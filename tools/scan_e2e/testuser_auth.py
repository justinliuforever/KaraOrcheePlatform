#!/usr/bin/env python3
"""Device-code sign-in for the throwaway dev Notes account.

Its own cache file, so it can never overwrite the admin credential the batch tools use.
Run once interactively; every later run refreshes silently.
"""
from __future__ import annotations

import atexit
import os
import sys
from pathlib import Path

import msal

AUTHORITY = "https://karaorcheeauth.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b"
CLIENT = "4a12e0a8-c0b8-4770-a182-0f02626c7dc5"
SCOPE = ["api://4a12e0a8-c0b8-4770-a182-0f02626c7dc5/access_as_user"]
CACHE = Path.home() / ".karaorchee_scan_testuser_cache.json"


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
    app = _app()
    for account in app.get_accounts():
        result = app.acquire_token_silent(SCOPE, account=account)
        if result and "access_token" in result:
            return result["access_token"]
    if not interactive_ok:
        raise SystemExit("no cached credential — run tools/scan_e2e/testuser_auth.py")
    flow = app.initiate_device_flow(scopes=SCOPE)
    if "user_code" not in flow:
        raise SystemExit(f"device flow refused: {flow}")
    print(flow["message"], flush=True)
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise SystemExit(f"sign-in failed: {result.get('error_description', result)}")
    return result["access_token"]


if __name__ == "__main__":
    import urllib.request, json
    t = token()
    req = urllib.request.Request(
        "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io/v1/me",
        headers={"Authorization": "Bearer " + t})
    try:
        with urllib.request.urlopen(req) as r:
            me = json.load(r)
        print(f"signed in — notes user exists: {me.get('email')} "
              f"teacher={me.get('isTeacher')} student={me.get('isStudent')}")
    except Exception as exc:
        print(f"signed in to CIAM, but /v1/me says: {exc}")
        print("next step: POST /v1/users/sync with role=teacher to create the Notes row")
    print(f"cached at {CACHE}")
