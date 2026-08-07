"""Assertions behind the published retention table.

The apply is a REPLACE-ALL: `az storage account management-policy create` overwrites
every rule, and the live account has carried rules the bicep template lacks. So the
proof is never "the command exited 0" — it is this module comparing the live policy,
the live blob service properties and the live Postgres server against
`retention_policy.json` and the constants below, one printed line per assertion.

Pure functions only: the CLI probes fetch, this decides.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any, NamedTuple

POLICY_FILE = Path(__file__).with_name("retention_policy.json")

# Each of these is printed verbatim in the published retention table and privacy notice.
BLOB_SOFT_DELETE_DAYS = 7
PG_BACKUP_RETENTION_DAYS = 7
TRANSCRIPT_RETENTION_DAYS = 90
DELETED_VERSION_RETENTION_DAYS = 30
AUDIO_VERSION_RETENTION_DAYS = 7
LOG_RETENTION_DAYS = 30

# Our service logs land in the container-app tables; the App* tables belong to
# Application Insights, which is unwired, and Azure fixes their floor at 90 days.
SERVICE_LOG_TABLE_PREFIX = "ContainerApp"

TRANSCRIPT_RULE = "notes-transcripts-delete"
AUDIO_RULE = "lesson-audio-cool-then-delete"
DELETED_VERSIONS_RULE = "notes-assets-purge-deleted-versions"

TRANSCRIPT_CONTAINER = "notes-assets"
TRANSCRIPT_PREFIX = "transcripts/"


class Check(NamedTuple):
    name: str
    ok: bool
    expected: str
    actual: str


def normalize(node: Any) -> Any:
    """`az` renders absent actions as null and every day count as a float; the
    checked-in policy is hand-written ints. Compare shapes, not renderings."""
    if isinstance(node, dict):
        return {k: normalize(v) for k, v in sorted(node.items()) if v is not None}
    if isinstance(node, list):
        return [normalize(v) for v in node]
    if isinstance(node, float) and node.is_integer():
        return int(node)
    return node


def load_intended_policy() -> dict:
    return json.loads(POLICY_FILE.read_text())


def rules_by_name(policy: dict) -> dict[str, dict]:
    inner = policy.get("policy", policy) if isinstance(policy, dict) else {}
    return {r["name"]: normalize(r) for r in (inner or {}).get("rules", [])}


def _dig(node: Any, *keys: str) -> Any:
    for k in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(k)
    return node


def check_management_policy(live: dict, intended: dict | None = None) -> list[Check]:
    intended = intended if intended is not None else load_intended_policy()
    want = rules_by_name(intended)
    have = rules_by_name(live)
    checks: list[Check] = []

    for name, rule in want.items():
        actual = have.get(name)
        if actual is None:
            checks.append(Check(f"policy rule {name}", False, "present", "absent"))
        elif actual != rule:
            checks.append(Check(f"policy rule {name}", False,
                                json.dumps(rule, sort_keys=True),
                                json.dumps(actual, sort_keys=True)))
        else:
            state = "enabled" if rule.get("enabled") else "disabled"
            checks.append(Check(f"policy rule {name}", True,
                                f"matches retention_policy.json ({state})",
                                f"matches retention_policy.json ({state})"))

    extra = sorted(set(have) - set(want))
    checks.append(Check("no live rule outside retention_policy.json", not extra,
                        "none", ", ".join(extra) if extra else "none"))

    # The three numbers the table depends on, asserted by name as well as by
    # whole-rule equality: a rule renamed or re-scoped must not pass quietly.
    transcript = have.get(TRANSCRIPT_RULE, {})
    checks.append(Check(
        f"{TRANSCRIPT_RULE} deletes transcripts",
        _dig(transcript, "definition", "actions", "baseBlob", "delete",
             "daysAfterModificationGreaterThan") == TRANSCRIPT_RETENTION_DAYS
        and transcript.get("enabled") is True
        and _dig(transcript, "definition", "filters", "prefixMatch")
        == [f"{TRANSCRIPT_CONTAINER}/{TRANSCRIPT_PREFIX}"],
        f"enabled, {TRANSCRIPT_CONTAINER}/{TRANSCRIPT_PREFIX}, delete@{TRANSCRIPT_RETENTION_DAYS}d",
        f"enabled={transcript.get('enabled')}, "
        f"prefix={_dig(transcript, 'definition', 'filters', 'prefixMatch')}, "
        f"delete@{_dig(transcript, 'definition', 'actions', 'baseBlob', 'delete', 'daysAfterModificationGreaterThan')}d"))

    audio_version = _dig(have.get(AUDIO_RULE, {}), "definition", "actions", "version",
                         "delete", "daysAfterCreationGreaterThan")
    checks.append(Check(
        f"{AUDIO_RULE} keeps its version action",
        audio_version == AUDIO_VERSION_RETENTION_DAYS,
        f"version.delete@{AUDIO_VERSION_RETENTION_DAYS}d",
        f"version.delete@{audio_version}d"))

    deleted_versions = _dig(have.get(DELETED_VERSIONS_RULE, {}), "definition", "actions",
                            "version", "delete", "daysAfterCreationGreaterThan")
    checks.append(Check(
        f"{DELETED_VERSIONS_RULE} purge age",
        deleted_versions == DELETED_VERSION_RETENTION_DAYS,
        f"version.delete@{DELETED_VERSION_RETENTION_DAYS}d",
        f"version.delete@{deleted_versions}d"))

    return checks


def check_blob_service(props: dict) -> list[Check]:
    policy = normalize(props.get("deleteRetentionPolicy") or {})
    days = policy.get("days")
    return [Check("blob soft-delete retention", days == BLOB_SOFT_DELETE_DAYS
                  and policy.get("enabled") is True,
                  f"enabled, {BLOB_SOFT_DELETE_DAYS} days",
                  f"enabled={policy.get('enabled')}, {days} days"),
            Check("blob versioning", props.get("isVersioningEnabled") is True,
                  "enabled", f"enabled={props.get('isVersioningEnabled')}")]


def check_pg_backup(server: dict) -> list[Check]:
    days = normalize(_dig(server, "backup", "backupRetentionDays"))
    if days is None:
        days = normalize(server.get("backupRetentionDays"))
    return [Check("postgres backup retention", days == PG_BACKUP_RETENTION_DAYS,
                  f"{PG_BACKUP_RETENTION_DAYS} days", f"{days} days")]


def check_log_retention(workspace: dict, tables: list[dict] | None = None) -> list[Check]:
    days = normalize(workspace.get("retentionInDays"))
    over = sorted(str(t.get("name")) for t in (tables or [])
                  if str(t.get("name", "")).startswith(SERVICE_LOG_TABLE_PREFIX)
                  and normalize(t.get("retentionInDays")) != LOG_RETENTION_DAYS)
    return [Check("service log retention (workspace default)",
                  days == LOG_RETENTION_DAYS,
                  f"{LOG_RETENTION_DAYS} days", f"{days} days"),
            Check("no service log table kept longer", not over,
                  f"every {SERVICE_LOG_TABLE_PREFIX}* table at {LOG_RETENTION_DAYS} days",
                  ", ".join(over) if over else "none")]


def transcript_age_report(blobs: list[dict], now: dt.datetime | None = None) -> dict:
    """What applying the transcript rule would delete on its first pass. The rule
    reads last-modified, so this does too."""
    now = now or dt.datetime.now(dt.timezone.utc)
    aged: list[tuple[str, int]] = []
    oldest = 0
    for b in blobs:
        stamp = b.get("mod") or _dig(b, "properties", "lastModified")
        if not stamp:
            continue
        age = (now - dt.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))).days
        oldest = max(oldest, age)
        if age > TRANSCRIPT_RETENTION_DAYS:
            aged.append((b.get("name", "?"), age))
    return {"total": len(blobs), "over_retention": len(aged),
            "oldest_days": oldest, "names": sorted(n for n, _ in aged)}


def render(checks: list[Check]) -> str:
    width = max((len(c.name) for c in checks), default=0)
    lines = []
    for c in checks:
        lines.append(f"  {'PASS' if c.ok else 'FAIL'}  {c.name.ljust(width)}  "
                     f"expected: {c.expected}")
        if not c.ok:
            lines.append(f"        {' ' * width}  actual:   {c.actual}")
    return "\n".join(lines)
