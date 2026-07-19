import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from gates import GateError, gate_alignment, gate_geometry, run_all
from pipeline.staff import (ANCHOR_COVERAGE_MIN, ANCHOR_GAP_RATIO, ENDPOINT_SLACK_SEC,
                            RESIDUAL_P50_MS, RESIDUAL_P90_MS, anchor_gap_check,
                            score_events_end_sec, staff_gate_reasons,
                            timeline_residual_ms, timemap_rend_count)
from tests.test_structure import ATTRS, FWD, bwd, measure, score

FIX = Path(__file__).parent / "fixtures"
BACH = "bach_bwv_846"
CZERNY = "czerny_practical_method_beginners_op_599_no_57"
PASTORALE = "burgmuller_twenty_five_easy_etudes_op_100_pastorale_pastorale"


def _events_file(tmp: Path, onsets, dur=0.2) -> Path:
    p = tmp / "ev.json"
    p.write_text(json.dumps({"events": [
        {"idx": k, "onset_sec": t, "pitches": [60], "durations": [dur]}
        for k, t in enumerate(onsets)]}))
    return p


def _bundle(**over):
    b = {"schema": 2, "timeline_residual_ms_p50": 1.0, "timeline_residual_ms_p90": 5.0,
         "anchor_coverage": 1.0, "anchor_max_gap_sec": 0.5, "anchor_max_gap_ratio": 0.5,
         "anchor_max_gap_at_sec": 0.0, "timemap_rend_ids": 0,
         "score_events_end_sec": 47.5, "map_end_sec": 48.0}
    b.update(over)
    return b


def _meta():
    return {"n_parts": 1, "parts": [{"id": "P1"}]}


def test_anchor_hole_fails_coverage_p90_and_gap(tmp_path):
    onsets = [k * 0.5 for k in range(80)]
    anchors = [t for t in onsets if not (10.0 <= t <= 26.0)]     # 16s hole, pastorale-shaped
    p50, p90, cov = timeline_residual_ms(_events_file(tmp_path, onsets), anchors)
    assert p50 < RESIDUAL_P50_MS                                 # the old p50-only gate passes it
    assert p90 >= RESIDUAL_P90_MS
    assert cov < ANCHOR_COVERAGE_MIN
    bounds = [(2.0 * k, 2.0 * (k + 1)) for k in range(20)]
    g = anchor_gap_check(anchors, bounds)
    assert not g["ok"] and g["max_gap_ratio"] > ANCHOR_GAP_RATIO
    assert g["max_gap_sec"] > 15


def test_gap_check_tolerates_held_chords_in_long_measures():
    # rach op23/4 / scriabin op8/11 class: multi-second silence inside long measures
    anchors = [0.0, 1.0, 2.0, 8.0, 9.0, 10.0, 11.0]
    bounds = [(4.0 * k, 4.0 * (k + 1)) for k in range(4)]
    assert anchor_gap_check(anchors, bounds)["ok"]               # 6s gap / 4s measures = 1.5x


def test_gap_check_ignores_terminal_gap_only():
    bounds = [(k * 1.0, (k + 1) * 1.0) for k in range(13)]
    assert anchor_gap_check([0.0, 1.0, 2.0, 3.0, 12.0], bounds)["ok"]
    assert not anchor_gap_check([0.0, 1.0, 2.0, 3.0, 12.0, 12.5], bounds)["ok"]


def test_timemap_rend_count():
    tm = [{"measureOn": "m1", "on": ["n1"]},
          {"measureOn": "m1-rend2", "on": ["n1-rend2", "n2"]}]
    assert timemap_rend_count(tm) == 2
    assert timemap_rend_count([{"measureOn": "m1"}, {"on": ["n1"]}]) == 0


def test_reasons_healthy_bundle_empty():
    assert staff_gate_reasons(_bundle()) == []


def test_reasons_schema1_with_rend_ids_flagged():
    assert staff_gate_reasons(_bundle(schema=2, timemap_rend_ids=50)) == []
    r = staff_gate_reasons(_bundle(schema=1, timemap_rend_ids=50))
    assert len(r) == 1 and "-rend" in r[0]


def test_reasons_p90_alone_fails_even_with_clean_p50():
    r = staff_gate_reasons(_bundle(timeline_residual_ms_p90=4460.8))
    assert len(r) == 1 and "p90" in r[0]


def test_reasons_endpoint_release_early_ok_overrun_fails():
    assert staff_gate_reasons(_bundle(score_events_end_sec=40.0, map_end_sec=48.0)) == []
    assert staff_gate_reasons(_bundle(score_events_end_sec=48.04, map_end_sec=48.0)) == []
    r = staff_gate_reasons(_bundle(score_events_end_sec=48.2, map_end_sec=48.0))
    assert len(r) == 1 and "overrun" in r[0] and "48.2" in r[0] and "48.0" in r[0]


def test_schema1_build_over_expanded_timemap_hard_fails(tmp_path):
    # the shipped split-brain reproduced: repeats in the XML, no playback map (pre-07-12 path)
    ms = [measure(1, ATTRS), measure(2, FWD)]
    ms += [measure(i) for i in range(3, 8)]
    ms += [measure(8, bwd())]
    ms += [measure(i) for i in range(9, 13)]
    xml = score(*ms)
    gate_alignment(xml, None, tmp_path, _meta(), None, None)
    with pytest.raises(GateError, match="-rend") as ei:
        gate_geometry("piece", xml, tmp_path, _meta(), None, None)
    assert ei.value.metrics["timemap_rend_ids"] > 0
    assert ei.value.metrics["staff_eligible"] is False


def test_endpoint_overrun_hard_fails_with_both_numbers(tmp_path):
    xml = score(measure(1, ATTRS), measure(2), measure(3), measure(4))
    gate_alignment(xml, None, tmp_path, _meta(), None, None)
    ev = json.loads((tmp_path / "score_events.json").read_text())
    ev["events"][-1]["durations"] = [30.0]
    (tmp_path / "score_events.json").write_text(json.dumps(ev))
    with pytest.raises(GateError, match="overrun") as ei:
        gate_geometry("piece", xml, tmp_path, _meta(), None, None)
    m = ei.value.metrics
    assert m["score_events_end_sec"] > m["map_end_sec"] + ENDPOINT_SLACK_SEC
    assert str(m["score_events_end_sec"]) in str(ei.value)
    assert str(m["map_end_sec"]) in str(ei.value)


def test_linear_preflight_green_and_emits_gate_metrics(tmp_path):
    xml = score(measure(1, ATTRS), measure(2), measure(3), measure(4))
    got = {}
    run_all("job", "piece", xml, None, tmp_path,
            on_gate=lambda st, status, m, e: got.update({st: (status, m)}),
            include_render=False)
    status, m = got["geometry"]
    assert status == "pass"
    for k in ("residual_p90_ms", "residual_p90_gate_ms", "residual_p90_gate_basis",
              "anchor_coverage", "anchor_coverage_min", "anchor_max_gap_ratio",
              "anchor_gap_ratio_max", "timemap_rend_ids", "score_events_end_sec",
              "map_end_sec", "endpoint_slack_sec"):
        assert k in m
    assert m["timemap_rend_ids"] == 0
    assert m["anchor_coverage"] == 1.0
    assert m["score_events_end_sec"] <= m["map_end_sec"] + ENDPOINT_SLACK_SEC


def test_real_bach_passes_all_new_checks():
    b = json.loads((FIX / f"{BACH}.staff.json").read_text())
    anchors = [a[0] for a in b["variants"]["phone"]["cursor_anchors"]]
    p50, p90, cov = timeline_residual_ms(FIX / f"{BACH}.score_events.json", anchors)
    assert p50 < RESIDUAL_P50_MS and p90 < RESIDUAL_P90_MS and cov >= ANCHOR_COVERAGE_MIN
    bounds = [(m["score_sec_start"], m["score_sec_end"]) for m in b["identity"]["measures"]]
    assert anchor_gap_check(anchors, bounds)["ok"]


def test_real_czerny_repeat_piece_passes_incl_endpoint():
    b = json.loads((FIX / f"{CZERNY}.staff.json").read_text())
    assert b["schema"] == 2
    anchors = [a[0] for a in b["variants"]["phone"]["cursor_anchors"]]
    p50, p90, cov = timeline_residual_ms(FIX / f"{CZERNY}.score_events.json", anchors)
    assert p50 < RESIDUAL_P50_MS and p90 < RESIDUAL_P90_MS and cov >= ANCHOR_COVERAGE_MIN
    bounds = [(o["expanded_sec_start"], o["expanded_sec_end"])
              for o in b["playback"]["occurrences"]]
    assert anchor_gap_check(anchors, bounds)["ok"]
    ee = score_events_end_sec(FIX / f"{CZERNY}.score_events.json")
    me = b["playback"]["counts"]["expanded_duration_sec"]
    assert ee < me                                               # release before final barline = normal
    assert staff_gate_reasons(_bundle(timeline_residual_ms_p50=p50, timeline_residual_ms_p90=p90,
                                      anchor_coverage=cov, score_events_end_sec=ee,
                                      map_end_sec=me)) == []


def test_real_pastorale_shipped_bundle_trips_every_new_check():
    # the published split-brain build (16.3s anchor hole, 50/226 onsets anchorless)
    b = json.loads((FIX / f"{PASTORALE}.staff.json").read_text())
    assert b["schema"] == 1
    anchors = [a[0] for a in b["variants"]["phone"]["cursor_anchors"]]
    p50, p90, cov = timeline_residual_ms(FIX / f"{PASTORALE}.score_events.json", anchors)
    assert p50 < RESIDUAL_P50_MS                                 # why the old gate published it
    assert p90 >= RESIDUAL_P90_MS
    assert cov < ANCHOR_COVERAGE_MIN
    bounds = [(m["score_sec_start"], m["score_sec_end"]) for m in b["identity"]["measures"]]
    g = anchor_gap_check(anchors, bounds)
    assert not g["ok"] and g["max_gap_sec"] > 15
    reasons = staff_gate_reasons(_bundle(schema=1, timeline_residual_ms_p50=p50,
                                         timeline_residual_ms_p90=p90, anchor_coverage=cov,
                                         anchor_max_gap_sec=g["max_gap_sec"],
                                         anchor_max_gap_ratio=g["max_gap_ratio"],
                                         anchor_max_gap_at_sec=g["max_gap_at_sec"]))
    assert len(reasons) == 3                                     # p90 + coverage + hole
