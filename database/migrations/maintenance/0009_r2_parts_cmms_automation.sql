-- R2: parts ledger, CMMS record authority, low-risk automation policies.

CREATE TABLE maintenance.store (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, code)
);
CREATE INDEX store_site_idx ON maintenance.store (tenant_id, site_id);

CREATE TABLE maintenance.part (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE maintenance.inventory_balance (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  part_id uuid NOT NULL,
  on_hand numeric(18, 4) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved numeric(18, 4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, part_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES maintenance.store (tenant_id, id),
  FOREIGN KEY (tenant_id, part_id) REFERENCES maintenance.part (tenant_id, id),
  CHECK (reserved <= on_hand)
);

CREATE TABLE maintenance.stock_reservation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  store_id uuid NOT NULL,
  part_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed', 'cancelled')),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES maintenance.store (tenant_id, id),
  FOREIGN KEY (tenant_id, part_id) REFERENCES maintenance.part (tenant_id, id)
);
CREATE UNIQUE INDEX stock_reservation_idem_uq ON maintenance.stock_reservation (tenant_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX stock_reservation_wo_idx ON maintenance.stock_reservation (tenant_id, work_order_id) WHERE status = 'active';

-- Immutable ledger. quantity is signed: receive +, issue -, return +, adjust +/-.
CREATE TABLE maintenance.stock_movement (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  store_id uuid NOT NULL,
  part_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('receive', 'issue', 'return', 'adjust')),
  quantity numeric(18, 4) NOT NULL CHECK (quantity <> 0),
  unit text NOT NULL,
  unit_cost numeric(18, 4),
  currency text,
  reason text NOT NULL,
  work_order_id uuid,
  reservation_id uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES maintenance.store (tenant_id, id),
  FOREIGN KEY (tenant_id, part_id) REFERENCES maintenance.part (tenant_id, id)
);
CREATE UNIQUE INDEX stock_movement_idem_uq ON maintenance.stock_movement (tenant_id, created_by, movement_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX stock_movement_store_idx ON maintenance.stock_movement (tenant_id, store_id, created_at DESC);
CREATE INDEX stock_movement_wo_idx ON maintenance.stock_movement (tenant_id, work_order_id) WHERE work_order_id IS NOT NULL;

-- Per-site work-order authority (AC-13). Native is the R1 default.
CREATE TABLE maintenance.site_record_authority (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  work_order_mode text NOT NULL DEFAULT 'native' CHECK (work_order_mode IN ('native', 'external_cmms')),
  field_ownership jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_system text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, site_id)
);

CREATE TABLE maintenance.cmms_sync_exception (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  work_order_id uuid,
  external_id text,
  conflict_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  UNIQUE (tenant_id, id)
);
CREATE INDEX cmms_exception_open_idx ON maintenance.cmms_sync_exception (tenant_id, site_id, status) WHERE status = 'open';

-- Approved low-risk automations; disabled by default, one kind at a time.
CREATE TABLE maintenance.automation_policy (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('auto_draft_high_priority_request')),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, kind)
);
