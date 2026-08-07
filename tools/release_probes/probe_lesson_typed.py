#!/usr/bin/env python3
"""probe_lesson_typed — the live half of the 0024/0025 proof: one authenticated
POST /v1/lessons with pieceSource:"typed", then a read of what the database actually
holds. A 201 proves the route answered; only the rows prove the migration ran.

    API_BASE=... NOTES_TOKEN=... DATABASE_URL=... \
        python3 tools/release_probes/probe_lesson_typed.py

The lesson it creates is left in place (status 'created', no audio) and named in the
output so it can be discarded by hand. Exit 2 = nothing was proved.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from schema import check_typed_create, render

LABEL = "probe_lesson_typed — safe to discard"


def main() -> int:
    base = os.environ.get("API_BASE")
    token = os.environ.get("NOTES_TOKEN")
    url = os.environ.get("DATABASE_URL")
    if not base or not token or not url:
        print("API_BASE, NOTES_TOKEN and DATABASE_URL are all required — nothing was proved.")
        return 2
    try:
        import psycopg
    except ImportError:
        print("psycopg is not installed — nothing was proved.")
        return 2

    body = json.dumps({"pieceLabel": LABEL, "pieceSource": "typed", "attested": True}).encode()
    req = urllib.request.Request(
        f"{base.rstrip('/')}/v1/lessons", data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            created = json.loads(resp.read())
    except urllib.error.HTTPError as err:
        print(f"POST /v1/lessons returned {err.code}: {err.read()[:200]!r} — nothing was proved.")
        return 2
    except Exception as err:  # noqa: BLE001
        print(f"POST /v1/lessons failed: {err} — nothing was proved.")
        return 2

    lesson_id = created.get("lesson", {}).get("id")
    print(f"created lesson {lesson_id} ({LABEL})")
    try:
        with psycopg.connect(url) as conn, conn.cursor() as cur:
            cur.execute("""SELECT piece_source, custom_piece_id FROM lesson_sessions
                           WHERE id = %s""", (lesson_id,))
            row = cur.fetchone()
            lesson = {"piece_source": row[0], "custom_piece_id": row[1]} if row else None
            custom = None
            if lesson and lesson["custom_piece_id"]:
                cur.execute("""SELECT id, display_label FROM custom_pieces WHERE id = %s""",
                            (lesson["custom_piece_id"],))
                crow = cur.fetchone()
                custom = {"id": crow[0], "display_label": crow[1]} if crow else None
    except Exception as err:  # noqa: BLE001
        print(f"could not read the database: {err}")
        return 2

    text, ok = render(check_typed_create(lesson, custom))
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
