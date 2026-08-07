"""Read-only `az` calls for the release probes. Nothing here writes to Azure."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys

DEV = {"account": "stkaraoappdev", "group": "rg-karaorchee-app-dev",
       "pg": "pg-karaorchee-app-dev", "workspace": "log-karaorchee-app-dev"}


class AzUnavailable(RuntimeError):
    pass


def az(*args: str) -> object:
    if shutil.which("az") is None:
        raise AzUnavailable("the az CLI is not installed")
    proc = subprocess.run(["az", *args, "-o", "json"], capture_output=True, text=True)
    if proc.returncode != 0:
        raise AzUnavailable(f"az {' '.join(args)} failed: {proc.stderr.strip()[:400]}")
    return json.loads(proc.stdout or "null")


def guard(fn):
    """A probe that cannot reach Azure has proved nothing — say so and exit 2, so a
    lost login never reads as a green release gate."""
    def wrapped(*a, **k):
        try:
            return fn(*a, **k)
        except AzUnavailable as err:
            print(f"UNPROVEN: {err}", file=sys.stderr)
            return 2
    return wrapped
