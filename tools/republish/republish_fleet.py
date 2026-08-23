#!/usr/bin/env python3
"""Republish every published piece from its own staged sources, through the full pipeline.

Built for the layout change: the render config moved to the engraver's own line breaks, and a piece
only picks that up when it is built again. The sources never left piece-sources/staging/<jobId>/, so
nothing needs re-exporting.

Order of operations is load-bearing: run `backfill:slot-versions --write` BEFORE this, or
already-sent notes on slots 1..5 fail their version check silently instead of loudly.

Usage:
  python3 republish_fleet.py --plan                 # who would be rebuilt, from which job
  python3 republish_fleet.py --run --only <id,...>  # pilot on named pieces
  python3 republish_fleet.py --run                  # the fleet, serially, state in fleet_state.json
"""
import argparse, json, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collection_splitter"))
import requests
from admin_auth import token

API = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"
STATE = Path(__file__).resolve().parent / "fleet_state.json"
SKIP = {"burgmuller_candeur_6_2mm", "burgmuller_candeur_7_0mm"}  # born on the new layout


def session():
    s = requests.Session()
    s.headers["Authorization"] = "Bearer " + token()
    return s


def latest_published_jobs(s):
    r = s.get(f"{API}/admin/studio/jobs", params={"status": "published", "limit": 1000}, timeout=120)
    r.raise_for_status()
    by_piece = {}
    for j in r.json()["items"]:  # newest first
        by_piece.setdefault(j["pieceId"], j["id"])
    return by_piece


def plan(s):
    pieces = s.get(f"{API}/admin/pieces", timeout=120).json()
    rows = pieces if isinstance(pieces, list) else pieces.get("pieces") or pieces.get("items")
    published = [p["id"] for p in rows if p.get("status") == "published" and p["id"] not in SKIP]
    jobs = latest_published_jobs(s)
    todo = [(pid, jobs[pid]) for pid in published if pid in jobs]
    missing = [pid for pid in published if pid not in jobs]
    return todo, missing


def sources_of(s, job_id):
    d = s.get(f"{API}/admin/studio/jobs/{job_id}", timeout=120).json()
    srcs = {x["kind"]: x for x in (d.get("sources") or [])}
    return srcs.get("musicxml"), srcs.get("midi"), d


_KEY = None


def storage_key():
    global _KEY
    if _KEY is None:
        _KEY = subprocess.run(
            ["az", "storage", "account", "keys", "list", "-n", "stkaraoappdev",
             "-g", "rg-karaorchee-app-dev", "--query", "[0].value", "-o", "tsv"],
            capture_output=True, text=True, check=True).stdout.strip()
    return _KEY


def fetch(entry):
    # The detail serves paths, never urls — staged sources are pulled straight from the container.
    out = subprocess.run(
        ["az", "storage", "blob", "download", "--account-name", "stkaraoappdev",
         "--account-key", storage_key(), "--container-name", "piece-sources",
         "--name", entry["path"], "--file", "/dev/stdout", "--no-progress", "--only-show-errors"],
        capture_output=True, check=True)
    if not out.stdout:
        raise RuntimeError(f"empty download for {entry['path']}")
    return out.stdout


def save(state):
    STATE.write_text(json.dumps(state, indent=1))


def republish_one(s, piece_id, job_id, state):
    rec = state.setdefault(piece_id, {})
    if rec.get("published"):
        return "done"
    if "newJobId" not in rec:
        xml_e, mid_e, _ = sources_of(s, job_id)
        if not xml_e or not mid_e:
            rec["error"] = "sources_missing"
            save(state)
            return "sources_missing"
        xml, mid = fetch(xml_e), fetch(mid_e)
        r = s.post(f"{API}/admin/studio/drafts", params={"piece": piece_id},
                   files={"musicxml": (xml_e.get("originalName") or "score.musicxml", xml, "application/xml"),
                          "midi": (mid_e.get("originalName") or "score.mid", mid, "audio/midi")},
                   data={"instrument": "piano"}, timeout=300)
        if r.status_code == 409:
            rec["error"] = f"open_draft:{r.json().get('jobId', '')[:8]}"
            save(state)
            return "open_draft"
        if r.status_code != 201:
            rec["error"] = f"draft:{r.status_code}:{r.text[:120]}"
            save(state)
            return "draft_failed"
        rec["newJobId"] = r.json()["id"]
        rec.pop("error", None)
        save(state)
    new_job = rec["newJobId"]
    cs = None
    for _ in range(100):
        d = s.get(f"{API}/admin/studio/jobs/{new_job}", timeout=60).json()
        cs = d.get("checkStatus")
        if cs in ("pass", "fail"):
            break
        time.sleep(3)
    if cs != "pass":
        rec["error"] = f"preflight:{cs}:{str(d.get('error'))[:150]}"
        save(state)
        return "preflight_failed"
    if not rec.get("submitted"):
        r = s.post(f"{API}/admin/studio/jobs/{new_job}/submit", timeout=60)
        if r.status_code not in (200, 202):
            rec["error"] = f"submit:{r.status_code}"
            save(state)
            return "submit_failed"
        rec["submitted"] = True
        save(state)
    for _ in range(200):
        d = s.get(f"{API}/admin/studio/jobs/{new_job}", timeout=60).json()
        if d.get("status") in ("ready_for_review", "failed"):
            break
        time.sleep(6)
    if d.get("status") != "ready_for_review":
        rec["error"] = f"pipeline:{d.get('failureCode')}:{str(d.get('error'))[:150]}"
        save(state)
        return "pipeline_failed"
    r = s.post(f"{API}/admin/studio/jobs/{new_job}/publish", timeout=120)
    if r.status_code != 200:
        rec["error"] = f"publish:{r.status_code}:{r.text[:120]}"
        save(state)
        return "publish_failed"
    rec["published"] = True
    rec["version"] = r.json().get("publishedVersion")
    rec.pop("error", None)
    save(state)
    return "published"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--only", type=str, default=None)
    args = ap.parse_args()
    s = session()
    todo, missing = plan(s)
    if args.only:
        keep = set(args.only.split(","))
        todo = [(p, j) for p, j in todo if p in keep]
    print(f"{len(todo)} piece(s) to rebuild; {len(missing)} with no findable published job")
    for pid in missing[:10]:
        print(f"  NO JOB: {pid}")
    if not args.run:
        return
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    counts = {}
    for i, (pid, job) in enumerate(todo, 1):
        s.headers["Authorization"] = "Bearer " + token()
        outcome = republish_one(s, pid, job, state)
        counts[outcome] = counts.get(outcome, 0) + 1
        print(f"[{i}/{len(todo)}] {pid}: {outcome}", flush=True)
    print("\nsummary:", json.dumps(counts))


if __name__ == "__main__":
    main()
