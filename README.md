# KaraOrchee App Platform

Dedicated cloud backend for the KaraOrchee iOS app (pieces catalog, admin console,
content pipeline). Greenfield by decision — shares only the CIAM tenant, ACS email,
and container registry with the rest of the company. **Not** the legacy `music_backend`.

## Repo map

| Dir | What |
|---|---|
| `api/` | Platform API — TypeScript/Express, Postgres (drizzle), fail-closed CIAM auth. Tests: `cd api && npm test` (PGlite, real migration chain) |
| `apps/admin/` | Admin console SPA (Pieces Studio wizard + Pieces Library + Users) — Vite/React/MSAL. Dev: `npm run dev` (localhost:5173) |
| `worker/pieces/` | Content pipeline worker — Python, verovio/FluidSynth/playwright; two Service Bus lanes (preflight + full verification) |
| `infra/` | Bicep for the Azure env (see drift warnings in `infra/main.bicep` header) |
| `tools/publisher/` | CLI publishing tools (pre-Studio era) + retired one-shot backfills |
| `docs/` | `platform.md` = resources/identity/laws · `catalog_roadmap.md` = entity model north star |
| `scripts/` | `deploy.sh <api|worker|admin> [env]` — the only sanctioned deploy path |

## Environments

Dev is live in **centralus** (`rg-karaorchee-app-dev`); prod not yet created.
Details, URLs, and identity setup: `docs/platform.md`.

## The laws (violate at your peril)

- Published bundles are **immutable** (`<pieceId>/v<N>/`); old versions are never deleted.
- Auth is **fail-closed**; admin power comes only from `users.is_admin` in Postgres.
- All blob access is SAS-signed; containers are private.
- SQL is catalog truth; `catalog.json` is a build artifact (ETag-guarded rebuild).
- Reviewed = published: what the admin approved is byte-for-byte what ships.
