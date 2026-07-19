#!/usr/bin/env python3
"""KaraOrchee corpus health checker.

Fetches the published catalog from the API, downloads each piece's bundle assets
into a local workdir cache, and checks per-piece invariants:

  I1 endpoint         : last event release <= expanded end (repeat) / written end (linear) + 0.05s
  I2 anchor coverage  : every unique onset needs a cursor anchor within 250ms
                        (ornament tolerance); coverage >= 0.995; max nearest-anchor
                        distance <= 0.5s
  I3 start agreement  : first anchor vs first onset; measure-based drift fit over the
                        first 30s (slope!=1 / intercept!=0 -> from-t0 start-lag class)
  I4 geometry pairing : staff.json phone page viewbox vs the phone SVG's own viewBox
  I5 audio_map        : breakpoints monotone (endpoint ratios superseded by worker G8)
  I6 residuals        : stored timeline_residual p50/p90 from staff.json
  I7 bijection        : follow_ready vs staff_eligible vs playback-block vs
                        expanded-timeline consistency

Outputs (in --workdir): corpus_audit.tsv (one row per piece), summary.json (flagged
pieces grouped by class), perpiece/<pid>.json raw evidence.
"""
import argparse
import bisect
import glob as globmod
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

TOL_END = 0.05
ANCHOR_TOL = 0.250   # ornament clusters put onsets up to ~250ms from the beat anchor
COV_MIN = 0.995
MAX_NEAREST = 0.5
SLOPE_TOL = 0.02
INTERCEPT_TOL = 0.10
P90_WARN_MS = 1000.0
SVG_HEAD_BYTES = 262144  # viewBox sits in the opening <svg> tag

# vendored id -> cloud catalog id (exact-id matches added automatically)
VENDORED_ALIAS = {
    "la_candeur_v2": "burgmuller_twenty_five_easy_etudes_op_100_candeur_frankness",
    "arabesque_repeat": "burgmuller_twenty_five_easy_etudes_op_100_arabesque",
    "haydn_48_2_repeat": "haydn_sonata_48_2",
    "schubert_894_2_repeat": "schubert_sonata_894_mvt2",
}


def load(p):
    with open(p) as f:
        return json.load(f)


def fetch(url, dest, refresh=False, head_bytes=None):
    if os.path.exists(dest) and not refresh:
        return dest
    tmp = dest + ".part"
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        if head_bytes is not None:
            out.write(resp.read(head_bytes))
        else:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
    os.replace(tmp, dest)
    return dest


def uniq_onsets(events):
    return sorted({round(e["onset_sec"], 4) for e in events})


def last_event_end(events):
    return max(e["onset_sec"] + max(e["durations"]) for e in events)


def nearest(sorted_list, v):
    i = bisect.bisect_left(sorted_list, v)
    best = None
    for j in (i - 1, i, i + 1):
        if 0 <= j < len(sorted_list):
            d = abs(sorted_list[j] - v)
            if best is None or d < best[0]:
                best = (d, sorted_list[j])
    return best  # (dist, value)


def parse_viewbox(svg_text):
    m = re.search(r'viewBox="([^"]*)"', svg_text)
    if not m:
        return None
    return [float(x) for x in m.group(1).split()]


def check_piece(pid, staff, events_doc, svg_vb, follow_ready, facts, audio_map, extra=None):
    r = {"pid": pid}
    ev = events_doc["events"] if events_doc else None
    onsets = uniq_onsets(ev) if ev else None
    meas = staff["identity"]["measures"]
    written_end = max(m["score_sec_end"] for m in meas)
    mdurs = sorted(m["score_sec_end"] - m["score_sec_start"] for m in meas)
    med_mdur = mdurs[len(mdurs) // 2]
    pb = staff.get("playback")
    spans = pb.get("spans") if isinstance(pb, dict) else (pb if isinstance(pb, list) else None)
    expanded_end = max(s["expanded_sec_end"] for s in spans) if spans else None
    ph = staff["variants"]["phone"]
    anchors = sorted(a[0] for a in ph["cursor_anchors"])
    r["n_anchors"] = len(anchors)
    r["written_end"] = round(written_end, 3)
    r["expanded_end"] = round(expanded_end, 3) if expanded_end is not None else None
    r["has_playback"] = spans is not None
    r["n_spans"] = len(spans) if spans else 0
    r["initial_tempo_eps"] = events_doc.get("initial_tempo_eps") if events_doc else None
    r["tempo_source"] = (facts or {}).get("tempo_source")
    r["facts_duration_sec"] = (facts or {}).get("duration_sec")

    # zero-length final measure in identity.measures (score_sec_end == score_sec_start at the written end)
    r["final_measure_zero_len"] = any(
        abs(m["score_sec_end"] - written_end) < 1e-9 and (m["score_sec_end"] - m["score_sec_start"]) < 1e-9
        for m in meas)

    # ---- I1 endpoint
    if ev:
        lee = last_event_end(ev)
        last_onset = max(e["onset_sec"] for e in ev)
        r["last_event_end"] = round(lee, 3)
        r["last_onset"] = round(last_onset, 3)
        ref = expanded_end if expanded_end is not None else written_end
        r["I1_ref"] = "expanded" if expanded_end is not None else "written"
        r["I1_overrun"] = round(lee - ref, 3)
        r["I1_ok"] = lee <= ref + TOL_END
        # expanded timeline = onsets (not releases) extend beyond written timeline
        r["is_expanded"] = last_onset > written_end + 0.5
        # linear piece whose last onset sits AT/PAST the final written barline = identity
        # timeline truncated (zero-length or missing final measure entry)
        r["identity_truncated"] = (expanded_end is None and not r["is_expanded"]
                                   and last_onset >= written_end - 1e-3)
    else:
        r["I1_ok"] = None
        r["is_expanded"] = spans is not None and expanded_end is not None and expanded_end > written_end + 0.5

    # ---- I2 anchor coverage (250ms ornament tolerance)
    if ev:
        r["n_events_unique"] = len(onsets)
        dists = [nearest(anchors, o)[0] for o in onsets] if anchors else []
        cov = (sum(1 for d in dists if d <= ANCHOR_TOL) / len(onsets)) if onsets and dists else 0.0
        r["I2_coverage"] = round(cov, 4)
        r["I2_max_nearest"] = round(max(dists), 3) if dists else None
        r["I2_ok"] = bool(dists) and cov >= COV_MIN and max(dists) <= MAX_NEAREST
    else:
        r["I2_ok"] = None

    # ---- I3 start agreement / drift
    if ev and anchors:
        r["first_anchor"] = round(anchors[0], 3)
        r["first_onset"] = round(onsets[0], 3)
        r["I3_start_diff"] = round(anchors[0] - onsets[0], 3)
        m03 = []
        for m in meas[:4]:
            d = nearest(onsets, m["score_sec_start"])
            m03.append(round(d[1] - m["score_sec_start"], 3) if d else None)
        r["I3_m03_deltas"] = m03
        # (a) greedy monotone anchor<->onset matching (80ms) over the first 30s.
        #     A genuine tempo-ratio mismatch (score_events built at one tempo, staff at
        #     another) makes matching fail almost everywhere after ~2s; anchor HOLES
        #     (C2) merely drop some pairs. Index-pairing or nearest-pairing both give
        #     artifact slopes under holes, so neither is used for the verdict.
        w_on = [o for o in onsets if o <= 30.0]
        w_an = [a for a in anchors if a <= 30.0]
        j = 0
        matched = 0
        for a in w_an:
            while j < len(w_on) and w_on[j] < a - 0.08:
                j += 1
            if j < len(w_on) and abs(w_on[j] - a) <= 0.08:
                matched += 1
                j += 1
        r["I3_matched_frac_30s"] = round(matched / len(w_an), 4) if w_an else None
        # (b) measure-based drift: identity.measures score_sec ranges vs the onsets
        #     that fall inside them. delta_k = (first onset >= measure start) - start;
        #     Theil-Sen slope of delta vs start over the first 30s = (ratio - 1).
        #     Immune to anchor holes (uses events + identity only).
        deltas = []
        for m in meas:
            s = m["score_sec_start"]
            if s > 30.0:
                break
            i = bisect.bisect_left(onsets, s - 0.031)
            if i < len(onsets) and onsets[i] < m["score_sec_end"]:
                deltas.append((s, onsets[i] - s))
        drift = None
        if len(deltas) >= 4:
            slopes = sorted((deltas[j2][1] - deltas[i2][1]) / (deltas[j2][0] - deltas[i2][0])
                            for i2 in range(len(deltas)) for j2 in range(i2 + 1, len(deltas))
                            if deltas[j2][0] - deltas[i2][0] > 1e-9)
            drift = slopes[len(slopes) // 2] if slopes else None
        r["I3_drift"] = round(drift, 5) if drift is not None else None
        r["I3_n_measures_fit"] = len(deltas)
        r["I3_ok"] = (abs(r["I3_start_diff"]) <= INTERCEPT_TOL
                      and (drift is None or abs(drift) <= SLOPE_TOL))
    else:
        r["I3_ok"] = None

    # ---- I4 geometry pairing
    page = ph["page"]
    r["staff_viewbox"] = [page["viewbox_w"], page["viewbox_h"]]
    r["svg_viewbox"] = svg_vb
    if svg_vb:
        r["I4_dw"] = round(svg_vb[2] - page["viewbox_w"], 1)
        r["I4_dh"] = round(svg_vb[3] - page["viewbox_h"], 1)
        r["I4_ok"] = (abs(r["I4_dw"]) < 1 and abs(r["I4_dh"]) < 1
                      and svg_vb[0] == 0 and svg_vb[1] == 0)
    else:
        r["I4_ok"] = None

    # ---- I5 audio_map monotonicity (endpoint ratios superseded by worker G8)
    if audio_map:
        ss, au = audio_map["score_sec"], audio_map["audio_sec"]
        mono = all(b >= a for a, b in zip(ss, ss[1:])) and all(b >= a for a, b in zip(au, au[1:]))
        r["I5_monotone"] = mono
        r["I5_ok"] = mono
    else:
        r["I5_ok"] = None

    # ---- I6 residuals
    r["I6_p50_ms"] = staff.get("timeline_residual_ms_p50")
    r["I6_p90_ms"] = staff.get("timeline_residual_ms_p90")
    r["I6_ok"] = None if r["I6_p90_ms"] is None else r["I6_p90_ms"] <= P90_WARN_MS

    # ---- I7 bijection
    r["follow_ready"] = follow_ready
    r["staff_eligible"] = staff.get("staff_eligible")
    i7_flags = []
    if follow_ready and not r["staff_eligible"]:
        i7_flags.append("follow_ready_but_not_staff_eligible")
    if r.get("is_expanded") and not r["has_playback"]:
        i7_flags.append("expanded_timeline_without_playback_block")
    # playback declares expansion but the final expanded measure(s) contain no onset at
    # all (a last note + closing rest inside the final measure is the known-FINE case)
    if (expanded_end is not None and r.get("last_onset") is not None):
        deficit = expanded_end - r["last_onset"]
        r["I7_end_deficit"] = round(deficit, 3)
        if deficit > 2 * med_mdur:
            i7_flags.append("no_onsets_in_final_expanded_measures")
    r["I7_flags"] = i7_flags
    r["I7_ok"] = not i7_flags

    if extra:
        r.update(extra)
    return r


def classify(r):
    cls = []
    if r.get("identity_truncated"):
        cls.append("C1_identity_truncated")   # zero-len/missing final measure; events at/past final barline
    elif r.get("I1_ok") is False:
        cls.append("C1_endpoint")
    elif r.get("final_measure_zero_len"):
        cls.append("C1_zero_len_final_measure")  # structural: identity carries a zero-length final measure
    if r.get("I2_ok") is False or (r.get("I6_ok") is False):
        cls.append("C2_anchor_holes")
    if r.get("I3_ok") is False:
        cls.append("START_LAG_TEMPO")         # staff timeline vs score_events tempo mismatch from t=0
    if r.get("I4_ok") is False:
        cls.append("C3_geometry")             # staff.json page vs its own SVG viewBox
    if r.get("I5_ok") is False:
        cls.append("C5_audiomap")
    if r.get("I7_ok") is False:
        cls.append("C7_bijection")
    if r.get("generation_skew"):
        cls.append("C3_generation_skew")      # vendored pair is a different render generation than cloud
    return cls


def piece_file_url(piece, role, variant=None):
    for f in piece.get("files", []):
        if f.get("role") == role and (variant is None or f.get("variant") == variant):
            return f.get("url")
    return None


def download_corpus(api_base, workdir, refresh):
    corpus = os.path.join(workdir, "corpus")
    os.makedirs(corpus, exist_ok=True)
    cat_path = os.path.join(workdir, "catalog.json")
    # caps=instruments,repeats: without them the API filters non-piano and repeat
    # pieces out of the catalog, silently shrinking the audit surface.
    url = api_base.rstrip("/") + "/v1/catalog?caps=" + urllib.parse.quote("instruments,repeats")
    tmp = cat_path + ".part"
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        out.write(resp.read())
    os.replace(tmp, cat_path)
    cat = load(cat_path)
    missing = {}
    for p in cat.get("pieces", []):
        pid = p["id"]
        want = [("geometry", None, f"{pid}.geometry.json", None),
                ("score_events", None, f"{pid}.score_events.json", None),
                ("svg", "phone", f"{pid}.phone.head.svg", SVG_HEAD_BYTES),
                ("audio_map", None, f"{pid}.audio_map.json", None)]
        for role, variant, name, head in want:
            u = piece_file_url(p, role, variant)
            if not u:
                if role in ("geometry", "score_events"):
                    missing.setdefault(pid, []).append(role)
                continue
            try:
                fetch(u, os.path.join(corpus, name), refresh=refresh, head_bytes=head)
            except Exception as err:
                missing.setdefault(pid, []).append(f"{role}: {err}")
    return cat, missing


def main():
    ap = argparse.ArgumentParser(description="Audit the published corpus against per-piece invariants I1-I7.")
    ap.add_argument("--api-base", required=True, help="API origin, e.g. https://api.example.com")
    ap.add_argument("--workdir", default="./corpus_health_run", help="download cache + report output dir")
    ap.add_argument("--assets-dir", default=None,
                    help="optional dir of vendored app asset sets (<id>/<id>.staff.json) to cross-check against cloud")
    ap.add_argument("--refresh", action="store_true", help="re-download cached bundle files")
    args = ap.parse_args()

    workdir = os.path.abspath(args.workdir)
    corpus = os.path.join(workdir, "corpus")
    os.makedirs(os.path.join(workdir, "perpiece"), exist_ok=True)

    cat, missing = download_corpus(args.api_base, workdir, args.refresh)
    pieces = {p["id"]: p for p in cat.get("pieces", [])}
    rows = []

    # ---------- cloud corpus ----------
    for pid in sorted(pieces):
        if pid in missing and any(str(m).split(":")[0] in ("geometry", "score_events") for m in missing[pid]):
            continue
        staff = load(f"{corpus}/{pid}.geometry.json")
        events = load(f"{corpus}/{pid}.score_events.json")
        svg_p = f"{corpus}/{pid}.phone.head.svg"
        vb = parse_viewbox(open(svg_p, encoding="utf-8", errors="ignore").read(SVG_HEAD_BYTES)) \
            if os.path.exists(svg_p) else None
        am_p = f"{corpus}/{pid}.audio_map.json"
        am = load(am_p) if os.path.exists(am_p) else None
        p = pieces[pid]
        r = check_piece(pid, staff, events, vb, p.get("follow_ready"), p.get("facts"), am,
                        extra={"origin": "cloud", "tier": p.get("tier"), "tracking": p.get("tracking")})
        r["classes"] = classify(r)
        rows.append(r)

    # ---------- vendored asset sets ----------
    cloud_staff_cache = {}
    assets = args.assets_dir
    for d in (sorted(os.listdir(assets)) if assets else []):
        dd = os.path.join(assets, d)
        if not os.path.isdir(dd):
            continue
        staff_p = os.path.join(dd, d + ".staff.json")
        svg_p = os.path.join(dd, d + ".phone.svg")
        if not os.path.exists(staff_p):
            continue
        staff = load(staff_p)
        ev_p = os.path.join(dd, "score_events.json")
        events = load(ev_p) if os.path.exists(ev_p) else None
        vb = parse_viewbox(open(svg_p, encoding="utf-8", errors="ignore").read(SVG_HEAD_BYTES)) \
            if os.path.exists(svg_p) else None
        am_candidates = (globmod.glob(os.path.join(dd, "*audio_map*.json"))
                         + globmod.glob(os.path.join(assets, d + "*audio_map*.json")))
        am = load(am_candidates[0]) if am_candidates else None
        cloud_id = d if d in pieces else VENDORED_ALIAS.get(d)
        extra = {"origin": "vendored", "cloud_id": cloud_id}
        if os.path.exists(svg_p):
            extra["mtime_staff"] = os.path.getmtime(staff_p)
            extra["mtime_svg"] = os.path.getmtime(svg_p)
            extra["mtime_gap_days"] = round((extra["mtime_staff"] - extra["mtime_svg"]) / 86400.0, 2)
        # cross-generation check vs cloud staff/svg for the same catalog piece
        if cloud_id and cloud_id in pieces:
            cp = f"{corpus}/{cloud_id}.geometry.json"
            if os.path.exists(cp):
                cs = cloud_staff_cache.setdefault(cloud_id, load(cp))
                va = staff["variants"]["phone"]["cursor_anchors"]
                ca = cs["variants"]["phone"]["cursor_anchors"]
                if va and ca:
                    extra["anchor0_vendored"] = va[0]
                    extra["anchor0_cloud"] = ca[0]
                    extra["anchor0_dy"] = round(va[0][2] - ca[0][2], 1)
                    extra["anchor0_dx"] = round(va[0][1] - ca[0][1], 1)
                extra["xml_sha_match"] = staff.get("source_musicxml_sha256") == cs.get("source_musicxml_sha256")
                cloud_vb = cs["variants"]["phone"]["page"]
                same_vb = (staff["variants"]["phone"]["page"]["viewbox_w"] == cloud_vb["viewbox_w"]
                           and staff["variants"]["phone"]["page"]["viewbox_h"] == cloud_vb["viewbox_h"])
                extra["viewbox_matches_cloud"] = same_vb

                cfiles = {(f["role"], f.get("variant")): f for f in pieces[cloud_id]["files"]}

                def sha(p):
                    h = hashlib.sha256()
                    with open(p, "rb") as fh:
                        for chunk in iter(lambda: fh.read(1 << 20), b""):
                            h.update(chunk)
                    return h.hexdigest()

                if d == cloud_id:  # only meaningful when the very same piece id
                    if ("svg", "phone") in cfiles and os.path.exists(svg_p):
                        extra["svg_sha_matches_cloud"] = sha(svg_p) == cfiles[("svg", "phone")]["sha256"]
                    if ("geometry", None) in cfiles:
                        extra["staff_sha_matches_cloud"] = sha(staff_p) == cfiles[("geometry", None)]["sha256"]
                # Generation skew: the vendored staff+svg pair differs from the current
                # cloud bundle for the same catalog piece. Each pair may be internally
                # consistent (I4 passes on both sides), but any client mixing vendored
                # geometry with cloud SVG (or vice versa) draws the cursor a full
                # system off from the FIRST second.
                if (not same_vb) or abs(extra.get("anchor0_dy", 0)) > 500 \
                   or extra.get("svg_sha_matches_cloud") is False or extra.get("staff_sha_matches_cloud") is False:
                    extra["generation_skew"] = True
        fr = pieces[cloud_id].get("follow_ready") if cloud_id and cloud_id in pieces else None
        facts = pieces[cloud_id].get("facts") if cloud_id and cloud_id in pieces else None
        r = check_piece(d, staff, events, vb, fr, facts, am, extra=extra)
        r["classes"] = classify(r)
        rows.append(r)

    # ---------- write outputs ----------
    for r in rows:
        name = r["pid"] if r["origin"] == "cloud" else "vendored__" + r["pid"]
        with open(f"{workdir}/perpiece/{name}.json", "w") as f:
            json.dump(r, f, indent=1)

    cols = ["pid", "origin", "classes", "I1_ok", "I1_ref", "I1_overrun", "last_event_end", "last_onset",
            "written_end", "expanded_end", "has_playback", "n_spans", "is_expanded",
            "final_measure_zero_len", "identity_truncated",
            "I2_ok", "I2_coverage", "I2_max_nearest", "n_anchors", "n_events_unique",
            "I3_ok", "I3_start_diff", "I3_matched_frac_30s", "I3_drift", "I3_n_measures_fit", "I3_m03_deltas",
            "I4_ok", "staff_viewbox", "svg_viewbox", "I4_dw", "I4_dh",
            "I5_ok", "I5_monotone",
            "I6_ok", "I6_p50_ms", "I6_p90_ms",
            "I7_ok", "I7_flags", "I7_end_deficit", "follow_ready", "staff_eligible",
            "tempo_source", "initial_tempo_eps", "facts_duration_sec",
            "cloud_id", "mtime_gap_days", "anchor0_dy", "anchor0_dx", "xml_sha_match",
            "viewbox_matches_cloud", "svg_sha_matches_cloud", "staff_sha_matches_cloud", "generation_skew"]
    with open(f"{workdir}/corpus_audit.tsv", "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write("\t".join(json.dumps(r.get(c)) if isinstance(r.get(c), (list, dict)) else str(r.get(c)) for c in cols) + "\n")

    summary = {"n_pieces": len(rows),
               "n_cloud": sum(1 for r in rows if r["origin"] == "cloud"),
               "n_vendored": sum(1 for r in rows if r["origin"] == "vendored"),
               "missing_files": missing,
               "classes": {}}
    for r in rows:
        for c in r["classes"]:
            summary["classes"].setdefault(c, []).append({
                "pid": r["pid"], "origin": r["origin"],
                "evidence": {k: r.get(k) for k in
                             ("I1_overrun", "last_event_end", "last_onset", "expanded_end", "written_end",
                              "final_measure_zero_len", "I2_coverage", "I2_max_nearest",
                              "I3_start_diff", "I3_matched_frac_30s", "I3_drift",
                              "I4_dw", "I4_dh", "I5_monotone",
                              "I6_p90_ms", "I7_flags", "I7_end_deficit", "anchor0_dy", "viewbox_matches_cloud",
                              "svg_sha_matches_cloud", "staff_sha_matches_cloud", "tempo_source")
                             if r.get(k) not in (None, [], 0.0)}})
    summary["class_counts"] = {k: len(v) for k, v in summary["classes"].items()}
    summary["clean"] = [r["pid"] for r in rows if not r["classes"]]
    with open(f"{workdir}/summary.json", "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps({"class_counts": summary["class_counts"], "n_clean": len(summary["clean"]),
                      "n_pieces": summary["n_pieces"],
                      "n_missing_files": len(missing)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
