# Live and OpenRemote connector specification

These are provider adapter requirements. They do not assert which upstream endpoints or protocols exist in a deployed version. Implement provider discovery after checking actual official documentation and customer access.

## Adapter interface

Define test_connection, discover_assets, discover_signals, preview_mapping, start_ingestion, pause_ingestion, resume_from_checkpoint and health. Publish normalized events to the internal ingestion contract. An adapter never writes work-order state or PLC values.

| Provider | Supplies | Preserves ownership |
| --- | --- | --- |
| Visibility Live | Canonical context where shared, selected readings, alarms and production context | Live retains monitoring and full operational telemetry |
| OpenRemote | External assets, attributes, readings and supported events | OpenRemote retains device configuration and telemetry |

Standalone uses neither. Manual readings contain manual provenance and do not masquerade as live provider events. A machine may have many sensor references; mapping equipment is not equivalent to importing every source asset as a separate machine.

## Mapping lifecycle

Draft mapping specifies tenant/site, provider instance, external asset/attribute, canonical equipment/signal, value type, source/target units, conversion and freshness. Preview validates actual samples and authorization. Approval publishes a mapping revision. Activate a route only when it has no competing active route for the same canonical signal.

Store external identity mapping in the registry and connection/route configuration in the integration boundary. Shared registry authority must be settled before activation. Rename updates identity displays; external deletion disables mapping and flags review without deleting history.

## Event processing

Require schema, source identity, event ID, source timestamp, value/unit, quality, observed/received times and routing epoch. Validate freshness and source time. Deduplicate after conversion with source identity retained. Provider alarm and raw-reading rules share incident correlation to avoid double requests.

For absent stable IDs, generate a documented deterministic source key. Preserve identical provider occurrences only when their identity can actually be distinguished. Do not invent timestamp precision or sequence IDs that falsely guarantee exactly-once delivery.

Use at-least-once delivery and idempotent consumers. Persist checkpoints after safely committing receipt. Buffer within the qualified capacity, proposed 72 hours at pilot load. Raise warning before capacity is exceeded. If source retention permits later backfill, record the gap and backfill window; otherwise mark missing evidence explicitly.

Historical replay defaults to analysis-only. It may update historical evidence but cannot create a burst of current work. Out-of-order live events use an agreed evaluation window; outside-window events are historical or quarantined. Rule duration, hysteresis, cooldown and episode closure are versioned configuration.

## Source cutover

Pause related rules and current route. Capture checkpoint and meter baseline. Validate replacement mapping and units. Increment routing epoch and activate replacement. Fence old-route live arrivals. Resume rules and reconcile buffered history. Maintain active incidents and avoid duplicate requests. A failed cutover restores the old route and epoch policy from the recorded manifest, without losing receipt history.

## Health and qualification

Show connectivity, last receipt, source-data age, processing lag, backlog, quarantined values, mapping coverage and credential expiry. Cloud/network failure never blocks manual work. Stale cumulative meters suspend PM rather than advancing from fabricated values.

Maintain a compatibility matrix listing provider/version, auth mode, ingestion mechanism, historical access, limitations, test environment and evidence date. Keep simulated adapters labeled and disabled in production by default. Qualify Live and OpenRemote independently; one passing adapter does not qualify the other.
