#!/usr/bin/env python3
"""Upload the split library through the normal studio flow: create works, then per
piece draft -> metadata -> preflight -> submit. Every job lands in review; nothing
publishes here. Resumable via upload_state.json.

Usage: library_upload.py <out_dir> [--only slug,slug] [--submit] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from admin_auth import token  # noqa: E402
from library_plan import RIGHTS_NOTE  # noqa: E402

API = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"


def ensure_works(s: requests.Session, pieces: list[dict], dry: bool) -> dict[str, str]:
    """One work row per (work_title, catalogue); returns work_title -> work id."""
    want: dict[str, dict] = {}
    for p in pieces:
        if not p.get("work_title"):
            continue
        want.setdefault(p["work_title"], {
            "title": p["work_title"], "composer": p["composer"],
            "catalogue": p.get("work_catalogue"),
            "workType": p.get("work_type", "other"),
            "movementCount": p.get("work_movements") or 1,
        })
    raw = s.get(f"{API}/admin/works", timeout=60).json()
    rows = raw if isinstance(raw, list) else raw.get("items", [])
    have = {w["title"]: w["id"] for w in rows if isinstance(w, dict)}
    out = {}
    for title, body in want.items():
        if title in have:
            out[title] = have[title]
            continue
        if dry:
            print(f"  + work (would create): {title}")
            continue
        r = s.post(f"{API}/admin/works", json=body, timeout=60)
        if r.status_code in (200, 201):
            out[title] = r.json()["id"]
            print(f"  + work {out[title]}: {title}")
        else:
            print(f"  !! work failed {r.status_code} {r.text[:160]} :: {title}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--only", default=None)
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    out = args.out_dir
    plan = json.load(open(out / "plan.json"))["pieces"]
    gates = {g["slug"]: g for g in json.load(open(out / "gates_report.json"))}
    book_ids = {}
    bid_file = HERE / "book_ids.json"
    if bid_file.exists():
        book_ids = json.loads(bid_file.read_text())

    live = [p for p in plan
            if not p["held"] and gates.get(p["slug"], {}).get("verdict") == "PASS"]
    if args.only:
        keep = set(args.only.split(","))
        live = [p for p in live if p["slug"] in keep]

    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token(interactive_ok=False)}"

    print(f"works needed for {sum(1 for p in live if p.get('work_title'))} pieces")
    works = ensure_works(s, live, args.dry_run)

    state_path = out / "upload_state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    print(f"\nuploading {len(live)} pieces")

    for p in live:
        slug = p["slug"]
        if state.get(slug, {}).get("submitted"):
            continue
        book = p.get("book")
        book_id = book_ids.get(book) if book else None
        if book and not book_id:
            print(f"  !! {slug}: book {book!r} has no id yet — run books_and_covers.py first")
            continue
        work_id = works.get(p["work_title"]) if p.get("work_title") else None
        meta = {
            "title": p["title"], "composer": p["composer"], "subtitle": p["subtitle"],
            "mode": "solo", "difficulty": None, "tracking": "experimental",
            "rights": "public_domain", "rightsNote": RIGHTS_NOTE,
            "instrument": "piano", "soloPart": None,
            "work": {"id": work_id, "index": p.get("work_index")} if work_id else None,
            "book": {"id": book_id, "index": p.get("book_index")} if book_id else None,
        }
        if args.dry_run:
            print(f"  {slug}: {json.dumps(meta, ensure_ascii=False)[:190]}")
            continue

        if slug not in state:
            xml = out / p["file"]
            mid = xml.with_suffix(".mid")
            with open(xml, "rb") as fx, open(mid, "rb") as fm:
                r = s.post(f"{API}/admin/studio/drafts",
                           files={"musicxml": (xml.name, fx, "application/xml"),
                                  "midi": (mid.name, fm, "audio/midi")},
                           data={"instrument": "piano"}, timeout=180)
            if r.status_code != 201:
                print(f"  {slug}: draft FAILED {r.status_code} {r.text[:180]}", flush=True)
                continue
            state[slug] = {"jobId": r.json()["id"]}
            state_path.write_text(json.dumps(state, indent=1))
            r = s.patch(f"{API}/admin/studio/jobs/{state[slug]['jobId']}/metadata",
                        json=meta, timeout=60)
            if r.status_code not in (200, 204):
                print(f"  {slug}: metadata FAILED {r.status_code} {r.text[:180]}", flush=True)
                continue
            state[slug]["metadata"] = True
            state_path.write_text(json.dumps(state, indent=1))
            print(f"  {slug}: draft {state[slug]['jobId'][:8]} + metadata ok", flush=True)

        if not args.submit:
            continue
        job_id = state[slug]["jobId"]
        cs = None
        for _ in range(80):
            r = s.get(f"{API}/admin/studio/jobs/{job_id}", timeout=60)
            if r.status_code == 200:
                cs = r.json().get("checkStatus")
                if cs in ("pass", "fail"):
                    break
            time.sleep(3)
        if cs != "pass":
            print(f"  {slug}: preflight {cs} — NOT submitted", flush=True)
            state[slug]["preflight"] = cs
            state_path.write_text(json.dumps(state, indent=1))
            continue
        r = s.post(f"{API}/admin/studio/jobs/{job_id}/submit", timeout=60)
        state[slug]["preflight"] = "pass"
        state[slug]["submitted"] = r.status_code in (200, 202)
        state_path.write_text(json.dumps(state, indent=1))
        print(f"  {slug}: submit "
              f"{'ok' if state[slug]['submitted'] else f'FAILED {r.status_code} {r.text[:150]}'}",
              flush=True)

    done = sum(1 for v in state.values() if v.get("submitted"))
    print(f"\nsubmitted {done}; state -> {state_path}")


if __name__ == "__main__":
    main()
