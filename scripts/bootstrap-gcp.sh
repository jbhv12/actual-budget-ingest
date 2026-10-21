#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID, e.g. export GCP_PROJECT_ID=actual-ingest-\$USER}"
GCP_PROJECT_NAME="${GCP_PROJECT_NAME:-Actual Ingest}"
GCP_BILLING_ACCOUNT="${GCP_BILLING_ACCOUNT:-}"

gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1 >/dev/null \
  || { echo "not authenticated. run: gcloud auth login"; exit 1; }

if ! gcloud projects describe "$GCP_PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$GCP_PROJECT_ID" --name="$GCP_PROJECT_NAME"
fi

gcloud config set project "$GCP_PROJECT_ID"

if [[ -n "$GCP_BILLING_ACCOUNT" ]]; then
  gcloud beta billing projects link "$GCP_PROJECT_ID" \
    --billing-account="$GCP_BILLING_ACCOUNT"
fi

gcloud services enable gmail.googleapis.com

cat <<EOF

Automated GCP bootstrap done.

Google requires the next two steps in the console (OAuth client creation
cannot be scripted — platform limitation):

  https://console.cloud.google.com/apis/credentials/consent?project=$GCP_PROJECT_ID
    OAuth consent screen -> User type: Internal -> Create.

  https://console.cloud.google.com/apis/credentials?project=$GCP_PROJECT_ID
    Create Credentials -> OAuth client ID -> Desktop app -> Create.
    Copy client_id and client_secret.

Then:
  export GMAIL_CLIENT_ID=<copied>
  export GMAIL_CLIENT_SECRET=<copied>
  ./scripts/get-gmail-refresh-token.sh
EOF
