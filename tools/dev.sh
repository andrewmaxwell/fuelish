#!/usr/bin/env bash
# Runs Fuelish locally: the Worker (API + web app) on http://localhost:8787 (or $PORT) with local D1 and R2.
#   tools/dev.sh          start it
#   tools/dev.sh --pull   copy production's data down first (see tools/pull-prod.sh), then start
# Sign in with Google, or "Use the original web token" with WEB_TOKEN from server/.dev.vars.
# The web app is served straight from web/, so edits there show on reload.
set -euo pipefail
cd "$(dirname "$0")/../server"

[ -d node_modules ] || npm ci
[ -f .dev.vars ] || { cp .dev.vars.example .dev.vars; echo "Created server/.dev.vars from the example."; }

if [ "${1:-}" = "--pull" ]; then
  shift
  ../tools/pull-prod.sh "$@"
fi

npx wrangler d1 migrations apply fuelish --local >/dev/null
PORT="${PORT:-8787}"
echo "Fuelish: http://localhost:$PORT  (web token: WEB_TOKEN in server/.dev.vars)"
# 0.0.0.0 so a phone on the same Wi-Fi can upload to it too.
exec npx wrangler dev --ip 0.0.0.0 --port "$PORT"
