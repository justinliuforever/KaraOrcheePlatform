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
import argparse, json, subprocess, sys, tempfile, time
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
    best = {}
    for j in r.json()["items"]:
        # By publishedVersion, not list order: updatedAt moves on any touch to an old row, and a
        # touched old job would republish stale sources.
        v = j.get("publishedVersion") or 0
        if j["pieceId"] not in best or v > best[j["pieceId"]][0]:
            best[j["pieceId"]] = (v, j["id"])
    return {pid: jid for pid, (v, jid) in best.items()}


def open_drafts(s):
    out = {}
    for status in ("draft", "queued", "running", "ready_for_review"):
        r = s.get(f"{API}/admin/studio/jobs", params={"status": status, "limit": 1000}, timeout=120)
        if r.status_code != 200:
            continue
        for j in r.json()["items"]:
            out.setdefault(j["pieceId"], (j["id"], status))
    return out


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
    # Audio TOO: a musicxml+midi-only redraft passes every gate and silently strips the published
    # bundle's reference recording and audio map — tier-2 audio destroyed with all lights green.
    return srcs.get("musicxml"), srcs.get("midi"), srcs.get("audio"), d


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
    with tempfile.NamedTemporaryFile(suffix=Path(entry["path"]).suffix) as tmp:
        subprocess.run(
            ["az", "storage", "blob", "download", "--account-name", "stkaraoappdev",
             "--account-key", storage_key(), "--container-name", "piece-sources",
             "--name", entry["path"], "--file", tmp.name, "--overwrite", "--only-show-errors"],
            capture_output=True, check=True)
        data = Path(tmp.name).read_bytes()
    if not data:
        raise RuntimeError(f"empty download for {entry['path']}")
    return data


def save(state):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE)


def reconcile(s, rec):
    """The server's word beats the state file: a crash between an action and its save leaves the
    file behind reality, and replaying the action then wedges on 409 or double-submits."""
    job = rec.get("newJobId")
    if not job:
        return
    d = s.get(f"{API}/admin/studio/jobs/{job}", timeout=60).json()
    status = d.get("status")
    if status == "published":
        rec["published"] = True
        rec["version"] = d.get("publishedVersion")
    elif status in ("queued", "running", "ready_for_review"):
        rec["submitted"] = True


def republish_one(s, piece_id, job_id, state):
    rec = state.setdefault(piece_id, {})
    reconcile(s, rec)
    if rec.get("published"):
        save(state)
        return "done"
    if "newJobId" not in rec:
        xml_e, mid_e, aud_e, _ = sources_of(s, job_id)
        if not xml_e or not mid_e:
            rec["error"] = "sources_missing"
            save(state)
            return "sources_missing"
        files = {"musicxml": (xml_e.get("originalName") or "score.musicxml", fetch(xml_e), "application/xml"),
                 "midi": (mid_e.get("originalName") or "score.mid", fetch(mid_e), "audio/midi")}
        if aud_e:
            files["audio"] = (aud_e.get("originalName") or "reference.m4a", fetch(aud_e), "audio/mp4")
        r = s.post(f"{API}/admin/studio/drafts", params={"piece": piece_id},
                   files=files, data={"instrument": "piano"}, timeout=600)
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
    if r.status_code == 409:
        # stale_registry means a human edited the Library row mid-window — terminal for this tool;
        # retrying the same publish forever can never succeed.
        rec["error"] = f"publish_409_manual:{r.text[:120]}"
        save(state)
        return "publish_409_manual"
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
    blockers = open_drafts(s)
    blocked = [(p, blockers[p]) for p, _ in todo if p in blockers]
    print(f"{len(todo)} piece(s) to rebuild; {len(missing)} with no findable published job; "
          f"{len(blocked)} blocked by an open draft")
    for pid in missing[:10]:
        print(f"  NO JOB: {pid}")
    for pid, (jid, st) in blocked[:20]:
        print(f"  OPEN DRAFT: {pid} ({st} {jid[:8]}) — close or publish it first")
    if not args.run:
        return
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    counts = {}
    for i, (pid, job) in enumerate(todo, 1):
        s.headers["Authorization"] = "Bearer " + token()
        try:
            outcome = republish_one(s, pid, job, state)
        except Exception as err:  # one transient failure must not kill an hours-long run
            state.setdefault(pid, {})["error"] = f"exception:{type(err).__name__}:{str(err)[:150]}"
            save(state)
            outcome = "exception"
        counts[outcome] = counts.get(outcome, 0) + 1
        print(f"[{i}/{len(todo)}] {pid}: {outcome}", flush=True)
    print("\nsummary:", json.dumps(counts))


if __name__ == "__main__":
    main()
