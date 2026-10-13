-- Procedures, requests, work orders and execution records.

CREATE TABLE maintenance.procedure (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE maintenance.procedure_revision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  procedure_id uuid NOT NULL,
  revision_no integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'obsolete')),
  summary text NOT NULL DEFAULT '',
  safety_instructions text NOT NULL,
  steps jsonb NOT NULL,
  estimated_minutes integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  published_at timestamptz,
  published_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (procedure_id, revision_no),
  FOREIGN KEY (tenant_id, procedure_id) REFERENCES maintenance.procedure (tenant_id, id)
);

-- Published revisions are immutable apart from being marked obsolete.
CREATE FUNCTION maintenance.protect_published_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.steps IS DISTINCT FROM OLD.steps
      OR NEW.safety_instructions IS DISTINCT FROM OLD.safety_instructions
      OR NEW.summary IS DISTINCT FROM OLD.summary
      OR NEW.revision_no IS DISTINCT FROM OLD.revision_no) THEN
    RAISE EXCEPTION 'published procedure revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER procedure_revision_immutable BEFORE UPDATE ON maintenance.procedure_revision
  FOR EACH ROW EXECUTE FUNCTION maintenance.protect_published_revision();

CREATE TABLE maintenance.request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  display_number integer NOT NULL,
  origin text NOT NULL CHECK (origin IN ('manual', 'inspection', 'connector', 'neo')),
  reporter_id uuid NOT NULL,
  asset_id uuid,
  asset_snapshot jsonb,
  location_text text,
  description text NOT NULL,
  observed_at timestamptz NOT NULL,
  proposed_priority text NOT NULL CHECK (proposed_priority IN ('critical', 'high', 'normal', 'low')),
  reading jsonb,
  voice_transcript text,
  source_ref jsonb,
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'under_review', 'accepted', 'rejected', 'duplicate')),
  triage_reason text,
  triaged_by uuid,
  triaged_at timestamptz,
  linked_work_order_id uuid,
  duplicate_of_request_id uuid,
  duplicate_of_work_order_id uuid,
  client_request_id text,
  version integer NOT NULL DEFAULT 1,
  change_seq bigint NOT NULL DEFAULT nextval('maintenance.change_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, display_number),
  CHECK (asset_id IS NOT NULL OR location_text IS NOT NULL),
  CHECK (state NOT IN ('rejected', 'duplicate') OR triage_reason IS NOT NULL),
  CHECK (state <> 'accepted' OR linked_work_order_id IS NOT NULL),
  CHECK (state <> 'duplicate' OR duplicate_of_request_id IS NOT NULL OR duplicate_of_work_order_id IS NOT NULL)
);
CREATE INDEX request_site_state_idx ON maintenance.request (tenant_id, site_id, state, created_at DESC);
CREATE INDEX request_reporter_idx ON maintenance.request (tenant_id, reporter_id, created_at DESC);
CREATE UNIQUE INDEX request_client_uq ON maintenance.request (tenant_id, reporter_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE maintenance.work_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  display_number integer NOT NULL,
  type text NOT NULL CHECK (type IN ('corrective', 'preventive', 'inspection', 'follow_up')),
  state text NOT NULL CHECK (state IN ('draft', 'pending_approval', 'ready', 'in_progress', 'on_hold', 'pending_review', 'closed', 'cancelled')),
  priority text NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  scope text NOT NULL,
  asset_id uuid,
  asset_snapshot jsonb,
  non_asset_category text,
  non_asset_justification text,
  location_text text,
  team_id uuid NOT NULL,
  assignee_id uuid,
  planned_start timestamptz,
  planned_end timestamptz,
  due_at timestamptz,
  procedure_revision_id uuid,
  procedure_snapshot jsonb,
  safety_instructions text,
  source_request_id uuid,
  plan_occurrence_id uuid,
  follow_up_of_id uuid,
  cycle integer NOT NULL DEFAULT 1,
  observed_symptoms text,
  failure_code text,
  cause_code text,
  cause_unknown_reason text,
  corrective_action text,
  acknowledgments jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  closure_outcome text,
  cancel_reason text,
  version integer NOT NULL DEFAULT 1,
  change_seq bigint NOT NULL DEFAULT nextval('maintenance.change_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, display_number),
  FOREIGN KEY (tenant_id, team_id) REFERENCES maintenance.team (tenant_id, id),
  FOREIGN KEY (tenant_id, source_request_id) REFERENCES maintenance.request (tenant_id, id),
  CHECK (state IN ('draft', 'cancelled') OR asset_id IS NOT NULL
         OR (non_asset_category IS NOT NULL AND non_asset_justification IS NOT NULL)),
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start),
  CHECK (state <> 'closed' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND closure_outcome IS NOT NULL)),
  CHECK (state <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX work_order_backlog_idx ON maintenance.work_order (tenant_id, site_id, state, due_at);
CREATE INDEX work_order_assignee_idx ON maintenance.work_order (tenant_id, assignee_id, state);
CREATE INDEX work_order_asset_idx ON maintenance.work_order (tenant_id, asset_id, created_at DESC);
CREATE INDEX work_order_change_idx ON maintenance.work_order (tenant_id, change_seq);

ALTER TABLE maintenance.request
  ADD FOREIGN KEY (tenant_id, linked_work_order_id) REFERENCES maintenance.work_order (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, duplicate_of_work_order_id) REFERENCES maintenance.work_order (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, duplicate_of_request_id) REFERENCES maintenance.request (tenant_id, id);

CREATE TABLE maintenance.work_order_transition (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  action text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  from_version integer,
  to_version integer NOT NULL,
  cycle integer NOT NULL,
  actor_id uuid,
  actor_kind text NOT NULL,
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  occurred_at timestamptz NOT NULL,
  UNIQUE (work_order_id, to_version),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id)
);
CREATE TRIGGER transition_append_only BEFORE UPDATE OR DELETE ON maintenance.work_order_transition
  FOR EACH ROW EXECUTE FUNCTION maintenance.reject_audit_mutation();

CREATE TABLE maintenance.work_order_closure (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  cycle integer NOT NULL,
  submitted_by uuid,
  verifier_id uuid NOT NULL,
  verified_at timestamptz NOT NULL,
  outcome text NOT NULL,
  self_approval_exception boolean NOT NULL DEFAULT false,
  UNIQUE (work_order_id, cycle),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id)
);

CREATE TABLE maintenance.task_result (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  cycle integer NOT NULL,
  step_key text NOT NULL,
  value jsonb NOT NULL,
  unit text,
  passed boolean,
  note text,
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  client_op_id text,
  supersedes_id uuid,
  amendment_reason text,
  entry_seq bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id)
);
CREATE INDEX task_result_order_idx ON maintenance.task_result (tenant_id, work_order_id, cycle, step_key, entry_seq);
CREATE UNIQUE INDEX task_result_client_uq ON maintenance.task_result (tenant_id, recorded_by, client_op_id, step_key) WHERE client_op_id IS NOT NULL;
CREATE TRIGGER task_result_append_only BEFORE UPDATE OR DELETE ON maintenance.task_result
  FOR EACH ROW EXECUTE FUNCTION maintenance.reject_audit_mutation();

CREATE TABLE maintenance.check_exception (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  cycle integer NOT NULL,
  step_key text NOT NULL,
  reason text NOT NULL,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, cycle, step_key),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id)
);

CREATE TABLE maintenance.labor_rate (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  hourly_rate numeric(12, 2) NOT NULL CHECK (hourly_rate >= 0),
  currency char(3) NOT NULL,
  effective_from timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX labor_rate_user_idx ON maintenance.labor_rate (tenant_id, user_id, effective_from DESC);

CREATE TABLE maintenance.labor_entry (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  person_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_minutes integer NOT NULL CHECK (duration_minutes >= 0),
  hourly_rate numeric(12, 2),
  currency char(3),
  note text,
  recorded_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  client_op_id text,
  amends_entry_id uuid,
  amendment_reason text,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (amends_entry_id IS NULL OR amendment_reason IS NOT NULL)
);
CREATE INDEX labor_order_idx ON maintenance.labor_entry (tenant_id, work_order_id);
CREATE UNIQUE INDEX labor_client_uq ON maintenance.labor_entry (tenant_id, recorded_by, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE TRIGGER labor_append_only BEFORE UPDATE OR DELETE ON maintenance.labor_entry
  FOR EACH ROW EXECUTE FUNCTION maintenance.reject_audit_mutation();

CREATE TABLE maintenance.comment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  client_op_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maintenance.work_order (tenant_id, id)
);
CREATE UNIQUE INDEX comment_client_uq ON maintenance.comment (tenant_id, author_id, client_op_id) WHERE client_op_id IS NOT NULL;
