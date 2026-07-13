import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from gates import GateError, gate_structure, gate_alignment
from tests.test_structure import ATTRS, FWD, bwd, estart, estop, measure, score


def _meta(n_parts=1):
    return {"n_parts": n_parts, "parts": [{"id": "P1"}]}


def _run_structure(xml: Path, tmp: Path):
    state: dict = {}
    m = gate_structure(xml, tmp, _meta(), None, state)
    return m, state


def test_linear_piece_passes_with_no_playback(tmp_path):
    p = score(measure(1, ATTRS), measure(2), measure(3))
    m, state = _run_structure(p, tmp_path)
    assert m == {"kind": "linear", "written_measures": 3}
    assert state["playback"] is None
    assert state["structure"].kind == "linear"


def test_repeat_piece_builds_verified_playback_map(tmp_path):
    p = score(measure(1, ATTRS), measure(2, FWD),
              measure(3, estart("1"), estop("1")),
              measure(4, estart("2"), estop("2", repeat=False)),
              measure(5))
    m, state = _run_structure(p, tmp_path)
    assert m["kind"] == "repeats"
    assert m["written_measures"] == 5 and m["played_measures"] == 6
    assert m["expansion_verified"] is True and m["expansion_source"] == "verovio-inferred"
    pb = state["playback"]
    assert pb["counts"]["played_measures"] == 6
    # expanded seconds must tile monotonically
    occ = pb["occurrences"]
    assert all(occ[k]["expanded_sec_start"] < occ[k]["expanded_sec_end"] for k in range(len(occ)))
    assert all(occ[k]["expanded_sec_end"] <= occ[k + 1]["expanded_sec_start"] + 1e-6
               for k in range(len(occ) - 1))


def test_dc_al_fine_rejects_at_structure_gate(tmp_path):
    dc = ('<direction><direction-type><words>D.C. al Fine</words></direction-type>'
          '<sound dacapo="yes"/></direction>')
    p = score(measure(1, ATTRS), measure(2), measure(3, dc))
    with pytest.raises(GateError, match="not supported yet"):
        _run_structure(p, tmp_path)


def _midi_from_timeline(xml: Path, tmp: Path, expanded: bool) -> Path:
    import pretty_midi
    from gates import _timeline_events
    events = _timeline_events(xml, expanded=expanded)
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0)
    for e in events:
        t = e["q"] * 0.5
        for p in e["pitches"]:
            inst.notes.append(pretty_midi.Note(velocity=80, pitch=p, start=t, end=t + 0.2))
    pm.instruments.append(inst)
    out = tmp / f"{'exp' if expanded else 'lin'}.mid"
    pm.write(str(out))
    return out


def _repeat_score():
    # long enough for a meaningful pitch alignment: 12 written measures, m3-8 repeated
    ms = [measure(1, ATTRS), measure(2), measure(3, FWD)]
    ms += [measure(i) for i in range(4, 8)]
    ms += [measure(8, bwd())]
    ms += [measure(i) for i in range(9, 13)]
    return score(*ms)


def test_alignment_accepts_expanded_midi_and_rejects_linear(tmp_path):
    p = _repeat_score()
    state: dict = {}
    gate_structure(p, tmp_path, _meta(), None, state)

    good = _midi_from_timeline(p, tmp_path, expanded=True)
    m = gate_alignment(p, good, tmp_path, _meta(), None, state)
    assert m["structure_match"] == "expanded"
    assert m["structure_match_expanded"] >= 0.8

    bad = _midi_from_timeline(p, tmp_path, expanded=False)
    with pytest.raises(GateError, match="repeats taken|straight through"):
        gate_alignment(p, bad, tmp_path, _meta(), None, state)


def test_alignment_without_structure_state_keeps_old_behavior(tmp_path):
    p = score(measure(1, ATTRS), measure(2), measure(3))
    mid = _midi_from_timeline(p, tmp_path, expanded=True)
    m = gate_alignment(p, mid, tmp_path, _meta(), None, None)
    assert m["route"] == "midi"
    assert "structure_match" not in m
