#!/usr/bin/env bash
# bootstrap-fly.sh — create and configure the 2 Fly apps.
#
# Only 2 apps are deployed to Fly (actual-server + actual-ingest).
# The local docker-compose stack has a third convenience service,
# actual_api, for curl-based debugging. In production, the ingest
# container embeds the Actual client directly via @actual-app/api,
# so no sidecar is needed.
#
# Idempotent. Safe to re-run.
#
# Requires:
#   - fly CLI authenticated: `fly auth login`
#   - FLY_APP_PREFIX exported, e.g. export FLY_APP_PREFIX=jbhv12-actual
#   - FLY_ORG (optional; default is "personal")
#   - FLY_REGION (optional; default is "sin")

set -euo pipefail

: "${FLY_APP_PREFIX:?set FLY_APP_PREFIX, e.g. export FLY_APP_PREFIX=jbhv12-actual}"
FLY_ORG="${FLY_ORG:-personal}"
FLY_REGION="${FLY_REGION:-sin}"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

create_app() {
  local app="$1"
  if fly apps show "$app" >/dev/null 2>&1; then
    echo "    $app already exists"
  else
    fly apps create "$app" --org "$FLY_ORG"
  fi
}

echo "==> Creating Fly apps"
create_app "$FLY_APP_PREFIX-server"
create_app "$FLY_APP_PREFIX-ingest"

echo "==> Ensuring persistent volume for actual-server"
if ! fly volumes list --app "$FLY_APP_PREFIX-server" | grep -q actual_data; then
  fly volumes create actual_data --size 1 --region "$FLY_REGION" --yes \
    --app "$FLY_APP_PREFIX-server"
else
  echo "    volume actual_data already exists"
fi

cat <<EOF

================================================================
Fly apps created: $FLY_APP_PREFIX-server, $FLY_APP_PREFIX-ingest.

Next:
  1. Set secrets (see TODO-SECRETS.md).
  2. First deploy:

       # server (public web)
       fly deploy --remote-only \\
         -c $ROOT/deploy/fly/actual-server/fly.toml \\
         --app $FLY_APP_PREFIX-server

       # ingest — Docker context is ingest/
       fly deploy --remote-only \\
         -c $ROOT/deploy/fly/actual-ingest/fly.toml \\
         --app $FLY_APP_PREFIX-ingest \\
         --dockerfile ingest/Dockerfile \\
         $ROOT/ingest

  3. Convert ingest to a scheduled machine (monthly):

       fly machines list --app $FLY_APP_PREFIX-ingest
       fly machine update <machine-id> \\
         --schedule monthly \\
         --app $FLY_APP_PREFIX-ingest

     After this, Fly spins the machine up on the first of each month,
     runs the Gmail poll, and the machine exits. Zero cost between runs.

  4. Scale-to-zero on actual-server is baked into its fly.toml.
     The UI wakes up on first request (~5-10s cold start).
================================================================
EOF
