#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
venv="${WIRELESS_DEBUG_ACCEPTANCE_VENV:-/tmp/wireless-debug-acceptance-venv}"

if [[ ! -x "$venv/bin/python" ]]; then
  python3 -m venv "$venv"
fi

if ! "$venv/bin/python" -c 'import websockets' >/dev/null 2>&1; then
  "$venv/bin/pip" install --disable-pip-version-check \
    -r "$root/scripts/requirements-hardware-acceptance.txt"
fi

exec "$venv/bin/python" "$root/scripts/cloud_osc_hardware_acceptance.py" "$@"
