#!/usr/bin/env bash
# bootstrap-fly.sh — create and configure the 3 Fly apps.
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
create_app "$FLY_APP_PREFIX-api"
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
Fly apps created.

Next:
  1. Set secrets (see TODO-SECRETS.md).
  2. Deploy:

       # server
       fly deploy -c $ROOT/deploy/fly/actual-server/fly.toml \\
                  --app $FLY_APP_PREFIX-server

       # api — Docker context must be api-scripts/
       fly deploy -c $ROOT/deploy/fly/actual-api/fly.toml \\
                  --app $FLY_APP_PREFIX-api \\
                  --dockerfile api-scripts/Dockerfile \\
                  $ROOT/api-scripts

       # ingest — Docker context must be ingest/
       fly deploy -c $ROOT/deploy/fly/actual-ingest/fly.toml \\
                  --app $FLY_APP_PREFIX-ingest \\
                  --dockerfile ingest/Dockerfile \\
                  $ROOT/ingest

  3. For actual-ingest, convert to scheduled runs:

       fly machine update <machine-id> --schedule hourly \\
                                       --app $FLY_APP_PREFIX-ingest
================================================================
EOF
