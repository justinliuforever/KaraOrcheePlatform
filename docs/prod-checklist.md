# Prod provisioning checklist

Everything dev learned the hard way, consolidated. Work top-to-bottom when
creating rg-karaorchee-app-prod (decision: right before beta launch).
Nothing here is checked — prod does not exist yet.

## Region + capacity
- [ ] centralus (subscription is PG-offer-restricted in eastus — dev hit this).
      `infra/README.md`'s example still has to be run with `-l centralus`.
- [ ] ACA environment created WITH workload profiles. Dev's `cae-karaorchee-app-dev` is
      Consumption-only, hard-capped at 2 vCPU / 4Gi per app; dedicated profiles unlock
      4-16 vCPU for long-recording transcription. Not changeable after creation.
- [ ] API container app: min replicas 1 (no cold starts — founder call on dev)
- [ ] Both workers: single replica; NEVER scale >1 without revisiting SB lock handling
      (a draining replica keeps its links and steals messages for minutes after
      `containerapp update` reports the new revision running — known war story)

## Container apps (three, only one of them in Bicep)
- [ ] `ca-app-api-prod` — from `infra/main.bicep`
- [ ] `ca-pieces-worker-prod` — CLI-created, not in the template
- [ ] `ca-notes-worker-prod` — CLI-created, not in the template, and `scripts/deploy.sh`
      has no target for it. Either add one or write down the manual command.
      Dev's image is `acrkaraorchee.azurecr.io/notes-worker:<tag>` — note it does NOT
      carry the `karaorchee-app/` prefix the other two use.

## Logging / Ops tab (all three REQUIRED or the Ops tab is blind)
- [ ] az containerapp env update --logs-dynamic-json-columns true   (off by default!)
- [ ] Log Analytics retention: set 90 days (founder decision 2026-07-11: revisit at prod;
      dev stays 30)
- [ ] API container app: system-assigned managed identity
      + role "Log Analytics Reader" on the prod workspace
      + env LOG_ANALYTICS_WORKSPACE_ID=<prod workspace customerId>

## Identity / auth
- [ ] Admin SPA App Registration: add prod SWA URL to redirect URIs
- [ ] ADMIN_ORIGINS env on API = prod admin URL (exact origin, comma list)
- [ ] AUTH_* env trio (tenant id/name/audience unchanged — same CIAM tenant)

## Secrets (see docs/runbooks/secret-rotation.md for names)
- [ ] api: `dburl`, `storagecs`, `sbcs`
- [ ] pieces worker: `dburl`, `storagecs`, `sbcs`
- [ ] notes worker: the same three plus `aaikey`, `anthkey`, `dskey`, `elevenkey`
- [ ] APNs: `apns-key` + APNS_KEY_ID + APNS_TEAM_ID, and **APNS_ENVIRONMENT=production**.
      It defaults to `production` when unset, which is right here and wrong on dev.
- [ ] Fresh vendor keys for prod, not dev's — one leaked key should not bill both.

## Data
- [ ] PG: `--geo-redundant-backup Enabled` **at the create command**. This cannot be
      enabled on an existing server; getting it later means rebuilding the database.
      Decide before you type the command, not after.
- [ ] PG: `--backup-retention 35` (this one can be raised later)
- [ ] Run the full migration chain (`cd api && npm run db:migrate`) BEFORE the first
      revision, and before every later revision that needs new columns — never as part
      of container start
- [ ] Blob containers: piece-bundles, piece-sources, soundfont, lesson-audio, notes-assets
      (all PRIVATE; the catalog is served signed — no container may ever be public)
- [ ] Storage lifecycle policy: decide each rule explicitly. It is one replace-all
      resource, so deploying the Bicep overwrites whatever is live. `lesson-audio`
      cool@30d/delete@90d is settled; transcript delete@90d and narration cool@30d are
      still founder-gated (`docs/open-items.md`)
- [ ] Service Bus queues: pieces-jobs, pieces-preflight, notes-jobs, notes-narration

## Alerts
- [ ] Recreate DLQ dead-letter alert (ag-karaorchee-ops + alert-sb-deadletter equivalents)
      covering all four queues
- [ ] Alert on `kind == "purge_failed"` for every label — `audio`, `transcript`, `narration`,
      `scan`. Scans need it most: the rows are deleted before the blobs are purged, so once the
      three retries exhaust that log line is the only thing that names the bytes, no orphan sweep
      exists, and the score-scans container ships with its time-based delete rule disabled
- [ ] Azure cost budget alert on the prod RG

## Deploy
- [ ] deploy.sh env wiring for prod (image tags from HEAD, dirty-tree guard already enforced)
- [ ] GitHub Actions CI green on main before any prod deploy. Note what CI actually
      covers today: api tsc+vitest, admin tsc+build, and `worker/pieces` pytest only —
      **the notes worker suite does not run in CI**. Add that leg before it gates a
      production deploy, or the gate is lying about the notes pipeline.

## Content
- [ ] Licensed-piece exposure fix lands BEFORE public beta (login-gated download
      manifests — founder-deferred from 2026-07)
- [ ] Decide the catalog capability gate for the prod fleet: today 83 of 95 published
      pieces are invisible without `?caps=repeats`
