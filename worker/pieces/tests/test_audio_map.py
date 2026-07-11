import sys, json, tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.audio_map import _simplify, _agreement, _write_map


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
