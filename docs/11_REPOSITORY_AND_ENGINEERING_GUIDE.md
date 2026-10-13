# Repository and engineering guide

Inspect the repository before adopting this layout. Existing verified conventions should be reused if they preserve separate-product deployment. For a new project, the proposed default is TypeScript, Next.js frontend, a modular NestJS API, a separate worker, PostgreSQL, an S3-compatible object store and an OIDC-compatible local identity provider. This is a design proposal, not a mandate to rewrite Live.

Choose supported versions after checking current documentation and dependency compatibility during implementation. Pin dependencies and preserve lockfiles. Do not hard-code versions from memory.

## Suggested layout

| Path | Ownership |
| --- | --- |
| apps/maintenance-web | Product shell, technician and manager interfaces |
| apps/maintenance-api | Versioned HTTP API and business modules |
| apps/maintenance-worker | Scheduler, outbox, ingestion and retries |
| packages/contracts | Validated API/event schema and generated types |
| packages/registry | Registry service boundary and client |
| packages/policy | Permission and entitlement evaluation |
| packages/connectors | Provider interface and isolated Live/OpenRemote adapters |
| packages/neo | Optional retrieval and model/tool adapter |
| packages/ui | Shared accessible components |
| database/migrations | Owned schema migrations and fixtures |
| deploy/private | Installer, Compose profiles and runbooks |
| tests | Contract, integration, UI and acceptance fixtures |
| docs | This specification pack and implementation decisions |

## Coding boundaries

Controllers validate schemas and identity; domain services enforce business invariants; repositories persist scoped records. Workers invoke the same domain rules as HTTP actions. Use generated contract types where possible without treating types as runtime validation.

Do not fetch all tenants and filter in JavaScript. Do not let Neo read unrestricted database tables. Do not let a connector insert work orders directly. Do not reference Live frontend internals from the Maintenance backend. Shared registry access is through its boundary, even if packaged in one process.

## Transactions and time

State mutation, audit and outbox creation commit together. Store UTC and use explicit site timezones for recurrence. Use optimistic concurrency and permanent business uniqueness in addition to request idempotency. Keep clock dependencies injectable for recurrence tests.

## Configuration and demo data

Use sample configuration with placeholders and setup validation. Development seeds are opt-in and tenant-scoped. Simulations display provenance. Production builds disable demo credential paths and simulated provider activation by default. A blank new installation must be useful without preloaded data.

## Review and verification

Run repository checks appropriate to changed behavior. Validate policy and workflow invariants with negative cases, not tests mirroring implementation details. Record commands and outputs in phase completion notes. Avoid broad unrelated refactors. Leave existing customer data untouched until a reviewed migration and backup are available.

Do not deploy, publish or write to customer systems merely to demonstrate a local feature. Provider test connections use authorized read-only access. No PLC/control writes belong in this product.
