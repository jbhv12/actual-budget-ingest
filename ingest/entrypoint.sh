#!/bin/sh
# Routes the container to the right entry point based on INGEST_SOURCE.
#
# INGEST_SOURCE=folder (default): long-running chokidar watcher.
# INGEST_SOURCE=gmail: poll Gmail once, sleep GMAIL_POLL_INTERVAL_SEC, repeat.
#
# On Fly, we bypass this by setting [processes] in fly.toml to run
# ingest-once-gmail.js directly (one-shot per scheduled machine tick).

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
