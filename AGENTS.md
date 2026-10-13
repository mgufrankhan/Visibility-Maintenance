# Agent notes for Visibility Maintenance

Standalone maintenance product. Core must work without Visibility Live, OpenRemote, Neo, sensors or a GPU.

## Commands

```sh
npm run dev              # local stack: migrate + platform :5191 + API :5192 + worker + web :5173
npx tsc -p tsconfig.json
npx tsc -p apps/maintenance-web/tsconfig.json
npx vitest run
node tools/build.mjs
npm run build -w @vm/maintenance-web
npm run openapi
npm run release:bundle
```

`npm run dev` needs local PostgreSQL (`TEST_DATABASE_ADMIN_URL`, default `postgres://localhost:5432/postgres`). State and secrets live under `.dev/` (gitignored). First run creates database `vm_dev` and tenant `dev` / `admin@dev.local` / `dev-admin-password`.

Integration tests need the same PostgreSQL admin URL and must use the **source** migration directories. Do not rely on `MIGRATIONS_ROOT` if it points at a stale `dist/migrations`.

Private install: `deploy/private/README.md`.

```sh
npm run openapi          # Zod → docs/generated/openapi.json + events.schema.json
npm run release:bundle   # image digests + optional cosign-signed tarball (needs Docker)
```

Leave Live/OpenRemote qualification, Neo 40-case model eval, external IdP, customer TLS/DNS, commercial license terms, and external CMMS HTTP sync blocked until owners or credentials exist (see `docs/13_COMPLETION_REPORT.md`).

## Boundaries

- One canonical asset registry (`platform`). Never copy asset names into a second equipment master.
- Tenant and site scope is enforced in the API and workers, including attachments, exports, Neo retrieval and background jobs.
- Entitlements are separate from role permissions.
- Connectors sit behind the adapter contract. Live and OpenRemote are `not_qualified`. The labeled simulator is off unless `ALLOW_SIMULATED_CONNECTORS=true`.
- Neo cannot bypass permissions, approve its own drafts, close work or write to machines. Cloud inference is disabled under `private_only`.
- Do not implement PLC writes. Do not embed credentials or invent provider endpoints.
- Do not claim a working provider connector from mocked results. Do not claim production readiness until docs/09 is satisfied.

## Layout

| Path | Role |
| --- | --- |
| `apps/platform-api` | Identity and canonical asset registry |
| `apps/maintenance-api` | Maintenance HTTP API |
| `apps/maintenance-worker` | Scheduler, outbox, meters, incidents |
| `apps/maintenance-web` | Vite React SPA / PWA |
| `packages/core` | Domain services |
| `packages/connectors` | Adapter contract and labeled simulator |
| `packages/neo` | Tool allowlist and deterministic synthesizer |
| `database/migrations` | Owned SQL per schema |
