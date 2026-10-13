-- Platform-owned schema: tenancy, identity and the canonical asset registry.
-- Maintenance never writes these tables; it uses the registry HTTP contract.

CREATE TABLE platform.tenant (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.site (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenant (id),
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE platform.user_account (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenant (id),
  kind text NOT NULL CHECK (kind IN ('human', 'service')),
  email text,
  display_name text NOT NULL,
  password_hash text,
  client_id text UNIQUE,
  client_secret_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (kind = 'service' OR email IS NOT NULL),
  CHECK (kind = 'human' OR client_id IS NOT NULL)
);
CREATE UNIQUE INDEX user_account_email_uq ON platform.user_account (tenant_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE platform.site_membership (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (user_id, site_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES platform.site (tenant_id, id)
);

-- Registry and platform administration roles. Maintenance roles live in the maintenance schema.
CREATE TABLE platform.platform_role (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('platform_admin', 'asset_admin', 'mapping_admin')),
  site_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES platform.site (tenant_id, id)
);
CREATE UNIQUE INDEX platform_role_uq ON platform.platform_role
  (user_id, role, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE platform.refresh_token (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.user_account (tenant_id, id)
);

CREATE SEQUENCE platform.asset_change_seq;

CREATE TABLE platform.asset (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  asset_type text NOT NULL DEFAULT 'equipment',
  location text,
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived', 'tombstoned')),
  qr_token text NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1,
  change_seq bigint NOT NULL DEFAULT nextval('platform.asset_change_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, code),
  FOREIGN KEY (tenant_id, site_id) REFERENCES platform.site (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES platform.asset (tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX asset_site_idx ON platform.asset (tenant_id, site_id, lifecycle);
CREATE INDEX asset_change_idx ON platform.asset (tenant_id, change_seq);

CREATE TABLE platform.asset_history (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  version integer NOT NULL,
  change_kind text NOT NULL,
  snapshot jsonb NOT NULL,
  reason text,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES platform.asset (tenant_id, id)
);

-- Durable aliases preserve old IDs and QR tokens after consolidation or remapping.
CREATE TABLE platform.asset_alias (
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('id', 'qr')),
  value text NOT NULL,
  asset_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, kind, value),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES platform.asset (tenant_id, id)
);
CREATE UNIQUE INDEX asset_alias_qr_uq ON platform.asset_alias (value) WHERE kind = 'qr';

CREATE TABLE platform.external_asset_ref (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('visibility_live', 'openremote', 'cmms', 'import', 'simulated')),
  provider_instance text NOT NULL,
  external_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES platform.asset (tenant_id, id)
);
CREATE UNIQUE INDEX external_asset_ref_uq ON platform.external_asset_ref (tenant_id, provider, provider_instance, external_id)
  WHERE status = 'active';

CREATE TABLE platform.idempotency_key (
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

CREATE TABLE platform.audit_event (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  actor_id uuid,
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
CREATE INDEX platform_audit_target_idx ON platform.audit_event (tenant_id, target_type, target_id);

CREATE FUNCTION platform.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END $$;
CREATE TRIGGER platform_audit_append_only BEFORE UPDATE OR DELETE ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_audit_mutation();
