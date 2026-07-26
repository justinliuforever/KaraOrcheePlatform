# Infra

One Bicep template, two environments; prod differs from dev only by parameters (SKU sizes,
min replicas).

⚠️ **The template is no longer the whole platform.** It declares the API container app but
NOT `ca-pieces-worker-<env>` or `ca-notes-worker-<env>`, which are CLI-created. Image tags,
container secrets and most env vars are applied with `az` and are not represented here, so
re-running a deployment against a live environment resets them. The storage lifecycle policy
is a single replace-all resource whose live contents already differ from this file in both
directions. Reconcile before creating prod — `docs/platform.md` has the current picture.

## Deploy / update an environment

```bash
az account set --subscription 7f5d0970-fdd5-45ba-a9c2-635eb221f9c1

ENV=dev   # or prod
# centralus, NOT eastus: the subscription is Postgres-offer-restricted in eastus.
az group create -n rg-karaorchee-app-$ENV -l centralus --tags product=karaorchee-app env=$ENV

az deployment group create \
  -g rg-karaorchee-app-$ENV \
  -f infra/main.bicep \
  -p env=$ENV \
  -p operatorObjectId=$(az ad signed-in-user show --query id -o tsv) \
  -p pgAdminPassword=$PG_ADMIN_PASSWORD
```

The template is idempotent — re-running updates in place. `pgAdminPassword` is only *set* on first
create; later runs must pass the same value (kept in Key Vault as `pg-admin-password`).
Read the warning at the top before running it against dev.

## Post-deploy secrets

`kv-karaorchee-app-<env>` holds exactly one secret: `pg-admin-password`, for the Postgres
admin login `karaorchee_admin`. Everything else — storage, Service Bus, database URL, the
four vendor API keys, the APNs key — lives only as Container Apps secrets on the app that
consumes it, per company convention. The full inventory and the rotation procedure are in
`docs/runbooks/secret-rotation.md`; do not duplicate the list here.

## Not in the template (deliberate)

- CIAM App Registration — lives in the auth tenant (1a19dfd9…), managed via `az ad` / Graph.
- ACR (`acrkaraorchee`), ACS email (`comm-karaorchee`) — shared, pre-existing, other RGs.
- Front Door / Redis — deferred until scale requires them.
- Notification Hubs — not deferred, not wanted: push goes to APNs directly from the API.

## Not in the template (accidental — fix before prod)

- Both worker container apps.
- Every container app's image, secrets and env.
