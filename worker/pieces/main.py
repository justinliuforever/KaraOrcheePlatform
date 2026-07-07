"""Pieces Studio worker — consumes pieces-jobs, runs the four gates, stages artifacts.

The studio_jobs row is the source of truth for job state; the queue message is only a
trigger. Every terminal path (ready_for_review / failed) is written to Postgres, so a
crashed run that redelivers is re-processed idempotently from the row's status.
"""
from __future__ import annotations
import hashlib
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

import psycopg
from azure.servicebus import ServiceBusClient
from azure.storage.blob import BlobServiceClient, ContentSettings

from gates import run_all, GateError, ARTIFACT_LAYOUT

QUEUE = "pieces-jobs"
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
            "SELECT id, piece_id, status, sources FROM studio_jobs WHERE id = %s", (job_id,))
        return cur.fetchone()


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


def process(conn, blob: BlobServiceClient, job_id: str) -> None:
    row = fetch_job(conn, job_id)
    if row is None:
        print(f"{job_id}: no such job, dropping")
        return
    _, piece, status, sources = row
    if status not in ("queued", "running"):
        print(f"{job_id}: status={status}, skipping (idempotent)")
        return

    update_job(conn, job_id, status="running", stage="sanity", error=None)

    with tempfile.TemporaryDirectory(prefix=f"job-{job_id[:8]}-") as tmp:
        tmpdir = Path(tmp)
        xml_path = midi_path = None
        src_client = blob.get_container_client(SOURCES_CONTAINER)
        for srcf in sources:
            local = tmpdir / Path(srcf["path"]).name
            local.write_bytes(src_client.download_blob(srcf["path"]).readall())
            if srcf["kind"] == "musicxml":
                xml_path = local
            elif srcf["kind"] == "midi":
                midi_path = local
        if xml_path is None:
            update_job(conn, job_id, status="failed", error="job has no musicxml source")
            return

        out_dir = tmpdir / "out"
        out_dir.mkdir()

        def on_gate(stage: str, gstatus: str, metrics: dict, error: str | None) -> None:
            entry = {"status": gstatus, "metrics": metrics}
            if error:
                entry["error"] = error
            merge_gate(conn, job_id, stage, entry)
            print(f"{job_id}: {stage} -> {gstatus} {json.dumps(metrics)[:200]}")

        try:
            run_all(job_id, piece, xml_path, midi_path, out_dir, on_gate)
        except GateError as err:
            update_job(conn, job_id, status="failed", error=str(err))
            return

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

        update_job(conn, job_id, status="ready_for_review", stage=None,
                   artifacts=json.dumps(artifacts))
        print(f"{job_id}: ready_for_review ({len(artifacts)} artifacts)")


def main() -> None:
    db_url = env("DATABASE_URL")
    storage_cs = env("STORAGE_CONNECTION_STRING")
    sb_cs = env("SERVICEBUS_CONNECTION_STRING")

    blob = BlobServiceClient.from_connection_string(storage_cs)
    print("pieces worker up; waiting for jobs")
    with ServiceBusClient.from_connection_string(sb_cs) as sb:
        receiver = sb.get_queue_receiver(QUEUE, max_wait_time=None)
        with receiver:
            for msg in receiver:
                job_id = None
                try:
                    body = json.loads(b"".join(msg.body).decode()
                                      if not isinstance(msg.body, (bytes, str)) else msg.body)
                    job_id = body["jobId"]
                    # Fresh connection per job: gates can run minutes; idle-killed
                    # connections must not poison the next job.
                    with psycopg.connect(db_url) as conn:
                        process(conn, blob, job_id)
                    receiver.complete_message(msg)
                except Exception:
                    traceback.print_exc()
                    try:
                        if job_id:
                            with psycopg.connect(db_url) as conn:
                                update_job(conn, job_id, status="failed",
                                           error="worker_crash: see worker logs")
                    except Exception:
                        traceback.print_exc()
                    receiver.complete_message(msg)  # row state is truth; don't redeliver crashes


if __name__ == "__main__":
    main()
