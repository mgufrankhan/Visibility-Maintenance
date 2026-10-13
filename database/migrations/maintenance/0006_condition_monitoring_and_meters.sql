-- Condition rules, incident episodes and cumulative meters (PRD §8, §9; MI-01..MI-06, MP-04).
-- Receipts live in the integration schema and are referenced by ID only.

CREATE TABLE maintenance.condition_rule (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_snapshot jsonb NOT NULL,
  signal_key text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_revision_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX condition_rule_signal_idx ON maintenance.condition_rule (tenant_id, asset_id, signal_key) WHERE status = 'active';

CREATE TABLE maintenance.condition_rule_revision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  revision_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  operator text NOT NULL CHECK (operator IN ('gt', 'gte', 'lt', 'lte')),
  threshold numeric NOT NULL,
  unit text NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 0 AND 86400),
  hysteresis numeric NOT NULL DEFAULT 0 CHECK (hysteresis >= 0),
  cooldown_seconds integer NOT NULL CHECK (cooldown_seconds BETWEEN 0 AND 2592000),
  priority text NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  team_id uuid NOT NULL REFERENCES maintenance.team (id),
  correlation_group text NOT NULL,
  published_by uuid,
  published_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, revision_no),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES maintenance.condition_rule (tenant_id, id)
);

CREATE FUNCTION maintenance.protect_published_rule_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.operator IS DISTINCT FROM OLD.operator
      OR NEW.threshold IS DISTINCT FROM OLD.threshold
      OR NEW.unit IS DISTINCT FROM OLD.unit
      OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
      OR NEW.hysteresis IS DISTINCT FROM OLD.hysteresis
      OR NEW.cooldown_seconds IS DISTINCT FROM OLD.cooldown_seconds
      OR NEW.priority IS DISTINCT FROM OLD.priority
      OR NEW.team_id IS DISTINCT FROM OLD.team_id
      OR NEW.correlation_group IS DISTINCT FROM OLD.correlation_group) THEN
    RAISE EXCEPTION 'published rule revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER condition_rule_revision_immutable BEFORE UPDATE ON maintenance.condition_rule_revision
  FOR EACH ROW EXECUTE FUNCTION maintenance.protect_published_rule_revision();

-- Duration tracking per rule. Paused during source cutover.
CREATE TABLE maintenance.rule_state (
  rule_id uuid PRIMARY KEY REFERENCES maintenance.condition_rule (id),
  tenant_id uuid NOT NULL,
  breach_since timestamptz,
  last_observed_at timestamptz,
  last_value numeric,
  paused_by_cutover uuid,
  updated_at timestamptz NOT NULL
);

CREATE TABLE maintenance.incident (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_snapshot jsonb NOT NULL,
  correlation_group text NOT NULL,
  episode integer NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'recovered', 'closed')),
  source text NOT NULL CHECK (source IN ('rule', 'provider_alarm')),
  rule_id uuid,
  rule_revision_id uuid,
  opening_receipt_id uuid NOT NULL,
  priority text NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  simulated boolean NOT NULL,
  opened_at timestamptz NOT NULL,
  recovered_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  cooldown_seconds integer NOT NULL DEFAULT 0,
  -- New episodes for the key are suppressed until this time; readings meanwhile are follow-up evidence.
  cooldown_until timestamptz,
  request_id uuid,
  request_blocked_reason text,
  evidence_count integer NOT NULL DEFAULT 1,
  last_evidence_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, asset_id, correlation_group, episode),
  CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL)),
  CHECK (request_id IS NULL OR request_blocked_reason IS NULL)
);
-- MI-03: one active episode per correlation key; alarm and reading paths share it.
CREATE UNIQUE INDEX incident_active_uq ON maintenance.incident (tenant_id, asset_id, correlation_group) WHERE status <> 'closed';
CREATE INDEX incident_site_idx ON maintenance.incident (tenant_id, site_id, status, opened_at DESC);

CREATE TABLE maintenance.incident_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'breach', 'alarm', 'recovery', 'alarm_cleared', 'follow_up')),
  observed_at timestamptz NOT NULL,
  value jsonb,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  UNIQUE (incident_id, receipt_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES maintenance.incident (tenant_id, id)
);

-- MI-02: every current-event evaluation is traceable to a rule version and decision.
CREATE TABLE maintenance.rule_evaluation (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  rule_revision_id uuid,
  asset_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  evaluated jsonb NOT NULL,
  decision text NOT NULL CHECK (decision IN (
    'normal', 'breach_pending', 'incident_opened', 'evidence_appended', 'suppressed_cooldown',
    'recovered', 'rule_paused', 'unit_mismatch', 'alarm_cleared'
  )),
  incident_id uuid,
  created_at timestamptz NOT NULL
);
CREATE INDEX rule_evaluation_receipt_idx ON maintenance.rule_evaluation (receipt_id);

CREATE TABLE maintenance.meter (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_snapshot jsonb NOT NULL,
  signal_key text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  freshness_seconds integer NOT NULL CHECK (freshness_seconds BETWEEN 60 AND 2592000),
  status text NOT NULL DEFAULT 'awaiting_reading' CHECK (status IN ('awaiting_reading', 'ok', 'reset_suspected')),
  issue text,
  -- usage = segment_offset + (raw - segment_start_raw); resets start a new segment (MP-04).
  segment_offset numeric NOT NULL DEFAULT 0,
  segment_start_raw numeric,
  last_raw numeric,
  last_usage numeric,
  last_observed_at timestamptz,
  last_source text CHECK (last_source IN ('connector', 'manual')),
  -- Set by a source cutover declared as a different counter: the next accepted reading starts a new segment.
  rebaseline_cutover_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, asset_id, signal_key)
);

CREATE TABLE maintenance.meter_reading (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  raw_value numeric NOT NULL,
  usage numeric,
  observed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('connector', 'manual')),
  receipt_id uuid,
  client_entry_id text,
  entered_by uuid,
  status text NOT NULL CHECK (status IN ('accepted', 'rejected_decrease', 'out_of_order', 'historical')),
  reason text,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, meter_id) REFERENCES maintenance.meter (tenant_id, id),
  CHECK ((source = 'connector') = (receipt_id IS NOT NULL)),
  CHECK (status <> 'accepted' OR usage IS NOT NULL)
);
CREATE UNIQUE INDEX meter_reading_receipt_uq ON maintenance.meter_reading (meter_id, receipt_id) WHERE receipt_id IS NOT NULL;
CREATE UNIQUE INDEX meter_reading_client_uq ON maintenance.meter_reading (meter_id, entered_by, client_entry_id) WHERE client_entry_id IS NOT NULL;
CREATE INDEX meter_reading_time_idx ON maintenance.meter_reading (meter_id, observed_at DESC);

CREATE TABLE maintenance.meter_baseline (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reset', 'replacement', 'source_cutover')),
  previous_raw numeric,
  usage_at_change numeric NOT NULL,
  new_raw numeric NOT NULL,
  reason text NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, meter_id) REFERENCES maintenance.meter (tenant_id, id)
);

ALTER TABLE maintenance.pm_plan
  ADD COLUMN trigger_kind text NOT NULL DEFAULT 'calendar' CHECK (trigger_kind IN ('calendar', 'meter')),
  ADD COLUMN meter_id uuid REFERENCES maintenance.meter (id),
  ADD COLUMN meter_next_threshold numeric,
  ADD CONSTRAINT pm_plan_meter_ck CHECK ((trigger_kind = 'meter') = (meter_id IS NOT NULL));

ALTER TABLE maintenance.pm_occurrence
  ADD COLUMN threshold numeric,
  ADD COLUMN completion_usage numeric,
  ADD COLUMN usage_overrun_at timestamptz,
  ADD COLUMN usage_overrun_value numeric;
