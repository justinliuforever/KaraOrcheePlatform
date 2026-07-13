import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.structure import (
    Structure, StructureError, build_playback_map, classify_structure,
    expected_playback_sequence, verify_expansion,
)

ATTRS = ('<attributes><divisions>1</divisions><key><fifths>0</fifths></key>'
         '<time><beats>4</beats><beat-type>4</beat-type></time>'
         '<clef><sign>G</sign><line>2</line></clef></attributes>')
FWD = '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>'


def bwd(times=None):
    t = f' times="{times}"' if times else ""
    return f'<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"{t}/></barline>'


def estart(num):
    return f'<barline location="left"><ending number="{num}" type="start"/></barline>'


def estop(num, repeat=True):
    rep = '<repeat direction="backward"/>' if repeat else ""
    return f'<barline location="right"><ending number="{num}" type="stop"/>{rep}</barline>'


def measure(n, *inner):
    note = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>'
    return f'<measure number="{n}">{"".join(inner)}{note}</measure>'


def score(*measures) -> Path:
    xml = ('<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">'
           '<part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>'
           f'<part id="P1">{"".join(measures)}</part></score-partwise>')
    p = Path(tempfile.mkdtemp()) / "s.musicxml"
    p.write_text(xml)
    return p


def seq_of(path):
    return expected_playback_sequence(classify_structure(path))


def test_linear_score_is_identity():
    p = score(measure(1, ATTRS), measure(2), measure(3))
    st = classify_structure(p)
    assert st.kind == "linear" and not st.has_repeats
    assert seq_of(p) == [1, 2, 3]


def test_implicit_start_repeat():
    p = score(measure(1, ATTRS), measure(2, bwd()), measure(3))
    assert seq_of(p) == [1, 2, 1, 2, 3]


def test_times_three():
    p = score(measure(1, ATTRS, FWD), measure(2, bwd(3)), measure(3))
    assert seq_of(p) == [1, 2, 1, 2, 1, 2, 3]


def test_volta_first_second_ending():
    p = score(measure(1, ATTRS), measure(2, FWD),
              measure(3, estart("1"), estop("1")),
              measure(4, estart("2"), estop("2", repeat=False)),
              measure(5))
    assert seq_of(p) == [1, 2, 3, 2, 4, 5]


def test_arabesque_shape_33_to_55():
    # m3-10 with volta1=m10/volta2=m11; m12-27 with volta1=m27/volta2=m28; coda m29-33
    ms = [measure(1, ATTRS), measure(2), measure(3, FWD)]
    ms += [measure(i) for i in range(4, 10)]
    ms += [measure(10, estart("1"), estop("1")), measure(11, estart("2"), estop("2", repeat=False))]
    ms += [measure(12, FWD)]
    ms += [measure(i) for i in range(13, 27)]
    ms += [measure(27, estart("1"), estop("1")), measure(28, estart("2"), estop("2", repeat=False))]
    ms += [measure(i) for i in range(29, 34)]
    seq = seq_of(score(*ms))
    assert len(seq) == 55
    assert seq[:12] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 3, 4]
    assert seq[17] == 11 and seq[18] == 12


def test_rejects_dc_al_fine_words():
    dc = ('<direction><direction-type><words>D.C. al Fine</words></direction-type>'
          '<sound dacapo="yes"/></direction>')
    p = score(measure(1, ATTRS), measure(2), measure(3, dc))
    with pytest.raises(StructureError, match="not supported yet"):
        classify_structure(p)


def test_rejects_sound_jump_attr_without_words():
    p = score(measure(1, ATTRS), measure(2, '<direction><sound tocoda="yes"/></direction>'), measure(3))
    with pytest.raises(StructureError, match="not supported yet"):
        classify_structure(p)


def test_bare_fine_word_alone_is_allowed():
    p = score(measure(1, ATTRS), measure(2, '<direction><direction-type><words>Fine</words></direction-type></direction>'), measure(3))
    assert classify_structure(p).kind == "linear"


def test_rejects_nested_repeats():
    p = score(measure(1, ATTRS, FWD), measure(2, FWD), measure(3, bwd()), measure(4, bwd()))
    with pytest.raises(StructureError):
        classify_structure(p)


def test_rejects_noncontiguous_volta_numbers():
    p = score(measure(1, ATTRS, FWD),
              measure(2, estart("1,3"), estop("1,3")),
              measure(3, estart("2"), estop("2", repeat=False)),
              measure(4))
    with pytest.raises(StructureError, match="non-contiguous|cover passes"):
        classify_structure(p)


def test_rejects_times_out_of_range():
    p = score(measure(1, ATTRS, FWD), measure(2, bwd(5)), measure(3))
    with pytest.raises(StructureError, match="2..4"):
        classify_structure(p)


def test_rejects_volta_undercoverage():
    # times=3 but endings only cover passes 1 and 2
    p = score(measure(1, ATTRS, FWD),
              measure(2, estart("1"), estop("1")),
              measure(3, estart("2"), estop("2", repeat=False)),
              measure(4))
    st_p = score(measure(1, ATTRS, FWD),
                 measure(2, estart("1"), '<barline location="right"><ending number="1" type="stop"/>'
                                          '<repeat direction="backward" times="3"/></barline>'),
                 measure(3, estart("2"), estop("2", repeat=False)),
                 measure(4))
    with pytest.raises(StructureError, match="cover passes"):
        classify_structure(st_p)
    assert seq_of(p) == [1, 2, 1, 3, 4]


def test_verify_expansion_match_and_mismatch():
    written = ["m1", "m2", "m3"]
    verify_expansion(["m1", "m2", "m1", "m2", "m3"], written, [1, 2, 1, 2, 3])
    with pytest.raises(StructureError, match="playback step 3"):
        verify_expansion(["m1", "m2", "m3"], written, [1, 2, 1, 2, 3])


def test_playback_map_spans_and_passes():
    p = score(measure(1, ATTRS), measure(2, FWD),
              measure(3, estart("1"), estop("1")),
              measure(4, estart("2"), estop("2", repeat=False)),
              measure(5))
    st = classify_structure(p)
    exp = expected_playback_sequence(st)          # [1,2,3,2,4,5]
    secs = [(float(k), float(k + 1)) for k in range(len(exp))]
    pm = build_playback_map(st, exp, secs, secs)
    assert pm["counts"] == {"written_measures": 5, "played_measures": 6,
                            "max_passes": 2, "expanded_duration_sec": 6.0}
    # spans: [1-3 p1] [2-2 p2 backward] [4-5 p?]... pass semantics: m4 pass1, m5 pass1
    spans = pm["spans"]
    assert spans[0]["written_start"] == 1 and spans[0]["written_end"] == 3 and spans[0]["pass"] == 1
    assert spans[1]["written_start"] == 2 and spans[1]["pass"] == 2 and spans[1]["jump_in"] == "backward"
    occ2 = [o for o in pm["occurrences"] if o["measure_index"] == 2]
    assert [o["pass"] for o in occ2] == [1, 2]
    assert pm["endings"] == [{"numbers": [1], "written_start": 3, "written_end": 3},
                             {"numbers": [2], "written_start": 4, "written_end": 4}]
