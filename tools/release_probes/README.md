# Release probes

Written proof that the live environment is what the release says it is. Migration 0023
was run inside a container image that did not contain it: the runner exited 0, nothing
happened, and the roster 500ed for days. So nothing here trusts an exit code — every
probe prints the value it read next to the value the release promises.

Run them at every dev deploy, and again at W10 before the build is cut.

```bash
python3 tools/release_probes/probe_retention.py        # exit 0 = every assertion held
python3 tools/release_probes/probe_transcript_age.py   # the FG-9 count, for signature
python3 tools/release_probes/probe_privacy_parity.py   # [C6] the privacy artifacts agree
python3 -m pytest tools/release_probes/tests -q        # the probes' own tests
```

Both probes take `--account` / `--group` / `--pg`; they default to dev. They read
Azure and nothing else — no writes, no `create`, no `update`. Exit 2 means the probe
could not reach Azure and therefore proved nothing; never read it as green.

## probe_retention

Asserts, one printed line each:

| Assertion | Number the document prints |
|---|---|
| every rule in `retention_policy.json` is live and identical | — |
| no live rule exists that the file does not declare | — |
| `notes-transcripts-delete` enabled, `notes-assets/transcripts/`, delete @90d | "Lesson transcripts … deleted on the same 90-day clock" |
| `lesson-audio-cool-then-delete` still carries `version.delete` @7d | "deleted files are recoverable by our operators for up to 7 days" |
| `notes-assets-purge-deleted-versions` @30d | "overwritten note files up to 30 days" |
| blob `deleteRetentionPolicy` enabled, 7 days | "deleted files … up to 7 days" |
| blob versioning enabled | (the version rules are inert without it) |
| Postgres `backup.backupRetentionDays` | "database backups are kept 7 days" |
| Log Analytics workspace retention, and every `ContainerApp*` table | "Service logs … 30 days" |

The `App*` and `AzureActivity` tables sit at 90 days — Azure's floor for them. They are
out of scope above because Application Insights is unwired; wiring it puts request
telemetry under a 90-day clock and the "Service logs … 30 days" row stops being true.

## probe_transcript_age

Counts what the transcript rule would delete on its first pass, by last-modified —
the same clock the rule reads. This is the count FG-9 signs before the flip.

## probe_privacy_parity `[C6]`

Three artifacts must say the same thing, and each is authored in a different language:
the checked-in source documents, the copy compiled into the iOS Settings screen, and
the numbers `retention.py` asserts against Azure. The first two were compared before;
a number could drift in the third and every check stayed green, so this probe also
matches each printed number against the constant the retention probe uses — anchored
on the row's phrase, so a reworded row fails loudly instead of quietly ceasing to be
checked.

```bash
python3 tools/release_probes/probe_privacy_parity.py \
  --app-repo ~/Desktop/KaraOrcheeAMT \
  --docs ~/Desktop/KaraOrcheeNotes_Feedback1/batch_ab/documents \
  --public-url https://karaorchee.com/privacy
```

Paths also read `NOTES_APP_REPO` / `NOTES_PRIVACY_DOCS` / `NOTES_PRIVACY_URL`. Without
a URL the deployed page cannot be checked and the probe exits **2** — FG-11 has not
named one yet, and "not checked" must never print as a pass.

## Applying the policy (founder, once, before any build carrying the promise copy)

`managementPolicies` is **replace-all** and the live account has carried rules the
Bicep template lacks. `retention_policy.json` is the reconciliation: it is composed
from the live policy, keeps the live-only `version.delete@7` action, and adds the
transcript rule. Capture the rollback artifact first.

```bash
az storage account management-policy show \
  --account-name stkaraoappdev -g rg-karaorchee-app-dev -o json > policy-rollback.json

az storage account management-policy create \
  --account-name stkaraoappdev -g rg-karaorchee-app-dev \
  --policy @tools/release_probes/retention_policy.json

python3 tools/release_probes/probe_retention.py
```

Rollback: `management-policy create --policy @policy-rollback.json` with the `policy`
key unwrapped, then re-probe.

**Postgres backup retention is a separate apply, and it is not currently 7.** The live
server reads 35; FG-9 and the published table both say 7, and `probe_retention` fails
until they agree. The founder makes them agree in one of two ways — either shrink the
server, before any build carrying the promise copy:

```bash
az postgres flexible-server update \
  -n pg-karaorchee-app-dev -g rg-karaorchee-app-dev --backup-retention 7
```

— or rule the other way at FG-10 and move `PG_BACKUP_RETENTION_DAYS`, the document row,
the compiled-in row, and FG-9's own text to 35 together. `probe_privacy_parity` is what
catches a half-done move.

`infra/main.bicep` must be reconciled to match this file in the same change
(`transcriptRetentionEnabled` default `true`, and the `version` action added to
`lesson-audio-cool-then-delete`) or the next `az deployment group create` silently
reverts the flip and drops the 7-day version rule. `probe_retention` is what catches
it if that reconciliation is missed.

## Still owed by other lanes

`probe_sync` — spec 3.3, W9's `features.passwordSignIn` round trip. `probe_schema`
covers 0024–0025 today; 0026–0027 join it with W7. Keep the
pure-assertion-plus-thin-CLI shape so each stays testable without Azure.
