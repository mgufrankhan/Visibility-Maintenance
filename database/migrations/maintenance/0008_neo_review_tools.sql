-- Extend Neo recommendation action types for review-only draft_work_order and propose_checklist.
ALTER TABLE maintenance.recommendation
  DROP CONSTRAINT IF EXISTS recommendation_action_type_check;

ALTER TABLE maintenance.recommendation
  ADD CONSTRAINT recommendation_action_type_check
  CHECK (action_type IN ('draft_request', 'draft_work_order', 'propose_checklist'));
