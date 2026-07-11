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
