# API and event contracts

Proposed root: /api/v1/maintenance on the product service origin. Registry routes are a separate /api/v1/assets contract. Finalize paths with repository conventions. Upstream Live/OpenRemote endpoints are discovered against tested provider versions, not inferred from these routes.

## Request rules

Authenticate every call. Determine allowed tenants/sites from the validated identity; a body tenant_id is never authority. Scope service identities explicitly. List endpoints use cursor pagination and bounded page size, proposed default 50 and maximum 200. Define stable ordering with an ID tiebreaker.

Mutating POST uses Idempotency-Key. Scope to tenant, actor and operation, store a canonical payload hash and committed result. Same payload returns the same result; different payload returns conflict. Proposed pilot retention is 30 days, with permanent client-operation IDs on offline entries and unique business constraints after that window.

PATCH and transitions require If-Match or record_version. Reject stale state with 409/412. Generic PATCH cannot change workflow state, tenant, canonical asset identity or externally owned fields. UTC ISO 8601 timestamps are required in exchange payloads.

## Resource map

| Resource | Methods and actions | Boundary |
| --- | --- | --- |
| /asset-profiles | GET; GET/PUT /{assetId} | Maintenance fields only; registry authorizes identity |
| /requests | GET/POST; POST /{id}/triage | Accept, reject or mark duplicate |
| /work-orders | GET/POST; GET/PATCH /{id} | Draft creation and permitted edits |
| /work-orders/{id}/transitions | POST | Explicit requested action and version |
| /work-orders/{id}/labor | GET/POST | Technician execution scope |
| /work-orders/{id}/evidence | GET/POST | Evidence metadata and upload authorization |
| /plans | GET/POST; GET/PATCH /{id}; POST /{id}/publish or /pause | Revisioned schedules |
| /inspection-templates | GET/POST; POST /{id}/publish | Versioned template administration |
| /inspection-results | GET/POST | Typed check submission |
| /downtime-events | GET/POST; POST /{id}/amendments | Retain correction history |
| /reports/{metric} | GET | Source records and coverage; cost permission separately |
| /connectors | GET/POST; test, mappings, activate and pause actions | Scoped integration administration |
| /integrations/events | POST | Authenticated adapter ingestion only |
| /recommendations | GET; POST /{id}/decisions | Bound approval, no self-approval |
| /sync/changes and /sync/operations | GET and POST | Per-record policy and conflict results |
| /entitlements | GET | Effective grants, limits, term and safe status |

## Representative payloads

Create an order:

```json
{
  "site_id": "site-uuid",
  "asset_id": "asset-uuid",
  "title": "Inspect lifter hydraulic leak",
  "type": "corrective",
  "priority": "high",
  "team_id": "team-uuid",
  "source_request_id": "request-uuid"
}
```

Example UUID labels above are placeholders for actual validated UUIDs. Server allocates identity, display number, Draft state and version. Approval checks assignment/team queue, dates, procedure revision and applicable site instructions.

Transition payload:

```json
{"action":"submit_completion","record_version":7,"reason":"Inspection and repair completed"}
```

Validate mandatory execution evidence server-side. The result contains ID, state, version, applied transition and correlation ID. Closure is a separate supervisor action.

A normalized event contains schema_version, event_id, tenant_id, site_id, connector_instance_id, source_system, source_event_id, external_asset_id, external_attribute, asset_id, signal_id, observed_at, received_at, value, unit, quality, routing_epoch and historical. Value has a declared type; timestamps are not synthesized to hide missing source time. Preserve original values when conversion occurs.

## Errors and uploads

Return error.code, message, field_errors and correlation_id. Use 401 authentication, 403 denied action, 404 absent/concealed record, 409/412 conflict, 422 validation and 429 limit. A 5xx cannot imply successful saving; clients reconcile idempotency before retrying uncertain outcomes.

Uploads are two-stage: authorize against parent record and policy, then finalize validated bytes/hash/type/size. Proposed limits are 10 MiB per image and 50 MiB per document, configurable. Quarantine unsafe types and reject mismatched declared media types. Download links expire and require authorization before issuance. Do not expose secrets or permanent object URLs.

## Business events

Publish maintenance.request.created, work_order.created, work_order.state_changed, plan.occurrence_due, inspection.failed, downtime.updated and recommendation.decided with the maintenance prefix. Include event ID, aggregate ID/version, tenant/site, occurred_at, schema version and correlation ID. Event publication uses an outbox; consumers deduplicate. A delivery acknowledgment is not a workflow approval.

Produce machine-readable OpenAPI and event schemas during implementation. Validate examples and contract tests against those schemas before integration work proceeds.
