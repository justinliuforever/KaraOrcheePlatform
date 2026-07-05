# Infra

One Bicep template, two environments. Everything the app platform runs on is declared in `main.bicep`;
prod differs from dev only by parameters (SKU sizes, min replicas).

## Deploy / update an environment

```bash
az account set --subscription 7f5d0970-fdd5-45ba-a9c2-635eb221f9c1

ENV=dev   # or prod
az group create -n rg-karaorchee-app-$ENV -l eastus --tags product=karaorchee-app env=$ENV

az deployment group create \
  -g rg-karaorchee-app-$ENV \
  -f infra/main.bicep \
  -p env=$ENV \
  -p operatorObjectId=$(az ad signed-in-user show --query id -o tsv) \
  -p pgAdminPassword=$PG_ADMIN_PASSWORD
```

The template is idempotent — re-running updates in place. `pgAdminPassword` is only *set* on first
create; later runs must pass the same value (kept in Key Vault as `pg-admin-password`).

## Post-deploy secrets

Stored in `kv-karaorchee-app-<env>`:

- `pg-admin-password` — Postgres admin (`karaorchee_admin`)
- (Phase B) `assemblyai-api-key`, `anthropic-api-key`, `acs-connection-string`, `apns-key`

The API container gets its config as Container Apps secrets/env vars (connection strings, per
company convention), sourced from Key Vault by the operator at deploy time.

## Not in the template (deliberate)

- CIAM App Registration — lives in the auth tenant (1a19dfd9…), managed via `az ad` / Graph.
- ACR (`acrkaraorchee`), ACS email (`comm-karaorchee`) — shared, pre-existing, other RGs.
- Front Door / Redis / Notification Hubs — deferred until scale requires them.
