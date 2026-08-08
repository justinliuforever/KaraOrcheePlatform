"""Failure diagnosability: the Ops severity a worker event carries, and the model
output an unexplained "processing failed" needs. Reuses the fake conn/blob harness
shape from test_replace_draft.py — no DB, no network."""
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
for attr in ("BlobSasPermissions", "BlobServiceClient", "ContentSettings", "generate_blob_sas"):
    setattr(sys.modules["azure.storage.blob"], attr, object)

import main  # noqa: E402
import obs  # noqa: E402
from pipeline import GateFail, drop_reasons, normalize_note  # noqa: E402
from test_replace_draft import (FETCH_ROW_14, LIVE_LESSON, FakeBlobService,  # noqa: E402
                                FakeConn, _codes_written, _process_env, _update_cols,
                                solo_lock)

TRANSCRIPT = ("Let's look at bar three. The left hand D to F sharp leap needs to be "
              "prepared in advance. Circle those two bars where the change happens. " * 4)


def test_every_jlog_event_the_worker_emits_has_a_deliberate_level():
    source = (Path(main.__file__).parent / "main.py").read_text()
    source += (Path(main.__file__).parent / "narration.py").read_text()
    emitted = set()
    for chunk in source.split("event=")[1:]:
        token = chunk.split(",")[0].split(")")[0].strip()
        if token.startswith('"') and token.endswith('"'):
            emitted.add(token.strip('"'))
    classified = obs.ERROR_EVENTS | obs.WARN_EVENTS | {"start", "done", "skip", "up", "narration"}
    assert len(emitted) >= 15, "the scrape stopped finding call sites — fix it, don't pass vacuously"
    assert emitted - classified == set(), "unclassified jlog events default to info"


def test_failure_events_log_at_error_and_recoveries_at_warn(capsys):
    for event in ("gate_fail", "asr_fail", "llm_invalid", "worker_crash", "asset_delete_failed"):
        main.jlog(job="j", event=event)
    for event in ("llm_repair", "drop", "model_output_unwritten"):
        main.jlog(job="j", event=event)
    main.jlog(job="j", event="done")
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    assert [l["level"] for l in lines] == ["error"] * 5 + ["warn"] * 3 + ["info"]
    assert {l["kind"] for l in lines} == {"notes-worker"}


def test_a_crashing_message_names_its_job_in_a_structured_error_line(capsys):
    main.jlog(job="job-1", event="worker_crash", error="KeyError: 'jobId'")
    line = json.loads(capsys.readouterr().out.strip())
    assert line["level"] == "error" and line["job"] == "job-1"


def _obj(annotations):
    return {"lesson_summary": "Summary.", "annotations": annotations, "practice_plan": []}


GOOD = {"instruction": "Prepare the leap.",
        "quote": "The left hand D to F sharp leap needs to be prepared in advance",
        "category": "technique", "location": {"type": "none"}}
INVENTED = {"instruction": "Practise with a metronome every day.",
            "quote": "use a metronome every single day", "category": "practice_strategy",
            "location": {"type": "none"}}


def test_a_dropped_annotation_is_named_with_its_index_reason_and_text():
    _, annotations, warnings, drops = normalize_note(
        _obj([GOOD, INVENTED, dict(GOOD, instruction="Circle the change.",
                                   quote="Circle those two bars where the change happens")]),
        TRANSCRIPT, 32)
    assert len(annotations) == 2
    assert len(drops) == 1
    assert drops[0]["index"] == 1
    assert drops[0]["reason"] == "unverifiable_quote"
    assert drops[0]["instruction"] == INVENTED["instruction"]
    assert drops[0]["quote"] == INVENTED["quote"]
    assert warnings == [f"dropped_unverifiable_quote: {INVENTED['instruction'][:60]}"]
    assert drop_reasons(drops) == {"unverifiable_quote": 1}


def test_the_thin_note_gate_carries_what_it_rejected():
    with pytest.raises(GateFail) as exc:
        normalize_note(_obj([GOOD, INVENTED]), TRANSCRIPT, 32)
    gf = exc.value
    assert gf.code == "thin_note"
    assert gf.evidence["annotations_in"] == 2 and gf.evidence["kept"] == 1
    assert [d["reason"] for d in gf.evidence["drops"]] == ["unverifiable_quote"]


def test_malformed_annotations_are_dropped_with_a_reason_not_silently():
    _, _, _, drops = normalize_note(
        _obj(["not a dict", {"instruction": "  ", "quote": "x"}, GOOD,
              dict(GOOD, instruction="Circle the change.",
                   quote="Circle those two bars where the change happens")]),
        TRANSCRIPT, 32)
    assert [(d["index"], d["reason"]) for d in drops] == [(0, "not_an_object"), (1, "empty_instruction")]


MODEL_TEXT = '{"lesson_summary": "s", "annotations": [], "practice_plan": []}'


def _uploaded(blob, prefix):
    return [(p, json.loads(b)) for p, b in blob.uploads if p.startswith(prefix)]


def test_a_gate_failure_persists_the_model_output_that_explains_it(monkeypatch):
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON})
    blob = FakeBlobService()

    def thin(obj, text, mc):
        raise GateFail("Too little teaching talk.", ["hint"], code="thin_note",
                       evidence={"annotations_in": 3, "kept": 1,
                                 "drops": [{"index": 1, "reason": "unverifiable_quote",
                                            "instruction": "Keep the wrist loose",
                                            "quote": "never said this"}]})

    _process_env(monkeypatch, normalize=thin)
    monkeypatch.setattr(main, "generate", lambda s, u: SimpleNamespace(
        text=MODEL_TEXT, model="claude-sonnet-5", in_tok=900, out_tok=120))

    with pytest.raises(GateFail) as exc:
        main.process(conn, blob, "cs", "job-9")

    path, payload = _uploaded(blob, main.MODEL_OUTPUT_PREFIX)[0]
    assert path == "transcripts/model-output/job-9.json"
    assert path.startswith(main.TRANSCRIPT_PREFIX)
    assert payload["outcome"] == "thin_note" and payload["stage"] == "gates"
    assert payload["attempts"][0]["text"] == MODEL_TEXT
    assert payload["attempts"][0]["model"] == "claude-sonnet-5"
    assert payload["evidence"]["drops"][0]["quote"] == "never said this"

    stamp = [s for s, _ in conn.executed if "SET model_output_path" in s]
    assert len(stamp) == 1 and "l.status <> 'canceled'" in stamp[0]

    gf = exc.value
    assert gf.artifact == path
    assert gf.metrics["annotations_in"] == 3 and gf.metrics["kept"] == 1
    assert gf.metrics["llm_model"] == "claude-sonnet-5"
    assert "drops" not in gf.metrics
    assert not any("never said this" in json.dumps(v) for v in gf.metrics.values())

    fail_conn = FakeConn({})
    main.record_gate_fail(fail_conn, "job-9", gf)
    assert _codes_written(fail_conn) == [("failed", "thin_note")]
    sql, params = fail_conn.executed[0]
    assert json.loads(params[_update_cols(sql).index("metrics")])["kept"] == 1


def test_llm_invalid_keeps_both_rejected_outputs_and_each_validator_message(monkeypatch):
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON})
    blob = FakeBlobService()
    texts = iter(["not json at all", "still ```json {nope}"])
    _process_env(monkeypatch, normalize=None)
    monkeypatch.setattr(main, "generate", lambda s, u: SimpleNamespace(
        text=next(texts), model="claude-sonnet-5", in_tok=1, out_tok=2))
    monkeypatch.setattr(main, "extract_json", lambda t: (_ for _ in ()).throw(
        ValueError(f"output is not valid JSON: {t[:12]}")))

    main.process(conn, blob, "cs", "job-9")

    _, payload = _uploaded(blob, main.MODEL_OUTPUT_PREFIX)[0]
    assert [a["n"] for a in payload["attempts"]] == [1, 2]
    assert payload["attempts"][0]["text"] == "not json at all"
    assert payload["attempts"][1]["text"] == "still ```json {nope}"
    assert "not valid JSON" in payload["attempts"][0]["error"]
    assert payload["outcome"] == "llm_invalid"
    assert _codes_written(conn)[-1] == ("failed", "llm_invalid")
    final_sql, final_params = [(s, p) for s, p in conn.executed if s.startswith("UPDATE note_jobs")][-1]
    metrics = json.loads(final_params[_update_cols(final_sql).index("metrics")])
    assert metrics["llm_model"] == "claude-sonnet-5" and "llm_secs" in metrics


def test_a_delivered_note_that_lost_annotations_keeps_the_same_evidence(monkeypatch):
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        **LIVE_LESSON,
        "FOR UPDATE OF l": solo_lock(),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-9",),
    })
    blob = FakeBlobService()
    drops = [{"index": 0, "reason": "unverifiable_quote", "instruction": "Invented",
              "quote": "never said"}]
    _process_env(monkeypatch, normalize=lambda obj, text, mc: (
        {"lessonSummary": "s"},
        [{"category": "technique", "instruction": "i", "quote": "q", "location": {}},
         {"category": "rhythm", "instruction": "j", "quote": "k", "location": {}}],
        ["dropped_unverifiable_quote: Invented"], drops))

    main.process(conn, blob, "cs", "job-9")

    _, payload = _uploaded(blob, main.MODEL_OUTPUT_PREFIX)[0]
    assert payload["outcome"] == "delivered"
    assert payload["evidence"]["drops"] == drops
    final_sql, final_params = [(s, p) for s, p in conn.executed if s.startswith("UPDATE note_jobs")][-1]
    cols = _update_cols(final_sql)
    assert final_params[cols.index("status")] == "ready_for_review"
    metrics = json.loads(final_params[cols.index("metrics")])
    assert metrics["dropped"] == 1 and metrics["drop_reasons"] == {"unverifiable_quote": 1}


def test_a_clean_first_pass_writes_no_artifact_at_all(monkeypatch):
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        **LIVE_LESSON,
        "FOR UPDATE OF l": solo_lock(),
        "SELECT id FROM notes WHERE note_job_id": None,
        "INSERT INTO notes": ("note-9",),
    })
    blob = FakeBlobService()
    _process_env(monkeypatch)
    main.process(conn, blob, "cs", "job-9")
    assert _uploaded(blob, main.MODEL_OUTPUT_PREFIX) == []


def test_no_speech_reports_how_much_speech_there_actually_was(monkeypatch):
    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON})
    blob = FakeBlobService()
    _process_env(monkeypatch)
    monkeypatch.setattr(main, "check_transcript", lambda text, utt: (_ for _ in ()).throw(
        GateFail("Very little speech.", ["hint"], code="no_speech",
                 evidence={"transcript_words": 11, "min_transcript_words": 50})))

    with pytest.raises(GateFail) as exc:
        main.process(conn, blob, "cs", "job-9")
    assert exc.value.metrics["transcript_words"] == 11
    assert exc.value.metrics["min_transcript_words"] == 50
    assert _uploaded(blob, main.MODEL_OUTPUT_PREFIX) == []


def test_a_discard_landing_mid_write_deletes_the_artifact_it_just_wrote(monkeypatch):
    conn = FakeConn(
        {"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON},
        rowcounts={"SET model_output_path": 0},
    )
    blob = FakeBlobService()
    _process_env(monkeypatch, normalize=lambda obj, text, mc: (_ for _ in ()).throw(
        ValueError("lesson_summary missing or empty")))
    main.process(conn, blob, "cs", "job-9")
    assert blob.deletes == ["transcripts/model-output/job-9.json"]


def test_a_lesson_already_discarded_is_never_given_a_new_artifact(monkeypatch):
    conn = FakeConn({
        "FROM note_jobs j": FETCH_ROW_14,
        "SELECT status FROM lesson_sessions": [("submitted",), ("submitted",), ("canceled",)],
    })
    blob = FakeBlobService()
    _process_env(monkeypatch, normalize=lambda obj, text, mc: (_ for _ in ()).throw(
        ValueError("lesson_summary missing or empty")))
    main.process(conn, blob, "cs", "job-9")
    assert _uploaded(blob, main.MODEL_OUTPUT_PREFIX) == []
    assert not any("SET model_output_path" in s for s, _ in conn.executed)


def test_a_blob_that_refuses_the_artifact_never_takes_the_job_down(monkeypatch, capsys):
    class BrokenBlob(FakeBlobService):
        def upload_blob(self, data, **kwargs):
            if self._path.startswith(main.MODEL_OUTPUT_PREFIX):
                raise RuntimeError("storage unavailable")
            super().upload_blob(data, **kwargs)

    conn = FakeConn({"FROM note_jobs j": FETCH_ROW_14, **LIVE_LESSON})
    _process_env(monkeypatch, normalize=lambda obj, text, mc: (_ for _ in ()).throw(
        ValueError("lesson_summary missing or empty")))
    main.process(conn, BrokenBlob(), "cs", "job-9")
    assert _codes_written(conn)[-1] == ("failed", "llm_invalid")
    events = [json.loads(l)["event"] for l in capsys.readouterr().out.strip().splitlines()]
    assert "model_output_unwritten" in events
