#!/usr/bin/env python3
"""Synthesize a construction-consistent MIDI for each split piece: the note events
come from the SAME engine timemap the pipeline builds score_events from (repeats
expanded, injected <sound tempo> honored), so the alignment/geometry gates verify
XML<->MIDI identity by construction. Used because Sibelius failed to export a
whole-book MIDI (corrupt 700MB export, 2026-07-18); replace with the engraver's
own MIDI via v2 uploads whenever one exists.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pretty_midi

WORKER = "/Users/liuqinyuan/Desktop/KaraOrcheePlatform/worker/pieces"
sys.path.insert(0, WORKER)

from gates import _effective_paths  # noqa: E402
from pipeline import score_events as se  # noqa: E402
from pipeline import xml_meta  # noqa: E402


def synth(xml_path: Path, out_mid: Path, work_dir: Path) -> dict:
    meta = xml_meta.extract(xml_path)
    eff = _effective_paths(xml_path, work_dir, meta, None)
    payload = se.from_xml_timemap(eff)
    bpm = meta["tempo_bpm"] or 100
    pm = pretty_midi.PrettyMIDI(initial_tempo=float(bpm))
    inst = pretty_midi.Instrument(program=0)
    # Grace notes land ~30ms after their principal in the verovio timemap — exactly
    # the pipeline's onset-cluster width, so they'd merge into the chord on the MIDI
    # read-back. Enforce a 45ms floor between distinct events (order preserved; the
    # shift is ~15ms on a handful of ornaments, far under the 12ms MEDIAN gate).
    MIN_GAP = 0.045
    last = None
    shifted_events = []
    for ev in payload["events"]:
        onset = float(ev["onset_sec"])
        if last is not None and onset - last < MIN_GAP:
            onset = last + MIN_GAP
        shifted_events.append((onset, ev))
        last = onset
    for onset, ev in shifted_events:
        for pitch, dur in zip(ev["pitches"], ev["durations"]):
            inst.notes.append(pretty_midi.Note(
                velocity=80, pitch=int(pitch), start=onset,
                end=onset + max(float(dur), 0.06)))
    pm.instruments.append(inst)
    pm.write(str(out_mid))
    return {"events": payload["n_events"], "bpm": bpm,
            "notes": len(inst.notes),
            "duration_sec": round(pm.get_end_time(), 1)}


def main():
    split_dir = Path(sys.argv[1])
    work = split_dir / "_synthmidi"
    work.mkdir(exist_ok=True)
    files = sorted(list(split_dir.glob("*.musicxml")) +
                   list((split_dir / "hold_tail").glob("*.musicxml")))
    for f in files:
        w = work / f.stem
        w.mkdir(exist_ok=True)
        info = synth(f, f.with_suffix(".mid"), w)
        print(f.stem, info, flush=True)


if __name__ == "__main__":
    main()
