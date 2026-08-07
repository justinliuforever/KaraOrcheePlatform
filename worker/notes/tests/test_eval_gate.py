import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eval"))

from metrics import BooleanVerdict, LessonMetrics, compare_samples  # noqa: E402

KEY = "lesson_a"


def sample(json_ok=True, gate_failed=None, kept=10, quote_fidelity=0.8, grounded=3):
    return [LessonMetrics(key=KEY, json_ok=json_ok, gate_failed=gate_failed, proposed=12,
                          kept=kept, quote_fidelity=quote_fidelity, grounded=grounded)]


def verdicts(baseline, candidate):
    return compare_samples(baseline, candidate)


def test_a_candidate_that_stops_producing_json_in_one_run_is_a_regression():
    out = verdicts([sample(), sample(), sample()],
                   [sample(), sample(json_ok=False), sample()])
    broke = [v for v in out if isinstance(v, BooleanVerdict) and v.field == "json_ok"]
    assert len(broke) == 1
    assert broke[0].regressed
    assert any(v.regressed for v in out)


def test_a_candidate_that_newly_fails_a_gate_in_one_run_is_a_regression():
    out = verdicts([sample(), sample(), sample()],
                   [sample(), sample(), sample(gate_failed="quote_not_in_transcript")])
    broke = [v for v in out if isinstance(v, BooleanVerdict) and v.field == "gate_failed"]
    assert len(broke) == 1
    assert "quote_not_in_transcript" in broke[0].detail


def test_a_baseline_that_already_broke_is_not_charged_to_the_candidate():
    out = verdicts([sample(json_ok=False), sample(), sample()],
                   [sample(json_ok=False), sample(), sample()])
    assert not [v for v in out if isinstance(v, BooleanVerdict)]

    out = verdicts([sample(gate_failed="x"), sample(gate_failed="x")],
                   [sample(gate_failed="x"), sample(gate_failed="x")])
    assert not [v for v in out if isinstance(v, BooleanVerdict)]


def test_the_numeric_arms_still_read_their_tolerance_off_the_baseline_spread():
    out = [v for v in verdicts([sample(kept=12), sample(kept=10), sample(kept=11)],
                               [sample(kept=8), sample(kept=8), sample(kept=8)])
           if v.field == "kept"]
    assert len(out) == 1
    assert out[0].regressed

    steady = [v for v in verdicts([sample(kept=12), sample(kept=10), sample(kept=11)],
                                  [sample(kept=11), sample(kept=11), sample(kept=11)])
              if v.field == "kept"]
    assert not steady[0].regressed
