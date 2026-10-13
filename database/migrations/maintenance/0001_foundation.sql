-- Maintenance-owned foundation: installation state, licensing, roles, teams,
-- identity snapshots, profiles, idempotency, audit, outbox, attachments, notifications.

CREATE TABLE maintenance.installation_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE maintenance.license_installation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  license_id text NOT NULL,
  document jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'rejected')),
  verification_error text,
  imported_by uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX license_active_uq ON maintenance.license_installation (tenant_id) WHERE status = 'active';

CREATE TABLE maintenance.role_assignment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  site_id uuid,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX role_assignment_uq ON maintenance.role_assignment
  (tenant_id, user_id, role, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX role_assignment_user_idx ON maintenance.role_assignment (tenant_id, user_id);

CREATE TABLE maintenance.team (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, name)
);

CREATE TABLE maintenance.team_member (
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES maintenance.team (tenant_id, id)
);

-- Versioned read-only caches of registry identity, refreshed from the registry
-- change feed. Never authoritative; used for scoping and registry outages.
CREATE TABLE maintenance.site_snapshot (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id)
);

CREATE TABLE maintenance.asset_snapshot (
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  site_id uuid NOT NULL,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  asset_type text NOT NULL,
  location text,
  lifecycle text NOT NULL,
  qr_token text NOT NULL,
  version integer NOT NULL,
  change_seq bigint NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, asset_id)
);
CREATE INDEX asset_snapshot_site_idx ON maintenance.asset_snapshot (tenant_id, site_id);

CREATE TABLE maintenance.profile (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  site_id uuid NOT NULL,
  maintainable boolean NOT NULL,
  criticality text CHECK (criticality IN ('a_critical', 'b_important', 'c_standard')),
  team_id uuid,
  warranty_reference text,
  service_interval_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_taxonomy text[] NOT NULL DEFAULT '{}',
  document_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  UNIQUE (tenant_id, asset_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES maintenance.team (tenant_id, id)
);

CREATE TABLE maintenance.site_settings (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  incident_contact_instructions text,
  pm_initial_state text NOT NULL DEFAULT 'ready' CHECK (pm_initial_state IN ('ready', 'pending_approval')),
  allow_self_approval boolean NOT NULL DEFAULT false,
  self_approval_justification text,
  repeat_fault_window_days integer NOT NULL DEFAULT 30,
  holiday_policy text NOT NULL DEFAULT 'none' CHECK (holiday_policy IN ('none', 'shift_to_next_working_day')),
  holidays date[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id, site_id),
  CHECK (NOT allow_self_approval OR self_approval_justification IS NOT NULL)
);

CREATE TABLE maintenance.site_counter (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  kind text NOT NULL,
  next_value integer NOT NULL,
  PRIMARY KEY (tenant_id, site_id, kind)
);

CREATE TABLE maintenance.idempotency_key (
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL,
  key text NOT NULL,
  payload_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, operation, key)
);
CREATE INDEX idempotency_created_idx ON maintenance.idempotency_key (created_at);

CREATE TABLE maintenance.audit_event (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_version integer,
  after_version integer,
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_target_idx ON maintenance.audit_event (tenant_id, target_type, target_id, id);
CREATE INDEX audit_site_time_idx ON maintenance.audit_event (tenant_id, site_id, occurred_at);

CREATE FUNCTION maintenance.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON maintenance.audit_event
  FOR EACH ROW EXECUTE FUNCTION maintenance.reject_audit_mutation();

CREATE TABLE maintenance.outbox (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  event_type text NOT NULL,
  schema_version integer NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text
);
CREATE INDEX outbox_pending_idx ON maintenance.outbox (status, next_attempt_at) WHERE status = 'pending';

CREATE TABLE maintenance.attachment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('work_order', 'request', 'inspection_result', 'procedure_revision', 'asset_document', 'downtime_event')),
  owner_id uuid NOT NULL,
  step_key text,
  file_name text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'quarantined', 'rejected')),
  status_reason text,
  client_op_id text,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX attachment_owner_idx ON maintenance.attachment (tenant_id, owner_type, owner_id);
CREATE UNIQUE INDEX attachment_client_op_uq ON maintenance.attachment (tenant_id, uploaded_by, client_op_id) WHERE client_op_id IS NOT NULL;

CREATE TABLE maintenance.notification (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (user_id, event_id, kind)
);
CREATE INDEX notification_user_idx ON maintenance.notification (tenant_id, user_id, created_at DESC);

CREATE SEQUENCE maintenance.change_seq;
