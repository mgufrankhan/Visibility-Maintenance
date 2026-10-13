import type { Queryable } from '@vm/db';

export interface PlatformAudit {
  tenantId: string;
  siteId?: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  beforeVersion?: number | null;
  afterVersion?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
  correlationId?: string | null;
}

export async function audit(db: Queryable, e: PlatformAudit): Promise<void> {
  await db.query(
    `INSERT INTO platform.audit_event
       (tenant_id, site_id, actor_id, action, target_type, target_id, before_version, after_version, reason, detail, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      e.tenantId,
      e.siteId ?? null,
      e.actorId,
      e.action,
      e.targetType,
      e.targetId,
      e.beforeVersion ?? null,
      e.afterVersion ?? null,
      e.reason ?? null,
      JSON.stringify(e.detail ?? {}),
      e.correlationId ?? null,
    ],
  );
}
