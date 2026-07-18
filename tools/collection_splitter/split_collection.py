#!/usr/bin/env python3
"""Split a Dolet-exported multi-piece collection (single part, pieces delimited by
edition-number system texts like "41.") into standalone per-piece MusicXML files.

XML-only route: the collection carries no numeric tempo and Sibelius could not
export a whole-book MIDI (700MB corrupt-header export, 2026-07-18), so each piece
gets an injected <sound tempo> from the Sibelius-playback term map below and the
pipeline builds on its xml_timemap route (geometry residual 0 by construction).
The colleague's ear check = the per-piece preview audio in review; real metronome
marks later arrive as v2 uploads.

Segmentation is evidence-based, not label-trusting: label positions give candidate
starts, each start is scored against final-barline adjacency and key/time changes,
label text is treated as a checksum only (the real book has one unlabeled piece and
two mislabeled ones). Every anomaly lands in the segmentation report for human
confirmation BEFORE any upload.
"""
from __future__ import annotations

import copy
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

LABEL_RE = re.compile(r"\d{1,3}\s*\.")
EXPECTED_PIECES = 98

# Sibelius playback defaults for tempo words, calibrated against the two real MIDI
# exports we hold (partial 12-piece export + the salvaged conductor prefix of the
# whole-book export): unmarked=100 and Allegro=120 are OBSERVED; the rest are
# Sibelius's documented defaults and are flagged "default" in the report.
TERM_BPM = {
    None: (100, "observed"),
    "allegro": (120, "observed"),
    "allegretto": (100, "observed"),
    "moderato": (110, "observed"),
    "vivace": (140, "observed"),
    "andante": (75, "observed"),
    "adagio": (50, "observed"),
    "andantino": (80, "default"),
    "molto allegro": (132, "default"),
    "allegro moderato": (116, "default"),
    "allegro vivace": (132, "default"),
    "poco allegro": (112, "default"),
    "poco vivace": (126, "default"),
}

ATTR_ORDER = ["divisions", "key", "time", "staves", "clef"]


def _words_of(measure):
    out = []
    for d in measure.findall("direction"):
        for w in d.iter("words"):
            if w.text and w.text.strip():
                out.append((d, w.text.strip()))
    return out


def load(path: Path):
    root = ET.parse(path).getroot()
    part = root.find("part")
    return root, part, part.findall("measure")


def find_starts(measures):
    """Candidate starts = label positions + unlabeled boundaries (final barline
    followed by a tempo word). Returns (starts, report_rows)."""
    labels = []
    for i, m in enumerate(measures):
        for _, t in _words_of(m):
            if LABEL_RE.fullmatch(t):
                labels.append((i, int(t.rstrip(".  "))))
    finals = set()
    for i, m in enumerate(measures):
        for bl in m.findall("barline"):
            if (bl.findtext("bar-style") or "") == "light-heavy":
                finals.add(i)

    starts = [i for i, _ in labels]
    # Unlabeled-piece recovery: a final barline whose next measure starts a key or
    # time change or carries a tempo-ish word, and is not already a labeled start.
    labeled = set(starts)
    for i in sorted(finals):
        j = i + 1
        if j >= len(measures) or j in labeled:
            continue
        nxt = measures[j]
        has_sig = nxt.find("attributes/key") is not None or nxt.find("attributes/time") is not None
        has_word = any(not LABEL_RE.fullmatch(t) for _, t in _words_of(nxt))
        # conservative: require BOTH signature change and a word, to avoid splitting
        # at mid-piece final barlines (Fine bars etc.)
        if has_sig and has_word:
            starts.append(j)
    starts = sorted(set(starts))
    if 0 not in starts:
        starts.insert(0, 0)

    # Minimum-length rule: a boundary that would create a piece shorter than 4
    # bars is a stray label, not a piece (the real book has a floating '90.' text
    # mid-piece that would otherwise split off a 1-bar "piece").
    MIN_BARS = 4
    kept, dropped = [], []
    for k, s in enumerate(starts):
        nxt = starts[k + 1] if k + 1 < len(starts) else len(measures)
        if kept and nxt - s < MIN_BARS:
            dropped.append(s)
        else:
            kept.append(s)
    starts = kept

    rows = []
    label_at = dict(labels)
    for k, s in enumerate(starts):
        expect = k + 1
        got = label_at.get(s)
        note = ""
        if got is None:
            note = "UNLABELED (recovered from final-barline + signature evidence)"
        elif got != expect:
            note = f"LABEL MISMATCH: printed '{got}.' but positional ordinal is {expect}"
        prev_final = (s - 1) in finals or s == 0
        rows.append({"piece": expect, "start_measure_index": s,
                     "label": got, "preceded_by_final": prev_final, "note": note})
    for s in dropped:
        rows.append({"piece": None, "start_measure_index": s, "label": label_at.get(s),
                     "preceded_by_final": (s - 1) in finals,
                     "note": "REJECTED boundary (would create a <4-bar piece; stray label text)"})
    return starts, rows


def carry_attributes(measures):
    """Running (divisions, key, time, clef-per-staff, staves) at each index."""
    state = {"divisions": None, "key": None, "time": None, "staves": None, "clefs": {}}
    snapshots = []
    for m in measures:
        snapshots.append({
            "divisions": state["divisions"], "key": state["key"], "time": state["time"],
            "staves": state["staves"], "clefs": dict(state["clefs"]),
        })
        for a in m.findall("attributes"):
            if a.find("divisions") is not None:
                state["divisions"] = copy.deepcopy(a.find("divisions"))
            if a.find("key") is not None:
                state["key"] = copy.deepcopy(a.find("key"))
            if a.find("time") is not None:
                state["time"] = copy.deepcopy(a.find("time"))
            if a.find("staves") is not None:
                state["staves"] = copy.deepcopy(a.find("staves"))
            for c in a.findall("clef"):
                state["clefs"][c.get("number") or "1"] = copy.deepcopy(c)
    return snapshots


def ensure_first_measure_attributes(m1, snap):
    attrs = m1.find("attributes")
    if attrs is None:
        attrs = ET.Element("attributes")
        m1.insert(0, attrs)
    have_clefs = {c.get("number") or "1" for c in attrs.findall("clef")}
    additions = []
    if attrs.find("divisions") is None and snap["divisions"] is not None:
        additions.append(copy.deepcopy(snap["divisions"]))
    if attrs.find("key") is None and snap["key"] is not None:
        additions.append(copy.deepcopy(snap["key"]))
    if attrs.find("time") is None and snap["time"] is not None:
        additions.append(copy.deepcopy(snap["time"]))
    if attrs.find("staves") is None and snap["staves"] is not None:
        additions.append(copy.deepcopy(snap["staves"]))
    for num, clef in sorted(snap["clefs"].items()):
        if num not in have_clefs:
            additions.append(copy.deepcopy(clef))
    for el in additions:
        attrs.append(el)
    # normalize schema order
    order = {name: i for i, name in enumerate(ATTR_ORDER)}
    attrs[:] = sorted(list(attrs), key=lambda e: order.get(e.tag, len(order)))


def piece_tempo(piece_measures):
    """(term, bpm, source) from the first two measures' non-label words. Full match
    first, then base-term prefix ("Allegretto scherzando." -> allegretto) — Sibelius's
    own playback dictionary keyword-matches inside tempo text the same way."""
    candidates = []
    for m in piece_measures[:2]:
        for _, t in _words_of(m):
            if not LABEL_RE.fullmatch(t):
                candidates.append(t)
    for t in candidates:
        key = t.rstrip(". ").lower()
        if key in TERM_BPM:
            bpm, src = TERM_BPM[key]
            return t.rstrip("."), bpm, src
    for t in candidates:
        first = t.rstrip(". ").lower().split()[0] if t.strip() else ""
        if first in TERM_BPM and first is not None:
            bpm, src = TERM_BPM[first]
            return t.rstrip("."), bpm, "prefix:" + src
    bpm, src = TERM_BPM[None]
    return None, bpm, src


def inject_sound_tempo(m1, bpm):
    d = ET.Element("direction")
    ET.SubElement(d, "sound", {"tempo": str(bpm)})
    attrs = m1.find("attributes")
    pos = list(m1).index(attrs) + 1 if attrs is not None else 0
    m1.insert(pos, d)


def has_dc(piece_measures):
    return any("D.C" in t or "D. C" in t
               for m in piece_measures for _, t in _words_of(m))


def split(src: Path, out_dir: Path):
    root, part, measures = load(src)
    starts, seg_rows = find_starts(measures)
    if len(starts) != EXPECTED_PIECES:
        for r in seg_rows:
            if r["note"]:
                print("  !", r, file=sys.stderr)
        raise SystemExit(f"segmentation found {len(starts)} pieces, expected {EXPECTED_PIECES} — aborting")

    snapshots = carry_attributes(measures)
    total_notes = len(part.findall(".//note"))
    total_fings = len(part.findall(".//fingering"))

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "excluded_dc").mkdir(exist_ok=True)
    manifest = []
    bounds = starts + [len(measures)]
    sum_measures = sum_notes = sum_fings = 0

    for k in range(EXPECTED_PIECES):
        n = k + 1
        seg = [copy.deepcopy(m) for m in measures[bounds[k]:bounds[k + 1]]]
        # Strip stray edition-number words anywhere past measure 1 — they belong to
        # no piece and would render as floating text (real case: '90.' inside 91).
        strays = 0
        for m in seg[1:]:
            for d in list(m.findall("direction")):
                ws = d.findall(".//words")
                if len(ws) == 1 and ws[0].text and LABEL_RE.fullmatch(ws[0].text.strip()):
                    m.remove(d)
                    strays += 1
        new_root = ET.Element("score-partwise", {"version": root.get("version") or "4.0"})
        for child in root:
            if child.tag in ("movement-title", "part"):
                continue
            if child.tag == "credit":
                continue
            new_root.append(copy.deepcopy(child))
        new_part = ET.SubElement(new_root, "part", {"id": part.get("id") or "P1"})
        num = 0 if seg[0].get("implicit") == "yes" else 1
        for m in seg:
            m.set("number", str(num))
            num += 1
            new_part.append(m)
        ensure_first_measure_attributes(seg[0], snapshots[bounds[k]])
        term, bpm, tempo_src = piece_tempo(seg)
        inject_sound_tempo(seg[0], bpm)

        dc = has_dc(seg)
        # Trust zone: ordinals 1..91 are label-verified + content-anchored (No.41
        # matches the known czerny_599_41 score exactly). The tail's printed labels
        # drift (93,94,95,96,96,97,98) — HOLD those for the engraver's confirmation.
        hold = n >= 92
        name = f"czerny599_{n:02d}.musicxml"
        sub = "excluded_dc" if dc else ("hold_tail" if hold else "")
        dest = (out_dir / sub / name) if sub else (out_dir / name)
        dest.parent.mkdir(exist_ok=True)
        ET.ElementTree(new_root).write(dest, encoding="UTF-8", xml_declaration=True)

        n_meas = len(seg)
        n_notes = len(new_part.findall(".//note"))
        n_fings = len(new_part.findall(".//fingering"))
        sum_measures += n_meas; sum_notes += n_notes; sum_fings += n_fings
        manifest.append({
            "piece": n, "file": str(dest.relative_to(out_dir)), "measures": n_meas,
            "notes": n_notes, "fingerings": n_fings, "tempo_term": term,
            "tempo_bpm": bpm, "tempo_source": tempo_src, "dc_al_fine": dc,
            "hold": hold, "strays_removed": strays,
            "start_index": bounds[k], "label": seg_rows[k]["label"],
            "seg_note": seg_rows[k]["note"],
            "preceded_by_final": seg_rows[k]["preceded_by_final"],
        })

    conservation = {
        "measures": (sum_measures, len(measures)),
        "notes": (sum_notes, total_notes),
        "fingerings": (sum_fings, total_fings),
    }
    ok = all(a == b for a, b in conservation.values())
    json.dump({"pieces": manifest, "conservation": conservation, "conserved": ok},
              open(out_dir / "manifest.json", "w"), indent=1, ensure_ascii=False)
    return manifest, conservation, ok


def main():
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    manifest, conservation, ok = split(src, out_dir)
    print(f"pieces: {len(manifest)}")
    for key, (got, want) in conservation.items():
        print(f"conservation {key}: {got}/{want} {'OK' if got == want else 'MISMATCH'}")
    dc = [p["piece"] for p in manifest if p["dc_al_fine"]]
    print("D.C. pieces (excluded_dc/):", dc)
    flagged = [p for p in manifest if p["seg_note"]]
    print("segmentation flags:", len(flagged))
    for p in flagged:
        print("  piece", p["piece"], "->", p["seg_note"])
    defaults = [p["piece"] for p in manifest if p["tempo_source"] == "default"]
    print("tempo from uncalibrated defaults:", defaults)
    if not ok:
        raise SystemExit("CONSERVATION FAILED")


if __name__ == "__main__":
    main()
