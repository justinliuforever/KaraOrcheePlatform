"""B1.5 solo finalize branch: replace_draft teacher/solo paths, the BK-1
insert-guard, fetch_job arity (owner_role), and owner_role in job metrics.
All DB access goes through a fake psycopg-style conn that records executed
SQL + params and returns scripted fetchone rows — no real DB or network."""
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

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

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self._conn.executed.append((norm(sql), params))
        self._conn._pending = self._conn.script(norm(sql))

    def fetchone(self):
        return self._conn._pending


class FakeConn:
    """Records every (sql, params); fetchone returns the scripted row for the
    most recently executed statement (first matching fragment wins)."""

    def __init__(self, rows: dict):
        self.rows = rows
        self.executed = []
        self.commits = 0
        self._pending = None

    def script(self, sql):
        for frag, val in self.rows.items():
            if frag in sql:
                return val
        return None

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


def teacher_lesson():
    return ("lesson-1", "teacher-7", "student-4", "piece-1", "Etude No. 3", "teacher")


def solo_lesson(piece_id="piece-1"):
    # Solo lesson_sessions carry no student_id; the owner is teacher_id.
    return ("lesson-1", "owner-9", None, piece_id, "Etude No. 3", "student")


# --- replace_draft: teacher path (pre-B1.5 behavior, byte-for-byte sequence) ---

def test_teacher_path_wipes_draft_then_inserts_teacher_origin():
    conn = FakeConn({"INSERT INTO notes": ("note-1",)})
    nid = main.replace_draft(conn, "job-1", teacher_lesson(), CONTENT, ORIGINAL, ANNS)
    assert nid == "note-1"
    sqls = [s for s, _ in conn.executed]
    assert sqls[0].startswith("DELETE FROM note_annotations") and "status = 'draft'" in sqls[0]
    assert sqls[1] == "DELETE FROM notes WHERE note_job_id = %s AND status = 'draft'"
    assert sqls[2].startswith("INSERT INTO notes") and "'teacher'" in sqls[2]
    assert "'sent'" not in sqls[2] and "sent_at" not in sqls[2]
    assert all("INSERT INTO note_annotations" in s for s in sqls[3:])
    assert len(sqls) == 3 + len(ANNS)
    # no solo-only queries leak into the teacher path
    assert not any("published_version" in s or "origin = 'self'" in s for s in sqls)
    p = conn.executed[2][1]
    assert p[2] == "teacher-7" and p[3] == "student-4"  # student_id passed through
    assert json.loads(p[6]) == ORIGINAL and json.loads(p[7]) == CONTENT
    assert conn.commits == 1


# --- replace_draft: solo path (born 'sent' to the owner) ---

def test_solo_first_run_inserts_one_born_sent_note():
    conn = FakeConn({
        "SELECT id FROM notes WHERE note_job_id": None,   # guard: nothing yet
        "SELECT published_version": (7,),
        "INSERT INTO notes": ("note-2",),
    })
    nid = main.replace_draft(conn, "job-2", solo_lesson(), CONTENT, ORIGINAL, ANNS)
    assert nid == "note-2"
    sqls = [s for s, _ in conn.executed]
    assert not any(s.startswith("DELETE") for s in sqls)  # solo never wipes
    assert "origin = 'self' AND status = 'sent'" in sqls[0]  # guard runs first
    assert sqls[1].startswith("SELECT published_version FROM pieces")
    assert conn.executed[1][1] == ("piece-1",)
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
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-3",),
    })
    main.replace_draft(conn, "job-3", solo_lesson(piece_id=None), CONTENT, ORIGINAL, ANNS)
    sqls = [s for s, _ in conn.executed]
    assert not any("published_version" in s for s in sqls)  # lookup skipped entirely
    ins = next(i for i, s in enumerate(sqls) if s.startswith("INSERT INTO notes"))
    assert conn.executed[ins][1][6] is None


def test_solo_piece_version_null_when_piece_row_missing():
    conn = FakeConn({
        "SELECT id FROM notes WHERE note_job_id": None,
        "SELECT published_version": None,  # piece_id present but row gone
        "INSERT INTO notes": ("note-4",),
    })
    main.replace_draft(conn, "job-4", solo_lesson(), CONTENT, ORIGINAL, ANNS)
    ins = next(i for i, (s, _) in enumerate(conn.executed) if s.startswith("INSERT INTO notes"))
    assert conn.executed[ins][1][6] is None


# --- BK-1: insert-guard idempotency (redelivered/requeued solo job = no-op) ---

def test_solo_insert_guard_converges_without_second_insert():
    conn = FakeConn({"SELECT id FROM notes WHERE note_job_id": ("existing-note",)})
    nid = main.replace_draft(conn, "job-2", solo_lesson(), CONTENT, ORIGINAL, ANNS)
    assert nid == "existing-note"
    assert len(conn.executed) == 1  # guard SELECT only — no INSERT, no annotations
    sql, params = conn.executed[0]
    assert sql.startswith("SELECT id FROM notes")
    assert "origin = 'self'" in sql and "status = 'sent'" in sql
    assert params == ("job-2",)
    assert conn.commits == 1  # still commits (closes the transaction cleanly)


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
        self._path = None

    def get_container_client(self, container):
        return self

    def get_blob_client(self, path):
        self._path = path
        return self

    def upload_blob(self, data, **kwargs):
        self.uploads.append((self._path, data))


def _update_cols(sql):
    return [seg.split(" = ")[0].strip()
            for seg in sql.split(" SET ")[1].split(" WHERE ")[0].split(",")]


def test_process_seeds_metrics_with_owner_role(monkeypatch):
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT id FROM notes WHERE note_job_id": None,
        "SELECT published_version": (4,),
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
    monkeypatch.setattr(main, "normalize_note", lambda obj, text, mc: (CONTENT, ANNS, []))

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
