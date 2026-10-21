#!/bin/sh
set -e

case "${INGEST_SOURCE:-folder}" in
  folder)
    exec node src/ingest-watch.js
    ;;
  gmail)
    INTERVAL="${GMAIL_POLL_INTERVAL_SEC:-900}"
    echo "[entrypoint] gmail loop, interval=${INTERVAL}s"
    while true; do
      node src/ingest-once-gmail.js || echo "[entrypoint] pass failed, continuing"
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "[entrypoint] unknown INGEST_SOURCE=$INGEST_SOURCE"
    exit 1
    ;;
esac
