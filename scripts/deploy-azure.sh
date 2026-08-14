#!/usr/bin/env bash
#
# Stand the interface up on Azure Container Apps, from nothing, in one command.
#
#   ./scripts/deploy-azure.sh --resource-group cie --location eastus
#
# Creates what is missing and leaves alone what is already there, so it is also the
# redeploy command. Everything it creates is named from --prefix, so a second stack
# alongside the first is a different prefix and nothing else.
#
# Spec section 2.3 makes Azure Container Apps the target and section 16 forbids cloud
# coupling in the code, so nothing here is reflected in the application: the image this
# pushes is the image CI builds, and it reads DATABASE_URL like it does on a laptop.
#
# Requires the Azure CLI, logged in (`az login`) with rights to create resources in the
# subscription.

set -euo pipefail

RESOURCE_GROUP=""
LOCATION="eastus"
PREFIX="cie"
INGRESS="internal"
DB_TIER="Burstable"
DB_SKU="Standard_B1ms"
SKIP_DB="false"
TAG=""

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-azure.sh --resource-group <name> [options]

  --resource-group <name>   Required. Created if it does not exist.
  --location <region>       Default: eastus
  --prefix <name>           Default: cie. Names every resource this creates.
  --ingress internal|external
                            Default: internal.

                            external publishes the interface on the public internet.
                            The interface has NO AUTHENTICATION: anyone with the URL
                            reads the whole corpus. docs/DECISIONS.md D12 records the
                            decision that this is acceptable while the corpus is OSINT,
                            and says when it stops being acceptable.

  --tag <tag>               Image tag. Default: the current short commit SHA.
  --db-tier <tier>          Default: Burstable
  --db-sku <sku>            Default: Standard_B1ms
  --skip-db                 Do not create a database. Requires DATABASE_URL in the
                            environment, pointing at one that already exists.
  -h, --help                This.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    --location)       LOCATION="$2";       shift 2 ;;
    --prefix)         PREFIX="$2";         shift 2 ;;
    --ingress)        INGRESS="$2";        shift 2 ;;
    --tag)            TAG="$2";            shift 2 ;;
    --db-tier)        DB_TIER="$2";        shift 2 ;;
    --db-sku)         DB_SKU="$2";         shift 2 ;;
    --skip-db)        SKIP_DB="true";      shift 1 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$RESOURCE_GROUP" ]; then
  echo "--resource-group is required." >&2
  usage
  exit 2
fi

if [ "$INGRESS" != "internal" ] && [ "$INGRESS" != "external" ]; then
  echo "--ingress must be internal or external." >&2
  exit 2
fi

command -v az > /dev/null 2>&1 || { echo "The Azure CLI is not installed." >&2; exit 1; }
az account show > /dev/null 2>&1 || { echo "Not logged in. Run: az login" >&2; exit 1; }

# The ACR name has to be globally unique and alphanumeric only, so it carries a suffix
# derived from the subscription id rather than a random one: re-running this script must
# find the registry it made last time rather than making another.
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
SUFFIX="$(printf '%s' "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-8)"
REGISTRY="$(printf '%sacr%s' "$PREFIX" "$SUFFIX" | tr -cd 'a-z0-9' | cut -c1-50)"
ENVIRONMENT="${PREFIX}-env"
APP="${PREFIX}-web"
MIGRATE_JOB="${PREFIX}-migrate"
DB_SERVER="${PREFIX}-db-${SUFFIX}"
IMAGE_TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Subscription $SUBSCRIPTION_ID, resource group $RESOURCE_GROUP, region $LOCATION"

az extension add --name containerapp --upgrade --only-show-errors > /dev/null
az provider register --namespace Microsoft.App --only-show-errors > /dev/null || true
az provider register --namespace Microsoft.OperationalInsights --only-show-errors > /dev/null || true

say "Resource group"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --only-show-errors -o none

say "Container registry: $REGISTRY"
if ! az acr show --name "$REGISTRY" --resource-group "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az acr create --name "$REGISTRY" --resource-group "$RESOURCE_GROUP" \
    --sku Basic --admin-enabled true --only-show-errors -o none
fi

say "Building the image in the registry, tag $IMAGE_TAG"
# Built by ACR rather than locally: no Docker daemon needed, and the image is built on
# the same architecture it runs on.
az acr build --registry "$REGISTRY" \
  --image "cie:${IMAGE_TAG}" --image "cie:latest" \
  --file Dockerfile . --only-show-errors

IMAGE="${REGISTRY}.azurecr.io/cie:${IMAGE_TAG}"

if [ "$SKIP_DB" = "true" ]; then
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "--skip-db needs DATABASE_URL in the environment." >&2
    exit 2
  fi
  say "Using the DATABASE_URL already in the environment"
else
  say "PostgreSQL 16 flexible server: $DB_SERVER"
  if az postgres flexible-server show --name "$DB_SERVER" --resource-group "$RESOURCE_GROUP" -o none 2>/dev/null; then
    echo "Already exists. Reusing it."
    if [ -z "${DB_PASSWORD:-}" ]; then
      echo "" >&2
      echo "The server exists but DB_PASSWORD is not set, and Azure will not read a" >&2
      echo "password back. Set it to the one from the first run and re-run:" >&2
      echo "  DB_PASSWORD='...' $0 $*" >&2
      exit 2
    fi
  else
    # Generated here rather than prompted, so the password never sits in a shell
    # history. It is printed once at the end and stored as a Container Apps secret.
    DB_PASSWORD="${DB_PASSWORD:-$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 28)}"
    az postgres flexible-server create \
      --name "$DB_SERVER" --resource-group "$RESOURCE_GROUP" --location "$LOCATION" \
      --admin-user cieadmin --admin-password "$DB_PASSWORD" \
      --database-name cie --version 16 \
      --tier "$DB_TIER" --sku-name "$DB_SKU" --storage-size 32 \
      --public-access 0.0.0.0 --yes --only-show-errors -o none
    NEW_DB="yes"
  fi
  DATABASE_URL="postgresql://cieadmin:${DB_PASSWORD}@${DB_SERVER}.postgres.database.azure.com:5432/cie"
fi

say "Container Apps environment: $ENVIRONMENT"
if ! az containerapp env show --name "$ENVIRONMENT" --resource-group "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az containerapp env create --name "$ENVIRONMENT" --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" --only-show-errors -o none
fi

REGISTRY_PASSWORD="$(az acr credential show --name "$REGISTRY" --query 'passwords[0].value' -o tsv)"

# Migrations run as a job, not on app start. Forward-only migrations and several
# replicas booting at once is a bad way to discover that the runner is not safe under
# concurrency, and a migration failure should stop a deploy rather than crash-loop a
# revision.
say "Applying migrations as a one-off job"
if az containerapp job show --name "$MIGRATE_JOB" --resource-group "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az containerapp job update --name "$MIGRATE_JOB" --resource-group "$RESOURCE_GROUP" \
    --image "$IMAGE" --only-show-errors -o none
else
  az containerapp job create \
    --name "$MIGRATE_JOB" --resource-group "$RESOURCE_GROUP" --environment "$ENVIRONMENT" \
    --image "$IMAGE" --trigger-type Manual --replica-timeout 900 --replica-retry-limit 0 \
    --registry-server "${REGISTRY}.azurecr.io" \
    --registry-username "$REGISTRY" --registry-password "$REGISTRY_PASSWORD" \
    --secrets "db-url=${DATABASE_URL}" \
    --env-vars "DATABASE_URL=secretref:db-url" "PGSSLMODE=require" \
    --command "npm" --args "run,migrate" \
    --cpu 0.5 --memory 1Gi --only-show-errors -o none
fi

az containerapp job start --name "$MIGRATE_JOB" --resource-group "$RESOURCE_GROUP" --only-show-errors -o none
echo "Migration job started. Follow it with:"
echo "  az containerapp job execution list -n $MIGRATE_JOB -g $RESOURCE_GROUP -o table"

say "Interface: $APP (ingress $INGRESS)"
if az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" -o none 2>/dev/null; then
  az containerapp update --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --image "$IMAGE" --only-show-errors -o none
  az containerapp ingress update --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --type "$INGRESS" --target-port 3000 --only-show-errors -o none
else
  az containerapp create \
    --name "$APP" --resource-group "$RESOURCE_GROUP" --environment "$ENVIRONMENT" \
    --image "$IMAGE" \
    --registry-server "${REGISTRY}.azurecr.io" \
    --registry-username "$REGISTRY" --registry-password "$REGISTRY_PASSWORD" \
    --secrets "db-url=${DATABASE_URL}" \
    --env-vars "DATABASE_URL=secretref:db-url" "PGSSLMODE=require" "PORT=3000" \
    --target-port 3000 --ingress "$INGRESS" \
    --min-replicas 1 --max-replicas 3 \
    --cpu 0.5 --memory 1Gi --only-show-errors -o none
fi

URL="https://$(az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" --query 'properties.configuration.ingress.fqdn' -o tsv)"

say "Done"
echo "Interface:  $URL"
echo "Health:     $URL/healthz"
echo "Image:      $IMAGE"

if [ "${NEW_DB:-}" = "yes" ]; then
  cat <<EOF

The database password was generated and is shown once:

  $DB_PASSWORD

It is stored as the Container Apps secret 'db-url' and is not recoverable from Azure.
Put it somewhere you will find it, or a redeploy will not be able to reuse this server.
EOF
fi

if [ "$INGRESS" = "external" ]; then
  cat <<'EOF'

Ingress is external and the interface has no authentication: anyone with the URL reads
the corpus. docs/DECISIONS.md D12 records why that is acceptable while everything held
is open-source intelligence, and when it stops being.

The corpus is empty until it is loaded. The load is a scheduled job against a mounted
share, per spec decision D8; docs/DEPLOY.md has it.
EOF
fi
