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


def _voice_hand(part, n_staves: int) -> dict[str, str]:
    """Which hand each voice belongs to, by the staff it mostly lives on.

    A voice keeps its hand when it crosses staves: in Hanon's scales the
    right-hand voice is written on the BASS staff wherever the scale runs low,
    and the left-hand voice on the TREBLE staff wherever it runs high. Deciding
    fingering side by the printed staff therefore flips 656 of No. 39's
    fingerings to the wrong side of their notes."""
    tally: dict[str, dict[str, int]] = {}
    for note in part.iter("note"):
        voice = (note.findtext("voice") or "1").strip()
        staff = (note.findtext("staff") or "1").strip()
        tally.setdefault(voice, {}).setdefault(staff, 0)
        tally[voice][staff] += 1
    hands = {}
    for voice, staves in tally.items():
        home = max(staves.items(), key=lambda kv: kv[1])[0]
        hands[voice] = "below" if home == str(n_staves) else "above"
    return hands


def _fix_fingering_placement(part) -> bool:
    n_staves = _staff_counts(part)
    if n_staves < 2:
        return False
    hands = _voice_hand(part, n_staves)
    changed = False
    for note in part.iter("note"):
        side = hands.get((note.findtext("voice") or "1").strip())
        if side is None:
            continue
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


def normalize_engraving(xml_path: Path, out_dir: Path) -> Path:
    """Return a path with fingering placement + piece-number fixes applied.
    Returns the input path untouched when there is nothing to fix."""
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError:
        return xml_path
    root = tree.getroot()
    changed = False
    for part in root.iter("part"):
        changed |= _reanchor_chord_fingerings(part)
        changed |= _fix_fingering_placement(part)
        changed |= _fix_pedal_placement(part)
        changed |= _fix_orphan_dynamic_placement(part)
        number = _drop_piece_number_words(part)
        if number:
            changed = True
            _store_piece_number(root, number)
        changed |= _pad_tempo_metronome_gap(part)
    if not changed:
        return xml_path
    out = out_dir / (xml_path.stem + ".engraving_norm.musicxml")
    tree.write(out, encoding="UTF-8", xml_declaration=True)
    return out
