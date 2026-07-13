import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from gates import run_all
from tests.test_structure import ATTRS, FWD, bwd, estart, estop, measure, score
from tests.test_gate_structure import _midi_from_timeline, _repeat_score


def _run(xml: Path, midi: Path, tmp: Path):
    seen = []
    files = run_all("job", "piece", xml, midi, tmp,
                    on_gate=lambda st, status, m, e: seen.append((st, status)),
                    include_render=False)
    return seen, files


def test_full_preflight_on_repeat_piece(tmp_path):
    xml = _repeat_score()
    midi = _midi_from_timeline(xml, tmp_path, expanded=True)
    seen, _ = _run(xml, midi, tmp_path)
    assert ("structure", "pass") in seen and ("geometry", "pass") in seen

    ev = json.loads((tmp_path / "score_events.json").read_text())
    pb = ev["playback"]
    assert pb["spans"][0]["first_event_idx"] == 0
    assert pb["spans"][-1]["last_event_idx"] == ev["n_events"] - 1
    assert any(sp["jump_in"] == "backward" for sp in pb["spans"])
    assert pb["twin_groups"] and all(len(g) >= 2 for g in pb["twin_groups"])

    staff = json.loads((tmp_path / "piece.staff.json").read_text())
    assert staff["schema"] == 2
    assert "pass" in staff["anchor_rule"]
    counts = staff["playback"]["counts"]
    assert counts["written_measures"] == 12 and counts["played_measures"] == 18
    idm = staff["identity"]["measures"]
    assert len(idm) == 12                                  # one row per WRITTEN measure
    assert [m["measure_index"] for m in idm] == list(range(1, 13))
    assert all(m["passes"] == (2 if 3 <= m["measure_index"] <= 8 else 1) for m in idm)
    # anchors stay monotone in expanded time
    anchors = staff["variants"]["phone"]["cursor_anchors"]
    assert all(anchors[k][0] <= anchors[k + 1][0] for k in range(len(anchors) - 1))
    # max data-measure-index rendered == written count (SVG stays compact)
    svg = (tmp_path / "piece.phone.svg").read_text()
    import re
    assert max(int(x) for x in re.findall(r'data-measure-index="(\d+)"', svg)) == 12


def test_full_preflight_on_linear_piece_unchanged_shape(tmp_path):
    xml = score(measure(1, ATTRS), measure(2), measure(3), measure(4))
    midi = _midi_from_timeline(xml, tmp_path, expanded=True)
    seen, _ = _run(xml, midi, tmp_path)
    assert ("structure", "pass") in seen

    ev = json.loads((tmp_path / "score_events.json").read_text())
    assert "playback" not in ev
    staff = json.loads((tmp_path / "piece.staff.json").read_text())
    assert staff["schema"] == 1
    assert "playback" not in staff
    assert staff["anchor_rule"] == "musical-coordinate {measure_index, qstamp}; xml:id is a hint only"
    assert "passes" not in staff["identity"]["measures"][0]
