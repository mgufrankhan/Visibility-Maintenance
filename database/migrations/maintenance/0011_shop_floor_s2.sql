-- S2: working languages, briefing recommendations, and human translations that do not replace the request text.

ALTER TABLE maintenance.site_settings
  ADD COLUMN working_languages text[] NOT NULL DEFAULT '{en}';

ALTER TABLE maintenance.recommendation
  DROP CONSTRAINT IF EXISTS recommendation_action_type_check;

ALTER TABLE maintenance.recommendation
  ADD CONSTRAINT recommendation_action_type_check
  CHECK (action_type IN (
    'draft_request',
    'draft_work_order',
    'propose_checklist',
    'draft_briefing',
    'structured_capture',
    'translate_description'
  ));

CREATE TABLE maintenance.request_translation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  request_id uuid NOT NULL,
  target_language text NOT NULL,
  body text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE INDEX request_translation_request_idx
  ON maintenance.request_translation (tenant_id, request_id, created_at);
