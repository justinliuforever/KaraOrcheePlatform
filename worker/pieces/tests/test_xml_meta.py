from pathlib import Path

from pipeline.xml_meta import extract

XML_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <identification>
    <creator type="composer">Test</creator>
    <encoding>{software}</encoding>
  </identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      {m1_notes}
    </measure>
    <measure number="2">{m2_notes}</measure>
  </part>
</score-partwise>
"""

DOLET = "<software>Sibelius 2026.6</software><software>Dolet 8.3 for Sibelius</software>"
DIRECT = "<software>Sibelius 26.6.0</software><software>Direct export, not from Dolet</software>"
MUSESCORE = "<software>MuseScore 2.3.2</software>"

PLAIN_NOTE = "<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>"

POSITIONED_STACK = """<note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration>
  <notations><technical>
    <fingering default-x="-10" default-y="7">1</fingering>
    <fingering default-x="-10" default-y="-7">3</fingering>
  </technical></notations></note>"""

UNPOSITIONED_STACK = """<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration>
  <notations><technical>
    <fingering default-y="7">2</fingering>
    <fingering default-y="-7">5</fingering>
  </technical></notations></note>"""

SINGLE_UNPOSITIONED = """<note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration>
  <notations><technical><fingering>3</fingering></technical></notations></note>"""


def _extract(tmp_path: Path, software: str, m1_notes: str, m2_notes: str = PLAIN_NOTE) -> dict:
    p = tmp_path / "t.musicxml"
    p.write_text(XML_TEMPLATE.format(software=software, m1_notes=m1_notes, m2_notes=m2_notes))
    return extract(p)


def test_direct_export_flagged(tmp_path):
    meta = _extract(tmp_path, DIRECT, PLAIN_NOTE)
    assert {"code": "sibelius_direct_export"} in meta["export_warnings"]
    assert "Direct export, not from Dolet" in meta["software"]


def test_dolet_export_clean(tmp_path):
    meta = _extract(tmp_path, DOLET, POSITIONED_STACK)
    assert meta["export_warnings"] == []
    assert "Dolet 8.3 for Sibelius" in meta["software"]


def test_musescore_never_warns(tmp_path):
    # The stack check is a Dolet-artifact fingerprint — other engravers omit
    # default-x legitimately and must not trip it.
    meta = _extract(tmp_path, MUSESCORE, UNPOSITIONED_STACK)
    assert meta["export_warnings"] == []


def test_dolet_unpositioned_stack_flagged_with_measure(tmp_path):
    meta = _extract(tmp_path, DOLET, PLAIN_NOTE, m2_notes=UNPOSITIONED_STACK)
    assert meta["export_warnings"] == [
        {"code": "fingering_stack_no_position", "measures": ["2"]}]


def test_dolet_single_fingering_without_position_ok(tmp_path):
    meta = _extract(tmp_path, DOLET, SINGLE_UNPOSITIONED)
    assert meta["export_warnings"] == []


def test_no_identification_block(tmp_path):
    meta = _extract(tmp_path, "", PLAIN_NOTE)
    assert meta["software"] == []
    assert meta["export_warnings"] == []


def test_direct_export_never_runs_stack_check(tmp_path):
    # The direct-export marker CONTAINS the word "Dolet" — a substring match must
    # not route direct exports into the Dolet-artifact stack check.
    meta = _extract(tmp_path, DIRECT, UNPOSITIONED_STACK)
    assert meta["export_warnings"] == [{"code": "sibelius_direct_export"}]
