# Phased implementation backlog

Phases express dependency order, not calendar promises. Split tasks into reviewable slices. Each completed phase must leave runnable behavior and meaningful verification.

| Phase | Build | Gate |
| --- | --- | --- |
| 0 Repository discovery | Inventory code, registry, identity, APIs, database, tests and dependencies; decide reuse | Recorded decisions and scope-preserving plan |
| 1 Standalone foundation | App/API/worker skeleton, registry, identity, tenant/site policy, local licensing, migrations, storage | Start with optional systems absent; create and read scoped assets |
| 2 Corrective maintenance | Requests, triage, work orders, assignment, issued procedures, evidence, labor, review and audit/outbox | Full request-to-closure, denied access, idempotency and stale edits |
| 3 Planned maintenance | Calendar plans, revisions, occurrence scheduler and typed inspections | Retry/concurrency/month-end/pause and failed-check scenarios |
| 4 Mobile and reliability | QR, My Work, offline execution/sync, downtime classification and core reports | Offline conflicts, independent approval and KPI fixture |
| 5 Operational qualification | Installer, backups/restore, licensing grace, observability, compatibility and upgrade | AC-15/20/21 plus local continuity and recovery |
| 6 IoT integration | Adapter contract, Live and OpenRemote mappings, ingestion, quality, correlation and cutover | AC-05/06/16/17/18; separate provider evidence |
| 7 Neo assistance | Scoped retrieval, citations, read tools, drafts, approvals and runtime policy | Reviewed 40-case evaluation and no forbidden actions |
| 8 R2 expansion | Parts ledger, CMMS authority, multi-site reporting and optional approved automation | R2 requirements and field conflict qualification |

Shop-floor capabilities taken from remberg are a separate follow-on, phases S0–S5 in `docs/15_REMBERG_SHOP_FLOOR.md`. They start from the local phase 0–8 baseline. They do not renumber phases 0–9, and they do not block docs/09, connector qualification, the Neo evaluation or phase 9. Decisions D36–D42 live in `docs/12_DECISIONS_AND_DISCOVERY.md`.

## Slice acceptance

Phase 1 includes durable asset creation, not a sample asset array. Phase 2 includes server-side state checks, not only disabled buttons. Phase 3 includes recoverable jobs, not browser timers. Phase 4 shows real missing-data coverage. Phase 5 proves Core has no Live license or application dependency.

Build the shared connector contract before provider adapters. If customer access is unavailable, implement a labeled test adapter and contract suite, mark provider qualification blocked, then continue Neo or other independent work. Never treat guessed endpoints as a completed connector.

## Definition of done

Behavior persists and enforces permissions. Migrations and contracts are documented. Relevant tests pass on the stated build. UI flows display truthful pending/error/conflict states. Observability and rollback or recovery procedures exist for changed background work. The phase report names untested provider and hardware assumptions.

## Pilot handoff

Configure one site, proposed 10–20 equipment assets and 5–10 users. Train reporter, technician and supervisor flows. Observe four weeks after acceptance, compare to a documented baseline and measure adoption, evidence quality and acknowledgment time. Changes in downtime are reported with sample counts and work mix; they are not promised from software installation alone.
