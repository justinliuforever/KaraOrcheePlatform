#!/usr/bin/env python3
"""Interactive device-code sign-in for batch tools. Writes the bearer token to
~/.karaorchee_admin_token (0600) — never prints it. Run this yourself; the batch
uploader reads the file. Tokens last ~1h; re-run when expired."""
import json
import os
import sys
from pathlib import Path

import msal

AUTHORITY = "https://karaorcheeauth.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b"
CLIENT = "4a12e0a8-c0b8-4770-a182-0f02626c7dc5"  # public client (iOS app registration)
SCOPE = ["api://4a12e0a8-c0b8-4770-a182-0f02626c7dc5/access_as_user"]
OUT = Path.home() / ".karaorchee_admin_token"

app = msal.PublicClientApplication(CLIENT, authority=AUTHORITY)
flow = app.initiate_device_flow(scopes=SCOPE)
if "user_code" not in flow:
    sys.exit(f"device flow not available: {json.dumps(flow)[:300]}")
print(flow["message"], flush=True)
result = app.acquire_token_by_device_flow(flow)
if "access_token" not in result:
    sys.exit(f"sign-in failed: {result.get('error_description', result)}"[:400])
OUT.write_text(result["access_token"])
os.chmod(OUT, 0o600)
print(f"token saved to {OUT} (expires in ~{result.get('expires_in', 3600)//60} min)")
