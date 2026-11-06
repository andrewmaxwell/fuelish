#!/usr/bin/env bash
# Copies production's data (database and recordings) into the local dev server's storage, so
# tools/dev.sh shows your real trips. Only reads production. Replaces the local database.
#   tools/pull-prod.sh             database + recordings (APKs skipped)
#   tools/pull-prod.sh --db-only   just the database (trip pages that need raw chunks won't load)
#   tools/pull-prod.sh --apks      also copy the published APKs
# Needs `npx wrangler login` (once) for an account that can read the production Worker's storage.
set -euo pipefail
cd "$(dirname "$0")/../server"

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The local server is running on :8787. Stop it first (its storage can't be replaced while open)." >&2
  exit 1
fi
[ -d node_modules ] || npm ci
node scripts/pull-prod.mjs "$@"
