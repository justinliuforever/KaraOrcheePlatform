"""B1.5 solo finalize branch: replace_draft teacher/solo paths, the BK-1
insert-guard, fetch_job arity (owner_role), and owner_role in job metrics.
R4 adds the failure_code map and the discard-vs-worker race guards.
All DB access goes through a fake psycopg-style conn that records executed
SQL + params and returns scripted fetchone rows — no real DB or network."""
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# main.py imports azure/psycopg at module load; stub the heavy ones (same
# pattern as test_asr_poll.py — idempotent if that file already ran).
for name in ("azure", "azure.servicebus", "azure.storage", "azure.storage.blob", "psycopg"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["azure.servicebus"].AutoLockRenewer = object
sys.modules["azure.servicebus"].ServiceBusClient = object
blobmod = sys.modules["azure.storage.blob"]
for attr in ("BlobSasPermissions", "BlobServiceClient", "ContentSettings", "generate_blob_sas"):
    setattr(blobmod, attr, object)

import main  # noqa: E402


def norm(sql: str) -> str:
    return " ".join(sql.split())


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self._conn.executed.append((norm(sql), params))
        self._conn._pending = self._conn.script(norm(sql))
        self.rowcount = self._conn.rowcount_for(norm(sql))

    def fetchone(self):
        return self._conn._pending


class FakeConn:
    """Records every (sql, params); fetchone returns the scripted row for the
    most recently executed statement (first matching fragment wins). rowcounts
    scripts cur.rowcount the same way (default 1 = the statement landed). A
    scripted LIST is consumed one entry per execution, which is how the same
    statement can answer differently before and after a concurrent write."""

    def __init__(self, rows: dict, rowcounts: dict | None = None):
        self.rows = rows
        self.rowcounts = rowcounts or {}
        self.executed = []
        self.commits = 0
        self._pending = None

    def script(self, sql):
        for frag, val in self.rows.items():
            if frag in sql:
                if isinstance(val, list):
                    return val.pop(0) if val else None
                return val
        return None

    def rowcount_for(self, sql):
        for frag, val in self.rowcounts.items():
            if frag in sql:
                return val
        return 1

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1


CONTENT = {"lessonSummary": "Nice work on the leap."}
ORIGINAL = {"lesson_summary": "Nice work on the leap."}
ANNS = [
    {"category": "technique", "instruction": "Prepare the leap.", "quote": "prepare the leap",
     "location": {"raw": "bar 3", "grounded": True}},
    {"category": "practice_strategy", "instruction": "Five slow reps.", "quote": "five slow reps",
     "location": {"raw": "", "grounded": False}},
]


# The row replace_draft re-reads under FOR UPDATE — never the job snapshot.
# (status, teacher_id, student_id, piece_id, piece_label, owner_role,
#  published_version, facts)
LOCK = "FOR UPDATE OF l"


def teacher_lock(status="submitted", student_id="student-4", piece_id="piece-1",
                 piece_label="Etude No. 3", published_version=3, facts=None):
    return (status, "teacher-7", student_id, piece_id, piece_label, "teacher",
            published_version, facts)


def solo_lock(status="submitted", piece_id="piece-1", piece_label="Etude No. 3",
              published_version=7, facts=None):
    # Solo lesson_sessions carry no student_id; the owner is teacher_id.
    return (status, "owner-9", None, piece_id, piece_label, "student",
            published_version, facts)


# --- replace_draft: teacher path (pre-B1.5 behavior, byte-for-byte sequence) ---

def test_teacher_path_wipes_draft_then_inserts_teacher_origin():
    conn = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-1",)})
    nid = main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert nid == "note-1"
    sqls = [s for s, _ in conn.executed]
    # The discard guard runs first, and holds the lesson row for the whole insert.
    assert sqls[0].startswith("SELECT l.status, l.teacher_id") and sqls[0].endswith(LOCK)
    assert conn.executed[0][1] == ("lesson-1",)
    assert sqls[1].startswith("DELETE FROM note_annotations") and "status = 'draft'" in sqls[1]
    assert sqls[2] == "DELETE FROM notes WHERE note_job_id = %s AND status = 'draft'"
    assert sqls[3].startswith("INSERT INTO notes") and "'teacher'" in sqls[3]
    assert "'sent'" not in sqls[3] and "sent_at" not in sqls[3]
    assert all("INSERT INTO note_annotations" in s for s in sqls[4:])
    assert len(sqls) == 4 + len(ANNS)
    # the piece row rides the lock statement — no second round trip
    assert not any(s.startswith("SELECT published_version") or "origin = 'self'" in s
                   for s in sqls)
    p = conn.executed[3][1]
    assert p[2] == "teacher-7" and p[3] == "student-4"  # student_id passed through
    assert json.loads(p[6]) == ORIGINAL and json.loads(p[7]) == CONTENT
    assert conn.commits == 1


# --- replace_draft: solo path (born 'sent' to the owner) ---

def test_solo_first_run_inserts_one_born_sent_note():
    conn = FakeConn({
        LOCK: solo_lock(),
        "SELECT id FROM notes WHERE note_job_id": None,   # guard: nothing yet
        "INSERT INTO notes": ("note-2",),
    })
    nid = main.replace_draft(conn, "job-2", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert nid == "note-2"
    sqls = [s for s, _ in conn.executed]
    assert not any(s.startswith("DELETE") for s in sqls)  # solo never wipes
    assert sqls[0].endswith(LOCK)
    assert "origin = 'self' AND status = 'sent'" in sqls[1]  # insert-guard next
    assert sqls[2].startswith("INSERT INTO notes")
    assert "'self', 'sent', now()" in sqls[2]  # origin/status literal, sent_at set
    p = conn.executed[2][1]
    assert p[0] == "job-2" and p[1] == "lesson-1"
    assert p[2] == "owner-9" and p[3] == "owner-9"  # student_id == teacher_id == owner
    assert p[6] == 7                                # piece_version from published_version
    assert json.loads(p[7]) == ORIGINAL and json.loads(p[8]) == CONTENT
    # annotations inserted after the note, one row each, bound to the new id
    ann = conn.executed[3:]
    assert len(ann) == len(ANNS)
    assert all(s.startswith("INSERT INTO note_annotations") for s, _ in ann)
    assert all(params[0] == "note-2" for _, params in ann)
    assert conn.commits == 1


def test_solo_piece_version_null_when_no_piece():
    conn = FakeConn({
        LOCK: solo_lock(piece_id=None, published_version=None),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-3",),
    })
    main.replace_draft(conn, "job-3", "lesson-1", CONTENT, ORIGINAL, ANNS)
    ins = next(i for i, (s, _) in enumerate(conn.executed) if s.startswith("INSERT INTO notes"))
    assert conn.executed[ins][1][4] is None  # piece_id
    assert conn.executed[ins][1][6] is None  # piece_version


def test_lesson_row_gone_is_treated_as_discarded():
    conn = FakeConn({LOCK: None})
    assert main.replace_draft(conn, "job-4", "lesson-1", CONTENT, ORIGINAL, ANNS) is None
    assert len(conn.executed) == 1
    assert conn.commits == 1


# --- BK-1: insert-guard idempotency (redelivered/requeued solo job = no-op) ---

def test_solo_insert_guard_converges_without_second_insert():
    conn = FakeConn({
        LOCK: solo_lock(),
        "SELECT id FROM notes WHERE note_job_id": ("existing-note",),
    })
    nid = main.replace_draft(conn, "job-2", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert nid == "existing-note"
    # discard guard + insert guard only — no INSERT, no annotations
    assert len(conn.executed) == 2
    sql, params = conn.executed[1]
    assert sql.startswith("SELECT id FROM notes")
    assert "origin = 'self'" in sql and "status = 'sent'" in sql
    assert params == ("job-2",)
    assert conn.commits == 1  # still commits (closes the transaction cleanly)


# --- AS-3: the repair made DURING the run is what lands, not the job snapshot ---

def test_student_reassigned_mid_run_is_the_one_the_note_is_written_to():
    # Seq A (wrong recipient): the lesson was created naming alice; the teacher
    # fixed it to bob while ASR+LLM ran. The PATCH cascade found no note to fix
    # because the note did not exist yet, so this insert is the only writer.
    conn = FakeConn({
        LOCK: teacher_lock(student_id="student-bob"),
        "INSERT INTO notes": ("note-5",),
    })
    main.replace_draft(conn, "job-5", "lesson-1", CONTENT, ORIGINAL, ANNS)
    ins = next((s, p) for s, p in conn.executed if s.startswith("INSERT INTO notes"))
    assert ins[1][3] == "student-bob"
    # the snapshot value never appears anywhere in the write
    assert "student-4" not in [str(v) for v in ins[1]]


def test_piece_named_mid_run_lands_on_the_note_with_its_version():
    # Seq B (the unrecoverable one): the lesson was created piece-less, so the
    # note used to be born piece_id NULL — after which re-picking the SAME piece
    # is a no-op on both the inherit test and the reground pass.
    conn = FakeConn({
        LOCK: solo_lock(piece_id="short_piece", piece_label="Op. 100 No. 2",
                        published_version=5),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-6",),
    })
    main.replace_draft(conn, "job-6", "lesson-1", CONTENT, ORIGINAL, ANNS)
    ins = next((s, p) for s, p in conn.executed if s.startswith("INSERT INTO notes"))
    assert ins[1][4] == "short_piece"      # piece_id
    assert ins[1][5] == "Op. 100 No. 2"    # piece_label
    assert ins[1][6] == 5                  # piece_version, from the same locked read


def test_a_piece_named_mid_run_bounds_the_grounding_it_never_had():
    # The anchors were computed with measure_count None (unbounded); the piece
    # named under the lock is 32 bars, so bar 84 must land unplaced, not on a
    # score that has no bar 84.
    anns = [
        {"category": "technique", "instruction": "Past the end", "quote": "bar eighty four",
         "location": {"type": "absolute", "raw": "bar 84", "grounded": True,
                      "measureStart": 84, "measureEnd": 84, "pinnedBy": "auto"}},
        {"category": "rhythm", "instruction": "Still inside", "quote": "bar four",
         "location": {"type": "absolute", "raw": "bar 4", "grounded": True,
                      "measureStart": 4, "measureEnd": 4, "pinnedBy": "auto"}},
    ]
    conn = FakeConn({
        LOCK: teacher_lock(piece_id="short_piece", facts={"measures": 32}),
        "INSERT INTO notes": ("note-7",),
    })
    main.replace_draft(conn, "job-7", "lesson-1", CONTENT, ORIGINAL, anns)
    locs = [json.loads(p[5]) for s, p in conn.executed
            if s.startswith("INSERT INTO note_annotations")]
    assert locs[0]["grounded"] is False
    assert "measureStart" not in locs[0] and "pinnedBy" not in locs[0]
    assert locs[0]["raw"] == "bar 84"           # the words survive as the clue
    assert locs[0]["hint"] == main.REGROUND_HINT
    assert locs[1]["grounded"] is True and locs[1]["measureStart"] == 4
    # the caller's list is not mutated in place
    assert anns[0]["location"]["grounded"] is True


def test_rebound_leaves_human_pins_and_unbounded_pieces_alone():
    human = [{"location": {"grounded": True, "measureStart": 90, "measureEnd": 90,
                           "pinnedBy": "teacher"}}]
    assert main.rebound_annotations(human, 32) == human
    auto = [{"location": {"grounded": True, "measureStart": 90, "pinnedBy": "auto"}}]
    assert main.rebound_annotations(auto, None) == auto  # no piece = no bound
    assert main.piece_measures({"measures": 0}) is None
    assert main.piece_measures(None) is None
    assert main.piece_measures({"measures": 32}) == 32


# --- fetch_job tuple shape: 14 columns, owner_role in the position process() expects ---

FETCH_ROW_14 = ("job-1", "queued", 0, "lesson-1", "owner-9", None, "piece-1",
                "Etude No. 3", "audio/a.m4a", 300, "student",
                "Etude No. 3", "Czerny", None)


def test_fetch_job_selects_14_columns_with_owner_role_after_duration():
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14})
    row = main.fetch_job(conn, "job-1")
    assert row == FETCH_ROW_14
    sql = conn.executed[0][0]
    cols = [c.strip() for c in sql.split("SELECT ")[1].split(" FROM ")[0].split(",")]
    assert len(cols) == 14
    assert cols[9] == "l.duration_sec"
    assert cols[10] == "l.owner_role"
    assert cols[11] == "p.title"


def test_process_unpacks_14_field_row():
    # Terminal status → process returns right after the unpack; a wrong arity
    # in either fetch_job or the destructuring raises ValueError here.
    row = list(FETCH_ROW_14)
    row[1] = "ready_for_review"
    conn = FakeConn({"FROM note_jobs j": tuple(row)})
    main.process(conn, None, "", "job-1")
    assert len(conn.executed) == 1  # fetch only — skip path touched nothing else


# --- metrics: process() seeds metrics with owner_role ---

class FakeBlobService:
    def __init__(self):
        self.uploads = []
        self.deletes = []
        self._path = None

    def get_container_client(self, container):
        return self

    def get_blob_client(self, path):
        self._path = path
        return self

    def upload_blob(self, data, **kwargs):
        self.uploads.append((self._path, data))

    def delete_blob(self):
        self.deletes.append(self._path)


def _update_cols(sql):
    return [seg.split(" = ")[0].strip()
            for seg in sql.split(" SET ")[1].split(" WHERE ")[0].split(",")]


def test_process_seeds_metrics_with_owner_role(monkeypatch):
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT status FROM lesson_sessions": ("submitted",),
        LOCK: solo_lock(published_version=4),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-9",),
    })
    blob = FakeBlobService()
    monkeypatch.setattr(main, "env", lambda n: "test-key")
    monkeypatch.setattr(main, "audio_read_url", lambda cs, p: "https://audio?sas")
    monkeypatch.setattr(main, "run_asr", lambda url, key: {
        "text": "plenty of lesson talk", "utterances": [],
        "language_code": "en", "audio_duration": 300})
    monkeypatch.setattr(main, "check_transcript", lambda text, utt: {"transcript_words": 100})
    monkeypatch.setattr(main, "ContentSettings", lambda **k: None)
    monkeypatch.setattr(main, "generate", lambda s, u: SimpleNamespace(
        text="x", model="test-model", in_tok=10, out_tok=20))
    monkeypatch.setattr(main, "extract_json", lambda t: dict(ORIGINAL))
    monkeypatch.setattr(main, "normalize_note", lambda obj, text, mc: (CONTENT, ANNS, [], []))

    main.process(conn, blob, "cs", "job-9", req_id="req-1")

    assert blob.uploads and blob.uploads[0][0] == "transcripts/job-9.json"
    updates = [(s, p) for s, p in conn.executed if s.startswith("UPDATE note_jobs")]
    final_sql, final_params = updates[-1]
    cols = _update_cols(final_sql)
    assert final_params[cols.index("status")] == "ready_for_review"
    metrics = json.loads(final_params[cols.index("metrics")])
    assert metrics["owner_role"] == "student"
    # solo note actually landed through replace_draft under process()
    assert any(s.startswith("INSERT INTO notes") for s, _ in conn.executed)


# --- R4: failure_code map ---------------------------------------------------

def _codes_written(conn):
    out = []
    for sql, params in conn.executed:
        if not sql.startswith("UPDATE note_jobs"):
            continue
        cols = _update_cols(sql)
        if "failure_code" in cols:
            out.append((params[cols.index("status")] if "status" in cols else None,
                        params[cols.index("failure_code")]))
    return out


def _process_env(monkeypatch, *, asr=None, normalize=None):
    monkeypatch.setattr(main, "env", lambda n: "test-key")
    monkeypatch.setattr(main, "audio_read_url", lambda cs, p: "https://audio?sas")
    monkeypatch.setattr(main, "run_asr", asr or (lambda url, key: {
        "text": "plenty of lesson talk", "utterances": [],
        "language_code": "en", "audio_duration": 300}))
    monkeypatch.setattr(main, "check_transcript", lambda text, utt: {"transcript_words": 100})
    monkeypatch.setattr(main, "ContentSettings", lambda **k: None)
    monkeypatch.setattr(main, "generate", lambda s, u: SimpleNamespace(
        text="x", model="test-model", in_tok=10, out_tok=20))
    monkeypatch.setattr(main, "extract_json", lambda t: dict(ORIGINAL))
    monkeypatch.setattr(main, "normalize_note",
                        normalize or (lambda obj, text, mc: (CONTENT, ANNS, [], [])))


LIVE_LESSON = {"SELECT status FROM lesson_sessions": ("submitted",)}


def test_gate_fails_carry_codes_that_reach_failure_code():
    # The real gates raise the real codes, and the real handler writes them.
    from pipeline import check_transcript, normalize_note
    with pytest.raises(main.GateFail) as silent:
        check_transcript("too short", [])
    assert silent.value.code == "no_speech"
    with pytest.raises(main.GateFail) as thin:
        normalize_note({"lesson_summary": "s", "annotations": [], "practice_plan": []}, "x", 32)
    assert thin.value.code == "thin_note"

    for gf, expected in ((silent.value, "no_speech"), (thin.value, "thin_note")):
        conn = FakeConn({})
        main.record_gate_fail(conn, "job-1", gf)
        assert _codes_written(conn) == [("failed", expected)]


def test_missing_audio_writes_no_audio():
    row = list(FETCH_ROW_14)
    row[8] = None  # audio_path
    conn = FakeConn({"FROM note_jobs j": tuple(row)})
    main.process(conn, None, "cs", "job-1")
    assert _codes_written(conn) == [("failed", "no_audio")]


def test_asr_failure_writes_asr_error_and_never_crashes_out(monkeypatch):
    def boom(url, key):
        raise RuntimeError("assemblyai transcription did not complete within 2400s")
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14})
    _process_env(monkeypatch, asr=boom)
    main.process(conn, FakeBlobService(), "cs", "job-1")
    # 'processing' clears the previous code; the failure then stamps asr_error.
    assert _codes_written(conn) == [("processing", None), ("failed", "asr_error")]


def test_second_llm_shape_failure_writes_llm_invalid(monkeypatch):
    def always_bad(obj, text, mc):
        raise ValueError("lesson_summary missing or empty")
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON})
    _process_env(monkeypatch, normalize=always_bad)
    main.process(conn, FakeBlobService(), "cs", "job-1")
    assert _codes_written(conn)[-1] == ("failed", "llm_invalid")
    assert not any("ready_for_review" in str(p) for _, p in conn.executed)


def test_worker_crash_handler_stamps_its_code_and_spares_a_delivered_job():
    conn = FakeConn({})
    main.mark_worker_crash(conn, "job-1")
    sql, params = conn.executed[0]
    assert "failure_code = 'worker_crash'" in sql
    assert "status <> 'ready_for_review'" in sql
    assert params == ("job-1",)


# --- R4: the discard-vs-worker race (r4_verify M2 / M3) ----------------------

def test_replace_draft_drops_everything_when_the_lesson_was_discarded():
    conn = FakeConn({LOCK: teacher_lock(status="canceled")})
    assert main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS) is None
    # The guard SELECT and nothing else: no wipe, no insert, no annotations.
    assert len(conn.executed) == 1
    assert conn.executed[0][0].endswith(LOCK)
    assert conn.commits == 1


def test_discard_before_note_insert_never_flips_the_job_to_ready(monkeypatch):
    # Live through ASR and the transcript stamp, canceled by the time the note
    # would be inserted (the FOR UPDATE read is what sees it).
    conn = FakeConn({
        LOCK: teacher_lock(status="canceled"),
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT status FROM lesson_sessions": ("submitted",),
    })
    blob = FakeBlobService()
    _process_env(monkeypatch)
    main.process(conn, blob, "cs", "job-9")
    assert not any(s.startswith("INSERT INTO notes") for s, _ in conn.executed)
    assert not any("ready_for_review" in str(p) for _, p in conn.executed)
    assert _codes_written(conn)[-1] == ("failed", "lesson_discarded")
    # metrics carry quoted instruction text — a discarded job must not gain them.
    assert not any("metrics" in _update_cols(s) for s, _ in conn.executed
                   if s.startswith("UPDATE note_jobs"))


def test_discard_before_asr_never_submits_and_never_says_asr_error(monkeypatch):
    # DI-7 / IN-10: the check used to sit downstream of the ASR submit and of the
    # failure-code labelling, so an owner-initiated discard was attributed to
    # asr_error in the facet this batch added.
    submitted = []
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT status FROM lesson_sessions": ("canceled",),
    })
    blob = FakeBlobService()
    _process_env(monkeypatch, asr=lambda url, key: submitted.append(url) or {})
    main.process(conn, blob, "cs", "job-9")
    assert submitted == []
    assert blob.uploads == []
    # never even claimed the job: no 'processing' stamp, one terminal write
    assert _codes_written(conn) == [("failed", "lesson_discarded")]


def test_discard_during_asr_uploads_no_transcript_at_all(monkeypatch):
    # Live at the pre-ASR check, canceled by the time ASR returns.
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT status FROM lesson_sessions": [("submitted",), ("canceled",)],
    })
    blob = FakeBlobService()
    _process_env(monkeypatch)
    main.process(conn, blob, "cs", "job-9")
    assert blob.uploads == []
    assert not any("transcript_path" in _update_cols(s) for s, _ in conn.executed
                   if s.startswith("UPDATE note_jobs") and " SET " in s)
    assert _codes_written(conn) == [("processing", None), ("failed", "lesson_discarded")]


def test_asr_outrunning_the_check_deletes_the_transcript_it_just_wrote(monkeypatch):
    # The pre-check passes, the discard commits mid-upload, so the conditional
    # stamp matches no rows: notes-assets has no lifecycle rule, so the blob we
    # wrote must be deleted rather than left permanent behind a nulled column.
    conn = FakeConn(
        {"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON},
        rowcounts={"UPDATE note_jobs j SET transcript_path": 0},
    )
    blob = FakeBlobService()
    _process_env(monkeypatch)
    main.process(conn, blob, "cs", "job-9")
    assert blob.uploads and blob.uploads[0][0] == "transcripts/job-9.json"
    assert blob.deletes == ["transcripts/job-9.json"]
    assert not any(s.startswith("INSERT INTO notes") for s, _ in conn.executed)
    assert _codes_written(conn)[-1] == ("failed", "lesson_discarded")


def test_live_lesson_still_stamps_the_transcript_and_finishes(monkeypatch):
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        **LIVE_LESSON,
        LOCK: solo_lock(published_version=4),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-9",),
    })
    blob = FakeBlobService()
    _process_env(monkeypatch)
    main.process(conn, blob, "cs", "job-9")
    assert blob.deletes == []
    stamp = [s for s, _ in conn.executed if s.startswith("UPDATE note_jobs j SET transcript_path")]
    assert len(stamp) == 1 and "l.status <> 'canceled'" in stamp[0]
    final_sql, final_params = [(s, p) for s, p in conn.executed if s.startswith("UPDATE note_jobs")][-1]
    cols = _update_cols(final_sql)
    assert final_params[cols.index("status")] == "ready_for_review"
