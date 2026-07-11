import sys, tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.tempo_norm import _metronome_qpm, normalize_tempo


def met(unit: str, per_minute: str, dots: int = 0) -> ET.Element:
    m = ET.Element("metronome")
    ET.SubElement(m, "beat-unit").text = unit
    for _ in range(dots):
        ET.SubElement(m, "beat-unit-dot")
    ET.SubElement(m, "per-minute").text = per_minute
    return m


def test_plain_units():
    assert _metronome_qpm(met("quarter", "120")) == 120
    assert _metronome_qpm(met("half", "60")) == 120
    assert _metronome_qpm(met("eighth", "120")) == 60


def test_dotted_units():
    # The verovio 6.2.1 bug case: dotted quarter = 1.5 quarters, NOT 4/3.
    assert _metronome_qpm(met("quarter", "60", dots=1)) == 90
    assert _metronome_qpm(met("eighth", "120", dots=1)) == 90
    assert _metronome_qpm(met("quarter", "40", dots=2)) == 70  # double dot = x1.75


def test_tolerant_per_minute():
    assert _metronome_qpm(met("quarter", "c. 120")) == 120
    assert _metronome_qpm(met("quarter", "120-132")) == 120
    assert _metronome_qpm(met("quarter", "fast")) is None
    assert _metronome_qpm(met("breve", "")) is None
    assert _metronome_qpm(met("weird-unit", "120")) is None


SCORE = """<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>X</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>1</divisions></attributes>
    {direction}
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
  </measure></part></score-partwise>"""


def _write(tmp: Path, direction: str) -> Path:
    p = tmp / "s.musicxml"
    p.write_text(SCORE.format(direction=direction))
    return p


def test_injects_sound_for_dotted_metronome():
    tmp = Path(tempfile.mkdtemp())
    src = _write(tmp, "<direction><direction-type><metronome><beat-unit>quarter</beat-unit>"
                      "<beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>")
    out = normalize_tempo(src, tmp)
    assert out != src
    snd = ET.parse(out).getroot().find(".//direction/sound")
    assert snd is not None and float(snd.get("tempo")) == 90


def test_trusts_exporter_sound_tempo():
    tmp = Path(tempfile.mkdtemp())
    src = _write(tmp, "<direction><direction-type><metronome><beat-unit>quarter</beat-unit>"
                      "<beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type>"
                      "<sound tempo=\"88\"/></direction>")
    assert normalize_tempo(src, tmp) == src  # exporter's machine tempo wins, untouched


def test_no_metronome_returns_input():
    tmp = Path(tempfile.mkdtemp())
    src = _write(tmp, "<direction><direction-type><words>Allegro</words></direction-type></direction>")
    assert normalize_tempo(src, tmp) == src
