-- Calendar PM plans, generated occurrences and typed inspections (PRD §8).

CREATE TABLE maintenance.pm_plan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_snapshot jsonb NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  current_revision_id uuid,
  -- Occurrences due before this instant are never generated (publish/resume point).
  generate_from timestamptz,
  last_occurrence_due_at timestamptz,
  next_generate_at timestamptz,
  last_generation_issue text,
  last_generation_issue_at timestamptz,
  pause_reason text,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX pm_plan_due_idx ON maintenance.pm_plan (status, next_generate_at) WHERE status = 'active';
CREATE INDEX pm_plan_site_idx ON maintenance.pm_plan (tenant_id, site_id, status);

CREATE TABLE maintenance.pm_plan_revision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  revision_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  title text NOT NULL,
  scope text NOT NULL,
  procedure_revision_id uuid NOT NULL REFERENCES maintenance.procedure_revision (id),
  team_id uuid NOT NULL REFERENCES maintenance.team (id),
  priority text NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  estimated_minutes integer NOT NULL CHECK (estimated_minutes > 0),
  lead_days integer NOT NULL CHECK (lead_days BETWEEN 0 AND 365),
  trigger jsonb NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  published_by uuid,
  published_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, revision_no),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES maintenance.pm_plan (tenant_id, id)
);

CREATE FUNCTION maintenance.protect_published_plan_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.trigger IS DISTINCT FROM OLD.trigger
      OR NEW.procedure_revision_id IS DISTINCT FROM OLD.procedure_revision_id
      OR NEW.team_id IS DISTINCT FROM OLD.team_id
      OR NEW.scope IS DISTINCT FROM OLD.scope
      OR NEW.lead_days IS DISTINCT FROM OLD.lead_days
      OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
    RAISE EXCEPTION 'published plan revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_plan_revision_immutable BEFORE UPDATE ON maintenance.pm_plan_revision
  FOR EACH ROW EXECUTE FUNCTION maintenance.protect_published_plan_revision();

CREATE TABLE maintenance.pm_occurrence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL REFERENCES maintenance.pm_plan_revision (id),
  asset_id uuid NOT NULL,
  occurrence_key text NOT NULL,
  due_at timestamptz NOT NULL,
  -- 'pending' exists only inside the generating transaction, before the order row is linked.
  status text NOT NULL CHECK (status IN ('pending', 'issued', 'missed', 'skipped_open_overdue', 'blocked_asset')),
  reason text,
  work_order_id uuid,
  generated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- MP-05: one occurrence per plan/asset/key under retries and concurrent workers.
  UNIQUE (tenant_id, plan_id, asset_id, occurrence_key),
  CHECK ((status = 'issued') = (work_order_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES maintenance.pm_plan (tenant_id, id)
);
CREATE INDEX pm_occurrence_plan_idx ON maintenance.pm_occurrence (tenant_id, plan_id, due_at DESC);
-- Every occurrence has at most one issued order, and every PM order has one occurrence.
CREATE UNIQUE INDEX pm_occurrence_order_uq ON maintenance.pm_occurrence (work_order_id) WHERE work_order_id IS NOT NULL;
CREATE UNIQUE INDEX work_order_occurrence_uq ON maintenance.work_order (plan_occurrence_id) WHERE plan_occurrence_id IS NOT NULL;

CREATE TABLE maintenance.inspection_template (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  title text NOT NULL,
  asset_type text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE maintenance.inspection_template_revision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  revision_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  instructions text NOT NULL DEFAULT '',
  checks jsonb NOT NULL,
  published_by uuid,
  published_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, revision_no),
  FOREIGN KEY (tenant_id, template_id) REFERENCES maintenance.inspection_template (tenant_id, id)
);

CREATE FUNCTION maintenance.protect_published_inspection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.checks IS DISTINCT FROM OLD.checks OR NEW.instructions IS DISTINCT FROM OLD.instructions) THEN
    RAISE EXCEPTION 'published inspection revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_revision_immutable BEFORE UPDATE ON maintenance.inspection_template_revision
  FOR EACH ROW EXECUTE FUNCTION maintenance.protect_published_inspection_revision();

CREATE TABLE maintenance.inspection_result (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  template_revision_id uuid NOT NULL REFERENCES maintenance.inspection_template_revision (id),
  checks_snapshot jsonb NOT NULL,
  asset_id uuid NOT NULL,
  asset_snapshot jsonb NOT NULL,
  work_order_id uuid,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  submitted_by uuid NOT NULL,
  client_submission_id text NOT NULL,
  started_at timestamptz NOT NULL,
  observed_at timestamptz,
  submitted_at timestamptz,
  values jsonb,
  evaluation jsonb,
  passed boolean,
  request_id uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, submitted_by, client_submission_id),
  CHECK (status = 'in_progress' OR (submitted_at IS NOT NULL AND passed IS NOT NULL)),
  CHECK (passed IS DISTINCT FROM false OR request_id IS NOT NULL)
);
CREATE INDEX inspection_result_asset_idx ON maintenance.inspection_result (tenant_id, asset_id, submitted_at DESC);
