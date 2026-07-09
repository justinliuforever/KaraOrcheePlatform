"""Tier-1 reference-audio gate: verifies uploaded produced audio was rendered AT the
notated score tempo, so the app's linear time map (tap-to-seek, cursor sync, start-
anywhere) holds. History lesson: a hand-made alignment shipped broken once — never
trust, always verify.

Checks: (1) duration ratio |audio/notated - 1| <= 3%; (2) onset agreement under the
fitted linear map — >=90% of score onsets within 100ms of a detected audio onset, and
no 5s window below 60% (catches locally-broken audio a global number hides).
"""
from __future__ import annotations
import json
from pathlib import Path

import librosa
import numpy as np

DURATION_TOL = 0.03
ONSET_TOL_SEC = 0.100
PASS_RATE = 0.90
WINDOW_SEC = 5.0
WINDOW_MIN_RATE = 0.60


def check_reference_audio(audio_path: Path, score_events_path: Path) -> dict:
    events = json.loads(score_events_path.read_text())["events"]
    score_onsets = sorted({round(e["onset_sec"], 4) for e in events})
    notated_end = max(e["onset_sec"] + max(e["durations"]) for e in events)

    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    audio_dur = len(y) / sr

    # Trim silence head/tail for the duration comparison (lead-in/ring-out tolerance).
    yt, idx = librosa.effects.trim(y, top_db=40)
    content_dur = (idx[1] - idx[0]) / sr
    lead_in = idx[0] / sr

    ratio = content_dur / max(notated_end, 0.1)
    metrics: dict = {
        "audio_duration_sec": round(audio_dur, 1),
        "content_duration_sec": round(content_dur, 1),
        "notated_duration_sec": round(notated_end, 1),
        "duration_ratio": round(ratio, 4),
        "lead_in_sec": round(lead_in, 2),
    }
    if abs(ratio - 1.0) > DURATION_TOL:
        metrics["verdict"] = "duration_mismatch"
        raise AudioGateError(
            f"Audio length is {content_dur:.0f}s but the score at its notated tempo runs "
            f"{notated_end:.0f}s ({(ratio - 1) * 100:+.1f}%). Reference audio must be produced "
            "at the score's written tempo — a performance with tempo changes won't work here.",
            metrics)

    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="time", backtrack=False)
    audio_onsets = np.asarray(onset_frames, dtype=float)
    if len(audio_onsets) == 0:
        metrics["verdict"] = "no_onsets"
        raise AudioGateError("No note onsets detected in the audio (silent or corrupt file?).", metrics)

    # Linear map score->audio: t_audio = a*t_score + b (a from the trim ratio, b = lead-in).
    a = content_dur / max(notated_end, 0.1)
    b = lead_in
    mapped = np.asarray(score_onsets) * a + b

    idxs = np.searchsorted(audio_onsets, mapped)
    best = np.full(len(mapped), np.inf)
    for shift in (0, -1):
        j = np.clip(idxs + shift, 0, len(audio_onsets) - 1)
        best = np.minimum(best, np.abs(audio_onsets[j] - mapped))
    hits = best <= ONSET_TOL_SEC
    rate = float(np.mean(hits))
    metrics["onset_agreement"] = round(rate, 3)
    metrics["n_score_onsets"] = len(score_onsets)

    # Windowed check: no 5s span of the SCORE timeline below the local floor.
    worst_window = 1.0
    t = np.asarray(score_onsets)
    for w0 in np.arange(0, notated_end, WINDOW_SEC / 2):
        mask = (t >= w0) & (t < w0 + WINDOW_SEC)
        if mask.sum() >= 4:
            worst_window = min(worst_window, float(np.mean(hits[mask])))
    metrics["worst_window_agreement"] = round(worst_window, 3)

    if rate < PASS_RATE or worst_window < WINDOW_MIN_RATE:
        metrics["verdict"] = "onset_disagreement"
        raise AudioGateError(
            f"Only {rate * 100:.0f}% of score notes line up with the audio (any 5s stretch "
            f"minimum: {worst_window * 100:.0f}%). The audio doesn't follow the notated "
            "timeline closely enough for tap-to-seek and cursor sync.",
            metrics)

    metrics["verdict"] = "pass"
    return metrics


class AudioGateError(Exception):
    def __init__(self, reason: str, metrics: dict | None = None):
        super().__init__(reason)
        self.metrics = metrics or {}
