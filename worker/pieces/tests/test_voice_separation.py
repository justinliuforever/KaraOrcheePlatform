"""Interleaved voices must become legible without anything moving in time."""
import xml.etree.ElementTree as ET

import pytest

from pipeline.engraving_norm import (
    _measure_note_onsets,
    _separate_interleaved_voices,
)

HEAD = """<score-partwise version="4.0">
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><staves>2</staves></attributes>
    {body}
  </measure></part></score-partwise>"""


def _n(step, octave, voice, staff, dur=4, chord=False):
    return ("<note>" + ("<chord/>" if chord else "")
            + f"<pitch><step>{step}</step><octave>{octave}</octave></pitch>"
            f"<duration>{dur}</duration><voice>{voice}</voice><staff>{staff}</staff></note>")


def _back(d):
    return f"<backup><duration>{d}</duration></backup>"


def _part(body):
    return ET.fromstring(HEAD.format(body=body)).find("part")


def _onsets(part):
    return [(v, o, m.findtext("pitch/step"))
            for m, v, o in _measure_note_onsets(part.find("measure"))]


# Dolet's shape: voice 1 note, back up, voice 2 note, back up, voice 1 note...
INTERLEAVED = (_n("C", 4, 1, 1) + _back(4) + _n("E", 3, 2, 1)
               + _n("D", 4, 1, 1) + _back(4) + _n("F", 3, 2, 1))


def test_a_voice_switch_becomes_visible_to_the_importer():
    part = _part(INTERLEAVED)
    assert _separate_interleaved_voices(part) is True
    body = list(part.find("measure"))
    assert sum(1 for el in body if el.tag in ("backup", "forward")) > 2


def test_nothing_moves_in_time():
    part = _part(INTERLEAVED)
    before = _onsets(_part(INTERLEAVED))
    _separate_interleaved_voices(part)
    assert _onsets(part) == before


def test_no_note_is_added_or_lost():
    part = _part(INTERLEAVED)
    _separate_interleaved_voices(part)
    assert len(part.findall(".//note")) == 4


CONTIGUOUS = _n("C", 4, 1, 1) + _n("D", 4, 1, 1) + _back(8) + _n("E", 3, 2, 2) + _n("F", 3, 2, 2)


def test_an_already_contiguous_measure_is_left_alone():
    part = _part(CONTIGUOUS)
    assert _separate_interleaved_voices(part) is False


# K.331 m115: one voice, written across both staves. Splitting it by (staff,
# voice) would tear a hand in half — the grouping must key on voice alone.
CROSS_STAFF_ONE_VOICE = (_n("C", 5, 1, 1) + _n("A", 3, 1, 2)
                         + _n("D", 5, 1, 1) + _n("B", 3, 1, 2))


def test_one_voice_crossing_staves_is_never_split():
    part = _part(CROSS_STAFF_ONE_VOICE)
    assert _separate_interleaved_voices(part) is False


@pytest.mark.parametrize("bad", [
    _n("C", 4, 1, 1) + "<backup><duration>x</duration></backup>" + _n("E", 3, 2, 1)
    + _n("D", 4, 1, 1) + _back(4) + _n("F", 3, 2, 1),
    _n("C", 4, 1, 1) + _back(400) + _n("E", 3, 2, 1)
    + _n("D", 4, 1, 1) + _back(4) + _n("F", 3, 2, 1),
])
def test_an_unreadable_measure_is_refused_not_guessed(bad):
    part = _part(bad)
    before = ET.tostring(part)
    assert _separate_interleaved_voices(part) is False
    assert ET.tostring(part) == before


GRACE_INTERLEAVE = ('<note><grace/><pitch><step>G</step><octave>4</octave></pitch>'
                    "<voice>1</voice><staff>1</staff></note>" + INTERLEAVED)


def test_a_grace_note_is_zero_time_not_an_unreadable_measure():
    part = _part(GRACE_INTERLEAVE)
    assert _separate_interleaved_voices(part) is True


CHORD_INTERLEAVE = (_n("C", 4, 1, 1) + _n("E", 4, 1, 1, chord=True)
                    + _back(4) + _n("E", 3, 2, 1)
                    + _n("D", 4, 1, 1) + _back(4) + _n("F", 3, 2, 1))


def test_a_chord_is_not_broken_off_from_its_principal():
    part = _part(CHORD_INTERLEAVE)
    _separate_interleaved_voices(part)
    body = list(part.find("measure"))
    for i, el in enumerate(body):
        if el.tag == "note" and el.find("chord") is not None:
            assert body[i - 1].tag == "note", "a chord follower lost its principal"


# Fugue BWV 846 m16: voice 1 fills the bar, then returns to qstamp 16. The importer
# fills a layer forward and never seeks back into it, so giving voice 1 a layer puts
# those two notes after the barline and the bar gains a beat.
REWINDING_VOICE = (_n("C", 4, 1, 1) + _n("D", 4, 1, 1)
                   + _back(8) + _n("E", 3, 2, 1) + _n("F", 3, 2, 1)
                   + _back(8) + _n("G", 4, 1, 1))


def test_a_voice_that_re_enters_behind_itself_is_left_alone():
    part = _part(REWINDING_VOICE)
    before = ET.tostring(part)
    assert _separate_interleaved_voices(part) is False
    assert ET.tostring(part) == before
