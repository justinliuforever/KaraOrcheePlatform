"""Machine checks for engraving defects the eye kept finding first.

Each one corresponds to a defect that shipped: a fingering stranded 16.6 staff
spaces from its note, an ottava passage playing an octave off, two voices strung
into one layer. They report rather than fail — the operator sees them on the job
card and decides — because the underlying causes live in the source, and a hard
gate would block a whole book on one bad bar.
"""
from __future__ import annotations

import re
import statistics
import xml.etree.ElementTree as ET

FING_GAP_STAFF_SPACES = 8.0


def _staff_space(svg: str) -> float:
    ys = sorted({float(m.group(1)) for m in re.finditer(r'd="M\d+ (\d+) L\d+ \1"', svg)})
    gaps = [round(b - a) for a, b in zip(ys, ys[1:]) if 40 < b - a < 400]
    return float(statistics.mode(gaps)) if gaps else 180.0


def stranded_fingerings(mei: str, svg: str) -> dict:
    """Fingerings rendered further than FING_GAP_STAFF_SPACES from their note."""
    pairs = re.findall(r'<fing\b[^>]*xml:id="([^"]+)"[^>]*startid="#([^"]+)"', mei)
    pairs += [(f, n) for n, f in
              re.findall(r'<fing\b[^>]*startid="#([^"]+)"[^>]*xml:id="([^"]+)"', mei)]
    if not pairs:
        return {}
    fing_y = {m.group(1): float(m.group(2)) for m in
              re.finditer(r'<g id="(\w+)" class="fing">\s*<text x="\d+" y="(\d+)"', svg)}
    note_y = {m.group(1): float(m.group(2)) for m in
              re.finditer(r'<g id="(\w+)" class="note[^"]*">\s*<g class="notehead">\s*'
                          r'<use[^>]*transform="translate\(\d+, (\d+)\)', svg)}
    space = _staff_space(svg)
    gaps = [abs(fing_y[f] - note_y[n]) / space
            for f, n in pairs if f in fing_y and n in note_y]
    if not gaps:
        return {}
    far = [g for g in gaps if g > FING_GAP_STAFF_SPACES]
    return {"fingerings": len(gaps), "median_staff_spaces": round(statistics.median(gaps), 1),
            "max_staff_spaces": round(max(gaps), 1), "stranded": len(far),
            "stranded_limit_staff_spaces": FING_GAP_STAFF_SPACES}


def layer_overflow(mei: str) -> dict:
    """Layers holding MORE than their own measure — the fingerprint of two
    interleaved voices strung into one.

    Measured against the bar's own capacity, never against a sibling layer: an
    inner voice that sounds for half a bar, or a layer carrying only a grace
    note, is ordinary engraving and comparing layers to each other calls all of
    it broken."""
    bad = 0
    total = 0
    ppq = int((re.search(r'\bppq="(\d+)"', mei) or [0, "0"])[1])
    if not ppq:
        return {}
    count = unit = None
    for tok in re.finditer(r'<meterSig\b[^>]*?/?>|<measure\b[^>]*>.*?</measure>', mei, re.S):
        mtxt = tok.group(0)
        if not mtxt.startswith("<measure"):
            c = re.search(r'\bcount="(\d+)"', mtxt)
            u = re.search(r'\bunit="(\d+)"', mtxt)
            if c and u:
                count, unit = int(c.group(1)), int(u.group(1))
            continue
        if count is None:
            continue
        if 'metcon="false"' in mtxt:
            continue  # pickup or otherwise deliberately short
        capacity = ppq * 4 * count / unit
        for _sn, sbody in re.findall(r'<staff\b[^>]*n="(\d+)"[^>]*>(.*?)</staff>', mtxt, re.S):
            sums = []
            for _ln, lbody in re.findall(r'<layer\b[^>]*n="(\d+)"[^>]*>(.*?)</layer>',
                                         sbody, re.S):
                lb = re.sub(r"<chord\b[^>]*>(.*?)</chord>",
                            lambda m: '<C ppq="%s"/>' % (
                                (re.search(r'dur\.ppq="(\d+)"', m.group(1)) or
                                 re.match(r"(?!)", "")).group(1)
                                if re.search(r'dur\.ppq="(\d+)"', m.group(1)) else "0"),
                            lbody, flags=re.S)
                sums.append(sum(int(d) for d in re.findall(r'(?:dur\.ppq|ppq)="(\d+)"', lb)))
            if len(sums) > 1:
                total += 1
                if max(sums) > capacity * 1.25:
                    bad += 1
    return {"multi_layer_measures": total, "layer_overflow_measures": bad}


def pitch_conservation(source_xml_path, events: dict) -> dict:
    """The rendered event stream must span the same pitch range as the source.
    Catches an ottava read at its written octave instead of its sounding one."""
    try:
        root = ET.parse(source_xml_path).getroot()
    except Exception:
        return {}
    STEP = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
    src = []
    for note in root.iter("note"):
        p = note.find("pitch")
        if p is None:
            continue
        step = (p.findtext("step") or "").lower()
        octave = p.findtext("octave")
        if step not in STEP or not (octave or "").strip().lstrip("-").isdigit():
            continue
        src.append(12 * (int(octave) + 1) + STEP[step] + int(p.findtext("alter") or 0))
    played = [pitch for e in events.get("events", []) for pitch in e.get("pitches", [])]
    if not src or not played:
        return {}
    # Reading an ottava at its written octave narrows the played range; a stray
    # transposition widens it. Either direction is a defect, so report the total.
    return {"source_pitch_range": [min(src), max(src)],
            "played_pitch_range": [min(played), max(played)],
            "pitch_range_mismatch_semitones": abs(max(played) - max(src))
                                              + abs(min(played) - min(src))}


def overfull_fingerings(source_xml_path) -> dict:
    """Notes carrying more fingerings than their chord has noteheads — duplicated
    or mis-anchored digits from the exporter."""
    try:
        root = ET.parse(source_xml_path).getroot()
    except Exception:
        return {}
    bad = 0
    for measure in root.iter("measure"):
        group: list = []
        for note in measure.findall("note"):
            if note.find("chord") is None:
                if group:
                    fings = sum(len(n.findall("notations/technical/fingering")) for n in group)
                    bad += fings > len(group)
                group = []
            group.append(note)
        if group:
            fings = sum(len(n.findall("notations/technical/fingering")) for n in group)
            bad += fings > len(group)
    return {"overfull_fingering_chords": bad}
