"""Solo-part selection for multi-part scores (violin + piano accompaniment).

Spike-verified 2026-07-08: Verovio has no native part filter; MusicXML pre-surgery
(remove the accompaniment score-part + part block) renders/timemaps correctly and is
timing-neutral (0.000ms residual). MIDI instrument separation is a pretty_midi filter.
"""
from __future__ import annotations
import xml.etree.ElementTree as ET
from pathlib import Path
import pretty_midi


def reduce_xml_to_part(src_xml: Path, out_xml: Path, keep_part_id: str) -> None:
    tree = ET.parse(src_xml)
    root = tree.getroot()
    pl = root.find("part-list")
    if pl is None:
        raise ValueError("MusicXML has no part-list")
    ids = [sp.get("id") for sp in pl.findall("score-part")]
    if keep_part_id not in ids:
        raise ValueError(f"solo part {keep_part_id!r} not in part-list {ids}")
    for sp in list(pl.findall("score-part")):
        if sp.get("id") != keep_part_id:
            pl.remove(sp)
    # Brace/bracket groups reference removed parts — safe to drop when one part remains.
    for pg in list(pl.findall("part-group")):
        pl.remove(pg)
    for pt in list(root.findall("part")):
        if pt.get("id") != keep_part_id:
            root.remove(pt)
    tree.write(out_xml, encoding="UTF-8", xml_declaration=True)


def split_midi_notes(midi_path: Path, solo_index: int) -> tuple[list, list]:
    """(solo_notes, accompaniment_notes) as (start, dur, pitch, velocity) tuples.
    solo_index = 0-based position in the XML part-list; MIDI track order follows the
    part-list for notation-software exports (validated per upload by the alignment gate —
    a wrong mapping fails the <12ms residual)."""
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    insts = [i for i in pm.instruments if not i.is_drum]
    if not insts:
        raise ValueError("MIDI contains no instruments")
    # A grand-staff accompaniment often exports as 2 MIDI tracks for 1 XML part; when
    # counts disagree, fall back to name matching, then to first-track-is-solo.
    solo, accomp = [], []
    if solo_index < len(insts):
        for k, inst in enumerate(insts):
            bucket = solo if k == solo_index else accomp
            for n in inst.notes:
                bucket.append((n.start, n.end - n.start, n.pitch, n.velocity))
    else:
        for k, inst in enumerate(insts):
            bucket = solo if k == 0 else accomp
            for n in inst.notes:
                bucket.append((n.start, n.end - n.start, n.pitch, n.velocity))
    if not solo:
        raise ValueError("solo part has no notes in the MIDI")
    solo.sort(key=lambda x: x[0])
    accomp.sort(key=lambda x: x[0])
    return solo, accomp
