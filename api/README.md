# KaraOrchee API

Backend for the KaraOrcheeAMT iOS piano app. Runs as an Azure Container App;
Postgres Flexible Server (relational), Azure Blob Storage (content bundles),
Microsoft Entra External ID / CIAM (auth).

## Environment

Config is env-only and validated with zod at boot. A missing required var, or a
partially-configured group, exits the process with the list of problems. Feature
groups degrade explicitly (the feature returns 503) when their group is absent —
never silently.

`src/config.ts` is the authoritative list; this table is a summary.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (default 8080) | HTTP listen port |
| `STORAGE_CONNECTION_STRING` | group: catalog | Blob account `AccountName`/`AccountKey`; enables `/v1/catalog` and every SAS mint |
| `SERVICEBUS_CONNECTION_STRING` | group: queue | Enqueues studio and notes jobs |
| `AUTH_TENANT_ID` | group: auth | CIAM tenant id |
| `AUTH_TENANT_NAME` | group: auth | CIAM tenant name (`<name>.ciamlogin.com`) |
| `AUTH_AUDIENCE` | group: auth | Expected JWT `aud`; enables protected routes |
| `ADMIN_ORIGINS` | no | Comma-separated browser origins for the admin SPA. Native clients send no Origin and are unaffected |
| `LOG_ANALYTICS_WORKSPACE_ID` | no | Workspace customerId; enables the Ops tab's log queries via managed identity |
| `APP_SUPPORTS_REPEATS` | no | `"true"` lets repeat-structure pieces publish. Anything else blocks them |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_PRIVATE_KEY` | group: apns | Push. Wholly unset is supported — no key, no pushes, sends unaffected |
| `APNS_BUNDLE_ID` | no (default `com.karaorchee.karaorcheeamt`) | |
| `APNS_ENVIRONMENT` | no (**default `production`**) | `sandbox` for Xcode builds. Not part of the apns group, so forgetting it fails pushes silently on dev |

Auth and APNs are all-or-nothing groups: a partially-set group exits at boot naming what is
missing. If auth is wholly unset, protected routes return `503 auth_not_configured` — they
never pass through unauthenticated.

## Routes

`src/routes/` is the map. Broadly:

- **Open**: `GET /healthz`; `GET /v1/catalog` (reads `piece-bundles/catalog.json`, rewrites
  every `files[].url` / `stems[].url` with a short-lived read SAS, filters by `?caps=`).
- **`/v1/*`, authenticated** (`users`, `links`, `lessons`, `notes`): account sync and
  deletion, invite-code pairing in both directions, lesson upload via write-SAS, note
  review/send/retract, student inbox, narration URLs. Every authenticated response carries
  `no-store` + `Vary: Authorization`, set once in `requireAuth`.
- **`/admin/*`**: `requireAuth` → `requireAdmin` (403 unless `users.is_admin`). Studio,
  catalog registry, composers, ops/log queries, notes pairing and subscriptions, note-job
  monitoring. Every mutation writes an `audit_events` row.

## Local run

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/karaorchee
npm run dev
```

## Database migrations

Migrations are generated from `src/db/schema.ts` and committed under `drizzle/`.
Applying them is an explicit operator step (never part of container start), and it runs
**before** the revision that needs the new columns — a missed migration leaves the running
code querying columns that do not exist, while a cached catalog keeps serving and hides it.

```bash
npm run db:generate   # regenerate SQL after a schema change
npm run db:migrate    # apply ./drizzle migrations to DATABASE_URL
```

## Test

```bash
npm test              # vitest run — 416 tests, offline, no network
```

Tests run against PGlite with the real `drizzle/` chain applied, so a migration that does not
apply cleanly fails the suite rather than production.

## Docker

```bash
docker build -t karaorchee-api .
docker run -p 8080:8080 -e DATABASE_URL=... karaorchee-api
```

The image runs `node dist/index.js` as the non-root `node` user. Run
`db:migrate` separately before rolling out a schema change.
