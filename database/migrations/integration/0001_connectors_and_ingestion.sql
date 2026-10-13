-- Integration boundary: connector instances, signal routes, receipts and cutovers
-- (06_IOT_CONNECTORS, PRD §11). Work records stay in the maintenance schema.

CREATE TABLE integration.connector (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('visibility_live', 'openremote', 'simulated')),
  name text NOT NULL,
  -- Matches platform.external_asset_ref.provider_instance for this provider deployment.
  provider_instance text NOT NULL,
  -- Name of the secret held by the connector runtime; the secret value is never stored here.
  secret_ref text,
  service_account_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'disabled')),
  status_reason text,
  simulated boolean NOT NULL,
  last_receipt_at timestamptz,
  last_report jsonb,
  last_report_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_instance, site_id),
  CHECK (simulated = (provider = 'simulated'))
);

-- Adapter-reported discovery (MC-03). Samples are evidence for mapping preview.
CREATE TABLE integration.discovered_signal (
  tenant_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  external_asset_id text NOT NULL,
  external_asset_name text,
  external_attribute text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')),
  unit text,
  sample_value jsonb,
  sample_observed_at timestamptz,
  reported_at timestamptz NOT NULL,
  PRIMARY KEY (connector_id, external_asset_id, external_attribute),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES integration.connector (tenant_id, id)
);

CREATE TABLE integration.signal_route (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  signal_key text NOT NULL CHECK (signal_key ~ '^[a-z][a-z0-9_.]{0,79}$'),
  kind text NOT NULL CHECK (kind IN ('reading', 'alarm', 'meter')),
  external_asset_id text NOT NULL,
  external_attribute text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('number', 'boolean')),
  source_unit text,
  target_unit text,
  -- target = source * factor + offset
  conversion jsonb NOT NULL DEFAULT '{"factor": 1, "offset": 0}',
  freshness_seconds integer NOT NULL CHECK (freshness_seconds BETWEEN 1 AND 604800),
  -- Late live events older than this relative to the newest current reading are historical.
  evaluation_window_seconds integer NOT NULL DEFAULT 300 CHECK (evaluation_window_seconds BETWEEN 0 AND 86400),
  correlation_group text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'active', 'paused', 'retired', 'review_required')),
  status_reason text,
  routing_epoch integer NOT NULL DEFAULT 0,
  preview jsonb,
  previewed_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  last_observed_at timestamptz,
  last_receipt_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES integration.connector (tenant_id, id),
  CHECK ((value_type = 'boolean') = (kind = 'alarm')),
  CHECK (kind = 'alarm' OR (source_unit IS NOT NULL AND target_unit IS NOT NULL))
);
-- One active telemetry source per canonical asset/signal (PRD §11). Paused
-- routes stay addressable for epoch fencing during cutover but do not block the replacement.
CREATE UNIQUE INDEX signal_route_active_uq ON integration.signal_route (tenant_id, asset_id, signal_key) WHERE status = 'active';
CREATE UNIQUE INDEX signal_route_source_uq ON integration.signal_route (connector_id, external_asset_id, external_attribute) WHERE status = 'active';
CREATE INDEX signal_route_lookup_idx ON integration.signal_route (connector_id, external_asset_id, external_attribute, status);

CREATE TABLE integration.event_receipt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  route_id uuid,
  source_system text NOT NULL,
  source_event_id text NOT NULL,
  payload_hash text NOT NULL,
  external_asset_id text NOT NULL,
  external_attribute text NOT NULL,
  asset_id uuid,
  signal_key text,
  observed_at timestamptz,
  adapter_received_at timestamptz,
  ingested_at timestamptz NOT NULL,
  raw_value jsonb,
  raw_unit text,
  value jsonb,
  unit text,
  quality text,
  routing_epoch integer,
  historical boolean NOT NULL,
  simulated boolean NOT NULL,
  decision text NOT NULL CHECK (decision IN (
    'current', 'historical', 'stale', 'out_of_window', 'uncertain_quality', 'route_paused', 'fenced_epoch',
    'quarantined_unmapped', 'quarantined_unit', 'quarantined_quality', 'quarantined_invalid'
  )),
  decision_reason text,
  -- MC-04: delivery is at least once; the connector/source key is the idempotency key.
  UNIQUE (connector_id, source_event_id),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES integration.connector (tenant_id, id)
);
CREATE INDEX event_receipt_route_idx ON integration.event_receipt (route_id, observed_at DESC);
CREATE INDEX event_receipt_decision_idx ON integration.event_receipt (connector_id, decision, ingested_at DESC);

CREATE TABLE integration.checkpoint (
  connector_id uuid NOT NULL,
  stream text NOT NULL,
  tenant_id uuid NOT NULL,
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (connector_id, stream),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES integration.connector (tenant_id, id)
);

-- Unmapped signals, identity collisions and upstream identity changes awaiting an administrator.
CREATE TABLE integration.review_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unmapped_signal', 'source_id_collision', 'mapping_identity_changed')),
  subject text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text,
  FOREIGN KEY (tenant_id, connector_id) REFERENCES integration.connector (tenant_id, id)
);
CREATE UNIQUE INDEX review_item_open_uq ON integration.review_item (connector_id, kind, subject) WHERE status = 'open';

CREATE TABLE integration.cutover (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  signal_key text NOT NULL,
  from_route_id uuid NOT NULL REFERENCES integration.signal_route (id),
  to_route_id uuid NOT NULL REFERENCES integration.signal_route (id),
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'rolled_back')),
  -- Old epoch, watermark, checkpoints and meter baseline captured before the switch.
  manifest jsonb NOT NULL,
  reason text NOT NULL,
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL,
  finished_by uuid,
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK (from_route_id <> to_route_id)
);
CREATE UNIQUE INDEX cutover_open_uq ON integration.cutover (tenant_id, asset_id, signal_key) WHERE status = 'in_progress';
