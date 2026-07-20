"""Notes worker — consumes notes-jobs, runs ASR (AssemblyAI) + LLM (claude-sonnet-5)
+ gates, writes the transcript derivative to notes-assets, and inserts the draft
note + annotations for teacher review.

The note_jobs row is the source of truth; queue messages are only triggers, so
redelivered messages re-process idempotently (draft output is wiped and rebuilt).
Raw audio lives in lesson-audio (auto-deleted at 90d); the transcript JSON written
here is the durable derivative that survives it.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
import traceback

import psycopg
import requests
from azure.servicebus import AutoLockRenewer, ServiceBusClient
from azure.storage.blob import (BlobSasPermissions, BlobServiceClient,
                                ContentSettings, generate_blob_sas)

from llm import generate
from pipeline import GateFail, build_turns, check_transcript, extract_json, normalize_note
from prompt import build_system, build_user

QUEUE = "notes-jobs"
AUDIO_CONTAINER = "lesson-audio"
ASSETS_CONTAINER = "notes-assets"
ASR_BASE = "https://api.assemblyai.com/v2"
# Validated 2026-07-03: plural priority list; keyterms/prompt stay OFF (both
# tested and rejected — over-bias, hallucinated numbers).
ASR_MODELS = ["universal-3-5-pro", "universal-2"]


def jlog(**fields) -> None:
    print(json.dumps({"kind": "notes-worker", **fields}), flush=True)


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"fatal: {name} is required", file=sys.stderr)
        sys.exit(1)
    return v


def fetch_job(conn, job_id: str):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT j.id, j.status, j.attempts, l.id, l.teacher_id, l.student_id,
                      l.piece_id, l.piece_label, l.audio_path, l.duration_sec,
                      p.title, p.composer, p.facts
               FROM note_jobs j
               JOIN lesson_sessions l ON l.id = j.lesson_session_id
               LEFT JOIN pieces p ON p.id = l.piece_id
               WHERE j.id = %s""",
            (job_id,))
        return cur.fetchone()


def update_job(conn, job_id: str, **cols) -> None:
    sets = ", ".join(f"{k} = %s" for k in cols) + ", updated_at = now()"
    with conn.cursor() as cur:
        cur.execute(f"UPDATE note_jobs SET {sets} WHERE id = %s", (*cols.values(), job_id))
    conn.commit()


def audio_read_url(storage_cs: str, path: str) -> str:
    parts = dict(kv.split("=", 1) for kv in storage_cs.split(";") if "=" in kv)
    account, key = parts["AccountName"], parts["AccountKey"]
    sas = generate_blob_sas(
        account_name=account, container_name=AUDIO_CONTAINER, blob_name=path,
        account_key=key, permission=BlobSasPermissions(read=True),
        expiry=dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=60))
    return f"https://{account}.blob.core.windows.net/{AUDIO_CONTAINER}/{path}?{sas}"


# A 60-min lesson polls for ~10-20 min; cap well past that so a stuck ASR job
# fails cleanly instead of holding the message lock (3600s) until it expires.
ASR_POLL_INTERVAL = 5
ASR_POLL_MAX = 40 * 60


def _get_with_retry(url: str, headers: dict, attempts: int = 4):
    """Transient network/5xx during a long poll must not discard paid ASR work —
    the transcript id already exists server-side, so re-GET loses nothing."""
    last = None
    for i in range(attempts):
        try:
            r = requests.get(url, headers=headers, timeout=60)
            if r.status_code >= 500:
                r.raise_for_status()
            return r
        except requests.RequestException as err:
            last = err
            time.sleep(min(2 ** i, 15))
    raise last


def run_asr(audio_url: str, api_key: str) -> dict:
    """Presigned-URL handoff (AssemblyAI's documented best practice) — the URL is
    minted immediately before submission so it cannot expire mid-queue."""
    h = {"authorization": api_key}
    sub = None
    for i in range(4):
        try:
            sub = requests.post(f"{ASR_BASE}/transcript", headers=h, timeout=60, json={
                "audio_url": audio_url,
                "speech_models": ASR_MODELS,
                "speaker_labels": True,
            })
            if sub.status_code >= 500:
                sub.raise_for_status()
            break
        except requests.RequestException:
            if i == 3:
                raise
            time.sleep(min(2 ** i, 15))
    sub.raise_for_status()
    tid = sub.json()["id"]
    waited = 0
    while True:
        g = _get_with_retry(f"{ASR_BASE}/transcript/{tid}", h)
        g.raise_for_status()
        j = g.json()
        if j["status"] == "completed":
            return j
        if j["status"] == "error":
            raise RuntimeError(j.get("error", "assemblyai error"))
        if waited >= ASR_POLL_MAX:
            raise RuntimeError(f"assemblyai transcription did not complete within {ASR_POLL_MAX}s")
        time.sleep(ASR_POLL_INTERVAL)
        waited += ASR_POLL_INTERVAL


def replace_draft(conn, job_id: str, lesson, content: dict, original: dict,
                  annotations: list[dict]) -> str:
    """Idempotent output: a redelivered job wipes its own draft and rebuilds."""
    lesson_id, teacher_id, student_id, piece_id, piece_label = lesson
    with conn.cursor() as cur:
        cur.execute(
            """DELETE FROM note_annotations WHERE note_id IN
               (SELECT id FROM notes WHERE note_job_id = %s AND status = 'draft')""",
            (job_id,))
        cur.execute("DELETE FROM notes WHERE note_job_id = %s AND status = 'draft'", (job_id,))
        cur.execute(
            """INSERT INTO notes (note_job_id, lesson_session_id, teacher_id, student_id,
                                  piece_id, piece_label, content_original, content)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (job_id, lesson_id, teacher_id, student_id, piece_id, piece_label,
             json.dumps(original), json.dumps(content)))
        note_id = cur.fetchone()[0]
        for idx, a in enumerate(annotations):
            cur.execute(
                """INSERT INTO note_annotations (note_id, idx, category, instruction, quote, location)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (note_id, idx, a["category"], a["instruction"], a["quote"],
                 json.dumps(a["location"])))
    conn.commit()
    return note_id


def process(conn, blob: BlobServiceClient, storage_cs: str, job_id: str,
            req_id: str | None = None) -> None:
    jlog(job=job_id, event="start", reqId=req_id)
    row = fetch_job(conn, job_id)
    if row is None:
        jlog(job=job_id, event="drop", reason="no such job")
        return
    (_, status, attempts, lesson_id, teacher_id, student_id, piece_id, piece_label,
     audio_path, duration_sec, piece_title, piece_composer, piece_facts) = row
    if status not in ("queued", "processing"):
        jlog(job=job_id, event="skip", status=status)
        return
    if not audio_path:
        update_job(conn, job_id, status="failed", error="lesson has no audio")
        return

    metrics: dict = {}
    t0 = time.time()
    update_job(conn, job_id, status="processing", stage="asr", error=None)

    asr = run_asr(audio_read_url(storage_cs, audio_path), env("ASSEMBLYAI_API_KEY"))
    text = asr.get("text") or ""
    utterances = asr.get("utterances") or []
    metrics["asr_secs"] = round(time.time() - t0, 1)
    metrics["language"] = asr.get("language_code")
    metrics["audio_duration"] = asr.get("audio_duration")

    # Persist the transcript BEFORE any gate — it is the durable derivative that
    # outlives the 90-day audio and the only debug artifact for a gate failure.
    transcript_path = f"transcripts/{job_id}.json"
    blob.get_container_client(ASSETS_CONTAINER).get_blob_client(transcript_path).upload_blob(
        json.dumps({"text": text, "utterances": utterances,
                    "language": asr.get("language_code"),
                    "audio_duration": asr.get("audio_duration")}),
        overwrite=True, content_settings=ContentSettings(content_type="application/json"))
    update_job(conn, job_id, stage="llm", transcript_path=transcript_path)

    metrics.update(check_transcript(text, utterances))

    measure_count = None
    if isinstance(piece_facts, dict):
        m = piece_facts.get("measures")
        measure_count = m if isinstance(m, int) and m > 0 else None
    piece_desc = f'"{piece_title}" by {piece_composer}' if piece_title else piece_label
    system = build_system(measure_count)
    user = build_user(build_turns(utterances) or text, piece_desc)

    t1 = time.time()
    result = generate(system, user)
    parsed = None
    try:
        obj = extract_json(result.text)
        parsed = normalize_note(obj, text, measure_count)
    except ValueError as err:
        jlog(job=job_id, event="llm_repair", error=str(err)[:200])
        result = generate(system, user + f"\n\nYour previous output failed validation: {err}. "
                                         "Output ONLY the corrected ```json block.")
        obj = extract_json(result.text)
        parsed = normalize_note(obj, text, measure_count)
    content, annotations, warnings = parsed
    metrics.update({
        "llm_secs": round(time.time() - t1, 1), "llm_model": result.model,
        "llm_in_tok": result.in_tok, "llm_out_tok": result.out_tok,
        "annotations": len(annotations),
        "grounded": sum(1 for a in annotations if a["location"].get("grounded")),
        "warnings": warnings,
    })

    update_job(conn, job_id, stage="gates")
    lesson = (lesson_id, teacher_id, student_id, piece_id, piece_label)
    note_id = replace_draft(conn, job_id, lesson, content, obj, annotations)
    update_job(conn, job_id, status="ready_for_review", stage=None,
               metrics=json.dumps(metrics))
    jlog(job=job_id, event="done", note=str(note_id), reqId=req_id,
         annotations=len(annotations), grounded=metrics["grounded"],
         secs=round(time.time() - t0, 1))


def main() -> None:
    db_url = env("DATABASE_URL")
    storage_cs = env("STORAGE_CONNECTION_STRING")
    sb_cs = env("SERVICEBUS_CONNECTION_STRING")
    env("ASSEMBLYAI_API_KEY")
    env("ANTHROPIC_API_KEY")

    blob = BlobServiceClient.from_connection_string(storage_cs)
    # A 60-min lesson ≈ 10-20 min of ASR+LLM; keep the message lock alive well past it.
    renewer = AutoLockRenewer(max_lock_renewal_duration=3600)
    jlog(event="up", queue=QUEUE)
    with ServiceBusClient.from_connection_string(sb_cs) as sb:
        receiver = sb.get_queue_receiver(QUEUE, max_wait_time=None, auto_lock_renewer=renewer)
        with receiver:
            for msg in receiver:
                job_id = None
                processed = False
                try:
                    body = json.loads(b"".join(msg.body).decode()
                                      if not isinstance(msg.body, (bytes, str)) else msg.body)
                    job_id = body["jobId"]
                    req_id = body.get("reqId")
                    with psycopg.connect(db_url) as conn:
                        try:
                            process(conn, blob, storage_cs, job_id, req_id)
                        except GateFail as gf:
                            update_job(conn, job_id, status="failed", stage=None,
                                       error=str(gf), failure_hints=json.dumps(gf.hints))
                            jlog(job=job_id, event="gate_fail", error=str(gf))
                    processed = True
                    receiver.complete_message(msg)
                except Exception:
                    traceback.print_exc()
                    marked_failed = False
                    if job_id and not processed:
                        try:
                            with psycopg.connect(db_url) as conn:
                                update_job(conn, job_id, status="failed",
                                           error="worker_crash: see worker logs")
                            marked_failed = True
                        except Exception:
                            traceback.print_exc()
                    if not processed:
                        try:
                            if marked_failed:
                                # Row now says failed (retry can recover) — settle it.
                                receiver.complete_message(msg)
                            else:
                                # DB unreachable: we could NOT record a terminal state, so
                                # completing would strand the job forever. Abandon → the
                                # broker redelivers (idempotent) or dead-letters after
                                # maxDelivery, which fires the DLQ alert.
                                receiver.abandon_message(msg)
                        except Exception:
                            traceback.print_exc()


if __name__ == "__main__":
    main()
