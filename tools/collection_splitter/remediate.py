#!/usr/bin/env python3
"""Re-run pieces whose rendering or metadata changed after they were already
submitted: reopen the job (back to draft), re-apply metadata, resubmit so every
gate runs against the current worker.

Usage: remediate.py <out_dir> --slugs a,b,c [--retitle-works] [--dry-run]
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--slugs", required=True)
    ap.add_argument("--retitle-works", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    want = [s.strip() for s in args.slugs.split(",") if s.strip()]
    plan = {p["slug"]: p for p in json.load(open(args.out_dir / "plan.json"))["pieces"]}
    state = json.loads((args.out_dir / "upload_state.json").read_text())
    book_ids = json.loads((HERE / "book_ids.json").read_text())

    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token(interactive_ok=False)}"

    works = {}
    raw = s.get(f"{API}/admin/works", timeout=60).json()
    for w in (raw if isinstance(raw, list) else raw.get("items", [])):
        works[w["title"]] = w

    if args.retitle_works:
        # A work row keeps its id; only the display title changes.
        wanted = {p["work_title"]: p for p in plan.values() if p.get("work_title")}
        for title, p in wanted.items():
            if title in works:
                continue
            old = next((w for w in works.values()
                        if w.get("catalogue") == p.get("work_catalogue")
                        and w.get("composer") == p["composer"]), None)
            if not old:
                print(f"  ? no work to retitle for {title}")
                continue
            if args.dry_run:
                print(f"  ~ work {old['id']}: {old['title']!r} -> {title!r}")
                continue
            r = s.patch(f"{API}/admin/works/{old['id']}",
                        json={"title": title, "composer": p["composer"],
                              "catalogue": p.get("work_catalogue"),
                              "workType": p.get("work_type", "other"),
                              "movementCount": p.get("work_movements") or 1},
                        timeout=60)
            print(f"  ~ work {old['id']} -> {title!r}: {r.status_code}"
                  f"{'' if r.status_code == 200 else ' ' + r.text[:140]}")
            if r.status_code == 200:
                works[title] = r.json()

    for slug in want:
        p = plan.get(slug)
        job = (state.get(slug) or {}).get("jobId")
        if not p or not job:
            print(f"  !! {slug}: no job on record")
            continue
        if args.dry_run:
            print(f"  {slug}: would reopen {job[:8]} and resubmit")
            continue

        r = s.post(f"{API}/admin/studio/jobs/{job}/reopen", timeout=60)
        if r.status_code not in (200, 202):
            print(f"  {slug}: reopen FAILED {r.status_code} {r.text[:150]}", flush=True)
            continue

        work_id = (works.get(p["work_title"]) or {}).get("id") if p.get("work_title") else None
        book_id = book_ids.get(p["book"]) if p.get("book") else None
        meta = {
            "title": p["title"], "composer": p["composer"], "subtitle": p["subtitle"],
            "mode": "solo", "difficulty": None, "tracking": "experimental",
            "rights": "public_domain", "rightsNote": RIGHTS_NOTE,
            "instrument": "piano", "soloPart": None,
            "work": {"id": work_id, "index": p.get("work_index")} if work_id else None,
            "book": {"id": book_id, "index": p.get("book_index")} if book_id else None,
        }
        r = s.patch(f"{API}/admin/studio/jobs/{job}/metadata", json=meta, timeout=60)
        if r.status_code not in (200, 204):
            print(f"  {slug}: metadata FAILED {r.status_code} {r.text[:150]}", flush=True)
            continue

        cs = None
        for _ in range(80):
            d = s.get(f"{API}/admin/studio/jobs/{job}", timeout=60).json()
            cs = d.get("checkStatus")
            if cs in ("pass", "fail"):
                break
            time.sleep(3)
        if cs != "pass":
            print(f"  {slug}: preflight {cs} — NOT resubmitted", flush=True)
            continue
        r = s.post(f"{API}/admin/studio/jobs/{job}/submit", timeout=60)
        print(f"  {slug}: resubmitted "
              f"{'ok' if r.status_code in (200, 202) else f'FAILED {r.status_code} {r.text[:140]}'}",
              flush=True)


if __name__ == "__main__":
    main()
