# Decisions and discovery register

Decisions below are proposed implementation defaults derived from the PRD. Record the actual repository evidence, decision owner and date when adopting or revising them. No existing codebase or customer installation was examined for this pack.

| ID | Decision | Status and rationale |
| --- | --- | --- |
| D01 | Separate Visibility Maintenance product | Settled product direction; Core independent of Live |
| D02 | Shared registry included standalone | Settled boundary; one canonical equipment identity |
| D03 | One active source per equipment signal | R1 requirement; prevents duplicate and conflicting telemetry |
| D04 | Private on-premises first | PRD baseline; hosted deployment qualified separately |
| D05 | Modular backend plus worker | Proposed default; preserve boundaries without unnecessary service count |
| D06 | PostgreSQL transaction store | Proposed for new projects; adapt to repository evidence |
| D07 | Next.js and NestJS TypeScript stack | Proposed for new projects; existing stack may override |
| D08 | Local OIDC identity dependency | Proposed; validate internet-loss behavior and existing directory integration |
| D09 | Core has no AI/GPU dependency | Settled requirement; Neo optional |
| D10 | Frontend separate with Live deep links | R1 default; embedding can follow defined contracts |
| D11 | Read-only upstream telemetry adapters | R1 default; no machine command path |
| D12 | Licensing grace and capacity policy | Proposed commercial behavior; configurable pending launch approval |
| D13 | Private model/runtime choice | Open until hardware and evaluation evidence exist |
| D14 | Mobile client/cache protection | Open; choose supported implementation after security and device review |
| D15 | Asset consolidation strategy | Open per existing installation; preserve history and QR aliases |
| D36 | Shop-floor adoption is a follow-on plan | Proposed; `docs/15_REMBERG_SHOP_FLOOR.md`; does not reopen phases 0–9 |
| D37 | Briefing and capture are review-first | Proposed; deterministic briefing works with Neo absent |
| D38 | Planning board uses the fixed lifecycle | Proposed; schedule edits follow current reapproval rules |
| D39 | Signature and conditional steps freeze on the issued snapshot | Proposed; hidden steps are not required |
| D40 | Parts readiness warns by default | Proposed; no purchase or ERP goods issue in this plan |
| D41 | Completion-relative recurrence waits on a written rule | Proposed; rule text is in docs/15 S5 |
| D42 | Directory sign-in stays blocked with D08 | Proposed; no IdP without a customer directory |

## Discovery outputs

Identify which registry/identity services currently exist and whether they run independently of Live. Inspect actual tenant and site models, asset IDs, device mappings, API contracts, file storage, notification services and current licenses. Confirm which dependencies are truly optional.

For providers, record actual Live/OpenRemote versions, authorized access, attribute naming, event identity/timestamps, delivery mechanism and historical retention. Obtain approved sample events. Produce compatibility evidence rather than assuming source capability.

For the pilot, obtain asset list and criticality, maintenance procedures/revisions, failure codes, approval roles, timezone, operating exposure source, backup policy and device constraints. Confirm CMMS/ERP authority and whether migration is needed.

## Open decision handling

Routine implementation choices can proceed using these defaults and repository evidence. Do not block Core while provider credentials or Neo hardware are pending. Customer-owned data migration, changes to authority, commercial fee commitments and external deployment require their actual owner and authorized scope. Mark those integrations or rollouts pending while completing local work.

## Change record format

Record decision ID, observed evidence, chosen option, rationale, affected contracts, migration impact, tests, owner, date and status. Update contradictory documents when a decision changes. Never bury a product scope change in a code comment or generated endpoint.

## Change record (implementation, 12 October 2026)

Owner for every entry below: implementation team (Codex session). Status "Adopted" means implemented in this repository; it does not mean customer or commercial approval.

### Phase 0 discovery evidence

- Repository contained only this specification pack, `README.md`, `CODEX_START_PROMPT.md`, `manifest.json` and the PRD `.docx`. No commits, no `AGENTS.md`, no code, migrations, tests or package manifests.
- No Live codebase, Live registry, identity service or OpenRemote installation was available. Nothing was reused; no existing registry contract could be verified. Combined-deployment attachment to a Live registry therefore remains blocked (see D02a).
- Local tooling observed: Node 24.4, npm 11.6, Docker 29.7 with Compose v5.4, PostgreSQL 14.18 (Homebrew). Dependency versions were taken from the npm registry on this date and pinned in lockfiles.

### Adopted decisions

| ID | Evidence | Choice | Rationale and impact | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| D05 | New repository | Modular backend: `platform-api` (identity + registry), `maintenance-api`, `maintenance-worker` | Registry and identity run as a separate platform process with a distinct `platform` schema and their own HTTP contract (`/api/v1/identity`, `/api/v1/assets`). Maintenance only reaches the registry through `RegistryClient` over HTTP and keeps versioned identity snapshots (MA-08). | `tests/integration/registry.test.ts` | Adopted |
| D06 | New repository | PostgreSQL (tested on 14 and the Compose image) with schemas `platform`, `maintenance`, `integration`; plain SQL migrations per owner | Each owner migrates only its own schema; no cross-schema foreign keys from maintenance to platform. | Migration runner tests, all integration suites | Adopted |
| D07 | New repository; NestJS DI relies on `emitDecoratorMetadata`, which the esbuild-based test runner does not emit | Revised: TypeScript + Fastify 5 APIs, Vite + React 19 SPA (PWA) instead of NestJS + Next.js | No SSR requirement; static SPA simplifies LAN/offline deployment and service-worker caching. Contracts are Zod 4 schemas shared by API and web. | Typecheck, API and unit suites | Adopted (revises proposal) |
| D08 | No customer directory available | Included local identity service issuing ES256 JWTs with JWKS and OIDC discovery metadata; first-party password login, refresh tokens and client-credential service accounts | Works with no internet. The Maintenance API validates tokens by issuer, audience and JWKS URL, so an external OIDC provider can replace it once claim mapping is agreed. A full authorization-code/PKCE flow for external IdPs is not implemented. | `tests/integration/identity.test.ts` | Adopted; external IdP integration open |
| D02a | No Live registry to inspect | Standalone registry is the canonical authority. Each platform database carries an immutable `registry_id` (`GET /api/v1/meta`); setup binds the Maintenance installation to it, and API, worker and migration preflight refuse a different registry (by HTTP and by platform database) | Prevents a competing master or a re-pointed URL from forking asset identity (D23). Live registry contract compatibility is unverified. | `tests/integration/standalone-install.test.ts`, `tools/smoke-bundles.sh` | Adopted; Live registry blocked |
| D12 | PRD §21 proposed policy | Signed Ed25519 license verified locally; 30-day grace default tagged `proposed-default-pending-commercial-approval`. Missing/invalid license = setup mode: read, export, license import, user/asset administration and manual fault reporting allowed; triage acceptance, new orders, PM generation and connector requests blocked. After grace: read/export, completion of already-approved active work, manual fault reporting allowed; triage acceptance, new orders, plan generation and connector requests blocked | Manual fault reporting stays available after grace because reporting a hazard should not depend on billing state; turning it into work is blocked. Requires commercial approval before launch. | `tests/unit/entitlements.test.ts`, `tests/integration/licensing.test.ts` | Adopted as configurable default |
| D16 | PRD §8 silent on initial state of generated PM orders | Generated PM orders start in Ready when the published plan revision supplies team, procedure revision and dates; site policy `pm_initial_state` may require Pending Approval instead | The published plan revision is the approval basis and is recorded in the transition. | `tests/integration/pm.test.ts` | Adopted |
| D17 | PRD §7 lifecycle forbids asset identity edits through PATCH | `asset_id` may be set through PATCH only while the order is Draft and has no asset yet (resolving an asset-free request); it can never be changed once set | Satisfies MR-01 resolution without allowing identity rewrites. | Work-order integration tests | Adopted |
| D18 | No object store available locally | Attachment storage behind a `BlobStore` interface; filesystem driver default; optional S3-compatible driver via `BLOB_STORE=s3` and caller-supplied endpoint/credentials | Keeps standalone install self-contained. S3/MinIO is a deployment option without inventing provider hosts. | Evidence upload tests; unit driver selection | Adopted |
| D14 | Open | Browser PWA with IndexedDB cache of assigned work; cached records encrypted with a non-extractable AES-GCM WebCrypto key; cache cleared on logout | Remains open: this protects against casual disk inspection, not against script running on the same origin or a compromised device. Requires security and device review before field use. | Web unit tests for queue/sync logic | Open (implementation exists for pilot evaluation only) |
| D19 | Provider docs/versions unavailable | Live and OpenRemote adapters implement the adapter interface but refuse to connect until a qualified provider profile is configured; only the labeled simulated adapter produces events, and it is disabled unless `ALLOW_SIMULATED_CONNECTORS=true` | No guessed upstream endpoints. Provider qualification blocked on credentials and deployed versions. | Connector contract suite | Adopted; provider qualification blocked |
| D20 | PRD MP-03 "at most one overdue occurrence stays open" | While a plan/asset has an open order past its due time, newly due occurrences are recorded as `skipped_open_overdue` instead of issued. After scheduler downtime, only the latest overdue occurrence is issued and earlier ones are recorded as `missed`. Pausing and resuming does not backfill. Archived assets record `blocked_asset`. A plan revision whose procedure revision became obsolete stops generation with a visible `last_generation_issue` until a new plan revision is published | Prevents uncontrolled backlog while keeping every skipped occurrence visible; obsolete procedures are never issued silently | `tests/integration/pm.test.ts` | Adopted |
| D21 | PRD MP-04 operating-hour plans need validated meters | Cumulative meters with manual and connector provenance; a decrease suspends generation until an authorized reset/replacement baseline. Meter plans issue one order per threshold; further crossings while that order is open flag overrun instead of duplicating work. Stale or reset-suspected meters suspend generation | Same model as ingestion freshness; simulator never masquerades as a provider | `tests/integration/ingestion.test.ts` | Adopted |
| D22 | PRD MP-06 photo evidence must exist before submission | Inspections are started (`POST /inspection-results`, idempotent by `client_submission_id`), evidence is attached to the in-progress result, then submitted once (`POST /inspection-results/{id}/submit`); resubmission returns the stored outcome | Lets evidence be authorized against a real parent record; repeated submissions cannot create duplicate requests | `tests/integration/pm.test.ts` | Adopted |
| D23 | AC-21 shared-service mismatch; docs/08 "validate existing registry authority" | Platform API version (`PLATFORM_API_VERSION`) and registry ID are published at `/api/v1/meta`. Maintenance supports an explicit version range. Startup tolerates an unreachable platform (local continuity) but refuses an unbound installation, an unsupported API version or a different registry. `migrate` preflight additionally refuses a database ahead of the build or an edited migration | Detects unsafe upgrades and re-pointing before any migration is applied | `tests/integration/standalone-install.test.ts` | Adopted |
| D24 | docs/08 backup scope and AC-12 | Backup = `pg_dump` custom-format dump per database taken from an exported snapshot, attachment files with SHA-256, identity signing key and system credentials, and a manifest of row counts, schema versions, installation and registry IDs and pending outbox count. Restore verifies hashes, refuses non-empty targets, compares counts and clears stale outbox leases | Restores are provable; installation identity (license binding) and registry identity are preserved; PM uniqueness keys prevent re-issue. Backups contain secrets and must be protected; retention is a customer decision | `tests/integration/operations.test.ts`, Compose restore drill | Adopted |
| D25 | Background work needs a system identity in every site | Setup creates the `maintenance-system` service account with `auto_site_membership`; platform site creation adds such accounts to new sites | Scheduler and registry sync keep working after sites are added without manual membership grants | `tests/integration/standalone-install.test.ts` | Adopted |
| D26 | docs/08 monitoring; health detail exposes operational state | `/health/ready` stays public and depends only on core components. `/health/details` requires a tenant administrator (`maintenance.settings.manage`) or the configured `MONITORING_TOKEN`, and returns counts and ages only | Avoids leaking operational detail while supporting an external monitor. In multi-tenant hosting, details are installation-wide and must be restricted to operators | `tests/integration/operations.test.ts` | Adopted |
| D27 | docs/11 pin reviewed dependency versions; docs/08 protected secret references | One server image (bundled with esbuild, Postgres 17 client for backups) runs platform, API, worker and tools; nginx serves the SPA and proxies both APIs from one origin. Base images are pinned by digest. Secrets are files mounted as Compose secrets and read through `*_FILE` variables. `tools/sign-release.sh` builds digests, image archives, and an optional cosign-signed bundle | Release images do not need sources or dev dependencies. Cosign signing requires an operator key; customer registry push remains site-owned | Compose build and run on Docker Desktop; `npm run release:bundle` | Adopted |
| D28 | D13 open; no qualified local or cloud model | Neo uses a deterministic retrieval runtime (`deterministic-retrieval-v1`). `private_only` never calls a remote model. `cloud_permitted` is accepted as config but still does not call cloud because no model is qualified. Drafts persist as bound recommendations; the proposer cannot decide them | 40-case engineer-reviewed evaluation remains blocked | `tests/unit/neo.test.ts`, `tests/integration/neo.test.ts` | Adopted as interim; model qualification blocked |

### Shop-floor adoption register (22 October 2026)

Owner: product + implementation. S1 and S2 are in code while these decisions stay proposed. Full plan: `docs/15_REMBERG_SHOP_FLOOR.md`.

| ID | Evidence | Choice | Rationale and impact | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| D36 | remberg public CMMS compared with phases 0–8 and the PRD | Include the shop-floor list in docs/15; leave cloud-only hosting, other product lines, custom statuses, an open agent builder, floor plans, a required native app and capital planning outside this plan | Adds technician capture and planning without reopening Core or phase 9 | n/a (docs) | Proposed |
| D37 | D09 Core without Neo; D28 deterministic runtime; Neo drafts are recommendations | Briefing pack is deterministic. Narrative, field split, transcript and translation are recommendations. No transcript or translation is invented without a qualified runtime | Assignment, request text and work execution stay usable with Neo off | `tests/integration/shop-floor-s2.test.ts` | Proposed |
| D38 | PRD work-order lifecycle; material schedule changes require reapproval | The board writes `planned_start` and `planned_end` through the current patch. It adds no state | Avoids a second, unaudited status model | `tests/integration/shop-floor.test.ts` | Proposed |
| D39 | Existing `acknowledgment` checks and immutable procedure snapshots | A required signature binds signer, time and snapshot hash. `visible_when` on a check freezes in the snapshot. Hidden checks are not required. A failed visible mandatory check still opens one request | Completion evidence stays traceable after a procedure edit | `tests/integration/shop-floor.test.ts` | Proposed |
| D40 | Phase 8 parts ledger; PM generation already records generation issues | Shortage is visible. `pm_block_on_shortage` defaults off. This plan posts no purchase and no ERP goods issue | Planned work is not stopped by stock unless an administrator says so | `tests/integration/shop-floor-s3.test.ts` | Proposed |
| D41 | PRD defers completion-relative schedules until semantics exist | Adopt or revise the S5 rule before code. Calendar and meter triggers stay as they are | One open occurrence and month-end behavior stay defined | Deferred until S5 entry | Proposed |
| D42 | D08 external authorization-code flow is not implemented | Directory sign-in waits for a customer IdP. Local accounts remain | Matches the existing blocked gate | Deferred until a directory exists | Proposed |

Open pilot questions (need owners): working languages, which procedures require a signature, and whether multi-asset shutdowns are in the first pilot — listed in docs/15 S0.

### Phase plan

| Phase | Scope delivered in this repository | Gate evidence |
| --- | --- | --- |
| 1 | Monorepo, platform identity and registry, policy package, licensing, migrations, blob storage, scoped assets and maintenance profiles | Integration tests with optional systems absent |
| 2 | Requests, triage, work orders, explicit transitions, procedure revisions and snapshots, task results, labor, evidence, audit, outbox, idempotency | Request-to-closure, denied access, idempotency, stale edit tests |
| 3 | Calendar PM plans, revisions, recoverable occurrence scheduler, typed inspections | Retry, concurrency, month-end, DST, pause, failed-check tests |
| 4 | QR resolution, My Work, offline sync operations and conflicts, downtime events and amendments, KPI reports and export | Offline conflict, independent approval, KPI fixture tests |
| 5 | Docker Compose package, backup/restore scripts, grace enforcement in workers, health split, schema compatibility check | Compose smoke run and restore script run where Docker is available |
| 6 | Connector contract, ingestion pipeline, quality, dedupe, correlation, cutover, labeled simulator | Contract suite with simulated adapter; provider qualification blocked |
| 7 | Neo scoped retrieval, tool allowlist, bound approvals, deterministic no-model runtime | Policy, injection and approval tests; 40-case model evaluation blocked |
| 8 | R2 parts ledger, CMMS authority mode + exception queue, multi-site reports, auto-draft automation | `tests/integration/r2.test.ts`; external CMMS HTTP adapter remains not_qualified until a customer system is contracted |
