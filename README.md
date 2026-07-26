# KaraOrchee App Platform

Dedicated cloud backend for the KaraOrchee iOS app: the pieces catalog and its content
pipeline, the admin console, and Notes (lesson recording → transcription → practice notes →
narration → push). Greenfield by decision — shares only the CIAM tenant, ACS email, and
container registry with the rest of the company. **Not** the legacy `music_backend`.

## Repo map

| Dir | What |
|---|---|
| `api/` | Platform API — TypeScript/Express, Postgres (drizzle), fail-closed CIAM auth. Tests: `cd api && npm test` (PGlite, real migration chain) |
| `apps/admin/` | Admin console SPA (Pieces Studio + Library + Collections + Users + Ops + Pairings + Subscriptions) — Vite/React/MSAL. Dev: `npm run dev` (localhost:5173) |
| `worker/pieces/` | Content pipeline worker — Python, verovio/FluidSynth/playwright; two Service Bus lanes (preflight + full verification) |
| `worker/notes/` | Notes worker — Python; two Service Bus lanes on one process (ASR+LLM on `notes-jobs`, ElevenLabs narration on `notes-narration`) |
| `infra/` | Bicep — declares the API but neither worker; see the drift warning in `docs/platform.md` |
| `tools/publisher/` | Pre-Studio CLI publishing tools. Superseded — read its README before running anything |
| `docs/` | `platform.md` = resources/identity/laws · `open-items.md` = what is outstanding · `prod-checklist.md` · `runbooks/` · `catalog_roadmap.md` = entity model north star |
| `scripts/` | `deploy.sh <api\|worker\|admin> [env]` — sanctioned for those three. The notes worker has no target and is deployed by hand |

## Environments

Dev is live in **centralus** (`rg-karaorchee-app-dev`); prod not yet created.
Details, URLs, and identity setup: `docs/platform.md`.

## The laws (violate at your peril)

- Published bundles are **immutable** (`<pieceId>/v<N>/`); old versions are never deleted.
- Auth is **fail-closed**; admin power comes only from `users.is_admin` in Postgres.
- All blob access is SAS-signed; containers are private.
- SQL is catalog truth; `catalog.json` is a build artifact (ETag-guarded rebuild).
- Reviewed = published: what the admin approved is byte-for-byte what ships.
