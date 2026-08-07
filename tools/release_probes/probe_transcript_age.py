#!/usr/bin/env python3
"""probe_transcript_age — how many stored transcripts the 90-day rule would delete
on its first pass. This is the count the founder signs before the flip (FG-9).

    python3 tools/release_probes/probe_transcript_age.py [--account …] [--group …]

Exit 0 whatever the count is: this probe reports, it does not judge. Exit 2 = nothing
was proved.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys

from azcli import DEV, az, guard
from retention import (TRANSCRIPT_CONTAINER, TRANSCRIPT_PREFIX,
                       TRANSCRIPT_RETENTION_DAYS, transcript_age_report)


@guard
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--account", default=DEV["account"])
    p.add_argument("--group", default=DEV["group"])
    args = p.parse_args(argv)

    blobs = az("storage", "blob", "list", "--account-name", args.account,
               "-c", TRANSCRIPT_CONTAINER, "--prefix", TRANSCRIPT_PREFIX,
               "--auth-mode", "key",
               "--query", "[].{name:name,mod:properties.lastModified}") or []
    report = transcript_age_report(blobs)

    print(f"probe_transcript_age  {args.account}/{TRANSCRIPT_CONTAINER}/{TRANSCRIPT_PREFIX}")
    print(f"                      {dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}")
    rows = [("stored transcripts (incl. model-output)", report["total"]),
            (f"older than {TRANSCRIPT_RETENTION_DAYS} days — the flip deletes",
             report["over_retention"]),
            ("oldest", f"{report['oldest_days']} days")]
    width = max(len(label) for label, _ in rows)
    for label, value in rows:
        print(f"  {label.ljust(width)}  {value}")
    for name in report["names"]:
        print(f"    {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
