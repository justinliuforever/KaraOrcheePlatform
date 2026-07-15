"""Staff-asset builder — vendored from piano-amt prototype/staff/produce_staff.py with
paths parameterized for the worker container. Rendering logic and the staff_eligible
gate are kept identical so cloud-built bundles match the hand-built launch set.

Per piece x device-variant, from the FROZEN canonical MEI, emits:
  <out>/<piece>.mei                 frozen source-of-record (deterministic ids)
  <out>/<piece>.<variant>.svg       WHITE-PAPER stacked-systems continuous tall SVG
  <out>/<piece>.staff.json          bundle: provenance + IDENTITY tier + per-variant GEOMETRY tier

Verovio is an OFFLINE BUILD TOOL ONLY (never shipped/linked — sidesteps LGPLv3).
"""
from __future__ import annotations
import json, re, hashlib, bisect

_REND = re.compile(r'-rend\d+$')
import xml.etree.ElementTree as ET
from pathlib import Path

from pipeline.vrv import make_toolkit, version as verovio_version
from pipeline.fingering_layout import adjust_mei as adjust_fingering_mei

ET.register_namespace('', 'http://www.w3.org/2000/svg')
ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')

COMMON = {"scale": 40, "pageHeight": 60000, "breaks": "auto", "xmlIdChecksum": True,
          "header": "none", "footer": "none", "pageMarginLeft": 100, "pageMarginTop": 120, "pageMarginBottom": 140}
VARIANTS = {"phone":         {"pageWidth": 3000, "pageMarginRight": 100},
            "ipad":          {"pageWidth": 4500, "pageMarginRight": 120},
            "ipad_portrait": {"pageWidth": 3000, "pageMarginRight": 100}}
PAGE_GAP = 1400

CURSOR_EL = ('<g id="cursor" visibility="hidden">'
             '<line class="cursor-glow" x1="0" y1="0" x2="0" y2="0" stroke="#7C5CFF" stroke-width="340" '
             'stroke-opacity="0.20" stroke-linecap="round"/>'
             '<line class="cursor-core" x1="0" y1="0" x2="0" y2="0" stroke="#7C5CFF" stroke-width="130" '
             'stroke-opacity="0.95" stroke-linecap="round"/></g>')


def s(tag: str) -> str:
    return tag.split('}')[-1]


def translate(attr: str | None):
    m = re.search(r'translate\(\s*([-\d.]+)[ ,]+([-\d.]+)', attr or "")
    return (float(m.group(1)), float(m.group(2))) if m else None


def freeze_mei(xml_path: Path) -> str:
    tk = make_toolkit()
    tk.setOptions({"xmlIdChecksum": True, "footer": "none", "header": "none"})
    if not tk.loadFile(str(xml_path)):
        raise ValueError("verovio could not load the MusicXML")
    return tk.getMEI()


def mei_measure_numbers(mei: str) -> dict:
    out = {}
    for m in re.finditer(r'<measure\b[^>]*>', mei):
        mid = re.search(r'xml:id="([^"]+)"', m.group(0))
        n = re.search(r'\bn="([^"]+)"', m.group(0))
        if mid:
            out[mid.group(1)] = n.group(1) if n else None
    return out


def staff_xy(staff_g):
    xs, ys = [], []
    for p in staff_g.iter():
        if s(p.tag) == "path":
            m = re.match(r'M\s*([-\d.]+)\s+([-\d.]+)\s+L\s*([-\d.]+)\s+([-\d.]+)', p.get("d", ""))
            if m:
                x0, y0, x1, y1 = map(float, m.groups())
                if abs(y0 - y1) < 1.0:                      # horizontal staffline only
                    xs += [x0, x1]; ys += [y0, y1]
    return xs, ys


def build_variant(mei: str, vopts: dict):
    """Render all pages, STITCH them into one continuous SVG, and extract global geometry."""
    tk = make_toolkit()
    tk.setOptions({**COMMON, **vopts})
    tk.loadData(mei)
    npages = tk.getPageCount()
    tm = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
    # data-measure-index is the WRITTEN index: expansion copies (-rendN) collapse to
    # their written measure; first appearance in played order == document order.
    mid2idx = {}
    for e in tm:
        mon = e.get("measureOn")
        if mon:
            base = _REND.sub("", mon)
            if base not in mid2idx:
                mid2idx[base] = len(mid2idx) + 1

    p1 = tk.renderToSVG(1)
    VBW = int(re.search(r'class="definition-scale"[^>]*viewBox="0 0 (\d+) (\d+)"', p1).group(1))
    svg_px_w = int(re.search(r'<svg width="(\d+)px"', p1).group(1))
    outer_open = re.search(r'<svg\b[^>]*>', p1).group(0)
    inner_open = re.search(r'<svg class="definition-scale"[^>]*>', p1).group(0)
    defs_m = re.search(r'<defs>.*?</defs>', p1, re.S)
    defs = defs_m.group(0) if defs_m else ""
    # Verovio emits two <style> blocks per page: scoped CSS rules (bold tempo/fing, italic
    # dir/dynam, stroke:currentColor — scoped to the outer id, which the stitched doc keeps)
    # and an @font-face embedding the SMuFL text font (metronome beat-unit glyphs render as
    # tofu without it). Both are identical across pages; carry page 1's copies.
    p1_styles = re.findall(r'<style[^>]*>.*?</style>', p1, re.S)
    rules_style = next((st for st in p1_styles if "@font-face" not in st), "")
    font_style = next((st for st in p1_styles if "@font-face" in st), "")

    parts, geo_measures, systems, note_xy, note_sys = [], [], [], {}, {}
    sys_idx, yoff = -1, 0.0
    for p in range(1, npages + 1):
        root = ET.fromstring(tk.renderToSVG(p))
        pm, mx, my = None, 0.0, 0.0
        for g in root.iter():
            if s(g.tag) == "g" and g.get("class") == "page-margin":
                pm = g; mx, my = translate(g.get("transform")) or (0.0, 0.0); break
        if pm is None:
            continue
        page_bottom = 0.0
        hitrects = []   # appended AFTER pm.iter() — SubElement during iteration mutates mid-walk
        for sysg in pm.iter():
            if not (s(sysg.tag) == "g" and sysg.get("class") == "system"):
                continue
            sys_idx += 1
            sysg.set("data-system-index", str(sys_idx))
            sxs, sys_mids, tops, bots = [], [], [], []
            for mg in sysg.iter():
                if not (s(mg.tag) == "g" and mg.get("class") == "measure" and mg.get("id")):
                    continue
                mg.set("data-measure-index", str(mid2idx.get(mg.get("id"), 0)))
                mxs, mys = [], []
                sn = 0
                for st in mg.iter():
                    if s(st.tag) == "g" and st.get("class") == "staff":
                        sn += 1; st.set("data-n", str(sn))
                        xs, ys = staff_xy(st); mxs += xs; mys += ys
                for nt in mg.iter():
                    if s(nt.tag) == "g" and nt.get("class") == "note" and nt.get("id"):
                        for u in nt.iter():
                            t = translate(u.get("transform")) if s(u.tag) == "use" else None
                            if t:
                                note_xy[nt.get("id")] = (round(t[0] + mx, 1), round(t[1] + my + yoff, 1))
                                note_sys[nt.get("id")] = sys_idx; break
                if mxs:
                    gy0, gy1 = min(mys) + my + yoff, max(mys) + my + yoff
                    geo_measures.append({"measure_id": mg.get("id"), "system_index": sys_idx,
                                         "bbox": [round(min(mxs) + mx, 1), round(gy0, 1),
                                                  round(max(mxs) - min(mxs), 1), round(gy1 - gy0, 1)]})
                    sxs += [min(mxs) + mx, max(mxs) + mx]; sys_mids.append(mg.get("id"))
                    tops.append(gy0); bots.append(gy1); page_bottom = max(page_bottom, max(mys))
                    hitrects.append((mg, min(mxs), min(mys), max(mxs) - min(mxs), max(mys) - min(mys)))
            if sxs:
                systems.append({"system_index": sys_idx,
                                "bbox": [round(min(sxs), 1), round(min(tops), 1),
                                         round(max(sxs) - min(sxs), 1), round(max(bots) - min(tops), 1)],
                                "measure_ids": sys_mids})
        for mg, hx, hy, hw, hh in hitrects:
            ET.SubElement(mg, '{http://www.w3.org/2000/svg}rect',
                          {"class": "measure-hit", "x": f"{hx:.1f}", "y": f"{hy:.1f}",
                           "width": f"{hw:.1f}", "height": f"{hh:.1f}", "fill": "none", "pointer-events": "all"})
        parts.append(f'<g transform="translate(0,{yoff:.0f})">{ET.tostring(pm, encoding="unicode")}</g>')
        yoff += page_bottom + my + PAGE_GAP

    total_h = max(yoff - PAGE_GAP, 1.0) + VBW
    px_per_vb = svg_px_w / VBW
    svg_px_h = round(total_h * px_per_vb)
    inner = re.sub(r'viewBox="0 0 \d+ \d+"', f'viewBox="0 0 {VBW} {int(total_h)}"', inner_open)
    outer = re.sub(r'height="\d+px"', f'height="{svg_px_h}px"', outer_open)
    # Fallback when the rules block is absent: stafflines are <path stroke-width=...> with NO
    # stroke colour -> invisible in spec renderers (WebKit) without stroke=currentColor.
    if not rules_style:
        rules_style = '<style>path[stroke-width]{stroke:currentColor}</style>'
    # house style: slurs/ties read lighter than note ink (colleague-matched to the source editions)
    rules_style = rules_style.replace('</style>', 'g.slur,g.tie{opacity:.7}</style>')
    stitched = (f'{outer}{defs}{rules_style}{inner}{"".join(parts)}{CURSOR_EL}</svg>'
                f'{font_style}</svg>')
    page = {"viewbox_w": VBW, "viewbox_h": int(total_h), "svg_px_w": svg_px_w, "svg_px_h": svg_px_h,
            "px_per_vbunit": round(px_per_vb, 6), "content_h": round(total_h, 1), "margin": [0, 0],
            "src_pages": npages}
    return stitched, tm, page, geo_measures, systems, note_xy, note_sys


def build_identity(tm: list, num_map: dict, playback: dict | None = None):
    meas, onsets = [], []
    for e in tm:
        if e.get("measureOn"):
            meas.append([e["measureOn"], e.get("qstamp", 0.0), e.get("tstamp", 0) / 1000.0])
        if e.get("on"):
            onsets.append((e.get("tstamp", 0) / 1000.0, e.get("qstamp", 0.0), e["on"]))
    end_sec = max([o[0] for o in onsets], default=0.0)
    end_q = max([o[1] for o in onsets], default=0.0)
    identity = []
    if playback is None:
        for i, (mid, q, sec) in enumerate(meas):
            q_end = meas[i + 1][1] if i + 1 < len(meas) else end_q
            s_end = meas[i + 1][2] if i + 1 < len(meas) else end_sec
            ids_in = [nid for (osec, oq, ids) in onsets if q <= oq < q_end for nid in ids]
            identity.append({"measure_index": i + 1, "measure_number": num_map.get(mid), "measure_id": mid,
                             "qstamp_start": round(q, 4), "qstamp_end": round(q_end, 4),
                             "score_sec_start": round(sec, 4), "score_sec_end": round(s_end, 4),
                             "first_note_id": ids_in[0] if ids_in else None,
                             "last_note_id": ids_in[-1] if ids_in else None})
        return identity, onsets
    # Repeats: ONE ROW PER WRITTEN MEASURE, ranges = pass-1 occurrence. The timemap
    # is expanded, so played measure k realizes occurrences[k]; identity keeps linear
    # semantics for the app (sec->measure lookups go through the playback block).
    occs = playback["occurrences"]
    assert len(occs) == len(meas)
    by_written: dict[int, int] = {}
    for k, occ in enumerate(occs):
        if occ["pass"] == 1:
            by_written[occ["measure_index"]] = k
    for wm in sorted(by_written):
        k = by_written[wm]
        mid, q, sec = meas[k]
        occ = occs[k]
        q_end, s_end = occ["expanded_q_end"], occ["expanded_sec_end"]
        ids_in = [nid for (osec, oq, ids) in onsets if q <= oq < q_end for nid in ids]
        base = _REND.sub("", mid)
        passes = sum(1 for o in occs if o["measure_index"] == wm)
        identity.append({"measure_index": wm, "measure_number": num_map.get(base), "measure_id": base,
                         "qstamp_start": round(q, 4), "qstamp_end": round(q_end, 4),
                         "score_sec_start": round(sec, 4), "score_sec_end": round(s_end, 4),
                         "first_note_id": ids_in[0] if ids_in else None,
                         "last_note_id": ids_in[-1] if ids_in else None,
                         "passes": passes})
    return identity, onsets


def cursor_anchors(onsets, note_xy, note_sys, span_starts=()):
    anchors = []
    for sec, q, ids in onsets:
        xs = [_REND.sub("", i) for i in ids]
        xs = [i for i in xs if i in note_xy]
        if not xs:
            continue
        lead = min(xs, key=lambda i: note_xy[i][0])
        x, y = note_xy[lead]
        anchors.append([round(sec, 4), x, y, note_sys.get(lead, 0)])
    # cummax x PER system kills grace/voice backward jogs — but a repeat pass
    # legitimately restarts earlier on the same system, so the running max resets
    # at every span boundary.
    last = {}
    bounds = sorted(span_starts)
    k = 0
    for a in anchors:
        while k < len(bounds) and a[0] >= bounds[k] - 1e-6:
            last = {}
            k += 1
        a[1] = max(a[1], last.get(a[3], a[1])); last[a[3]] = a[1]
    return anchors


def timeline_residual_ms(score_events_path: Path, anchor_secs: list):
    """Consistency gate: nearest-onset residual (ms) between cursor anchors (Verovio timemap)
    and score_events.json (the keyboard's source). Gate is on the MEDIAN — robust to a few
    ornament onsets present in only one source."""
    if not score_events_path.exists() or not anchor_secs:
        return None
    ev = json.loads(score_events_path.read_text())["events"]
    sv = sorted({round(float(e["onset_sec"]), 4) for e in ev})
    v = sorted(set(anchor_secs))
    if not v or not sv:
        return None
    errs = []
    for x in sv:
        i = bisect.bisect_left(v, x)
        c = []
        if i < len(v): c.append(abs(v[i] - x))
        if i > 0: c.append(abs(v[i - 1] - x))
        errs.append(min(c) * 1000 if c else 0.0)
    errs.sort()
    n = len(errs)
    return (round(errs[int(0.5 * (n - 1))], 1), round(errs[int(0.9 * (n - 1))], 1))


def build_staff_assets(piece: str, xml_path: Path, score_events_path: Path, out_dir: Path,
                       variant_overrides: dict | None = None,
                       playback: dict | None = None) -> dict:
    """Build all staff assets for one piece into out_dir; returns the bundle dict."""
    ver = verovio_version()
    sha = hashlib.sha256(xml_path.read_bytes()).hexdigest()[:16]
    mei = freeze_mei(xml_path)
    num_map = mei_measure_numbers(mei)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{piece}.mei").write_text(mei)

    if playback is None:
        bundle = {"schema": 1, "piece_id": piece, "verovio_version": ver, "source_musicxml_sha256": sha,
                  "xml_id_checksum": True, "anchor_rule": "musical-coordinate {measure_index, qstamp}; xml:id is a hint only",
                  "paper": "#FBFAF6", "ink": "#111111", "identity": {"measures": []}, "variants": {}}
    else:
        bundle = {"schema": 2, "piece_id": piece, "verovio_version": ver, "source_musicxml_sha256": sha,
                  "xml_id_checksum": True,
                  "anchor_rule": "musical-coordinate {measure_index, pass, qstamp}; pass=1 when no repeats; xml:id is a hint only",
                  "paper": "#FBFAF6", "ink": "#111111", "identity": {"measures": []},
                  "playback": playback, "variants": {}}
    id_ref = None
    for vname, vopts in VARIANTS.items():
        vopts = {**vopts, **(variant_overrides or {}).get(vname, {})}
        # fingering layout is per-variant (line breaks move the obstacles); the
        # canonical <piece>.mei stays unadjusted — position is pure presentation
        mei_v, fing_rep = adjust_fingering_mei(mei, {**COMMON, **vopts})
        svg, tm, page, gmeas, systems, note_xy, note_sys = build_variant(mei_v, vopts)
        (out_dir / f"{piece}.{vname}.svg").write_text(svg)
        identity, onsets = build_identity(tm, num_map, playback)
        span_starts = ([sp["expanded_sec_start"] for sp in playback["spans"][1:]]
                       if playback else ())
        anchors = cursor_anchors(onsets, note_xy, note_sys, span_starts)
        gmap = {m["measure_id"]: m for m in gmeas}
        geo = [{"measure_index": im["measure_index"], "measure_id": im["measure_id"],
                "system_index": gmap.get(im["measure_id"], {}).get("system_index"),
                "bbox": gmap.get(im["measure_id"], {}).get("bbox")} for im in identity]
        bundle["variants"][vname] = {"page": page, "n_systems": len(systems),
                                     "measures": geo, "systems": systems, "cursor_anchors": anchors,
                                     "fingering_layout": fing_rep}
        if id_ref is None:
            bundle["identity"]["measures"] = identity; id_ref = [m["measure_id"] for m in identity]
        else:
            bundle["variants"][vname]["id_match_phone"] = (id_ref == [m["measure_id"] for m in identity])
    res = timeline_residual_ms(score_events_path, [a[0] for a in bundle["variants"]["phone"]["cursor_anchors"]])
    p50, p90 = res if res else (None, None)
    bundle["timeline_residual_ms_p50"] = p50
    bundle["timeline_residual_ms_p90"] = p90
    bundle["staff_eligible"] = (p50 is not None and p50 < 12.0)   # bar<->keyboard one-timeline gate (MEDIAN)
    ph = bundle["variants"]["phone"]
    bands = {sg["system_index"]: sg["bbox"] for sg in ph["systems"]}
    oob = sum(1 for a in ph["cursor_anchors"]
              if (bb := bands.get(int(a[3]))) and not (bb[1] - bb[3] <= a[2] <= bb[1] + 2 * bb[3]))
    bundle["anchors_out_of_band"] = oob
    (out_dir / f"{piece}.staff.json").write_text(json.dumps(bundle))
    return bundle
