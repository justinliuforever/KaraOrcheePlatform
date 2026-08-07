#!/usr/bin/env python3
"""probe_schema — proves migrations 0024/0025 exist in the database the deployed API
is talking to, by reading information_schema and printing every column it found next
to the one the release promises.

    DATABASE_URL=... python3 tools/release_probes/probe_schema.py

Exit 0 = every assertion held. Exit 1 = at least one failed. Exit 2 = nothing was
proved (no DATABASE_URL, no psycopg, no connection).
"""
from __future__ import annotations

import os
import sys

from schema import (EXPECTED_CONSTRAINTS, EXPECTED_INDEXES, check_columns,
                    check_named, render)


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is unset — nothing was read and nothing was proved.")
        return 2
    try:
        import psycopg
    except ImportError:
        print("psycopg is not installed — nothing was proved.")
        return 2
    try:
        with psycopg.connect(url) as conn, conn.cursor() as cur:
            cur.execute("""SELECT table_name, column_name FROM information_schema.columns
                           WHERE table_schema = 'public'""")
            columns = {(t, c) for t, c in cur.fetchall()}
            cur.execute("""SELECT conname FROM pg_constraint
                           WHERE connamespace = 'public'::regnamespace""")
            constraints = {r[0] for r in cur.fetchall()}
            cur.execute("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
            indexes = {r[0] for r in cur.fetchall()}
    except Exception as err:  # noqa: BLE001 — a probe that cannot read proves nothing
        print(f"could not read the database: {err}")
        return 2

    assertions = (check_columns(columns)
                  + check_named(constraints, EXPECTED_CONSTRAINTS, "constraint")
                  + check_named(indexes, EXPECTED_INDEXES, "index"))
    text, ok = render(assertions)
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
