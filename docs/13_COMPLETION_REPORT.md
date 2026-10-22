# Implementation completion report

Date: 13 October 2026. This is an engineering status report for the Codex implementation session. It is **not** a production-readiness claim. Release acceptance remains docs/09.

## Completed phases

| Phase | Status | Locally verified |
| --- | --- | --- |
| 0 Discovery and decisions | Done | `docs/12_DECISIONS_AND_DISCOVERY.md` |
| 1 Standalone foundation | Done | Identity, registry, licensing, scoped assets |
| 2 Corrective maintenance | Done | Request-to-closure, permissions, idempotency |
| 3 Calendar PM and inspections | Done | Recurrence, pause, failed checks |
| 4 QR, My Work, offline, downtime, KPIs | Done | Sync conflicts, KPI fixtures |
| 5 Compose package, backup/restore, health | Done locally on Docker Desktop | Customer TLS/DNS and image signing unverified |
| 6 Connector contract, ingestion, meters | Done with labeled simulator | Live/OpenRemote **not qualified** |
| 7 Neo retrieval, tools, bound approvals | Done with deterministic runtime | 40-case model evaluation **blocked** |
| Web shell / PWA | Done | Technician/supervisor flows verified in browser (login → triage → WO planning/approval → My Work/QR → closure; PM publish/preview/pause; settings procedures; connectors refuse Live/OR) |
| OpenAPI / events | Done | `docs/generated/` from Zod (`npm run openapi`) |
| Neo review tools | Done | `draft_work_order`, `propose_checklist` (review-only; no model) |
| Release ops | Done locally | `tools/sign-release.sh` digests + optional cosign; optional `BLOB_STORE=s3` |
| 8 R2 | Done locally | Parts ledger, CMMS authority + exception queue, multi-site reports, approved auto-draft automation; external CMMS HTTP adapter not qualified |
| Shop-floor adoption S0–S5 | S2 implemented | S1 plus briefing, structured capture, and translations that keep the original request text. S3–S5 not started. Decisions D36–D42 remain proposed. S5 directory sign-in stays blocked with external IdP |

## Executable commands

```sh
npx tsc -p tsconfig.json
npx tsc -p apps/maintenance-web/tsconfig.json
npx vitest run
node tools/build.mjs
npm run build -w @vm/maintenance-web
```

Private deployment: see `deploy/private/README.md`.

```sh
cd deploy/private
./init-secrets.sh
cp .env.example .env   # set PUBLIC_URL
docker compose build && docker compose up -d
docker compose run --rm tools tools/setup.mjs --tenant-slug … --site-code … --timezone … --admin-email …
```

Optional Neo retrieval (no model): `docker compose -f compose.yaml -f compose.neo.yaml up -d`.

## Working entry points

| Entry | Path |
| --- | --- |
| Web | `/` through the `web` container (default `http://127.0.0.1:8080`) |
| Identity | `/api/v1/identity/sessions`, `/api/v1/identity/sites` |
| Registry | `/api/v1/assets` |
| Maintenance | `/api/v1/maintenance/*` |
| Neo | `POST /api/v1/maintenance/neo/ask`, `POST /api/v1/maintenance/recommendations/{id}/decisions` |
| Readiness | `/health/ready` (core only) |
| Operator detail | `/health/details` (admin or `MONITORING_TOKEN`) |

## Locally verified vs unverified

**Locally verified (this repository):** `npx tsc -p tsconfig.json` and `tsc -p apps/maintenance-web/tsconfig.json` clean; **17 files / 154 tests** passed (`vitest run`); web production build succeeded. Covered: platform identity and registry; maintenance requests, work orders, PM, inspections, QR, offline sync, downtime, KPIs, exports; licensing continuity; backup/restore scripts; labeled simulated connector; meter PM; condition incidents; Neo retrieval (including review-only `draft_work_order` / `propose_checklist`), document instruction filtering, bound approvals and no self-approval; R2 parts ledger, CMMS authority/exception queue, multi-site reports, and policy-gated auto-draft automation. Per-AC local evidence: `docs/09_RELEASE_EVIDENCE.md`.

**Unverified / left blocked until owners or credentials exist:**

| Gate | Why blocked |
| --- | --- |
| AC-16 / AC-17 Live and OpenRemote | Need authorized credentials, deployed versions, sample events. Adapters remain `not_qualified`. |
| AC-09 40-case Neo evaluation | No qualified local/cloud model (D13). Retrieval-only runtime ships without a model. |
| AC-01 combined Live registry | No Live registry contract to verify. |
| External IdP / directory (D08) | Customer directory not available. |
| Live nav deep link (D10) | Needs Live embedding contract. |
| Customer TLS/DNS, capacity, restore drill | Site acceptance. |
| License commercial terms (D12) | Pending commercial approval. |
| Asset consolidation (D15, AC-19) | Per existing installation. |
| Cache/device security review (D14) | Security owner. |
| External CMMS HTTP adapter | Field ownership and exception queue ship; live bidirectional sync needs a customer CMMS contract (AC-13 partial). |

Image digests and an optional cosign-signed bundle can be produced with `npm run release:bundle` when Docker and (optionally) cosign keys are available; customer registry push and site TLS remain owner tasks.

Do not treat the simulator or the deterministic Neo runtime as a qualified connector or qualified assistant.

## Required customer configuration

1. TLS terminator and DNS in front of `web`.
2. Signed license matching the installation ID and tenant, with issuer public keys in `config/license-public-keys.json`.
3. Site timezone, teams, roles and published procedure revisions.
4. Authorized provider credentials and versions before any Live/OpenRemote work.
5. Backup destination and restore drill (proposed 24 h RPO / 4 h RTO).
6. Commercial approval of the grace/continuity policy tag.

## Remaining acceptance gates (docs/09)

- Customer-server install, capacity and TLS/DNS.
- Signed release images and bundle.
- Provider qualification with authorized read access.
- 40-case Neo evaluation on a chosen runtime.
- Pilot handoff (site, assets, users, four-week observation).
- External CMMS provider qualification (bidirectional sync against a real CMMS).

Expiry never deletes data. Cloud inference is not enabled by this package. PLC writes are not implemented.
