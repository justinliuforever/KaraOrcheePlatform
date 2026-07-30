#!/usr/bin/env python3
"""Cross-check our repeat expansion against Sibelius's own playback order.

The colleague's KaraOrcheeDiag run emits BarPlaybackOrderString for the WHOLE
collection (1-based bar numbers). For each split piece we count how many played
bars the engine spends inside that piece's measure range and compare it with the
played_measures our structure gate computed. This is the check that caught a
segmentation bug the gates themselves called clean (Hanon, 2026-07-18): three
independent components can agree with each other and still be wrong.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DIAG_FOR = {
    "Clementi/Clementi sonatina No.1.musicxml": "Clementi/Clementi sonatina No.1.sib.karaorchee_diag.txt",
    "Clementi/Clementi sonatina No.2.musicxml": "Clementi/Clementi sonatina No.2.sib.karaorchee_diag.txt",
    "Clementi/Clementi sonatina No.3.musicxml": "Clementi/Clementi sonatina No.3.sib.karaorchee_diag.txt",
    "Clementi/Clementi sonatina No.4.musicxml": "Clementi/Clementi sonatina No.4.sib.karaorchee_diag.txt",
    "Clementi/Clementi sonatina No.5.musicxml": "Clementi/Clementi sonatina No.5.sib.karaorchee_diag.txt",
    "Clementi/Clementi sonatina No.6.musicxml": "Clementi/Clementi sonatina No.6.sib.karaorchee_diag.txt",
    "J.S.Bach/Two-Part Inventions/Bach Inventio 1-15.musicxml":
        "J.S.Bach/Two-Part Inventions/Bach Inventio 1-15.sib.karaorchee_diag.txt",
    "Hanon/The Virtuoso Pianist Part I/The Virtuoso-Pianist Hanon part 1.musicxml":
        "Hanon/The Virtuoso Pianist Part I/The Virtuoso-Pianist Hanon part 1.sib.karaorchee_diag.txt",
    "Mozart/Sonatas/Kv.330/Mozart Piano Sonata Kv.330.musicxml":
        "Mozart/Sonatas/Kv.330/piano-sonata-10-kv-330-mozart.sib.karaorchee_diag.txt",
    "Mozart/Sonatas/Kv.331/Mozart Piano Sonata K.331.musicxml":
        "Mozart/Sonatas/Kv.331/Mozart Piano Sonata K.331.sib.karaorchee_diag.txt",
    "Chopin/19 Waltzes/Op.34/Chopin Three Waltzes Op34.musicxml":
        "Chopin/19 Waltzes/Op.34/Chopin Three Waltzes Op.34.txt",
}


def played_bars(diag_path: Path) -> list[int]:
    raw = diag_path.read_bytes()
    for enc in ("utf-16", "utf-8", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
    m = re.search(r"BarPlaybackOrderString:\s*(.*?)(?:\n\s*===|\Z)", text, re.S)
    if not m:
        return []
    body = re.sub(r"\s+", " ", m.group(1)).strip()
    out: list[int] = []
    for span in (s.strip() for s in body.split(",")):
        if not span:
            continue
        if "-" in span:
            a, b = span.split("-", 1)
            try:
                out.extend(range(int(a), int(b) + 1))
            except ValueError:
                continue
        elif span.isdigit():
            out.append(int(span))
    return out


def raw_spans(diag_path: Path) -> list[tuple[int, int]]:
    raw = diag_path.read_bytes()
    for enc in ("utf-16", "utf-8", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
    m = re.search(r"BarPlaybackOrderString:\s*(.*?)(?:\n\s*===|\Z)", text, re.S)
    if not m:
        return []
    body = re.sub(r"\s+", " ", m.group(1)).strip()
    out = []
    for span in (s.strip() for s in body.split(",")):
        if not span:
            continue
        if "-" in span:
            a, b = span.split("-", 1)
            if a.isdigit() and b.isdigit():
                out.append((int(a), int(b)))
        elif span.isdigit():
            out.append((int(span), int(span)))
    return out


def main():
    lib = Path(sys.argv[1])
    out = Path(sys.argv[2])
    plan = json.load(open(out / "plan.json"))["pieces"]
    gates = {g["slug"]: g for g in json.load(open(out / "gates_report.json"))}

    cache: dict[str, list[tuple[int, int]]] = {}
    rows, mismatches, missing = [], [], []
    for p in plan:
        diag_rel = DIAG_FOR.get(p["src"])
        g = gates.get(p["slug"], {})
        if diag_rel is None or not (lib / diag_rel).exists():
            missing.append(p["slug"])
            continue
        if diag_rel not in cache:
            cache[diag_rel] = raw_spans(lib / diag_rel)
        spans = cache[diag_rel]
        if not spans:
            missing.append(p["slug"])
            continue
        lo = p["start"] + 1                      # diag bars are 1-based
        hi = (p["end"] if p["end"] is not None else p["start"] + p["measures"])
        # A span that starts inside the piece and leaves it (or the reverse) means the
        # engine was playing the COLLECTION, not this piece: a later D.C. re-enters an
        # earlier movement, or a section straddles the printed boundary. Those counts
        # describe whole-file playback and cannot be compared with a standalone split.
        touching = [(a, b) for a, b in spans if a <= hi and b >= lo]
        contained = all(a >= lo and b <= hi for a, b in touching)
        engine = sum(min(b, hi) - max(a, lo) + 1 for a, b in touching)
        st = g.get("structure") or {}
        ours = st.get("played_measures") or st.get("written_measures") or p["measures"]
        row = {"slug": p["slug"], "engine": engine, "ours": ours,
               "comparable": contained, "match": engine == ours,
               "held": p.get("blocked") is not None}
        rows.append(row)
        if contained and engine != ours:
            mismatches.append(row)

    json.dump(rows, open(out / "engine_crosscheck.json", "w"), indent=1)
    live = [r for r in rows if not r["held"]]
    comp = [r for r in live if r["comparable"]]
    print(f"cross-checked {len(rows)} pieces ({len(live)} live)")
    print(f"  engine-comparable: {len(comp)}  -> MATCH {sum(1 for r in comp if r['match'])}/{len(comp)}")
    print(f"  not comparable (engine crossed the piece boundary): {len(live) - len(comp)}")
    if missing:
        print(f"  no engine data for {len(missing)}: {missing[:8]}")
    for r in mismatches:
        print(f"  MISMATCH {r['slug']}: engine {r['engine']} vs ours {r['ours']}")


if __name__ == "__main__":
    main()
