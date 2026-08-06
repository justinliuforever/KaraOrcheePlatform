"""MusicXML metadata extraction — the wizard's read-only facts card.

Musical facts (key/time/measures/parts/tempo) are ground truth (100% coverage in the
12-file audit). Bibliographic strings (title/composer) are prefill SUGGESTIONS only —
they are present in ~25% of real files and never house-style clean.
"""
from __future__ import annotations
import xml.etree.ElementTree as ET
from pathlib import Path

MODE_NAMES = {"major", "minor"}

# Sibelius's File > Export writes this literal marker; the Dolet plugin writes
# "Dolet 8.3 for Sibelius". Direct exports degrade fingerings to <words> digits
# and drop tempo words — the guide mandates Dolet, so flag at the door.
DIRECT_EXPORT_MARKER = "Direct export, not from Dolet"


def _text(el) -> str | None:
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


def _fingering_stack_measures(root) -> list[str]:
    """Printed measure numbers where a note carries a >=2-fingering stack with any
    fingering missing default-x. Dolet writes default-x only when its position match
    succeeded — an unpositioned stack is the fingerprint of a voice-driven mis-claim
    (fingering likely hung on the wrong note)."""
    seen: list[str] = []
    for part in root.findall("part"):
        for meas in part.findall("measure"):
            for note in meas.findall("note"):
                fings = [f for tech in note.findall("notations/technical")
                         for f in tech.findall("fingering")]
                if len(fings) >= 2 and any(f.get("default-x") is None for f in fings):
                    num = meas.get("number") or "?"
                    if num not in seen:
                        seen.append(num)
    return seen



def _orphan_fingering_measures(root) -> list[str]:
    """Printed measure numbers where a lone digit arrived as <words> instead of a
    fingering, because its voice has no note there while another voice on the same
    staff does.

    Dolet can only bind a fingering to a note in its own voice. Typing the digits
    without first selecting the notehead leaves them in voice 1, and on a staff
    whose music is in voices 2-4 every one of them degrades to floating text that
    lands nowhere near its note."""
    seen: list[str] = []
    for part in root.findall("part"):
        for meas in part.findall("measure"):
            voices_with_notes: dict[str, set] = {}
            for note in meas.findall("note"):
                if note.find("rest") is not None:
                    continue
                staff = (note.findtext("staff") or "1").strip()
                voices_with_notes.setdefault(staff, set()).add(
                    (note.findtext("voice") or "1").strip())
            for d in meas.findall("direction"):
                staff = (d.findtext("staff") or "1").strip()
                voice = (d.findtext("voice") or "1").strip()
                here = voices_with_notes.get(staff)
                if not here or voice in here:
                    continue
                for w in d.findall("direction-type/words"):
                    if (w.text or "").strip().isdigit() and len((w.text or "").strip()) == 1:
                        num = meas.get("number") or "?"
                        if num not in seen:
                            seen.append(num)
                        break
    return seen


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

    # Tempo: <sound tempo> anywhere wins, then the first metronome mark — the same
    # reading tempo_norm injects, so the registry cannot say "not marked" about a
    # score whose timeline is already running at the engraver's number.
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
    if tempo_bpm is None:
        from pipeline.tempo_norm import _metronome_qpm
        for met in root.iter("metronome"):
            qpm = _metronome_qpm(met)
            if qpm:
                tempo_bpm = round(qpm)
                break
    # directive="yes" is how the exporter marks the tempo indication itself; without
    # it the first <words> in the file wins, which on this corpus is a rit. or a
    # bare edition number.
    for d in root.iter("direction"):
        if d.get("directive") != "yes":
            continue
        w = _text(d.find(".//words"))
        if w and len(w) < 60:
            tempo_text = w
            break
    if tempo_text is None:
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

    software = [s for s in (_text(el) for el in root.findall("identification/encoding/software")) if s][:8]
    export_warnings: list[dict] = []
    if any(DIRECT_EXPORT_MARKER in s for s in software):
        export_warnings.append({"code": "sibelius_direct_export"})
    # NB: the direct-export marker itself contains the word "Dolet" — exclude it.
    if any("Dolet" in s and DIRECT_EXPORT_MARKER not in s for s in software):
        stack_measures = _fingering_stack_measures(root)
        if stack_measures:
            export_warnings.append({"code": "fingering_stack_no_position",
                                    "measures": stack_measures[:8]})
        orphan_measures = _orphan_fingering_measures(root)
        if orphan_measures:
            export_warnings.append({"code": "fingering_wrong_voice",
                                    "measures": orphan_measures[:8]})

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
        "software": software,
        "export_warnings": export_warnings,
        # Prefill suggestions — NEVER authoritative:
        "suggested_title": _text(root.find("work/work-title")),
        "suggested_movement": _text(root.find("movement-title")),
        "suggested_composer": composer,
    }
