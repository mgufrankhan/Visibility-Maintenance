# Release evidence log (local engineering)

**Status:** Local engineering evidence only. This is **not** a production-acceptance sign-off. Customer TLS/DNS, capacity, provider credentials, commercial license terms, and Stage-site restore drills remain open (see `docs/13_COMPLETION_REPORT.md`).

| Field | Value |
| --- | --- |
| Date | 13 October 2026 |
| Product version | 0.1.0 (`packages` / root `package.json`) |
| Environment | Local Darwin; Postgres; platform `:5191`; maintenance-api `:5192`; Vite `:5173` |
| Fixture | Tenant `acme`, site `P1`, users admin/supervisor/tech, asset `PUMP-1`, signed continuity license |
| Commands | `npx tsc -p tsconfig.json`; `npx tsc -p apps/maintenance-web/tsconfig.json`; `npx vitest run`; browser exercise of SPA |

## Per-AC record

| AC | Expected | Actual (local) | Evidence | Gate |
| --- | --- | --- | --- | --- |
| AC-01 standalone registry | Standalone registry updates appear in Maintenance | Pass for standalone path | `tests/integration/standalone-install.test.ts`; assets UI | Pass local; **combined Live registry blocked** |
| AC-02 tenant/site isolation | Unauthorized IDs/exports/attachments/Neo/jobs disclose nothing | Pass | Integration auth/scope tests across packages | Pass local |
| AC-03 fault to closure | Request → order → evidence → independent close + audit | Pass | `tests/integration/corrective.test.ts`; browser triage→close | Pass local |
| AC-04 completion validation | Missing mandatory evidence blocks submit | Pass | Corrective / work-order integration tests | Pass local |
| AC-05 duplicate generation | Replay/retry yields one occurrence/request | Pass (simulator / PM workers) | `tests/integration/ingestion.test.ts`, PM tests | Pass local; Live/OR N/A |
| AC-06 event quality | Stale/unmapped/bad-unit cannot create current work | Pass for simulator path | Ingestion quality tests | Pass local; Live/OR N/A |
| AC-07 recurrence edges | Month-end, pause, meter reset | Pass | PM / meters integration tests | Pass local |
| AC-08 offline reconciliation | Offline entries survive; stale → visible conflict | Pass API; SPA queue/conflict banner exercised | `tests/integration/offline-sync.test.ts`; web offline queue | Pass local |
| AC-09 Neo grounding | Evidence-linked answers; abstain; no model claim | Pass retrieval-only; **40-case eval blocked** | `tests/integration/neo.test.ts`, `tests/unit/neo.test.ts` | Partial; model eval blocked |
| AC-10 action integrity | Stale approval / revoked permission blocked | Pass | Neo bound approval; role revoke offline test | Pass local |
| AC-11 KPI reconciliation | Section 15 sample numbers | Pass | KPI fixture / reliability tests | Pass local |
| AC-12 continuity + restore | Offline workflows; backup restore | Pass Compose/local backup path | `tests/integration/operations.test.ts`; `deploy/private` | Pass local; customer drill pending |
| AC-13 CMMS authority | Field ownership + exception queue; external CMMS HTTP not qualified | Pass local (native + exception path) | `tests/integration/r2.test.ts` | Partial; live CMMS sync blocked |
| AC-14 archived/moved assets | Block new work; history scoped | Pass | Profile / asset lifecycle tests | Pass local |
| AC-15 independent product | Live/OR/Neo absent still works | Pass | Standalone install + Compose | Pass local |
| AC-16 Live connector | Real Live events | **Blocked** — adapters `not_qualified` | Connectors UI refuse | Blocked |
| AC-17 OpenRemote connector | Real OR mappings | **Blocked** | Same | Blocked |
| AC-18 outage/cutover | 72h buffer / route switch | Pass for labeled simulator fencing | Ingestion cutover tests | Pass local; provider pending |
| AC-19 registry consolidation | Migration/rollback | **Blocked** per installation | D15 | Blocked |
| AC-20 entitlement isolation | Works without Live grant; grace | Pass | Licensing / entitlements tests | Pass local; commercial terms pending |
| AC-21 independent release | Upgrade/disable connector; version mismatch refused | Pass | Compat / migrate preflight tests; `tools/sign-release.sh` digests | Pass local; signed customer push pending |

## UI browser evidence (Stage B demo path)

Exercised on `http://127.0.0.1:5173` against the fixture above:

1. Supervisor login → create request → triage accept → planning (procedure/dates/safety) → approve.
2. Technician My Work → start queued WO → QR resolve → labor + evidence → submit completion.
3. Supervisor close.
4. Settings: publish procedure; PM planner publish / preview / pause.
5. Connectors screen states Live/OpenRemote as not qualified; simulator only when allowed.
6. Offline queue banner present in SPA (`QueueBanner`); API conflicts covered by `offline-sync.test.ts`. Browser showed conflict review text for a stale `submit_completion` against an `on_hold` order (`version_conflict` / current version 5).
7. Parts screen (`Parts` nav): stores, catalog, receive/issue against balances (API covered by `tests/integration/r2.test.ts`).

## Explicit exclusions

- No production readiness claim.
- No Live/OpenRemote qualification.
- No Neo 40-case model evaluation (no qualified model).
- No customer TLS/DNS, capacity, or commercial license approval.
- External CMMS bidirectional HTTP adapter not qualified (AC-13 partial).
- Phase 8 local: parts ledger, CMMS authority mode + exception queue, multi-site reports, `auto_draft_high_priority_request` automation — see `tests/integration/r2.test.ts`.
