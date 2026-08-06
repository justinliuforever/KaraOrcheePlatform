"""What the registry says a piece's tempo is, and where it got it."""
from pipeline.xml_meta import extract

HEAD = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
 <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
 <part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><staves>1</staves></attributes>
  {directions}
  <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
    <voice>1</voice><type>quarter</type></note>
 </measure></part></score-partwise>"""

RIT = '<direction placement="above"><direction-type><words>Rit.</words></direction-type></direction>'


def _tempo(tmp_path, directions):
    p = tmp_path / "t.musicxml"
    p.write_text(HEAD.format(directions=directions))
    m = extract(p)
    return m["tempo_bpm"], m["tempo_source"], m["tempo_text"]


def _mark(text, per_minute, unit="quarter", directive=True):
    d = ' directive="yes"' if directive else ""
    return (f'<direction{d} placement="above"><direction-type><words>{text}</words></direction-type>'
            f'<direction-type><metronome><beat-unit>{unit}</beat-unit>'
            f'<per-minute>{per_minute}</per-minute></metronome></direction-type></direction>')


def test_a_metronome_mark_is_a_marked_tempo(tmp_path):
    assert _tempo(tmp_path, _mark("Allegro", "102")) == (102, "xml", "Allegro")


def test_a_range_takes_its_first_number(tmp_path):
    assert _tempo(tmp_path, _mark("Allegro", "102-120"))[0] == 102


def test_a_dotted_beat_unit_is_converted(tmp_path):
    d = _mark("Andante", "60", unit="half")
    assert _tempo(tmp_path, d)[0] == 120


def test_a_sound_tempo_still_wins(tmp_path):
    d = _mark("Allegro", "102").replace("<direction-type><metronome>",
                                        "<sound tempo='144'/><direction-type><metronome>")
    assert _tempo(tmp_path, d)[0] == 144


def test_the_marking_is_the_directive_not_whatever_comes_first(tmp_path):
    assert _tempo(tmp_path, RIT + _mark("Allegro (mm=102-120)", "102"))[2] == "Allegro (mm=102-120)"


def test_without_a_directive_the_first_words_still_answer(tmp_path):
    assert _tempo(tmp_path, RIT)[2] == "Rit."


def test_a_score_with_no_tempo_at_all_says_so(tmp_path):
    assert _tempo(tmp_path, "") == (None, "default", None)
