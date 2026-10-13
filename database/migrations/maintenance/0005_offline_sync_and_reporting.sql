-- Offline sync operation log (MO-02) and downtime offline dedupe.

CREATE TABLE maintenance.sync_operation (
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  client_op_id text NOT NULL,
  op_type text NOT NULL,
  record_id text,
  base_version integer,
  client_time timestamptz,
  received_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'conflict', 'rejected')),
  result jsonb NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, client_op_id)
);

ALTER TABLE maintenance.failure_event ADD COLUMN client_op_id text;
CREATE UNIQUE INDEX failure_event_client_uq ON maintenance.failure_event (tenant_id, created_by, client_op_id) WHERE client_op_id IS NOT NULL;
ALTER TABLE maintenance.failure_event ADD COLUMN change_seq bigint NOT NULL DEFAULT nextval('maintenance.change_seq');

CREATE INDEX request_change_idx ON maintenance.request (tenant_id, change_seq);
CREATE INDEX order_failure_link_failure_idx ON maintenance.order_failure_link (failure_event_id);
