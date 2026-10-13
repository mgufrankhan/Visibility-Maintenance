# Deployment and operations guide

## Private standalone package

Provide an installer/manifest for Maintenance frontend, API, worker, included registry and identity, transaction store, object store, notification adapter, licensing and observability. Use Docker Compose as the proposed initial package. Optional profiles enable connectors and Neo. Do not install Live/OpenRemote automatically or require a GPU for Core.

Container images and migrations are versioned. Production uses signed release packages and reviewed dependency versions. Persist database, files, identity configuration and licensing state outside ephemeral containers. Validate existing registry authority before attaching another product.

## Setup sequence

Validate host capacity, DNS, TLS and volumes. Configure tenant, site/timezone and administrator identity. Apply compatible schemas. Import signed local entitlement. Create initial asset identities and procedures. Verify backup destination and run restore test. Enable connectors only after mapping preview and provider qualification. Enable Neo only after private/cloud policy and evaluation.

No universal hardware capacity is claimed. Benchmark the PRD's proposed 50 users, 1000 assets, 100000 orders and 10 events/second on the agreed server. Model serving capacity is a separate sizing exercise.

## Configuration

Define registry and identity endpoints, database and object-store locations, site timezone, license input, notification settings, event freshness and queue limits. Secrets are protected references, never sample real credentials. Feature profiles control connector and model startup. Private-only mode denies cloud inference egress by policy, not simply a UI checkbox.

If locally authenticated operation is required during internet loss, avoid a cloud-only identity dependency. An external directory must have a documented local continuity approach. Supported mobile offline behavior requires separate client security validation.

## Monitoring

Measure API p95, transition failures, scheduler lag, outbox age, retries, failed jobs, storage usage, backup age, license status, registry errors and connector source-data age. Separate core readiness from optional health. Notify administrators of mapping failures, stale meters, capacity warnings and failed PM occurrences.

Use structured logs with correlation IDs and redacted secrets. Audit business changes separately from ordinary diagnostic logs. Proposed service targets in the PRD require measured evidence before commercial commitments.

## Backup and recovery

Back up transactional state, registry, identity configuration, attachment bytes, procedures, settings and pending outbox/checkpoints. Preserve installation/license identity. Recovery must not fork canonical registry identity or issue duplicate PM occurrences.

Proposed pilot RPO is 24 hours and RTO 4 hours. Run an actual restore with fixture counts and attachment hashes. Model binaries may be restored from versioned manifests separately. Document a customer-approved retention period rather than silently selecting indefinite retention.

## Upgrade and rollback

Check API/worker/registry/client compatibility before deployment. Back up, drain or fence workers, apply compatible migration, run health and business smoke checks, then resume. Database rollback is a planned operation with validated backup; reverting containers alone does not undo data migrations. Keep queued offline operations compatible or reject them visibly with recovery instructions.

Managed cloud hosting is a later qualification path. It requires its own tenancy isolation, backup, update and service-operation tests. Connectivity modes remain available in both deployment locations.
