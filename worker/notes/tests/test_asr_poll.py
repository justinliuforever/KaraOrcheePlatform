import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# main.py imports azure/psycopg at module load; stub the heavy ones so the pure
# ASR-polling logic can be tested without the SDKs installed.
for name in ("azure", "azure.servicebus", "azure.storage", "azure.storage.blob", "psycopg"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["azure.servicebus"].AutoLockRenewer = object
sys.modules["azure.servicebus"].ServiceBusClient = object
blobmod = sys.modules["azure.storage.blob"]
for attr in ("BlobSasPermissions", "BlobServiceClient", "ContentSettings", "generate_blob_sas"):
    setattr(blobmod, attr, object)

import main  # noqa: E402


class Resp:
    def __init__(self, status=200, payload=None, raise_exc=None):
        self.status_code = status
        self._payload = payload or {}
        self._raise = raise_exc

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise main.requests.HTTPError(f"status {self.status_code}")


def test_run_asr_polls_until_completed(monkeypatch):
    posts = iter([Resp(200, {"id": "t1"})])
    gets = iter([Resp(200, {"status": "queued"}),
                 Resp(200, {"status": "processing"}),
                 Resp(200, {"status": "completed", "text": "hi", "utterances": []})])
    monkeypatch.setattr(main.requests, "post", lambda *a, **k: next(posts))
    monkeypatch.setattr(main.requests, "get", lambda *a, **k: next(gets))
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)
    j = main.run_asr("https://blob/audio?sas", "key")
    assert j["status"] == "completed"


def test_run_asr_error_status_raises(monkeypatch):
    monkeypatch.setattr(main.requests, "post", lambda *a, **k: Resp(200, {"id": "t2"}))
    monkeypatch.setattr(main.requests, "get", lambda *a, **k: Resp(200, {"status": "error", "error": "bad audio"}))
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)
    with pytest.raises(RuntimeError, match="bad audio"):
        main.run_asr("https://blob/audio?sas", "key")


def test_run_asr_caps_polling(monkeypatch):
    monkeypatch.setattr(main, "ASR_POLL_MAX", 10)
    monkeypatch.setattr(main, "ASR_POLL_INTERVAL", 5)
    monkeypatch.setattr(main.requests, "post", lambda *a, **k: Resp(200, {"id": "t3"}))
    monkeypatch.setattr(main.requests, "get", lambda *a, **k: Resp(200, {"status": "processing"}))
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)
    with pytest.raises(RuntimeError, match="did not complete"):
        main.run_asr("https://blob/audio?sas", "key")


def test_get_with_retry_recovers_from_transient(monkeypatch):
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] < 3:
            raise main.requests.ConnectionError("boom")
        return Resp(200, {"ok": True})

    monkeypatch.setattr(main.requests, "get", flaky)
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)
    r = main._get_with_retry("https://x", {})
    assert r.json()["ok"] is True
    assert calls["n"] == 3


def test_get_with_retry_gives_up(monkeypatch):
    monkeypatch.setattr(main.requests, "get",
                        lambda *a, **k: (_ for _ in ()).throw(main.requests.ConnectionError("down")))
    monkeypatch.setattr(main.time, "sleep", lambda *_: None)
    with pytest.raises(main.requests.ConnectionError):
        main._get_with_retry("https://x", {}, attempts=2)
