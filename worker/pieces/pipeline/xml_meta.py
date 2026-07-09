"""MusicXML metadata extraction — the wizard's read-only facts card.

Musical facts (key/time/measures/parts/tempo) are ground truth (100% coverage in the
12-file audit). Bibliographic strings (title/composer) are prefill SUGGESTIONS only —
they are present in ~25% of real files and never house-style clean.
"""
from __future__ import annotations
import xml.etree.ElementTree as ET
from pathlib import Path

MODE_NAMES = {"major", "minor"}


def _text(el) -> str | None:
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


def extract(xml_path: Path) -> dict:
    root = ET.parse(xml_path).getroot()

    parts = []
    for sp in root.findall("part-list/score-part"):
        pid = sp.get("id") or f"P{len(parts) + 1}"
        parts.append({"id": pid, "name": _text(sp.find("part-name"))})

    # First measure attributes of the first part = the piece-level facts.
    key = None
    time = None
    staves = None
    first_part = root.find("part")
    if first_part is not None:
        attrs = first_part.find("measure/attributes")
        if attrs is not None:
            fifths = _text(attrs.find("key/fifths"))
            mode = _text(attrs.find("key/mode"))
            if fifths is not None:
                key = {"fifths": int(fifths)}
                if mode in MODE_NAMES:
                    key["mode"] = mode
            beats = _text(attrs.find("time/beats"))
            beat_type = _text(attrs.find("time/beat-type"))
            if beats and beat_type:
                time = f"{beats}/{beat_type}"
            st = _text(attrs.find("staves"))
            if st:
                staves = int(st)

    # Tempo: <sound tempo> anywhere wins; first direction words = the verbal marking.
    tempo_bpm = None
    tempo_text = None
    for sound in root.iter("sound"):
        t = sound.get("tempo")
        if t:
            try:
                tempo_bpm = round(float(t))
                break
            except ValueError:
                pass
    for words in root.iter("words"):
        w = _text(words)
        if w and len(w) < 60:
            tempo_text = w
            break

    measures = len(first_part.findall("measure")) if first_part is not None else 0

    ident = root.find("identification")
    composer = None
    if ident is not None:
        for creator in ident.findall("creator"):
            if creator.get("type") == "composer":
                composer = _text(creator)
                break

    return {
        "parts": parts,
        "n_parts": len(parts),
        "key": key,
        "time": time,
        "staves": staves,
        "measures": measures,
        "tempo_bpm": tempo_bpm,
        "tempo_text": tempo_text,
        "tempo_source": "xml" if tempo_bpm is not None else "default",
        # Prefill suggestions — NEVER authoritative:
        "suggested_title": _text(root.find("work/work-title")),
        "suggested_movement": _text(root.find("movement-title")),
        "suggested_composer": composer,
    }
