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

Declared in `infra/main.bicep` — but see the drift warning under Resources: the template is
no longer the whole picture. Env differences are parameters only (SKUs, min replicas).

Dev API: `https://ca-app-api-dev.graymoss-40d67a2f.centralus.azurecontainerapps.io`
— image `acrkaraorchee.azurecr.io/karaorchee-app/api:<tag>` (built via `az acr build`), secrets
`dburl`/`storagecs`/`sbcs` on the container app, AUTH_* env pointed at the CIAM iOS App
Registration. Live as of 2026-07-26: api rev 47 and `ca-notes-worker-dev` rev 0000005 both on
`a8e2429`; `ca-pieces-worker-dev` rev 0000026 still on `4ee6fc2` — the content pipeline has
not needed a rebuild since the Library closeout, and that is expected, not drift.
Database `karaorchee_app` on `pg-karaorchee-app-dev` (0021 applied as of api rev 47 — check
`select count(*) from drizzle.__drizzle_migrations` against `ls api/drizzle/*.sql`, never this
sentence);
the Pieces Library is live truth (95 published pieces as of 2026-07-19 — Czerny 599, Burgmüller
Op. 100, Hanon, flagship singles; every piece carries a first-page `thumbnail.webp` + `row_icon.webp`).
The default `/v1/catalog` serves 12 of them: the other 83 use repeat structures and are gated
behind `?caps=repeats` until the shipped app can play them.
Composers are a registry (`composers` table: canonical name + aliases + portrait + years + bio;
writes canonicalize through it — see `api/src/composer_canon.ts`). Publish gates (worker) enforce
anchor coverage/p90 residual/endpoint/`-rend` schema splits/audio-map clamp; `render_generation`
stamps staff.json + SVGs against cross-generation mixing. Corpus health tool: `tools/corpus_health/`.

**Notes (Phase B) is LIVE on dev.** Schema (everything from migration 0008 on):
`teacher_student_links`, `invites` (code+expiry+uses, `direction` — a student can invite a
teacher), `lesson_sessions` (offline-first, created at send time, `client_lesson_id`
idempotency key, `owner_role`), `note_jobs` (`failure_code` drives app copy and the retry
cap; `discarded_at`), `notes` (draft→sent→retracted, `superseded_by`, `origin`),
`note_annotations` (location jsonb, printed-bar-number unit), `note_narration_clips`
(content-hash keyed, `credits` = the vendor's own metered number), `entitlements`
(source-typed), `devices`, `platform_config`. On `users`: `organization`,
`can_view_transcripts`, and split `solo_consent_at` / `teacher_consent_at`.

**Recording is a capability, not a role**: a student records themselves and the resulting
note is born `sent` to its owner with no review step; a teacher-recorded lesson produces a
draft the teacher reviews. End-user API: invite-code linking in both directions (no user
search by design), `POST /v1/lessons` + write-SAS direct upload, teacher
review/send/retract/duplicate, student inbox/practiced/pin, `DELETE /v1/me`
(Apple 5.1.1(v) — PII scrub + cascade + audio/transcript/narration purge, CIAM Graph delete
pending). Authenticated responses carry `no-store` + `Vary: Authorization` from `requireAuth`.

Worker `ca-notes-worker-dev` runs two Service Bus lanes on one process. **notes-jobs**:
AssemblyAI (60-minute read SAS minted immediately before the vendor call so it cannot expire
while queued; `speech_models` priority `universal-3-5-pro` then `universal-2`; keyterms and
prompt both tested and left OFF) → claude-sonnet-5 with deepseek-v4-pro as availability
fallback → gates: 50-word transcript floor, quote-verbatim drop, measure-range demote (an
out-of-range bar number leaves the annotation unplaced rather than discarding it), and a
2-annotation floor below which the job fails as `thin_note`. The quote gate is the structural
one: an annotation whose quote is not in the transcript is dropped, which makes invented
instructions impossible by construction. The transcript JSON is written to
`notes-assets/transcripts/` as the durable derivative that outlives the raw audio — note
that its 90-day expiry is designed but NOT applied, so transcripts currently never expire
(`docs/open-items.md`). **notes-narration** on its own thread, so a minutes-long synthesis never
waits behind an ASR job: ElevenLabs `eleven_multilingual_v2`, fixed seed and settings, two
voices (jessica/george), clips keyed by a content hash over text+voice+model+seed+settings —
a redelivery re-pays for nothing. Config lives in `platform_config.notes_narration`; no row
means off. Narration failure never blocks a send; the app falls back to the device voice.
Note-arrived push goes out over APNs direct — no key is set yet, so `apns: null` and sends
proceed unpushed (`docs/runbooks/secret-rotation.md`).

Admin: `/admin/notes/*` (pairing/subscription/roster/invite history/trust watch) +
`/admin/note-jobs/*` (monitoring + break-glass transcript, audited, gated on
`users.can_view_transcripts`). Entitlement resolver: teacher = free; no
`monetization_live_at` = beta-free; otherwise trial =
`max(trial_started_at, monetization_live_at) + 30d`, then lapsed locks only notes sent after
the boundary.

## Resources (per env)

| Resource | Name (`<env>` suffix) | Role |
|---|---|---|
| Container App | `ca-app-api-<env>` | The API — accounts, roles, invites, notes metadata, entitlements, SAS minting, APNs push. No IAP webhook: StoreKit is deliberately unbuilt (`docs/open-items.md`), though `entitlements.source` already reserves `apple_iap` |
| Container Apps env | `cae-karaorchee-app-<env>` | Hosts the API and both workers (`ca-pieces-worker-<env>`, `ca-notes-worker-<env>`) |
| Postgres Flexible | `pg-karaorchee-app-<env>` | Relational truth: users, teacher↔student, referrals, invites, entitlements, metering |
| Storage | `stkaraoapp<env>` | `piece-bundles/` (versioned, immutable) · `piece-sources/` · `soundfont/` · `lesson-audio/` (Cool@30d, delete@90d — **live**) · `notes-assets/` (`transcripts/`, `narration/`). Public access OFF, SAS-only |
| Service Bus | `sb-karaorchee-app-<env>` | Four queues, each with a DLQ: `pieces-preflight` and `pieces-jobs` for the content pipeline; `notes-jobs` for ASR+LLM; `notes-narration` on its own lane so a minutes-long synthesis run never waits behind an ASR job |
| Key Vault | `kv-karaorchee-app-<env>` | Holds `pg-admin-password` and nothing else. Every other credential is a Container Apps secret on its consumer — see `docs/runbooks/secret-rotation.md` |
| App Insights + Log Analytics | `appi/log-karaorchee-app-<env>` | Logs, traces, alerts |

Shared, pre-existing (NOT in this repo's Bicep): `comm-karaorchee` (ACS email, verified
karaorchee.com sender), `acrkaraorchee` (images), CIAM tenant (below).

⚠️ **Only `ca-app-api-<env>` is declared in Bicep.** Both worker container apps
(`ca-pieces-worker-<env>`, `ca-notes-worker-<env>`) are CLI-created, and every app's image
tag / secrets / env are applied by `az`. Re-running the deployment against a live env resets
them. Same for storage lifecycle: of the three rules in `main.bicep` only
`lesson-audio-cool-then-delete` is applied, the live policy carries one rule
(`notes-assets-purge-deleted-versions`) that Bicep does not, and the policy is a single
replace-all resource — deploying the template would both switch on the two founder-gated
rules and drop the live one. Reconcile before creating prod. Retention decisions:
`docs/open-items.md`.

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
  portrait ~3:4, floor 900×1200, normalized output 1200×1600 → `books/<id>/cover.webp` + `cover_thumb.webp`, signed URLs in
  `GET /admin/books`; `PUT /admin/books/:id/cover` replaces).
- ⚠️ verovio: the default `verovio.toolkit()` auto-init is MAIN-THREAD-ONLY (fonts fail to
  load on a worker thread → every load returns False). Always construct via
  `worker/pieces/pipeline/vrv.py::make_toolkit()` (explicit resource path).
- ⚠️ Deploys: a draining worker replica keeps its Service Bus links and steals queue
  messages minutes after `containerapp update` reports the new revision running — after a
  worker rollout, confirm the OLD replica is really gone before trusting queue behavior.

### Engraving normalization (worker, pre-render)

`worker/pieces/pipeline/engraving_norm.py` rewrites the source MusicXML before verovio
sees it. Every rule exists because a Sibelius+Dolet export carries the engraver's intent
in a form verovio does not read. Established 2026-07-13, extended 2026-08-02 after the
engraver reviewed the rendered pages against his own.

- **A fingering's side follows its VOICE, not the staff it prints on.** In a scale the
  right hand is written on the bass staff wherever the run goes low; deciding by the
  printed staff flips those digits to the wrong side. A voice reaching DOWN into the
  staff below gets `below` regardless — verovio resolves `@place` against the LAYER's
  anchor staff, so `above` throws the digit clean outside the system.
- **Chord fingering stacks are ordered by hand** — a right-hand chord reads 1-2-5 up
  from the lowest note.
- **Pedals go to the bottom staff**, dynamics orphaned on an empty staff go above it.
- **Trailing words after a metronome fold into `<per-minute>`**, or the sentence prints
  as `(M. M. to 108.) ♩=60`.
- **Interleaved voices get a net-zero `<backup>`/`<forward>` pair at each voice switch.**
  Dolet writes a staff's two voices note by note; the importer strings the second into
  the first one's layer and the bar holds twice its meter. Refused on any measure where
  a voice re-enters BEHIND itself — the importer fills a layer forward and never seeks
  back into it, so a boundary there puts those notes after the barline.
- **A one-part score never labels its instrument** — the `print-object="no"` Sibelius
  uses does not survive the export.
- **The opening tempo is lifted to the engraver's distance** (`staff.py::lift_opening_tempo`,
  MEI `@vo`). verovio honours neither `default-y` nor `placement` from the source here.

⚠️ **Dolet tells us when it gives up, in processing instructions nothing was reading.**
`<?DoletSibelius Unrecognized line style …?>` marks a line it could not translate; it writes
nothing else and the export stays internally consistent, so every gate passes. Half the
engraver's octave lines vanished this way — 61 in Hanon Part II alone — and because Dolet's
octave compensation lives inside the same routine that writes `<octave-shift>`, the pitches
were not raised either. The published pieces printed AND SOUNDED an octave low, because the
batch reference MIDI is synthesised from the same XML by
`tools/collection_splitter/synth_midi.py`. Read these instructions from the RAW uploaded bytes
— ElementTree, `normalize_engraving` and the splitter all discard them.

Dolet dispatches by the object type Sibelius reports, built at runtime
(`sWriteMethod = 'Write' & sType; @sWriteMethod(…)`), so grepping its source for a call site
finds nothing. Only a line Sibelius reports as `OctavaLine` reaches `WriteOctavaLine`.

⚠️ **`<pitch>` is the SOUNDING pitch; an octave-shift moves only where the note prints.**
Verified minimally: C4-F4 under `octave-shift type="down"` gives MEI `@oct=3`, `@oct.ges=4`,
and score_events plays 60-65 either way. So restoring a dropped octave line means raising the
pitch by 12 AND adding the bracket — the bracket alone lowers an already-low note again.

⚠️ **Two renders of the same score are never byte-identical.** verovio gives the
document a random id and suffixes every glyph def with it, and every element that did
not come from the source (`system`, `grpSym`, …) gets its own random id of varying
length — `xmlIdChecksum` only makes the source-derived ones stable. Comparing SVG
length, or the SVG itself, therefore measures noise: a Bach invention with no
fingerings at all "changed" under a fingering-only patch. To decide whether a change
actually moved the page, strip every `id`/`href` attribute and compare what is left.

`pipeline/engrave_checks.py` reports these defects on the job card without ever failing a
build — the causes live in the source and a hard gate would block a whole book on one bar.
⚠️ Read `stranded_fingerings`'s MEDIAN, not its maximum: a scale is engraved with its
digits in a row while the run climbs past them, and the printed editions do the same.

⚠️ A reference MIDI synthesised by `tools/collection_splitter/synth_midi.py` comes from
the same timemap as the render, so **any render change invalidates it** — regenerate
before republishing or the playback-map gate fails. Its grace-note floor is squeezed from
both sides: below the 30ms onset-cluster width the ornament merges away, far above it the
event loses the staff anchor the timeline gate pairs it with.

## Pieces Library (admin registry manager)

- List = search (title/composer/subtitle/id + work title/catalogue) + filter selects
  (status/shelf/rights/instrument/work/book) + sortable columns (incl. Work column) +
  CSV export; row → LARGE slide-over panel (`?sel=<id>` in the URL — deep-linkable,
  table state never lost). `/pieces/:id` redirects into `?sel=` — ONE canonical piece
  view, so the two surfaces can never drift.
- Two edit lanes: display/catalog fields (title/composer/subtitle/difficulty/shelf/book/
  **work membership**/rights/note) edit IN the panel — per-guard validation (book-index
  clash, provenance required for PD, work_missing / work_index_without_work /
  movement_taken 409 requiring explicit `confirmMovementClash` when same work+No.+
  instrument already exists, optimistic-concurrency `expectedUpdatedAt` → 409
  stale_edit) → one Apply w/ live-catalog confirm → SQL + catalog rebuild + audit.
  Work membership is catalog metadata BY DESIGN — re-grouping/movement-number fixes
  must not require re-running the build pipeline. Score-content changes =
  "Upload new version" → studio wizard with `?piece=<id>` — the draft is PINNED to the
  permanent piece id (identity never re-derived from title strings; renames can't break
  the version chain) → full gates → review → publish v(N+1).
- Lifecycle: Archive (reversible, instant catalog removal) / Take down (one step:
  archive + rights=blocked + reason recorded) / Restore (guards: has published version +
  publishable rights). Rights can't go unknown/blocked in-place while published.
- Detail shows EVERYTHING: signed downloads for every bundle file per version (roles
  humanized in UI), original MusicXML/MIDI sources (studio uploads at staging/<jobId>/
  AND the pre-studio archive at <pieceId>/ in piece-sources), engraving previews,
  **score-facts card** (read-only — MusicXML is ground truth; empty for pre-v3 pieces
  until their next upload), **work section w/ all sibling movements**, **audio section**
  (latest build's staged preview render + published reference audio, with why-preview-
  is-never-bundled notes), build history (links to studio jobs), per-piece audit trail.
  API errors carry their human explanation end-to-end (ApiError.message = server's
  `message` field), so every guard shows its reason in the UI.

### Observability & activity logging (三层法, decided 2026-07-11)

Decision rule — where a "who did what" record belongs:
1. **`audit_events` (Postgres, append-only, keep forever)** — business-meaningful state
   changes an operator may need to reconstruct years later (all /admin mutations today;
   future: entitlement grants, account deletion). Identity = user row FK; no PII payloads.
2. **Structured request logs (stdout JSON → ContainerAppConsoleLogs_CL, 31d free
   retention)** — EVERY api request: `{kind:"http", reqId, method, route, status, ms,
   oid, admin, ua}` via `api/src/reqlog.ts`. Auth forensics: 401s appear here with
   oid=null; successful sign-ins also live in Entra CIAM's own sign-in log. Privacy
   rules: oid only (never email/display name), no bodies, no query strings, no client
   IPs (ACA ingress logs hold the IP chain if ever needed — treat as PII).
3. **App Insights (provisioned, NOT yet wired — pre-beta task)** — add
   `@azure/monitor-opentelemetry` (API) + `azure-monitor-opentelemetry` (worker) when we
   want distributed traces + live metrics; workspace-billed per GB, so dual-emitting
   overlapping data is paying twice — keep stdout as the base layer and sample traces.

Worker: one JSON line per event (`jlog()` in `worker/pieces/main.py` — lane_up/start/
gate/done/skip) carrying `job` and the originating API `reqId` (propagated through the
Service Bus message body) — KQL can join a wizard click to its worker run end-to-end.

⚠️ ACA does NOT columnize JSON stdout by default (behavior change Oct 2023): the
environment must have `--logs-dynamic-json-columns true` (enabled on dev 2026-07-11;
remember for prod). Without it everything lands as a string in `Log_s`.

Cost: ~100k req/day ≈ 2-4 GB/month ≈ within the 5 GB/month free ingestion allowance.
Piece downloads are unauthenticated by design (browse-before-login) so they appear in
request logs without identity; when licensed-gating lands, downloads become
attributable and should then also be audited in-table.

### Dead-letter runbook

Alert `alert-sb-deadletter` (action group `ag-karaorchee-ops` → founder email) fires when
any Service Bus queue dead-letters a message (delivery attempts exhausted — an upload
died without updating its job row; the wizard shows an eternal spinner).

1. Which queue: `az servicebus queue show -g rg-karaorchee-app-dev --namespace-name
   sb-karaorchee-app-dev -n pieces-jobs --query countDetails` (repeat for
   `pieces-preflight`, `notes-jobs`, `notes-narration`).
2. Peek the poison message (Service Bus Explorer in the portal is easiest) → body carries
   `{jobId}`; look the job up on the Studio board and in worker logs
   (Log Analytics `ContainerAppConsoleLogs_CL | where Log_s contains "<jobId>"`).
3. Fix the underlying cause, then mark the job failed by hand if the row is stuck on
   `running` (`UPDATE studio_jobs SET status='failed', error='dead-lettered: <reason>'`),
   and dead-letter-receive-and-complete the message to clear the alert.

### Jobs ↔ registry consistency laws

- **Publish trusts the LIVE registry, not the draft snapshot** (2026-07-09 adversarial
  review): publish re-reads the pieces row — non-publishable live rights → 409
  rights_blocked_live (a stale draft can never reverse a takedown); pinned drafts carry
  `pinnedPieceUpdatedAt` and publish 409s stale_registry if the Library row changed
  (token refreshed on reopen). The job flip inside the publish tx carries a status
  predicate — a concurrent cancel/reopen aborts the whole publish.
- **Queue sends never strand a row**: submit/retry roll the row back and 503 if the
  Service Bus send fails ('queued' has no recovery route by design).
- **catalog.json writes are ETag-guarded** (read etag → snapshot DB → conditional PUT,
  retry on 412): two racing rebuilds converge to the newest DB state — a takedown can't
  be resurrected by a slower rebuild landing later.

- Two tables, two clocks: a studio_jobs row is an IMMUTABLE build record (what happened
  then); the pieces row owns the live lifecycle + published_version pointer. UIs JOIN at
  render time (job detail returns `piece {status, publishedVersion}`) — never denormalize
  "current" onto a job. A job that published stays `published` even after the piece is
  archived; the banner explains the divergence.
- Publish ordering: immutable v<N> blobs FIRST, then ONE SQL transaction (piece upsert +
  version insert + job flip), catalog rebuild AFTER commit — a half-failed publish leaves
  nothing live and retrying is idempotent. (pieceId, version) PK makes concurrent
  publishes collide loudly instead of corrupting.
- Metadata edit boundary (shipped as the Pieces Library panel): catalog/display fields
  (title, difficulty, rights note, book) = edit in place on the registry + catalog rebuild +
  audit; anything baked into the bundle (score files) = new version through the studio.
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
5. Server is the entitlement truth (`entitlements.source` = trial | apple_iap | admin_grant |
   org); the client is a hint, never a receipt.
6. Money never renders in the iOS app (referral counts only) — App Review 3.1.1/3.2.2.
7. `npm run db:migrate` runs BEFORE the revision that needs the columns, never as part of
   container start. A missed 0007 in July made every live admin query 500 while the cached
   catalog kept serving and hid it.
