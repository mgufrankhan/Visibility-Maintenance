-- S4: one shutdown order may coordinate child orders at the same site.
-- Children keep their own asset, lifecycle, labor, evidence and downtime.

ALTER TABLE maintenance.work_order
  ADD COLUMN parent_id uuid,
  ADD CONSTRAINT work_order_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  ADD CONSTRAINT work_order_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES maintenance.work_order (tenant_id, id);

CREATE INDEX work_order_parent_idx ON maintenance.work_order (tenant_id, parent_id) WHERE parent_id IS NOT NULL;
