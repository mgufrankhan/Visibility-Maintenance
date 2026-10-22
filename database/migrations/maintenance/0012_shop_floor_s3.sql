-- S3: expected parts on a plan revision, and an optional site block when stock is short.

ALTER TABLE maintenance.site_settings
  ADD COLUMN pm_block_on_shortage boolean NOT NULL DEFAULT false;

ALTER TABLE maintenance.pm_plan_revision
  ADD COLUMN expected_parts jsonb NOT NULL DEFAULT '[]';

CREATE OR REPLACE FUNCTION maintenance.protect_published_plan_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.trigger IS DISTINCT FROM OLD.trigger
      OR NEW.procedure_revision_id IS DISTINCT FROM OLD.procedure_revision_id
      OR NEW.team_id IS DISTINCT FROM OLD.team_id
      OR NEW.scope IS DISTINCT FROM OLD.scope
      OR NEW.lead_days IS DISTINCT FROM OLD.lead_days
      OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
      OR NEW.expected_parts IS DISTINCT FROM OLD.expected_parts) THEN
    RAISE EXCEPTION 'published plan revisions are immutable';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE maintenance.pm_occurrence DROP CONSTRAINT IF EXISTS pm_occurrence_status_check;
ALTER TABLE maintenance.pm_occurrence
  ADD CONSTRAINT pm_occurrence_status_check
  CHECK (status IN ('pending', 'issued', 'missed', 'skipped_open_overdue', 'blocked_asset', 'blocked_shortage'));
