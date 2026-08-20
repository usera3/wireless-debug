#!/usr/bin/env bash
set -euo pipefail
umask 027

runtime=/apps/.local/share/micromamba/envs/wireless-debug
config=/apps/conf/wireless-debug-cloud/supervisord.conf
run_dir=/apps/run/wireless-debug-cloud

mkdir -p "$run_dir/postgres"

if pid=$("$runtime/bin/supervisorctl" -c "$config" pid 2>/dev/null) && [ "$pid" != "0" ]; then
  exit 0
fi

if [ -s "$run_dir/supervisord.pid" ]; then
  pid=$(cat "$run_dir/supervisord.pid")
  if kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi

rm -f "$run_dir/supervisord.pid" "$run_dir/supervisor.sock"
exec "$runtime/bin/supervisord" -c "$config"

