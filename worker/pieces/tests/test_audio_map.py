import sys, json, tempfile
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import pipeline.audio_map as audio_map
from pipeline.audio_gate import AudioGateError
from pipeline.audio_map import (MAP_BP_ONSET_TOL_SEC, _agreement, _simplify, _write_map,
                                build_time_map, check_map_invariants, clamp_map_to_end)


def test_simplify_straight_line_two_points():
    xs = np.linspace(0, 60, 3000)
    ys = xs * 1.05 + 0.2
    sx, sy = _simplify(xs, ys)
    assert len(sx) == 2
    assert abs(np.interp(30.0, sx, sy) - (30 * 1.05 + 0.2)) < 0.01


def test_simplify_preserves_warp_within_tolerance():
    xs = np.linspace(0, 60, 3000)
    ys = xs + 0.5 * np.sin(xs / 6.0)  # gentle rubato-like warp
    sx, sy = _simplify(xs, ys, tol_sec=0.010)
    probe = np.linspace(0, 60, 500)
    err = np.abs(np.interp(probe, sx, sy) - np.interp(probe, xs, ys))
    assert err.max() < 0.030
    assert 2 < len(sx) <= 400


def test_agreement_windows_catch_local_break():
    onsets = np.arange(0, 30, 0.5)
    audio = onsets.copy()
    audio[40:50] += 0.4  # a 5s stretch broken beyond the 100ms tolerance
    overall, worst, med = _agreement(onsets, np.sort(audio))
    assert overall > 0.8
    assert worst <= 0.4  # the windowed check must expose it
    assert med < 0.02


def test_write_map_schema():
    tmp = Path(tempfile.mkdtemp())
    _write_map(tmp, [0.0, 61.66], [0.0, 61.8], tier=1)
    mp = json.loads((tmp / "audio_map.json").read_text())
    assert mp == {"version": 1, "tier": 1, "score_sec": [0.0, 61.66], "audio_sec": [0.0, 61.8]}


def test_clamp_drops_tail_past_written_end():
    xs, ys = clamp_map_to_end([0.0, 10.0, 20.0, 25.0], [0.0, 11.0, 21.0, 27.0], 22.0)
    assert xs == [0.0, 10.0, 20.0, 22.0]
    assert ys[:3] == [0.0, 11.0, 21.0]
    assert ys[3] == pytest.approx(21.0 + 2 / 5 * 6, abs=1e-4)   # interp at the end


def test_clamp_noop_when_within_end():
    xs, ys = clamp_map_to_end([0.0, 10.0], [0.5, 10.5], 22.0)
    assert xs == [0.0, 10.0] and ys == [0.5, 10.5]


def test_check_far_breakpoint_fails_with_numbers():
    onsets = [0.0, 1.0, 2.0, 3.0, 10.0]
    with pytest.raises(AudioGateError) as ei:
        check_map_invariants([0.0, 6.0, 10.0, 12.0], [0.0, 6.1, 10.2, 12.3], onsets, 10.0)
    assert "6.00" in str(ei.value) and "3.00" in str(ei.value)  # where + how far
    assert ei.value.metrics["map_bp_far_from_onset"] == 1
    assert ei.value.metrics["map_bp_worst_dev_sec"] == pytest.approx(3.0)


def test_check_monotone_violation_fails_on_either_axis():
    onsets = list(np.arange(0.0, 12.5, 0.5))
    with pytest.raises(AudioGateError, match="monotonic") as ei:
        check_map_invariants([0.0, 5.0, 5.0, 10.0], [0.0, 5.0, 6.0, 10.0], onsets, 12.0)
    assert ei.value.metrics["map_monotone_violations"] == 1
    with pytest.raises(AudioGateError, match="monotonic"):
        check_map_invariants([0.0, 5.0, 10.0], [0.0, 6.0, 5.5], onsets, 12.0)


def test_check_tier1_straight_map_passes():
    # origin bp exempt (piece may start with a rest); tail bp sits past the last onset
    onsets = [0.5, 1.0, 1.5, 2.0]
    check_map_invariants([0.0, 2.4], [0.1, 2.6], onsets, 2.0)


def test_build_time_map_tier1_writes_checked_map(tmp_path, monkeypatch):
    ev = tmp_path / "score_events.json"
    ev.write_text(json.dumps({"events": [
        {"onset_sec": t, "pitches": [60], "durations": [0.5]} for t in (0.0, 1.0, 2.0)]}))
    monkeypatch.setattr(audio_map, "check_reference_audio",
                        lambda a, s: {"content_duration_sec": 2.6, "lead_in_sec": 0.1,
                                      "duration_ratio": 1.04})
    m = build_time_map(tmp_path / "x.m4a", ev, tmp_path, None, 0)
    assert m["tier"] == 1
    mp = json.loads((tmp_path / "audio_map.json").read_text())
    assert mp["score_sec"] == [0.0, 2.5]                        # notated end, not audio end
    assert mp["audio_sec"] == [0.1, 2.7]
