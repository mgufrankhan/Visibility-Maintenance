# Codex starting prompt for Visibility Maintenance

Implement Visibility Maintenance using this specification pack. Begin with the standalone core and proceed through the implementation backlog. Do the authorized engineering work; ask only when a missing decision materially blocks a safe implementation.

## Product requirements

Build a separately purchasable maintenance and asset-management product with its own application, APIs, permissions and deployment package. It must work without Visibility Live, OpenRemote, Neo, sensors or a GPU. Include the required shared registry, identity, storage, scheduler, licensing and audit capabilities in standalone deployment.

Use one canonical asset registry. Maintenance owns maintenance profiles and business records. Combined deployment may reuse Live's registry only after verifying its contract and authority. Never create a second equipment master by copying asset names into another database.

Support optional connections through Live or directly to OpenRemote. Keep each behind an adapter. Activate one telemetry source per asset/signal by default. Neo is an optional assistant for evidence-based answers and drafts. It cannot bypass permissions, approve its own actions or control machines.

The standalone brand is Visibility Maintenance. In Live's navigation, the link is Maintenance. It opens this product with authenticated site and asset context.

## First execution steps

1. Read README and all relevant documents. Inspect AGENTS.md, repository structure, package manifests, database migrations and current tests.
2. Report existing components that can be reused, missing dependencies and any specification conflict. Do not claim a working provider connector from mocked results.
3. Use established repository patterns where possible. For a new repository, use the proposed stack and layout in the engineering guide, after verifying supported dependency versions.
4. Create a phase plan and implement Phase 1 in the backlog. Do not produce only a static UI or an outline. Deliver persistent behavior, authorization, migrations, setup instructions and appropriate verification.
5. Continue through the authorized phases where feasible. After each phase, summarize changed behavior, checks performed and remaining blockers. External provider validation may remain blocked without credentials; continue other independent work.

## Engineering requirements

Keep tenant/site scoping server-side, including background work, attachments, exports and Neo retrieval. Separate entitlement checks from role permissions. Use explicit work-order transitions, version checks, idempotent mutation handling and a transactional outbox.

Store timestamps in UTC and present site timezones. Separate repair labor, equipment downtime and distinct failure events. Test recurrence edge cases, duplicate events, stale signals, offline sync conflicts and cross-tenant references. Store original procedure revisions with issued work.

Use real persistent repositories. Demo fixtures and simulated connectors must be explicitly labeled and unavailable as production routes by default. Avoid placeholders in completed flows. Never embed credentials, manufacture provider endpoints or deploy to external systems without authorization.

Core must remain usable during internet or AI loss. Do not implement PLC writes. Cloud inference is disabled in private-only policy. Follow agreed licensing continuity behavior without deleting data on expiry.

## Completion report

List completed phases, executable commands, test results and deployment steps. Include working entry points and known limitations. Distinguish locally verified behavior from unverified Live/OpenRemote compatibility. State required customer configuration and any remaining acceptance gates. Do not claim production readiness until the release acceptance plan is satisfied.
