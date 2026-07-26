# Runbook: Postgres restore (pg-karaorchee-app-dev / future prod)

Server `pg-karaorchee-app-dev`, database **`karaorchee_app`**, admin login
`karaorchee_admin`. The database is the truth for pieces/users/jobs/audit/notes.

Azure Flexible Server keeps automatic backups. Dev's retention is **35 days**
(`backupRetentionDays: 35` on the live server; `infra/main.bicep` still declares 7 — it was
raised out of band, so trust `az postgres flexible-server show`, not the template). Retention
is not the same as the window: the real floor is `backup.earliestRestoreDate` from that same
command, because raising retention does not manufacture backups that were never taken. Check
it before picking a restore point. Restore is always to a NEW server.

**Blobs do not restore with it, and that cuts two ways.** Piece bundles are immutable
`v<N>` paths — an older DB simply points at blobs that still exist, and orphans are harmless.
Notes assets are not: narration clips and transcripts are purged when their note, lesson or
account is deleted, so restoring past a deletion resurrects rows whose
`notes-assets/narration/<noteId>/` prefix is gone. Those notes read as never-narrated and
re-synthesize on demand — degraded, not broken. Lesson audio older than 90 days is gone by
lifecycle rule regardless of what the database says.

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
   psql "host=pg-karaorchee-app-dev-restored.postgres.database.azure.com dbname=karaorchee_app user=karaorchee_admin sslmode=require" \
     -c "select count(*) from pieces; select count(*) from notes; select max(created_at) from audit_events;"
5. Swap over: update the `dburl` secret on ALL THREE container apps — ca-app-api-dev,
   ca-pieces-worker-dev, ca-notes-worker-dev — then restart each active revision. A worker
   left on the old server keeps writing to it and the two databases diverge silently.
   Keep the old server stopped but NOT deleted until the incident is fully closed.
6. Confirm the migration state matches the code that is running:
   `select count(*) from drizzle.__drizzle_migrations` must equal `ls api/drizzle/*.sql | wc -l`
   at the deployed commit. A restore to a point before a migration leaves the running revision
   querying columns the restored database does not have; re-run `npm run db:migrate` from
   `api/` against the restored server before sending it traffic.
7. Rebuild the catalog once (any admin metadata PATCH triggers it, or hit publish
   flow) so catalog.json regenerates from the restored SQL.

## Verify the runbook (do this once per quarter, dev)

Run steps 2-4 against dev, confirm counts, then delete the restored server:
   az postgres flexible-server delete -g rg-karaorchee-app-dev -n pg-karaorchee-app-dev-restored --yes

## Prod deltas (when prod exists)

- `--backup-retention 35`. This one CAN be raised later (dev's was).
- `--geo-redundant-backup Enabled` is **creation-time only** — it cannot be enabled on an
  existing server, so a prod database created without it can only get it by rebuilding.
  Decide before the create command runs; see `docs/prod-checklist.md`.
