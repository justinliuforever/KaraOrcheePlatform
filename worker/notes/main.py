"""Notes worker — consumes notes-jobs, runs ASR (AssemblyAI) + LLM (claude-sonnet-5)
+ gates, writes the transcript derivative to notes-assets, and inserts the note +
annotations: a draft for teacher review on teacher-recorded lessons, or a note born
'sent' to the owner on solo (student-recorded) lessons.

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
import threading
import time
import traceback

import psycopg
import requests
from azure.servicebus import AutoLockRenewer, ServiceBusClient
from azure.storage.blob import (BlobSasPermissions, BlobServiceClient,
                                ContentSettings, generate_blob_sas)

from llm import generate
from narration import narrate_on_demand, narration_stage, targets_from_message
from obs import jlog
from pipeline import (GateFail, build_turns, check_transcript, drop_reasons,
                      extract_json, normalize_note)
from prompt import build_system, build_user

QUEUE = "notes-jobs"
NARRATION_QUEUE = "notes-narration"
AUDIO_CONTAINER = "lesson-audio"
ASSETS_CONTAINER = "notes-assets"
TRANSCRIPT_PREFIX = "transcripts/"
# Under transcripts/ deliberately: the notes-assets lifecycle rule that expires
# verbatim lesson content at 90 days matches that prefix, and this is the same content.
MODEL_OUTPUT_PREFIX = "transcripts/model-output/"
MODEL_OUTPUT_MAX_CHARS = 100_000
ASR_BASE = "https://api.assemblyai.com/v2"
# Validated 2026-07-03: plural priority list; keyterms/prompt stay OFF (both
# tested and rejected — over-bias, hallucinated numbers).
ASR_MODELS = ["universal-3-5-pro", "universal-2"]


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"fatal: {name} is required", file=sys.stderr)
        sys.exit(1)
    return v


def piece_measures(facts) -> int | None:
    """The only piece fact the grounding bound reads. Absent/zero = unbounded."""
    if isinstance(facts, dict):
        m = facts.get("measures")
        if isinstance(m, int) and m > 0:
            return m
    return None


def fetch_job(conn, job_id: str):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT j.id, j.status, j.attempts, l.id, l.teacher_id, l.student_id,
                      l.piece_id, l.piece_label, l.audio_path, l.duration_sec,
                      l.owner_role, p.title, p.composer, p.facts
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


def lesson_canceled(conn, lesson_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM lesson_sessions WHERE id = %s", (lesson_id,))
        row = cur.fetchone()
    conn.commit()
    return bool(row) and row[0] == "canceled"


def stamp_transcript(conn, job_id: str, path: str) -> bool:
    """Record the transcript ONLY while the lesson is still live. One statement, so
    a discard committing alongside it either loses (and then sees transcript_path
    and deletes the blob itself) or wins (and this returns False)."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE note_jobs j SET transcript_path = %s, stage = 'llm', updated_at = now()
               FROM lesson_sessions l
               WHERE j.id = %s AND l.id = j.lesson_session_id AND l.status <> 'canceled'""",
            (path, job_id))
        landed = cur.rowcount > 0
    conn.commit()
    return landed


def delete_asset_blob(blob, path: str) -> None:
    try:
        blob.get_container_client(ASSETS_CONTAINER).get_blob_client(path).delete_blob()
    except Exception as err:
        jlog(event="asset_delete_failed", path=path, error=str(err)[:200])


def record_gate_fail(conn, job_id: str, gf: GateFail) -> None:
    cols = {"status": "failed", "stage": None, "failure_code": gf.code,
            "error": str(gf), "failure_hints": json.dumps(gf.hints)}
    if gf.metrics is not None:
        cols["metrics"] = json.dumps(gf.metrics)
    update_job(conn, job_id, **cols)
    jlog(job=job_id, event="gate_fail", code=gf.code, error=str(gf), artifact=gf.artifact)


def mark_worker_crash(conn, job_id: str) -> None:
    """Never relabel a terminal success: a transient error AFTER the note committed
    (final update_job blip, or a duplicate-delivery race loser) must not flip a
    delivered job to 'failed' and invite a paid re-run."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE note_jobs
               SET status = 'failed',
                   failure_code = 'worker_crash',
                   error = 'worker_crash: see worker logs',
                   updated_at = now()
               WHERE id = %s AND status <> 'ready_for_review'""",
            (job_id,))
    conn.commit()


def stamp_model_output(conn, job_id: str, path: str) -> bool:
    """Same live-lesson guard as stamp_transcript: an artifact whose lesson was
    discarded mid-write must not survive behind a column the discard already nulled."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE note_jobs j SET model_output_path = %s, updated_at = now()
               FROM lesson_sessions l
               WHERE j.id = %s AND l.id = j.lesson_session_id AND l.status <> 'canceled'""",
            (path, job_id))
        landed = cur.rowcount > 0
    conn.commit()
    return landed


def attempt_record(n: int, result, error: str | None) -> dict:
    return {"n": n, "model": result.model, "in_tok": result.in_tok, "out_tok": result.out_tok,
            "error": error, "text": (result.text or "")[:MODEL_OUTPUT_MAX_CHARS]}


def model_output_payload(job_id: str, outcome: str, stage: str, piece_desc, measure_count,
                         attempts: list[dict], parsed, evidence: dict | None) -> dict:
    """What the model produced and what rejected it. The prompt itself is deliberately
    absent — it is the stored transcript plus the two inputs recorded here, and copying
    it in would put the same verbatim speech under a second retention clock."""
    return {
        "job_id": job_id,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "outcome": outcome,
        "stage": stage,
        "piece": piece_desc,
        "measure_count": measure_count,
        "attempts": attempts,
        "parsed": parsed,
        "evidence": evidence or {},
    }


def save_model_output(conn, blob, job_id: str, lesson_id: str, payload: dict) -> str | None:
    """Diagnostics only — every failure here is swallowed. A job must never fail, or
    lose a note it already produced, because its evidence could not be stored."""
    path = f"{MODEL_OUTPUT_PREFIX}{job_id}.json"
    try:
        if lesson_canceled(conn, lesson_id):
            return None
        blob.get_container_client(ASSETS_CONTAINER).get_blob_client(path).upload_blob(
            json.dumps(payload), overwrite=True,
            content_settings=ContentSettings(content_type="application/json"))
        if not stamp_model_output(conn, job_id, path):
            delete_asset_blob(blob, path)
            return None
        return path
    except Exception as err:
        jlog(job=job_id, event="model_output_unwritten", error=str(err)[:200])
        return None


def gate_counts(evidence: dict) -> dict:
    """Numeric evidence only: everything else a gate records is verbatim lesson text."""
    return {k: v for k, v in evidence.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}


def llm_metrics(t0: float, result) -> dict:
    return {"llm_secs": round(time.time() - t0, 1), "llm_model": result.model,
            "llm_in_tok": result.in_tok, "llm_out_tok": result.out_tok}


def abort_discarded(conn, job_id: str, reason: str) -> None:
    """Terminal state for a job whose lesson was discarded mid-run. Writes NO
    metrics: metrics.warnings carries quoted instruction text, and the discard the
    user was promised has already stripped it from this row."""
    update_job(conn, job_id, status="failed", stage=None,
               failure_code="lesson_discarded", error="lesson discarded by owner")
    jlog(job=job_id, event="drop", reason=reason)


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


# Mirrors REGROUND_HINT in api/src/routes/lessons.ts — it must read as "needs a
# location", never as an error.
REGROUND_HINT = "This pointed past the end of the piece — place it on the score."


def rebound_annotations(annotations: list[dict], measure_count: int | None) -> list[dict]:
    """Demote every auto-placed anchor that points past the end of the piece, the
    same rule the API applies when a piece is named after the fact. A human pin is
    never touched, and `raw` survives as the clue. No-op when the anchors were
    already validated against this bound upstream."""
    if measure_count is None:
        return annotations
    out = []
    for a in annotations:
        loc = a.get("location") or {}
        end = loc.get("measureEnd") if isinstance(loc.get("measureEnd"), int) else loc.get("measureStart")
        if (loc.get("grounded") is True and loc.get("pinnedBy") == "auto"
                and isinstance(end, int) and end > measure_count):
            kept = {k: v for k, v in loc.items()
                    if k not in ("measureStart", "measureEnd", "pinnedBy")}
            kept.update({"grounded": False, "hint": REGROUND_HINT})
            a = {**a, "location": kept}
        out.append(a)
    return out


def replace_draft(conn, job_id: str, lesson_id: str, content: dict, original: dict,
                  annotations: list[dict]) -> str | None:
    """Idempotent output. Teacher lessons: a redelivered job wipes its own draft and
    rebuilds. Solo lessons: the note is born 'sent' to the owner, so the wipe can't
    apply — an insert-guard makes redelivery/requeue a no-op instead (a rebuild
    would silently drop pins the student may already have placed).

    Every mutable lesson fact is re-read UNDER the lock and never taken from the
    job snapshot: PATCH /v1/lessons/:id can reassign the student or name the piece
    during the ASR+LLM window, and its cascade finds no note to fix because the
    note does not exist yet — so a snapshot write would silently revert the repair
    and prefill the review footer with the wrong recipient.

    Returns None when the lesson was discarded — the caller MUST NOT then flip the
    job to ready_for_review."""
    with conn.cursor() as cur:
        # Discard race: a worker already past process()'s status check can insert a
        # note into a lesson canceled seconds ago, leaving an orphan draft in
        # "Needs attention" for a lesson the teacher deleted. FOR UPDATE, so a
        # discard that arrives mid-insert blocks here and then deletes the draft
        # we just wrote instead of interleaving with it. (FOR UPDATE OF l: the
        # piece join is the nullable side and must not be locked.)
        cur.execute(
            """SELECT l.status, l.teacher_id, l.student_id, l.piece_id, l.piece_label,
                      l.owner_role, p.published_version, p.facts
               FROM lesson_sessions l
               LEFT JOIN pieces p ON p.id = l.piece_id
               WHERE l.id = %s FOR UPDATE OF l""",
            (lesson_id,))
        row = cur.fetchone()
        if row is None:
            conn.commit()
            return None
        (status, teacher_id, student_id, piece_id, piece_label, owner_role,
         piece_version, piece_facts) = row
        if status == "canceled":
            conn.commit()
            return None
        # A piece named during the run bounds grounding that was computed with no
        # bound at all; re-picking the same piece later is a no-op on both the
        # inherit test and the reground pass, so this is the only place it lands.
        annotations = rebound_annotations(annotations, piece_measures(piece_facts))
        if owner_role == "student":
            cur.execute(
                """SELECT id FROM notes WHERE note_job_id = %s
                   AND origin = 'self' AND status = 'sent' LIMIT 1""",
                (job_id,))
            existing = cur.fetchone()
            if existing:
                conn.commit()
                return existing[0]
            try:
                cur.execute(
                    """INSERT INTO notes (note_job_id, lesson_session_id, teacher_id, student_id,
                                          piece_id, piece_label, piece_version, origin,
                                          status, sent_at, content_original, content)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 'self', 'sent', now(), %s, %s)
                       RETURNING id""",
                    (job_id, lesson_id, teacher_id, teacher_id, piece_id, piece_label,
                     piece_version, json.dumps(original), json.dumps(content)))
            except psycopg.errors.UniqueViolation:
                # uq_note_self_per_job race loser (concurrent delivery via deploy
                # drain / redelivery): the winner's note IS the note — converge as
                # success instead of crashing this job into 'failed' and inviting a
                # paid re-run.
                conn.rollback()
                with conn.cursor() as cur2:
                    cur2.execute(
                        """SELECT id FROM notes WHERE note_job_id = %s
                           AND origin = 'self' AND status = 'sent' LIMIT 1""",
                        (job_id,))
                    winner = cur2.fetchone()
                conn.commit()
                if winner:
                    return winner[0]
                raise
        else:
            cur.execute(
                """DELETE FROM note_annotations WHERE note_id IN
                   (SELECT id FROM notes WHERE note_job_id = %s AND status = 'draft')""",
                (job_id,))
            cur.execute("DELETE FROM notes WHERE note_job_id = %s AND status = 'draft'", (job_id,))
            cur.execute(
                """INSERT INTO notes (note_job_id, lesson_session_id, teacher_id, student_id,
                                      piece_id, piece_label, origin, content_original, content)
                   VALUES (%s, %s, %s, %s, %s, %s, 'teacher', %s, %s)
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
    # PROMPT INPUTS ONLY. Everything written to the note (student, piece, its
    # version and measure bound) is re-read under the lock in replace_draft — a
    # PATCH during the ASR+LLM window must not be reverted by this snapshot.
    (_, status, attempts, lesson_id, teacher_id, student_id, piece_id, piece_label,
     audio_path, duration_sec, owner_role, piece_title, piece_composer, piece_facts) = row
    if status not in ("queued", "processing"):
        jlog(job=job_id, event="skip", status=status)
        return
    if not audio_path:
        update_job(conn, job_id, status="failed", stage=None,
                   failure_code="no_audio", error="lesson has no audio")
        return

    # Before the spend and before any failure label: a message queued ahead of a
    # discard (or redelivered after one) must not be attributed to asr_error in
    # the failure-code facet, and must not re-ship deleted audio to the ASR vendor.
    if lesson_canceled(conn, lesson_id):
        abort_discarded(conn, job_id, "lesson canceled before asr")
        return

    # Mic-proximity watch: solo recordings put the phone near the STUDENT, flipping
    # which voice is far-field. Recorded per job; never pre-tuned on.
    metrics: dict = {"owner_role": owner_role}
    t0 = time.time()
    update_job(conn, job_id, status="processing", stage="asr", error=None, failure_code=None)

    try:
        asr = run_asr(audio_read_url(storage_cs, audio_path), env("ASSEMBLYAI_API_KEY"))
    except Exception as err:
        update_job(conn, job_id, status="failed", stage=None,
                   failure_code="asr_error", error=f"asr_error: {err}"[:500])
        jlog(job=job_id, event="asr_fail", error=str(err)[:200])
        return
    text = asr.get("text") or ""
    utterances = asr.get("utterances") or []
    metrics["asr_secs"] = round(time.time() - t0, 1)
    metrics["language"] = asr.get("language_code")
    metrics["audio_duration"] = asr.get("audio_duration")

    # Persist the transcript BEFORE any gate — it is the durable derivative that
    # outlives the 90-day audio and the only debug artifact for a gate failure.
    #
    # The 60-minute stuck-job hatch can fire while ASR is still running
    # (ASR_POLL_MAX alone is 40 min), so a discard can land between the job
    # starting and this write. A transcript re-uploaded after a discard survives its
    # full 90-day lifecycle while the audit trail says it was deleted. Check before
    # the upload, and let the stamp itself re-check.
    transcript_path = f"{TRANSCRIPT_PREFIX}{job_id}.json"
    if lesson_canceled(conn, lesson_id):
        abort_discarded(conn, job_id, "lesson canceled during asr")
        return
    blob.get_container_client(ASSETS_CONTAINER).get_blob_client(transcript_path).upload_blob(
        json.dumps({"text": text, "utterances": utterances,
                    "language": asr.get("language_code"),
                    "audio_duration": asr.get("audio_duration")}),
        overwrite=True, content_settings=ContentSettings(content_type="application/json"))
    if not stamp_transcript(conn, job_id, transcript_path):
        delete_asset_blob(blob, transcript_path)
        abort_discarded(conn, job_id, "lesson canceled during transcript upload")
        return

    try:
        metrics.update(check_transcript(text, utterances))
    except GateFail as gf:
        gf.metrics = {**metrics, **gate_counts(gf.evidence)}
        raise

    measure_count = piece_measures(piece_facts)
    piece_desc = f'"{piece_title}" by {piece_composer}' if piece_title else piece_label
    system = build_system(measure_count)
    user = build_user(build_turns(utterances) or text, piece_desc)

    t1 = time.time()
    result = generate(system, user)
    obj = None
    rejected: list[dict] = []
    try:
        try:
            obj = extract_json(result.text)
            parsed = normalize_note(obj, text, measure_count)
        except ValueError as err:
            # GateFail is not a ValueError, so a content gate never lands here — only
            # a malformed model response, which earns exactly one repair pass.
            rejected.append(attempt_record(1, result, str(err)))
            jlog(job=job_id, event="llm_repair", error=str(err)[:200])
            result = generate(system, user + f"\n\nYour previous output failed validation: {err}. "
                                             "Output ONLY the corrected ```json block.")
            obj = extract_json(result.text)
            parsed = normalize_note(obj, text, measure_count)
    except ValueError as err2:
        rejected.append(attempt_record(len(rejected) + 1, result, str(err2)))
        metrics.update(llm_metrics(t1, result))
        artifact = save_model_output(conn, blob, job_id, lesson_id, model_output_payload(
            job_id, "llm_invalid", "llm", piece_desc, measure_count, rejected, obj, None))
        update_job(conn, job_id, status="failed", stage=None, failure_code="llm_invalid",
                   error=f"llm_invalid: {err2}"[:500], metrics=json.dumps(metrics))
        jlog(job=job_id, event="llm_invalid", error=str(err2)[:200], artifact=artifact)
        return
    except GateFail as gf:
        rejected.append(attempt_record(len(rejected) + 1, result, None))
        metrics.update(llm_metrics(t1, result))
        metrics.update(gate_counts(gf.evidence))
        gf.metrics = metrics
        gf.artifact = save_model_output(conn, blob, job_id, lesson_id, model_output_payload(
            job_id, gf.code, "gates", piece_desc, measure_count, rejected, obj, gf.evidence))
        raise
    content, annotations, warnings, drops = parsed
    metrics.update(llm_metrics(t1, result))
    metrics.update({
        "annotations": len(annotations),
        "grounded": sum(1 for a in annotations if a["location"].get("grounded")),
        "warnings": warnings,
        "dropped": len(drops),
        "drop_reasons": drop_reasons(drops),
    })
    # A note that shipped after a repair, or short of annotations a gate dropped, needs
    # the same evidence a failed one does.
    if rejected or drops:
        save_model_output(conn, blob, job_id, lesson_id, model_output_payload(
            job_id, "delivered", "gates", piece_desc, measure_count, rejected, obj,
            {"kept": len(annotations), "drops": drops}))

    update_job(conn, job_id, stage="gates")
    note_id = replace_draft(conn, job_id, lesson_id, content, obj, annotations)
    if note_id is None:
        # A canceled lesson must never produce a ready_for_review job: it would be
        # a "ready" row with no note — invisible to the app (canceled lessons are
        # filtered out of the poll) but a lie in admin and in the failure_code
        # statistics. Writing metrics here would also re-introduce the quoted
        # instruction text the discard just stripped.
        abort_discarded(conn, job_id, "lesson canceled before note insert")
        return
    update_job(conn, job_id, status="ready_for_review", stage=None,
               metrics=json.dumps(metrics))
    jlog(job=job_id, event="done", note=str(note_id), reqId=req_id,
         annotations=len(annotations), grounded=metrics["grounded"],
         secs=round(time.time() - t0, 1))

    # Strictly after delivery: premium narration is an enhancement, and the app reads
    # the note with the system voice whether or not any of this succeeds.
    narration = narration_stage(conn, blob, note_id, req_id)
    if narration:
        metrics["narration"] = narration
        update_job(conn, job_id, metrics=json.dumps(metrics))


def narration_loop(sb_cs: str, db_url: str, blob: BlobServiceClient) -> None:
    """The notes-narration lane, on its own thread: a minutes-long synthesis run must
    neither delay an ASR job nor wait behind one. Never lets its own death take the
    ASR lane with it — narration is an enhancement, notes are the product."""
    try:
        renewer = AutoLockRenewer(max_lock_renewal_duration=1800)
        with ServiceBusClient.from_connection_string(sb_cs) as sb:
            receiver = sb.get_queue_receiver(NARRATION_QUEUE, max_wait_time=None,
                                             auto_lock_renewer=renewer)
            with receiver:
                jlog(event="up", queue=NARRATION_QUEUE)
                for msg in receiver:
                    try:
                        body = json.loads(b"".join(msg.body).decode()
                                          if not isinstance(msg.body, (bytes, str)) else msg.body)
                        note_id, voices = targets_from_message(body)
                        with psycopg.connect(db_url) as conn:
                            narrate_on_demand(conn, blob, note_id, voices, body.get("reqId"))
                        receiver.complete_message(msg)
                    except Exception as err:
                        traceback.print_exc()
                        jlog(event="narration_failed", queue=NARRATION_QUEUE,
                             error=str(err)[:200] or type(err).__name__)
                        try:
                            # Redelivery costs nothing it already paid for: clips whose
                            # content hash still matches are skipped on the retry.
                            receiver.abandon_message(msg)
                        except Exception:
                            traceback.print_exc()
    except Exception:
        traceback.print_exc()
        jlog(event="narration_lane_down", queue=NARRATION_QUEUE)


def main() -> None:
    db_url = env("DATABASE_URL")
    storage_cs = env("STORAGE_CONNECTION_STRING")
    sb_cs = env("SERVICEBUS_CONNECTION_STRING")
    env("ASSEMBLYAI_API_KEY")
    env("ANTHROPIC_API_KEY")

    blob = BlobServiceClient.from_connection_string(storage_cs)
    threading.Thread(target=narration_loop, args=(sb_cs, db_url, blob), daemon=True).start()
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
                            record_gate_fail(conn, job_id, gf)
                    processed = True
                    receiver.complete_message(msg)
                except Exception as err:
                    traceback.print_exc()
                    # The traceback is unstructured stderr; this line carries the job id.
                    jlog(job=job_id, event="worker_crash",
                         error=f"{type(err).__name__}: {err}"[:200])
                    marked_failed = False
                    if job_id and not processed:
                        try:
                            with psycopg.connect(db_url) as conn:
                                mark_worker_crash(conn, job_id)
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
