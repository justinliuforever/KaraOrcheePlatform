#!/usr/bin/env python3
"""Execute the library plan: cut every piece out of its collection file, apply the
same surgery the Czerny/Hanon batches used (attribute carry-forward, stray edition
labels, implicit-repeat-start normalization, tempo injection), then report.

Usage: library_split.py <dropbox_lib_dir> <out_dir>
"""
from __future__ import annotations

import copy
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from split_collection import (  # noqa: E402
    LABEL_RE, carry_attributes, ensure_first_measure_attributes, fix_start_repeats,
    has_dc, inject_sound_tempo, piece_tempo,
)
from library_plan import all_pieces  # noqa: E402


def load(path: Path):
    root = ET.parse(path).getroot()
    part = root.find("part")
    return root, part, part.findall("measure")


def cut(src_root, src_part, measures, snapshots, start, end):
    seg = [copy.deepcopy(m) for m in measures[start:end]]
    new_root = ET.Element("score-partwise", {"version": src_root.get("version") or "4.0"})
    for child in src_root:
        if child.tag in ("movement-title", "part", "credit"):
            continue
        new_root.append(copy.deepcopy(child))
    new_part = ET.SubElement(new_root, "part", {"id": src_part.get("id") or "P1"})
    num = 0 if seg[0].get("implicit") == "yes" else 1
    for m in seg:
        m.set("number", str(num))
        num += 1
        new_part.append(m)
    ensure_first_measure_attributes(seg[0], snapshots[start])
    strays = 0
    for m in seg[1:]:
        for d in list(m.findall("direction")):
            ws = d.findall(".//words")
            if len(ws) == 1 and ws[0].text and LABEL_RE.fullmatch(ws[0].text.strip()):
                m.remove(d)
                strays += 1
    return new_root, new_part, seg, strays


def main():
    lib = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    (out / "held").mkdir(exist_ok=True)

    cache: dict[str, tuple] = {}
    rows = []
    for p in all_pieces():
        if p["src"] not in cache:
            root, part, measures = load(lib / p["src"])
            cache[p["src"]] = (root, part, measures, carry_attributes(measures))
        root, part, measures, snaps = cache[p["src"]]
        end = p["end"] if p["end"] is not None else len(measures)
        new_root, new_part, seg, strays = cut(root, part, measures, snaps, p["start"], end)

        # Tempo: honour an in-file metronome mark, otherwise inject from the term map.
        has_tempo = any(s.get("tempo") for s in new_root.iter("sound"))
        tempo_src = "in-file"
        if not has_tempo:
            term, bpm, src = piece_tempo(seg)
            inject_sound_tempo(seg[0], bpm)
            tempo_src = f"{src}:{term or 'unmarked'}"
        fixed = fix_start_repeats(seg)

        dest_dir = out / "held" if p["blocked"] else out
        dest = dest_dir / f"{p['slug']}.musicxml"
        ET.ElementTree(new_root).write(dest, encoding="UTF-8", xml_declaration=True)

        rows.append({**p, "file": dest.name, "held": bool(p["blocked"]),
                     "measures": len(seg),
                     "notes": len(new_part.findall(".//note")),
                     "pitched": sum(1 for n in new_part.findall(".//note")
                                    if n.find("pitch") is not None),
                     "fingerings": len(new_part.findall(".//fingering")),
                     "tempo_source": tempo_src, "start_repeats_injected": fixed,
                     "strays_removed": strays, "dc_in_segment": has_dc(seg)})

    # Conservation per source file: every measure must land in exactly one piece
    # (except deliberately dropped tails, which are reported).
    cons = {}
    for srcname, (root, part, measures, _) in cache.items():
        used = sum(r["measures"] for r in rows if r["src"] == srcname)
        cons[srcname] = {"used": used, "total": len(measures),
                         "dropped": len(measures) - used}

    json.dump({"pieces": rows, "conservation": cons},
              open(out / "plan.json", "w"), ensure_ascii=False, indent=1)

    print(f"wrote {len(rows)} pieces ({sum(1 for r in rows if r['held'])} held) -> {out}")
    print("\nconservation (measures used / total, dropped):")
    for k, v in cons.items():
        flag = "" if v["dropped"] == 0 else f"  <-- {v['dropped']} dropped"
        print(f"  {v['used']:5d}/{v['total']:<5d}{flag}  {k}")
    empty = [r for r in rows if r["pitched"] == 0]
    if empty:
        print("\nEMPTY (no pitched notes):", [r["slug"] for r in empty])
    print("\nper collection tempo sources:")
    import collections
    for c in sorted({r["collection"] for r in rows}):
        srcs = collections.Counter(r["tempo_source"].split(":")[0]
                                   for r in rows if r["collection"] == c)
        print(f"  {c}: {dict(srcs)}")


if __name__ == "__main__":
    main()
