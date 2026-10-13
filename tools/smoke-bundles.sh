#!/usr/bin/env bash
# Process-level smoke test of the release bundles in dist/ against a local
# PostgreSQL server: migrate, start platform, setup, start API and worker,
# probe health, sign and verify a license, back up, and confirm that the API
# refuses a different registry. Uses scratch databases that are dropped on exit.
#
#   node tools/build.mjs && tools/smoke-bundles.sh [postgres://admin-url]
set -euo pipefail

ADMIN_URL="${1:-${TEST_DATABASE_ADMIN_URL:-postgres://localhost:5432/postgres}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
S="$(mktemp -d "${TMPDIR:-/tmp}/vm-smoke-XXXXXX")"
DB="vm_smoke_$$_a"
DB2="vm_smoke_$$_b"
BASE="${ADMIN_URL%/*}"
PIDS=()
PG_BIN_DIR="${PG_BIN_DIR:-$(dirname "$(command -v pg_dump)")}"

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "DROP DATABASE IF EXISTS $DB2 WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$S"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*" >&2; }
die() { printf '   FAIL: %s\n' "$*" >&2; exit 1; }
# check "description" command...: runs the command (use bash -c for pipelines) and aborts on failure.
check() {
  local msg="$1"; shift
  if "$@"; then ok "$msg"; else die "$msg"; fi
}
mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

common_env=(PATH="$PATH" HOME="$HOME" USER="${USER:-postgres}" NODE_ENV=production MIGRATIONS_ROOT="$DIST/migrations"
  PLATFORM_MIGRATIONS_DIR="$DIST/migrations/platform" MAINTENANCE_MIGRATIONS_DIR="$DIST/migrations/maintenance")
SECRET="$(openssl rand -hex 32)"

wait_http() {
  for _ in $(seq 1 50); do curl -fs "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done
  die "timed out waiting for $1"
}

step "create scratch databases"
psql "$ADMIN_URL" -qc "CREATE DATABASE $DB" -c "CREATE DATABASE $DB2"
URL="$BASE/$DB"; URL2="$BASE/$DB2"

step "migrate (preflight then apply)"
env -i "${common_env[@]}" PLATFORM_DATABASE_URL="$URL" node "$DIST/tools/migrate.mjs" >"$S/migrate.log"
check "preflight passes after migration" env -i "${common_env[@]}" PLATFORM_DATABASE_URL="$URL" node "$DIST/tools/migrate.mjs" --check >/dev/null

step "start platform"
env -i "${common_env[@]}" PORT=4911 PLATFORM_DATABASE_URL="$URL" PLATFORM_ISSUER=http://127.0.0.1:4911 \
  PLATFORM_SIGNING_KEY_FILE="$S/identity/key.json" node "$DIST/platform-api/main.mjs" >"$S/platform.log" 2>&1 &
PIDS+=($!)
wait_http http://127.0.0.1:4911/health/ready
REGISTRY_ID="$(curl -fs http://127.0.0.1:4911/api/v1/meta | node -pe 'JSON.parse(require("fs").readFileSync(0)).registry_id')"
ok "registry $REGISTRY_ID"

step "setup tenant"
env -i "${common_env[@]}" PLATFORM_DATABASE_URL="$URL" PLATFORM_URL=http://127.0.0.1:4911 SYSTEM_CREDENTIALS_FILE="$S/config/system-credentials.json" \
  SETUP_ADMIN_PASSWORD="smoke-admin-password-1" node "$DIST/tools/setup.mjs" --tenant-slug smoke --tenant-name Smoke --site-code S1 \
  --site-name "Site 1" --timezone Asia/Karachi --admin-email admin@smoke.test --admin-name Admin >"$S/setup.log"
check "credentials file is 0600" [ "$(mode "$S/config/system-credentials.json")" = "600" ]

api_env=("${common_env[@]}" MAINTENANCE_DATABASE_URL="$URL" PLATFORM_URL=http://127.0.0.1:4911 TOKEN_ISSUER=http://127.0.0.1:4911
  SYSTEM_CREDENTIALS_FILE="$S/config/system-credentials.json" LICENSE_PUBLIC_KEYS_FILE="$S/issuer/public-keys.json"
  BLOB_ROOT="$S/blobs" DOWNLOAD_LINK_SECRET="$SECRET")

step "start maintenance API and worker"
env -i "${api_env[@]}" PORT=4912 MONITORING_TOKEN=smoke-monitoring-token node "$DIST/maintenance-api/main.mjs" >"$S/api.log" 2>&1 &
API_PID=$!
PIDS+=($API_PID)
env -i "${api_env[@]}" WORKER_ID=smoke-w1 node "$DIST/maintenance-worker/main.mjs" >"$S/worker.log" 2>&1 &
PIDS+=($!)
wait_http http://127.0.0.1:4912/health/ready
check "core ready with no optional components" bash -c "curl -fs http://127.0.0.1:4912/health/ready | grep -q '\"optional\":{}'"
sleep 1
DETAILS="$(curl -fs -H 'authorization: Bearer smoke-monitoring-token' http://127.0.0.1:4912/health/details)"
echo "$DETAILS" | grep -q '"status":"bound"' || die "registry not bound: $DETAILS"
echo "$DETAILS" | grep -q '"worker_id":"smoke-w1"' || die "worker heartbeat missing: $DETAILS"
ok "health details: registry bound, worker heartbeat present"
check "details require credentials" [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4912/health/details)" = "401" ]

step "login and import a locally signed license"
TENANT_ID="$(psql -At "$URL" -c "select id from platform.tenant where slug='smoke'")"
INSTALL_ID="$(psql -At "$URL" -c "select value #>> '{}' from maintenance.installation_state where key='installation_id'")"
env -i "${common_env[@]}" node "$DIST/tools/license-cli.mjs" keygen --kid smoke-issuer --out-dir "$S/issuer" >/dev/null
env -i "${common_env[@]}" node "$DIST/tools/license-cli.mjs" sign --private-key "$S/issuer/smoke-issuer.private.pem" --kid smoke-issuer \
  --tenant-id "$TENANT_ID" --installation-id "$INSTALL_ID" --features core --starts 2026-01-01T00:00:00Z --ends 2099-01-01T00:00:00Z \
  --grace-days 30 --policy-tag smoke-test --out "$S/license.json" >/dev/null
env -i "${common_env[@]}" node "$DIST/tools/license-cli.mjs" verify --public-keys "$S/issuer/public-keys.json" --file "$S/license.json" \
  --tenant-id "$TENANT_ID" --installation-id "$INSTALL_ID" >"$S/lic-verify.json"
check "license verifies offline" grep -q '"status": "valid"' "$S/lic-verify.json"
# The API read the (then absent) public key file at startup; restart it to load the issuer key.
kill "$API_PID"; wait "$API_PID" 2>/dev/null || true
env -i "${api_env[@]}" PORT=4912 MONITORING_TOKEN=smoke-monitoring-token node "$DIST/maintenance-api/main.mjs" >"$S/api.log" 2>&1 &
API_PID=$!
PIDS+=($API_PID)
wait_http http://127.0.0.1:4912/health/ready
TOKEN="$(curl -fs -H 'content-type: application/json' -d '{"tenant":"smoke","email":"admin@smoke.test","password":"smoke-admin-password-1"}' \
  http://127.0.0.1:4911/api/v1/identity/sessions | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')"
STATUS="$(curl -s -o "$S/lic-import.json" -w '%{http_code}' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary @"$S/license.json" http://127.0.0.1:4912/api/v1/maintenance/licenses)"
[ "$STATUS" = "201" ] || die "license import returned $STATUS: $(cat "$S/lic-import.json")"
check "license imported through the API" grep -q '"status":"valid"' "$S/lic-import.json"

step "backup and verify"
env -i "${common_env[@]}" PLATFORM_DATABASE_URL="$URL" BLOB_ROOT="$S/blobs" PG_BIN_DIR="$PG_BIN_DIR" \
  SYSTEM_CREDENTIALS_FILE="$S/config/system-credentials.json" PLATFORM_SIGNING_KEY_FILE="$S/identity/key.json" \
  node "$DIST/tools/backup.mjs" create --out-dir "$S/backups" >"$S/backup.log"
BDIR="$(ls -d "$S"/backups/*/)"
check "backup verifies" env -i "${common_env[@]}" node "$DIST/tools/backup.mjs" verify --dir "$BDIR" >/dev/null
check "dump is 0600" [ "$(mode "$BDIR/combined.dump")" = "600" ]

step "refuse a different registry"
env -i "${common_env[@]}" PLATFORM_DATABASE_URL="$URL2" node "$DIST/tools/migrate.mjs" >/dev/null
env -i "${common_env[@]}" PORT=4921 PLATFORM_DATABASE_URL="$URL2" PLATFORM_ISSUER=http://127.0.0.1:4921 \
  PLATFORM_SIGNING_KEY_FILE="$S/identity2/key.json" node "$DIST/platform-api/main.mjs" >"$S/platform2.log" 2>&1 &
PIDS+=($!)
wait_http http://127.0.0.1:4921/health/ready
if env -i "${api_env[@]}" PORT=4922 PLATFORM_URL=http://127.0.0.1:4921 TOKEN_ISSUER=http://127.0.0.1:4921 \
  node "$DIST/maintenance-api/main.mjs" >"$S/api-wrong.log" 2>&1; then die "API started against a foreign registry"; fi
check "API refused the foreign registry" grep -q "differs from the bound registry" "$S/api-wrong.log"
if env -i "${common_env[@]}" PLATFORM_DATABASE_URL="$URL" PLATFORM_URL=http://127.0.0.1:4921 node "$DIST/tools/migrate.mjs" --check >"$S/pre-wrong.log" 2>&1; then
  die "preflight passed against a foreign registry"
fi
ok "preflight refused the foreign registry"

printf '\nSMOKE PASSED\n'
