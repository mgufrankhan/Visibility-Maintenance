-- Distinct failure events, their links to work, amendments and operating exposure.
-- Technician labor stays in labor_entry; equipment downtime lives here (MW-04).

CREATE TABLE maintenance.failure_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_snapshot jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  restored_at timestamptz,
  classification text NOT NULL CHECK (classification IN ('candidate', 'unplanned_failure', 'planned_stop', 'break', 'communication_loss', 'other')),
  validated boolean NOT NULL DEFAULT false,
  validated_by uuid,
  validated_at timestamptz,
  symptom text,
  failure_code text,
  production_impact text,
  source text NOT NULL CHECK (source IN ('manual', 'connector', 'inspection')),
  source_ref jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (restored_at IS NULL OR restored_at >= started_at),
  CHECK (NOT validated OR classification <> 'candidate')
);
CREATE INDEX failure_event_asset_idx ON maintenance.failure_event (tenant_id, asset_id, started_at);
CREATE INDEX failure_event_site_idx ON maintenance.failure_event (tenant_id, site_id, started_at);

CREATE TABLE maintenance.failure_amendment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  failure_event_id uuid NOT NULL,
  from_version integer NOT NULL,
  to_version integer NOT NULL,
  original jsonb NOT NULL,
  amended jsonb NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  amended_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, failure_event_id) REFERENCES maintenance.failure_event (tenant_id, id)
);
CREATE TRIGGER failure_amendment_append_only BEFORE UPDATE OR DELETE ON maintenance.failure_amendment
  FOR EACH ROW EXECUTE FUNCTION maintenance.reject_audit_mutation();

CREATE TABLE maintenance.order_failure_link (
  tenant_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  failure_event_id uuid NOT NULL,
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_order_id, failure_event_id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id),
  FOREIGN KEY (tenant_id, failure_event_id) REFERENCES maintenance.failure_event (tenant_id, id)
);

-- Verified or estimated operating hours used as MTBF exposure.
CREATE TABLE maintenance.operating_exposure (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  hours numeric(12, 2) NOT NULL CHECK (hours >= 0),
  basis text NOT NULL CHECK (basis IN ('verified', 'estimated')),
  source text NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);
CREATE INDEX operating_exposure_asset_idx ON maintenance.operating_exposure (tenant_id, asset_id, period_start);

CREATE TABLE maintenance.external_service_cost (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  description text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id)
);
