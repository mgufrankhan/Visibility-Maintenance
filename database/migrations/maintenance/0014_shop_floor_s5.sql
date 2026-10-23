-- S5: completion-relative preventive plans, and an approved cancellation exemption.

ALTER TABLE maintenance.pm_plan DROP CONSTRAINT IF EXISTS pm_plan_trigger_kind_check;

ALTER TABLE maintenance.pm_plan
  ADD CONSTRAINT pm_plan_trigger_kind_check CHECK (trigger_kind IN ('calendar', 'meter', 'completion'));

ALTER TABLE maintenance.work_order
  ADD COLUMN cancel_exemption boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT work_order_cancel_exemption_ck CHECK (cancel_exemption = false OR state = 'cancelled');
