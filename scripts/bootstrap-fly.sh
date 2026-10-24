#!/usr/bin/env bash
set -euo pipefail

: "${FLY_APP_PREFIX:?set FLY_APP_PREFIX, e.g. export FLY_APP_PREFIX=jbhv12-actual}"
FLY_ORG="${FLY_ORG:-personal}"
FLY_REGION="${FLY_REGION:-sin}"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

create_app() {
  local app="$1"
  if fly apps list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$app"; then
    echo "    $app already exists"
  else
    fly apps create "$app" --org "$FLY_ORG"
  fi
}

create_app "$FLY_APP_PREFIX-server"
create_app "$FLY_APP_PREFIX-ingest"

if ! fly volumes list --app "$FLY_APP_PREFIX-server" | grep -q actual_data; then
  fly volumes create actual_data --size 1 --region "$FLY_REGION" --yes \
    --app "$FLY_APP_PREFIX-server"
fi

cat <<EOF

Fly apps ready: $FLY_APP_PREFIX-server, $FLY_APP_PREFIX-ingest.

Next:
  fly deploy --remote-only \\
    -c $ROOT/deploy/fly/actual-server/fly.toml \\
    --app $FLY_APP_PREFIX-server

  fly deploy --remote-only \\
    -c $ROOT/deploy/fly/actual-ingest/fly.toml \\
    --app $FLY_APP_PREFIX-ingest \\
    --dockerfile ingest/Dockerfile \\
    $ROOT/ingest

Then convert ingest to a scheduled machine:
  fly machine list --app $FLY_APP_PREFIX-ingest
  fly machine update <id> --schedule monthly --app $FLY_APP_PREFIX-ingest
EOF
