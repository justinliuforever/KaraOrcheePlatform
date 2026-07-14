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


def _fix_fingering_placement(part) -> bool:
    n_staves = _staff_counts(part)
    if n_staves < 2:
        return False
    changed = False
    for note in part.iter("note"):
        staff = note.find("staff")
        if staff is None or (staff.text or "").strip() != str(n_staves):
            continue
        technicals = [t for t in note.iter("technical") if t.find("fingering") is not None]
        for tech in technicals:
            fings = tech.findall("fingering")
            if any(f.get("placement") for f in fings):
                continue  # editor stated a side — trust it
            for f in fings:
                f.set("placement", "below")
            if len(fings) > 1:
                def dy(f):
                    try:
                        return float(f.get("default-y", "0"))
                    except ValueError:
                        return 0.0
                ordered = sorted(fings, key=dy, reverse=True)
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


def _drop_piece_number_words(part) -> bool:
    m1 = part.find("measure")
    if m1 is None:
        return False
    changed = False
    for d in list(m1.findall("direction")):
        words = d.findall(".//words")
        if len(words) == 1 and words[0].text and _PIECE_NUMBER.fullmatch(words[0].text.strip()):
            m1.remove(d)
            changed = True
    return changed


def normalize_engraving(xml_path: Path, out_dir: Path) -> Path:
    """Return a path with fingering placement + piece-number fixes applied.
    Returns the input path untouched when there is nothing to fix."""
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError:
        return xml_path
    changed = False
    for part in tree.getroot().iter("part"):
        changed |= _fix_fingering_placement(part)
        changed |= _drop_piece_number_words(part)
    if not changed:
        return xml_path
    out = out_dir / (xml_path.stem + ".engraving_norm.musicxml")
    tree.write(out, encoding="UTF-8", xml_declaration=True)
    return out
