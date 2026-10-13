# Data model and migration specification

This is a logical schema, not executable migration SQL. Map it to the inspected repository database. The proposed new-project database is PostgreSQL with platform, maintenance and integration ownership boundaries.

## Common fields and constraints

Use immutable UUID identifiers, tenant_id, site_id where relevant, created_at, updated_at, created_by and integer version. Store timestamps with timezone semantics in UTC. Use decimal numeric types for cost and meter readings; record currency and unit explicitly. Foreign keys must enforce tenant identity, not merely the globally unique ID.

Prefer composite uniqueness and references such as (tenant_id, id). Cross-service references require an authorized registry lookup and a retained identity version. For every mutable entity, define allowed edits, archival and retention. Asset history is not cascade-deleted.

| Entity | Essential fields | Constraint |
| --- | --- | --- |
| platform.asset | tenant, site, parent, name, code, type, location, lifecycle | Canonical ID; hierarchy cannot cycle or cross tenant |
| platform.external_asset_ref | provider, instance, external ID, canonical ID | Unique provider instance/external reference within tenant |
| maintenance.profile | asset, maintainable, criticality, team | Unique tenant/asset |
| maintenance.request | origin, reporter, asset or location, priority, triage, order | Acceptance decision occurs once |
| maintenance.work_order | asset/category, type, state, team, assignee, due, procedure revision | Unique tenant/site/display number; optimistic version |
| maintenance.transition | order, old/new state, actor, reason, version, time | Append-only; unique order/new version |
| maintenance.task_result | order, task revision, typed result, actor, evidence | Required checks validated against issued revision |
| maintenance.labor_entry | order, person, start/end or duration, rate snapshot | Nonnegative duration; amendment retains original |
| maintenance.plan | asset, revision, trigger, interval, due basis, team, status | Published revisions immutable |
| maintenance.occurrence | plan, revision, asset, scheduled time/threshold, order | Unique plan/asset/occurrence key |
| maintenance.inspection_result | template revision, asset, typed checks, client ID | Unique submission key; failed-request link retained |
| maintenance.failure_event | asset, start, restore, classification, failure code | Restore cannot precede start |
| maintenance.order_failure_link | order, failure event | Unique pair; several orders may share a failure |
| maintenance.incident | asset, rule revision, episode, status, request | One active episode per configured correlation key |
| maintenance.attachment | object key, tenant/site, owner record, hash, media type | Authorize parent record before download |
| maintenance.audit_event | actor, action, target, before/after versions, correlation | Append-only by application role |
| maintenance.outbox | event ID, aggregate version, schema, payload, delivery lease | Unique event ID; published after transaction commits |
| maintenance.idempotency | actor, operation, key, payload hash, result | Unique scoped key; differing payload rejected |
| integration.connector | tenant/site, provider, secret ref, status, cursor | Secrets never stored in event payload |
| integration.signal_route | canonical asset/signal, connector, unit, freshness, epoch | One active route per tenant/asset/signal |
| integration.event_receipt | source ID, epoch, observed/received, quality, value | Unique connector/source key; replay provenance |

Store procedure templates and inspection definitions as versioned documents with validated field schemas. Issued orders reference immutable revisions plus the display snapshot needed for offline execution. Never update an issued checklist by changing its original template.

## Indexes

Index site/state/due time for backlog; assignee/state for My Work; asset/created time for history; plan/occurrence key for generation; connector/source key for deduplication; outbox delivery state/next attempt for workers. Add tenant as the leading scope where useful. Validate indexes against measured query plans, not every possible filter.

## R2 parts extension

Part, store, reservation and stock_movement form a ledger. Each movement records signed quantity, unit, cost basis, reason, source order and idempotency key. Issue and return update inventory atomically. Reservations are separate from consumption. No deleted movement may hide an adjustment. Negative stock is blocked by default.

## Migrations and imports

Run schema migrations before compatible workers start. Use expand/migrate/contract for shared-service changes. Import previews resolve canonical IDs, validate units and produce error rows. Do not merge by name. Consolidation manifests contain old/new IDs, aliases, references, hashes, validation totals and rollback instructions.

For an existing MongoDB-backed Live installation, keep its current telemetry store until a reviewed migration warrants change. Expose or migrate registry identity deliberately; do not assume a wholesale database rewrite is required.

## Reconciliation checks

Every work-order asset exists or resolves through a tombstone. Every occurrence has at most one issued order. Every closed order has verifier and closure evidence. Every linked failure counts once. Every event can be traced to a route and incident decision. Missing references are surfaced in an administrator queue.
