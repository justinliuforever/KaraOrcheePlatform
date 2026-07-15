"""fingering_layout: chord stacks move beside their noteheads; everything else is untouched."""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from pipeline.fingering_layout import adjust_mei, _geometry, W_DIGIT
from pipeline.staff import freeze_mei, COMMON, VARIANTS
from pipeline.vrv import make_toolkit

_M = '{http://www.music-encoding.org/ns/mei}'
_XID = '{http://www.w3.org/XML/1998/namespace}id'

OPTS = {**COMMON, **VARIANTS["phone"]}


def _note(step, octave, fingerings=(), chord=False):
    fings = ""
    if fingerings:
        inner = "".join(f'<fingering default-y="{10 - 14 * i}" default-x="-10">{f}</fingering>'
                        for i, f in enumerate(fingerings))
        fings = f"<notations><technical>{inner}</technical></notations>"
    return (f'<note>{"<chord/>" if chord else ""}<pitch><step>{step}</step>'
            f"<octave>{octave}</octave></pitch><duration>4</duration>"
            f"<voice>1</voice><type>half</type>{fings}</note>")


def _score(m1_notes, m2_notes):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef></attributes>
      {m1_notes}
    </measure>
    <measure number="2">{m2_notes}<barline location="right"><bar-style>light-heavy</bar-style></barline></measure>
  </part>
</score-partwise>"""


@pytest.fixture(scope="module")
def frozen(tmp_path_factory):
    """MEI for: m1 = G3+B3+D4 chord with a 5/3/1 stack (+ a plain D3 half note),
    m2 = single A3 with a single fingering '2'."""
    xml = _score(
        _note("G", 3, ("1", "3", "5")) + _note("B", 3, chord=True) + _note("D", 4, chord=True)
        + _note("D", 3),
        _note("A", 3, ("2",)) + _note("C", 3),
    )
    p = tmp_path_factory.mktemp("fx") / "chord.musicxml"
    p.write_text(xml)
    return freeze_mei(p)


def _fing_map(mei_text):
    root = ET.fromstring(mei_text)
    notes = {n.get(_XID): (n.get("pname"), n.get("oct")) for n in root.iter(_M + "note")}
    out = []
    for f in root.iter(_M + "fing"):
        sid = (f.get("startid") or "").lstrip("#")
        out.append({"digit": "".join(f.itertext()).strip(), "target": notes.get(sid),
                    "ho": f.get("ho"), "vo": f.get("vo")})
    return out


def test_stack_reanchors_per_chord_note_and_gets_offsets(frozen):
    adjusted, report = adjust_mei(frozen, OPTS)
    assert report == {"stacks": 1, "beside": 1, "fallback": 0}
    by_digit = {f["digit"]: f for f in _fing_map(adjusted)}
    # digits descending <-> pitch ascending: 5->G3, 3->B3, 1->D4
    assert by_digit["5"]["target"] == ("g", "3")
    assert by_digit["3"]["target"] == ("b", "3")
    assert by_digit["1"]["target"] == ("d", "4")
    for d in ("5", "3", "1"):
        assert by_digit[d]["ho"] is not None and by_digit[d]["vo"] is not None


def test_single_fingering_untouched(frozen):
    adjusted, _ = adjust_mei(frozen, OPTS)
    single = next(f for f in _fing_map(adjusted) if f["digit"] == "2")
    assert single["target"] == ("a", "3")
    assert single["ho"] is None and single["vo"] is None


def test_rendered_digits_sit_left_of_their_noteheads(frozen):
    adjusted, _ = adjust_mei(frozen, OPTS)
    tk = make_toolkit()
    tk.setOptions(OPTS)
    assert tk.loadData(adjusted)
    fings, notes, _, _ = _geometry(tk.renderToSVG(1))
    root = ET.fromstring(adjusted)
    pitch = {n.get(_XID): (n.get("pname"), n.get("oct")) for n in root.iter(_M + "note")}
    checked = 0
    for f in root.iter(_M + "fing"):
        if f.get("ho") is None:
            continue
        fid, nid = f.get(_XID), (f.get("startid") or "").lstrip("#")
        fx, fy = fings[fid]
        nx, ny = notes[nid]
        assert fx + W_DIGIT / 2 <= nx, f"digit not left of notehead for {pitch[nid]}"
        assert abs(fy - (ny + 65.0)) < 6, f"digit not centered on its note for {pitch[nid]}"
        checked += 1
    assert checked == 3


def test_count_mismatch_leaves_group_alone():
    xml = _score(
        _note("G", 3, ("1", "5")) + _note("B", 3, chord=True) + _note("D", 4, chord=True),
        _note("C", 3),
    )
    p = Path("/tmp") / "mismatch.musicxml"
    p.write_text(xml)
    mei = freeze_mei(p)
    adjusted, report = adjust_mei(mei, OPTS)
    assert report["stacks"] == 0
    assert adjusted == mei


def test_bundle_carries_layout_report(frozen, tmp_path):
    # smoke the staff.py hook end-to-end on the fixture piece
    from pipeline.staff import build_staff_assets
    xml = _score(
        _note("G", 3, ("1", "3", "5")) + _note("B", 3, chord=True) + _note("D", 4, chord=True)
        + _note("D", 3),
        _note("A", 3) + _note("C", 3),
    )
    src = tmp_path / "piece.musicxml"
    src.write_text(xml)
    bundle = build_staff_assets("fxpiece", src, tmp_path / "missing_events.json", tmp_path)
    for vname in VARIANTS:
        rep = bundle["variants"][vname]["fingering_layout"]
        assert rep["stacks"] == 1 and rep["beside"] + rep["fallback"] == 1


def test_piece_number_rendered_beside_first_system(tmp_path):
    from pipeline.engraving_norm import normalize_engraving
    from pipeline.staff import build_staff_assets, VARIANTS
    xml = _score(
        '<direction placement="above"><direction-type><words>3.</words></direction-type>'
        "</direction>" + _note("G", 3) + _note("D", 3),
        _note("A", 3) + _note("C", 3),
    )
    src = tmp_path / "n.musicxml"
    src.write_text(xml)
    eff = normalize_engraving(src, tmp_path)
    bundle = build_staff_assets("numpiece", eff, tmp_path / "no.json", tmp_path)
    for vname in VARIANTS:
        svg = (tmp_path / f"numpiece.{vname}.svg").read_text()
        assert 'class="piece-number"' in svg and ">3.</text>" in svg
