#!/usr/bin/env python3
"""Batch-upload split collection pieces through the normal studio flow: draft ->
metadata prefill -> wait for preflight pass -> submit. Every job lands in the
review queue exactly like a hand upload — nothing skips the human approve step.

Auth: ADMIN_TOKEN env var (a signed-in admin's bearer token), or --device-code to
acquire one interactively via the CIAM public client.

Resumable: state.json in the split dir records jobId per piece; re-runs skip
pieces that already have a live job.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

API = "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io"
BOOK_ID = "czerny_op599"          # default; override with --book-id ('' = no book)
TITLE = "Practical Method for Beginners, Op. 599"
COMPOSER = "Carl Czerny"
RIGHTS_NOTE = "Engraved by KaraOrchee, Inc."

CIAM_AUTHORITY = "https://karaorcheeauth.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b"
PUBLIC_CLIENT = "4a12e0a8-c0b8-4770-a182-0f02626c7dc5"  # iOS app reg (public client)
SCOPE = ["api://4a12e0a8-c0b8-4770-a182-0f02626c7dc5/access_as_user"]


def acquire_token_device_code() -> str:
    import msal
    app = msal.PublicClientApplication(PUBLIC_CLIENT, authority=CIAM_AUTHORITY)
    flow = app.initiate_device_flow(scopes=SCOPE)
    if "user_code" not in flow:
        raise SystemExit(f"device flow failed: {json.dumps(flow)[:400]}")
    print(flow["message"], flush=True)  # tells the admin where to enter the code
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise SystemExit(f"auth failed: {result.get('error_description', result)[:400]}")
    return result["access_token"]


def wave1(split_dir: Path, skip: set[int]) -> list[dict]:
    man = json.load(open(split_dir / "manifest.json"))["pieces"]
    gates = {g["piece"]: g for g in json.load(open(split_dir / "gates_report.json"))}
    out = []
    for p in man:
        if p["hold"] or p["dc_al_fine"] or p["piece"] in skip:
            continue
        g = gates.get(Path(p["file"]).stem)
        if not g or g["verdict"] != "PASS":
            continue
        out.append(p)
    return out


def run(split_dir: Path, token: str, only: list[int] | None, submit: bool,
        cfg: dict | None = None):
    cfg = cfg or {}
    title = cfg.get("title", TITLE)
    composer = cfg.get("composer", COMPOSER)
    book_id = cfg.get("book_id", BOOK_ID)
    if book_id:
        # A typo'd book id used to mint a silent coverless book at publish; the server
        # now 409s it — fail the whole run up front instead of 79 pieces in.
        rb = s.get(f"{API}/admin/books/{book_id}", timeout=30)
        if rb.status_code != 200:
            raise SystemExit(f"book id '{book_id}' not found on the server (HTTP {rb.status_code}) — create the book in admin first")
    skip = set(cfg.get("skip", [41] if book_id == "czerny_op599" else []))
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token}"
    state_path = split_dir / "upload_state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    pieces = wave1(split_dir, skip)
    if only:
        pieces = [p for p in pieces if p["piece"] in only]
    print(f"uploading {len(pieces)} pieces", flush=True)

    for p in pieces:
        n = p["piece"]
        key = str(n)
        if key in state and state[key].get("submitted"):
            continue
        xml = split_dir / p["file"]
        mid = xml.with_suffix(".mid")
        if key not in state:
            with open(xml, "rb") as fx, open(mid, "rb") as fm:
                r = s.post(f"{API}/admin/studio/drafts",
                           files={"musicxml": (xml.name, fx, "application/xml"),
                                  "midi": (mid.name, fm, "audio/midi")},
                           data={"instrument": "piano"}, timeout=120)
            if r.status_code != 201:
                print(f"  piece {n}: draft FAILED {r.status_code} {r.text[:200]}", flush=True)
                continue
            job = r.json()
            state[key] = {"jobId": job["id"]}
            state_path.write_text(json.dumps(state, indent=1))
            meta = {
                "title": title, "composer": composer, "subtitle": f"No. {n}",
                "mode": "solo", "difficulty": None, "tracking": "experimental",
                "rights": "public_domain", "rightsNote": RIGHTS_NOTE,
                "instrument": "piano", "soloPart": None,
                "work": None,
                "book": {"id": book_id, "index": n} if book_id else None,
            }
            r = s.patch(f"{API}/admin/studio/jobs/{state[key]['jobId']}/metadata",
                        json=meta, timeout=60)
            if r.status_code not in (200, 204):
                print(f"  piece {n}: metadata FAILED {r.status_code} {r.text[:200]}", flush=True)
                continue
            state[key]["metadata"] = True
            state_path.write_text(json.dumps(state, indent=1))
            print(f"  piece {n}: draft {state[key]['jobId'][:8]} + metadata ok", flush=True)

        if not submit:
            continue
        job_id = state[key]["jobId"]
        # wait for preflight verdict
        for _ in range(60):
            r = s.get(f"{API}/admin/studio/jobs/{job_id}", timeout=60)
            if r.status_code != 200:
                time.sleep(3); continue
            cs = r.json().get("checkStatus")
            if cs in ("pass", "fail"):
                break
            time.sleep(3)
        if cs != "pass":
            print(f"  piece {n}: preflight {cs} — NOT submitted", flush=True)
            state[key]["preflight"] = cs
            state_path.write_text(json.dumps(state, indent=1))
            continue
        r = s.post(f"{API}/admin/studio/jobs/{job_id}/submit", timeout=60)
        ok = r.status_code in (200, 202)
        state[key]["preflight"] = "pass"
        state[key]["submitted"] = ok
        state_path.write_text(json.dumps(state, indent=1))
        print(f"  piece {n}: submit {'ok' if ok else f'FAILED {r.status_code} {r.text[:160]}'}",
              flush=True)

    done = sum(1 for v in state.values() if v.get("submitted"))
    print(f"\nsubmitted: {done}; state -> {state_path}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("split_dir", type=Path)
    ap.add_argument("--token", default=None)
    ap.add_argument("--device-code", action="store_true")
    ap.add_argument("--only", type=lambda s: [int(x) for x in s.split(",")], default=None)
    ap.add_argument("--submit", action="store_true",
                    help="also wait for preflight and submit (default: draft+metadata only)")
    ap.add_argument("--title", default=None)
    ap.add_argument("--composer", default=None)
    ap.add_argument("--book-id", default=None, help="'' = no book membership")
    ap.add_argument("--skip", type=lambda s: [int(x) for x in s.split(",")], default=None)
    args = ap.parse_args()
    import os
    token = args.token or os.environ.get("ADMIN_TOKEN")
    if not token:
        tf = Path.home() / ".karaorchee_admin_token"
        if tf.exists():
            token = tf.read_text().strip()
    if not token and args.device_code:
        token = acquire_token_device_code()
    if not token:
        raise SystemExit("need --token / ADMIN_TOKEN / --device-code")
    cfg = {}
    if args.title is not None: cfg["title"] = args.title
    if args.composer is not None: cfg["composer"] = args.composer
    if args.book_id is not None: cfg["book_id"] = args.book_id
    if args.skip is not None: cfg["skip"] = args.skip
    run(args.split_dir, token, args.only, args.submit, cfg)


if __name__ == "__main__":
    main()
