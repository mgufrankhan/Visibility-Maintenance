#!/usr/bin/env sh
# Generates installation-local secrets under ./secrets with owner-only
# permissions. Never overwrites existing values: rotating the database
# password or link secret is a planned operation (see README).
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p secrets config

gen() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

write_once() {
  if [ -e "secrets/$1" ]; then
    echo "keep    secrets/$1"
  else
    printf '%s' "$2" > "secrets/$1"
    echo "created secrets/$1"
  fi
}

write_once postgres_password "$(gen)"
write_once database_url "postgres://vm:$(cat secrets/postgres_password)@postgres:5432/visibility"
write_once download_link_secret "$(gen)"
write_once monitoring_token "$(gen)"

# Compose mounts file secrets as-is; application containers run as uid 1000.
APP_UID=1000
if [ "$(id -u)" = "0" ]; then
  chown "$APP_UID:$APP_UID" secrets/database_url secrets/download_link_secret secrets/monitoring_token
elif [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" != "$APP_UID" ]; then
  echo "warning: run 'sudo chown $APP_UID:$APP_UID secrets/database_url secrets/download_link_secret secrets/monitoring_token' so the services can read them"
fi

if [ ! -e config/license-public-keys.json ]; then
  printf '{}\n' > config/license-public-keys.json
  chmod 644 config/license-public-keys.json
  echo "created config/license-public-keys.json (empty: place the issuer's public key file here before importing a license)"
fi
