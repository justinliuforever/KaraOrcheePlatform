"""Pieces Studio worker — two lanes over the same gate code.

  pieces-preflight  (spawned thread): sanity+alignment+geometry on a fresh upload,
                    streamed into studio_jobs.check_status/gates while the admin is
                    still filling the wizard. Never touches playwright.
  pieces-jobs       (main thread): the full 4-gate run on submit — re-verifies the
                    fast gates (deliberate redundancy) and adds the slow headless-
                    WebKit render gate. Playwright sync API stays on this thread.

The studio_jobs row is the source of truth for job state; queue messages are only
triggers, so crashed runs that redeliver are re-processed idempotently.
"""
from __future__ import annotations
import hashlib
import json
import os
import sys
import tempfile
import threading
import traceback
from pathlib import Path

import psycopg
from azure.servicebus import AutoLockRenewer, ServiceBusClient
from azure.storage.blob import BlobServiceClient, ContentSettings

from gates import run_all, GateError, ARTIFACT_LAYOUT

FULL_QUEUE = "pieces-jobs"
PREFLIGHT_QUEUE = "pieces-preflight"
SOURCES_CONTAINER = "piece-sources"
BUNDLES_CONTAINER = "piece-bundles"

CONTENT_TYPES = {".json": "application/json", ".svg": "image/svg+xml", ".mei": "application/xml"}


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"fatal: {name} is required", file=sys.stderr)
        sys.exit(1)
    return v


def fetch_job(conn, job_id: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, piece_id, status, check_status, sources, metadata FROM studio_jobs WHERE id = %s",
            (job_id,))
        return cur.fetchone()


_SF2_CACHE = Path("/tmp/sf2cache")


def get_soundfont(blob: BlobServiceClient, instrument: str | None) -> tuple[Path | None, int]:
    """Download (once) the SF2 for this instrument from the soundfont container."""
    from pipeline.preview import soundfont_for

    blob_name, program, _ = soundfont_for(instrument)
    _SF2_CACHE.mkdir(exist_ok=True)
    local = _SF2_CACHE / blob_name
    if not local.exists():
        try:
            data = blob.get_container_client("soundfont").download_blob(blob_name).readall()
            local.write_bytes(data)
        except Exception:
            traceback.print_exc()
            return None, program
    return local, program


def update_job(conn, job_id: str, **cols) -> None:
    sets = ", ".join(f"{k} = %s" for k in cols) + ", updated_at = now()"
    with conn.cursor() as cur:
        cur.execute(f"UPDATE studio_jobs SET {sets} WHERE id = %s", (*cols.values(), job_id))
    conn.commit()


def merge_gate(conn, job_id: str, stage: str, entry: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE studio_jobs SET gates = gates || %s::jsonb, stage = %s, updated_at = now() WHERE id = %s",
            (json.dumps({stage: entry}), stage, job_id))
    conn.commit()


def stage_artifacts(blob: BlobServiceClient, job_id: str, piece: str, out_dir: Path) -> list[dict]:
    bundle_client = blob.get_container_client(BUNDLES_CONTAINER)
    artifacts = []
    for local_tmpl, blob_name, role, variant in ARTIFACT_LAYOUT:
        local = out_dir / local_tmpl.format(p=piece)
        if not local.exists():
            continue
        data = local.read_bytes()
        path = f"staging/{job_id}/{blob_name}"
        bundle_client.get_blob_client(path).upload_blob(
            data, overwrite=True,
            content_settings=ContentSettings(
                content_type=CONTENT_TYPES.get(local.suffix, "application/octet-stream")))
        entry = {"role": role, "path": path, "bytes": len(data),
                 "sha256": hashlib.sha256(data).hexdigest()}
        if variant:
            entry["variant"] = variant
        artifacts.append(entry)
    return artifacts


def process(conn, blob: BlobServiceClient, job_id: str, mode: str) -> None:
    row = fetch_job(conn, job_id)
    if row is None:
        print(f"{job_id}: no such job, dropping")
        return
    _, piece, status, check_status, sources, metadata = row
    metadata = metadata or {}
    if mode == "preflight":
        if status != "draft":
            print(f"{job_id}: preflight skipped (status={status})")
            return
        update_job(conn, job_id, check_status="running", stage=None, error=None)
    else:
        if status not in ("queued", "running"):
            print(f"{job_id}: full run skipped (status={status}, idempotent)")
            return
        update_job(conn, job_id, status="running", stage="sanity", error=None)

    with tempfile.TemporaryDirectory(prefix=f"job-{job_id[:8]}-") as tmp:
        tmpdir = Path(tmp)
        xml_path = midi_path = audio_path = None
        src_client = blob.get_container_client(SOURCES_CONTAINER)
        for srcf in sources:
            local = tmpdir / Path(srcf["path"]).name
            local.write_bytes(src_client.download_blob(srcf["path"]).readall())
            if srcf["kind"] == "musicxml":
                xml_path = local
            elif srcf["kind"] == "midi":
                midi_path = local
            elif srcf["kind"] == "audio":
                audio_path = local
        if xml_path is None:
            if mode == "preflight":
                update_job(conn, job_id, check_status="fail", error="job has no musicxml source")
            else:
                update_job(conn, job_id, status="failed", error="job has no musicxml source")
            return

        out_dir = tmpdir / "out"
        out_dir.mkdir()

        def on_gate(stage: str, gstatus: str, metrics: dict, error: str | None) -> None:
            entry = {"status": gstatus, "metrics": metrics}
            if error:
                entry["error"] = error
            merge_gate(conn, job_id, stage, entry)
            print(f"{job_id}[{mode}]: {stage} -> {gstatus} {json.dumps(metrics)[:200]}")

        sf2_path, program = get_soundfont(blob, metadata.get("instrument"))
        try:
            run_all(job_id, piece, xml_path, midi_path, out_dir, on_gate,
                    include_render=(mode == "full"),
                    solo_part=metadata.get("soloPart"),
                    audio_path=audio_path,
                    sf2_path=sf2_path, program=program)
        except GateError as err:
            if mode == "preflight":
                update_job(conn, job_id, check_status="fail", error=str(err))
            else:
                update_job(conn, job_id, status="failed", error=str(err))
            return

        artifacts = stage_artifacts(blob, job_id, piece, out_dir)
        if mode == "preflight":
            # Engraving is already previewable in the wizard's review step; the full
            # run after submit re-verifies and re-stages everything.
            update_job(conn, job_id, check_status="pass", stage=None,
                       artifacts=json.dumps(artifacts))
            print(f"{job_id}: preflight pass ({len(artifacts)} artifacts staged)")
        else:
            update_job(conn, job_id, status="ready_for_review", stage=None,
                       artifacts=json.dumps(artifacts))
            print(f"{job_id}: ready_for_review ({len(artifacts)} artifacts)")


def run_receiver(db_url: str, storage_cs: str, sb_cs: str, queue: str, mode: str) -> None:
    blob = BlobServiceClient.from_connection_string(storage_cs)
    # Long pieces render for minutes — the renewer keeps the message lock alive
    # (battle scar: a 54-min movement's preview outlived the 60s default lock, the
    # complete() threw MessageLockLostError, and a PASSED job got marked failed).
    renewer = AutoLockRenewer(max_lock_renewal_duration=1800)
    print(f"{mode} lane up on {queue}")
    with ServiceBusClient.from_connection_string(sb_cs) as sb:
        receiver = sb.get_queue_receiver(queue, max_wait_time=None, auto_lock_renewer=renewer)
        with receiver:
            for msg in receiver:
                job_id = None
                processed = False
                try:
                    body = json.loads(b"".join(msg.body).decode()
                                      if not isinstance(msg.body, (bytes, str)) else msg.body)
                    job_id = body["jobId"]
                    # Fresh connection per job: gates can run minutes; idle-killed
                    # connections must not poison the next job.
                    with psycopg.connect(db_url) as conn:
                        process(conn, blob, job_id, mode)
                    processed = True
                    receiver.complete_message(msg)
                except Exception:
                    traceback.print_exc()
                    # A settlement failure AFTER successful processing must never
                    # overwrite the job's (correct) terminal state.
                    if job_id and not processed:
                        try:
                            fail_cols = ({"check_status": "fail"} if mode == "preflight"
                                         else {"status": "failed"})
                            with psycopg.connect(db_url) as conn:
                                update_job(conn, job_id, error="worker_crash: see worker logs",
                                           **fail_cols)
                        except Exception:
                            traceback.print_exc()
                    if not processed:
                        try:
                            receiver.complete_message(msg)  # row state is truth; don't redeliver
                        except Exception:
                            traceback.print_exc()


def main() -> None:
    db_url = env("DATABASE_URL")
    storage_cs = env("STORAGE_CONNECTION_STRING")
    sb_cs = env("SERVICEBUS_CONNECTION_STRING")

    preflight = threading.Thread(
        target=run_receiver, args=(db_url, storage_cs, sb_cs, PREFLIGHT_QUEUE, "preflight"),
        daemon=True)
    preflight.start()
    # Full lane owns the main thread: playwright's sync API must not run on a
    # thread that ever hosts an asyncio loop, and this guarantees one render at a time.
    run_receiver(db_url, storage_cs, sb_cs, FULL_QUEUE, "full")


if __name__ == "__main__":
    main()
