"""Pitch-aware note evidence for the reference-audio gate.

A score note counts as confirmed only if the recording shows an onset OF THAT PITCH
near the note's mapped time. Generic (pitch-blind) onset detection both under-recalls
on pedaled/legato piano (~67% on a verified-correct real recording) and over-accepts
wrong content on dense textures — pitch-specific evidence fixes both directions at
once (bake-off 2026-07-12: 97.9% true-pair recall, 4.8% on pitch-shifted content).

Evidence source: ByteDance high-resolution piano transcription (Apache-2.0 code,
onset F1 96.72% on pedaled MAESTRO). torch imports and model loading stay inside
transcribe_notes() so the module is importable without torch and tests can inject
fake note tables.

The checkpoint is NOT auto-downloaded by the upstream package inside the container
(it shells out to wget). Resolution order: TRANSCRIPTION_MODEL_PATH env → per-replica
cache → the soundfont blob container (same immutable-snapshot convention as SF2s).
"""
from __future__ import annotations
import os
import tempfile
from pathlib import Path

import numpy as np

MODEL_BLOB = "piano-transcription-crnn-20260712.pth"
_MODEL_CACHE = Path("/tmp/transcription-model")

WINDOW_SEC = 5.0
# The MrMsDTW path is corner-forced at the endpoints; a final ritardando/ring-out can
# push tail-note map error past any onset tolerance for EVERY evidence extractor
# (measured on a verified-correct recording: all windows 100%, terminal window 44%).
# The terminal region therefore still counts toward the overall rate, but is exempt
# from the worst-window kill. Truncated recordings stay caught by the duration gates.
TERMINAL_EXEMPT_SEC = 5.0


class NoteEvidenceUnavailable(Exception):
    pass


def score_notes_from_events(events: list[dict]) -> list[tuple[float, int]]:
    """(onset_sec, midi_pitch) per note — notes, not deduped onsets: a chord with a
    wrong member should lose evidence for that member."""
    return [(float(e["onset_sec"]), int(p)) for e in events for p in e["pitches"]]


def _resolve_model() -> Path:
    env = os.environ.get("TRANSCRIPTION_MODEL_PATH")
    if env and Path(env).exists():
        return Path(env)
    cached = _MODEL_CACHE / MODEL_BLOB
    if cached.exists():
        return cached
    cs = os.environ.get("STORAGE_CONNECTION_STRING")
    if not cs:
        raise NoteEvidenceUnavailable("no TRANSCRIPTION_MODEL_PATH and no storage connection")
    from azure.storage.blob import BlobServiceClient
    _MODEL_CACHE.mkdir(parents=True, exist_ok=True)
    client = BlobServiceClient.from_connection_string(cs).get_container_client("soundfont")
    # tmp+rename: a crashed download must never leave a truncated file that
    # exists() then trusts forever (same rule as the SF2 cache).
    fd, tmp = tempfile.mkstemp(dir=_MODEL_CACHE)
    try:
        with os.fdopen(fd, "wb") as f:
            client.get_blob_client(MODEL_BLOB).download_blob().readinto(f)
        os.replace(tmp, cached)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return cached


def transcribe_notes(audio_path: Path) -> dict[int, np.ndarray]:
    """midi_pitch -> sorted onset times (sec). Raises NoteEvidenceUnavailable when the
    engine cannot run here (missing model/torch) — callers degrade, not crash."""
    try:
        import librosa
        from piano_transcription_inference import PianoTranscription, sample_rate
    except ImportError as err:
        raise NoteEvidenceUnavailable(f"transcription engine not installed: {err}") from err
    model = _resolve_model()
    y, _ = librosa.load(str(audio_path), sr=sample_rate, mono=True)
    with tempfile.TemporaryDirectory() as tmp:
        out = PianoTranscription(device="cpu", checkpoint_path=str(model)).transcribe(
            y, str(Path(tmp) / "t.mid"))
    by_pitch: dict[int, list[float]] = {}
    for ev in out["est_note_events"]:
        by_pitch.setdefault(int(ev["midi_note"]), []).append(float(ev["onset_time"]))
    return {p: np.sort(np.asarray(t)) for p, t in by_pitch.items()}


def note_hits(score_notes: list[tuple[float, int]], mapped_sec: np.ndarray,
              notes_by_pitch: dict[int, np.ndarray], tol_sec: float) -> np.ndarray:
    hits = np.zeros(len(score_notes), dtype=bool)
    for k, ((_, pitch), t_audio) in enumerate(zip(score_notes, mapped_sec)):
        onsets = notes_by_pitch.get(pitch)
        if onsets is None or len(onsets) == 0:
            continue
        i = int(np.clip(np.searchsorted(onsets, t_audio), 0, len(onsets) - 1))
        prev = max(i - 1, 0)
        hits[k] = min(abs(t_audio - onsets[prev]), abs(t_audio - onsets[i])) <= tol_sec
    return hits


def evidence_rates(hits: np.ndarray, score_sec: np.ndarray) -> tuple[float, float]:
    """(overall rate, worst enforced 5s window). Windows over SCORE time so a locally
    broken stretch cannot hide in the mean; the terminal region is rate-counted but
    exempt from the worst-window kill (see TERMINAL_EXEMPT_SEC)."""
    rate = float(hits.mean()) if len(hits) else 0.0
    if len(hits) == 0:
        return rate, 0.0
    enforce_end = score_sec.max() - TERMINAL_EXEMPT_SEC
    worst = 1.0
    for w0 in np.arange(0.0, score_sec.max(), WINDOW_SEC):
        if w0 + WINDOW_SEC > enforce_end:
            break
        m = (score_sec >= w0) & (score_sec < w0 + WINDOW_SEC)
        if m.sum() >= 3:
            worst = min(worst, float(hits[m].mean()))
    return rate, worst
