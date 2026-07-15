import xml.etree.ElementTree as ET
from pathlib import Path

from pipeline.engraving_norm import normalize_engraving

XML_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><staves>{staves}</staves></attributes>
      {m1_directions}
      {m1_notes}
    </measure>
    <measure number="2">
      {m2_directions}
      {m2_notes}
    </measure>
  </part>
</score-partwise>
"""

RH_NOTE = """<note>
  <pitch><step>G</step><octave>4</octave></pitch><duration>4</duration>
  <staff>1</staff>
  <notations><technical><fingering default-y="-7">1</fingering></technical></notations>
</note>"""

LH_STACK_NOTE = """<note>
  <pitch><step>G</step><octave>3</octave></pitch><duration>4</duration>
  <staff>2</staff>
  <notations><technical>
    <fingering default-y="-21" default-x="-10">5</fingering>
    <fingering default-y="-7" default-x="-10">3</fingering>
    <fingering default-y="7" default-x="-10">1</fingering>
  </technical></notations>
</note>"""

LH_EXPLICIT_NOTE = """<note>
  <pitch><step>C</step><octave>3</octave></pitch><duration>4</duration>
  <staff>2</staff>
  <notations><technical>
    <fingering placement="above" default-y="7">2</fingering>
    <fingering default-y="-7">4</fingering>
  </technical></notations>
</note>"""

NUMBER_WORDS = '<direction><direction-type><words default-y="-15">3.</words></direction-type></direction>'
CRESC_WORDS = '<direction><direction-type><words>cresc:</words></direction-type></direction>'


def _build(tmp_path: Path, staves=2, m1_directions="", m1_notes="", m2_directions="", m2_notes="") -> Path:
    p = tmp_path / "in.musicxml"
    p.write_text(XML_TEMPLATE.format(staves=staves, m1_directions=m1_directions,
                                     m1_notes=m1_notes, m2_directions=m2_directions,
                                     m2_notes=m2_notes))
    return p


def _fingerings(path: Path, staff: str):
    root = ET.parse(path).getroot()
    out = []
    for note in root.iter("note"):
        st = note.find("staff")
        if st is not None and st.text == staff:
            out += [(f.text, f.get("placement")) for f in note.iter("fingering")]
    return out


def test_bottom_staff_stack_placed_below_and_reordered(tmp_path):
    src = _build(tmp_path, m1_notes=RH_NOTE + LH_STACK_NOTE)
    out = normalize_engraving(src, tmp_path)
    assert out != src
    # document order becomes top-to-bottom visual order: 1, 3, 5
    assert _fingerings(out, "2") == [("1", "below"), ("3", "below"), ("5", "below")]
    # right hand untouched
    assert _fingerings(out, "1") == [("1", None)]


def test_explicit_placement_trusted(tmp_path):
    src = _build(tmp_path, m1_notes=LH_EXPLICIT_NOTE)
    out = normalize_engraving(src, tmp_path)
    # one fingering declares a side -> the whole note's stack is left alone
    assert _fingerings(out, "2") == [("2", "above"), ("4", None)]


def test_single_staff_untouched(tmp_path):
    solo = RH_NOTE.replace("<staff>1</staff>", "")
    src = _build(tmp_path, staves=1, m1_notes=solo)
    out = normalize_engraving(src, tmp_path)
    assert out == src  # nothing to fix -> input path returned


def test_piece_number_dropped_only_in_measure_one(tmp_path):
    src = _build(tmp_path, m1_directions=NUMBER_WORDS + CRESC_WORDS,
                 m1_notes=LH_STACK_NOTE, m2_directions=NUMBER_WORDS)
    out = normalize_engraving(src, tmp_path)
    root = ET.parse(out).getroot()
    measures = root.find("part").findall("measure")
    m1_words = [w.text for w in measures[0].iter("words")]
    m2_words = [w.text for w in measures[1].iter("words")]
    assert m1_words == ["cresc:"]   # "3." gone, real text kept
    assert m2_words == ["3."]       # later measures never touched


def test_idempotent(tmp_path):
    src = _build(tmp_path, m1_notes=LH_STACK_NOTE)
    once = normalize_engraving(src, tmp_path)
    twice = normalize_engraving(once, tmp_path)
    assert twice == once  # second pass finds nothing to fix


# --- mis-anchored chord fingerings (Dolet x-proximity picks the wrong voice) ---

def _two_voice_measure(fing_a='<fingering default-y="6">2</fingering>',
                       fing_b='<fingering default-y="-22">5</fingering>',
                       chord_extra="", chord_fing=""):
    """Held LH double-stop (voice 1, div=2: dotted half=6) against an off-beat
    single-note line (voice 2) whose first note carries the fingering stack."""
    return f"""
<note><pitch><step>F</step><octave>3</octave></pitch><duration>6</duration>
  <voice>1</voice><staff>2</staff>{chord_fing}</note>
<note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration>
  <voice>1</voice><staff>2</staff></note>
{chord_extra}
<backup><duration>6</duration></backup>
<note><rest/><duration>1</duration><voice>2</voice><staff>2</staff></note>
<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration>
  <voice>2</voice><staff>2</staff>
  <notations><technical>{fing_b}{fing_a}</technical></notations></note>
"""


def test_misanchored_stack_moves_to_sounding_chord(tmp_path):
    src = _build(tmp_path, m1_notes=_two_voice_measure())
    out = normalize_engraving(src, tmp_path)
    root = ET.parse(out).getroot()
    by_pitch = {}
    for note in root.iter("note"):
        step = note.findtext("pitch/step")
        if step:
            by_pitch.setdefault(step, []).extend(
                (f.text, f.get("placement")) for f in note.iter("fingering"))
    # stack re-anchored to the chord principal, placed below, editor order (2 above 5)
    assert by_pitch["F"] == [("2", "below"), ("5", "below")]
    assert by_pitch["D"] == []


def test_count_mismatch_stays_put(tmp_path):
    third = ('<note><chord/><pitch><step>A</step><octave>3</octave></pitch>'
             '<duration>6</duration><voice>1</voice><staff>2</staff></note>')
    src = _build(tmp_path, m1_notes=_two_voice_measure(chord_extra=third))
    out = normalize_engraving(src, tmp_path)
    root = ET.parse(out).getroot()
    d_note = [n for n in root.iter("note") if n.findtext("pitch/step") == "D"][0]
    # 3-note chord vs 2 fingerings -> no move; placement still applied on the D
    assert [(f.text, f.get("placement")) for f in d_note.iter("fingering")] == \
        [("2", "below"), ("5", "below")]


def test_horizontal_pair_not_treated_as_stack(tmp_path):
    src = _build(tmp_path, m1_notes=_two_voice_measure(
        fing_a='<fingering default-y="6">1</fingering>',
        fing_b='<fingering default-y="6">2</fingering>'))
    out = normalize_engraving(src, tmp_path)
    root = ET.parse(out).getroot()
    d_note = [n for n in root.iter("note") if n.findtext("pitch/step") == "D"][0]
    assert len(list(d_note.iter("fingering"))) == 2  # substitution pair stays put


def test_tempo_metronome_gap_padded(tmp_path):
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
    <direction placement="above" directive="yes">
      <direction-type><words font-weight="bold">ADANTINO. </words></direction-type>
      <direction-type><metronome parentheses="yes"><beat-unit>quarter</beat-unit>
        <beat-unit-dot/><per-minute>66</per-minute></metronome></direction-type>
      <sound tempo="99"/>
    </direction>
    <direction placement="below">
      <direction-type><words font-style="italic">dolce cantabile.</words></direction-type>
    </direction>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
  </measure></part>
</score-partwise>"""
    src = tmp_path / "t.musicxml"
    src.write_text(xml)
    out = normalize_engraving(src, tmp_path)
    text = out.read_text()
    assert "ADANTINO.\u00a0\u00a0\u200d<" in text   # two nbsp + zwj terminator
    assert "dolce cantabile.<" in text               # words without metronome untouched
    out2 = normalize_engraving(out, tmp_path)        # idempotent
    assert out2.read_text().count("ADANTINO.\u00a0\u00a0\u200d") == 1
