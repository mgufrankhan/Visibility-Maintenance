import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import type { amendDowntimeRequest, createDowntimeRequest, exposureRequest, externalCostRequest, restoreDowntimeRequest } from '@vm/contracts';
import { can, sitesWith } from '@vm/policy';
import { conflict, forbidden, invalid, notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import type { Actor, Services } from './context.ts';
import { identitySnapshot, resolveAsset } from './identity-snapshots.ts';
import { enqueueEvent, iso, writeAudit } from './records.ts';
import { loadVisibleWorkOrder } from './work-orders.ts';

const AMENDABLE = ['started_at', 'restored_at', 'classification', 'validated', 'symptom', 'failure_code', 'production_impact'] as const;

function dto(r: Record<string, any>) {
  return {
    id: r.id,
    site_id: r.site_id,
    asset_id: r.asset_id,
    asset_snapshot: r.asset_snapshot,
    started_at: iso(r.started_at),
    restored_at: iso(r.restored_at),
    open: r.restored_at === null,
    classification: r.classification,
    validated: r.validated,
    validated_by: r.validated_by,
    validated_at: iso(r.validated_at),
    symptom: r.symptom,
    failure_code: r.failure_code,
    production_impact: r.production_impact,
    source: r.source,
    source_ref: r.source_ref,
    version: r.version,
    created_by: r.created_by,
    created_at: iso(r.created_at),
  };
}

async function loadEvent(db: Queryable, actor: Actor, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM maintenance.failure_event WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const e = rows[0];
  if (!e || !can(actor.principal, 'maintenance.view', e.site_id)) throw notFound('Downtime event');
  return e;
}

async function emit(tx: Queryable, s: Services, actor: Actor, e: Record<string, any>, change: string): Promise<void> {
  await enqueueEvent(tx, actor, {
    siteId: e.site_id,
    type: 'maintenance.downtime.updated',
    aggregateType: 'failure_event',
    aggregateId: e.id,
    aggregateVersion: e.version,
    occurredAt: s.clock.now(),
    payload: { failure_event_id: e.id, asset_id: e.asset_id, change, classification: e.classification, validated: e.validated, started_at: iso(e.started_at), restored_at: iso(e.restored_at) },
  });
}

async function linkToOrder(tx: Queryable, actor: Actor, woId: string, event: Record<string, any>): Promise<void> {
  const wo = await loadVisibleWorkOrder(tx, actor, woId);
  if (wo.site_id !== event.site_id || (wo.asset_id && wo.asset_id !== event.asset_id)) throw invalid('Work order and downtime event must concern the same asset', { work_order_id: ['Different asset or site'] });
  await tx.query(
    `INSERT INTO maintenance.order_failure_link (tenant_id, work_order_id, failure_event_id, linked_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [actor.principal.tenantId, wo.id, event.id, actor.principal.userId],
  );
}

/**
 * MD-01/MD-02: technicians record downtime as unvalidated; only holders of
 * downtime.correct classify it as validated evidence for KPIs.
 */
export async function createDowntime(s: Services, actor: Actor, input: z.infer<typeof createDowntimeRequest>) {
  const p = actor.principal;
  const asset = await resolveAsset(s, actor, input.asset_id);
  requirePermission(p, 'maintenance.downtime.create', asset.site_id);
  await s.entitlements.require(p.tenantId, 'core.report_fault');
  return withTransaction(s.db, async (tx) => {
    if (input.client_op_id) {
      const { rows } = await tx.query(`SELECT * FROM maintenance.failure_event WHERE tenant_id = $1 AND created_by = $2 AND client_op_id = $3`, [p.tenantId, p.userId, input.client_op_id]);
      if (rows[0]) return { status: 200, body: dto(rows[0]) };
    }
    const validated = input.classification !== 'candidate' && can(p, 'maintenance.downtime.correct', asset.site_id);
    const now = s.clock.now();
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.failure_event
         (id, tenant_id, site_id, asset_id, asset_snapshot, started_at, restored_at, classification, validated, validated_by, validated_at,
          symptom, failure_code, production_impact, source, created_by, created_at, updated_at, client_op_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual',$15,$16,$16,$17) RETURNING *`,
      [id, p.tenantId, asset.site_id, asset.asset_id, JSON.stringify(identitySnapshot(asset)), input.started_at, input.restored_at, input.classification, validated, validated ? p.userId : null, validated ? now : null, input.symptom, input.failure_code, input.production_impact, p.userId, now, input.client_op_id],
    );
    if (input.work_order_id) await linkToOrder(tx, actor, input.work_order_id, rows[0]);
    await writeAudit(tx, actor, { siteId: asset.site_id, action: 'downtime.recorded', targetType: 'failure_event', targetId: id, afterVersion: 1, detail: { classification: input.classification, validated } });
    await emit(tx, s, actor, rows[0], 'recorded');
    return { status: 201, body: dto(rows[0]) };
  });
}

export async function restoreDowntime(s: Services, actor: Actor, id: string, input: z.infer<typeof restoreDowntimeRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const e = await loadEvent(tx, actor, id, true);
    requirePermission(p, 'maintenance.downtime.create', e.site_id);
    if (e.version !== input.record_version) throw staleVersion(e.version);
    if (e.restored_at) throw conflict('already_restored', 'This downtime event is already restored; use an amendment to correct it');
    if (new Date(input.restored_at) < e.started_at) throw invalid('Restoration cannot precede the start', { restored_at: ['Before started_at'] });
    const { rows } = await tx.query(`UPDATE maintenance.failure_event SET restored_at = $2, version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $3 WHERE id = $1 RETURNING *`, [e.id, input.restored_at, s.clock.now()]);
    await writeAudit(tx, actor, { siteId: e.site_id, action: 'downtime.restored', targetType: 'failure_event', targetId: e.id, beforeVersion: e.version, afterVersion: e.version + 1 });
    await emit(tx, s, actor, rows[0], 'restored');
    return dto(rows[0]);
  });
}

/** MD-04: corrections keep the original values, actor and reason. */
export async function amendDowntime(s: Services, actor: Actor, id: string, input: z.infer<typeof amendDowntimeRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const e = await loadEvent(tx, actor, id, true);
    requirePermission(p, 'maintenance.downtime.correct', e.site_id);
    if (e.version !== input.record_version) throw staleVersion(e.version);
    const changes = input.changes as Record<string, unknown>;
    const next = { ...e, ...changes };
    if (next.validated && next.classification === 'candidate') throw invalid('Classify the event before validating it', { 'changes.classification': ['Required for validation'] });
    const start = new Date(next.started_at as string | Date);
    if (next.restored_at && new Date(next.restored_at as string | Date) < start) throw invalid('Restoration cannot precede the start', { 'changes.restored_at': ['Before started_at'] });
    const fields = AMENDABLE.filter((f) => f in changes);
    const original = Object.fromEntries(fields.map((f) => [f, f.endsWith('_at') ? iso(e[f]) : e[f]]));
    const set: Record<string, unknown> = Object.fromEntries(fields.map((f) => [f, changes[f]]));
    if ('validated' in changes) {
      set.validated_by = changes.validated ? p.userId : null;
      set.validated_at = changes.validated ? s.clock.now() : null;
    }
    const cols = Object.keys(set);
    const { rows } = await tx.query(
      `UPDATE maintenance.failure_event SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $${cols.length + 2}
        WHERE id = $1 RETURNING *`,
      [e.id, ...cols.map((c) => set[c]), s.clock.now()],
    );
    await tx.query(
      `INSERT INTO maintenance.failure_amendment (id, tenant_id, failure_event_id, from_version, to_version, original, amended, reason, actor_id, amended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), p.tenantId, e.id, e.version, e.version + 1, JSON.stringify(original), JSON.stringify(changes), input.reason, p.userId, s.clock.now()],
    );
    await writeAudit(tx, actor, { siteId: e.site_id, action: 'downtime.amended', targetType: 'failure_event', targetId: e.id, beforeVersion: e.version, afterVersion: e.version + 1, reason: input.reason, detail: { fields } });
    await emit(tx, s, actor, rows[0], 'amended');
    return dto(rows[0]);
  });
}

/** MW-04/MD-03: several orders may reference one failure without duplicating its downtime. */
export async function linkFailure(s: Services, actor: Actor, woId: string, failureId: string) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const e = await loadEvent(tx, actor, failureId);
    if (!can(p, 'maintenance.work_order.execute', e.site_id) && !can(p, 'maintenance.work_order.edit', e.site_id)) throw forbidden();
    await linkToOrder(tx, actor, woId, e);
    await writeAudit(tx, actor, { siteId: e.site_id, action: 'work_order.failure_linked', targetType: 'work_order', targetId: woId, detail: { failure_event_id: e.id } });
    return { work_order_id: woId, failure_event_id: e.id };
  });
}

export async function getDowntime(s: Services, actor: Actor, id: string) {
  const e = await loadEvent(s.db, actor, id);
  const [amend, links] = await Promise.all([
    s.db.query(`SELECT from_version, to_version, original, amended, reason, actor_id, amended_at FROM maintenance.failure_amendment WHERE failure_event_id = $1 ORDER BY to_version`, [e.id]),
    s.db.query(`SELECT l.work_order_id, w.display_number, w.state FROM maintenance.order_failure_link l JOIN maintenance.work_order w ON w.id = l.work_order_id WHERE l.failure_event_id = $1`, [e.id]),
  ]);
  return { ...dto(e), amendments: amend.rows.map((a) => ({ ...a, amended_at: iso(a.amended_at) })), work_orders: links.rows };
}

export async function listDowntime(s: Services, actor: Actor, q: { site_id?: string; asset_id?: string; from?: string; to?: string; open?: boolean; limit: number }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
  if (q.asset_id) where.push(`asset_id::text = $${params.push(q.asset_id)}`);
  if (q.from) where.push(`coalesce(restored_at, 'infinity') >= $${params.push(q.from)}`);
  if (q.to) where.push(`started_at < $${params.push(q.to)}`);
  if (q.open !== undefined) where.push(q.open ? 'restored_at IS NULL' : 'restored_at IS NOT NULL');
  const { rows } = await s.db.query(`SELECT * FROM maintenance.failure_event WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id LIMIT ${q.limit}`, params);
  return rows.map(dto);
}

export async function recordExposure(s: Services, actor: Actor, input: z.infer<typeof exposureRequest>) {
  const p = actor.principal;
  const asset = await resolveAsset(s, actor, input.asset_id);
  requirePermission(p, 'maintenance.downtime.correct', asset.site_id);
  return withTransaction(s.db, async (tx) => {
    const { rows: overlap } = await tx.query(
      `SELECT id FROM maintenance.operating_exposure WHERE tenant_id = $1 AND asset_id = $2 AND period_start < $4 AND period_end > $3 LIMIT 1`,
      [p.tenantId, asset.asset_id, input.period_start, input.period_end],
    );
    if (overlap[0]) throw conflict('exposure_overlap', 'Operating exposure already recorded for an overlapping period');
    const id = randomUUID();
    await tx.query(
      `INSERT INTO maintenance.operating_exposure (id, tenant_id, site_id, asset_id, period_start, period_end, hours, basis, source, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, p.tenantId, asset.site_id, asset.asset_id, input.period_start, input.period_end, input.hours, input.basis, input.source, p.userId],
    );
    await writeAudit(tx, actor, { siteId: asset.site_id, action: 'exposure.recorded', targetType: 'asset', targetId: asset.asset_id, detail: { hours: input.hours, basis: input.basis } });
    return { id, ...input, asset_id: asset.asset_id };
  });
}

export async function addExternalCost(s: Services, actor: Actor, woId: string, input: z.infer<typeof externalCostRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisibleWorkOrder(tx, actor, woId);
    requirePermission(p, 'maintenance.cost.view', wo.site_id);
    requirePermission(p, 'maintenance.work_order.approve', wo.site_id);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO maintenance.external_service_cost (id, tenant_id, site_id, work_order_id, amount, currency, description, approved, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
      [id, p.tenantId, wo.site_id, wo.id, input.amount, input.currency.toUpperCase(), input.description, p.userId],
    );
    await writeAudit(tx, actor, { siteId: wo.site_id, action: 'work_order.external_cost_recorded', targetType: 'work_order', targetId: wo.id, detail: { amount: input.amount, currency: input.currency } });
    return { id, work_order_id: wo.id, ...input, approved: true };
  });
}
