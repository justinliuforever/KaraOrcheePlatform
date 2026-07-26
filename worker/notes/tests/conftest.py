"""Suite-wide lockout. The narration stage bills a per-character vendor account, so no
test in this directory may open a socket: outbound HTTP and raw connects both raise, and
ElevenLabsSynthesizer refuses to construct while PYTEST_CURRENT_TEST is set. A test that
wants vendor behaviour injects a fake synthesizer."""
import socket
import sys
import types
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# main.py imports the azure/psycopg SDKs at module load; stub them so every test file
# imports standalone.
for name in ("azure", "azure.servicebus", "azure.storage", "azure.storage.blob", "psycopg"):
    sys.modules.setdefault(name, types.ModuleType(name))
for attr in ("AutoLockRenewer", "ServiceBusClient"):
    setattr(sys.modules["azure.servicebus"], attr, object)
for attr in ("BlobSasPermissions", "BlobServiceClient", "ContentSettings", "generate_blob_sas"):
    setattr(sys.modules["azure.storage.blob"], attr, object)


class NetworkBlocked(RuntimeError):
    pass


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise NetworkBlocked(f"outbound network is blocked in tests: {args[:1]}")

    for verb in ("request", "get", "post", "put", "patch", "delete", "head"):
        monkeypatch.setattr(requests, verb, blocked)
    monkeypatch.setattr(requests.sessions.Session, "request", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
