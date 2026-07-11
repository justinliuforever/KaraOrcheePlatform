import sys, random
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.diagnose import _theil_sen, _nearest_median_ms, _align


def test_theil_sen_recovers_line():
    xs = [float(i) for i in range(100)]
    ys = [1.25 * x + 3.0 for x in xs]
    s, c = _theil_sen(xs, ys)
    assert abs(s - 1.25) < 0.01 and abs(c - 3.0) < 0.1


def test_theil_sen_robust_to_outliers():
    rng = random.Random(1)
    xs = [float(i) for i in range(100)]
    ys = [x * 1.0 for x in xs]
    for i in rng.sample(range(100), 15):
        ys[i] += 50  # 15% gross outliers must not move the median slope
    s, _ = _theil_sen(xs, ys)
    assert abs(s - 1.0) < 0.05


def test_nearest_median():
    assert _nearest_median_ms([0.0, 1.0, 2.0], [0.01, 1.01, 2.01]) == 10.0
    assert _nearest_median_ms([0.0, 1.0], [0.0, 1.0]) == 0.0


def ev_x(q, pitches):
    return {"q": float(q), "sec": q / 2.0, "pitches": frozenset(pitches), "grace": False}


def ev_m(beat, pitches):
    return {"beat": float(beat), "sec": beat / 2.0, "pitches": frozenset(pitches)}


def test_align_identical_is_diagonal():
    xa = [ev_x(i, [60 + i % 12]) for i in range(50)]
    xb = [ev_m(i, [60 + i % 12]) for i in range(50)]
    pairs = _align(xa, xb)
    assert pairs == [(i, i) for i in range(50)]


def test_align_survives_ornament_surplus():
    # MIDI has 5 extra trill notes inserted mid-stream; matched pairs must stay
    # index-true on both flanks (index pairing would shift the whole tail).
    xa = [ev_x(i, [60 + i % 12]) for i in range(40)]
    xb = [ev_m(i, [60 + i % 12]) for i in range(20)]
    for k in range(5):
        xb.append(ev_m(20 + k * 0.1, [99]))  # foreign-pitch ornament burst
    xb += [ev_m(i + 1, [60 + i % 12]) for i in range(20, 39)]
    pairs = _align(xa, xb)
    d = dict(pairs)
    assert d.get(10) == 10   # before the burst
    # After the burst the aligner must follow CONTENT (pitch), not index: xa[30]
    # (pitch 66) pairs with the xb event carrying pitch 66 at index 35. The residual
    # beat delta of +1 is exactly the structure-divergence signal downstream reads.
    assert d.get(30) == 35
