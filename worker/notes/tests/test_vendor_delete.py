"""A3 step 2: the transcript is verbatim lesson speech, often a minor's, and the
privacy notice says we instruct the vendor to delete its copy once ours is stored.
These tests hold that sentence to the code — the call is made, it carries the
transcript id, it happens only after our copy is durable, and its failure is a
logged fault that never costs the teacher a note.
"""
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for name in ("azure", "azure.servicebus", "azure.storage", "azure.storage.blob", "psycopg"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["azure.servicebus"].AutoLockRenewer = object
sys.modules["azure.servicebus"].ServiceBusClient = object
for attr in ("BlobSasPermissions", "BlobServiceClient", "ContentSettings", "generate_blob_sas"):
    setattr(sys.modules["azure.storage.blob"], attr, object)

import main  # noqa: E402
import obs  # noqa: E402
from test_replace_draft import (CONTENT, FETCH_ROW_14, LIVE_LESSON,  # noqa: E402
                                FakeBlobService, FakeConn, ANNS, ORIGINAL,
                                _codes_written, solo_lock)

TRANSCRIPT_ID = "asr-9f2c"


class Resp:
    def __init__(self, status=200):
        self.status_code = status


def _asr_env(monkeypatch, deletes, responses=None):
    """Everything process() needs except the vendor delete, which stays real."""
    monkeypatch.setattr(main, "env", lambda n: "vendor-key")
    monkeypatch.setattr(main, "audio_read_url", lambda cs, p: "https://audio?sas")
    monkeypatch.setattr(main, "run_asr", lambda url, key: {
        "id": TRANSCRIPT_ID, "text": "plenty of lesson talk", "utterances": [],
        "language_code": "en", "audio_duration": 300})
    monkeypatch.setattr(main, "check_transcript", lambda text, utt: {"transcript_words": 100})
    monkeypatch.setattr(main, "ContentSettings", lambda **k: None)
    monkeypatch.setattr(main, "generate", lambda s, u: SimpleNamespace(
        text="x", model="test-model", in_tok=10, out_tok=20))
    monkeypatch.setattr(main, "extract_json", lambda t: dict(ORIGINAL))
    monkeypatch.setattr(main, "normalize_note", lambda obj, text, mc: (CONTENT, ANNS, [], []))
    monkeypatch.setattr(main, "post_ready_push", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)

    scripted = iter(responses or [])

    def fake_delete(url, headers=None, timeout=None):
        deletes.append((url, headers, timeout))
        try:
            outcome = next(scripted)
        except StopIteration:
            outcome = Resp(200)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(main.requests, "delete", fake_delete)


def _live_conn():
    return FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT status FROM lesson_sessions": ("submitted",),
        "FOR UPDATE OF l": solo_lock(published_version=4),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-9",),
    })


def _events(capsys):
    return [json.loads(l) for l in capsys.readouterr().out.strip().splitlines() if l]


def _delivered(conn, events) -> bool:
    """The note reached its owner: it was inserted, the job logged `done`, and no
    terminal failure was recorded."""
    return (any(s.startswith("INSERT INTO notes") for s, _ in conn.executed)
            and any(e["event"] == "done" for e in events)
            and _codes_written(conn) == [("processing", None)])


def test_a_delivered_job_tells_the_vendor_to_delete_its_copy(monkeypatch, capsys):
    deletes = []
    _asr_env(monkeypatch, deletes)
    conn, blob = _live_conn(), FakeBlobService()

    main.process(conn, blob, "cs", "job-9")

    assert len(deletes) == 1
    url, headers, _ = deletes[0]
    assert url == f"{main.ASR_BASE}/transcript/{TRANSCRIPT_ID}"
    assert headers == {"authorization": "vendor-key"}
    assert _delivered(conn, _events(capsys))


def test_the_vendor_is_told_only_after_our_copy_is_durable(monkeypatch):
    # Delete-then-store would leave a window with no copy anywhere if the stamp lost.
    order = []
    deletes = []
    _asr_env(monkeypatch, deletes)
    conn, blob = _live_conn(), FakeBlobService()
    real_upload = blob.upload_blob
    real_stamp = main.stamp_transcript

    def watched_upload(data, **kwargs):
        if blob._path.startswith(main.TRANSCRIPT_PREFIX):
            order.append("upload")
        real_upload(data, **kwargs)

    def watched_stamp(*a, **k):
        order.append("stamp")
        return real_stamp(*a, **k)

    blob.upload_blob = watched_upload
    monkeypatch.setattr(main, "stamp_transcript", watched_stamp)
    monkeypatch.setattr(main, "delete_vendor_transcript",
                        lambda *a: order.append("vendor_delete"))

    main.process(conn, blob, "cs", "job-9")

    assert order[:3] == ["upload", "stamp", "vendor_delete"]


def test_a_discard_during_the_run_still_retires_the_vendor_copy(monkeypatch):
    deletes = []
    _asr_env(monkeypatch, deletes)
    # live at the pre-ASR check, canceled by the time the transcript would be written
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14,
                     "SELECT status FROM lesson_sessions": [("submitted",), ("canceled",)]})
    blob = FakeBlobService()

    main.process(conn, blob, "cs", "job-9")

    assert [u for u, _, _ in deletes] == [f"{main.ASR_BASE}/transcript/{TRANSCRIPT_ID}"]
    assert blob.uploads == []


def test_a_discard_that_beats_the_stamp_retires_both_copies(monkeypatch):
    deletes = []
    _asr_env(monkeypatch, deletes)
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON},
                    rowcounts={"SET transcript_path": 0})
    blob = FakeBlobService()

    main.process(conn, blob, "cs", "job-9")

    assert blob.deletes == ["transcripts/job-9.json"]
    assert len(deletes) == 1


def test_a_vendor_that_refuses_costs_the_teacher_nothing_and_is_logged(monkeypatch, capsys):
    deletes = []
    _asr_env(monkeypatch, deletes,
             responses=[Resp(500), main.requests.ConnectionError("down"), Resp(503)])
    conn, blob = _live_conn(), FakeBlobService()

    main.process(conn, blob, "cs", "job-9")

    assert len(deletes) == 3
    events = _events(capsys)
    failed = [e for e in events if e["event"] == "asr_vendor_delete_failed"]
    assert len(failed) == 1
    assert failed[0]["transcript"] == TRANSCRIPT_ID
    assert failed[0]["error"] == "status 503"
    assert failed[0]["level"] == "error"
    assert _delivered(conn, events)


def test_a_rejection_the_vendor_will_repeat_is_not_retried(monkeypatch):
    deletes = []
    _asr_env(monkeypatch, deletes, responses=[Resp(401)])
    main.delete_vendor_transcript("job-9", TRANSCRIPT_ID, "vendor-key")
    assert len(deletes) == 1


def test_an_already_absent_transcript_is_not_reported_as_a_failure(monkeypatch, capsys):
    deletes = []
    _asr_env(monkeypatch, deletes, responses=[Resp(404)])
    main.delete_vendor_transcript("job-9", TRANSCRIPT_ID, "vendor-key")
    assert len(deletes) == 1
    assert capsys.readouterr().out == ""


def test_a_missing_transcript_id_is_never_silent(monkeypatch, capsys):
    deletes = []
    _asr_env(monkeypatch, deletes)
    main.delete_vendor_transcript("job-9", None, "vendor-key")
    assert deletes == []
    line = json.loads(capsys.readouterr().out.strip())
    assert line["event"] == "asr_vendor_delete_failed" and line["level"] == "error"


def test_the_failure_reaches_the_ops_error_tier():
    assert obs.level_for("asr_vendor_delete_failed") == "error"
