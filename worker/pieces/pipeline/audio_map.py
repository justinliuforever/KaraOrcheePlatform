"""Reference-audio time map: audio seconds ↔ score-timeline seconds.

Two tiers, ONE output schema (piecewise-linear breakpoints, strictly monotonic):
  Tier 1 — audio produced at the notated tempo: the existing linear gate passes and
           the map is just two breakpoints (a straight line).
  Tier 2 — expressive performances (rubato/ritardando): MrMsDTW (Sync Toolbox) aligns
           the recording against a deadpan synthesis of the score timeline, yielding a
           warped map. The map is only accepted if it passes the SAME onset-agreement
           self-check that gates Tier 1 — never trust an alignment, verify it.

The app consumes the map for tap-to-seek / cursor sync / keyboard hook; a Tier-1 file
is simply the special case where the map is straight. score files are never modified —
the map projects the audio onto the score's coordinate system, one-way.
"""
from __future__ import annotations
import json
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np

from pipeline.audio_gate import check_reference_audio, AudioGateError
from pipeline.note_evidence import (
    NoteEvidenceUnavailable, evidence_rates, note_hits, score_notes_from_events,
    transcribe_notes,
)

FEATURE_RATE = 50
FS = 22050
ONSET_TOL_SEC = 0.100
PASS_RATE = 0.90
WINDOW_SEC = 5.0
WINDOW_MIN_RATE = 0.60
# A recording at less than half / more than double the notated tempo is almost
# certainly the wrong file, not an interpretation.
RATIO_MIN, RATIO_MAX = 0.5, 2.0
MAX_BREAKPOINTS = 400
# Content-identity floor (data-anchored 2026-07-11: true expressive pair 0.774/0.548,
# impostor piece 0.428/0.000): onset agreement alone measures onset DENSITY, not
# identity — a dense wrong piece can fake it. Chroma along the path can't be faked.
CHROMA_SIM_MEAN_MIN = 0.60
CHROMA_SIM_P10_MIN = 0.15
# Map invariants: the DTW path runs into the deadpan synthesis' release tail, so the
# map is clamped to the written end; an interior breakpoint bending where the score
# has no event is an alignment artifact, not a tempo change.
MAP_BP_ONSET_TOL_SEC = 0.35


def _score_onsets(score_events_path: Path) -> tuple[np.ndarray, float]:
    events = json.loads(score_events_path.read_text())["events"]
    onsets = np.array(sorted({round(e["onset_sec"], 4) for e in events}))
    end = max(e["onset_sec"] + max(e["durations"]) for e in events)
    return onsets, end


def _audio_onsets(audio_path: Path) -> np.ndarray:
    y, _ = librosa.load(str(audio_path), sr=FS, mono=True)
    return np.array(sorted(librosa.onset.onset_detect(y=y, sr=FS, units="time")))


def _agreement(mapped: np.ndarray, audio_onsets: np.ndarray) -> tuple[float, float, float]:
    """(overall rate, worst 5s-window rate, median |Δ| sec) for mapped score onsets."""
    i = np.searchsorted(audio_onsets, mapped)
    i = np.clip(i, 0, len(audio_onsets) - 1)
    prev = np.clip(i - 1, 0, len(audio_onsets) - 1)
    d = np.minimum(np.abs(mapped - audio_onsets[prev]), np.abs(mapped - audio_onsets[i]))
    ok = d <= ONSET_TOL_SEC
    worst = 1.0
    # windows over SCORE time so a locally-broken stretch cannot hide in the mean
    score_t = mapped  # monotonic map ⇒ windowing over mapped time is equivalent
    for w0 in np.arange(0, score_t.max(), WINDOW_SEC):
        m = (score_t >= w0) & (score_t < w0 + WINDOW_SEC)
        if m.sum() >= 3:
            worst = min(worst, float(ok[m].mean()))
    return float(ok.mean()), worst, float(np.median(d))


def _simplify(xs: np.ndarray, ys: np.ndarray, tol_sec: float = 0.010) -> tuple[list[float], list[float]]:
    """Greedy polyline simplification: keep only breakpoints needed to reproduce the
    map within tol. Keeps the payload app-friendly (a few hundred points max)."""
    keep = [0]
    anchor = 0
    for k in range(2, len(xs)):
        seg = np.interp(xs[anchor:k + 1], [xs[anchor], xs[k]], [ys[anchor], ys[k]])
        if np.max(np.abs(seg - ys[anchor:k + 1])) > tol_sec:
            keep.append(k - 1)
            anchor = k - 1
    keep.append(len(xs) - 1)
    if len(keep) > MAX_BREAKPOINTS:
        idx = np.linspace(0, len(keep) - 1, MAX_BREAKPOINTS).astype(int)
        keep = [keep[j] for j in idx]
    return [round(float(xs[k]), 4) for k in keep], [round(float(ys[k]), 4) for k in keep]


def clamp_map_to_end(score_sec: list[float], audio_sec: list[float],
                     end_sec: float) -> tuple[list[float], list[float]]:
    """Clamp breakpoints to the written end: drop points past it, terminate the map
    exactly at (end, interp(end))."""
    if score_sec[-1] <= end_sec:
        return list(score_sec), list(audio_sec)
    y_end = float(np.interp(end_sec, score_sec, audio_sec))
    k = next(i for i, x in enumerate(score_sec) if x >= end_sec)
    return list(score_sec[:k]) + [round(end_sec, 4)], list(audio_sec[:k]) + [round(y_end, 4)]


def check_map_invariants(score_sec, audio_sec, onsets, last_onset: float) -> None:
    """Both axes strictly monotone, and every body breakpoint (score_sec <= last onset;
    the first breakpoint is the map origin, the tail sits at the written end) within
    MAP_BP_ONSET_TOL_SEC of a score onset. Violations raise AudioGateError with numbers."""
    xs, ys = np.asarray(score_sec, dtype=float), np.asarray(audio_sec, dtype=float)
    flat = (np.diff(xs) <= 0) | (np.diff(ys) <= 0)
    if flat.any():
        k = int(np.argmax(flat))
        raise AudioGateError(
            f"audio map is not strictly monotonic: {int(flat.sum())} non-increasing steps "
            f"(first at breakpoint {k}: score {xs[k]:.3f}->{xs[k + 1]:.3f}s, "
            f"audio {ys[k]:.3f}->{ys[k + 1]:.3f}s)",
            {"map_breakpoints": len(xs), "map_monotone_violations": int(flat.sum())})
    ov = np.asarray(onsets, dtype=float)
    body = xs[1:][xs[1:] <= last_onset + 1e-6]
    if len(body) and len(ov):
        i = np.searchsorted(ov, body)
        d = np.minimum(np.abs(body - ov[np.clip(i - 1, 0, len(ov) - 1)]),
                       np.abs(body - ov[np.clip(i, 0, len(ov) - 1)]))
        far = d > MAP_BP_ONSET_TOL_SEC
        if far.any():
            w = int(np.argmax(d))
            raise AudioGateError(
                f"{int(far.sum())}/{len(body)} audio-map breakpoints sit more than "
                f"{MAP_BP_ONSET_TOL_SEC}s from any score onset (worst {d[w]:.2f}s at "
                f"score_sec {body[w]:.2f}) — the map bends where the score has no event",
                {"map_breakpoints": len(xs), "map_bp_far_from_onset": int(far.sum()),
                 "map_bp_worst_dev_sec": round(float(d[w]), 3)})


def _deadpan_wav(score_events_path: Path, sf2_path: Path, program: int, out_dir: Path) -> Path:
    """Deadpan synthesis of the score timeline — the reference side of the alignment.
    Reuses the preview render (same soundfont) when it exists."""
    preview = out_dir / "preview.m4a"
    if preview.exists():
        return preview  # librosa decodes AAC via ffmpeg; chroma is codec-insensitive
    from pipeline.preview import _write_midi
    events = json.loads(score_events_path.read_text())["events"]
    midi = out_dir / "_map_deadpan.mid"
    _write_midi(events, midi, program)
    wav = out_dir / "_map_deadpan.wav"
    subprocess.run(["fluidsynth", "-ni", "-g", "0.6", "-F", str(wav), "-r", str(FS),
                    str(sf2_path), str(midi)], check=True, capture_output=True, timeout=600)
    return wav


def _tier2_map(audio_path: Path, deadpan_path: Path) -> tuple[np.ndarray, np.ndarray, float, float]:
    import matplotlib
    matplotlib.use("Agg")  # synctoolbox imports pyplot; the worker is headless
    from synctoolbox.feature.chroma import pitch_to_chroma, quantize_chroma
    from synctoolbox.feature.pitch import audio_to_pitch_features
    from synctoolbox.feature.pitch_onset import audio_to_pitch_onset_features
    from synctoolbox.feature.dlnco import pitch_onset_features_to_DLNCO
    from synctoolbox.dtw.mrmsdtw import sync_via_mrmsdtw
    from synctoolbox.dtw.utils import make_path_strictly_monotonic

    def feats(path: Path):
        audio, _ = librosa.load(str(path), sr=FS, mono=True)
        f_pitch = audio_to_pitch_features(f_audio=audio, Fs=FS, feature_rate=FEATURE_RATE, verbose=False)
        f_chroma = quantize_chroma(f_chroma=pitch_to_chroma(f_pitch=f_pitch))
        f_po = audio_to_pitch_onset_features(f_audio=audio, Fs=FS, verbose=False)
        f_dlnco = pitch_onset_features_to_DLNCO(
            f_peaks=f_po, feature_rate=FEATURE_RATE,
            feature_sequence_length=f_chroma.shape[1], visualize=False)
        return f_chroma, f_dlnco

    c1, o1 = feats(deadpan_path)   # score timeline
    c2, o2 = feats(audio_path)     # the performance
    wp = sync_via_mrmsdtw(f_chroma1=c1, f_onset1=o1, f_chroma2=c2, f_onset2=o2,
                          input_feature_rate=FEATURE_RATE, verbose=False)
    wp = make_path_strictly_monotonic(wp).astype(int)
    # Pitch-content identity along the path: cosine similarity of the two chroma
    # sequences at each aligned frame pair.
    a, b = c1[:, wp[0]], c2[:, wp[1]]
    na, nb = np.linalg.norm(a, axis=0), np.linalg.norm(b, axis=0)
    ok = (na > 1e-6) & (nb > 1e-6)
    cos = (a[:, ok] * b[:, ok]).sum(0) / (na[ok] * nb[ok])
    sim_mean = float(np.mean(cos)) if ok.any() else 0.0
    sim_p10 = float(np.percentile(cos, 10)) if ok.any() else 0.0
    return wp[0] / FEATURE_RATE, wp[1] / FEATURE_RATE, sim_mean, sim_p10


def build_time_map(audio_path: Path, score_events_path: Path, out_dir: Path,
                   sf2_path: Path | None, program: int,
                   transcriber=None, playback: dict | None = None) -> dict:
    """Verify the reference audio and write audio_map.json. Returns gate metrics.
    Raises AudioGateError when neither tier can vouch for the recording.
    transcriber: audio_path -> {pitch: sorted onset sec} (tests inject a fake;
    None = the real transcription engine)."""
    # Tier 1: the strict linear gate (cheap, and most uploads are studio renders).
    try:
        metrics = check_reference_audio(audio_path, score_events_path)
        onsets, notated_end = _score_onsets(score_events_path)
        content = metrics["content_duration_sec"]
        lead = metrics["lead_in_sec"]
        xs = [0.0, round(float(notated_end), 4)]
        ys = [round(lead, 4), round(lead + content, 4)]
        check_map_invariants(xs, ys, onsets, float(onsets[-1]))
        _write_map(out_dir, xs, ys, tier=1)
        metrics["tier"] = 1
        return metrics
    except AudioGateError as tier1_err:
        tier1_metrics = dict(tier1_err.metrics)

    # Tier 2: expressive performance — align, then verify the alignment.
    if sf2_path is None or not sf2_path.exists():
        raise AudioGateError(
            str(tier1_err) + " (expressive-alignment fallback unavailable: no soundfont)",
            tier1_metrics)
    score_onsets, notated_end = _score_onsets(score_events_path)
    ratio = tier1_metrics.get("duration_ratio")
    if ratio is not None and not (RATIO_MIN <= ratio <= RATIO_MAX):
        hint = ""
        if playback is not None and ratio < 1.0:
            lin = sum(o["expanded_sec_end"] - o["expanded_sec_start"]
                      for o in playback["occurrences"] if o["pass"] == 1)
            total = playback["counts"]["expanded_duration_sec"] or 1.0
            if abs(ratio - lin / total) < 0.12:
                hint = (" The length matches a performance that SKIPS the repeats — this "
                        "score plays its repeats; record with all repeats taken.")
        raise AudioGateError(
            f"The audio is {ratio:.2f}x the notated length — too far from the score to be "
            "an interpretation of it." + hint,
            tier1_metrics)
    try:
        map_score, map_audio, sim_mean, sim_p10 = _tier2_map(
            audio_path, _deadpan_wav(score_events_path, sf2_path, program, out_dir))
    except ImportError:
        raise AudioGateError(str(tier1_err) + " (expressive-alignment engine not installed)",
                             tier1_metrics) from None
    except Exception as err:
        # An alignment crash must degrade to the accurate Tier-1 verdict, not a stack trace.
        raise AudioGateError(
            str(tier1_err) + f" (expressive-alignment attempt failed: {type(err).__name__})",
            tier1_metrics) from err

    mapped = np.interp(score_onsets, map_score, map_audio)
    agree, worst, med = _agreement(mapped, _audio_onsets(audio_path))
    metrics = {
        **tier1_metrics, "tier": 2,
        "map_onset_agreement": round(agree, 3),
        "map_worst_window": round(worst, 3),
        "map_median_dev_ms": round(med * 1000, 1),
        "map_chroma_sim": round(sim_mean, 3),
        "map_chroma_sim_p10": round(sim_p10, 3),
    }
    if sim_mean < CHROMA_SIM_MEAN_MIN or sim_p10 < CHROMA_SIM_P10_MIN:
        raise AudioGateError(
            f"The audio's pitch content matches the score only weakly (similarity "
            f"{sim_mean:.0%}) — this recording does not appear to be this piece. Check "
            "that the right audio file was uploaded.",
            metrics)

    if playback is not None:
        worst_span = _span_duration_check(playback, map_score, map_audio)
        metrics["map_worst_span_ratio"] = round(worst_span[0], 3)
        if worst_span[0] < SPAN_RATIO_MIN:
            sp = worst_span[1]
            raise AudioGateError(
                f"The recording gives measures {sp['written_start']}-{sp['written_end']} "
                f"(pass {sp['pass']}) only {worst_span[0]:.0%} of their proportional time — "
                "a repeat pass appears to be skipped or cut. This score plays its repeats; "
                "record the full structure and re-upload.",
                metrics)

    # Note-level verdict: pitch-aware evidence (a note is confirmed only by an onset
    # OF ITS PITCH at its mapped time). The pitch-blind onset agreement above stays as
    # telemetry only. If the engine cannot run here, the old verdict path applies.
    events = json.loads(score_events_path.read_text())["events"]
    notes = score_notes_from_events(events)
    try:
        by_pitch = (transcriber or transcribe_notes)(audio_path)
        note_sec = np.array([s for s, _ in notes])
        hits = note_hits(notes, np.interp(note_sec, map_score, map_audio), by_pitch, ONSET_TOL_SEC)
        ev_rate, ev_worst = evidence_rates(hits, note_sec)
        metrics.update({
            "map_note_evidence": round(ev_rate, 3),
            "map_note_worst_window": round(ev_worst, 3),
            "n_score_notes": len(notes),
            "evidence_engine": "transcription-v1",
        })
        if ev_rate < PASS_RATE or ev_worst < WINDOW_MIN_RATE:
            raise AudioGateError(
                _evidence_failure_message(ev_rate, ev_worst, sim_mean,
                                          metrics.get("duration_ratio")),
                metrics)
    except NoteEvidenceUnavailable as err:
        metrics["evidence_engine"] = f"onset-fallback ({err})"
        if agree < PASS_RATE or worst < WINDOW_MIN_RATE:
            raise AudioGateError(
                f"Even allowing expressive timing, only {agree:.0%} of score notes line up "
                f"with the audio (worst 5s stretch: {worst:.0%}). The audio doesn't follow "
                "the score timeline closely enough for tap-to-seek and cursor sync.",
                metrics) from None
    xs, ys = _simplify(map_score, map_audio)
    clamped = xs[-1] > notated_end
    xs, ys = clamp_map_to_end(xs, ys, round(float(notated_end), 4))
    check_map_invariants(xs, ys, score_onsets, float(score_onsets[-1]))
    _write_map(out_dir, xs, ys, tier=2)
    metrics["map_breakpoints"] = len(xs)
    metrics["map_clamped_to_end"] = bool(clamped)
    return metrics


# Floor anchored 2026-07-13 on real data: the correct full-structure recording's worst
# span is 0.993x proportional time; a recording with its repeat passes cut out measures
# 0.508 (the DTW spreads the deficit rather than fully cramming one span). 0.75 sits
# 0.24 from both anchors.
SPAN_RATIO_MIN = 0.75


def _span_duration_check(playback: dict, map_score, map_audio):
    """(worst ratio, its span): per-span audio extent under the map vs the span's
    proportional share — the DTW-cramming detector onset evidence cannot provide."""
    total_score = playback["counts"]["expanded_duration_sec"] or 1.0
    total_audio = float(np.interp(total_score, map_score, map_audio) - np.interp(0.0, map_score, map_audio)) or 1.0
    worst = (float("inf"), None)
    for sp in playback["spans"]:
        dur = sp["expanded_sec_end"] - sp["expanded_sec_start"]
        if dur < 1.0:
            continue
        a0 = float(np.interp(sp["expanded_sec_start"], map_score, map_audio))
        a1 = float(np.interp(sp["expanded_sec_end"], map_score, map_audio))
        expected = dur / total_score * total_audio
        ratio = (a1 - a0) / expected if expected > 0 else 0.0
        if ratio < worst[0]:
            worst = (ratio, sp)
    return worst if worst[1] is not None else (1.0, None)


def _evidence_failure_message(ev_rate: float, ev_worst: float, sim_mean: float,
                              ratio: float | None) -> str:
    """Attribution honesty: a structure claim needs structure evidence (here: the
    duration ratio); otherwise the verified facts point at recording conditions,
    and telling the uploader to fix structure would send them chasing a ghost."""
    if ratio is not None and abs(ratio - 1.0) > 0.10:
        return (
            f"Only {ev_rate:.0%} of score notes are confirmed in the recording "
            f"(worst 5s stretch: {ev_worst:.0%}), and the recording is "
            f"{(ratio - 1) * 100:+.0f}% the score's length — the recording's "
            "structure likely differs from the score (missing/extra repeats, cuts, "
            "added material). Make the recording follow the score's structure and re-upload.")
    return (
        f"The recording is verified as this piece (pitch identity {sim_mean:.0%}) "
        f"and matches its length, but only {ev_rate:.0%} of notes show clear "
        f"evidence at their expected times (worst 5s stretch: {ev_worst:.0%}); "
        f"the bar is {PASS_RATE:.0%}. Common causes: heavy sustain pedal, distant "
        "microphone, strong reverb, or background noise. A drier, closer recording "
        "of the same performance will usually pass.")


def _write_map(out_dir: Path, score_sec: list[float], audio_sec: list[float], tier: int) -> None:
    (out_dir / "audio_map.json").write_text(json.dumps({
        "version": 1,
        "tier": tier,
        "score_sec": score_sec,
        "audio_sec": audio_sec,
    }))
