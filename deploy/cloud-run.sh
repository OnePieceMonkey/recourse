#!/usr/bin/env bash
# Deploy the committed tree (HEAD) to Google Cloud Run as one service.
#   deploy/cloud-run.sh --secrets   store/refresh secrets from .env and create missing keys
#   deploy/cloud-run.sh             build, push, print the deploy command
# The final `gcloud run deploy` is printed, not run: the owner starts it.
set -euo pipefail

PROJECT="${GCP_PROJECT:-recourse-agents-2026}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE=recourse
REPO=recourse
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
URL="https://$SERVICE-$NUMBER.$REGION.run.app"
SA="$NUMBER-compute@developer.gserviceaccount.com"

put_secret() { # put_secret <name>  (value on stdin, never echoed)
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --data-file=- --project "$PROJECT" >/dev/null
  else
    gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --project "$PROJECT" \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  echo "secret $1 stored"
}
from_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
has_secret() { gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; }

if [ "${1:-}" = "--secrets" ]; then
  for pair in database-url:RECOURSE_PROD_DATABASE_URL paypal-client-id:PAYPAL_CLIENT_ID paypal-client-secret:PAYPAL_CLIENT_SECRET \
              paypal-webhook-id:PAYPAL_WEBHOOK_ID openrouter-api-key:OPENROUTER_API_KEY gemini-api-key:GEMINI_API_KEY; do
    name="${pair%%:*}"; key="${pair#*:}"; value="$(from_env "$key")"
    if [ -z "$value" ] && [ "$key" = "GEMINI_API_KEY" ]; then value="${GEMINI_API_KEY:-}"; fi
    [ -n "$value" ] && printf '%s' "$value" | put_secret "$name" || echo "skip $name ($key empty)"
  done
  # Identities are created once and never rotated: receipts must stay verifiable.
  for name in signing-key publisher-key-northwind publisher-key-quickcheck publisher-key-tipjar; do
    has_secret "$name" || node deploy/gen-key.mjs | put_secret "$name"
  done
  has_secret admin-token || node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))' | put_secret admin-token
  exit 0
fi

gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$PROJECT" --quiet
policy="$(mktemp)"
cat > "$policy" <<'JSON'
[{"name": "keep-newest-2", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
 {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"tagState": "any"}}]
JSON
gcloud artifacts repositories set-cleanup-policies "$REPO" --location "$REGION" --project "$PROJECT" --policy "$policy" --no-dry-run --quiet >/dev/null
rm -f "$policy"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null

# Build from HEAD only, so uncommitted files and .env never reach the image.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/$SERVICE:$(git rev-parse --short HEAD)"
docker buildx build --platform linux/amd64 -f "$STAGE/deploy/Dockerfile" -t "$IMAGE" --push "$STAGE"

SECRETS="DATABASE_URL=database-url:latest,RECOURSE_SIGNING_KEY=signing-key:latest,RECOURSE_ADMIN_TOKEN=admin-token:latest"
SECRETS="$SECRETS,PUBLISHER_KEY_NORTHWIND=publisher-key-northwind:latest,PUBLISHER_KEY_QUICKCHECK=publisher-key-quickcheck:latest,PUBLISHER_KEY_TIPJAR=publisher-key-tipjar:latest"
for pair in PAYPAL_CLIENT_ID:paypal-client-id PAYPAL_CLIENT_SECRET:paypal-client-secret PAYPAL_WEBHOOK_ID:paypal-webhook-id \
            OPENROUTER_API_KEY:openrouter-api-key GEMINI_API_KEY:gemini-api-key RECOURSE_AGENT_STATE:agent-state; do
  has_secret "${pair#*:}" && SECRETS="$SECRETS,${pair%%:*}=${pair#*:}:latest"
done
ENVS="RECOURSE_PUBLIC_URL=$URL/recourse,RECOURSE_APP_URL=$URL,PUBLISHER_PUBLIC_URL=$URL/publishers"
ENVS="$ENVS,RECOURSE_FETCH_REWRITE=$URL/publishers=http://127.0.0.1:4030,RECOURSE_SIGNING_KEY_ID=recourse-1,PAYPAL_ENV=sandbox"

# max-instances 1: the agent's demo identity and rate limits live per process.
cat <<CMD

Image pushed. To go live, run:

gcloud run deploy $SERVICE --project $PROJECT --region $REGION --image $IMAGE \\
  --execution-environment gen2 --cpu 2 --memory 2Gi --max-instances 1 --min-instances 0 \\
  --port 8080 --timeout 300 --allow-unauthenticated \\
  --set-env-vars "$ENVS" \\
  --set-secrets "$SECRETS"

Service URL will be: $URL
CMD
