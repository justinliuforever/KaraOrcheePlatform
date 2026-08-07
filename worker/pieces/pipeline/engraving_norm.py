"""Engraving normalization — placement fixes verovio cannot infer from the source.

Two source patterns break the rendered layout (both observed on Sibelius+Dolet exports,
La Pastorale 2026-07-13):

1. Grand-staff fingerings carry no `placement`, so verovio defaults every one to
   above-staff — bottom-staff (left-hand) fingerings land between the staves instead
   of below the system (piano convention: fingerings sit OUTSIDE the grand staff).
   The editor's intent survives only in default-y; verovio ignores it on <fingering>.
   Fix: bottom-staff fingerings get placement="below", and each note's fingering
   stack is reordered by default-y descending — verovio stacks a below-placement in
   document order from the staff outward, so descending default-y reproduces the
   editor's top-to-bottom visual order (chord stacks read top-note finger first).

2. Edition piece numbers ("3.") engraved beside the first system export as a bare
   <words> direction in measure 1 and render as floating text inside the measure.
   MusicXML cannot express left-of-system placement and the catalog carries numbering
   natively, so the direction is dropped.

3. Dolet anchors beat-positioned fingering text to a note by x-proximity, which can
   pick a note in the WRONG VOICE — a chord's whole fingering stack lands on a lone
   note sounding against it. Detected by shape (lone note, stacked multi-fingering,
   a uniquely matching unfingered chord sounding at that moment) and re-anchored.

4. Piano pedal marks belong under the whole grand staff, but a pedal the editor
   attached to the TOP staff and then dragged down exports as staff 1 + a large
   negative default-y. verovio honours the staff and ignores the drag, so those
   marks render between the staves while their neighbours sit below the system
   (Chopin Op. 34 No. 1: 6 of 443 on staff 1). Fix: pedals go to the bottom staff,
   placement below.
"""
from __future__ import annotations
import re
import xml.etree.ElementTree as ET
from pathlib import Path

_PIECE_NUMBER = re.compile(r"\d{1,2}\.")



def _hide_solo_part_name(root) -> bool:
    """A one-part score names its instrument nowhere on the page.

    Sibelius hides it for solo writing and the printed editions never show it, but
    the name only survives the export as a bare <part-name> with no print-object,
    so eleven scores carried "Piano" down the left of every system."""
    parts = root.findall(".//score-part")
    if len(parts) != 1:
        return False
    changed = False
    for tag in ("part-name", "part-abbreviation"):
        el = parts[0].find(tag)
        if el is not None and (el.text or "").strip() and el.get("print-object") != "no":
            el.set("print-object", "no")
            changed = True
    return changed

def _staff_counts(part) -> int:
    staves = part.find(".//attributes/staves")
    if staves is not None and (staves.text or "").strip().isdigit():
        return int(staves.text)
    return 1


def _measure_onsets(measure):
    """[(note_el, onset_tick, is_chord_follower)] in document order, honoring
    <backup>/<forward>. Chord followers share the principal's onset."""
    out, cursor, prev_onset = [], 0, 0
    for el in measure:
        if el.tag == "backup":
            d = el.find("duration")
            cursor -= int(d.text) if d is not None else 0
        elif el.tag == "forward":
            d = el.find("duration")
            cursor += int(d.text) if d is not None else 0
        elif el.tag == "note":
            follower = el.find("chord") is not None
            onset = prev_onset if follower else cursor
            out.append((el, onset, follower))
            d = el.find("duration")
            if not follower:
                prev_onset = onset
                cursor = onset + (int(d.text) if d is not None else 0)
    return out


def _note_fingerings(note):
    return [f for t in note.iter("technical") for f in t.findall("fingering")]


def _dy(f) -> float:
    try:
        return float(f.get("default-y", "0"))
    except ValueError:
        return 0.0


def _reanchor_chord_fingerings(part) -> bool:
    """Dolet matches beat-anchored fingering text to a note by x-proximity; with two
    simultaneous voices it can hang a chord's whole fingering stack on a single note
    in the other voice (La Pastorale m11: 2/5 for the held F3+C4 double-stop landed
    on the off-beat D4 eighth). Signature: a lone note carrying >=2 vertically
    stacked fingerings while a same-staff chord with exactly that many notes and no
    fingerings of its own is SOUNDING at that moment -> move the stack to the
    chord's principal note. Requires a unique such chord, else leaves the source."""
    changed = False
    for measure in part.findall("measure"):
        onsets = _measure_onsets(measure)
        # (staff, onset, duration, [notes]) per chord group — document adjacency:
        # a principal plus its immediately following <chord/> followers.
        groups, i = [], 0
        while i < len(onsets):
            el, onset, _ = onsets[i]
            if el.find("rest") is not None:
                i += 1
                continue
            notes = [el]
            j = i + 1
            while j < len(onsets) and onsets[j][2]:
                notes.append(onsets[j][0])
                j += 1
            dur = el.find("duration")
            groups.append(((el.findtext("staff") or "1").strip(), onset,
                           int(dur.text) if dur is not None else 0, notes))
            i = j
        for staff, onset, _dur, notes in groups:
            if len(notes) != 1:
                continue
            src = notes[0]
            fings = _note_fingerings(src)
            if len(fings) < 2:
                continue
            dys = [_dy(f) for f in fings]
            if max(dys) - min(dys) <= 10:
                continue  # horizontal pair (substitution) — not a chord stack
            targets = [g for g in groups
                       if g[0] == staff and len(g[3]) == len(fings)
                       and g[1] <= onset < g[1] + g[2]
                       and not any(_note_fingerings(n) for n in g[3])]
            if len(targets) != 1:
                continue
            principal = targets[0][3][0]
            notations = principal.find("notations")
            if notations is None:
                notations = ET.SubElement(principal, "notations")
            technical = notations.find("technical")
            if technical is None:
                technical = ET.SubElement(notations, "technical")
            for f in fings:
                technical.append(f)
            for t in src.iter("technical"):
                for f in list(t.findall("fingering")):
                    t.remove(f)
            changed = True
    return changed


def _voice_home_staff(part) -> dict[str, str]:
    """The staff each voice mostly prints on."""
    tally: dict[str, dict[str, int]] = {}
    for note in part.iter("note"):
        voice = (note.findtext("voice") or "1").strip()
        staff = (note.findtext("staff") or "1").strip()
        tally.setdefault(voice, {}).setdefault(staff, 0)
        tally[voice][staff] += 1
    return {v: max(s.items(), key=lambda kv: kv[1])[0] for v, s in tally.items()}


def _voice_hand(part, n_staves: int) -> dict[str, str]:
    """Which hand each voice belongs to, by the staff it mostly lives on.

    A voice keeps its hand when it crosses staves: in Hanon's scales the
    right-hand voice is written on the BASS staff wherever the scale runs low,
    and the left-hand voice on the TREBLE staff wherever it runs high. Deciding
    fingering side by the printed staff therefore flips 656 of No. 39's
    fingerings to the wrong side of their notes."""
    return {v: ("below" if home == str(n_staves) else "above")
            for v, home in _voice_home_staff(part).items()}


def _fix_fingering_placement(part) -> bool:
    n_staves = _staff_counts(part)
    if n_staves < 2:
        return False
    hands = _voice_hand(part, n_staves)
    homes = _voice_home_staff(part)
    changed = False
    for note in part.iter("note"):
        voice = (note.findtext("voice") or "1").strip()
        side = hands.get(voice)
        if side is None:
            continue
        # verovio resolves @place against the LAYER's anchor staff, not the staff
        # the note prints on. A voice reaching DOWN into the staff below therefore
        # gets thrown clean outside the system by its hand's side — measured 16.6
        # staff spaces from the notehead, where the engraver's page prints 5.6.
        # A crossing voice always belongs in the gap between the staves, and from
        # the anchor staff's point of view the gap is "below".
        printed = (note.findtext("staff") or "1").strip()
        home = homes.get(voice)
        if home is not None and printed.isdigit() and home.isdigit() and int(printed) > int(home):
            side = "below"
        technicals = [t for t in note.iter("technical") if t.find("fingering") is not None]
        for tech in technicals:
            fings = tech.findall("fingering")
            if any(f.get("placement") for f in fings):
                continue  # editor stated a side — trust it
            for f in fings:
                f.set("placement", side)
            if len(fings) > 1:
                def dy(f):
                    try:
                        return float(f.get("default-y", "0"))
                    except ValueError:
                        return 0.0
                # verovio stacks a placed group in document order FROM the staff
                # outward, so the near-staff end comes first: descending default-y
                # below the staff, ascending above it.
                ordered = sorted(fings, key=dy, reverse=(side == "below"))
                if ordered != fings:
                    others = [c for c in tech if c.tag != "fingering"]
                    for c in list(tech):
                        tech.remove(c)
                    for f in ordered:
                        tech.append(f)
                    for c in others:
                        tech.append(c)
            changed = True
    return changed


def _fix_pedal_placement(part) -> bool:
    """Every pedal direction under the bottom staff, placement below — the piano
    convention, and the only reading verovio can render consistently."""
    n_staves = _staff_counts(part)
    changed = False
    for direction in part.iter("direction"):
        if direction.find("direction-type/pedal") is None:
            continue
        if direction.get("placement") != "below":
            direction.set("placement", "below")
            changed = True
        if n_staves < 2:
            continue
        staff = direction.find("staff")
        if staff is None:
            staff = ET.Element("staff")
            # MusicXML order: direction-type+, offset?, voice?, staff?, sound?
            sound = direction.find("sound")
            direction.insert(list(direction).index(sound) if sound is not None
                             else len(direction), staff)
        if (staff.text or "").strip() != str(n_staves):
            staff.text = str(n_staves)
            changed = True
    return changed


def _drop_stacked_pedal_starts(part) -> bool:
    """Two identical <pedal type="start"> in one measure with no stop between them
    are one pedal line laid on top of another in the editor.

    verovio pairs pedal down/up in document order, so the extra start makes every
    later down close on the NEXT up: from that bar to the end of the piece each
    bracket runs a span too long and overlaps its neighbour. Perfectly stacked marks
    are invisible in the editor (Chopin Op. 34 No. 1 bar 19)."""
    changed = False
    for measure in part.findall("measure"):
        open_here = None
        for direction in list(measure.findall("direction")):
            ped = direction.find("direction-type/pedal")
            if ped is None:
                continue
            kind = ped.get("type")
            if kind == "start":
                if open_here == ped.attrib:
                    measure.remove(direction)
                    changed = True
                    continue
                open_here = dict(ped.attrib)
            elif kind in ("stop", "discontinue"):
                open_here = None
    return changed


def _fix_orphan_dynamic_placement(part) -> bool:
    """A dynamic hung BELOW a staff that has no notes in that measure lands in the
    inter-staff gap, where it displaces the neighbouring staff's fingering row away
    from its noteheads. Put it above its (empty) staff instead — the notes it marks
    are elsewhere anyway. Observed on Hanon No. 1, whose opening bars write both
    hands on the bottom staff: the mf pushed the whole right-hand fingering row up.
    """
    n_staves = _staff_counts(part)
    if n_staves < 2:
        return False
    changed = False
    for measure in part.findall("measure"):
        voiced = {(n.findtext("staff") or "1")
                  for n in measure.findall("note") if n.find("rest") is None}
        for direction in measure.findall("direction"):
            if direction.find("direction-type/dynamics") is None:
                continue
            if direction.get("placement") != "below":
                continue
            staff = direction.findtext("staff") or "1"
            if staff == str(n_staves) or staff in voiced:
                continue  # bottom staff below is correct; a sounding staff keeps its side
            direction.set("placement", "above")
            changed = True
    return changed


def _measure_note_onsets(measure) -> list[tuple]:
    """[(note_el, voice, onset)] honoring backup/forward; chord followers share
    their principal's onset. Returns None if any duration is unreadable."""
    out, cursor, prev = [], 0, 0
    for el in measure:
        if el.tag in ("backup", "forward"):
            text = el.findtext("duration")
            if text is None or not text.strip().lstrip("-").isdigit():
                return None
            cursor += (-1 if el.tag == "backup" else 1) * int(text)
            if cursor < 0:
                return None
        elif el.tag == "note":
            follower = el.find("chord") is not None
            onset = prev if follower else cursor
            out.append((el, (el.findtext("voice") or "1").strip(), onset))
            if not follower and el.find("grace") is None:
                text = el.findtext("duration")
                if text is None or not text.strip().isdigit():
                    return None
                prev, cursor = onset, onset + int(text)
    return out


def _separate_interleaved_voices(part) -> bool:
    """Make a voice switch legible to the importer.

    Dolet writes two voices of a staff interleaved note by note with small
    <backup>s instead of one whole voice, a backup, then the other. The onsets are
    arithmetically right, but verovio's importer strings the second voice's notes
    into the first one's layer — K.331 bar 1 ends up with a layer summing to 3840
    ppq inside a 2304 ppq bar, and the two voices print out of alignment.

    Inserting a backup/forward pair of the SAME duration at each voice switch is
    position-neutral by construction — nothing else in the measure moves, so the
    mid-measure directions and clef changes keep their places — while giving the
    importer the boundary it needs. Grouping is by VOICE alone: same-voice
    cross-staff writing renders correctly today and must not be split.
    """
    changed = False
    for measure in part.findall("measure"):
        before = _measure_note_onsets(measure)
        if before is None:
            continue  # unreadable durations — leave the measure exactly as it is
        voices = [v for _n, v, _o in before]
        if len(set(voices)) < 2:
            continue
        switches = sum(1 for a, b in zip(voices, voices[1:]) if a != b)
        if switches < 2:
            continue  # already contiguous
        # A voice that re-enters BEHIND itself cannot be given a layer: the importer
        # fills a layer forward and never seeks back into it, so those notes land
        # after the barline and the bar gains a beat (Fugue BWV 846 m16, voice 1
        # returning to qstamp 16 having already reached 64). The arithmetic is fine
        # in MusicXML, so only this check sees it.
        seen: dict[str, int] = {}
        rewinds = False
        for _n, v, onset in before:
            if onset < seen.get(v, 0):
                rewinds = True
                break
            seen[v] = onset
        if rewinds:
            continue
        snapshot = list(measure)
        cursor, prev_voice, inserted = 0, None, 0
        for el in list(measure):
            if el.tag in ("backup", "forward"):
                cursor += (-1 if el.tag == "backup" else 1) * int(el.findtext("duration"))
            elif el.tag == "note":
                voice = (el.findtext("voice") or "1").strip()
                follower = el.find("chord") is not None or el.find("grace") is not None
                if not follower and prev_voice is not None and voice != prev_voice:
                    # A net-zero pair: back up to the bar start and return, or —
                    # when the cursor is already there and backing up is not
                    # expressible — step forward over this note and return.
                    span = cursor if cursor > 0 else int(el.findtext("duration") or 0)
                    if span > 0:
                        at = list(measure).index(el)
                        first = ET.Element("backup" if cursor > 0 else "forward")
                        ET.SubElement(first, "duration").text = str(span)
                        second = ET.Element("forward" if cursor > 0 else "backup")
                        ET.SubElement(second, "duration").text = str(span)
                        measure.insert(at, second)
                        measure.insert(at, first)
                        inserted += 1
                if not follower:
                    cursor += int(el.findtext("duration"))
                    prev_voice = voice
        if not inserted:
            continue
        after = _measure_note_onsets(measure)
        if after is None or [(id(n), v, o) for n, v, o in after] != \
                            [(id(n), v, o) for n, v, o in before]:
            measure[:] = snapshot          # any onset moved — revert this measure
            continue
        changed = True
    return changed


_TRILL_TAILS = ("trill-mark", "wavy-line")


def _rejoin_barline_graces(part) -> bool:
    """Put a grace note in the bar of the note it ornaments.

    A grace note entered at the end of a Sibelius bar exports as that voice's last
    element in the <measure>; verovio then draws it before the barline, split from the
    principal it belongs to (Chopin Op.34 No.1 bars 28 and 185). Graces carry no
    duration, so moving the run to the head of the next measure's same voice leaves
    every onset untouched. A trill termination is also a bar-final grace run and must
    stay put: it ornaments the note it follows, not the next bar's.
    """
    measures = part.findall("measure")
    changed = False
    for i, measure in enumerate(measures[:-1]):
        onsets = _measure_note_onsets(measure)
        if onsets is None:
            continue
        bar_end = max((o + int(n.findtext("duration") or 0) for n, _v, o in onsets
                       if n.find("grace") is None and n.find("chord") is None), default=0)
        by_voice: dict[str, list] = {}
        for n, v, o in onsets:
            by_voice.setdefault(v, []).append((n, o))
        for voice, seq in by_voice.items():
            cut = len(seq)
            while cut and seq[cut - 1][0].find("grace") is not None:
                cut -= 1
            tail = [n for n, _o in seq[cut:]]
            if not tail or cut == 0:
                continue
            last_onset = seq[cut - 1][1]
            if last_onset + int(seq[cut - 1][0].findtext("duration") or 0) != bar_end:
                continue                    # voice stops short — not a barline grace
            if any(e.tag in _TRILL_TAILS for n, o in seq[:cut] if o == last_onset
                   for e in n.iter()):
                continue                    # trill termination — belongs to this bar
            staff = tail[0].findtext("staff")
            nxt = measures[i + 1]
            nxt_onsets = _measure_note_onsets(nxt)
            if nxt_onsets is None:
                continue
            target = next(((n, o) for n, v, o in nxt_onsets if v == voice
                           and n.find("grace") is None and n.find("chord") is None), None)
            if target is None or target[1] != 0 or target[0].findtext("staff") != staff:
                continue
            at = list(nxt).index(target[0])
            for k, g in enumerate(tail):
                measure.remove(g)
                nxt.insert(at + k, g)
            changed = True
    return changed


def _fold_tempo_tail_into_metronome(part) -> bool:
    """Keep a metronome mark inside its sentence.

    Hanon prints "M. M. ♩ = 60 to 120." — words, metronome, words. verovio emits
    every <words> of a direction before the metronome regardless of document
    order, so it came out "M. M. to 120. ♩ = 60" on all eleven marks in the
    corpus. Moving the trailing text into <per-minute> puts it back after the
    number. Runs after tempo_norm, so the numeric per-minute has already been
    read; nothing downstream parses it again."""
    changed = False
    for direction in part.iter("direction"):
        types = direction.findall("direction-type")
        metro_at = next((i for i, t in enumerate(types)
                         if t.find("metronome") is not None), None)
        if metro_at is None or metro_at == len(types) - 1:
            continue
        per = types[metro_at].find("metronome/per-minute")
        if per is None:
            continue
        tail_types = [t for t in types[metro_at + 1:]
                      if t.find("words") is not None and len(t) == 1]
        if len(tail_types) != len(types) - metro_at - 1:
            continue  # something other than plain text follows — leave it alone
        tail = "".join((t.find("words").text or "") for t in tail_types)
        if not tail.strip() or (per.text or "").endswith(tail):
            continue
        per.text = (per.text or "") + tail
        for t in tail_types:
            direction.remove(t)
        changed = True
    return changed


def _drop_piece_number_words(part) -> str | None:
    """Remove the edition piece number ("3.") from measure 1 and return it so it
    can be preserved as metadata — the staff builder re-places it at the edition
    position (left of system 1, outside the brace), where MusicXML cannot put it."""
    m1 = part.find("measure")
    if m1 is None:
        return None
    captured = None
    for d in list(m1.findall("direction")):
        words = d.findall(".//words")
        if len(words) == 1 and words[0].text and _PIECE_NUMBER.fullmatch(words[0].text.strip()):
            captured = words[0].text.strip()
            m1.remove(d)
    return captured


def _store_piece_number(root, number: str) -> bool:
    for f in root.iter("miscellaneous-field"):
        if f.get("name") == "piece-number":
            return False
    ident = root.find("identification")
    if ident is None:
        idx = 0
        for i, child in enumerate(list(root)):
            if child.tag in ("work", "movement-number", "movement-title"):
                idx = i + 1
        ident = ET.Element("identification")
        root.insert(idx, ident)
    misc = ident.find("miscellaneous")
    if misc is None:
        misc = ET.SubElement(ident, "miscellaneous")
    field = ET.SubElement(misc, "miscellaneous-field", {"name": "piece-number"})
    field.text = number
    return True


def _pad_tempo_metronome_gap(part) -> bool:
    """Tempo directions carrying words AND a metronome render glued together
    ("ADANTINO.(♩.=66)"). Verovio right-trims trailing whitespace-class chars
    (incl. nbsp) both in the MEI roundtrip and at render, so a plain pad dies;
    a zero-width joiner terminator is non-whitespace and stops the trim while
    adding no width. Normalize to exactly two nbsp + ZWJ. Idempotent."""
    changed = False
    for d in part.iter("direction"):
        if d.find(".//metronome") is None:
            continue
        for w in d.findall(".//words"):
            if not (w.text and w.text.strip()):
                continue
            padded = w.text.rstrip(" \u00a0\u200d") + "\u00a0\u00a0\u200d"
            if padded != w.text:
                w.text = padded
                changed = True
    return changed


_REST_GLYPHS = {
    "restDoubleWhole", "restWhole", "restHalf", "restQuarter", "rest8th",
    "rest16th", "rest32nd", "rest64th", "rest128th",
}
# what may sit between the symbol and the rest it decorates
_SYMBOL_SKIP = {"direction", "barline", "print", "sound", "harmony"}


def _symbol_rest_glyph(direction) -> str | None:
    syms = [s for dt in direction.findall("direction-type")
            for s in dt.findall("symbol")]
    others = [c for dt in direction.findall("direction-type")
              for c in dt if c.tag != "symbol"]
    if len(syms) != 1 or others:
        return None
    name = (syms[0].text or "").strip()
    return name if name in _REST_GLYPHS else None


def _pair_symbol_rests(measure, want_hidden: bool):
    """(rest-symbol direction, the rest it decorates) pairs in one measure.

    Refuses unless the symbol is a rest glyph, is the whole of its direction, and
    the next timed element is a rest on the same staff — every other hidden rest
    is an editor's deliberately invisible voice and must stay invisible."""
    kids = list(measure)
    for i, el in enumerate(kids):
        if el.tag != "direction":
            continue
        glyph = _symbol_rest_glyph(el)
        if glyph is None:
            continue
        staff = (el.findtext("staff") or "1").strip()
        t = next((k for k in kids[i + 1:] if k.tag not in _SYMBOL_SKIP), None)
        if t is None or t.tag != "note" or t.find("rest") is None:
            continue
        if (t.get("print-object") == "no") != want_hidden:
            continue
        if (t.findtext("staff") or "1").strip() != staff:
            continue
        yield el, t, staff, glyph


def _restore_symbol_rests(part) -> bool:
    """Un-hide a rest the editor replaced with a rest symbol; see item 5.

    The <symbol> direction stays: verovio drops it silently, and it is what
    symbol_rest_glyphs() reads back to find these rests again in the MEI."""
    changed = False
    for measure in part.findall("measure"):
        for _d, note, _s, _g in list(_pair_symbol_rests(measure, want_hidden=True)):
            del note.attrib["print-object"]
            changed = True
    return changed


def symbol_rest_glyphs(xml_path: Path) -> list[dict]:
    """{measure, staff, ordinal, glyph} for every rest _restore_symbol_rests
    un-hid, keyed the way the MEI orders them: ordinal counts that staff's
    PRINTED rests, which is exactly what verovio emits as <rest> (a hidden rest
    becomes <space>).  Read back from the normalized file so staff.py needs no
    state from this module."""
    keys = []
    for part in ET.parse(xml_path).getroot().findall("part"):
        for measure in part.findall("measure"):
            printed = [n for n in measure.findall("note")
                       if n.find("rest") is not None
                       and n.get("print-object") != "no"
                       and n.find("rest").get("measure") != "yes"]
            for _d, note, staff, glyph in _pair_symbol_rests(measure,
                                                             want_hidden=False):
                same = [n for n in printed
                        if (n.findtext("staff") or "1").strip() == staff]
                keys.append({"measure": measure.get("number"), "staff": staff,
                             "ordinal": same.index(note), "glyph": glyph})
    return keys


def normalize_engraving(xml_path: Path, out_dir: Path) -> Path:
    """Return a path with fingering placement + piece-number fixes applied.
    Returns the input path untouched when there is nothing to fix."""
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError:
        return xml_path
    root = tree.getroot()
    changed = _hide_solo_part_name(root)
    for part in root.iter("part"):
        changed |= _reanchor_chord_fingerings(part)
        changed |= _fix_fingering_placement(part)
        changed |= _fix_pedal_placement(part)
        changed |= _drop_stacked_pedal_starts(part)
        changed |= _fix_orphan_dynamic_placement(part)
        changed |= _restore_symbol_rests(part)
        number = _drop_piece_number_words(part)
        if number:
            changed = True
            _store_piece_number(root, number)
        changed |= _pad_tempo_metronome_gap(part)
        changed |= _fold_tempo_tail_into_metronome(part)
        changed |= _rejoin_barline_graces(part)
        changed |= _separate_interleaved_voices(part)
    if not changed:
        return xml_path
    out = out_dir / (xml_path.stem + ".engraving_norm.musicxml")
    tree.write(out, encoding="UTF-8", xml_declaration=True)
    return out
