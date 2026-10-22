import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import type { CheckDefinition, checkExceptionRequest, commentRequest, laborEntryRequest, taskResultRequest } from '@vm/contracts';
import { can } from '@vm/policy';
import { AppError, conflict, forbidden, invalid } from '@vm/server-kit';
import type { z } from 'zod';
import { evaluateCheck, isStepVisible } from './checks.ts';
import type { Actor, Services } from './context.ts';
import { requirePermission } from './access.ts';
import { iso, writeAudit } from './records.ts';
import { currentResults, isShutdownParent, loadVisibleWorkOrder } from './work-orders.ts';

const EXECUTING = ['in_progress', 'on_hold'];
const AMENDABLE = ['pending_review', 'closed'];

async function availableAttachments(db: Queryable, tenantId: string, woId: string): Promise<Set<string>> {
  const { rows } = await db.query(`SELECT id FROM maintenance.attachment WHERE tenant_id = $1 AND owner_type = 'work_order' AND owner_id = $2 AND status = 'available'`, [tenantId, woId]);
  return new Set(rows.map((r) => r.id));
}

/**
 * Appends typed check results. While executing, a later result for the same
 * step supersedes the earlier one but both are retained. After submission,
 * corrections are explicit amendments by an approver (MW-07).
 */
export async function recordTaskResults(s: Services, actor: Actor, woId: string, input: z.infer<typeof taskResultRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisibleWorkOrder(tx, actor, woId, true);
    const amending = input.amends_result_id !== null;
    if (amending) {
      requirePermission(p, 'maintenance.work_order.approve', wo.site_id);
      if (!AMENDABLE.includes(wo.state) && !EXECUTING.includes(wo.state)) throw conflict('record_locked', 'This work order cannot be amended');
      if (!input.amendment_reason || input.amendment_reason.trim().length < 3) throw invalid('Amendments require a reason', { amendment_reason: ['Required'] });
    } else {
      requirePermission(p, 'maintenance.work_order.execute', wo.site_id);
      if (!EXECUTING.includes(wo.state)) throw conflict('not_executing', 'Results can only be recorded while work is in progress; use an amendment afterwards');
      if (wo.assignee_id !== p.userId) throw forbidden('Only the assigned technician records results');
      await s.entitlements.require(p.tenantId, 'core.complete_active_work');
    }
    if (input.client_op_id) {
      const { rows } = await tx.query(`SELECT id, step_key FROM maintenance.task_result WHERE tenant_id = $1 AND recorded_by = $2 AND client_op_id = $3`, [p.tenantId, p.userId, input.client_op_id]);
      if (rows.length > 0) return { results: rows, replayed: true };
    }
    const stepList: CheckDefinition[] = wo.procedure_snapshot?.steps ?? [];
    const steps = new Map<string, CheckDefinition>(stepList.map((st) => [st.key, st]));
    const attachments = await availableAttachments(tx, p.tenantId, wo.id);
    const working = new Map(
      [...(await currentResults(tx, p.tenantId, wo.id, wo.cycle)).entries()].map(([key, row]) => [key, { passed: row.passed as boolean | null, note: row.note as string | null }]),
    );
    const errors: Record<string, string[]> = {};
    const incoming = new Map(input.results.map((r) => [r.key, r]));
    const evaluated: Array<{ r: (typeof input.results)[number]; passed: boolean | null }> = [];
    for (const def of stepList) {
      const r = incoming.get(def.key);
      if (!r) continue;
      if (!isStepVisible(def, working)) {
        const hidden = { ...r, value: null, unit: null, note: 'not_applicable', attachment_ids: [] as string[] };
        evaluated.push({ r: hidden, passed: null });
        working.set(def.key, { passed: null, note: 'not_applicable' });
        continue;
      }
      const e = evaluateCheck(def, r, attachments);
      if (e.error) errors[`results.${r.key}`] = [e.error];
      else {
        evaluated.push({ r, passed: e.passed });
        working.set(def.key, { passed: e.passed, note: r.note });
      }
    }
    for (const r of input.results) {
      if (!steps.has(r.key)) errors[`results.${r.key}`] = ['Step is not part of the issued procedure revision'];
    }
    if (!amending) {
      for (const def of stepList) {
        if (isStepVisible(def, working) || incoming.has(def.key)) continue;
        const prev = working.get(def.key);
        if (prev?.note === 'not_applicable') continue;
        evaluated.push({
          r: { key: def.key, value: null, unit: null, note: 'not_applicable', attachment_ids: [] },
          passed: null,
        });
      }
    }
    if (Object.keys(errors).length) throw invalid('Some results are invalid', errors);
    let supersedes: string | null = null;
    if (amending) {
      const { rows } = await tx.query(`SELECT id, step_key, cycle FROM maintenance.task_result WHERE tenant_id = $1 AND work_order_id = $2 AND id = $3`, [p.tenantId, wo.id, input.amends_result_id]);
      if (!rows[0]) throw invalid('Amended result not found', { amends_result_id: ['Unknown result'] });
      if (input.results.length !== 1 || input.results[0]!.key !== rows[0].step_key) throw invalid('An amendment replaces exactly one result for the same step');
      supersedes = rows[0].id;
    }
    const now = s.clock.now();
    const recordedAt = input.recorded_at ? new Date(input.recorded_at) : now;
    if (recordedAt.getTime() > now.getTime() + 5 * 60_000) throw invalid('recorded_at is in the future', { recorded_at: ['Device clock ahead of server'] });
    const out = [];
    for (const item of evaluated) {
      const { r, passed } = item!;
      const id = randomUUID();
      await tx.query(
        `INSERT INTO maintenance.task_result
           (id, tenant_id, site_id, work_order_id, cycle, step_key, value, unit, passed, note, attachment_ids, recorded_by, recorded_at, received_at, client_op_id, supersedes_id, amendment_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, p.tenantId, wo.site_id, wo.id, wo.cycle, r.key, JSON.stringify(r.value), r.unit, passed, r.note, r.attachment_ids, p.userId, recordedAt, now, input.client_op_id, supersedes, input.amendment_reason],
      );
      out.push({ id, step_key: r.key, passed });
    }
    await writeAudit(tx, actor, { siteId: wo.site_id, action: amending ? 'work_order.result_amended' : 'work_order.results_recorded', targetType: 'work_order', targetId: wo.id, reason: input.amendment_reason, detail: { steps: out.map((o) => o.step_key), failed: out.filter((o) => o.passed === false).map((o) => o.step_key) } });
    return { results: out, replayed: false };
  });
}

export async function grantCheckException(s: Services, actor: Actor, woId: string, input: z.infer<typeof checkExceptionRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisibleWorkOrder(tx, actor, woId, true);
    requirePermission(p, 'maintenance.work_order.approve', wo.site_id);
    if (!['in_progress', 'on_hold', 'pending_review'].includes(wo.state)) throw conflict('invalid_state', 'Exceptions can only be granted during execution or review');
    const step = (wo.procedure_snapshot?.steps ?? []).find((st: CheckDefinition) => st.key === input.step_key);
    if (!step) throw invalid('Step is not part of the issued procedure', { step_key: ['Unknown step'] });
    if (step.safety_critical) throw new AppError(409, 'safety_critical_check', 'Safety-critical checks cannot be waived through a workflow exception');
    try {
      await tx.query(
        `INSERT INTO maintenance.check_exception (id, tenant_id, work_order_id, cycle, step_key, reason, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), p.tenantId, wo.id, wo.cycle, input.step_key, input.reason, p.userId],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('exception_exists', 'An exception already exists for this step');
      throw err;
    }
    await writeAudit(tx, actor, { siteId: wo.site_id, action: 'work_order.check_exception_granted', targetType: 'work_order', targetId: wo.id, reason: input.reason, detail: { step_key: input.step_key } });
    return { step_key: input.step_key, reason: input.reason, granted_by: p.userId };
  });
}

async function rateFor(db: Queryable, tenantId: string, userId: string, at: Date): Promise<{ rate: string; currency: string } | null> {
  const { rows } = await db.query(
    `SELECT hourly_rate, currency FROM maintenance.labor_rate WHERE tenant_id = $1 AND user_id = $2 AND effective_from <= $3 ORDER BY effective_from DESC LIMIT 1`,
    [tenantId, userId, at],
  );
  return rows[0] ? { rate: rows[0].hourly_rate, currency: rows[0].currency } : null;
}

export async function addLaborEntry(s: Services, actor: Actor, woId: string, input: z.infer<typeof laborEntryRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisibleWorkOrder(tx, actor, woId, true);
    if (isShutdownParent(wo)) throw conflict('shutdown_parent', 'A shutdown parent does not accept labor');
    const personId = input.person_id ?? p.userId;
    const amending = input.amends_entry_id !== null;
    if (amending) {
      requirePermission(p, 'maintenance.work_order.approve', wo.site_id);
      if (!input.amendment_reason?.trim()) throw invalid('Amendments require a reason', { amendment_reason: ['Required'] });
      if (wo.state === 'cancelled') throw conflict('record_locked', 'Cancelled work cannot be amended');
    } else {
      requirePermission(p, 'maintenance.work_order.execute', wo.site_id);
      if (!EXECUTING.includes(wo.state)) throw conflict('not_executing', 'Labor can only be recorded while work is in progress; use an amendment afterwards');
      if (personId !== p.userId) requirePermission(p, 'maintenance.work_order.assign', wo.site_id);
    }
    if (input.client_op_id) {
      const { rows } = await tx.query(`SELECT * FROM maintenance.labor_entry WHERE tenant_id = $1 AND recorded_by = $2 AND client_op_id = $3`, [p.tenantId, p.userId, input.client_op_id]);
      if (rows[0]) return { ...laborDto(rows[0], can(p, 'maintenance.cost.view', wo.site_id)), replayed: true };
    }
    if (amending) {
      const { rows } = await tx.query(`SELECT id FROM maintenance.labor_entry WHERE tenant_id = $1 AND work_order_id = $2 AND id = $3`, [p.tenantId, wo.id, input.amends_entry_id]);
      if (!rows[0]) throw invalid('Amended entry not found', { amends_entry_id: ['Unknown labor entry'] });
    }
    const started = new Date(input.started_at);
    const ended = input.ended_at ? new Date(input.ended_at) : null;
    if (ended && ended < started) throw invalid('ended_at must not precede started_at');
    const minutes = input.duration_minutes ?? Math.round((ended!.getTime() - started.getTime()) / 60000);
    const rate = await rateFor(tx, p.tenantId, personId, started);
    const { rows } = await tx.query(
      `INSERT INTO maintenance.labor_entry
         (id, tenant_id, site_id, work_order_id, person_id, started_at, ended_at, duration_minutes, hourly_rate, currency, note, recorded_by, client_op_id, amends_entry_id, amendment_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [randomUUID(), p.tenantId, wo.site_id, wo.id, personId, started, ended, minutes, rate?.rate ?? null, rate?.currency ?? null, input.note, p.userId, input.client_op_id, input.amends_entry_id, input.amendment_reason],
    );
    await writeAudit(tx, actor, { siteId: wo.site_id, action: amending ? 'work_order.labor_amended' : 'work_order.labor_recorded', targetType: 'work_order', targetId: wo.id, reason: input.amendment_reason, detail: { person_id: personId, minutes } });
    return { ...laborDto(rows[0], can(p, 'maintenance.cost.view', wo.site_id)), replayed: false };
  });
}

function laborDto(l: Record<string, any>, showCost: boolean) {
  return {
    id: l.id,
    person_id: l.person_id,
    started_at: iso(l.started_at),
    ended_at: iso(l.ended_at),
    duration_minutes: l.duration_minutes,
    note: l.note,
    amends_entry_id: l.amends_entry_id,
    ...(showCost ? { hourly_rate: l.hourly_rate, currency: l.currency } : {}),
  };
}

export async function addComment(s: Services, actor: Actor, woId: string, input: z.infer<typeof commentRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisibleWorkOrder(tx, actor, woId);
    if (!can(p, 'maintenance.work_order.execute', wo.site_id) && !can(p, 'maintenance.work_order.edit', wo.site_id)) throw forbidden();
    if (input.client_op_id) {
      const { rows } = await tx.query(`SELECT id, author_id, body, created_at FROM maintenance.comment WHERE tenant_id = $1 AND author_id = $2 AND client_op_id = $3`, [p.tenantId, p.userId, input.client_op_id]);
      if (rows[0]) return rows[0];
    }
    const { rows } = await tx.query(
      `INSERT INTO maintenance.comment (id, tenant_id, site_id, work_order_id, author_id, body, client_op_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, author_id, body, created_at`,
      [randomUUID(), p.tenantId, wo.site_id, wo.id, p.userId, input.body, input.client_op_id, s.clock.now()],
    );
    return rows[0];
  });
}

export async function setLaborRate(s: Services, actor: Actor, siteId: string, input: { user_id: string; hourly_rate: number; currency: string; effective_from: string }) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.settings.manage', siteId);
  requirePermission(p, 'maintenance.cost.view', siteId);
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO maintenance.labor_rate (id, tenant_id, user_id, hourly_rate, currency, effective_from, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, p.tenantId, input.user_id, input.hourly_rate, input.currency.toUpperCase(), new Date(input.effective_from), p.userId],
    );
    await writeAudit(tx, actor, { siteId, action: 'labor_rate.set', targetType: 'user', targetId: input.user_id, detail: { currency: input.currency, effective_from: input.effective_from } });
    return { id };
  });
}
