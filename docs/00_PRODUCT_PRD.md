# Visibility Maintenance Product Requirements

Product Requirements Document

Version 1.0 | 12 October 2026 | Status: Proposed standalone product baseline

Product owner: Visibility Bots | Audience: Product, engineering, design, deployment and pilot teams

## 1 Product decision

Launch **Visibility Maintenance** as a separately purchasable maintenance and asset-management product. Customers can use it without Visibility Live, OpenRemote, sensors or Neo. It has its own application, versioned APIs, permission namespace, deployment package and product entitlement.

Provide three operating setups: standalone manual maintenance, a connection through Visibility Live, and a direct connection to OpenRemote. These describe connectivity, not separate codebases. When sold with Live, users can open the product through the Live navigation label **Maintenance**, with shared sign-in and asset context.

Asset identity belongs to a shared platform registry service. Standalone installations include this service as a dependency; combined installations use one authoritative registry. Visibility Maintenance owns maintenance records and profiles, while Live and OpenRemote retain their own operational and telemetry responsibilities. This is a new product PRD and supersedes the earlier module-only design for future implementation; the earlier document remains a separate historical artifact.

Visibility Maintenance will connect equipment conditions with maintenance work. Users will report faults, plan preventive tasks, inspect assets, assign technicians, record repairs and assess equipment reliability. Visibility Neo is an optional AI capability for evidence-based troubleshooting and draft actions. On-premises operation is a first-class requirement, and ordinary maintenance remains usable when AI is absent or unavailable.

This PRD defines proposed product behavior. Existing implementation details, interfaces and delivery capacity have not been verified against the Live codebase. Suggested routes, entities and technical choices below are contracts to agree during discovery, rather than claims about current capabilities.

## 2 Problem and intended outcome

Factories need maintenance coordination even when they have no IoT platform. Visibility Maintenance must support manual fault reporting, schedules and inspections from day one. Where Live or OpenRemote supplies equipment conditions, the same product connects those conditions to accountable repair work, with an owner, evidence and a measurable outcome.

The same machine should retain one identity across telemetry, energy, production and maintenance. Its maintenance history should help users explain recurring faults and help Neo retrieve relevant instructions. Technicians need a short mobile workflow that works on the factory LAN and tolerates temporary loss of connectivity.

The initial customer is a factory seeking maintenance coordination, with equipment monitoring optional. CEW is a candidate pilot because its foundry and manufacturing workflow includes production equipment, lifters and material handling. Actual pilot assets, sensors and integration access must be confirmed at a site assessment.

### Goals

- Close the workflow from a verified condition or fault report to approved maintenance work and follow-up.
- Establish usable maintenance history against shared asset IDs in standalone and combined deployments.
- Sell and deploy maintenance independently without requiring the full Live platform.
- Improve assignment, preventive schedule compliance and repair evidence.
- Make downtime and reliability metrics traceable to operational records.
- Support private deployment and controlled Neo assistance.
- Integrate with an existing CMMS when the customer chooses to retain it.

### Scope boundaries

The first release is a practical computerized maintenance management system, or CMMS, sold as Visibility Maintenance. It covers maintainable assets and daily maintenance work. Full enterprise asset management, including depreciation, capital planning, leasing, advanced procurement and lifecycle replacement optimization, is outside the first release.

Direct PLC commands, autonomous equipment restarts, safety-system changes and unvalidated predictions of remaining useful life are excluded. Maintenance instructions must follow site procedures; a work-order status never confirms that equipment is safe to operate.

## 3 Release scope

| Release | Included capabilities | Boundary |
| --- | --- | --- |
| R1 Core pilot | Included registry and identity services, requests, work orders, calendar PM, inspections, QR access, downtime, basic reports, local deployment, mobile offline drafts and independent licensing | Runs with no Live, OpenRemote or Neo installation |
| R1 Connected pilot | Live connector, direct OpenRemote connector, operating-hour PM, selected IoT triggers, event deduplication and follow-up; optional Neo retrieval and drafts | One active telemetry route per mapped signal; each connector separately qualified |
| R2 Expansion | Basic parts stock and reservations, stock ledger, CMMS connector, multi-site reporting, optional voice entry and approved low-risk automation | Released after R1 acceptance |
| Later assessment | Advanced planning, procurement integration, condition models, lifecycle cost analysis | Separate requirements and validation |

R1 Core can be released independently after standalone acceptance. Connected capabilities require separate connector acceptance before they are advertised as supported. Neo has its own enablement and evaluation gate. Sensor or model readiness must not block the manual maintenance product. No calendar commitment is implied by these release labels.

## 4 Users and permissions

Identity, tenancy and site membership are shared platform services included in the standalone package. Maintenance adds action permissions and site or department scopes. Combined installations reuse the agreed identity provider and tenant mapping. Product entitlements and role permissions are checked separately; buying Live does not implicitly authorize maintenance actions. Server-side checks apply to every read, write, export, attachment, job and Neo tool call. Hidden navigation alone is insufficient authorization.

| Role | Default responsibility | Permitted actions |
| --- | --- | --- |
| Reporter | Operator reporting an equipment issue | Create requests, view own permitted requests, add evidence |
| Technician | Person carrying out maintenance | View assigned or authorized work, record tasks, labor, readings and repair evidence, submit completion |
| Supervisor | Maintenance lead | Triage requests, create and assign work, approve completion, reopen or cancel with reason, manage schedules within scope |
| Maintenance manager | Owner of maintenance performance | Supervisor actions, configure policies, inspect cost and reliability reports, manage team allocation |
| Asset administrator | Maintains asset master data | Use shared registry permissions to edit assets; maintain approved maintenance profiles |
| Stores user | R2 parts custodian | Receive, reserve, issue and return stock within authorized stores |
| Auditor or viewer | Reviews history and performance | Read and export permitted records; no workflow mutations |
| Neo service account | Executes explicitly granted tools | Retrieve scoped evidence and create drafts; additional actions only through approved policies |

Permission keys include maintenance.view, request.create, request.triage, work_order.create, work_order.assign, work_order.execute, work_order.complete, work_order.approve, work_order.cancel, plan.manage, inspection.execute, downtime.correct, report.view, cost.view, export, automation.manage and integration.manage. Keys are prefixed with maintenance. except where already shown. Shared asset edits require the registry's separate asset permissions.

Default completion approval requires a supervisor or manager other than the submitting technician. Delegated exceptions must be explicitly configured, recorded and visible to auditors. Criticality, cost thresholds and site boundaries may narrow permissions. Platform administration does not silently grant maintenance approval rights.

Neo uses the initiating user's permissions for interactive tools. Scheduled agents use a separately scoped service account. Approvals are bound to the exact payload, version, action, site and expiry; edits invalidate the approval. Execution rechecks permissions and current record state.

## 5 Navigation and interface

The standalone application header uses **Visibility Maintenance**. Its landing screen is the maintenance overview, and it offers the workspace areas below without displaying a required Live setup step. Suggested application routes are /overview, /work-orders, /assets and /settings/connections, subject to the product routing convention.

In combined use, the Live top-level navigation contains **Maintenance**. The link opens Visibility Maintenance through an authenticated deep link with the current site and asset context. A separately deployed frontend is the default R1 boundary; shared-shell embedding can follow after its session and release contracts are defined. Live can show a maintenance summary through the Maintenance API. Neither frontend reads the other product's database directly.

Unlicensed installations show an administrator-facing entitlement state according to Section 21. Unauthorized users cannot discover private records through routes, summaries, search or deep links. Telemetry-free customers see useful manual workflows, not empty sensor dashboards.

| Workspace area | Main content | Primary action |
| --- | --- | --- |
| Overview | Overdue work, critical open faults, PM due, downtime and team queue | Open prioritized work |
| Requests | Submitted issues and triage status | Report a fault |
| Work Orders | List, board and personal task view | Create or execute work |
| Preventive Maintenance | Plans, next occurrences and due calendar | Create a plan |
| Inspections | Templates, assignments, results and failed checks | Run an inspection |
| Assets | Maintenance view of shared registry assets | Open asset history |
| Downtime | Failure events and restoration records | Record or reconcile downtime |
| Reports | Backlog, PM compliance, reliability and costs | Filter or export |
| Settings | Permissions, codes, schedules, connector health, field ownership and licensing | Configure authorized settings |
| Parts | R2 stock, reservations, issues and returns | Record a stock movement |

A Visibility Maintenance asset screen shows its shared identity, maintenance profile, open work, PM plans, inspections, downtime, repair history and documents. Connected readings show their source and freshness. In Live, an asset Maintenance tab displays summaries and opens the corresponding record in Visibility Maintenance. Both use the same canonical ID in a combined installation. Overview cards link to their filtered source records.

On mobile, prioritize My Work, Report Issue and Scan QR. A technician can scan an asset, open assigned work, complete a checklist, add evidence and submit completion. Display offline status, pending uploads and conflicts clearly. Desktop screens support planning and review. Keyboard access, readable contrast and text labels for status are required.

## 6 Shared asset ownership

A shared platform asset registry owns canonical asset ID, tenant, site, hierarchy, name, location, lifecycle state and external references. It is a platform dependency, independently deployable from the Live application. Visibility Bots product engineering owns its API and schema contract; the customer's authorized asset administrators own the asset master data.

Standalone Maintenance includes one registry instance and its administration interface. Combined deployment uses one authoritative registry for both products. Existing Live registry behavior must be extracted or exposed behind this contract during discovery; it is not assumed to exist today. Maintenance creates or edits master fields through registry APIs under separate registry permissions.

A direct OpenRemote connection does not make every OpenRemote device a maintainable asset. A pump may have several sensors and attributes. The mapping model therefore links external asset IDs and attribute names to canonical equipment and signal IDs. Import supports explicit creation or linking, with preview and user approval; external deletes archive mappings rather than deleting maintenance history.

For separate installations connected over APIs, designate one canonical registry authority before activation. A second service may cache registry records but cannot allocate conflicting canonical IDs. If the customer later combines an existing standalone installation with Live, migrate through a reviewed reconciliation process that preserves IDs where possible, durable aliases where remapping is necessary, QR resolution and all historical references. Automatic merging by asset name is prohibited.

Maintenance owns an extension profile keyed by shared asset ID: maintainable flag, criticality, maintenance team, warranty reference, service interval defaults, failure taxonomy and maintenance document links. Existing registry fields must be reused where available. External identity mappings belong to the shared registry; connector configurations and signal routing belong to the integration boundary. Neither forms a duplicate equipment catalogue.

Requirements MA-01 through MA-08:

- MA-01: All asset-linked records contain a valid tenant-scoped shared asset ID; cross-tenant references are rejected.
- MA-02: A maintenance profile has at most one row per tenant and asset. Users can maintain equipment without installing a sensor.
- MA-03: Registry renames and location changes appear without manual reconciliation. Historical work retains a snapshot of the relevant name and location for audit.
- MA-04: Archived assets retain historical work. New work and schedule generation are blocked until an authorized user reactivates or explicitly permits the asset. Registry deletion must preserve references through archival or tombstones.
- MA-05: Asset moves cannot expose previous-site history to unauthorized users. Registry and Maintenance scopes are reconciled before a move becomes active; historical access follows an explicit policy.
- MA-06: A standalone installation creates assets and completes maintenance without any Live API call.
- MA-07: Combining installations requires an approved migration manifest, backup, mapping validation and rollback; maintenance history and authenticated QR links remain resolvable.
- MA-08: Registry outages block new asset creation and changes. Existing authorized work may continue using versioned cached identity snapshots; all queued registry-dependent operations reconcile on recovery.

QR codes contain an opaque shared asset reference or authenticated deep link. Scanning does not bypass authentication. Bulk import resolves existing registry IDs and reports ambiguous matches instead of creating duplicates.

## 7 Requests and work orders

### Fault reporting and triage

Requirements MR-01 through MR-04:

- MR-01: A reporter creates a request with site, description, observed time, proposed priority and optional asset, photo, reading or voice-derived text. Asset-free requests require a location and must be resolved to an asset or a justified non-asset category before work is approved.
- MR-02: Requests progress through Submitted, Under Review, Accepted, Rejected or Duplicate. Rejection and duplicate decisions require a reason; duplicates link to the surviving request or order.
- MR-03: Acceptance links to an existing work order or creates a Draft order atomically. One request cannot be accepted twice because of retries.
- MR-04: Users can follow request progress and receive configured notifications. Urgent requests display the site's incident contact instructions; reporting an issue does not replace emergency response procedures.

### Work records

Requirements MW-01 through MW-07:

- MW-01: Work orders support corrective, preventive, inspection and follow-up types, plus site-scoped sequential display numbers and immutable IDs.
- MW-02: Required fields are asset or justified non-asset category, title, type, priority, owning team and scope. Before approval, require assignment or team queue, planned dates, procedure revision and applicable safety instructions.
- MW-03: Execution captures checklist results, observed symptoms, failure and cause codes, corrective action, active labor entries, parts used, readings, attachments and downtime links. Unknown cause is allowed with a reason.
- MW-04: Technician labor and equipment downtime are separate records. Multiple technicians and multiple work orders can relate to one failure event without duplicating its downtime.
- MW-05: Submission validates mandatory checks, evidence and site-required acknowledgments. Failed mandatory checks block completion or require an authorized documented exception. Site permits remain authoritative outside this workflow unless explicitly integrated.
- MW-06: Supervisor review accepts completion or returns work to In Progress with a reason. Closure records verifier, verification time and outcome. Reopening preserves prior closure and adds a reason and new cycle.
- MW-07: Work orders support comments, immutable transition history, attachments and version checks. Completed evidence is corrected by amendment, not overwritten without trace.

### Work order lifecycle

| State | Allowed next states | Transition requirement |
| --- | --- | --- |
| Draft | Pending Approval, Cancelled | Validate planned scope; cancellation reason |
| Pending Approval | Ready, Draft, Cancelled | Approver grants, returns for edits or cancels |
| Ready | In Progress, Pending Approval, Cancelled | Assigned technician starts; material changes require reapproval |
| In Progress | On Hold, Pending Review | Hold reason or validated completion submission |
| On Hold | In Progress, Cancelled | Resume or supervisor cancellation with reason |
| Pending Review | Closed, In Progress | Authorized review of evidence |
| Closed | In Progress | Supervisor reopening with reason and preserved history |
| Cancelled | None | Create linked replacement if further work is needed |

Overdue is a derived flag, not a workflow state. Priority defaults are Critical, High, Normal and Low. Criticality and priority are separate: asset criticality describes business impact, while order priority describes the current work. Due-time and escalation policies are configurable per site and never imply automated equipment action.

## 8 Preventive maintenance and inspections

Requirements MP-01 through MP-06:

- MP-01: Plans contain asset, approved procedure revision, owning team, estimated duration, priority, trigger, lead time and effective dates. Published changes are versioned and do not rewrite an existing order's procedure snapshot.
- MP-02: Calendar plans use the site timezone. R1 supports daily, weekly and monthly intervals with explicit month-end and holiday behavior. Default monthly behavior clamps to the last valid day; site holidays do not shift due dates unless configured.
- MP-03: Default calendar recurrence is anchored to the plan schedule. One order is created for each occurrence when its generation lead time begins. At most one overdue occurrence per plan and asset stays open by default; additional missed occurrences are logged and visible rather than generating an uncontrolled backlog.
- MP-04: Operating-hour plans reference a validated cumulative meter and unit. Invalid, stale or reset meters suspend generation and raise a data-quality issue. Authorized reset or replacement records establish a new baseline without falsely counting negative usage.
- MP-05: Plan, asset and occurrence keys enforce unique generation under scheduler retries or concurrent workers. Pausing a plan stops future generation but does not cancel issued work.
- MP-06: Inspections support pass/fail, numeric limits and units, text, photo and required evidence. Failed checks create a reviewable request and link the result. Repeated submissions reuse the result ID and cannot create duplicate requests.

The connected pilot supports a single calendar or meter trigger per plan. Combined triggers and completion-relative schedules may be added later after their semantics are defined. Meter plans generate when the next threshold is reached; an approved completion meter sets the next threshold. During an open occurrence, repeated threshold crossings attach evidence and flag overdue usage rather than creating more orders.

## 9 IoT events and downtime

### Condition driven workflow

Telemetry arrives through the selected Live or OpenRemote connector and enters a common normalization adapter that validates asset mapping, unit, timestamp and data quality. In standalone mode, users can enter source-labeled readings; these must not appear as streamed telemetry. Selected rules evaluate normalized readings. Each rule defines a threshold or condition, duration, freshness limit, hysteresis, cooldown, severity and responsible team.

Requirements MI-01 through MI-06:

- MI-01: Reject or quarantine unmapped, incompatible-unit and invalid-quality events. Stale data cannot be treated as a current condition.
- MI-02: Persist source event ID, rule version, asset, observed time, received time, evaluated values and decision. Late or out-of-order readings follow a configurable evaluation window; historical replay defaults to analysis only.
- MI-03: Deduplicate transport retries by source ID. Correlate repeated abnormalities into an incident episode using asset, rule and episode state. Suppress new requests while an equivalent incident is open; append evidence instead.
- MI-04: R1 creates a request or Neo recommendation for review. Automatic creation of approved work is disabled by default and requires a later site policy for specific low-risk workflows.
- MI-05: Sensor recovery does not close a work order. Recovery becomes follow-up evidence. Closure requires the configured human verification.
- MI-06: If Neo is unavailable, deterministic event detection and request creation continue. Failed deliveries retry with backoff and enter a visible exception queue after the retry limit.

### Downtime records

Requirements MD-01 through MD-04:

- MD-01: A failure event records asset, start, restoration, planned/unplanned classification, symptom, production impact and source. Open events have no restoration time.
- MD-02: Machine stopped telemetry is a candidate event, not proof of failure. A supervisor classifies breaks, planned stops, communication loss and actual failure.
- MD-03: When several orders address one failure, all reference the same event. Asset downtime totals merge overlapping intervals; a failure count uses distinct validated failure events.
- MD-04: Manual corrections retain original values, actor and reason. Production reporting receives reconciled events without silently replacing its own authoritative classification.

Pilot example: a lifter with confirmed telemetry remains above its configured temperature threshold. A deterministic rule opens one incident and one request. Neo cites its approved manual and relevant repair records. The supervisor approves an inspection order. The technician records findings and repair evidence. The supervisor verifies restoration; Visibility Maintenance tracks subsequent connector readings during a configured follow-up window. If suitable telemetry is absent, the pilot uses operator reporting and inspections instead.

## 10 Neo assistance and action controls

When licensed and configured, Neo retrieves authorized manuals, SOPs, procedures, work history, validated incident evidence and selected telemetry summaries. Standalone customers can upload documents to the included maintenance document store; a separate Visibility Docs purchase is not required for attaching manuals or procedures. Neo may use its own approved retrieval adapter or a Docs connector. Numerical calculations and KPI values come from deterministic services. The model explains results and proposes work; it does not invent sensor values or calculate reliability from free-form text.

Requirements MN-01 through MN-07:

- MN-01: Troubleshooting responses cite document ID, revision and page or section, or the specific work record. Show data freshness, gaps and conflicting instructions.
- MN-02: Separate observed facts from possible causes and recommended checks. Use stated uncertainty rather than an unsupported numeric confidence score. If evidence is insufficient, request inspection or decline a specific diagnosis.
- MN-03: Neo may draft titles, checklists, summaries and requests. Users review generated text before publication in R1. Approved procedures remain versioned and cannot be silently replaced by model output.
- MN-04: Tools are explicitly allowlisted, validated against schemas and scoped to tenant and site. Use the same Maintenance APIs as human actions. Record retrievals, tool decisions, model and prompt versions, approval and execution outcome.
- MN-05: Uploaded documents are untrusted content. Instructions within them cannot change permissions, tool policy or system behavior. Retrieval authorization happens before context reaches the model.
- MN-06: All production-affecting recommendations follow site engineering and safety procedures. Neo cannot restart equipment, clear interlocks or write PLC setpoints through this product.
- MN-07: Customer policy selects local inference or permitted cloud inference. Private-only mode prohibits external telemetry, document and prompt transmission. AI failure leaves ordinary maintenance functions usable.

An agent run records trigger, identity, tools, evidence, draft, approval state, execution result and follow-up outcome. Work completion feedback may inform future retrieval; changes to prompts, models or execution policy require versioning and evaluation rather than uncontrolled learning from every technician comment.

## 11 Connectors and integrations

### Connection modes

| Setup | Required components | Authority and behavior |
| --- | --- | --- |
| Standalone | Maintenance application, included platform services and local or hosted storage | Maintenance work uses manual reports, inspections and entered readings; no IoT dependency |
| Connected through Live | Standalone components plus Live adapter and agreed registry and identity authority | Live supplies selected readings, alarms and operational context; Maintenance owns its work records |
| Direct OpenRemote connection | Standalone components plus OpenRemote adapter and external identity mappings | OpenRemote retains device and telemetry ownership; Maintenance maps selected signals to equipment |

Prefer the Live route when Live is already deployed. Activate a direct OpenRemote route when Live is absent or the customer chooses that route. Several connector instances may serve different sites, equipment or signals. One canonical asset and signal pair has only one active telemetry source by default. Dual ingestion requires an explicit reconciliation policy and is outside R1.

### Connector contract

Requirements MC-01 through MC-08:

- MC-01: Both connectors publish a common normalized envelope containing schema version, tenant and site, connector instance, source system, stable source event ID, external asset and attribute reference, canonical asset and signal ID, observed and received timestamps, value, unit, quality and routing epoch.
- MC-02: A connector uses a least-privilege service identity. Read-only telemetry access is the default. Store credentials in protected secrets storage, rotate them without losing mappings and never send them to Neo.
- MC-03: Discovery lists accessible source assets and attributes. A mapping preview validates identity, data type, unit conversion, timestamp and site access before activation. Unmapped signals enter a review queue.
- MC-04: Define delivery as at least once. Enforce event idempotency after normalization. If the provider lacks stable event IDs, the adapter creates a documented deterministic key from source identity, signal, original timestamp and value; unresolved collisions are quarantined rather than assumed unique.
- MC-05: Maintain cursors or watermarks where supported, bounded buffering, exponential retry and visible backlog. Reconnection backfill is marked historical; it must not generate a storm of current requests. The default pilot buffer target is 72 hours at the qualified event rate, with capacity alarms and a documented retention limit.
- MC-06: Surface connector health, last successful receipt, lag, stale signals, mapping errors, dropped or quarantined events and credential expiry. Connector loss does not block manual orders, calendar PM or inspections. Meter PM suspends when its source becomes stale.
- MC-07: Switch sources through an approved cutover: pause rules, record the last watermark, validate new mappings and units, increment routing epoch, reject old-route live events, then resume. Keep history and meter baselines; do not duplicate incidents or orders during overlap.
- MC-08: Core Maintenance accesses OpenRemote only through the adapter. Exact upstream authentication, subscription, polling and API mechanisms are selected against the deployed provider version during implementation. Do not hard-code an unverified upstream endpoint into the product contract. Publish a tested compatibility matrix.

A telemetry source being reachable does not establish fresh equipment data. Each signal has a configured freshness limit. Screens and Neo tools show stale or unavailable values explicitly. Condition rules run inside Maintenance or an agreed event service; upstream alarms are mapped to the same incident model so one condition cannot create both an alarm request and a reading request without correlation.

### Business integrations

In-app notifications are required in R1. Include a notification adapter in standalone deployment; existing approved platform connectors may be reused in combined installations. Email is optional configuration, and other messaging channels are later integrations. Sites configure recipients, quiet hours, acknowledgment and escalation. Delivery is distinct from acknowledgment. Deduplicate alerts and queue external notifications during outages.

In native record mode, Visibility Maintenance owns requests, orders, plans and execution records. An R2 external CMMS connector can delegate selected work-order fields and transitions to the customer's system. Connectivity to Live or OpenRemote does not itself change work-order ownership.

Choose authority per site and record type. Define a field ownership map, block conflicting native mutations and retain external IDs. Use idempotent synchronization, reconciliation, retries and an exception queue. Bidirectional synchronization requires passed conflict tests. ERP integrations may later supply parts, personnel or cost records. Shared workflow engines can execute steps, but Maintenance validates its lifecycle through its own APIs.

## 12 Data model and ownership

Use a distinct Maintenance application and API boundary with independently owned transactional records. A modular backend is acceptable, but packaging and release must allow Maintenance to run without the Live application. Shared dependencies have explicit APIs, version compatibility and owners. Neither product may mutate the other product database directly.

| Entity | Owner | Key fields or relationships |
| --- | --- | --- |
| Asset | Shared platform registry | Immutable asset ID, tenant, site, hierarchy, lifecycle and telemetry references |
| MaintenanceProfile | Maintenance | Unique tenant and asset, criticality, team, maintainable flag |
| Request | Maintenance | Origin, asset/location, reporter, priority, triage, linked order |
| WorkOrder | Maintenance or external CMMS by configured mode | Asset, type, state, assignment, due date, procedure version, record version |
| WorkOrderTask and LaborEntry | Maintenance | Checklist result, technician, actual time, evidence and amendments |
| MaintenancePlan and Occurrence | Maintenance | Trigger, revision, asset, generation key, issued order |
| InspectionTemplate and Result | Maintenance | Immutable revision, typed checks, units, failed result links |
| Incident and ConditionRule | Maintenance | Source events, rule version, episode, quality and request link |
| DowntimeEvent | Maintenance with production reconciliation | Failure identity, intervals, classification and related orders |
| Recommendation and AgentRun | Neo with Maintenance references | Evidence, draft action, model version, outcome |
| Approval and AuditEvent | Shared service or Maintenance contract | Actor, scope, record version, decision and timestamps |
| Part and StockMovement | R2 Maintenance or ERP authority | SKU, store, immutable ledger, reservations and work-order usage |
| ExternalAssetReference | Shared registry | Provider identity, canonical asset ID, durable aliases and approved field ownership |
| ConnectorInstance and SignalRoute | Integration boundary | Source, secret reference, signal mapping, freshness, watermark and routing epoch |
| OutboxEvent | Maintenance | Event ID, schema version, delivery state and correlation |
| ProductEntitlement | Licensing service | Tenant, installation, feature grants, limits, term, grace policy and signature |

Every Maintenance record contains tenant ID, site ID where applicable, immutable ID, created and updated timestamps, actor and version. Store timestamps in UTC and display in site timezone. Record currency and units explicitly. Attachments reside in authorized object storage; access is checked before temporary download links are issued. Asset links are foreign keys when feasible or validated references across service boundaries.

R2 stock movements form an auditable ledger. Issue, return and adjustment operations are atomic and idempotent. Negative stock is blocked by default; adjustments require stores permission and reason. Reservations do not count as consumption, and returns reverse cost allocation without deleting original issues.

## 13 API contracts

Suggested versioned Maintenance API root: /api/v1/maintenance on its own configured service origin. Shared assets use the proposed registry contract /api/v1/assets, whether deployed standalone or shared with Live. Final paths must align with platform conventions. Product APIs must not require the Live application server to exist. Asset creation allocates one canonical registry identity.

| Method and resource | Purpose | Required permission suffix |
| --- | --- | --- |
| GET /asset-profiles and /asset-profiles/{assetId} | Maintenance extension and filtered asset view | view |
| PUT /asset-profiles/{assetId} | Update maintenance-only profile | profile.manage |
| POST and GET /requests | Create or list fault requests | request.create or view |
| POST /requests/{id}/triage | Accept, reject or link duplicate | request.triage |
| POST and GET /work-orders | Draft or list orders | work_order.create or view |
| GET and PATCH /work-orders/{id} | Read or edit permitted fields | view or work_order.edit |
| POST /work-orders/{id}/transitions | Explicit validated state change | Permission for target action |
| POST /work-orders/{id}/labor and /evidence | Execution entries and evidence | work_order.execute |
| POST and GET /plans | Versioned PM planning | plan.manage or view |
| POST /plans/{id}/pause | Stop future generation | plan.manage |
| POST /inspection-results | Submit a typed inspection | inspection.execute |
| POST and GET /downtime-events | Record or list failure intervals | downtime.create or view |
| POST /downtime-events/{id}/amendments | Correct with history | downtime.correct |
| GET /reports/{metric} | Scoped KPI values and source references | report.view plus cost.view where needed |
| POST /recommendations/{id}/decisions | Approve or reject an exact proposed action | Action-specific approval permission |
| POST /integrations/events | Receive authenticated normalized events | Service identity with event.ingest |
| GET and POST /connectors | Inspect or create Live and OpenRemote connections | integration.manage |
| POST /connectors/{id}/test | Validate connectivity without enabling actions | integration.manage |
| PUT /connectors/{id}/mappings | Save reviewed signal mappings | integration.manage plus registry mapping permission |
| POST /connectors/{id}/activate | Activate a validated source route | integration.manage plus automation.manage |
| GET /entitlements | Read active product features and limits | Authorized user; no license secrets |
| GET /sync/changes and POST /sync/operations | Scoped mobile sync | Per-record read and action permissions |

Every suffix is namespaced maintenance. Additional keys profile.manage, work_order.edit, downtime.create and event.ingest complete the permission set in Section 4. GET operations are cursor-paginated with site, asset, status, assignee and date filters. API schema documentation defines required fields, units, enum values and permission requirements.

Mutating POST calls accept an Idempotency-Key scoped to tenant, actor and operation. Reuse with the same payload returns the original result; reuse with a different payload returns conflict. The work-order edit contract uses ETag/If-Match or an equivalent version token and returns 409 or 412 on stale edits. Generic PATCH cannot change workflow state or immutable ownership fields.

Errors return code, readable message, field details and correlation ID. Use 401 for authentication failure, 403 for unauthorized actions, 404 for absent or concealed records, 409/412 for state or version conflict, 422 for invalid input and 429 for rate limits. Do not reveal cross-tenant existence.

Persist business changes and outbound events atomically through a transactional outbox. Events include event ID, tenant, site, schema version, record version, occurrence time and correlation ID. Consumers deduplicate event IDs. Initial event types include request.created, work_order.created, work_order.state_changed, plan.occurrence_due, inspection.failed, downtime.updated and recommendation.decided, prefixed maintenance.

## 14 Deployment and offline behavior

Visibility Maintenance must have an independent installer and deployment manifest. The required package contains its frontend and API, shared identity and registry services, transactional database, object storage, scheduler, notification adapter, local licensing validation, audit and observability. Neither Live nor OpenRemote is a required container or external service. Neo, model serving and IoT adapters are optional components; the core package does not require a GPU.

Deployment location and IoT connectivity are separate choices. R1 supports a private on-premises installation. Managed-cloud hosting can be introduced after hosted tenancy, operations and recovery qualification; it uses the same product contracts. A private installation can be standalone or connected. Optional cloud support must not upload operational data without customer policy.

Combined deployment shares identity and registry where agreed but keeps Maintenance release and entitlement independent. Installers detect an existing approved registry and require an authority decision before attaching; they cannot silently create a competing master. Include registry and connector schema migrations, compatibility checks, signed release packages and rollback steps. An R1 Docker Compose package is the proposed starting point, subject to the existing stack.

The reference database can be PostgreSQL with a transactional outbox worker. Maintenance stores only selected telemetry summaries and evidence needed for work and reports. Live or OpenRemote remains the source for full telemetry history. Maintain enough evidence locally to audit work after disconnection; historical charts degrade visibly if the upstream system is unavailable.

Factory operation without internet and technician operation without any network are different requirements. On-premises users on the factory LAN can use the complete native workflow without internet. A disconnected mobile client can use only previously downloaded authorized work and queue permitted execution entries.

Requirements MO-01 through MO-05:

- MO-01: Mobile offline support covers assigned work, procedure snapshots, checklists, notes, photos, labor and draft requests. Initial authentication, approvals, policy edits and cross-team reassignment require server connectivity.
- MO-02: Each queued operation has a stable client ID, source record version and local timestamp. The server deduplicates retries and records received time separately.
- MO-03: Notes and new evidence can merge as append-only entries. Status changes and edited fields require version reconciliation. Conflicts display both versions and require an authorized decision; no silent last-write-wins for workflow state.
- MO-04: Sync rechecks authorization, asset state and current work state. Offline completion is provisional until accepted by the server. If permission was revoked, preserve the local draft for controlled recovery without applying it.
- MO-05: Cached data has a configured expiry, minimum necessary scope and encrypted storage on the supported managed client. Browser PWA use requires a reviewed cache protection approach. Shared devices clear cached work on logout; offline client platform selection is a discovery decision.

Local backup covers records, attachments, configuration, procedure revisions and pending outbox state. Model binaries can be restored separately from versioned manifests. Installation includes health checks, migrations, rollback steps and a documented restore procedure.

## 15 Reports and metric definitions

Reports expose period, site timezone, asset scope, source records, exclusions, missing-data coverage and last refresh. Exported data respects the same permissions. Maintenance costs cannot be read merely because a user can view work orders.

| Metric | Definition | Required handling |
| --- | --- | --- |
| PM on-time compliance | Eligible PM occurrences completed and approved by original due time divided by eligible occurrences due in the period | Exclude only cancellations with approved exemption; show exemption count and original due dates |
| Overdue backlog | Open non-cancelled orders with due time before now | Age from due time; filter by priority, team and asset |
| Failure count | Distinct validated unplanned failure events starting in the period | Multiple linked orders do not increase count |
| MTTR | Sum of failure-to-restoration elapsed hours divided by restored qualifying failures | Includes waiting; show active repair labor separately and open failures separately |
| MTBF | Verified operating hours in the period divided by qualifying failure count | Same asset and period basis; mark approximate if operating exposure is estimated |
| Equipment downtime | Duration of the union of validated downtime intervals intersecting the period | Separate planned and unplanned; clip at period boundary |
| Maintenance cost | Approved labor cost plus consumed parts net of returns plus entered external service cost | Currency, rates and valuation basis required; show incomplete cost coverage |
| Repeat faults | Validated failures sharing asset and failure code within a configurable window | Default proposed window is 30 days; unknown codes excluded and reported |

With zero failures, MTBF displays no observed failure and operating exposure, not an invented infinite value. Missing operating hours produce unavailable MTBF. Restored-failure MTTR uses events restored in the period and labels that cohort; open failures must remain visible. Historical due-date edits and cancellations are audited to prevent misleading compliance results.

OEE remains a production metric. Maintenance contributes validated downtime and repair context but does not infer availability, performance or quality from work orders alone.

## 16 Nonfunctional requirements

The following are proposed pilot acceptance targets, subject to benchmarking on the agreed hardware. They are requirements to validate, not measured platform performance.

| Area | Proposed target | Validation basis |
| --- | --- | --- |
| Interactive performance | p95 under 2 seconds for common read APIs; under 3 seconds for ordinary writes | Local LAN, agreed server, 50 concurrent users, 1000 assets and 100000 orders; excludes AI and uploads |
| Event responsiveness | p95 under 30 seconds from receipt of a valid qualifying event to persisted request | Excludes configured dwell time; 10 normalized events per second sustained pilot load |
| Scheduling | Due generation within 5 minutes of configured generation time | Scheduler restart and concurrent-worker tests |
| Continuity | Native workflow functions during a 72-hour internet outage | Local identity, attachments, scheduler and notifications tested; external channels queued |
| Availability | Proposed 99.5 percent monthly availability during scheduled operation | Measure local dependency health; report planned maintenance separately |
| Recovery | Proposed RPO 24 hours and RTO 4 hours for pilot | Actual backup restore on agreed hardware; customer can require stricter targets |
| Audit | Every sensitive mutation and transition has actor, scope, reason when required, before/after version and time | Automated completeness checks and manual audit review |
| Security | TLS, protected stored data, scoped secrets, least privilege and append-only audit access | Cross-tenant, attachment, export, service account and offline sync tests |
| Accessibility | Core paths meet WCAG 2.2 AA target | Keyboard, contrast, focus and screen-reader review |

AI latency is reported separately. Target an initial progress indicator within 2 seconds and configurable timeouts with usable fallback. Local model throughput and answer quality must be benchmarked on customer hardware before defining a response-time commitment.

## 17 Acceptance scenarios

Each scenario is a release gate with test evidence retained. Passing demonstrations alone do not substitute for record-level checks.

| ID | Scenario | Pass condition |
| --- | --- | --- |
| AC-01 | Asset consistency | Standalone registry updates appear in Maintenance; combined Live and Maintenance resolve one identity and retain historical snapshots |
| AC-02 | Tenant and site isolation | Unauthorized direct IDs, exports, attachments, Neo retrieval and background tools disclose no private data |
| AC-03 | Fault to closure | Request links to order; technician submits evidence; independent supervisor closes; every transition is audited |
| AC-04 | Completion validation | Missing mandatory evidence blocks submission; failed checks require resolution or logged authorized exception |
| AC-05 | Duplicate generation | Replaying the same event 100 times and retrying PM workers yields one incident request or one occurrence order |
| AC-06 | Event quality | Stale, invalid-unit, unmapped and out-of-window events cannot create current maintenance actions |
| AC-07 | Recurrence edge cases | Month-end, timezone, downtime restart, plan pause and meter reset produce the documented occurrences |
| AC-08 | Offline reconciliation | Technician entries survive disconnect; repeated sync adds no duplicates; stale closure triggers a visible conflict |
| AC-09 | Neo grounding | Answers link to accessible evidence, distinguish hypotheses and abstain when required evidence is absent |
| AC-10 | Approval integrity | Changed payload, expired approval or revoked permission blocks action; approval and execution are traceable |
| AC-11 | KPI reconciliation | Known sample failures, overlapping downtime, zero failures and missing hours produce the Section 15 results |
| AC-12 | Local continuity and restore | Internet outage leaves native workflows available; backup restores records, attachments and pending events |
| AC-13 | Existing CMMS authority | R2 connector cannot overwrite externally owned fields; retry and conflict cases reconcile or enter exception queue |
| AC-14 | Archived and moved assets | New generation is blocked for archived equipment; site moves respect historical access policy |
| AC-15 | Independent product | With Live, OpenRemote and Neo absent, install, license, create assets, execute work, generate calendar PM, inspect, report and export |
| AC-16 | Live connector | Mapped Live events create one validated request; source freshness, scope and context deep links behave correctly |
| AC-17 | OpenRemote connector | Selected equipment and sensor mappings work without Live; source units, permissions and upstream asset changes reconcile |
| AC-18 | Outage and source cutover | Buffer and replay 72 hours of pilot-rate events without duplicate current actions; route switch preserves identity and rejects old-route live events |
| AC-19 | Registry consolidation | Reviewed migration preserves history, aliases and QR resolution; rollback restores pre-migration behavior |
| AC-20 | Entitlement isolation | Maintenance works without a Live license; optional feature grants and local grace behavior match Section 21 |
| AC-21 | Independent release | Upgrade or disable a connector without stopping core work; shared-service version mismatch is detected before unsafe migration |

For Neo acceptance, use at least 40 reviewed pilot cases across troubleshooting, missing evidence, conflicting manuals, unsafe requests, permission boundaries and injected document instructions. Require zero unauthorized tool executions and zero uncited safety-critical recommendations. Require at least 90 percent of otherwise answerable cases to meet the agreed relevance and grounding rubric. A maintenance engineer reviews any safety-related content; failing cases block affected features, not ordinary CMMS operation.

## 18 Pilot and rollout

### Stage A Discovery and contracts

Inventory existing platform services and determine the smallest standalone dependency package. Define registry extraction or reuse, independent identity, optional Neo and each provider connector contract. Select one site, 10 to 20 maintainable assets and 5 to 10 users as a proposed pilot size. Confirm actual machinery, connectivity, documents and procedures. Agree field ownership, device mappings, client platform, hardware and acceptance data before implementation.

### Stage B Core maintenance

Deliver the standalone installer and licensing, registry extensions, mobile and desktop work, requests, calendar PM, inspections, downtime, audit and basic reports. Import approved procedures and baseline asset records. Demonstrate manual fault-to-closure and offline reconciliation with technicians. Gate: AC-01 through AC-04, relevant AC-07, AC-08, AC-11, AC-12, AC-14, AC-15, AC-20 and AC-21. Demonstrate with Live, OpenRemote and Neo absent.

### Stage C Connected intelligence

Qualify the Live adapter and direct OpenRemote adapter separately, then enable selected rules, meter PM and outcome follow-up. Gate: remaining connected R1 scenarios, performance benchmarks and restore exercise. Test outages and source cutover. Enable optional Neo only after its evaluation gate. Begin with requests requiring review.

### Stage D Pilot measurement

Observe usage for a proposed four-week period after training. Capture a comparable baseline beforehand. Targets are hypotheses: at least 90 percent of pilot maintenance jobs recorded, at least 90 percent of submitted completion records meeting evidence requirements, and median acknowledgment time at least 20 percent below baseline where sample size permits. Report counts and changes in work mix. Downtime reduction is an outcome to measure, not an acceptance promise.

### Stage E Expansion

Release R2 only after pilot review. Add stores and CMMS integration where customer demand is confirmed. Multi-site rollout requires site-specific permissions, procedure revisions, data-quality checks and administrator training. Enable automation one workflow at a time with explicit policy and rollback capability.

## 19 Dependencies and risks

| Dependency or risk | Effect | Required response |
| --- | --- | --- |
| Inconsistent asset identity | Duplicate histories and incorrect telemetry links | Resolve shared IDs before import; block ambiguous mapping |
| Poor sensor quality | False work requests and missed conditions | Validate units, freshness and incident rules; retain manual paths |
| Weak technician adoption | Incomplete repair history | Test QR and mobile flows with technicians; minimize mandatory entry |
| Unsafe or unsupported AI advice | Incorrect maintenance decisions | Ground answers, restrict tools, evaluate and require site procedures |
| Unclear CMMS authority | Conflicting work status and duplicated effort | Choose mode and field owners before synchronization |
| Local hardware limits | Slow Neo or event processing | Benchmark independently; preserve deterministic workflow when AI is unavailable |
| Missing operating exposure | Misleading MTBF | Show missing coverage and unavailable values |
| Limited delivery capacity | Scope growth delays pilot | Keep core and connector gates separate; move advanced EAM requests to later assessment |
| Standalone services still depend on Live | Product cannot be sold independently | Verify an installation with no Live process, license or network endpoint |
| Competing registry authorities | Lost identity links and duplicated equipment | Require reconciliation and approved authority before connection |
| License or source outage | Disruption of active maintenance | Validate local entitlements and continuity policy; keep manual workflow available |

## 20 Decisions required during discovery

The separate product name, independent purchase and deployment, connector options and shared registry boundary are settled by this PRD. The following implementation decisions remain open and do not change that boundary:

- Which shared registry, identity, approval and document services can be packaged independently, and which must be extracted from Live?
- Which existing installations need registry consolidation and durable asset aliases?
- Which deployed Live and OpenRemote versions can the initial connectors qualify?
- Which customer assets and telemetry are suitable for the connected pilot?
- Which CMMS or ERP, if any, remains authoritative at that site?
- Which mobile client meets local security and offline requirements?
- Which procedures, failure codes, criticality classes and approval thresholds does the site approve?
- Which local hardware, optional model runtime, backup retention and recovery targets does the customer require?
- Which proposed commercial units, grace policy and deployment terms should be approved for launch?
- Who owns implementation, site deployment, technician training and maintenance engineering review?

The discovery deliverable is a signed-off field ownership map, API contract, screen flow, deployment configuration, pilot dataset and release backlog mapped to the requirement and acceptance IDs above. This PRD supplies the product baseline for those implementation artifacts.

## 21 Product licensing and packaging

Visibility Maintenance is purchasable independently. Its core entitlement includes the registry and identity dependencies required for maintenance, asset and procedure records, requests, orders, calendar PM, inspections, downtime, basic reporting and supported mobile workflows. It must not require a Live or Visibility Docs subscription for these functions.

The proposed commercial structure below defines entitlement boundaries, not approved prices. Fees, caps, support terms and contracts remain commercial decisions.

| Package or option | Entitlement | Commercial boundary |
| --- | --- | --- |
| Visibility Maintenance Core | Standalone CMMS and included platform dependencies | Proposed annual site subscription with named operational user allowance |
| Connected Operations option | Qualified Live and direct OpenRemote adapters, selected condition rules and meter PM | Optional connector entitlement; third-party software and sensors remain separately supplied |
| Neo Assistance option | Licensed Neo retrieval, troubleshooting and drafts | Optional AI entitlement; local compute or permitted cloud usage stated separately |
| Private deployment option | On-premises installer, offline license and agreed update/support service | Proposed implementation fee plus annual software/support term |
| Combined Live and Maintenance offer | Separate product grants with shared identity and registry | Bundle discount may apply; neither product loses its own entitlement identity |

Initial commercial metering should remain simple. Propose named technicians, supervisors and managers as operational users, with request-only and read-only roles separately defined. Count a maintainable equipment asset once, not every telemetry sensor or imported attribute. Any site, user or asset limit must be explicit in the entitlement. Event volume, connector capacity and AI consumption are operational limits disclosed separately; no unapproved overage invoice or hidden dependency may be introduced.

Requirements ML-01 through ML-06:

- ML-01: Enforce feature grants in APIs, background jobs and interface routes. Entitlement never overrides role permissions. A missing optional grant disables that optional capability without disabling core maintenance.
- ML-02: Private installations validate a signed license locally. It contains product, tenant, installation ID, feature grants, term, limits and grace policy. No routine internet heartbeat is required during a valid licensed term. License import, renewal and installation rehosting follow an audited administrator workflow.
- ML-03: Display expiry and capacity warnings to administrators. Proposed expiry behavior is a 30-day continuity grace period with visible notice, followed by read/export access and permitted completion of already approved active work. Block new orders, plan generation and connector-triggered requests after grace; do not delete data or terminate an active repair. This proposed commercial policy requires approval before launch.
- ML-04: Network loss during a valid offline term does not change entitlement. A revoked or invalid signature blocks activation of new optional features; existing work follows the documented continuity and incident process. Clock anomalies raise administrator review rather than silently deleting records.
- ML-05: Exceeding a paid limit produces an explicit administrative warning and blocks new allocations according to the approved policy. It must not discard telemetry evidence, technician entries or existing assets. Proposed counting rules and any upgrade path are visible before activation.
- ML-06: Connector or Neo cancellation retains requests, evidence, approvals and work history. Live cancellation does not disable Core. Exports remain available to authorized administrators at term end; retention and deletion require an explicit customer instruction and approved policy.

On-premises software updates and support need not be available forever after expiry, but installed data remains accessible under the continuity policy. Backups retain the installed entitlement and installation identity; restore or rehosting must not create a second valid production license accidentally.

## 22 Launch readiness

Launch the standalone core once independent installation, registry ownership, licensing, manual workflows, offline sync and recovery pass their gates. Publish a product guide that distinguishes included features from optional connectors and AI.

Advertise each connection only after its compatibility matrix and acceptance results are complete. The launch handoff includes the installer, dependency inventory, API schemas, field ownership map, permissions matrix, migration and rollback guide, connector setup guide, license administration guide, technician training material and pilot evaluation report.

The product message is: Visibility Maintenance manages equipment maintenance, assets and frontline work on its own, and can connect to Visibility Live or OpenRemote for condition-based maintenance. Neo assistance is an optional capability. Predictive claims require separately validated data and models.
