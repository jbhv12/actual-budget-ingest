#!/usr/bin/env bash
# bootstrap-gcp.sh — one-time GCP setup for the Gmail connector.
#
# What this does automatically:
#   1. Creates a GCP project (idempotent).
#   2. Links billing (if $GCP_BILLING_ACCOUNT is set).
#   3. Enables the Gmail API.
#
# What this does NOT do (Google platform limitation, console-only):
#   4. OAuth consent screen setup (user type = Internal).
#   5. Creation of the OAuth 2.0 client ID.
#
# Steps 4-5 require ~2 minutes in the GCP Console; instructions are printed
# at the end of this script. This is the only non-IaC step in the entire
# bootstrap. Everything else is CLI.

set -euo pipefail

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID, e.g. export GCP_PROJECT_ID=actual-ingest-\$USER}"
GCP_PROJECT_NAME="${GCP_PROJECT_NAME:-Actual Ingest}"
GCP_BILLING_ACCOUNT="${GCP_BILLING_ACCOUNT:-}"

echo "==> Checking gcloud auth"
gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1 >/dev/null \
  || { echo "not authenticated. run: gcloud auth login"; exit 1; }

echo "==> Creating project $GCP_PROJECT_ID (idempotent)"
if ! gcloud projects describe "$GCP_PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$GCP_PROJECT_ID" --name="$GCP_PROJECT_NAME"
else
  echo "    project already exists"
fi

echo "==> Setting active project"
gcloud config set project "$GCP_PROJECT_ID"

if [[ -n "$GCP_BILLING_ACCOUNT" ]]; then
  echo "==> Linking billing account $GCP_BILLING_ACCOUNT"
  gcloud beta billing projects link "$GCP_PROJECT_ID" \
    --billing-account="$GCP_BILLING_ACCOUNT"
else
  echo "==> Skipping billing link (GCP_BILLING_ACCOUNT not set)."
  echo "    Gmail API has a free tier that covers personal ingest, so this"
  echo "    is often fine. Set GCP_BILLING_ACCOUNT and re-run if you want."
fi

echo "==> Enabling Gmail API"
gcloud services enable gmail.googleapis.com

cat <<EOF

================================================================
GCP automated bootstrap complete.

MANUAL STEP (one-time, ~2 minutes):
  https://console.cloud.google.com/apis/credentials/consent?project=$GCP_PROJECT_ID

  1. OAuth consent screen -> User type: Internal -> Create.
     ("Internal" skips Google's app-verification entirely. Only accounts
     in your Workspace can use the OAuth client, which is exactly what
     we want for a personal pipeline.)
  2. App name: "Actual Ingest" (any name is fine).
  3. Save.

Then create the OAuth 2.0 Client ID:
  https://console.cloud.google.com/apis/credentials?project=$GCP_PROJECT_ID
  -> Create Credentials -> OAuth client ID
  -> Application type: Desktop app
  -> Name: "actual-ingest-cli"
  -> Create -> copy client_id and client_secret.

Then run:
  export GMAIL_CLIENT_ID=<copied>
  export GMAIL_CLIENT_SECRET=<copied>
  ./scripts/get-gmail-refresh-token.sh
================================================================
EOF
