import { randomUUID } from 'node:crypto';
import type { siteAuthorityRequest, cmmsExceptionResolveRequest } from '@vm/contracts';
import { withTransaction } from '@vm/db';
import { conflict, invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission, requireVisible } from './access.ts';
import type { Actor, Services } from './context.ts';
import { writeAudit } from './records.ts';

type AuthorityInput = z.infer<typeof siteAuthorityRequest>;

export async function getSiteAuthority(s: Services, actor: Actor, siteId: string) {
  requireVisible(actor.principal, 'maintenance.view', siteId, 'Site');
  const { rows } = await s.db.query(`SELECT * FROM maintenance.site_record_authority WHERE tenant_id = $1 AND site_id = $2`, [
    actor.principal.tenantId,
    siteId,
  ]);
  if (!rows[0]) {
    return { site_id: siteId, work_order_mode: 'native' as const, field_ownership: {}, external_system: null };
  }
  return {
    site_id: rows[0].site_id,
    work_order_mode: rows[0].work_order_mode,
    field_ownership: rows[0].field_ownership ?? {},
    external_system: rows[0].external_system,
    updated_at: new Date(rows[0].updated_at).toISOString(),
  };
}

export async function setSiteAuthority(s: Services, actor: Actor, input: AuthorityInput) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.integration.manage', input.site_id);
  if (input.work_order_mode === 'external_cmms' && !input.external_system) {
    throw invalid('external_system is required for external_cmms mode', { external_system: ['Required'] });
  }
  return withTransaction(s.db, async (tx) => {
    await tx.query(
      `INSERT INTO maintenance.site_record_authority (tenant_id, site_id, work_order_mode, field_ownership, external_system, updated_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (tenant_id, site_id) DO UPDATE
         SET work_order_mode = EXCLUDED.work_order_mode,
             field_ownership = EXCLUDED.field_ownership,
             external_system = EXCLUDED.external_system,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by`,
      [p.tenantId, input.site_id, input.work_order_mode, JSON.stringify(input.field_ownership), input.external_system, p.userId],
    );
    await writeAudit(tx, actor, {
      siteId: input.site_id,
      action: 'authority.set',
      targetType: 'site',
      targetId: input.site_id,
      detail: { work_order_mode: input.work_order_mode, fields: Object.keys(input.field_ownership) },
    });
    return {
      site_id: input.site_id,
      work_order_mode: input.work_order_mode,
      field_ownership: input.field_ownership,
      external_system: input.external_system,
      updated_at: s.clock.now().toISOString(),
    };
  });
}

/**
 * Blocks native mutation of fields owned by an external CMMS (AC-13). Returns
 * null when the change is allowed; otherwise records an exception and throws.
 */
export async function assertNativeFieldMutable(
  s: Services,
  actor: Actor,
  siteId: string,
  workOrderId: string | null,
  fields: string[],
): Promise<void> {
  const auth = await getSiteAuthority(s, actor, siteId);
  if (auth.work_order_mode !== 'external_cmms') return;
  const owned = fields.filter((f) => auth.field_ownership[f] === 'external');
  if (!owned.length) return;
  const id = randomUUID();
  await s.db.query(
    `INSERT INTO maintenance.cmms_sync_exception (id, tenant_id, site_id, work_order_id, conflict_type, detail)
     VALUES ($1,$2,$3,$4,'native_overwrite_blocked',$5::jsonb)`,
    [id, actor.principal.tenantId, siteId, workOrderId, JSON.stringify({ fields: owned, external_system: auth.external_system })],
  );
  throw conflict('external_field_owned', `Fields owned by ${auth.external_system ?? 'external CMMS'} cannot be changed natively: ${owned.join(', ')}`);
}

export async function listCmmsExceptions(s: Services, actor: Actor, siteId: string, status: 'open' | 'resolved' | 'ignored' | 'all' = 'open') {
  requirePermission(actor.principal, 'maintenance.integration.manage', siteId);
  const { rows } = await s.db.query(
    `SELECT * FROM maintenance.cmms_sync_exception WHERE tenant_id = $1 AND site_id = $2 AND ($3::text = 'all' OR status = $3)
      ORDER BY created_at DESC LIMIT 200`,
    [actor.principal.tenantId, siteId, status],
  );
  return rows.map((r) => ({
    id: r.id,
    site_id: r.site_id,
    work_order_id: r.work_order_id,
    external_id: r.external_id,
    conflict_type: r.conflict_type,
    detail: r.detail,
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
    resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolution_note: r.resolution_note,
  }));
}

export async function resolveCmmsException(
  s: Services,
  actor: Actor,
  exceptionId: string,
  input: z.infer<typeof cmmsExceptionResolveRequest>,
) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.cmms_sync_exception WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [
      p.tenantId,
      exceptionId,
    ]);
    if (!rows[0]) throw notFound('CMMS exception');
    requirePermission(p, 'maintenance.integration.manage', rows[0].site_id);
    if (rows[0].status !== 'open') throw conflict('already_resolved', 'Exception is no longer open');
    await tx.query(
      `UPDATE maintenance.cmms_sync_exception SET status = $2, resolved_at = now(), resolved_by = $3, resolution_note = $4 WHERE id = $1`,
      [rows[0].id, input.status, p.userId, input.resolution_note],
    );
    await writeAudit(tx, actor, {
      siteId: rows[0].site_id,
      action: 'cmms_exception.resolved',
      targetType: 'cmms_sync_exception',
      targetId: rows[0].id,
      detail: { status: input.status },
    });
    return { id: rows[0].id, status: input.status };
  });
}

/** Enqueues a sync conflict when an external update disagrees with native state. */
export async function enqueueCmmsConflict(
  s: Services,
  tenantId: string,
  siteId: string,
  detail: { work_order_id?: string; external_id?: string; conflict_type: string; detail?: Record<string, unknown> },
): Promise<string> {
  const id = randomUUID();
  await s.db.query(
    `INSERT INTO maintenance.cmms_sync_exception (id, tenant_id, site_id, work_order_id, external_id, conflict_type, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [id, tenantId, siteId, detail.work_order_id ?? null, detail.external_id ?? null, detail.conflict_type, JSON.stringify(detail.detail ?? {})],
  );
  return id;
}
