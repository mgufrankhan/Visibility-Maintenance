# Interface and user flows

## Product shell

Use Visibility Maintenance in the standalone header. Provide Overview, Requests, Work Orders, Preventive Maintenance, Inspections, Assets, Downtime, Reports and Settings. Parts appears when R2 is enabled. In Live, the link label is Maintenance and opens authenticated context in this product. The core never prompts users to purchase Live to continue.

Reuse the customer's existing design system if present. For a new UI, use a restrained blue/azure palette, readable light surfaces, clear typography and practical tables. Color must not be the only status signal. Mockups are implementation aids, not production behavior.

| Screen | Required behavior | Empty/error state |
| --- | --- | --- |
| Overview | Prioritized critical issues, overdue work, PM due, team queue; cards open source filters | Manual-first guidance when no IoT exists |
| Requests | Submit issue, attachment and location; triage drawer | Duplicate link, rejection reason, save failure |
| Work orders | Search/list/board; state, due, owner, asset and origin | No matches, permission denied, version conflict |
| Order detail | Scope, procedure revision, evidence, labor, failure links, timeline and valid actions | Explain blocked completion with missing fields |
| PM planning | Trigger editor, schedule preview, procedure revision, pause/publish | Invalid meter, stale signal, missing approval |
| Inspections | Typed checks, units, evidence and failed-result follow-up | Draft/pending sync/conflict state |
| Asset detail | Canonical identity, profile, history and source-labeled readings | Stale/unmapped/unavailable signal |
| Connector setup | Discovery, mapping preview, test, activation and health | Credential failure and reconciliation queue |
| Reports | Scope, period, coverage and source drilldown | Unavailable MTBF if hours missing |
| Settings | Teams, policies, failure codes, grants, licenses | Admin-only access and change audit |

## Technician path

Open My Work or scan authenticated QR. Show asset, assigned task, priority, due time and issued procedure. Start work, complete typed checks, enter observations, add photos and labor, then submit completion. Display Pending Review until an authorized supervisor verifies. Equipment safety status is not inferred from order closure.

Provide obvious saved/pending/error indicators. Offline work uses previously cached authorized orders. Do not offer approvals or cross-team assignment offline. Submitted local completion remains provisional. When server state differs, show the conflicting state and recovery options rather than silently discarding entries.

## Supervisor path

Review a request, link a duplicate or accept it into a draft order. Set scope, owner/team, dates and approved procedure. Approve, monitor and review completion evidence. Accept closure or return for more work with a reason. Reopen only through an explicit action preserving previous closure.

## Connector onboarding

Choose Live or OpenRemote, specify instance and credentials, test read access, discover references, then map equipment and signals. Show unit conversions, freshness and route ownership. Preview normalized values without creating requests. Activate rules separately. Source switch requires an explicit cutover flow; a reachable provider alone must not show all signals as healthy.

## Neo experience

Show citations, timestamps, observations, possible causes and suggested checks. Draft actions open a review form. Approval names the exact action and current version. Show unavailable AI as a bounded feature failure; leave work forms usable.

## Accessibility and usability gates

Keyboard-operable forms and dialogs, visible focus, labeled fields, screen-reader status announcements, legible mobile controls and WCAG 2.2 AA target. Require confirmation only for consequential actions such as cancellation or source activation. Test with real technicians using gloves or shop-floor constraints where applicable; optimize required entry rather than hiding missing evidence.
