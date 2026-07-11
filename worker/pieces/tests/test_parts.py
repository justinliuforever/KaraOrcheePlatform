import sys, tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline.parts import reduce_xml_to_part

TWO_PART = """<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list>
    <part-group type="start"/>
    <score-part id="P1"><part-name>Violin</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
    <part-group type="stop"/>
  </part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>1</divisions></attributes>{p1m1}
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure>
    <measure number="2"><note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note></measure>
  </part>
  <part id="P2">
    <measure number="1">{p2m1}
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure>
    <measure number="2">{p2m2}
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>4</duration></note></measure>
  </part>
</score-partwise>"""

TEMPO_148 = ('<direction><direction-type><metronome><beat-unit>quarter</beat-unit>'
             '<per-minute>148</per-minute></metronome></direction-type><staff>1</staff>'
             '<sound tempo="148"/></direction>')


def reduce(p1m1="", p2m1="", p2m2=""):
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "s.musicxml"
    src.write_text(TWO_PART.format(p1m1=p1m1, p2m1=p2m1, p2m2=p2m2))
    out = tmp / "r.musicxml"
    reduce_xml_to_part(src, out, "P1")
    return ET.parse(out).getroot()


def test_removes_other_parts_and_groups():
    root = reduce()
    assert [p.get("id") for p in root.findall("part")] == ["P1"]
    assert root.find("part-list").find("part-group") is None
    assert [sp.get("id") for sp in root.findall("part-list/score-part")] == ["P1"]


def test_hoists_tempo_from_removed_part():
    root = reduce(p2m1=TEMPO_148)
    d = root.find("part/measure/direction")
    assert d is not None
    assert d.find("sound").get("tempo") == "148"
    assert d.find("staff") is None  # stale staff refs stripped


def test_kept_parts_own_mark_wins():
    own = '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type></direction>'
    root = reduce(p1m1=own, p2m1=TEMPO_148)
    dirs = root.findall("part/measure[1]/direction")
    assert len(dirs) == 1
    assert dirs[0].find(".//per-minute").text == "100"


def test_mid_piece_tempo_hoists_to_matching_measure():
    root = reduce(p2m2=TEMPO_148)
    measures = root.findall("part/measure")
    assert measures[0].find("direction") is None
    assert measures[1].find("direction/sound").get("tempo") == "148"
