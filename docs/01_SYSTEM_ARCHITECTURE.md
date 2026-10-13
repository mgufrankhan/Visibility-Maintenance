# System architecture

## Boundary

Visibility Maintenance is independently installable. Shared platform dependencies have explicit ownership and contracts; being shared does not mean requiring Live's application process. Start with a modular backend and separate worker, not a service for every entity.

| Component | Owns | Required for core |
| --- | --- | --- |
| Maintenance web application | Desktop/mobile workflows and product navigation | Yes |
| Maintenance API | Requests, orders, plans, inspections, downtime and reports | Yes |
| Shared registry | Canonical assets, sites, hierarchy and external aliases | Yes |
| Identity provider | Authentication and tenant membership | Yes |
| Policy and licensing boundary | Scoped permissions and local feature grants | Yes |
| Worker | PM generation, notifications, outbox and reconciliation | Yes |
| Transaction database | Transactional state and audit references | Yes |
| Object store | Procedures, repair evidence and attachments | Yes |
| Connector adapters | Provider discovery and normalized signal events | Optional |
| Neo adapter/model runtime | Grounded assistance and approved draft tools | Optional |

The registry may share the database server in standalone deployment but retains a distinct schema and API. Repository modules cannot mutate its tables through Maintenance repositories. If it runs in another process, validate references and maintain recovery-safe identity snapshots. Define ownership before connecting an existing Live installation.

## Core flows

A request is triaged into a draft work order. Approval releases work. A technician records execution and submits completion. A supervisor closes the order after verification. Persist each transition, evidence reference and outgoing event in one business transaction.

PM workers claim due occurrences, apply plan revision and asset eligibility checks, and create one order per generation key. Workers recover leases after failure without repeating committed work.

Connectors normalize authorized readings, append signal evidence and evaluate deterministic rules. Incident correlation links repeated conditions to one active episode. Neo can retrieve the evidence and prepare a recommendation, but detection and requests do not depend on Neo availability.

## Data placement

Use transactional storage for maintenance records; authorized object storage for files; provider-owned telemetry history for full historical signals. Retain selected evidence locally for audit. Do not replicate all OpenRemote telemetry into the CMMS without a separately justified retention requirement.

## Failure behavior

| Failure | Expected behavior |
| --- | --- |
| Internet absent | Local core, licensing and identity continue; external channels queue |
| Provider absent | Show stale values, suspend affected meter PM, preserve manual work |
| Neo absent | Retrieval assistance unavailable; core and deterministic rules continue |
| Worker restart | Resume occurrences and outbox through leases and idempotency |
| Registry unavailable | Existing work uses scoped identity snapshots; asset edits queue or fail visibly |
| Database unavailable | Do not claim saved work; mobile retains permitted local drafts |

Expose product health separately from connector and AI health. An unhealthy optional adapter must not fail the core readiness check. Maintain version compatibility between the API, registry, worker, client and connector schema.

## Architectural acceptance

Install core with optional containers absent. Observe zero requests to Live/OpenRemote/Neo endpoints while creating assets and completing work. Exercise a worker crash after commit and prove one generated order. Trace one action from request ID to audit and outbox delivery. Verify provider shutdown leaves core readiness healthy.
