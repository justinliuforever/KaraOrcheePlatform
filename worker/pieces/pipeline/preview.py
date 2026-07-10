"""Review-grade preview audio: render score_events through FluidSynth with the SAME
SF2 the app bundles, so the admin hears what users will hear (engine differs — app uses
AVAudioUnitSampler — but both replay the same samples; final per-instrument sign-off
stays the founder ear-gate).

Output is AAC (~96kbps) — WAV would be ~10MB/min and preview lives in staging.
"""
from __future__ import annotations
import json
import subprocess
import tempfile
from pathlib import Path

# instrumentation.solo -> (SF2 blob name in the soundfont container, MIDI program).
# Blob names are immutable snapshots (date-stamped) — the app bundles the SAME files,
# so preview == app sound. Selected 2026-07-09 via researched + rendered audition
# (see docs/catalog_roadmap.md):
#   violin  MuseScore_General (MIT, VSCO-2 CE solo violin samples), GM program 40
#   guitar  FreePats Spanish Classical Guitar (CC0), dedicated font at program 0
SOUNDFONTS = {
    "piano": ("SalC5Light2.sf2", 0),
    "violin": ("MuseScore_General-20260709.sf2", 40),
    "guitar": ("SpanishClassicalGuitar-20190618.sf2", 0),
}


def soundfont_for(instrument: str | None) -> tuple[str, int, bool]:
    """(blob_name, program, is_fallback). Fallback = unknown instrument -> piano."""
    key = (instrument or "piano").lower()
    is_fallback = key not in SOUNDFONTS
    blob, program = SOUNDFONTS.get(key, SOUNDFONTS["piano"])
    return blob, program, is_fallback


def render_preview(score_events_path: Path, sf2_path: Path, out_m4a: Path, program: int = 0) -> dict:
    events = json.loads(score_events_path.read_text())["events"]
    end = max(e["onset_sec"] + max(e["durations"]) for e in events) + 2.0

    with tempfile.TemporaryDirectory() as tmp:
        midi_path = Path(tmp) / "preview.mid"
        _write_midi(events, midi_path, program)
        wav_path = Path(tmp) / "preview.wav"
        subprocess.run(
            ["fluidsynth", "-ni", "-g", "0.6", "-F", str(wav_path), "-r", "44100",
             str(sf2_path), str(midi_path)],
            check=True, capture_output=True, timeout=600)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(wav_path), "-c:a", "aac", "-b:a", "96k",
             "-movflags", "+faststart", str(out_m4a)],
            check=True, capture_output=True, timeout=600)

    return {"duration_sec": round(end, 1), "bytes": out_m4a.stat().st_size}


def _write_midi(events: list[dict], out: Path, program: int) -> None:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=program)
    for e in events:
        for pitch, dur, vel in zip(e["pitches"], e["durations"], e["velocities"]):
            inst.notes.append(pretty_midi.Note(
                velocity=int(vel), pitch=int(pitch),
                start=float(e["onset_sec"]),
                end=float(e["onset_sec"]) + max(float(dur), 0.05)))
    pm.instruments.append(inst)
    pm.write(str(out))
