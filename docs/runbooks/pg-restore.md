# Runbook: Postgres restore (pg-karaorchee-app-dev / future prod)

The database is the truth for pieces/users/jobs/audit; blobs are content-addressed
by paths stored in it. Restoring PG restores the platform — blobs never need a
matching restore (immutable v<N> layout, orphans are harmless).

Azure Flexible Server keeps automatic backups (7-day PITR window on dev). There is
nothing to configure per-backup; restore is always to a NEW server.

## Point-in-time restore (the only procedure)

1. Pick the restore point (UTC): last moment BEFORE the incident.
2. Restore to a new server (never in place):
   az postgres flexible-server restore \
     --resource-group rg-karaorchee-app-dev \
     --name pg-karaorchee-app-dev-restored \
     --source-server pg-karaorchee-app-dev \
     --restore-time "2026-07-11T18:00:00Z"
3. Wait for provisioning (~10 min). Firewall/VNet rules do NOT copy — re-apply:
   az postgres flexible-server firewall-rule create -g rg-karaorchee-app-dev \
     -n pg-karaorchee-app-dev-restored -r allow-azure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
4. Sanity-check the restored data before pointing anything at it:
   psql "host=pg-karaorchee-app-dev-restored.postgres.database.azure.com dbname=karaorchee user=<admin> sslmode=require" \
     -c "select count(*) from pieces; select max(created_at) from audit_events;"
5. Swap the API/worker over: update the DATABASE_URL secret on both container apps
   (az containerapp secret set + new revision). Keep the old server stopped but
   NOT deleted until the incident is fully closed.
6. Rebuild the catalog once (any admin metadata PATCH triggers it, or hit publish
   flow) so catalog.json regenerates from the restored SQL.

## Verify the runbook (do this once per quarter, dev)

Run steps 2-4 against dev, confirm counts, then delete the restored server:
   az postgres flexible-server delete -g rg-karaorchee-app-dev -n pg-karaorchee-app-dev-restored --yes

## Prod deltas (when prod exists)

- Set backup retention to 35 days at creation (--backup-retention 35).
- Consider geo-redundant backup (--geo-redundant-backup Enabled) — decide at
  prod provisioning; cannot be flipped later.
