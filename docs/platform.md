# KaraOrchee App Platform

Dedicated backend platform for the iOS app (KaraOrcheeAMT). Greenfield by decision (2026-07-05
deep-research round): the legacy `music_backend` is pattern-reference only — nothing here shares
its code, database, or storage. Shared with the rest of the company: the CIAM tenant, the ACS
email domain, and the container registry. Everything else lives in this repo + its own RGs.

## Environments

| | dev | prod |
|---|---|---|
| Resource group | `rg-karaorchee-app-dev` | `rg-karaorchee-app-prod` (not yet created) |
| Region | centralus — subscription is Postgres-offer-restricted in eastus/eastus2/westus2/southcentralus (probed 2026-07-05 via capabilities API); centralus = nearest full-featured allowed region, whole platform co-located | same |
| Subscription | `7f5d0970-fdd5-45ba-a9c2-635eb221f9c1` (KaraOrchee, Inc.) | same |

Declared in `infra/main.bicep`; env differences are parameters only (SKUs, min replicas).

Dev API (live 2026-07-05): `https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io`
— image `acrkaraorchee.azurecr.io/karaorchee-app/api:<tag>` (built via `az acr build`), secrets
`dburl`/`storagecs` on the container app, AUTH_* env pointed at the CIAM iOS App Registration.
Database `karaorchee_app` on `pg-karaorchee-app-dev` (migrations applied); catalog has
`bach_bwv_846` + `czerny_599_41` v1 bundles.

## Resources (per env)

| Resource | Name (`<env>` suffix) | Role |
|---|---|---|
| Container App | `ca-app-api-<env>` | The API — accounts, roles, invites, notes metadata, entitlements, SAS minting, IAP webhook |
| Container Apps env | `cae-karaorchee-app-<env>` | Hosts API + (Phase B) notes worker job |
| Postgres Flexible | `pg-karaorchee-app-<env>` | Relational truth: users, teacher↔student, referrals, invites, entitlements, metering |
| Storage | `stkaraoapp<env>` | `piece-bundles/` (versioned, immutable) · `soundfont/` · `lesson-audio/` (private, Cool@30d, delete@90d) · `notes-assets/`. Public access OFF, SAS-only |
| Service Bus | `sb-karaorchee-app-<env>` | Queue `notes-jobs` (+DLQ) for the ASR+LLM pipeline |
| Key Vault | `kv-karaorchee-app-<env>` | All keys/connection strings (company convention: key-based auth) |
| App Insights + Log Analytics | `appi/log-karaorchee-app-<env>` | Logs, traces, alerts |

Shared, pre-existing (NOT in this repo's Bicep): `comm-karaorchee` (ACS email, verified
karaorchee.com sender), `acrkaraorchee` (images), CIAM tenant (below).

## Identity (CIAM)

- Tenant: `karaorcheeauth.onmicrosoft.com` / `1a19dfd9-0ec3-407d-b39b-d2374a73719b` — shared user
  pool with the web product.
- iOS App Registration **KaraOrchee App iOS** (created 2026-07-05 via Graph):
  - client/app ID `4a12e0a8-c0b8-4770-a182-0f02626c7dc5`
  - public client, redirect `msauth.com.karaorchee.karaorcheeamt://auth` (MSAL)
  - custom API scope `api://4a12e0a8-c0b8-4770-a182-0f02626c7dc5/access_as_user` — the app
    requests ONLY this scope, so the access token's `aud` is our API (never validate idToken;
    never mix Graph scopes into the request — that was the legacy trap)
  - attached to user flow `app-signup` (`e8be0cec-b63d-483f-ac8e-96786e5f2d4e`): EmailOTP only,
    collects email + displayName. Web keeps its own `signupsignin` flow (Google + EmailOTP);
    one app ↔ one flow — DETACH before re-attaching.
- Admin SPA App Registration **KaraOrchee Admin Web** (created 2026-07-06 via Graph):
  - client/app ID `af5d701a-28a5-4eec-b282-bbf97c545fc1`, SPA redirect `http://localhost:5173`
    (add the SWA URL when hosted)
  - requests the SAME api scope above → tokens carry the same audience, `api/src/auth.ts` unchanged
  - admin-consented for `access_as_user` + openid/offline_access; attached to `app-signup` flow
  - admin power comes ONLY from `users.is_admin` in Postgres (`requireAdmin`), never from the token
- API token validation: issuer `https://1a19dfd9-0ec3-407d-b39b-d2374a73719b.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b/v2.0`,
  JWKS `https://karaorcheeauth.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b/discovery/v2.0/keys`,
  audience = the client ID above. FAIL-CLOSED (see `api/src/auth.ts`).
- Roles (teacher/student/admin), trial, and subscription state live in OUR Postgres, not in Entra.

## Admin console

- `apps/admin` — Vite + React SPA, MSAL redirect flow, TanStack Query. Dev: `npm run dev`
  (localhost:5173; API base defaults to the dev container URL).
- Hosted (dev): Azure Static Web Apps `swa-karaorchee-admin-dev` →
  `https://delightful-tree-00c7c7110.7.azurestaticapps.net` (deploy: build then
  `npx @azure/static-web-apps-cli deploy ./dist --deployment-token <az staticwebapp secrets list>`).
- API surface: `/admin/*` on the same platform API, layered `requireAuth` → `requireAdmin`
  (403 unless `users.is_admin` and status active). Mutations write `audit_events`.
- Browser origins are allowlisted via `ADMIN_ORIGINS` (comma-separated env on the container app);
  native clients send no Origin and are unaffected.
- Granting a new admin: they sign in once (the console calls `/v1/users/sync`, creating their
  users row, and shows "Not an admin account"), then flip `users.is_admin` in Postgres.

## Pieces Studio

- Flow (v2, files-first): wizard uploads MusicXML + MIDI (**both mandatory** — same
  notation project) → `POST /admin/studio/drafts` → sources → `piece-sources/staging/<jobId>/`
  → **preflight lane** (`pieces-preflight` queue, worker thread) runs sanity/alignment/geometry
  in ~5s and streams per-gate results into the row while the admin fills the sectioned form
  (`PATCH .../metadata` autosave; `POST /admin/studio/checks` = duplicate findings per section)
  → `POST .../submit` re-runs ALL gates on `pieces-jobs` incl. the ~20s WebKit render
  (deliberate redundancy) → ready_for_review → human review → `POST .../publish`.
- Slugs are server-derived from composer/title/subtitle (`api/src/slug.ts`) and never
  client-writable; submit blocks slug collisions whose musical identity differs.
- Rights is a required no-default choice; public_domain requires a provenance note.
- Failed runs reopen ON THE SAME ROW (`POST .../reopen` → back to draft, re-preflights) —
  one board row per piece; attempt history lives in audit_events.
- Books are created with a MANDATORY cover (multipart `POST /admin/books`; sharp validates
  portrait ~3:4 ≥1200×1600 → `books/<id>/cover.webp` + `cover_thumb.webp`, signed URLs in
  `GET /admin/books`; `PUT /admin/books/:id/cover` replaces).
- ⚠️ verovio: the default `verovio.toolkit()` auto-init is MAIN-THREAD-ONLY (fonts fail to
  load on a worker thread → every load returns False). Always construct via
  `worker/pieces/pipeline/vrv.py::make_toolkit()` (explicit resource path).
- ⚠️ Deploys: a draining worker replica keeps its Service Bus links and steals queue
  messages minutes after `containerapp update` reports the new revision running — after a
  worker rollout, confirm the OLD replica is really gone before trusting queue behavior.

## Pieces Library (admin registry manager)

- List = search + filter chips + sortable columns + CSV export; row → LARGE slide-over
  panel (`?sel=<id>` in the URL — deep-linkable, table state never lost). `/pieces/:id`
  stays as the full-page escape hatch.
- Two edit lanes: display/catalog fields (title/composer/subtitle/difficulty/shelf/book/
  rights/note) edit IN the panel — per-guard validation (book-index clash, provenance
  required for PD, optimistic-concurrency `expectedUpdatedAt` → 409 stale_edit) → one
  Apply w/ live-catalog confirm → SQL + catalog rebuild + audit. Score-content changes =
  "Upload new version" → studio wizard with `?piece=<id>` — the draft is PINNED to the
  permanent piece id (identity never re-derived from title strings; renames can't break
  the version chain) → full gates → review → publish v(N+1).
- Lifecycle: Archive (reversible, instant catalog removal) / Take down (one step:
  archive + rights=blocked + reason recorded) / Restore (guards: has published version +
  publishable rights). Rights can't go unknown/blocked in-place while published.
- Detail shows EVERYTHING: signed downloads for every bundle file per version, original
  MusicXML/MIDI sources (studio uploads at staging/<jobId>/ AND the pre-studio archive at
  <pieceId>/ in piece-sources), engraving previews, build history (links to studio jobs),
  per-piece audit trail.

### Jobs ↔ registry consistency laws

- Two tables, two clocks: a studio_jobs row is an IMMUTABLE build record (what happened
  then); the pieces row owns the live lifecycle + published_version pointer. UIs JOIN at
  render time (job detail returns `piece {status, publishedVersion}`) — never denormalize
  "current" onto a job. A job that published stays `published` even after the piece is
  archived; the banner explains the divergence.
- Publish ordering: immutable v<N> blobs FIRST, then ONE SQL transaction (piece upsert +
  version insert + job flip), catalog rebuild AFTER commit — a half-failed publish leaves
  nothing live and retrying is idempotent. (pieceId, version) PK makes concurrent
  publishes collide loudly instead of corrupting.
- Metadata edit boundary (future Pieces management page): catalog/display fields (title,
  difficulty, rights note, book) = edit in place on the registry + catalog rebuild + audit;
  anything baked into the bundle (score files) = new version through the studio.
- Never GC a published v<N> bundle (rollback + stale app catalogs need it); only
  staging/<jobId>/ blobs of terminal non-published jobs may be swept later.
- The four gates (worker `worker/pieces/`): 1 sanity (files parse, score non-empty);
  2 alignment (score_events from MIDI — 30ms cluster, vendored parse_score — or the deadpan
  XML-timemap route when no MIDI; the czerny golden reproduces 182/182 events);
  3 geometry (vendored produce_staff: MEI freeze, 3 SVG variants, cursor anchors,
  `staff_eligible` = median timeline residual < 12ms — fails the job if the MIDI and XML
  disagree); 4 render (vendored verify_cursor: headless WebKit cursor-on-staff, the JS shim
  is byte-identical to the app's — keep in sync).
- Publish (API, admin-gated): rights must be public_domain|licensed; copies staging →
  immutable `<pieceId>/v<N>/`; upserts books/pieces + inserts piece_versions in one
  transaction; regenerates `catalog.json` FROM SQL (`api/src/catalog_build.ts` — SQL is the
  catalog truth now); audits `piece.publish`.
- The studio_jobs row is job-state truth; queue messages are only triggers (idempotent redelivery).
- Worker image: `worker/pieces/Dockerfile` (python:3.12-slim + verovio + playwright webkit),
  built via `az acr build`, deployed as always-on Container App with dburl/storagecs/sbcs secrets.

## Laws

1. Auth is fail-closed: unconfigured auth → 503 on protected routes, never pass-through.
2. Storage is private + SAS-only; the iOS app never holds an account key.
3. Config is env-vars only, validated at boot. No `activeEnv`-style file switches.
4. Piece bundles are immutable per version; re-publish = new version.
5. Server is the entitlement truth (trial/IAP/activation codes); the client is a hint.
6. Money never renders in the iOS app (referral counts only) — App Review 3.1.1/3.2.2.
