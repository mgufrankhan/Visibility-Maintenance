-- Optional Neo assistance records (PRD §10). Core work does not depend on these tables.

CREATE TABLE maintenance.agent_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid,
  actor_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('user_query', 'condition_incident', 'tool')),
  query text NOT NULL,
  inference_policy text NOT NULL,
  runtime text NOT NULL,
  model_version text,
  prompt_version text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  observations text NOT NULL,
  possible_causes jsonb NOT NULL DEFAULT '[]',
  recommended_checks jsonb NOT NULL DEFAULT '[]',
  citations jsonb NOT NULL DEFAULT '[]',
  missing_evidence jsonb NOT NULL DEFAULT '[]',
  proposed_action_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('answered', 'abstained', 'drafted', 'refused')),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX agent_run_site_idx ON maintenance.agent_run (tenant_id, site_id, created_at DESC);

CREATE TABLE maintenance.recommendation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES maintenance.agent_run (id),
  action_type text NOT NULL CHECK (action_type IN ('draft_request')),
  action_payload jsonb NOT NULL,
  action_version integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated')),
  proposed_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  resulting_request_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE INDEX recommendation_site_idx ON maintenance.recommendation (tenant_id, site_id, status, created_at DESC);

ALTER TABLE maintenance.agent_run
  ADD CONSTRAINT agent_run_proposed_fk FOREIGN KEY (proposed_action_id) REFERENCES maintenance.recommendation (id);
