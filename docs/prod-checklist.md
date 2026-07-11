# Prod provisioning checklist

Everything dev learned the hard way, consolidated. Work top-to-bottom when
creating rg-karaorchee-app-prod (decision: right before beta launch).

## Region + capacity
- [ ] centralus (subscription is PG-offer-restricted in eastus — dev hit this)
- [ ] API container app: min replicas 1 (no cold starts — founder call on dev)
- [ ] Worker: single replica; NEVER scale >1 without revisiting SB lock handling
      (draining replica steals messages — known war story)

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

## Data
- [ ] PG: --backup-retention 35, decide geo-redundant-backup NOW (immutable later)
- [ ] Run the full migration chain (drizzle/) before first deploy
- [ ] Blob containers: piece-bundles, piece-sources (PRIVATE access; catalog is
      served signed — the container must never be public)

## Alerts
- [ ] Recreate DLQ dead-letter alert (ag-karaorchee-ops + alert-sb-deadletter equivalents)
- [ ] Azure cost budget alert on the prod RG

## Deploy
- [ ] deploy.sh env wiring for prod (image tags from HEAD, dirty-tree guard already enforced)
- [ ] GitHub Actions CI green on main before any prod deploy

## Content
- [ ] Licensed-piece exposure fix lands BEFORE public beta (login-gated download
      manifests — founder-deferred from 2026-07)
