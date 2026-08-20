#!/usr/bin/env bash
set -euo pipefail

root=/apps/svr/wireless-debug-cloud
runtime=/apps/.local/share/micromamba/envs/wireless-debug
config=/apps/conf/wireless-debug-cloud/app.env

set -a
. "$config"
set +a

for attempt in $(seq 1 60); do
  if "$runtime/bin/pg_isready" -q -h 127.0.0.1 -p 5432 -U wireless_debug -d wireless_debug; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

for attempt in $(seq 1 30); do
  if timeout 1 bash -c '</dev/tcp/127.0.0.1/1883' 2>/dev/null; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Mosquitto did not become ready" >&2
    exit 1
  fi
  sleep 1
done

cd "$root/app"
exec "$runtime/bin/waitress-serve" \
  --listen="${APP_HOST:-0.0.0.0}:${APP_PORT:-18088}" \
  app:app

