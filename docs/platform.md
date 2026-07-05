# KaraOrchee App Platform

Dedicated backend platform for the iOS app (KaraOrcheeAMT). Greenfield by decision (2026-07-05
deep-research round): the legacy `music_backend` is pattern-reference only — nothing here shares
its code, database, or storage. Shared with the rest of the company: the CIAM tenant, the ACS
email domain, and the container registry. Everything else lives in this repo + its own RGs.

## Environments

| | dev | prod |
|---|---|---|
| Resource group | `rg-karaorchee-app-dev` | `rg-karaorchee-app-prod` (not yet created) |
| Region | eastus (Postgres: eastus2 — subscription is offer-restricted for PG in eastus) | same |
| Subscription | `7f5d0970-fdd5-45ba-a9c2-635eb221f9c1` (KaraOrchee, Inc.) | same |

Declared in `infra/main.bicep`; env differences are parameters only (SKUs, min replicas).

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
  - attached to user flow `signupsignin` (`4b4e388d-d2b0-4315-b246-05651a7ce4c9`), same flow as web
- API token validation: issuer `https://1a19dfd9-0ec3-407d-b39b-d2374a73719b.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b/v2.0`,
  JWKS `https://karaorcheeauth.ciamlogin.com/1a19dfd9-0ec3-407d-b39b-d2374a73719b/discovery/v2.0/keys`,
  audience = the client ID above. FAIL-CLOSED (see `api/src/auth.ts`).
- Roles (teacher/student), trial, and subscription state live in OUR Postgres, not in Entra.

## Laws

1. Auth is fail-closed: unconfigured auth → 503 on protected routes, never pass-through.
2. Storage is private + SAS-only; the iOS app never holds an account key.
3. Config is env-vars only, validated at boot. No `activeEnv`-style file switches.
4. Piece bundles are immutable per version; re-publish = new version.
5. Server is the entitlement truth (trial/IAP/activation codes); the client is a hint.
6. Money never renders in the iOS app (referral counts only) — App Review 3.1.1/3.2.2.
