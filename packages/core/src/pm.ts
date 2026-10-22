import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction, type Queryable } from '@vm/db';
import type { createPlanRequest, planRevisionRequest, planStatusRequest } from '@vm/contracts';
import { can, OPEN_STATES, sitesWith } from '@vm/policy';
import { AppError, conflict, invalid, notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import type { Actor, AnyActor, Services, SystemActor } from './context.ts';
import { identitySnapshot, resolveAsset, siteInfo, type AssetIdentity } from './identity-snapshots.ts';
import { assertPartsStockedAtSite, expectedPartsOf, shortageText } from './parts-coverage.ts';
import { issuableRevision } from './procedures.ts';
import { enqueueEvent, iso, writeAudit } from './records.ts';
import { nextOccurrences, occurrencesBetween, validateTrigger, type CalendarTrigger, type HolidayRule, type Occurrence } from './recurrence.ts';
import type { MeterTrigger } from './meters.ts';
import { loadSiteSettings } from './settings.ts';
import { insertWorkOrder } from './work-orders.ts';

type PlanRevisionInput = z.infer<typeof planRevisionRequest>;

async function holidayRule(db: Queryable, tenantId: string, siteId: string): Promise<HolidayRule> {
  const st = await loadSiteSettings(db, tenantId, siteId);
  return { policy: st.holiday_policy, holidays: new Set(st.holidays) };
}

async function loadPlan(db: Queryable, actor: Actor, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM maintenance.pm_plan WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const plan = rows[0];
  if (!plan || !can(actor.principal, 'maintenance.view', plan.site_id)) throw notFound('Plan');
  return plan;
}

function revisionDto(r: Record<string, any>) {
  return {
    id: r.id,
    plan_id: r.plan_id,
    revision_no: r.revision_no,
    status: r.status,
    title: r.title,
    scope: r.scope,
    procedure_revision_id: r.procedure_revision_id,
    team_id: r.team_id,
    priority: r.priority,
    estimated_minutes: r.estimated_minutes,
    lead_days: r.lead_days,
    trigger: r.trigger as CalendarTrigger | MeterTrigger,
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    expected_parts: expectedPartsOf(r.expected_parts),
    published_at: iso(r.published_at),
    published_by: r.published_by,
  };
}

function planDto(p: Record<string, any>) {
  return {
    id: p.id,
    site_id: p.site_id,
    asset_id: p.asset_id,
    asset_snapshot: p.asset_snapshot,
    title: p.title,
    status: p.status,
    trigger_kind: p.trigger_kind,
    meter_id: p.meter_id,
    meter_next_threshold: p.meter_next_threshold === null ? null : Number(p.meter_next_threshold),
    current_revision_id: p.current_revision_id,
    last_occurrence_due_at: iso(p.last_occurrence_due_at),
    next_generate_at: iso(p.next_generate_at),
    last_generation_issue: p.last_generation_issue,
    last_generation_issue_at: iso(p.last_generation_issue_at),
    pause_reason: p.pause_reason,
    version: p.version,
    created_at: iso(p.created_at),
  };
}

export async function createPlan(s: Services, actor: Actor, input: z.infer<typeof createPlanRequest>) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.plan.manage', input.site_id);
  const asset = await resolveAsset(s, actor, input.asset_id);
  if (asset.site_id !== input.site_id) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  if (asset.lifecycle !== 'active') throw conflict('asset_not_active', `Asset ${asset.code} is ${asset.lifecycle}`);
  return withTransaction(s.db, async (tx) => {
    const triggerKind = input.trigger_kind ?? 'calendar';
    const meterId = input.meter_id ?? null;
    if (meterId) {
      const { rows: m } = await tx.query(`SELECT asset_id FROM maintenance.meter WHERE tenant_id = $1 AND id = $2`, [p.tenantId, meterId]);
      if (m[0]?.asset_id !== asset.asset_id) throw invalid('Meter must belong to the plan asset', { meter_id: ['Unknown meter for this asset'] });
    }
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.pm_plan (id, tenant_id, site_id, asset_id, asset_snapshot, title, trigger_kind, meter_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, p.tenantId, input.site_id, asset.asset_id, JSON.stringify(identitySnapshot(asset)), input.title, triggerKind, meterId, p.userId],
    );
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'plan.created', targetType: 'pm_plan', targetId: id, afterVersion: 1, detail: { trigger_kind: input.trigger_kind } });
    return planDto(rows[0]);
  });
}

export async function addPlanRevision(s: Services, actor: Actor, planId: string, input: PlanRevisionInput) {
  const p = actor.principal;
  const plan = await loadPlan(s.db, actor, planId);
  requirePermission(p, 'maintenance.plan.manage', plan.site_id);
  if (plan.status === 'archived') throw conflict('plan_archived', 'Archived plans cannot be revised');
  if (input.trigger.type !== plan.trigger_kind) throw invalid(`This plan uses a ${plan.trigger_kind} trigger`, { trigger: [`Expected a ${plan.trigger_kind} trigger`] });
  if (input.trigger.type === 'calendar') {
    const site = await siteInfo(s, actor, plan.site_id);
    try {
      validateTrigger(input.trigger, site.timezone);
    } catch (err) {
      throw invalid((err as Error).message, { trigger: [(err as Error).message] });
    }
  }
  return withTransaction(s.db, async (tx) => {
    await issuableRevision(tx, p.tenantId, input.procedure_revision_id, plan.site_id);
    await assertPartsStockedAtSite(tx, p.tenantId, plan.site_id, input.expected_parts);
    const { rows: team } = await tx.query(`SELECT site_id, status FROM maintenance.team WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.team_id]);
    if (team[0]?.site_id !== plan.site_id || team[0]?.status !== 'active') throw invalid('Owning team must be an active team at this site', { team_id: ['Unknown team for this site'] });
    await tx.query(`SELECT 1 FROM maintenance.pm_plan WHERE id = $1 FOR UPDATE`, [plan.id]);
    const { rows: n } = await tx.query<{ next: number }>(`SELECT coalesce(max(revision_no), 0) + 1 AS next FROM maintenance.pm_plan_revision WHERE plan_id = $1`, [plan.id]);
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.pm_plan_revision
         (id, tenant_id, plan_id, revision_no, title, scope, procedure_revision_id, team_id, priority, estimated_minutes, lead_days, trigger, effective_from, effective_to, expected_parts, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *, effective_from::text AS effective_from, effective_to::text AS effective_to`,
      [id, p.tenantId, plan.id, n[0]!.next, input.title, input.scope, input.procedure_revision_id, input.team_id, input.priority, input.estimated_minutes, input.lead_days, JSON.stringify(input.trigger), input.effective_from, input.effective_to, JSON.stringify(input.expected_parts), p.userId],
    );
    await writeAudit(tx, actor, { siteId: plan.site_id, action: 'plan.revision_drafted', targetType: 'pm_plan', targetId: plan.id, detail: { revision_id: id, revision_no: n[0]!.next } });
    return revisionDto(rows[0]);
  });
}

const REVISION_COLS = `r.*, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to`;

/** MP-01: publishing versions the plan; already-issued orders keep their own procedure snapshot. */
export async function publishPlanRevision(s: Services, actor: Actor, revisionId: string) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT ${REVISION_COLS} FROM maintenance.pm_plan_revision r WHERE r.tenant_id = $1 AND r.id::text = $2 FOR UPDATE`, [p.tenantId, revisionId]);
    const rev = rows[0];
    if (!rev) throw notFound('Plan revision');
    const plan = await loadPlan(tx, actor, rev.plan_id, true);
    requirePermission(p, 'maintenance.plan.manage', plan.site_id);
    if (rev.status !== 'draft') throw conflict('revision_not_draft', `Revision is ${rev.status}`);
    await issuableRevision(tx, p.tenantId, rev.procedure_revision_id, plan.site_id);
    await assertPartsStockedAtSite(tx, p.tenantId, plan.site_id, expectedPartsOf(rev.expected_parts));
    const now = s.clock.now();
    await tx.query(`UPDATE maintenance.pm_plan_revision SET status = 'superseded' WHERE plan_id = $1 AND status = 'published'`, [plan.id]);
    await tx.query(`UPDATE maintenance.pm_plan_revision SET status = 'published', published_by = $2, published_at = $3 WHERE id = $1`, [rev.id, p.userId, now]);
    const status = plan.status === 'paused' ? 'paused' : 'active';
    let nextThreshold = plan.meter_next_threshold;
    if (plan.trigger_kind === 'meter' && nextThreshold === null) {
      // First publication: the cycle starts from current validated usage, or from the first reading.
      const { rows: m } = await tx.query(`SELECT last_usage FROM maintenance.meter WHERE id = $1`, [plan.meter_id]);
      nextThreshold = m[0]?.last_usage === null || m[0]?.last_usage === undefined ? null : Number(m[0].last_usage) + (rev.trigger as MeterTrigger).interval;
    }
    const { rows: updated } = await tx.query(
      `UPDATE maintenance.pm_plan SET current_revision_id = $2, status = $3, generate_from = $4, next_generate_at = NULL,
         last_generation_issue = NULL, meter_next_threshold = $5, version = version + 1, updated_at = $4 WHERE id = $1 RETURNING *`,
      [plan.id, rev.id, status, now, nextThreshold],
    );
    await writeAudit(tx, actor, { siteId: plan.site_id, action: 'plan.revision_published', targetType: 'pm_plan', targetId: plan.id, beforeVersion: plan.version, afterVersion: plan.version + 1, detail: { revision_id: rev.id, revision_no: rev.revision_no } });
    return planDto(updated[0]);
  });
}

/** MP-05: pausing stops future generation but never cancels issued work. */
export async function setPlanPaused(s: Services, actor: Actor, planId: string, paused: boolean, input: z.infer<typeof planStatusRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const plan = await loadPlan(tx, actor, planId, true);
    requirePermission(p, 'maintenance.plan.manage', plan.site_id);
    if (plan.version !== input.record_version) throw staleVersion(plan.version);
    if (paused && plan.status !== 'active') throw conflict('invalid_state', `Plan is ${plan.status}`);
    if (!paused && plan.status !== 'paused') throw conflict('invalid_state', `Plan is ${plan.status}`);
    const now = s.clock.now();
    const { rows } = paused
      ? await tx.query(`UPDATE maintenance.pm_plan SET status = 'paused', pause_reason = $2, version = version + 1, updated_at = $3 WHERE id = $1 RETURNING *`, [plan.id, input.reason, now])
      : await tx.query(`UPDATE maintenance.pm_plan SET status = 'active', pause_reason = NULL, generate_from = $2, next_generate_at = NULL, version = version + 1, updated_at = $2 WHERE id = $1 RETURNING *`, [plan.id, now]);
    await writeAudit(tx, actor, { siteId: plan.site_id, action: paused ? 'plan.paused' : 'plan.resumed', targetType: 'pm_plan', targetId: plan.id, beforeVersion: plan.version, afterVersion: plan.version + 1, reason: input.reason });
    return planDto(rows[0]);
  });
}

export async function listPlans(s: Services, actor: Actor, q: { site_id?: string; asset_id?: string; status?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
  if (q.asset_id) where.push(`asset_id::text = $${params.push(q.asset_id)}`);
  if (q.status) where.push(`status = $${params.push(q.status)}`);
  const { rows } = await s.db.query(`SELECT * FROM maintenance.pm_plan WHERE ${where.join(' AND ')} ORDER BY title, id LIMIT 500`, params);
  return rows.map(planDto);
}

export async function getPlan(s: Services, actor: Actor, id: string) {
  const plan = await loadPlan(s.db, actor, id);
  const [revs, occ] = await Promise.all([
    s.db.query(`SELECT ${REVISION_COLS} FROM maintenance.pm_plan_revision r WHERE r.plan_id = $1 ORDER BY revision_no DESC`, [plan.id]),
    s.db.query(`SELECT id, occurrence_key, due_at, status, reason, work_order_id, plan_revision_id, created_at FROM maintenance.pm_occurrence WHERE plan_id = $1 ORDER BY due_at DESC LIMIT 50`, [plan.id]),
  ]);
  const current = revs.rows.find((r) => r.id === plan.current_revision_id);
  let preview: Array<{ key: string; due_at: string }> = [];
  if (current && plan.status === 'active' && current.trigger.type === 'calendar') {
    const site = await siteInfo(s, actor, plan.site_id);
    const rule = await holidayRule(s.db, actor.principal.tenantId, plan.site_id);
    const from = new Date(Math.max(s.clock.now().getTime(), plan.last_occurrence_due_at ? plan.last_occurrence_due_at.getTime() + 1 : 0));
    preview = withinEffective(nextOccurrences(current.trigger, site.timezone, rule, from, 6), current).map((o) => ({ key: o.key, due_at: o.dueAt.toISOString() }));
  }
  return {
    ...planDto(plan),
    revisions: revs.rows.map(revisionDto),
    occurrences: occ.rows.map((o) => ({ ...o, due_at: iso(o.due_at), created_at: iso(o.created_at) })),
    upcoming: preview,
  };
}

/** Schedule preview for an unpublished revision (PM planning editor). */
export async function previewPlanRevision(s: Services, actor: Actor, revisionId: string, count: number) {
  const { rows } = await s.db.query(`SELECT ${REVISION_COLS}, p.site_id FROM maintenance.pm_plan_revision r JOIN maintenance.pm_plan p ON p.id = r.plan_id WHERE r.tenant_id = $1 AND r.id::text = $2`, [actor.principal.tenantId, revisionId]);
  const rev = rows[0];
  if (!rev || !can(actor.principal, 'maintenance.view', rev.site_id)) throw notFound('Plan revision');
  if (rev.trigger.type !== 'calendar') return [];
  const site = await siteInfo(s, actor, rev.site_id);
  const rule = await holidayRule(s.db, actor.principal.tenantId, rev.site_id);
  const start = new Date(Math.max(s.clock.now().getTime(), Date.parse(`${rev.effective_from}T00:00:00Z`) - 86_400_000));
  return withinEffective(nextOccurrences(rev.trigger, site.timezone, rule, start, count), rev).map((o) => ({
    key: o.key,
    nominal_date: o.nominalDate,
    due_date: o.dueDate,
    due_at: o.dueAt.toISOString(),
    generate_at: new Date(o.dueAt.getTime() - rev.lead_days * 86_400_000).toISOString(),
  }));
}

function withinEffective(occ: Occurrence[], rev: { effective_from: string; effective_to: string | null }): Occurrence[] {
  return occ.filter((o) => o.key >= rev.effective_from && (rev.effective_to === null || o.key <= rev.effective_to));
}

// ---------- Scheduler ----------

export interface SchedulerSummary {
  plans: number;
  issued: number;
  missed: number;
  skipped: number;
  blocked: number;
  issues: Array<{ plan_id: string; issue: string }>;
}

const DAY = 86_400_000;

async function recordIssue(db: Queryable, planId: string, issue: string, now: Date, retryAt: Date | null): Promise<void> {
  await db.query(`UPDATE maintenance.pm_plan SET last_generation_issue = $2, last_generation_issue_at = $3, next_generate_at = $4 WHERE id = $1`, [planId, issue, now, retryAt]);
}

async function insertOccurrence(tx: Queryable, plan: Record<string, any>, revId: string, o: Occurrence, status: string, reason: string | null, workerId: string): Promise<string | null> {
  const id = randomUUID();
  const { rows } = await tx.query(
    `INSERT INTO maintenance.pm_occurrence (id, tenant_id, site_id, plan_id, plan_revision_id, asset_id, occurrence_key, due_at, status, reason, work_order_id, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)
     ON CONFLICT (tenant_id, plan_id, asset_id, occurrence_key) DO NOTHING RETURNING id`,
    [id, plan.tenant_id, plan.site_id, plan.id, revId, plan.asset_id, o.key, o.dueAt, status === 'issued' ? 'pending' : status, reason, workerId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Generates due occurrences for one plan inside one transaction: occurrence
 * rows, work orders, outbox events and the plan cursor commit together, so a
 * crash after commit can never repeat work and a crash before commit leaves
 * nothing behind (MP-03, MP-05).
 */
async function generateForPlan(s: Services, workerId: string, planId: string, asset: AssetIdentity | null, assetError: string | null, sum: SchedulerSummary): Promise<void> {
  await withTransaction(s.db, async (tx: PoolClient) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.pm_plan WHERE id = $1 AND status = 'active' AND trigger_kind = 'calendar' FOR UPDATE SKIP LOCKED`, [planId]);
    const plan = rows[0];
    if (!plan || !plan.current_revision_id) return;
    sum.plans++;
    const now = s.clock.now();
    const system: SystemActor = { kind: 'system', tenantId: plan.tenant_id, label: `pm-scheduler:${workerId}`, correlationId: randomUUID() };
    if (!(await s.entitlements.has(plan.tenant_id, 'core.generate_pm'))) {
      sum.blocked++;
      sum.issues.push({ plan_id: plan.id, issue: 'license' });
      await recordIssue(tx, plan.id, 'PM generation is blocked by the current license state', now, new Date(now.getTime() + 3600_000));
      return;
    }
    if (!asset) {
      sum.issues.push({ plan_id: plan.id, issue: 'registry' });
      await recordIssue(tx, plan.id, assetError ?? 'Asset identity unavailable', now, new Date(now.getTime() + 600_000));
      return;
    }
    const { rows: revRows } = await tx.query(`SELECT ${REVISION_COLS} FROM maintenance.pm_plan_revision r WHERE r.id = $1`, [plan.current_revision_id]);
    const rev = revRows[0];
    const site = await siteInfo(s, system, plan.site_id);
    const rule = await holidayRule(tx, plan.tenant_id, plan.site_id);
    const leadMs = rev.lead_days * DAY;
    const from = new Date(Math.max(plan.generate_from.getTime(), plan.last_occurrence_due_at ? plan.last_occurrence_due_at.getTime() + 1 : 0));
    const to = new Date(now.getTime() + leadMs + 1);
    const due = withinEffective(occurrencesBetween(rev.trigger, site.timezone, rule, from, to, 1000), rev);
    const nextAfter = (after: Date) => withinEffective(nextOccurrences(rev.trigger, site.timezone, rule, after, 1), rev)[0];

    if (due.length > 0) {
      const procedureCheck = await issuableRevision(tx, plan.tenant_id, rev.procedure_revision_id, plan.site_id).then(
        () => null,
        (err: Error) => err.message,
      );
      if (procedureCheck) {
        sum.issues.push({ plan_id: plan.id, issue: 'procedure' });
        await recordIssue(tx, plan.id, `Procedure revision cannot be issued: ${procedureCheck}. Publish a new plan revision.`, now, new Date(now.getTime() + 3600_000));
        return;
      }
    }

    const settings = await loadSiteSettings(tx, plan.tenant_id, plan.site_id);
    const expected = expectedPartsOf(rev.expected_parts);
    const shortage = await shortageText(tx, plan.tenant_id, plan.site_id, expected);
    if (shortage) sum.issues.push({ plan_id: plan.id, issue: 'shortage' });
    const { rows: openOverdue } = await tx.query(
      `SELECT w.id FROM maintenance.work_order w JOIN maintenance.pm_occurrence o ON o.work_order_id = w.id
        WHERE o.plan_id = $1 AND o.asset_id = $2 AND w.state = ANY($3::text[]) AND w.due_at < $4 LIMIT 1`,
      [plan.id, plan.asset_id, OPEN_STATES, now],
    );
    let overdueOpen = openOverdue.length > 0;
    const overdueAtGeneration = due.filter((o) => o.dueAt < now);
    const latestOverdue = overdueAtGeneration.at(-1);

    for (const o of due) {
      let status: 'issued' | 'missed' | 'skipped_open_overdue' | 'blocked_asset' | 'blocked_shortage' = 'issued';
      let reason: string | null = null;
      if (asset.lifecycle !== 'active') {
        status = 'blocked_asset';
        reason = `Asset is ${asset.lifecycle}`;
      } else if (shortage && settings.pm_block_on_shortage) {
        status = 'blocked_shortage';
        reason = shortage;
      } else if (overdueOpen) {
        status = 'skipped_open_overdue';
        reason = 'An earlier occurrence of this plan is still open and overdue';
      } else if (o.dueAt < now && o !== latestOverdue) {
        status = 'missed';
        reason = 'Missed while generation was not running; only the latest overdue occurrence is issued';
      }
      const occId = await insertOccurrence(tx, plan, rev.id, o, status, reason, workerId);
      if (!occId) continue;
      if (status !== 'issued') {
        if (status === 'blocked_asset' || status === 'blocked_shortage') sum.blocked++;
        else if (status === 'missed') sum.missed++;
        else sum.skipped++;
        continue;
      }
      const wo = await insertWorkOrder(tx, s, system, {
        siteId: plan.site_id,
        type: 'preventive',
        priority: rev.priority,
        title: rev.title,
        description: `Generated from plan "${plan.title}" revision ${rev.revision_no} for ${o.dueDate}.`,
        scope: rev.scope,
        asset,
        nonAssetCategory: null,
        nonAssetJustification: null,
        locationText: asset.location,
        teamId: rev.team_id,
        assigneeId: null,
        plannedStart: o.dueAt,
        plannedEnd: new Date(o.dueAt.getTime() + rev.estimated_minutes * 60_000),
        dueAt: o.dueAt,
        procedureRevisionId: rev.procedure_revision_id,
        safetyInstructions: null,
        sourceRequestId: null,
        planOccurrenceId: occId,
        followUpOfId: null,
        initialState: settings.pm_initial_state,
        creationReason: `PM plan ${plan.id} revision ${rev.revision_no}, occurrence ${o.key}`,
      });
      await tx.query(`UPDATE maintenance.pm_occurrence SET status = 'issued', reason = NULL, work_order_id = $2 WHERE id = $1`, [occId, wo.id]);
      await enqueueEvent(tx, system, {
        siteId: plan.site_id,
        type: 'maintenance.plan.occurrence_due',
        aggregateType: 'pm_occurrence',
        aggregateId: occId,
        aggregateVersion: 1,
        occurredAt: now,
        payload: { plan_id: plan.id, occurrence_key: o.key, due_at: o.dueAt.toISOString(), work_order_id: wo.id, display_number: wo.display_number },
      });
      if (wo.state === 'ready') {
        await enqueueEvent(tx, system, {
          siteId: plan.site_id,
          type: 'maintenance.work_order.state_changed',
          aggregateType: 'work_order',
          aggregateId: wo.id,
          aggregateVersion: 1,
          occurredAt: now,
          payload: { work_order_id: wo.id, display_number: wo.display_number, title: wo.title, from: null, to: 'ready', action: 'create', assignee_id: null, team_id: wo.team_id, source_request_id: null },
        });
      }
      sum.issued++;
      if (o.dueAt < now) overdueOpen = true;
    }

    const lastDue = due.at(-1)?.dueAt ?? plan.last_occurrence_due_at;
    const next = nextAfter(new Date(Math.max(to.getTime(), lastDue ? lastDue.getTime() + 1 : 0)));
    await tx.query(
      `UPDATE maintenance.pm_plan SET last_occurrence_due_at = $2, next_generate_at = $3, last_generation_issue = $4, last_generation_issue_at = $5 WHERE id = $1`,
      [plan.id, lastDue, next ? new Date(next.dueAt.getTime() - leadMs) : null, shortage, shortage ? now : null],
    );
  });
}

/** One scheduler pass. Safe to run concurrently on several workers. */
export async function runPmScheduler(s: Services, workerId: string, opts: { tenantId?: string; limit?: number } = {}): Promise<SchedulerSummary> {
  const sum: SchedulerSummary = { plans: 0, issued: 0, missed: 0, skipped: 0, blocked: 0, issues: [] };
  const now = s.clock.now();
  const { rows } = await s.db.query(
    `SELECT id, tenant_id, asset_id FROM maintenance.pm_plan
      WHERE status = 'active' AND trigger_kind = 'calendar' AND current_revision_id IS NOT NULL AND (next_generate_at IS NULL OR next_generate_at <= $1)
        AND ($2::uuid IS NULL OR tenant_id = $2) ORDER BY next_generate_at NULLS FIRST LIMIT $3`,
    [now, opts.tenantId ?? null, opts.limit ?? 200],
  );
  for (const r of rows) {
    const system: AnyActor = { kind: 'system', tenantId: r.tenant_id, label: `pm-scheduler:${workerId}`, correlationId: randomUUID() };
    let asset: AssetIdentity | null = null;
    let assetError: string | null = null;
    try {
      asset = await resolveAsset(s, system, r.asset_id);
    } catch (err) {
      assetError = err instanceof AppError ? err.message : 'Asset identity unavailable';
    }
    await generateForPlan(s, workerId, r.id, asset, assetError, sum);
  }
  return sum;
}

