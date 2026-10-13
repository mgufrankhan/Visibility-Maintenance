# Test and acceptance plan

Tests must verify product behavior and failure handling. Match the PRD's AC-01 through AC-21. Do not claim tests have passed until run against the implementation and preserve evidence.

## Test fixtures

Create two tenants, two sites in one tenant, distinct role users, shared equipment identities, an archived asset, a moving asset and one equipment item with several sensor references. Include calendar plans at month end, cumulative meters with resets, repeated source events, stale readings and a source cutover. Include approved/obsolete manuals and one injected document instruction.

Use deterministic clocks and UTC stored times; test site timezone and a timezone with daylight-saving changes. Simulated telemetry is explicitly marked. Actual provider tests require the deployed version and credentials.

## Critical tests

| Group | Cases | Evidence |
| --- | --- | --- |
| Standalone | Core starts with no optional services; assets and manual work complete | Process/dependency inventory and business records |
| Authorization | Direct IDs, relation joins, search, exports, files, jobs and Neo scope | Negative and positive policy tests |
| Workflow | Invalid transition, stale edit, mandatory evidence, self-approval, reopen | API response and retained transition history |
| Recurrence | Retry, concurrent workers, crash after commit, pause, month end, meter reset | One occurrence/order per unique key |
| Event quality | Unmapped, bad unit, stale, replay, duplicate alarm/reading | Quarantine and incident decision records |
| Connectivity | Provider loss, buffering, source switch and old epoch arrival | No duplicate current action and preserved history |
| Offline sync | Retry, uncertain save, stale state, revoked role, edited procedure | Merge/conflict records and no lost drafts |
| Registry | Rename, archive, move, consolidation, alias QR and outage | Consistent identity and migration/rollback totals |
| Licensing | No Live grant, optional grants, valid offline term, expiry/grace | Core continuity and background action restrictions |
| Recovery | Restore full package and pending outbox | Record counts, file hashes and one-time jobs |
| Neo | Grounding, conflict, abstention, injection and unauthorized tool | Engineer-reviewed evaluation report |

## KPI fixture

For one asset, use 100 verified operating hours and two distinct qualifying failures in the selected exposure period. MTBF equals 50 hours. Set their restoration durations to 2 and 4 hours in the restored cohort; MTTR equals 3 hours. Link two orders to one failure and prove it remains one failure. Overlapping downtime intervals 10:00–12:00 and 11:00–13:00 total 3 hours, not 4.

Add a zero-failure asset and an asset without operating exposure. The first shows no observed failure with exposure; the second has unavailable MTBF. Planned stops and communication loss are not unplanned failures. Show pending/open failures separately from restored MTTR.

## Verification layers

Unit tests cover policy, recurrence, state machine, units and KPI logic. Integration tests cover transactional constraints, outbox, repository isolation and idempotency. API contract tests validate schemas and permissions. UI tests exercise technician and supervisor paths, accessibility and offline conflicts. Provider qualification tests cover real adapters separately.

## Release report

For each AC ID, record build/commit, environment, fixture, expected/actual result and evidence location. Core acceptance excludes optional Neo/provider compatibility while retaining their future gates. Run performance tests on agreed hardware and disclose exclusions. A simulated demo, code review or passing unit suite alone does not establish production readiness.

Local engineering evidence for this repository is maintained in [09_RELEASE_EVIDENCE.md](./09_RELEASE_EVIDENCE.md). That log is **not** a production sign-off.
