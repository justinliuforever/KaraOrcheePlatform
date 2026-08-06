"""A digit typed without selecting its notehead never becomes a fingering."""
from pipeline.xml_meta import extract

HEAD = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
 <identification><encoding><software>Dolet 8.3 for Sibelius</software></encoding></identification>
 <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
 <part id="P1"><measure number="7">
  <attributes><divisions>4</divisions><staves>2</staves></attributes>
  {body}
 </measure></part></score-partwise>"""


def _note(step, octave, voice, staff):
    return (f"<note><pitch><step>{step}</step><octave>{octave}</octave></pitch>"
            f"<duration>4</duration><voice>{voice}</voice><staff>{staff}</staff></note>")


def _digit(text, voice, staff):
    return (f'<direction placement="below"><direction-type><words>{text}</words>'
            f"</direction-type><voice>{voice}</voice><staff>{staff}</staff></direction>")


def _warn(tmp_path, body):
    p = tmp_path / "w.musicxml"
    p.write_text(HEAD.format(body=body))
    codes = [w["code"] for w in extract(p)["export_warnings"]]
    return [w for w in extract(p)["export_warnings"] if w["code"] == "fingering_wrong_voice"], codes


def test_a_digit_stranded_in_a_voice_with_no_notes_is_reported(tmp_path):
    body = _note("C", 4, 1, 1) + _note("E", 2, 7, 2) + _digit("5", 1, 2)
    hits, _ = _warn(tmp_path, body)
    assert hits and hits[0]["measures"] == ["7"]


def test_a_digit_in_the_same_voice_as_its_notes_is_not_reported(tmp_path):
    body = _note("C", 4, 1, 1) + _note("E", 2, 7, 2) + _digit("5", 7, 2)
    hits, _ = _warn(tmp_path, body)
    assert not hits


def test_ordinary_text_is_not_mistaken_for_a_fingering(tmp_path):
    body = _note("C", 4, 1, 1) + _note("E", 2, 7, 2) + _digit("dolce", 1, 2) + _digit("12", 1, 2)
    hits, _ = _warn(tmp_path, body)
    assert not hits


def test_a_staff_with_no_notes_at_all_is_not_reported(tmp_path):
    body = _note("C", 4, 1, 1) + _digit("5", 1, 2)
    hits, _ = _warn(tmp_path, body)
    assert not hits
