#!/usr/bin/env python3
"""probe_retention — proves the live retention state matches retention_policy.json
and the numbers the published retention table prints.

    python3 tools/release_probes/probe_retention.py [--account …] [--group …] [--pg …]

Exit 0 = every assertion held. Exit 1 = at least one failed. Exit 2 = nothing was
proved (no az CLI, no login, wrong subscription).
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys

from azcli import DEV, az, guard
from retention import (check_blob_service, check_log_retention,
                       check_management_policy, check_pg_backup, render)


@guard
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--account", default=DEV["account"])
    p.add_argument("--group", default=DEV["group"])
    p.add_argument("--pg", default=DEV["pg"])
    p.add_argument("--workspace", default=DEV["workspace"])
    args = p.parse_args(argv)

    live_policy = az("storage", "account", "management-policy", "show",
                     "--account-name", args.account, "-g", args.group) or {}
    blob_props = az("storage", "account", "blob-service-properties", "show",
                    "--account-name", args.account, "-g", args.group) or {}
    server = az("postgres", "flexible-server", "show",
                "-n", args.pg, "-g", args.group) or {}
    workspace = az("monitor", "log-analytics", "workspace", "show",
                   "-g", args.group, "--workspace-name", args.workspace) or {}
    tables = az("monitor", "log-analytics", "workspace", "table", "list",
                "-g", args.group, "--workspace-name", args.workspace,
                "--query", "[].{name:name,retentionInDays:retentionInDays}") or []

    checks = (check_management_policy(live_policy)
              + check_blob_service(blob_props)
              + check_pg_backup(server)
              + check_log_retention(workspace, tables))

    print(f"probe_retention  {args.account} / {args.pg} / {args.workspace} / {args.group}")
    print(f"                 {dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}")
    print(render(checks))
    failed = [c.name for c in checks if not c.ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} assertions held"
          + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
