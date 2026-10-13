# Visibility Maintenance

Standalone maintenance and asset-management product. Core runs without Visibility Live, OpenRemote, Neo, sensors or a GPU.

Implementation status, commands, entry points and remaining acceptance gates: `AGENTS.md` and `docs/13_COMPLETION_REPORT.md`. Private install: `deploy/private/README.md`. **Not production-ready** until `docs/09_TEST_AND_ACCEPTANCE_PLAN.md` is satisfied.

---

# Codex implementation pack

Version 1.0 | 12 October 2026 | Engineering specification baseline

This pack translates the Visibility Maintenance PRD into implementation guidance. The product must run independently and may connect to Visibility Live or directly to OpenRemote. Neo is optional. The included shared asset registry is the only canonical equipment master.

These are proposed specifications, not evidence that code, connectors or tests already exist. The repository and third-party deployments were not inspected. Codex must examine the target repository before selecting dependencies or migrations.

## Start here

1. Give Codex `CODEX_START_PROMPT.md` and this directory.
2. Read `docs/00_PRODUCT_PRD.md`, then architecture, data and API documents.
3. Use `docs/10_IMPLEMENTATION_BACKLOG.md` to build one verified phase at a time.
4. Record implementation choices in `docs/12_DECISIONS_AND_DISCOVERY.md`.

| File | Purpose |
| --- | --- |
| docs/00_PRODUCT_PRD.md | Authoritative product scope and acceptance requirements |
| docs/01_SYSTEM_ARCHITECTURE.md | Service boundaries, dependencies and flows |
| docs/02_DATA_MODEL.md | Entities, constraints, ownership and migrations |
| docs/03_API_CONTRACTS.md | Routes, payloads, concurrency and event contracts |
| docs/04_PERMISSIONS_AND_LICENSING.md | Role grants, scope checks and entitlements |
| docs/05_UI_AND_USER_FLOWS.md | Screen behavior, navigation and mobile flows |
| docs/06_IOT_CONNECTORS.md | Live/OpenRemote adapters, mapping, replay and cutover |
| docs/07_NEO_AGENT_SPEC.md | Retrieval, tools, approvals and evaluation |
| docs/08_DEPLOYMENT_AND_OPERATIONS.md | Independent installation, recovery and observability |
| docs/09_TEST_AND_ACCEPTANCE_PLAN.md | Test fixtures, scenarios and release evidence |
| docs/10_IMPLEMENTATION_BACKLOG.md | Ordered implementation phases and completion gates |
| docs/11_REPOSITORY_AND_ENGINEERING_GUIDE.md | Suggested layout, coding boundaries and checks |
| docs/12_DECISIONS_AND_DISCOVERY.md | Proposed defaults and unresolved customer decisions |
| CODEX_START_PROMPT.md | Copyable instruction for starting implementation |

## Precedence and release rules

User instructions take precedence. The PRD defines product behavior. These engineering documents add proposed detail. If a conflict changes product behavior, record and resolve it instead of silently changing the PRD. Repository conventions take precedence over suggested framework choices when they satisfy the product boundary.

A passing core release does not imply that connectors or Neo are qualified. A simulation validates our adapter behavior, not compatibility with an actual provider. Mark credentials, upstream versions and hardware benchmarks as pending until tested.

Core completion requires installation with no Live, OpenRemote, Neo or GPU dependency. Standalone and connected are connectivity modes; on-premises and managed cloud are deployment locations. R1 targets private deployment. Hosted release requires additional operational qualification.
