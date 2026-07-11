"""Metronome-mark tempo normalization for verovio.

verovio 6.2.1 misconverts dotted beat units (probe: ♩.=60 plays at 80 QPM; musically
correct is 90) — every 6/8 piece with a dotted metronome mark would fail the residual
gate by 12.5% against a correct MIDI. verovio DOES honor an explicit <sound tempo>
inside the same direction (probe-verified), so we inject the correctly-converted QPM
alongside the printed mark. Visual engraving is untouched.
"""
from __future__ import annotations
import re
import xml.etree.ElementTree as ET
from pathlib import Path

_BEAT_UNIT_QUARTERS = {
    "breve": 8.0, "whole": 4.0, "half": 2.0, "quarter": 1.0,
    "eighth": 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625,
}


def _metronome_qpm(met: ET.Element) -> float | None:
    unit = (met.findtext("beat-unit") or "").strip()
    base = _BEAT_UNIT_QUARTERS.get(unit)
    per_min_text = (met.findtext("per-minute") or "").strip()
    m = re.search(r"\d+(?:\.\d+)?", per_min_text)  # tolerate "c. 120", "120-132"
    if base is None or not m:
        return None
    ndots = len(met.findall("beat-unit-dot"))
    beat_quarters = base * (2.0 - 2.0 ** -ndots)  # dotted = ×1.5, double-dotted = ×1.75
    return float(m.group(0)) * beat_quarters


def normalize_tempo(xml_path: Path, out_dir: Path) -> Path:
    """Return a path whose metronome marks carry an explicit, correctly-converted
    <sound tempo>. Returns the input path untouched when there is nothing to fix."""
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError:
        return xml_path
    changed = False
    for d in tree.getroot().iter("direction"):
        snd = d.find("sound")
        if snd is not None and snd.get("tempo"):
            continue  # exporter already wrote the machine tempo — trust it
        met = d.find(".//metronome")
        if met is None:
            continue
        qpm = _metronome_qpm(met)
        if qpm is None:
            continue
        if snd is None:
            snd = ET.SubElement(d, "sound")
        snd.set("tempo", f"{qpm:g}")
        changed = True
    if not changed:
        return xml_path
    out = out_dir / (xml_path.stem + ".tempo_norm.musicxml")
    tree.write(out, encoding="UTF-8", xml_declaration=True)
    return out
