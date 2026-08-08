"""B6-1: the ready flip is conditional and drives exactly one ready-push.

Same fake-conn discipline as test_replace_draft: no real DB, no real socket. The
process() drive-through is fully stubbed at its seams so the assertion is about the
wiring — which flip fires the POST — and nothing else.
"""
import json
import sys
import types
from pathlib import Path

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
        self.rowcount = self._conn.rowcount_for(norm(sql))

    def fetchone(self):
        return None


class FakeConn:
    def __init__(self, rowcounts=None):
        self.rowcounts = rowcounts or {}
        self.executed = []
        self.commits = 0

    def rowcount_for(self, sql):
        for frag, val in self.rowcounts.items():
            if frag in sql:
                return val
        return 1

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1


METRICS = {"annotations": 3, "grounded": 2}


def test_mark_ready_flips_once_and_guards_on_the_current_status():
    conn = FakeConn()
    assert main.mark_ready(conn, "job-1", METRICS) is True
    sql, params = conn.executed[0]
    assert sql.endswith("WHERE id = %s AND status <> 'ready_for_review'")
    assert params[0] == "ready_for_review"
    assert params[1] is None
    assert json.loads(params[2]) == METRICS
    assert params[3] == "job-1"
    assert conn.commits == 1


def test_mark_ready_reports_false_when_another_delivery_already_flipped():
    conn = FakeConn(rowcounts={"status <> 'ready_for_review'": 0})
    assert main.mark_ready(conn, "job-1", METRICS) is False


def test_post_ready_push_calls_the_internal_route_with_the_key(monkeypatch, capsys):
    monkeypatch.setenv("API_INTERNAL_BASE_URL", "https://api.internal/")
    monkeypatch.setenv("INTERNAL_API_KEY", "s3cret")
    calls = []
    monkeypatch.setattr(main.requests, "post",
                        lambda url, **kw: calls.append((url, kw)) or types.SimpleNamespace(status_code=200))

    main.post_ready_push("job-9")

    assert len(calls) == 1
    url, kw = calls[0]
    assert url == "https://api.internal/internal/notes/job-9/ready-push"
    assert kw["headers"] == {"X-Internal-Key": "s3cret"}
    assert kw["timeout"] == 5
    assert "ready_push_failed" not in capsys.readouterr().out


def test_a_refused_push_is_logged_as_a_warning_not_a_job_failure(monkeypatch, capsys):
    monkeypatch.setenv("API_INTERNAL_BASE_URL", "https://api.internal")
    monkeypatch.setenv("INTERNAL_API_KEY", "wrong-key")
    monkeypatch.setattr(main.requests, "post",
                        lambda url, **kw: types.SimpleNamespace(status_code=401))

    main.post_ready_push("job-9")

    line = json.loads(capsys.readouterr().out.strip())
    assert line["event"] == "ready_push_failed" and line["status"] == 401
    assert line["level"] == "warn"


def test_post_ready_push_sends_nothing_when_unconfigured(monkeypatch, capsys):
    monkeypatch.delenv("API_INTERNAL_BASE_URL", raising=False)
    monkeypatch.delenv("INTERNAL_API_KEY", raising=False)
    monkeypatch.setattr(main.requests, "post",
                        lambda *a, **kw: pytest.fail("unconfigured push must not leave the container"))

    main.post_ready_push("job-9")

    line = json.loads(capsys.readouterr().out.strip())
    assert line == {"kind": "notes-worker", "level": "warn", "job": "job-9",
                    "event": "ready_push_failed", "reason": "unconfigured"}


def test_post_ready_push_swallows_a_dead_api(monkeypatch):
    monkeypatch.setenv("API_INTERNAL_BASE_URL", "https://api.internal")
    monkeypatch.setenv("INTERNAL_API_KEY", "s3cret")

    def boom(*a, **kw):
        raise ConnectionError("no route to host")

    monkeypatch.setattr(main.requests, "post", boom)
    main.post_ready_push("job-9")  # must not raise


def stub_pipeline(monkeypatch, status="queued", flipped_rowcount=1, real_push=False):
    """Everything process() needs, replaced at its seams. Returns the recorder."""
    seen = {"pushed": [], "narrated": [], "conn": FakeConn(rowcounts={
        "status <> 'ready_for_review'": flipped_rowcount})}

    row = ("job-1", status, 0, "lesson-1", "teacher-7", "student-4", "piece-1",
           "Etude No. 3", "audio/x.m4a", 600, "teacher", "Etude", "Czerny", None)
    monkeypatch.setattr(main, "fetch_job", lambda conn, job_id: row)
    monkeypatch.setattr(main, "lesson_canceled", lambda conn, lesson_id: False)
    monkeypatch.setattr(main, "update_job", lambda conn, job_id, **cols: None)
    monkeypatch.setattr(main, "audio_read_url", lambda cs, path: "https://blob/x")
    monkeypatch.setattr(main, "run_asr", lambda url, key: {
        "text": "play bar 3 slowly", "utterances": [], "language_code": "en",
        "audio_duration": 600})
    monkeypatch.setattr(main, "stamp_transcript", lambda conn, job_id, path: True)
    monkeypatch.setattr(main, "ContentSettings", lambda **k: None)
    monkeypatch.setattr(main, "delete_vendor_transcript", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(main, "check_transcript", lambda text, utts: {})
    monkeypatch.setattr(main, "generate", lambda system, user: types.SimpleNamespace(
        text="{}", model="m", in_tok=1, out_tok=1))
    monkeypatch.setattr(main, "extract_json", lambda text: {})
    monkeypatch.setattr(main, "normalize_note", lambda obj, text, mc: (
        {"lesson_summary": "s"},
        [{"category": "technique", "instruction": "i", "quote": "q",
          "location": {"grounded": True}}],
        [], []))
    monkeypatch.setattr(main, "replace_draft",
                        lambda conn, job_id, lesson_id, content, original, anns: "note-1")
    monkeypatch.setattr(main, "narration_stage",
                        lambda conn, blob, note_id, req_id: seen["narrated"].append(note_id))
    if not real_push:
        monkeypatch.setattr(main, "post_ready_push", lambda job_id: seen["pushed"].append(job_id))
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "k")

    class FakeBlobClient:
        def upload_blob(self, *a, **kw):
            pass

    class FakeContainer:
        def get_blob_client(self, path):
            return FakeBlobClient()

    seen["blob"] = types.SimpleNamespace(get_container_client=lambda name: FakeContainer())
    return seen


def test_a_genuine_transition_pushes_exactly_once(monkeypatch):
    seen = stub_pipeline(monkeypatch)
    main.process(seen["conn"], seen["blob"], "cs", "job-1")
    assert seen["pushed"] == ["job-1"]


def test_a_redelivered_ready_job_never_pushes_again(monkeypatch):
    seen = stub_pipeline(monkeypatch, status="ready_for_review")
    main.process(seen["conn"], seen["blob"], "cs", "job-1")
    assert seen["pushed"] == []


def test_a_delivery_that_loses_the_flip_race_never_pushes(monkeypatch):
    seen = stub_pipeline(monkeypatch, status="processing", flipped_rowcount=0)
    main.process(seen["conn"], seen["blob"], "cs", "job-1")
    assert seen["pushed"] == []


def test_the_job_still_completes_when_the_push_fails(monkeypatch):
    seen = stub_pipeline(monkeypatch, real_push=True)
    monkeypatch.setenv("API_INTERNAL_BASE_URL", "https://api.internal")
    monkeypatch.setenv("INTERNAL_API_KEY", "s3cret")

    def boom(*a, **kw):
        raise ConnectionError("api is down")

    monkeypatch.setattr(main.requests, "post", boom)

    main.process(seen["conn"], seen["blob"], "cs", "job-1")

    assert any("ready_for_review" in sql for sql, _ in seen["conn"].executed)
    assert seen["narrated"] == ["note-1"]
