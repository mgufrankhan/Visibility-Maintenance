import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction, type Queryable } from '@vm/db';
import type { createMeterRequest, manualMeterReadingRequest, meterBaselineRequest } from '@vm/contracts';
import { can, OPEN_STATES, sitesWith } from '@vm/policy';
import { AppError, conflict, invalid, notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import type { Actor, Services, SystemActor } from './context.ts';
import { identitySnapshot, resolveAsset, type AssetIdentity } from './identity-snapshots.ts';
import { expectedPartsOf, shortageText } from './parts-coverage.ts';
import { issuableRevision } from './procedures.ts';
import { enqueueEvent, iso, writeAudit } from './records.ts';
import { loadSiteSettings } from './settings.ts';
import { insertWorkOrder } from './work-orders.ts';

export interface MeterTrigger {
  type: 'meter';
  interval: number;
  lead_usage: number;
  due_days: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function meterDto(m: Record<string, any>, now: Date) {
  const lastObserved = m.last_observed_at as Date | null;
  const stale = !lastObserved || now.getTime() - lastObserved.getTime() > m.freshness_seconds * 1000;
  return {
    id: m.id,
    site_id: m.site_id,
    asset_id: m.asset_id,
    asset_snapshot: m.asset_snapshot,
    signal_key: m.signal_key,
    name: m.name,
    unit: m.unit,
    freshness_seconds: m.freshness_seconds,
    status: m.status,
    issue: m.issue,
    usage: num(m.last_usage),
    last_raw: num(m.last_raw),
    last_observed_at: iso(lastObserved),
    last_source: m.last_source,
    stale,
    version: m.version,
  };
}

async function loadMeter(db: Queryable, actor: Actor, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM maintenance.meter WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const m = rows[0];
  if (!m || !can(actor.principal, 'maintenance.view', m.site_id)) throw notFound('Meter');
  return m;
}

export async function createMeter(s: Services, actor: Actor, input: z.infer<typeof createMeterRequest>) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.plan.manage', input.site_id);
  const asset = await resolveAsset(s, actor, input.asset_id);
  if (asset.site_id !== input.site_id) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    try {
      const { rows } = await tx.query(
        `INSERT INTO maintenance.meter (id, tenant_id, site_id, asset_id, asset_snapshot, signal_key, name, unit, freshness_seconds, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, p.tenantId, input.site_id, asset.asset_id, JSON.stringify(identitySnapshot(asset)), input.signal_key, input.name, input.unit, input.freshness_seconds, p.userId],
      );
      await writeAudit(tx, actor, { siteId: input.site_id, action: 'meter.created', targetType: 'meter', targetId: id, afterVersion: 1, detail: { signal_key: input.signal_key, unit: input.unit } });
      return meterDto(rows[0], s.clock.now());
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('duplicate_meter', 'This asset already has a meter for the signal');
      throw err;
    }
  });
}

export async function listMeters(s: Services, actor: Actor, q: { site_id?: string; asset_id?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  let where = 'tenant_id = $1 AND site_id = ANY($2::uuid[])';
  if (q.asset_id) where += ` AND asset_id::text = $${params.push(q.asset_id)}`;
  const { rows } = await s.db.query(`SELECT * FROM maintenance.meter WHERE ${where} ORDER BY name, id LIMIT 500`, params);
  const now = s.clock.now();
  return rows.map((m) => meterDto(m, now));
}

export async function getMeter(s: Services, actor: Actor, id: string) {
  const m = await loadMeter(s.db, actor, id);
  const [readings, baselines] = await Promise.all([
    s.db.query(`SELECT id, raw_value, usage, observed_at, source, receipt_id, entered_by, status, reason FROM maintenance.meter_reading WHERE meter_id = $1 ORDER BY observed_at DESC, created_at DESC LIMIT 100`, [m.id]),
    s.db.query(`SELECT id, kind, previous_raw, usage_at_change, new_raw, reason, recorded_by, recorded_at FROM maintenance.meter_baseline WHERE meter_id = $1 ORDER BY recorded_at DESC`, [m.id]),
  ]);
  return {
    ...meterDto(m, s.clock.now()),
    readings: readings.rows.map((r) => ({ ...r, raw_value: num(r.raw_value), usage: num(r.usage), observed_at: iso(r.observed_at) })),
    baselines: baselines.rows.map((b) => ({ ...b, previous_raw: num(b.previous_raw), usage_at_change: num(b.usage_at_change), new_raw: num(b.new_raw), recorded_at: iso(b.recorded_at) })),
  };
}

export interface MeterReadingInput {
  raw: number;
  observedAt: Date;
  source: 'connector' | 'manual';
  receiptId: string | null;
  enteredBy: string | null;
  clientEntryId: string | null;
  historical: boolean;
  /** Identity applying the reading; recorded on any cutover baseline it establishes. */
  actorId: string;
}

export type MeterReadingStatus = 'accepted' | 'rejected_decrease' | 'out_of_order' | 'historical';

/**
 * Applies one cumulative reading to a locked meter row. A decrease is never
 * counted as negative usage: it suspends the meter until an authorized reset
 * or replacement baseline is recorded (MP-04).
 */
export async function applyMeterReading(tx: Queryable, meter: Record<string, any>, r: MeterReadingInput, now: Date): Promise<{ id: string; status: MeterReadingStatus; usage: number | null }> {
  const lastRaw = num(meter.last_raw);
  const lastObserved = meter.last_observed_at as Date | null;
  let status: MeterReadingStatus = 'accepted';
  let reason: string | null = null;
  let usage: number | null = null;
  let rebaseline = false;
  if (r.historical) {
    status = 'historical';
    reason = 'Historical or replayed reading; does not advance usage';
  } else if (lastObserved && r.observedAt.getTime() <= lastObserved.getTime()) {
    status = 'out_of_order';
    reason = `Observed at or before the latest applied reading (${lastObserved.toISOString()})`;
  } else if (meter.rebaseline_cutover_id) {
    // Replacement source counts independently: continue usage from the recorded baseline.
    usage = num(meter.last_usage) ?? 0;
    rebaseline = true;
  } else if (meter.status === 'reset_suspected') {
    status = 'rejected_decrease';
    reason = 'Meter is awaiting an authorized reset or replacement record';
  } else if (lastRaw !== null && r.raw < lastRaw) {
    status = 'rejected_decrease';
    reason = `Reading ${r.raw} is below the previous reading ${lastRaw}; record an authorized reset or replacement`;
  } else {
    const start = num(meter.segment_start_raw) ?? r.raw;
    const offset = meter.segment_start_raw === null ? r.raw : Number(meter.segment_offset);
    usage = offset + (r.raw - start);
  }
  const id = randomUUID();
  await tx.query(
    `INSERT INTO maintenance.meter_reading (id, tenant_id, meter_id, raw_value, usage, observed_at, source, receipt_id, client_entry_id, entered_by, status, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, meter.tenant_id, meter.id, r.raw, usage, r.observedAt, r.source, r.receiptId, r.clientEntryId, r.enteredBy, status, reason, now],
  );
  if (rebaseline) {
    await tx.query(
      `INSERT INTO maintenance.meter_baseline (id, tenant_id, meter_id, kind, previous_raw, usage_at_change, new_raw, reason, recorded_by, recorded_at)
       VALUES ($1,$2,$3,'source_cutover',$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), meter.tenant_id, meter.id, lastRaw, usage, r.raw, `Source cutover ${meter.rebaseline_cutover_id}: new counter segment from the replacement source`, r.actorId, now],
    );
    await tx.query(
      `UPDATE maintenance.meter SET segment_offset = $3, segment_start_raw = $2, last_raw = $2, last_usage = $3, last_observed_at = $4, last_source = $5,
         status = 'ok', issue = NULL, rebaseline_cutover_id = NULL, version = version + 1 WHERE id = $1`,
      [meter.id, r.raw, usage, r.observedAt, r.source],
    );
  } else if (status === 'accepted') {
    await tx.query(
      `UPDATE maintenance.meter SET last_raw = $2, last_usage = $3, last_observed_at = $4, last_source = $5, status = 'ok', issue = NULL,
         segment_start_raw = coalesce(segment_start_raw, $2), segment_offset = CASE WHEN segment_start_raw IS NULL THEN $2 ELSE segment_offset END,
         version = version + 1 WHERE id = $1`,
      [meter.id, r.raw, usage, r.observedAt, r.source],
    );
  } else if (status === 'rejected_decrease' && meter.status !== 'reset_suspected') {
    await tx.query(`UPDATE maintenance.meter SET status = 'reset_suspected', issue = $2, version = version + 1 WHERE id = $1`, [meter.id, reason]);
  }
  return { id, status, usage };
}

/** Manual readings carry manual provenance and never appear as streamed telemetry. */
export async function recordManualReading(s: Services, actor: Actor, meterId: string, input: z.infer<typeof manualMeterReadingRequest>) {
  const p = actor.principal;
  const observedAt = new Date(input.observed_at);
  const now = s.clock.now();
  if (observedAt.getTime() > now.getTime() + 5 * 60_000) throw invalid('Reading time is in the future', { observed_at: ['Cannot be in the future'] });
  return withTransaction(s.db, async (tx) => {
    const m = await loadMeter(tx, actor, meterId, true);
    requirePermission(p, 'maintenance.inspection.execute', m.site_id);
    if (input.client_entry_id) {
      const { rows } = await tx.query(`SELECT id, status, usage FROM maintenance.meter_reading WHERE meter_id = $1 AND entered_by = $2 AND client_entry_id = $3`, [m.id, p.userId, input.client_entry_id]);
      if (rows[0]) return { reading_id: rows[0].id, status: rows[0].status, usage: num(rows[0].usage), replayed: true };
    }
    const r = await applyMeterReading(tx, m, { raw: input.value, observedAt, source: 'manual', receiptId: null, enteredBy: p.userId, clientEntryId: input.client_entry_id, historical: false, actorId: p.userId }, now);
    await writeAudit(tx, actor, { siteId: m.site_id, action: 'meter.reading_recorded', targetType: 'meter', targetId: m.id, detail: { reading_id: r.id, status: r.status, value: input.value } });
    return { reading_id: r.id, status: r.status, usage: r.usage, replayed: false };
  });
}

/** Authorized reset/replacement: starts a new segment so usage continues without a negative step. */
export async function recordMeterBaseline(s: Services, actor: Actor, meterId: string, input: z.infer<typeof meterBaselineRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const m = await loadMeter(tx, actor, meterId, true);
    requirePermission(p, 'maintenance.plan.manage', m.site_id);
    if (m.version !== input.record_version) throw staleVersion(m.version);
    const usageAtChange = num(m.last_usage) ?? 0;
    const now = s.clock.now();
    await tx.query(
      `INSERT INTO maintenance.meter_baseline (id, tenant_id, meter_id, kind, previous_raw, usage_at_change, new_raw, reason, recorded_by, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), p.tenantId, m.id, input.kind, m.last_raw, usageAtChange, input.new_raw, input.reason, p.userId, now],
    );
    const { rows } = await tx.query(
      `UPDATE maintenance.meter SET segment_offset = $2, segment_start_raw = $3, last_raw = $3, last_usage = $2, status = 'ok', issue = NULL, version = version + 1
        WHERE id = $1 RETURNING *`,
      [m.id, usageAtChange, input.new_raw],
    );
    await writeAudit(tx, actor, { siteId: m.site_id, action: `meter.${input.kind}`, targetType: 'meter', targetId: m.id, beforeVersion: m.version, afterVersion: m.version + 1, reason: input.reason, detail: { previous_raw: num(m.last_raw), new_raw: input.new_raw, usage_at_change: usageAtChange } });
    return meterDto(rows[0], now);
  });
}

// ---------- Usage-based PM ----------

export interface MeterSchedulerSummary {
  plans: number;
  issued: number;
  overruns: number;
  suspended: number;
  issues: Array<{ plan_id: string; issue: string }>;
}

async function planIssue(db: Queryable, planId: string, issue: string | null, now: Date): Promise<void> {
  await db.query(`UPDATE maintenance.pm_plan SET last_generation_issue = $2, last_generation_issue_at = $3 WHERE id = $1`, [planId, issue, issue ? now : null]);
}

/** Validated usage at or before an instant, used as the approved completion meter. */
async function usageAt(db: Queryable, meterId: string, at: Date): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT usage FROM maintenance.meter_reading WHERE meter_id = $1 AND status = 'accepted' AND observed_at <= $2 ORDER BY observed_at DESC LIMIT 1`,
    [meterId, at],
  );
  return rows[0] ? Number(rows[0].usage) : null;
}

async function generateMeterPlan(s: Services, workerId: string, planId: string, asset: AssetIdentity | null, assetError: string | null, sum: MeterSchedulerSummary): Promise<void> {
  await withTransaction(s.db, async (tx: PoolClient) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.pm_plan WHERE id = $1 AND status = 'active' AND trigger_kind = 'meter' FOR UPDATE SKIP LOCKED`, [planId]);
    const plan = rows[0];
    if (!plan || !plan.current_revision_id) return;
    sum.plans++;
    const now = s.clock.now();
    const system: SystemActor = { kind: 'system', tenantId: plan.tenant_id, label: `meter-pm:${workerId}`, correlationId: randomUUID() };
    const { rows: revRows } = await tx.query(`SELECT * FROM maintenance.pm_plan_revision WHERE id = $1`, [plan.current_revision_id]);
    const rev = revRows[0];
    const trigger = rev.trigger as MeterTrigger;
    const { rows: meterRows } = await tx.query(`SELECT * FROM maintenance.meter WHERE id = $1`, [plan.meter_id]);
    const meter = meterRows[0];
    let nextThreshold = num(plan.meter_next_threshold);

    // An approved (closed) order's completion meter sets the next threshold.
    const { rows: closedOcc } = await tx.query(
      `SELECT o.id, o.threshold, w.closed_at FROM maintenance.pm_occurrence o JOIN maintenance.work_order w ON w.id = o.work_order_id
        WHERE o.plan_id = $1 AND o.completion_usage IS NULL AND o.threshold IS NOT NULL AND w.state = 'closed' ORDER BY w.closed_at`,
      [plan.id],
    );
    for (const o of closedOcc) {
      const completion = (await usageAt(tx, meter.id, o.closed_at)) ?? Number(o.threshold);
      await tx.query(`UPDATE maintenance.pm_occurrence SET completion_usage = $2 WHERE id = $1`, [o.id, completion]);
      nextThreshold = completion + trigger.interval;
    }

    const suspend = async (issue: string) => {
      sum.suspended++;
      sum.issues.push({ plan_id: plan.id, issue });
      await tx.query(`UPDATE maintenance.pm_plan SET meter_next_threshold = $2 WHERE id = $1`, [plan.id, nextThreshold]);
      await planIssue(tx, plan.id, issue, now);
    };
    if (!(await s.entitlements.has(plan.tenant_id, 'core.generate_pm'))) return suspend('PM generation is blocked by the current license state');
    if (!asset) return suspend(assetError ?? 'Asset identity unavailable');
    if (asset.lifecycle !== 'active') return suspend(`Asset is ${asset.lifecycle}`);
    if (meter.status === 'awaiting_reading') return suspend('Usage-based generation suspended: the meter has no validated reading');
    if (meter.status === 'reset_suspected') return suspend(`Usage-based generation suspended: ${meter.issue}`);
    const lastObserved = meter.last_observed_at as Date;
    if (now.getTime() - lastObserved.getTime() > meter.freshness_seconds * 1000) {
      return suspend(`Usage-based generation suspended: meter reading is stale (last validated reading ${lastObserved.toISOString()})`);
    }
    const usage = Number(meter.last_usage);
    if (nextThreshold === null) nextThreshold = usage + trigger.interval;

    const { rows: open } = await tx.query(
      `SELECT o.id, o.threshold FROM maintenance.pm_occurrence o JOIN maintenance.work_order w ON w.id = o.work_order_id
        WHERE o.plan_id = $1 AND w.state = ANY($2::text[]) ORDER BY o.due_at DESC LIMIT 1`,
      [plan.id, OPEN_STATES],
    );
    if (open[0]) {
      // MP: repeated crossings during an open occurrence flag overdue usage instead of issuing more orders.
      if (open[0].threshold !== null && usage >= Number(open[0].threshold)) {
        const { rowCount } = await tx.query(
          `UPDATE maintenance.pm_occurrence SET usage_overrun_at = coalesce(usage_overrun_at, $2), usage_overrun_value = $3 WHERE id = $1 AND usage_overrun_value IS DISTINCT FROM $3`,
          [open[0].id, now, usage],
        );
        if (rowCount) sum.overruns++;
      }
    } else if (usage >= nextThreshold - trigger.lead_usage) {
        const procedureCheck = await issuableRevision(tx, plan.tenant_id, rev.procedure_revision_id, plan.site_id).then(
          () => null,
          (err: Error) => err.message,
        );
        if (procedureCheck) return suspend(`Procedure revision cannot be issued: ${procedureCheck}. Publish a new plan revision.`);
        const key = `meter:${nextThreshold}`;
        const occId = randomUUID();
        const dueAt = new Date(now.getTime() + trigger.due_days * 86_400_000);
        const { rows: ins } = await tx.query(
          `INSERT INTO maintenance.pm_occurrence (id, tenant_id, site_id, plan_id, plan_revision_id, asset_id, occurrence_key, due_at, status, threshold, generated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) ON CONFLICT (tenant_id, plan_id, asset_id, occurrence_key) DO NOTHING RETURNING id`,
          [occId, plan.tenant_id, plan.site_id, plan.id, rev.id, plan.asset_id, key, dueAt, nextThreshold, workerId],
        );
        if (ins[0]) {
          const settings = await loadSiteSettings(tx, plan.tenant_id, plan.site_id);
          const shortage = await shortageText(tx, plan.tenant_id, plan.site_id, expectedPartsOf(rev.expected_parts));
          if (shortage && settings.pm_block_on_shortage) {
            await tx.query(`UPDATE maintenance.pm_occurrence SET status = 'blocked_shortage', reason = $2 WHERE id = $1`, [ins[0].id, shortage]);
            sum.issues.push({ plan_id: plan.id, issue: 'shortage' });
          } else {
          if (shortage) sum.issues.push({ plan_id: plan.id, issue: 'shortage' });
          const wo = await insertWorkOrder(tx, s, system, {
            siteId: plan.site_id,
            type: 'preventive',
            priority: rev.priority,
            title: rev.title,
            description: `Generated from usage plan "${plan.title}" revision ${rev.revision_no}: meter ${meter.name} reached ${usage} ${meter.unit} (threshold ${nextThreshold}).`,
            scope: rev.scope,
            asset,
            nonAssetCategory: null,
            nonAssetJustification: null,
            locationText: asset.location,
            teamId: rev.team_id,
            assigneeId: null,
            plannedStart: now,
            plannedEnd: new Date(now.getTime() + rev.estimated_minutes * 60_000),
            dueAt,
            procedureRevisionId: rev.procedure_revision_id,
            safetyInstructions: null,
            sourceRequestId: null,
            planOccurrenceId: occId,
            followUpOfId: null,
            initialState: settings.pm_initial_state,
            creationReason: `PM plan ${plan.id} revision ${rev.revision_no}, usage threshold ${nextThreshold} ${meter.unit}`,
          });
          await tx.query(`UPDATE maintenance.pm_occurrence SET status = 'issued', work_order_id = $2 WHERE id = $1`, [occId, wo.id]);
          await enqueueEvent(tx, system, {
            siteId: plan.site_id,
            type: 'maintenance.plan.occurrence_due',
            aggregateType: 'pm_occurrence',
            aggregateId: occId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { plan_id: plan.id, occurrence_key: key, due_at: dueAt.toISOString(), work_order_id: wo.id, display_number: wo.display_number, meter_usage: usage, threshold: nextThreshold },
          });
          sum.issued++;
          }
        }
      // Provisional until the order's completion meter is approved.
      nextThreshold = nextThreshold + trigger.interval;
    }
    await tx.query(`UPDATE maintenance.pm_plan SET meter_next_threshold = $2 WHERE id = $1`, [plan.id, nextThreshold]);
    const shortage = await shortageText(tx, plan.tenant_id, plan.site_id, expectedPartsOf(rev.expected_parts));
    await planIssue(tx, plan.id, shortage, now);
  });
}

/** One usage-based PM pass; safe under retries and concurrent workers (occurrence key uniqueness). */
export async function runMeterPlans(s: Services, workerId: string, opts: { tenantId?: string; limit?: number } = {}): Promise<MeterSchedulerSummary> {
  const sum: MeterSchedulerSummary = { plans: 0, issued: 0, overruns: 0, suspended: 0, issues: [] };
  const { rows } = await s.db.query(
    `SELECT id, tenant_id, asset_id FROM maintenance.pm_plan
      WHERE status = 'active' AND trigger_kind = 'meter' AND current_revision_id IS NOT NULL AND ($1::uuid IS NULL OR tenant_id = $1)
      ORDER BY id LIMIT $2`,
    [opts.tenantId ?? null, opts.limit ?? 500],
  );
  for (const r of rows) {
    const system: SystemActor = { kind: 'system', tenantId: r.tenant_id, label: `meter-pm:${workerId}`, correlationId: randomUUID() };
    let asset: AssetIdentity | null = null;
    let assetError: string | null = null;
    try {
      asset = await resolveAsset(s, system, r.asset_id);
    } catch (err) {
      assetError = err instanceof AppError ? err.message : 'Asset identity unavailable';
    }
    await generateMeterPlan(s, workerId, r.id, asset, assetError, sum);
  }
  return sum;
}
