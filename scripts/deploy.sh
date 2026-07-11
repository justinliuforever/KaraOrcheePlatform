#!/usr/bin/env bash
# One deploy path for every component. The tag is computed ONCE from HEAD and reused
# for both build and update — an amend after building can no longer strand a revision
# on a nonexistent tag (single-revision mode keeps the OLD code serving while the new
# one crash-loops, so healthz alone cannot tell you which code runs; check revisions).
set -euo pipefail
COMPONENT="${1:?usage: scripts/deploy.sh <api|worker|admin> [env]}"
ENV="${2:-dev}"
ACR=acrkaraorchee
RG="rg-karaorchee-app-${ENV}"

[ -z "$(git status --porcelain)" ] || { echo "dirty tree — commit first (the image tag would lie)"; exit 1; }
TAG="$(git rev-parse --short HEAD)"

case "$COMPONENT" in
  api)
    IMG="${ACR}.azurecr.io/karaorchee-app/api:${TAG}"
    az acr build -r "$ACR" -t "$IMG" api
    az containerapp update -n "ca-app-api-${ENV}" -g "$RG" --image "$IMG" --query properties.latestRevisionName -o tsv
    echo "verify: az containerapp revision list -n ca-app-api-${ENV} -g ${RG} -o table   # single active revision on ${TAG}"
    ;;
  worker)
    IMG="${ACR}.azurecr.io/karaorchee-app/pieces-worker:${TAG}"
    az acr build -r "$ACR" -t "$IMG" worker/pieces
    az containerapp update -n "ca-pieces-worker-${ENV}" -g "$RG" --image "$IMG" --query properties.latestRevisionName -o tsv
    echo "verify: wait until the OLD revision is fully gone before trusting queue behavior (draining replicas steal Service Bus messages)"
    ;;
  admin)
    (cd apps/admin && BUILD_SHA="$TAG" npm run build)
    npx -y @azure/static-web-apps-cli@latest deploy apps/admin/dist \
      --deployment-token "$(az staticwebapp secrets list -g "$RG" -n "swa-karaorchee-admin-${ENV}" --query properties.apiKey -o tsv)" \
      --env production
    ;;
  *) echo "unknown component: $COMPONENT"; exit 1 ;;
esac
