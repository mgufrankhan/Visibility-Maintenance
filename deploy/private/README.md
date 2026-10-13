# Private standalone package: operator runbook

This directory installs Visibility Maintenance as an independent product with
its included identity and asset registry. Live, OpenRemote, Neo, sensors and a
GPU are not required, and nothing here installs or contacts them.

Status: verified locally on Docker Desktop (setup, health, backup, wipe and
restore, restart). Not yet qualified on a customer server; capacity and
TLS/DNS remain site acceptance items (docs/08, docs/09).

## Release images and signed bundle (D27)

From the repository root (Docker required; cosign optional):

```sh
npm run release:bundle
# or: VERSION=0.1.0 COSIGN_KEY=./cosign.key tools/sign-release.sh
```

Produces `dist/release/visibility-maintenance-$VERSION-bundle.tar.gz` with
image archives, digests, Compose files, and `SHA256SUMS`. When `COSIGN_KEY` is
set and `cosign` is installed, images and the checksum file are signed. Pushing
to a customer registry and terminating TLS remain operator steps.

## Optional S3-compatible attachments (D18)

Default storage is the local `blobs` volume (`BLOB_STORE=filesystem`). To use
MinIO or another S3-compatible endpoint you supply, set on `maintenance-api`
and `maintenance-worker`:

```sh
BLOB_STORE=s3
S3_ENDPOINT=https://minio.example.internal
S3_BUCKET=visibility-maintenance
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
# S3_FORCE_PATH_STYLE=false  # only for virtual-hosted-style endpoints
```

Do not invent provider endpoints; credentials and hostname come from the site.

## Contents

| Item | Purpose |
| --- | --- |
| `compose.yaml` | Postgres, migrate (one-shot), platform-api, maintenance-api, maintenance-worker, web, tools (profile) |
| `init-secrets.sh` | Generates `secrets/*` (owner-only) and an empty `config/license-public-keys.json` |
| `.env.example` | Non-secret settings (`PUBLIC_URL`, published port, policies) |
| `nginx/` | Single-origin reverse proxy for the web app and APIs |

Persistent named volumes: `pgdata` (database), `blobs` (attachments),
`identity` (token signing key), `config` (system credentials), `backups`.

## Host prerequisites

- Docker Engine with Compose v2, 2+ CPU, 4 GB RAM as a starting point. No
  universal capacity is claimed: benchmark the agreed pilot load on the
  agreed server before commitments.
- A DNS name and a TLS terminator (existing reverse proxy or load balancer) in
  front of the `web` port. The package publishes plain HTTP on
  `HTTP_BIND:HTTP_PORT` (default `127.0.0.1:8080`).
- A backup destination outside the host for copies of the `backups` volume.

## First install

```sh
cd deploy/private
./init-secrets.sh
cp .env.example .env            # set PUBLIC_URL to the HTTPS origin users reach
cp /path/from/issuer/public-keys.json config/license-public-keys.json
docker compose build            # or load signed release images and set VM_*_IMAGE
docker compose up -d            # api/worker restart until setup binds the registry
docker compose run --rm tools tools/setup.mjs \
  --tenant-slug acme --tenant-name "Acme" \
  --site-code P1 --site-name "Plant 1" --timezone Asia/Karachi \
  --admin-email admin@example.com --admin-name "Maintenance Admin"
docker compose restart maintenance-api maintenance-worker
```

Setup prints the administrator password once (or reads
`SETUP_ADMIN_PASSWORD`), the installation ID and the tenant ID. Send the IDs to
the license issuer; import the returned license document as the administrator
through the web app or `POST /api/v1/maintenance/licenses`. Until then the
installation runs in continuity mode: records are readable and exportable and
faults can be reported, but new work orders and PM generation are blocked.

Check readiness:

```sh
curl -fs http://127.0.0.1:8080/health/ready
curl -fs -H "authorization: Bearer $(cat secrets/monitoring_token)" http://127.0.0.1:8080/health/details
```

`/health/details` reports outbox backlog and failures, scheduler lag, PM plans
with generation issues, worker heartbeats, failing background jobs, attachment
storage, last backup age, license states and registry binding.

## Licensing

Licenses are signed offline by the issuer and verified locally against
`config/license-public-keys.json`; no license server is contacted. The worker
re-evaluates entitlements every 15 minutes and notifies administrators when a
tenant moves between valid, grace and expired. Expiry never deletes or hides
data: reading, export, fault reporting, inspections and completion of active
work continue; new work orders and PM generation stop. Grace length and limits
are issued commercial terms, not package defaults.

Restart `maintenance-api` and `maintenance-worker` after replacing the public
key file.

## Backup and restore

```sh
docker compose run --rm tools tools/backup.mjs create --out-dir /var/lib/vm/backups
docker compose run --rm tools tools/backup.mjs verify --dir /var/lib/vm/backups/<id>
```

A backup holds a snapshot-consistent dump of the platform, maintenance and
integration schemas, every attachment file with its SHA-256, the identity
signing key and system credentials, and a manifest with per-table row counts,
schema versions, installation ID, registry ID and the number of pending outbox
events. Treat backups as secret material. Copy the `backups` volume off the
host on the customer-approved schedule (proposed pilot RPO 24 h, RTO 4 h);
retention is a customer decision.

Restore only into an empty database and attachment store:

```sh
docker compose stop maintenance-api maintenance-worker platform-api web
docker compose rm -f -s postgres migrate maintenance-api maintenance-worker platform-api
docker volume rm visibility-maintenance_pgdata visibility-maintenance_blobs
docker compose up -d postgres
docker compose run --rm tools tools/backup.mjs restore --dir /var/lib/vm/backups/<id>
docker compose up -d
```

Restore verifies every file hash before loading, refuses non-empty targets,
checks row counts against the manifest and clears stale outbox leases so
pending events are delivered once. Registry identity, installation ID (and so
the license) and PM occurrence uniqueness are preserved; a restored scheduler
does not re-issue occurrences. Add `--restore-config` to also write the
signing key and system credentials when restoring onto a new host.

Run a restore drill against a scratch host at acceptance and after upgrades,
and record the manifest counts and hashes as evidence (AC-12).

## Upgrade and rollback

1. Back up and verify.
2. Check compatibility against the running platform before changing anything:
   `docker compose run --rm -e PLATFORM_URL=http://platform-api:4100 tools tools/migrate.mjs --check`.
   It fails when the database is ahead of the new build, an applied migration
   was edited, the platform API version is unsupported or the configured
   platform is a different registry.
3. Load the new images, then `docker compose up -d`. `migrate` applies pending
   migrations (platform first) and services refuse to start against schemas
   they do not match.
4. Check `/health/ready`, `/health/details` and a business smoke test (log in,
   open My Work, create and read a request).

Reverting containers alone does not undo migrations: database rollback means
restoring the pre-upgrade backup.

## Secrets

`secrets/` holds the database password and URL, the download link secret and
the monitoring token (0600). Services read them through `*_FILE` variables.
On Linux, `init-secrets.sh` must run as root or the files must be owned by uid
1000 so the application containers can read them. Rotating the database
password requires updating both `postgres_password` (via `ALTER ROLE`) and
`database_url`, then restarting services.

## Optional profiles

```sh
# Labeled simulator only — not a Live or OpenRemote connector.
ALLOW_SIMULATED_CONNECTORS=true docker compose up -d

# Deterministic Neo retrieval (no model, no GPU, no cloud calls).
docker compose -f compose.yaml -f compose.neo.yaml up -d
```

Live, OpenRemote and a qualified Neo model are not shipped. Their absence
never affects core readiness. Simulated connectors are refused unless
`ALLOW_SIMULATED_CONNECTORS=true`. This package never enables cloud inference.
