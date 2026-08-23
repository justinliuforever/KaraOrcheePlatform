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

    def fetchall(self):
        v = self._conn._pending
        if v is None:
            return []
        return v if isinstance(v, list) else [v]


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
        # The database assigns slot ids; a test only scripts one when it asserts on it.
        if "INSERT INTO note_pieces" in sql:
            return ("slot-1",)
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


LOCK = "FOR UPDATE OF l"


def note_insert(conn) -> dict:
    """Column name -> written value, skipping the columns the statement writes as
    literals. Positional indices re-point silently when a column joins the list
    between two others; names do not."""
    sql, params = next((s, p) for s, p in conn.executed if s.startswith("INSERT INTO notes"))
    head, _, tail = sql.partition(") VALUES (")
    cols = [c.strip() for c in head[head.index("(") + 1:].split(",")]
    slots = tail.replace("now()", "now").split(")")[0].split(",")
    return dict(zip([c for c, s in zip(cols, slots) if s.strip() == "%s"], params))


def teacher_lock(status="submitted", student_id="student-4", piece_id="piece-1",
                 piece_label="Etude No. 3", custom_piece_id=None, score_scan_id=None,
                 published_version=3, facts=None):
    return (status, "teacher-7", student_id, piece_id, piece_label, custom_piece_id,
            score_scan_id, "teacher", published_version, facts)


def solo_lock(status="submitted", piece_id="piece-1", piece_label="Etude No. 3",
              custom_piece_id=None, score_scan_id=None, published_version=7, facts=None):
    return (status, "owner-9", None, piece_id, piece_label, custom_piece_id, score_scan_id,
            "student", published_version, facts)


def test_teacher_path_wipes_draft_then_inserts_teacher_origin():
    conn = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-1",)})
    nid = main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert nid == "note-1"
    sqls = [s for s, _ in conn.executed]
    assert sqls[0].startswith("SELECT l.status, l.teacher_id") and sqls[0].endswith(LOCK)
    assert conn.executed[0][1] == ("lesson-1",)
    assert sqls[1].startswith("SELECT lp.id, lp.piece_id"), "the planned list is read under the same lock"
    assert sqls[2].startswith("SELECT score_scan_id FROM notes") and "status = 'draft'" in sqls[2]
    assert sqls[3].startswith("DELETE FROM practice_items") and "status = 'draft'" in sqls[3]
    assert sqls[4] == "DELETE FROM notes WHERE note_job_id = %s AND status = 'draft'"
    assert sqls[5].startswith("INSERT INTO notes") and "'teacher'" in sqls[5]
    assert "'sent'" not in sqls[5] and "sent_at" not in sqls[5]
    assert "INSERT INTO note_pieces" in sqls[6], "the note's own slot is minted with it"
    assert all("INSERT INTO practice_items" in s for s in sqls[7:])
    assert len(sqls) == 7 + len(ANNS)
    assert not any(s.startswith("SELECT published_version") or "origin = 'self'" in s
                   for s in sqls)
    w = note_insert(conn)
    assert w["teacher_id"] == "teacher-7" and w["student_id"] == "student-4"
    assert json.loads(w["content_original"]) == ORIGINAL and json.loads(w["content"]) == CONTENT
    assert conn.commits == 1


def test_plan_sidecar_starts_every_entry_on_the_lessons_piece():
    import uuid
    planned = dict(CONTENT, practicePlan=[
        {"focus": "Hands separately", "steps": ["RH alone", "LH alone"], "target": "even"},
        {"focus": "Pedal on its own", "steps": [], "target": ""},
    ])
    # A real driver hands back uuid.UUID, not str; the sidecar dump crashed on exactly that in prod.
    slot = uuid.UUID("00000000-0000-4000-8000-000000000001")
    conn = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-1",),
                     "INSERT INTO note_pieces": (slot,)})
    main.replace_draft(conn, "job-1", "lesson-1", planned, ORIGINAL, ANNS)
    updates = [(s, p) for s, p in conn.executed if s.startswith("UPDATE notes SET plan_piece_ids")]
    assert len(updates) == 1
    assert json.loads(updates[0][1][0]) == [str(slot), str(slot)],         "one assignment per practicePlan ENTRY, not per flattened step row"
    assert updates[0][1][1] == "note-1"


def test_plan_sidecar_stays_unwritten_when_the_lesson_names_nothing():
    planned = dict(CONTENT, practicePlan=[{"focus": "Slow work", "steps": ["half speed"], "target": ""}])
    conn = FakeConn({LOCK: teacher_lock(piece_id=None, piece_label=None), "INSERT INTO notes": ("note-1",)})
    main.replace_draft(conn, "job-1", "lesson-1", planned, ORIGINAL, ANNS)
    assert not any(s.startswith("UPDATE notes SET plan_piece_ids") for s, _ in conn.executed)


PLANNED_SEL = "SELECT lp.id, lp.piece_id"


def test_a_planned_lesson_mints_every_slot_and_parks_the_rows_in_general():
    planned_rows = [
        ("lp-1", "piece-1", None, None, None, 3, {"measures": 32}, "Sonatina"),
        ("lp-2", None, "My etude", None, None, None, None, None),
    ]
    planned = dict(CONTENT, practicePlan=[{"focus": "Slow work", "steps": ["half speed"], "target": ""}])
    # A scripted [ [rows...] ] pops once and hands fetchall the whole list.
    conn = FakeConn({LOCK: teacher_lock(), PLANNED_SEL: [planned_rows],
                     "INSERT INTO notes": ("note-1",)})
    main.replace_draft(conn, "job-1", "lesson-1", planned, ORIGINAL, ANNS)
    slots = [(s, p) for s, p in conn.executed if s.startswith("INSERT INTO note_pieces")]
    assert [(p[1], p[2], p[3]) for _, p in slots] == [(0, "piece-1", None), (1000, None, "My etude")]
    items = [p for s, p in conn.executed if s.startswith("INSERT INTO practice_items")]
    assert items and all(p[-2] is None and p[-1] is None for p in items), \
        "every row starts in General: nothing in a whole-lesson recording says which sentence belongs where"
    assert not any(s.startswith("UPDATE notes SET plan_piece_ids") for s, _ in conn.executed)


def test_piece_summaries_land_on_their_own_slots_and_nowhere_else():
    planned_rows = [
        ("lp-1", "piece-1", None, None, None, 3, {"measures": 32}, "Sonatina"),
        ("lp-2", None, "My etude", None, None, None, None, None),
    ]
    conn = FakeConn({LOCK: teacher_lock(), PLANNED_SEL: [planned_rows],
                     "INSERT INTO notes": ("note-1",)})
    main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS,
                       piece_summaries={"Sonatina": "Even sixteenths arrived.",
                                        "Nonexistent": "must not land"})
    slots = [p for sql, p in conn.executed if sql.startswith("INSERT INTO note_pieces")]
    assert [p[-1] for p in slots] == ["Even sixteenths arrived.", None], \
        "the catalog-titled slot gets its summary; the label-only slot got none and stays null"


def test_summary_names_must_match_exactly():
    got = main.normalize_piece_summaries(
        {"piece_summaries": [
            {"piece": "Sonatina", "summary": " Solid tone. "},
            {"piece": "sonatina", "summary": "case-mangled, dropped"},
            {"piece": "Sonatina", "summary": "duplicate, dropped"},
            {"piece": "Etude", "summary": "   "},
            "not-a-dict",
        ]},
        ["Sonatina", "Etude"])
    assert got == {"Sonatina": "Solid tone."}


def test_the_grounding_bound_is_the_shortest_planned_piece():
    planned_rows = [
        ("lp-1", "piece-1", None, None, None, 3, {"measures": 8}, "Short piece"),
        ("lp-2", "piece-2", None, None, None, 1, {"measures": 32}, "Long piece"),
    ]
    anns = [{"category": "technique", "instruction": "Bar twelve.", "quote": "bar twelve",
             "location": {"raw": "bar 12", "grounded": True, "measureStart": 12, "measureEnd": 12,
                          "pinnedBy": "auto"}}]
    conn = FakeConn({LOCK: teacher_lock(facts={"measures": 32}), PLANNED_SEL: [planned_rows],
                     "INSERT INTO notes": ("note-1",)})
    main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, anns)
    items = [p for s, p in conn.executed if s.startswith("INSERT INTO practice_items")]
    assert len(items) == 1
    loc = json.loads(items[0][5])
    assert loc["grounded"] is False, \
        "bar 12 exceeds the 8-bar piece, and a grounded General row lights whichever score is on screen"


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
    assert sqls[1].startswith("SELECT lp.id, lp.piece_id")  # the planned list, under the same lock
    assert "origin = 'self' AND status = 'sent'" in sqls[2]  # insert-guard next
    assert sqls[3].startswith("INSERT INTO notes")
    assert "'self', 'sent', now()" in sqls[3]  # origin/status literal, sent_at set
    w = note_insert(conn)
    assert w["note_job_id"] == "job-2" and w["lesson_session_id"] == "lesson-1"
    assert w["teacher_id"] == "owner-9" and w["student_id"] == "owner-9"  # owner is both
    assert w["piece_version"] == 7                  # from published_version
    assert json.loads(w["content_original"]) == ORIGINAL and json.loads(w["content"]) == CONTENT
    slot = [s for s, _ in conn.executed if s.startswith("INSERT INTO note_pieces")]
    assert len(slot) == 1, "the note's own slot is minted with it"
    ann = [e for e in conn.executed if e[0].startswith("INSERT INTO practice_items")]
    assert len(ann) == len(ANNS)
    assert all(s.startswith("INSERT INTO practice_items") for s, _ in ann)
    assert all(params[0] == "note-2" for _, params in ann)
    assert conn.commits == 1


def test_solo_piece_version_null_when_no_piece():
    conn = FakeConn({
        LOCK: solo_lock(piece_id=None, published_version=None),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-3",),
    })
    main.replace_draft(conn, "job-3", "lesson-1", CONTENT, ORIGINAL, ANNS)
    w = note_insert(conn)
    assert w["piece_id"] is None
    assert w["piece_version"] is None


def test_lesson_row_gone_is_treated_as_discarded():
    conn = FakeConn({LOCK: None})
    assert main.replace_draft(conn, "job-4", "lesson-1", CONTENT, ORIGINAL, ANNS) is None
    assert len(conn.executed) == 1
    assert conn.commits == 1


def test_solo_insert_guard_converges_without_second_insert():
    conn = FakeConn({
        LOCK: solo_lock(),
        "SELECT id FROM notes WHERE note_job_id": ("existing-note",),
    })
    nid = main.replace_draft(conn, "job-2", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert nid == "existing-note"
    assert len(conn.executed) == 3
    sql, params = conn.executed[2]
    assert sql.startswith("SELECT id FROM notes")
    assert "origin = 'self'" in sql and "status = 'sent'" in sql
    assert params == ("job-2",)
    assert conn.commits == 1  # still commits (closes the transaction cleanly)


def test_student_reassigned_mid_run_is_the_one_the_note_is_written_to():
    conn = FakeConn({
        LOCK: teacher_lock(student_id="student-bob"),
        "INSERT INTO notes": ("note-5",),
    })
    main.replace_draft(conn, "job-5", "lesson-1", CONTENT, ORIGINAL, ANNS)
    w = note_insert(conn)
    assert w["student_id"] == "student-bob"
    assert "student-4" not in [str(v) for v in w.values()]


def test_piece_named_mid_run_lands_on_the_note_with_its_version():
    conn = FakeConn({
        LOCK: solo_lock(piece_id="short_piece", piece_label="Op. 100 No. 2",
                        published_version=5),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-6",),
    })
    main.replace_draft(conn, "job-6", "lesson-1", CONTENT, ORIGINAL, ANNS)
    w = note_insert(conn)
    assert w["piece_id"] == "short_piece"
    assert w["piece_label"] == "Op. 100 No. 2"
    assert w["piece_version"] == 5         # from the same locked read


def test_a_piece_named_mid_run_bounds_the_grounding_it_never_had():
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
            if s.startswith("INSERT INTO practice_items")]
    assert locs[0]["grounded"] is False
    assert "measureStart" not in locs[0] and "pinnedBy" not in locs[0]
    assert locs[0]["raw"] == "bar 84"           # the words survive as the clue
    assert locs[0]["hint"] == main.REGROUND_HINT
    assert locs[1]["grounded"] is True and locs[1]["measureStart"] == 4
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
    row = list(FETCH_ROW_14)
    row[1] = "ready_for_review"
    conn = FakeConn({"FROM note_jobs j": tuple(row)})
    main.process(conn, None, "", "job-1")
    assert len(conn.executed) == 1  # fetch only — skip path touched nothing else


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
    assert any(s.startswith("INSERT INTO notes") for s, _ in conn.executed)


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
    monkeypatch.setattr(main, "delete_vendor_transcript", lambda *a: None)
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


def test_replace_draft_drops_everything_when_the_lesson_was_discarded():
    conn = FakeConn({LOCK: teacher_lock(status="canceled")})
    assert main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS) is None
    assert len(conn.executed) == 1
    assert conn.executed[0][0].endswith(LOCK)
    assert conn.commits == 1


def test_discard_before_note_insert_never_flips_the_job_to_ready(monkeypatch):
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
    assert not any("metrics" in _update_cols(s) for s, _ in conn.executed
                   if s.startswith("UPDATE note_jobs"))


def test_discard_before_asr_never_submits_and_never_says_asr_error(monkeypatch):
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
    assert _codes_written(conn) == [("failed", "lesson_discarded")]


def test_discard_during_asr_uploads_no_transcript_at_all(monkeypatch):
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


def test_the_note_inherits_the_lessons_custom_piece_entity():
    teacher = FakeConn({LOCK: teacher_lock(custom_piece_id="entity-1"),
                        "INSERT INTO notes": ("note-1",)})
    main.replace_draft(teacher, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(teacher)["custom_piece_id"] == "entity-1"

    solo = FakeConn({LOCK: solo_lock(custom_piece_id="entity-2"),
                     "SELECT id FROM notes WHERE note_job_id": None,
                     "INSERT INTO notes": ("note-2",)})
    main.replace_draft(solo, "job-2", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(solo)["custom_piece_id"] == "entity-2"

    unfiled = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-3",)})
    main.replace_draft(unfiled, "job-3", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(unfiled)["custom_piece_id"] is None


CARRY = "SELECT score_scan_id FROM notes"
SCAN_LOCK = "SELECT id FROM score_scans"


def test_a_scan_attached_to_the_draft_survives_the_rebuild():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None), CARRY: ("scan-1",),
                     SCAN_LOCK: ("scan-1",), "INSERT INTO notes": ("note-1",)})
    main.replace_draft(conn, "job-1", "lesson-1", CONTENT, ORIGINAL, ANNS)
    sqls = [s for s, _ in conn.executed]
    read = next(i for i, s in enumerate(sqls) if s.startswith(CARRY))
    wipes = [i for i, s in enumerate(sqls) if s.startswith("DELETE")]
    assert read < min(wipes)
    assert conn.executed[read][1] == ("job-1",)
    assert "status = 'draft'" in sqls[read]
    assert note_insert(conn)["score_scan_id"] == "scan-1"


def test_a_draft_with_no_scan_rebuilds_with_a_null_reference():
    conn = FakeConn({LOCK: teacher_lock(), CARRY: None,
                     "INSERT INTO notes": ("note-2",)})
    main.replace_draft(conn, "job-2", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] is None


def test_the_rebuild_never_writes_the_detached_marker():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None), CARRY: ("scan-1",),
                     SCAN_LOCK: ("scan-1",), "INSERT INTO notes": ("note-3",)})
    main.replace_draft(conn, "job-3", "lesson-1", CONTENT, ORIGINAL, ANNS)
    sqls = [s for s, _ in conn.executed]
    assert not any("score_scan_detached_at" in s for s in sqls)


def test_a_rebuild_onto_a_lesson_with_a_piece_carries_no_scan():
    conn = FakeConn({LOCK: teacher_lock(piece_id="piece-1"), CARRY: ("scan-1",),
                     SCAN_LOCK: ("scan-1",), "INSERT INTO notes": ("note-4",)})
    main.replace_draft(conn, "job-4", "lesson-1", CONTENT, ORIGINAL, ANNS)
    w = note_insert(conn)
    assert w["piece_id"] == "piece-1"
    assert w["score_scan_id"] is None
    assert not any(s.startswith(SCAN_LOCK) for s, _ in conn.executed)


def test_a_scan_deleted_before_the_insert_is_carried_as_null_instead_of_violating_the_key():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None), CARRY: ("scan-1",),
                     SCAN_LOCK: None, "INSERT INTO notes": ("note-5",)})
    main.replace_draft(conn, "job-5", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] is None


def test_the_carried_scan_is_locked_before_the_draft_is_deleted():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None), CARRY: ("scan-1",),
                     SCAN_LOCK: ("scan-1",), "INSERT INTO notes": ("note-6",)})
    main.replace_draft(conn, "job-6", "lesson-1", CONTENT, ORIGINAL, ANNS)
    sqls = [s for s, _ in conn.executed]
    held = next(i for i, s in enumerate(sqls) if s.startswith(SCAN_LOCK))
    assert sqls[held].endswith("FOR UPDATE")
    assert conn.executed[held][1] == ("scan-1",)
    assert held < min(i for i, s in enumerate(sqls) if s.startswith("DELETE"))


def test_the_solo_path_reads_no_draft_because_it_never_wipes_a_note():
    resumed = FakeConn({LOCK: solo_lock(),
                        "SELECT id FROM notes WHERE note_job_id": ("existing-note",)})
    assert main.replace_draft(
        resumed, "job-4", "lesson-1", CONTENT, ORIGINAL, ANNS) == "existing-note"
    assert not any(s.startswith("DELETE") or s.startswith(CARRY) or s.startswith(SCAN_LOCK)
                   for s, _ in resumed.executed)

    fresh = FakeConn({LOCK: solo_lock(),
                      "SELECT id FROM notes WHERE note_job_id": None,
                      "INSERT INTO notes": ("note-5",)})
    main.replace_draft(fresh, "job-5", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(fresh)["score_scan_id"] is None
    assert not any(s.startswith(CARRY) for s, _ in fresh.executed)


def test_a_solo_lesson_photographed_at_the_start_reaches_the_note_it_produces():
    conn = FakeConn({LOCK: solo_lock(piece_id=None, score_scan_id="scan-8"),
                     "SELECT id FROM notes WHERE note_job_id": None,
                     SCAN_LOCK: ("scan-8",), "INSERT INTO notes": ("note-6",)})
    main.replace_draft(conn, "job-6", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] == "scan-8"


def test_a_solo_lesson_that_names_a_piece_carries_no_scan():
    conn = FakeConn({LOCK: solo_lock(piece_id="piece-1", score_scan_id="scan-8"),
                     "SELECT id FROM notes WHERE note_job_id": None,
                     SCAN_LOCK: ("scan-8",), "INSERT INTO notes": ("note-7",)})
    main.replace_draft(conn, "job-7", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] is None
    assert not any(s.startswith(SCAN_LOCK) for s, _ in conn.executed)


def test_a_lesson_photographed_at_the_start_reaches_the_teacher_draft():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None, score_scan_id="scan-9"),
                     CARRY: None, SCAN_LOCK: ("scan-9",),
                     "INSERT INTO notes": ("note-8",)})
    main.replace_draft(conn, "job-8", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] == "scan-9"


def test_the_scan_the_teacher_attached_at_review_outranks_the_lessons_own():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None, score_scan_id="scan-lesson"),
                     CARRY: ("scan-review",), SCAN_LOCK: ("scan-review",),
                     "INSERT INTO notes": ("note-9",)})
    main.replace_draft(conn, "job-9", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] == "scan-review"
    held = next(p for s, p in conn.executed if s.startswith(SCAN_LOCK))
    assert held == ("scan-review",)


def test_a_lesson_whose_scan_was_taken_down_produces_a_note_without_it():
    conn = FakeConn({LOCK: teacher_lock(piece_id=None, score_scan_id="scan-10"),
                     CARRY: None, SCAN_LOCK: None, "INSERT INTO notes": ("note-10",)})
    main.replace_draft(conn, "job-10", "lesson-1", CONTENT, ORIGINAL, ANNS)
    assert note_insert(conn)["score_scan_id"] is None
    held = next(s for s, _ in conn.executed if s.startswith(SCAN_LOCK))
    assert "status <> 'taken_down'" in held


def _job_mentions(conn):
    for sql, params in conn.executed:
        if sql.startswith("UPDATE note_jobs SET") and "piece_mentions" in sql:
            return json.loads(params[_update_cols(sql).index("piece_mentions")])
    return None


def _mentions_conn():
    return FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        **LIVE_LESSON,
        LOCK: solo_lock(),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-9",),
    })


def test_the_job_records_only_the_mentions_the_transcript_actually_contains(monkeypatch):
    conn = _mentions_conn()
    _process_env(monkeypatch)
    monkeypatch.setenv("NOTES_PIECE_MENTIONS", "1")
    monkeypatch.setattr(main, "extract_json", lambda t: {
        **ORIGINAL, "piece_mentions": ["plenty of lesson talk", "the Arabesque"]})
    main.process(conn, FakeBlobService(), "cs", "job-9")
    assert _job_mentions(conn) == ["plenty of lesson talk"]


def test_a_job_whose_model_named_nothing_records_an_empty_list_not_a_missing_write(monkeypatch):
    conn = _mentions_conn()
    _process_env(monkeypatch)
    monkeypatch.setenv("NOTES_PIECE_MENTIONS", "1")
    main.process(conn, FakeBlobService(), "cs", "job-9")
    assert _job_mentions(conn) == []


def test_a_model_that_volunteers_mentions_while_the_flag_is_off_stores_none(monkeypatch):
    conn = _mentions_conn()
    _process_env(monkeypatch)
    monkeypatch.delenv("NOTES_PIECE_MENTIONS", raising=False)
    monkeypatch.setattr(main, "extract_json", lambda t: {
        **ORIGINAL, "piece_mentions": ["plenty of lesson talk"]})
    main.process(conn, FakeBlobService(), "cs", "job-9")
    assert _job_mentions(conn) == []


def test_plan_rows_land_beside_the_transcript_rows_without_disturbing_them():
    conn = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-1",)})
    content = {"lessonSummary": "s", "practicePlan": [
        {"focus": "Evenness", "steps": ["Hands separate at 60", "Add the pedal last"], "target": "Four clean runs"},
    ]}
    main.replace_draft(conn, "job-1", "lesson-1", content, ORIGINAL, ANNS)

    inserts = [(s, p) for s, p in conn.executed if s.startswith("INSERT INTO practice_items")]
    transcript = [p for s, p in inserts if "'plan'" not in s]
    plan = [p for s, p in inserts if "'plan'" in s]
    assert len(transcript) == len(ANNS)
    assert len(plan) == 2
    # idx continues past the transcript rows so the two orderings never interleave.
    assert [p[1] for p in transcript] == [0, 1]
    assert [p[1] for p in plan] == [2, 3]
    assert plan[0][2] == "Hands separate at 60"
    assert plan[0][3] == "Evenness" and plan[0][4] == "Four clean runs"


def test_a_plan_entry_with_no_steps_still_keeps_its_words():
    conn = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-1",)})
    content = {"lessonSummary": "s", "practicePlan": [
        {"focus": "Sight-reading every day", "steps": [], "target": ""},
    ]}
    main.replace_draft(conn, "job-1", "lesson-1", content, ORIGINAL, ANNS)

    plan = [p for s, p in conn.executed if s.startswith("INSERT INTO practice_items") and "'plan'" in s]
    assert len(plan) == 1
    assert plan[0][2] == "Sight-reading every day"


def test_no_plan_means_no_plan_rows():
    conn = FakeConn({LOCK: teacher_lock(), "INSERT INTO notes": ("note-1",)})
    main.replace_draft(conn, "job-1", "lesson-1", {"lessonSummary": "s", "practicePlan": []}, ORIGINAL, ANNS)

    plan = [s for s, _ in conn.executed if s.startswith("INSERT INTO practice_items") and "'plan'" in s]
    assert plan == []
