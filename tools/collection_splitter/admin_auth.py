#!/usr/bin/env python3
"""Durable admin auth: MSAL device flow ONCE, then silent refresh forever.

The refresh token lives in a 0600 cache file and is exchanged automatically, so
batch tools never need another interactive sign-in. Import `token()` from here;
run this file directly to perform (or verify) the one-time sign-in.
"""
from __future__ import annotations

import atexit
import os
import sys
import time
from pathlib import Path

import msal

AUTHORITY = "https://karaorcheeauth.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b"
CLIENT = "4a12e0a8-c0b8-4770-a182-0f02626c7dc5"  # public client (iOS app registration)
SCOPE = ["api://4a12e0a8-c0b8-4770-a182-0f02626c7dc5/access_as_user"]
CACHE = Path.home() / ".karaorchee_admin_cache.json"
LEGACY_TOKEN = Path.home() / ".karaorchee_admin_token"


def _app() -> msal.PublicClientApplication:
    cache = msal.SerializableTokenCache()
    if CACHE.exists():
        cache.deserialize(CACHE.read_text())

    def _save():
        if cache.has_state_changed:
            CACHE.write_text(cache.serialize())
            os.chmod(CACHE, 0o600)

    atexit.register(_save)
    return msal.PublicClientApplication(CLIENT, authority=AUTHORITY, token_cache=cache)


def token(interactive_ok: bool = True) -> str:
    """A valid access token. Silent-refreshes from the cached refresh token; falls
    back to device flow only when no usable refresh token exists."""
    app = _app()
    for account in app.get_accounts():
        result = app.acquire_token_silent(SCOPE, account=account)
        if result and "access_token" in result:
            return result["access_token"]
    if not interactive_ok:
        raise SystemExit("no cached credential — run tools/collection_splitter/admin_auth.py")
    flow = app.initiate_device_flow(scopes=SCOPE)
    if "user_code" not in flow:
        raise SystemExit(f"device flow unavailable: {flow}")
    print(flow["message"], flush=True)
    # Poll the flow ourselves: MSAL only retries on the literal error code
    # "authorization_pending", and this CIAM tenant answers a not-yet-approved
    # device with a different code carrying AADSTS70016 — which made MSAL's own
    # loop give up on the first poll, before the operator could type the code.
    deadline = time.time() + int(flow.get("expires_in", 900))
    interval = max(int(flow.get("interval", 5)), 5)
    while time.time() < deadline:
        result = app.acquire_token_by_device_flow(flow, exit_condition=lambda f: True)
        if "access_token" in result:
            return result["access_token"]
        blob = f"{result.get('error', '')} {result.get('error_description', '')}"
        if not ("AADSTS70016" in blob or "authorization_pending" in blob
                or "slow_down" in blob):
            raise SystemExit(f"sign-in failed: {blob}"[:400])
        if "slow_down" in blob:
            interval += 5
        time.sleep(interval)
    raise SystemExit("device code expired before it was approved — run this again")


if __name__ == "__main__":
    quiet = "--check" in sys.argv
    try:
        t = token(interactive_ok=not quiet)
    except SystemExit as err:
        print(err)
        raise
    LEGACY_TOKEN.write_text(t)
    os.chmod(LEGACY_TOKEN, 0o600)
    app = _app()
    who = [a.get("username") for a in app.get_accounts()]
    print(f"OK — signed in as {who}; refresh token cached at {CACHE}")
    print("Batch tools now authenticate silently; no further manual sign-in needed.")
