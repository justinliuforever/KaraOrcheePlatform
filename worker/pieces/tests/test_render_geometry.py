"""Assertions about the RENDERED page, not the attributes that produce it.

Every fingering defect this pipeline has shipped passed the attribute-level
tests: a digit sat 16.6 staff spaces from its note while the suite was green,
because nothing measured the picture. These render a real score and measure it.
"""
import re
import statistics
from pathlib import Path

import pytest

from pipeline.engraving_norm import normalize_engraving
from pipeline.fingering_layout import adjust_mei
from pipeline.vrv import make_toolkit

XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      {home}
    </measure>
    <measure number="2">
      {notes}
    </measure>
  </part>
</score-partwise>
"""




def _note(step, octave, voice, staff, fingerings=(), chord=False):
    fing = "".join(f"<fingering>{d}</fingering>" for d in fingerings)
    return (
        "<note>"
        + ("<chord/>" if chord else "")
        + f"<pitch><step>{step}</step><octave>{octave}</octave></pitch>"
        f"<duration>4</duration><voice>{voice}</voice><type>quarter</type>"
        f"<staff>{staff}</staff>"
        + (f"<notations><technical>{fing}</technical></notations>" if fing else "")
        + "</note>"
    )


def _home_bar():
    """Each voice needs a majority home staff before a crossing bar means
    anything — a voice that only ever appears on the bass staff simply lives
    there, and the cross-staff rule correctly never fires."""
    return (_note("E", 5, 1, 1) + _note("F", 5, 1, 1)
            + "<backup><duration>8</duration></backup>"
            + _note("E", 2, 5, 2) + _note("F", 2, 5, 2))


def _render(tmp_path, notes):
    src = tmp_path / "g.musicxml"
    src.write_text(XML.format(home=_home_bar(), notes=notes))
    eff = normalize_engraving(src, tmp_path)
    tk = make_toolkit()
    opts = {"scale": 40, "pageWidth": 3000, "pageHeight": 60000, "adjustPageHeight": True,
            "header": "none", "footer": "none", "breaks": "auto", "xmlIdChecksum": True}
    tk.setOptions(opts)
    assert tk.loadFile(str(eff)), "verovio could not load the normalized score"
    mei, _ = adjust_mei(tk.getMEI(), opts)
    tk2 = make_toolkit()
    tk2.setOptions(opts)
    assert tk2.loadData(mei)
    return mei, tk2.renderToSVG(1)


def _staff_space(svg):
    ys = sorted({float(m.group(1)) for m in re.finditer(r'd="M\d+ (\d+) L\d+ \1"', svg)})
    gaps = [round(b - a) for a, b in zip(ys, ys[1:]) if 40 < b - a < 400]
    return float(statistics.mode(gaps)) if gaps else 180.0


def _gaps_in_staff_spaces(mei, svg):
    """Distance from each fingering to the notehead it labels, paired via startid."""
    pairs = re.findall(r'<fing\b[^>]*xml:id="([^"]+)"[^>]*startid="#([^"]+)"', mei)
    pairs += [(f, n) for n, f in
              re.findall(r'<fing\b[^>]*startid="#([^"]+)"[^>]*xml:id="([^"]+)"', mei)]
    fing_y = {m.group(1): float(m.group(2)) for m in
              re.finditer(r'<g id="(\w+)" class="fing">\s*<text x="\d+" y="(\d+)"', svg)}
    note_y = {m.group(1): float(m.group(2)) for m in
              re.finditer(r'<g id="(\w+)" class="note[^"]*">\s*<g class="notehead">\s*'
                          r'<use[^>]*transform="translate\(\d+, (\d+)\)', svg)}
    space = _staff_space(svg)
    return {f: abs(fing_y[f] - note_y[n]) / space
            for f, n in pairs if f in fing_y and n in note_y}


# The right hand runs low enough to be written on the bass staff; the left hand
# runs high enough to be written on the treble one. This is Hanon's scale layout,
# and it is where deciding a side by the printed staff goes wrong.
CROSS_STAFF = (
    _note("C", 4, 1, 2, ["1"]) + _note("D", 4, 1, 2, ["2"])
    + "<backup><duration>8</duration></backup>"
    + _note("C", 3, 5, 2, ["5"]) + _note("D", 3, 5, 2, ["4"])
)


def test_every_fingering_stays_near_its_notehead(tmp_path):
    mei, svg = _render(tmp_path, CROSS_STAFF)
    gaps = _gaps_in_staff_spaces(mei, svg)
    assert gaps, "no fingering could be paired to a notehead"
    far = {k: round(v, 1) for k, v in gaps.items() if v > 8}
    assert not far, f"fingerings stranded away from their notes: {far}"


RH_CHORD = (
    _note("C", 4, 1, 1, ["1"]) + _note("E", 4, 1, 1, ["2"], chord=True)
    + _note("G", 4, 1, 1, ["5"], chord=True)
    + "<backup><duration>4</duration></backup>"
    + _note("C", 3, 5, 2)
)


def test_right_hand_chord_puts_the_thumb_on_the_lowest_note(tmp_path):
    mei, _svg = _render(tmp_path, RH_CHORD)
    notes = {m.group(1): (m.group(3), int(m.group(2))) for m in
             re.finditer(r'<note xml:id="([^"]+)"[^>]*?oct="(\d)"[^>]*?pname="(\w)"', mei)}
    digits = {}
    for m in re.finditer(r'<fing\b[^>]*startid="#([^"]+)"[^>]*>(\d)</fing>', mei):
        digits[m.group(1)] = int(m.group(2))
    placed = [(notes[n][1] * 7 + "cdefgab".index(notes[n][0]), d)
              for n, d in digits.items() if n in notes]
    assert len(placed) == 3, f"expected the three chord digits, got {placed}"
    placed.sort()
    assert [d for _, d in placed] == [1, 2, 5], (
        f"right-hand chord should read 1-2-5 up the chord, got {[d for _, d in placed]}")


@pytest.mark.parametrize("staff,voice", [(2, 1), (1, 5)])
def test_a_crossing_voice_keeps_its_digits_inside_the_system(tmp_path, staff, voice):
    other = 1 if staff == 2 else 2
    notes = (_note("C", 4, voice, staff, ["3"])
             + "<backup><duration>4</duration></backup>"
             + _note("G", 3 if other == 2 else 5, 5 if voice == 1 else 1, other))
    mei, svg = _render(tmp_path, notes)
    gaps = _gaps_in_staff_spaces(mei, svg)
    assert gaps and max(gaps.values()) <= 8, (
        f"crossing voice stranded its digit: {gaps}")
