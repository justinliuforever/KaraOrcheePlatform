# KaraOrchee API

Backend for the KaraOrcheeAMT iOS piano app. Runs as an Azure Container App;
Postgres Flexible Server (relational), Azure Blob Storage (content bundles),
Microsoft Entra External ID / CIAM (auth).

## Environment

Config is env-only and validated with zod at boot. A missing required var, or a
partially-configured group, exits the process with the list of problems. Feature
groups degrade explicitly (the feature returns 503) when their group is absent —
never silently.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (default 8080) | HTTP listen port |
| `STORAGE_CONNECTION_STRING` | group: catalog | Blob account `AccountName`/`AccountKey`; enables `/v1/catalog` |
| `AUTH_TENANT_ID` | group: auth | CIAM tenant id |
| `AUTH_TENANT_NAME` | group: auth | CIAM tenant name (`<name>.ciamlogin.com`) |
| `AUTH_AUDIENCE` | group: auth | Expected JWT `aud`; enables protected routes |

The auth group is all-or-nothing. If it is unset, protected routes return
`503 auth_not_configured` — they never pass through unauthenticated.

## Routes

- `GET /healthz` — open. `{ ok: true, db: "ok" | "unconfigured" | "error" }`.
- `GET /v1/catalog` — open. Reads `piece-bundles/catalog.json`, rewrites every
  `files[].url` / `stems[].url` with a 60-minute read SAS.
- `POST /v1/users/sync` — requires a CIAM Bearer JWT. Upserts the caller by
  `entra_oid`, returns the user row.

## Local run

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/karaorchee
npm run dev
```

## Database migrations

Migrations are generated from `src/db/schema.ts` and committed under `drizzle/`.
Applying them is an explicit operator step (never part of container start).

```bash
npm run db:generate   # regenerate SQL after a schema change
npm run db:migrate    # apply ./drizzle migrations to DATABASE_URL
```

## Test

```bash
npm test              # vitest run — offline, no network, no real db
```

## Docker

```bash
docker build -t karaorchee-api .
docker run -p 8080:8080 -e DATABASE_URL=... karaorchee-api
```

The image runs `node dist/index.js` as the non-root `node` user. Run
`db:migrate` separately before rolling out a schema change.
