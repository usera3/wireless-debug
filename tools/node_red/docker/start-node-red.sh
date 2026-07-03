#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/node_red/docker/docker-compose.yml"

if ! service docker status >/dev/null 2>&1; then
  sudo service docker start
fi

docker compose -f "$COMPOSE_FILE" up -d
