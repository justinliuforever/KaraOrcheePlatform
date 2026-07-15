"""Chord-fingering layout — place stacked fingerings BESIDE their chord noteheads.

Source editions print a chord's fingering stack immediately left of the noteheads,
one digit per chord note. Dolet anchors the whole stack to the chord's principal
note and verovio ignores fingering default-x/y, so by default every stack renders
as a floating column above/below the staff. This pass adjusts the frozen MEI once
per device variant (line breaks differ per variant, so obstacles differ):

  1. group: >=2 <fing> sharing a startid whose target note sits in a <chord> with
     exactly as many notes as digits (anything else is left untouched);
  2. re-anchor each fing to its own chord note — digits descending <-> pitch
     ascending (piano-hand convention);
  3. measure a baseline render (same options as the final one) and give each digit
     @ho/@vo (vu units) so it sits left of its notehead, column-aligned per chord,
     vertically centered on its note, clear of obstacles in the digit's own band
     (barlines, repeat dots, neighbouring noteheads, the note's own accidental).
     Two clearance tiers (standard -> compact); no solution -> the group keeps
     verovio's default placement.

Single fingerings keep the default placement — that IS the engraving convention
for running notes. The canonical <piece>.mei on disk stays unadjusted (fingering
position is pure presentation); only the per-variant renders consume the result.

All geometry constants are in verovio viewBox units, which are scale-invariant
(1 staff space = 180, 1 vu = 90). Calibrated empirically on verovio 6.2.1
(La Pastorale corpus, 2026-07-14); see KaraOrcheeSibeliusPlugin research notes.
"""
from __future__ import annotations
import re
import xml.etree.ElementTree as ET

from pipeline.vrv import make_toolkit

_M = '{http://www.music-encoding.org/ns/mei}'
_XID = '{http://www.w3.org/XML/1998/namespace}id'

VU = 90.0                      # 1 MEI vu = half a staff space
W_DIGIT = 150.0                # fingering digit width at font-size 303
BASELINE_DROP = 65.0           # text baseline below notehead center = visually centered
BAND_UP, BAND_DOWN = 145.0, 75.0   # digit vertical extent around its baseline
TIERS = ((40.0, 25.0), (25.0, 12.0))   # (clear_note, clear_obstacle), standard -> compact
WINDOW = 800.0                 # how far left of the note obstacles are considered


def _glyph_w(code: str) -> float:
    if code.startswith("E0A"):
        return 180.0           # noteheads (incl. the 0.72 glyph scale)
    if code in ("E043", "E044"):
        return 70.0            # repeat dots
    if code.startswith("E26"):
        return 160.0           # accidentals
    return 350.0               # clefs & misc — deliberately conservative


def _pitch_val(note) -> int:
    return int(note.get("oct", 0)) * 7 + "cdefgab".index(note.get("pname", "c"))


def _groups(mei_root):
    """[(digit-sorted fing elements, pitch-sorted chord note ids)] for adjustable stacks."""
    chord_of = {}
    for chord in mei_root.iter(_M + "chord"):
        for n in chord.findall(_M + "note"):
            chord_of[n.get(_XID)] = chord
    by_start: dict[str, list] = {}
    for fing in mei_root.iter(_M + "fing"):
        sid = (fing.get("startid") or "").lstrip("#")
        if sid:
            by_start.setdefault(sid, []).append(fing)
    out = []
    for sid, fings in by_start.items():
        if len(fings) < 2:
            continue
        chord = chord_of.get(sid)
        if chord is None:
            continue
        notes = sorted(chord.findall(_M + "note"), key=_pitch_val)
        try:
            fings = sorted(fings, key=lambda f: -int("".join(f.itertext()).strip()))
        except ValueError:
            continue
        if len(fings) != len(notes):
            continue
        out.append((fings, [n.get(_XID) for n in notes]))
    return out


def _retarget(mei: str, fing_id: str, old_sid: str, new_sid: str) -> str:
    m = re.search(rf'<fing\b[^>]*xml:id="{re.escape(fing_id)}"[^>]*>', mei)
    if not m:
        return mei
    tag = m.group(0)
    return mei.replace(tag, tag.replace(f'startid="#{old_sid}"', f'startid="#{new_sid}"'), 1)


def _render_pages(mei: str, options: dict) -> list[str]:
    tk = make_toolkit()
    tk.setOptions(options)
    if not tk.loadData(mei):
        raise ValueError("verovio could not load the adjusted MEI")
    return [tk.renderToSVG(p) for p in range(1, tk.getPageCount() + 1)]


def _geometry(svg: str):
    """fing id->(x,y), note id->(x,y), vertical lines, positioned glyphs."""
    fings, notes, vlines, uses = {}, {}, [], []
    for m in re.finditer(r'<g id="([^"]+)" class="fing".*?<text x="([-\d.]+)" y="([-\d.]+)"',
                         svg, re.S):
        fings[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    for m in re.finditer(r'<g id="([^"]+)" class="note">.*?translate\(([-\d.]+), ([-\d.]+)\)',
                         svg, re.S):
        notes[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    for m in re.finditer(r'\bd="M([-\d.]+) ([-\d.]+) L([-\d.]+) ([-\d.]+)"', svg):
        x1, y1, x2, y2 = map(float, m.groups())
        if abs(x1 - x2) < 2:
            vlines.append((x1, min(y1, y2), max(y1, y2)))
    for m in re.finditer(r'href="#(E[0-9A-F]{3})[^"]*" transform="translate\(([-\d.]+), ([-\d.]+)\)',
                         svg):
        uses.append((float(m.group(2)), float(m.group(3)), m.group(1)))
    return fings, notes, vlines, uses


def _solve(members, geom, clear_note, clear_obstacle):
    """Column position for one chord stack, or None. members = [(fing_id, note_id)]."""
    fings, notes, vlines, uses = geom
    lows, highs, per = [], [], []
    for fid, nid in members:
        if fid not in fings or nid not in notes:
            return None
        nx, ny = notes[nid]
        band = (ny - BAND_UP, ny + BAND_DOWN)
        boundary = nx
        for x, y, code in uses:                      # the note's own accidental
            if code.startswith("E26") and nx - 300 < x < nx - 1 and abs(y - ny) < 120:
                boundary = min(boundary, x)
        ob = 0.0
        for x, y1, y2 in vlines:
            if boundary - WINDOW < x < boundary - 5 and not (y2 < band[0] or y1 > band[1]):
                ob = max(ob, x + 20)
        for x, y, code in uses:
            if boundary - WINDOW < x < boundary - 5 and not (y + 120 < band[0] or y - 120 > band[1]):
                ob = max(ob, x + _glyph_w(code))
        lo = ob + clear_obstacle + W_DIGIT / 2
        hi = boundary - clear_note - W_DIGIT / 2
        if lo > hi:
            return None
        lows.append(lo); highs.append(hi); per.append((fid, nid, hi))
    gl, gh = max(lows), min(highs)
    if gl <= gh:
        return [(fid, nid, gh) for fid, nid, _ in per]     # aligned column
    return per                                             # ragged, each tight to its note


def adjust_mei(mei: str, options: dict) -> tuple[str, dict]:
    """Return (per-variant adjusted MEI, report). `options` must equal the final render's."""
    root = ET.fromstring(mei)
    groups = _groups(root)
    report = {"stacks": len(groups), "beside": 0, "fallback": 0}
    if not groups:
        return mei, report

    adjusted = mei
    plan = []                                        # [(members=[(fid,nid)])]
    for fings, note_ids in groups:
        members = []
        for f, nid in zip(fings, note_ids):
            fid = f.get(_XID)
            adjusted = _retarget(adjusted, fid, (f.get("startid") or "").lstrip("#"), nid)
            members.append((fid, nid))
        plan.append(members)

    pages = _render_pages(adjusted, options)
    geoms = [_geometry(svg) for svg in pages]

    for members in plan:
        page = next((i for i, svg in enumerate(pages) if f'id="{members[0][0]}"' in svg), None)
        if page is None:
            report["fallback"] += 1
            continue
        placed = None
        for clear_note, clear_obstacle in TIERS:
            placed = _solve(members, geoms[page], clear_note, clear_obstacle)
            if placed:
                break
        if not placed:
            report["fallback"] += 1
            continue
        fings, notes, _, _ = geoms[page]
        for fid, nid, cx in placed:
            fx, fy = fings[fid]
            nx, ny = notes[nid]
            ho = round((cx - fx) / VU, 2)
            vo = round(-((ny + BASELINE_DROP) - fy) / VU, 2)
            adjusted = adjusted.replace(f'xml:id="{fid}"', f'xml:id="{fid}" ho="{ho}" vo="{vo}"', 1)
        report["beside"] += 1
    return adjusted, report
