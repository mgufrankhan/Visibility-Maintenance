-- One registry identity per installation. Products bind to it so that a
-- restored, re-pointed or second registry cannot silently fork asset identity.
CREATE TABLE platform.installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  registry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform.installation (registry_id) VALUES (gen_random_uuid());

CREATE OR REPLACE FUNCTION platform.installation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform.installation is immutable';
END;
$$;

CREATE TRIGGER installation_immutable BEFORE UPDATE OR DELETE ON platform.installation
  FOR EACH ROW EXECUTE FUNCTION platform.installation_immutable();

-- Product system identities (for example the Maintenance scheduler) join
-- every site of their tenant, including sites created after setup.
ALTER TABLE platform.user_account ADD COLUMN auto_site_membership boolean NOT NULL DEFAULT false;
ALTER TABLE platform.user_account ADD CONSTRAINT auto_site_membership_service_only CHECK (NOT auto_site_membership OR kind = 'service');
