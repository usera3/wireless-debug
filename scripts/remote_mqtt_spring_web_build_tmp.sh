#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_SRC="$REPO_ROOT/tools/remote_mqtt_spring/web-react"
BUILD_DIR="${TMPDIR:-/tmp}/wireless-debug-remote-web-react-build"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp -a "$WEB_SRC"/. "$BUILD_DIR"/
rm -rf "$BUILD_DIR/node_modules" "$BUILD_DIR/dist"

(
  cd "$BUILD_DIR"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund --progress=false
  else
    npm install --no-audit --no-fund --progress=false
  fi
  export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://localhost:18080}"
  npm run build
)

rm -rf "$WEB_SRC/dist" "$WEB_SRC/node_modules"
cp -a "$BUILD_DIR/package-lock.json" "$WEB_SRC/package-lock.json"
cp -a "$BUILD_DIR/dist" "$WEB_SRC/dist"

echo "Built React assets into $WEB_SRC/dist"
