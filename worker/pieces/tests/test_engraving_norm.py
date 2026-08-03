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
  <voice>1</voice>
  <staff>1</staff>
  <notations><technical><fingering default-y="-7">1</fingering></technical></notations>
</note>"""

LH_STACK_NOTE = """<note>
  <pitch><step>G</step><octave>3</octave></pitch><duration>4</duration>
  <voice>5</voice>
  <staff>2</staff>
  <notations><technical>
    <fingering default-y="-21" default-x="-10">5</fingering>
    <fingering default-y="-7" default-x="-10">3</fingering>
    <fingering default-y="7" default-x="-10">1</fingering>
  </technical></notations>
</note>"""

LH_EXPLICIT_NOTE = """<note>
  <pitch><step>C</step><octave>3</octave></pitch><duration>4</duration>
  <voice>5</voice>
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
    # the upper hand now states its side too — that is what keeps a right-hand
    # voice's fingerings above its notes when the voice crosses to the bass staff
    assert _fingerings(out, "1") == [("1", "above")]


CROSS_RH_ON_BASS = """<note>
  <pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
  <voice>1</voice>
  <staff>2</staff>
  <notations><technical><fingering>2</fingering></technical></notations>
</note>"""

CROSS_LH_ON_TREBLE = """<note>
  <pitch><step>E</step><octave>5</octave></pitch><duration>4</duration>
  <voice>5</voice>
  <staff>1</staff>
  <notations><technical><fingering>4</fingering></technical></notations>
</note>"""


def test_hand_follows_the_voice_not_the_printed_staff(tmp_path):
    # Each voice keeps its home staff by majority, then crosses once.
    src = _build(tmp_path,
                 m1_notes=RH_NOTE + LH_STACK_NOTE + CROSS_RH_ON_BASS + CROSS_LH_ON_TREBLE,
                 m2_notes=RH_NOTE + LH_STACK_NOTE)
    root = ET.parse(normalize_engraving(src, tmp_path)).getroot()
    sides = {}
    for note in root.iter("note"):
        for f in note.iter("fingering"):
            sides[(note.findtext("voice"), note.findtext("staff"), f.text)] = f.get("placement")
    # A voice reaching DOWN keeps its digits in the gap between the staves, which
    # from its anchor staff reads as "below" — asking for its hand's side throws
    # them clean outside the system, 16.6 staff spaces from the notehead.
    assert sides[("1", "2", "2")] == "below", "right hand crossing down sits in the gap"
    assert sides[("5", "1", "4")] == "below", "left hand crossing up stays below"
    # Same-staff notes keep the hand rule.
    assert sides[("1", "1", "1")] == "above"
    assert sides[("5", "2", "1")] == "below"


def test_explicit_placement_trusted(tmp_path):
    src = _build(tmp_path, m1_notes=LH_EXPLICIT_NOTE)
    out = normalize_engraving(src, tmp_path)
    # one fingering declares a side -> the whole note's stack is left alone
    assert _fingerings(out, "2") == [("2", "above"), ("4", None)]


def test_single_staff_fingerings_untouched(tmp_path):
    solo = RH_NOTE.replace("<staff>1</staff>", "")
    src = _build(tmp_path, staves=1, m1_notes=solo)
    out = normalize_engraving(src, tmp_path)
    assert 'placement' not in out.read_text().split('<part-list>')[1]


def test_a_score_with_nothing_to_fix_returns_its_input_path(tmp_path):
    solo = RH_NOTE.replace("<staff>1</staff>", "")
    src = _build(tmp_path, staves=1, m1_notes=solo)
    src.write_text(src.read_text().replace("<part-name>Piano</part-name>",
                                           '<part-name print-object="no">Piano</part-name>'))
    assert normalize_engraving(src, tmp_path) == src


def test_a_solo_score_never_labels_its_instrument(tmp_path):
    src = _build(tmp_path, staves=1, m1_notes=RH_NOTE.replace("<staff>1</staff>", ""))
    out = normalize_engraving(src, tmp_path)
    assert 'print-object="no"' in out.read_text()


def test_an_ensemble_keeps_its_instrument_labels(tmp_path):
    src = _build(tmp_path, staves=1, m1_notes=RH_NOTE.replace("<staff>1</staff>", ""))
    src.write_text(src.read_text().replace(
        "</part-list>",
        '<score-part id="P2"><part-name>Violin</part-name></score-part></part-list>'))
    out = normalize_engraving(src, tmp_path)
    assert 'print-object="no"' not in out.read_text()


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
    field = root.find(".//miscellaneous-field[@name='piece-number']")
    assert field is not None and field.text == "3."   # captured for the staff builder


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


PEDAL_TOP_STAFF = """<direction placement="above">
  <direction-type><pedal type="start" line="yes" default-y="-212"/></direction-type>
  <staff>1</staff>
</direction>"""

PEDAL_NO_STAFF = """<direction>
  <direction-type><pedal type="stop" line="yes"/></direction-type>
  <sound/>
</direction>"""


def _pedal_xml(tmp_path, directions, staves=2):
    p = tmp_path / "pedal.musicxml"
    p.write_text(XML_TEMPLATE.format(staves=staves, m1_directions=directions,
                                     m1_notes=RH_NOTE, m2_directions="",
                                     m2_notes=LH_STACK_NOTE))
    return p


def _pedal_dirs(path):
    root = ET.parse(path).getroot()
    return [d for d in root.iter("direction")
            if d.find("direction-type/pedal") is not None]


def test_pedal_moves_to_bottom_staff_and_below(tmp_path):
    out = normalize_engraving(_pedal_xml(tmp_path, PEDAL_TOP_STAFF), tmp_path)
    d = _pedal_dirs(out)[0]
    assert d.get("placement") == "below"
    assert d.findtext("staff") == "2"


def test_pedal_without_staff_gets_one_before_sound(tmp_path):
    out = normalize_engraving(_pedal_xml(tmp_path, PEDAL_NO_STAFF), tmp_path)
    d = _pedal_dirs(out)[0]
    assert d.findtext("staff") == "2"
    tags = [c.tag for c in d]
    assert tags.index("staff") < tags.index("sound")


def test_pedal_untouched_on_single_staff_score(tmp_path):
    out = normalize_engraving(_pedal_xml(tmp_path, PEDAL_NO_STAFF, staves=1), tmp_path)
    d = _pedal_dirs(out)[0]
    assert d.get("placement") == "below"
    assert d.find("staff") is None


DYN_BELOW_S1 = """<direction placement="below">
  <direction-type><dynamics><mf/></dynamics></direction-type>
  <staff>1</staff>
</direction>"""

S2_ONLY_NOTE = """<note>
  <pitch><step>C</step><octave>3</octave></pitch><duration>4</duration>
  <voice>5</voice>
  <staff>2</staff>
</note>"""


def test_dynamic_below_an_empty_staff_moves_above(tmp_path):
    p = tmp_path / "orphan.musicxml"
    p.write_text(XML_TEMPLATE.format(staves=2, m1_directions=DYN_BELOW_S1,
                                     m1_notes=S2_ONLY_NOTE, m2_directions="",
                                     m2_notes=S2_ONLY_NOTE))
    root = ET.parse(normalize_engraving(p, tmp_path)).getroot()
    d = next(d for d in root.iter("direction")
             if d.find("direction-type/dynamics") is not None)
    assert d.get("placement") == "above"


def test_dynamic_stays_below_when_its_staff_sounds(tmp_path):
    p = tmp_path / "sounding.musicxml"
    p.write_text(XML_TEMPLATE.format(staves=2, m1_directions=DYN_BELOW_S1,
                                     m1_notes=RH_NOTE, m2_directions="",
                                     m2_notes=S2_ONLY_NOTE))
    out = normalize_engraving(p, tmp_path)
    root = ET.parse(out).getroot()
    d = next(d for d in root.iter("direction")
             if d.find("direction-type/dynamics") is not None)
    assert d.get("placement") == "below"


def test_bottom_staff_dynamic_never_moves(tmp_path):
    below_s2 = DYN_BELOW_S1.replace("<staff>1</staff>", "<staff>2</staff>")
    p = tmp_path / "bottom.musicxml"
    p.write_text(XML_TEMPLATE.format(staves=2, m1_directions=below_s2,
                                     m1_notes=RH_NOTE, m2_directions="",
                                     m2_notes=RH_NOTE))
    root = ET.parse(normalize_engraving(p, tmp_path)).getroot()
    d = next(d for d in root.iter("direction")
             if d.find("direction-type/dynamics") is not None)
    assert d.get("placement") == "below"
