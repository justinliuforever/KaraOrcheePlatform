# Runbook: secret rotation

Inventory of every long-lived credential, where it lives, and how to rotate it.
Rotation order is always: mint new → update consumers → verify → revoke old.

| Secret | Consumers | Rotate with |
|---|---|---|
| Storage connection string (stkaraoappdev) | api (STORAGE_CONNECTION_STRING), worker | az storage account keys renew --key key2 → update secrets → verify → renew key1 |
| Service Bus connection (sb-karaorchee-app-dev) | api (SERVICEBUS_CONNECTION_STRING), worker | az servicebus namespace authorization-rule keys renew (SecondaryKey first) |
| Postgres password | api/worker DATABASE_URL | az postgres flexible-server update --admin-password → update secrets |
| SWA deployment token | deploy.sh (admin deploys) | az staticwebapp secrets reset-api-key; fetched fresh each deploy — no stored copy |
| Log Analytics access | api (managed identity) | Nothing to rotate — token-based, no secret exists |
| CIAM App Registrations (iOS + admin SPA) | public clients | No client secrets exist (PKCE/SPA flows) — nothing to rotate |
| APNs auth key (.p8, Apple Developer) | api (APNS_PRIVATE_KEY) | Create a second key in the portal → set the new secret + APNS_KEY_ID → verify a send → revoke the old key. Apple allows two active keys, so this is zero-downtime. |

## APNs first-time setup (Apple Developer account — founder only)

Notifications are the note-arrived push. Until all three steps land the API runs with
`apns: null`: sends succeed exactly as today and no push is attempted. Nothing crashes, no
send is blocked, and the app degrades to "no pushes" — it never fails to deliver a note.

1. **Key** — developer.apple.com → Certificates, Identifiers & Profiles → Keys → **+** →
   name it `KaraOrchee APNs`, tick **Apple Push Notifications service (APNs)**, Continue,
   Register, **Download** the `AuthKey_XXXXXXXXXX.p8`. It downloads ONCE — keep it in the
   password manager, not in either repo. Note the 10-char **Key ID** and the **Team ID**
   (`BLTUYJ4NAD`, top right of the portal).
2. **Bundle capability** — same portal → Identifiers → `com.karaorchee.karaorcheeamt` →
   tick **Push Notifications** → Save. Then in Xcode: KaraOrcheeAMT target → Signing &
   Capabilities → **+ Capability** → Push Notifications. That writes `aps-environment` into
   `App/KaraOrcheeAMT.entitlements`; keep the change (`project.yml` already points at that
   file, so `xcodegen generate` preserves it). Without it the app still builds and runs —
   registration just fails, and the app carries on with no pushes.
3. **Storage** — one pass, from the directory holding the .p8. The key is base64'd because
   a multi-line PEM does not survive the shell → ARM → container-env hops:

   ```
   az containerapp secret set -n ca-app-api-dev -g rg-karaorchee-app-dev \
     --secrets apns-key="$(base64 -i AuthKey_XXXXXXXXXX.p8)"

   az containerapp update -n ca-app-api-dev -g rg-karaorchee-app-dev \
     --set-env-vars APNS_PRIVATE_KEY=secretref:apns-key \
                    APNS_KEY_ID=XXXXXXXXXX \
                    APNS_TEAM_ID=BLTUYJ4NAD \
                    APNS_ENVIRONMENT=sandbox
   ```

   `APNS_ENVIRONMENT` is **sandbox** for Xcode builds and **production** for TestFlight and
   the App Store — a token minted under one is rejected by the other. `APNS_BUNDLE_ID`
   defaults to `com.karaorchee.karaorcheeamt` and only needs setting if that ever changes.

Verify: the three APNs vars are all-or-nothing — a partial set fails the API at boot with
`apns group incomplete; missing: …` rather than starting up silently push-less. After the
restart, send a note to a student who has opened the app since the capability shipped and
confirm the banner; `note.send` audit rows carry `push: {attempted, delivered, pruned}`.

## Container app secret update procedure (storage example, two-key zero-downtime)

1. Renew the UNUSED key:      az storage account keys renew -g rg-karaorchee-app-dev -n stkaraoappdev --key key2
2. Build its connection string and set it on both apps:
   az containerapp secret set -n ca-app-api-dev -g rg-karaorchee-app-dev --secrets storageconn="<new>"
   az containerapp secret set -n ca-pieces-worker-dev -g rg-karaorchee-app-dev --secrets storageconn="<new>"
3. Restart revisions (secret changes don't auto-roll):
   az containerapp revision restart -n ca-app-api-dev -g rg-karaorchee-app-dev --revision <active>
4. Verify: /healthz ok, admin loads a signed cover, worker processes a preflight.
5. Renew the now-retired key1.

Cadence: storage + SB + PG yearly or on any suspected exposure; always after a
laptop loss or repo-history secret scare (none as of 2026-07-11 — history scanned clean).
