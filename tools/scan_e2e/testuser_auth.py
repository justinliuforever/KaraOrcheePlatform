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
# One cache per account: a second role signing in must not evict the first.
ACCOUNT = os.environ.get("KARAORCHEE_TESTUSER", "")
CACHE = Path.home() / f".karaorchee_scan_testuser{'_' + ACCOUNT if ACCOUNT else ''}_cache.json"


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
    # /v1/me is DELETE-only; sync is the who-am-I, and it grants a role only to a roleless account.
    role = sys.argv[1] if len(sys.argv) > 1 else None
    body = json.dumps({"role": role, "notesConsent": True} if role else {}).encode()
    req = urllib.request.Request(
        "https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io/v1/users/sync",
        data=body, method="POST",
        headers={"Authorization": "Bearer " + t, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            me = json.load(r)
        print(f"signed in — {me.get('email')} teacher={me.get('isTeacher')} student={me.get('isStudent')}")
        if not me.get("isTeacher") and not me.get("isStudent"):
            print("no role yet — re-run with: testuser_auth.py teacher   (or student)")
    except Exception as exc:
        print(f"signed in to CIAM, but sync says: {exc}")
    print(f"cached at {CACHE}")
