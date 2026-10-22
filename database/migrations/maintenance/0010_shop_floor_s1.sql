-- S1 shop-floor records: conditional checks, completion signatures, and site shifts.

ALTER TABLE maintenance.procedure_revision
  ADD COLUMN signature_required boolean NOT NULL DEFAULT false;

ALTER TABLE maintenance.inspection_template_revision
  ADD COLUMN signature_required boolean NOT NULL DEFAULT false;

ALTER TABLE maintenance.inspection_result
  ADD COLUMN signature_required boolean NOT NULL DEFAULT false;

ALTER TABLE maintenance.site_settings
  ADD COLUMN shifts jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION maintenance.protect_published_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.steps IS DISTINCT FROM OLD.steps
      OR NEW.safety_instructions IS DISTINCT FROM OLD.safety_instructions
      OR NEW.summary IS DISTINCT FROM OLD.summary
      OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
      OR NEW.signature_required IS DISTINCT FROM OLD.signature_required) THEN
    RAISE EXCEPTION 'published procedure revisions are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION maintenance.protect_published_inspection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.checks IS DISTINCT FROM OLD.checks
      OR NEW.instructions IS DISTINCT FROM OLD.instructions
      OR NEW.signature_required IS DISTINCT FROM OLD.signature_required) THEN
    RAISE EXCEPTION 'published inspection revisions are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE maintenance.completion_signature (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('work_order', 'inspection_result')),
  owner_id uuid NOT NULL,
  cycle integer NOT NULL,
  signer_id uuid NOT NULL,
  signed_at timestamptz NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  client_op_id text,
  amends_signature_id uuid,
  amendment_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX completion_signature_owner_idx
  ON maintenance.completion_signature (tenant_id, owner_type, owner_id, cycle, created_at DESC);
CREATE UNIQUE INDEX completion_signature_client_uq
  ON maintenance.completion_signature (tenant_id, signer_id, client_op_id)
  WHERE client_op_id IS NOT NULL;

CREATE TRIGGER completion_signature_append_only BEFORE UPDATE OR DELETE ON maintenance.completion_signature
  FOR EACH ROW EXECUTE FUNCTION maintenance.reject_audit_mutation();
