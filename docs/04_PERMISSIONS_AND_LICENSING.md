# Permissions and licensing

Permission decisions combine authenticated identity, tenant membership, site/department scope, record relation, action, current state and optional entitlement. Evaluate on the server for API calls, workers, exports, attachments and agents. Product licensing does not grant permissions.

## Role grants

| Role | Default grants | Restrictions |
| --- | --- | --- |
| Reporter | Create requests, read own scoped requests, add evidence | No assignment, approval or costs |
| Technician | Read assigned/permitted orders; execute and submit completion | Cannot approve own completion |
| Supervisor | Triage, draft, assign, approve, close, reopen and manage scoped plans | Independent approval by default |
| Maintenance manager | Supervisor actions, reports, policy configuration | Cost views require explicit grant |
| Asset administrator | Registry edit and Maintenance profile management | Registry role does not imply work approval |
| Viewer/auditor | Scoped read and allowed export | No mutations |
| Stores user | R2 stores ledger operations | Scoped inventory and no approval override |
| Connector service | event.ingest and configured discovery access | No work closure or asset-master edits |
| Neo service | Scoped retrieval and draft tools | No self-approval or machine control |

Use maintenance.* action keys defined in PRD and API specification. Add registry.assets.* and registry.mappings.* in the registry namespace. Administration uses distinct integration, automation and license grants. Run scope tests on relationship joins so an allowed order cannot expose a forbidden attachment or asset.

## Work authorization

State transitions have their own policy. Draft creation, assignment, execution, completion submission and closure are separate actions. Approvals bind actor, exact payload hash, record version, target action, tenant/site and expiry. Material edits or expired approvals require new approval. Recheck at execution to handle revoked access.

Interactive Neo inherits user scope; scheduled runs use a configured service identity with narrow scope. Do not perform action replay under the administrator who configured an agent.

## Entitlements

Core includes required registry/identity dependencies and ordinary maintenance workflows. Connected Operations and Neo Assistance are optional proposed grants. Private licensing is validated locally from a signed document. Live and Maintenance retain separate grants even in a bundle.

License data contains product, installation, tenant, feature grants, limits, term, grace policy and signature. Keep signing private keys outside deployments. Clients display status from the server; client flags cannot enable features. Offline verification does not depend on a routine cloud heartbeat.

Commercial fees and final limits are undecided. Implement a configurable entitlement policy, with the PRD's proposed 30-day continuity grace as a proposed default. After grace, retain authorized read/export and permitted completion of already approved active work; block new orders, plan generation and connector-created requests. Do not delete data. Exact launch policy remains a commercial decision and must be tagged accordingly in configuration.

Capacity counting treats maintainable equipment once, not every signal or sensor. Disabling Neo or a connector retains historical evidence. Live expiry cannot turn off Maintenance Core. Entitlement state must be tested with workers and background actions, not only UI menus.

## Audit

Log sensitive changes, permission decisions for executions, approval decisions, export requests and entitlement changes. Record actor/service identity, target, site, action, reason, version, timestamp and correlation. Application credentials cannot overwrite audit records. Retention is customer-configured; stronger tamper-evidence can be added for customer requirements without claiming the base database is immutable against its own administrators.
