import { OPEN_STATES } from '@vm/policy';
import { invalid } from '@vm/server-kit';
import { requirePermission } from './access.ts';
import type { Actor, Services } from './context.ts';
import { siteInfo } from './identity-snapshots.ts';
import { exposureInPeriod, mtbf, mttr, repeatFaults, unionHours, type ExposureRecord } from './kpi.ts';
import { iso } from './records.ts';
import { loadSiteSettings } from './settings.ts';

export const REPORT_METRICS = ['failure_count', 'mtbf', 'mttr', 'mtta', 'downtime', 'overdue_backlog', 'pm_compliance', 'repeat_faults', 'maintenance_cost'] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export interface ReportQuery {
  site_id: string;
  from: string;
  to: string;
  asset_id?: string;
}

export interface MultiSiteReportQuery {
  site_ids: string[];
  from: string;
  to: string;
  asset_id?: string;
}

interface Scope {
  tenantId: string;
  siteId: string;
  from: Date;
  to: Date;
  assetId: string | null;
}

const QUALIFYING = `classification = 'unplanned_failure' AND validated`;

async function qualifyingFailures(s: Services, sc: Scope) {
  const { rows } = await s.db.query(
    `SELECT id, asset_id, asset_snapshot, started_at, restored_at, failure_code FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND ${QUALIFYING} AND ($3::uuid IS NULL OR asset_id = $3)
        AND started_at >= $4 AND started_at < $5 ORDER BY started_at`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  return rows;
}

async function assetsInScope(s: Services, sc: Scope): Promise<Array<{ asset_id: string; code: string; name: string }>> {
  const { rows } = await s.db.query(
    `SELECT asset_id, code, name FROM maintenance.asset_snapshot WHERE tenant_id = $1 AND site_id = $2 AND ($3::uuid IS NULL OR asset_id = $3) AND lifecycle <> 'tombstoned' ORDER BY code`,
    [sc.tenantId, sc.siteId, sc.assetId],
  );
  return rows;
}

async function failureCount(s: Services, sc: Scope) {
  const failures = await qualifyingFailures(s, sc);
  const { rows: excluded } = await s.db.query(
    `SELECT classification, validated, count(*)::int AS n FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND ($3::uuid IS NULL OR asset_id = $3) AND started_at >= $4 AND started_at < $5 AND NOT (${QUALIFYING})
      GROUP BY 1, 2`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  return {
    value: failures.length,
    source_records: failures.map((f) => ({ type: 'failure_event', id: f.id })),
    exclusions: excluded.map((e) => ({ reason: e.validated ? `classified ${e.classification}` : 'not validated', classification: e.classification, count: e.n })),
  };
}

async function mtbfReport(s: Services, sc: Scope) {
  const assets = await assetsInScope(s, sc);
  const failures = await qualifyingFailures(s, sc);
  const { rows: exp } = await s.db.query<ExposureRecord & { asset_id: string; id: string }>(
    `SELECT id, asset_id, period_start, period_end, hours::float8 AS hours, basis FROM maintenance.operating_exposure
      WHERE tenant_id = $1 AND site_id = $2 AND ($3::uuid IS NULL OR asset_id = $3) AND period_start < $5 AND period_end > $4`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  const items = assets.map((a) => {
    const f = failures.filter((x) => x.asset_id === a.asset_id);
    const e = exp.filter((x) => x.asset_id === a.asset_id);
    return { asset_id: a.asset_id, asset_code: a.code, ...mtbf(exposureInPeriod(e, sc.from, sc.to), f.length), failure_ids: f.map((x) => x.id), exposure_ids: e.map((x) => x.id) };
  });
  const missing = items.filter((i) => i.status === 'unavailable_no_exposure').length;
  return { items, coverage: { assets: items.length, assets_with_exposure: items.length - missing, assets_missing_exposure: missing } };
}

async function mttrReport(s: Services, sc: Scope) {
  const { rows: restored } = await s.db.query(
    `SELECT f.id, f.asset_id, f.started_at, f.restored_at,
            (SELECT coalesce(sum(l.duration_minutes), 0)::int FROM maintenance.labor_entry l JOIN maintenance.order_failure_link k ON k.work_order_id = l.work_order_id
              WHERE k.failure_event_id = f.id AND NOT EXISTS (SELECT 1 FROM maintenance.labor_entry x WHERE x.amends_entry_id = l.id)) AS labor_minutes
       FROM maintenance.failure_event f
      WHERE f.tenant_id = $1 AND f.site_id = $2 AND ${QUALIFYING} AND ($3::uuid IS NULL OR f.asset_id = $3) AND f.restored_at >= $4 AND f.restored_at < $5`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  const { rows: open } = await s.db.query(
    `SELECT id, asset_id, started_at FROM maintenance.failure_event WHERE tenant_id = $1 AND site_id = $2 AND ${QUALIFYING} AND ($3::uuid IS NULL OR asset_id = $3) AND restored_at IS NULL AND started_at < $4`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.to],
  );
  const result = mttr(restored.map((r) => ({ start: r.started_at, end: r.restored_at })));
  return {
    cohort: 'qualifying failures restored within the period',
    ...result,
    active_repair_labor_hours: Math.round((restored.reduce((a, r) => a + r.labor_minutes, 0) / 60) * 100) / 100,
    open_failures: open.map((o) => ({ id: o.id, asset_id: o.asset_id, started_at: iso(o.started_at) })),
    source_records: restored.map((r) => ({ type: 'failure_event', id: r.id })),
  };
}

async function mttaReport(s: Services, sc: Scope) {
  const asset = sc.assetId;
  const { rows: accepted } = await s.db.query(
    `SELECT id, created_at, triaged_at FROM maintenance.request
      WHERE tenant_id = $1 AND site_id = $2 AND state = 'accepted' AND triaged_at >= $3 AND triaged_at < $4
        AND ($5::uuid IS NULL OR asset_id = $5)
      ORDER BY triaged_at, id`,
    [sc.tenantId, sc.siteId, sc.from, sc.to, asset],
  );
  const { rows: rejected } = await s.db.query(
    `SELECT count(*)::int AS n FROM maintenance.request
      WHERE tenant_id = $1 AND site_id = $2 AND state = 'rejected' AND triaged_at >= $3 AND triaged_at < $4
        AND ($5::uuid IS NULL OR asset_id = $5)`,
    [sc.tenantId, sc.siteId, sc.from, sc.to, asset],
  );
  const { rows: open } = await s.db.query(
    `SELECT id, state, created_at FROM maintenance.request
      WHERE tenant_id = $1 AND site_id = $2 AND state IN ('submitted', 'under_review') AND created_at >= $3 AND created_at < $4
        AND ($5::uuid IS NULL OR asset_id = $5)
      ORDER BY created_at, id`,
    [sc.tenantId, sc.siteId, sc.from, sc.to, asset],
  );
  const hours = accepted.map((row) => (new Date(row.triaged_at).getTime() - new Date(row.created_at).getTime()) / 3_600_000);
  const average = hours.length ? Math.round((hours.reduce((sum, value) => sum + value, 0) / hours.length) * 100) / 100 : null;
  return {
    cohort: 'requests accepted within the period',
    average_hours: average,
    accepted_count: accepted.length,
    rejected_count: rejected[0]?.n ?? 0,
    open_requests: open.map((row) => ({ id: row.id, state: row.state, submitted_at: iso(row.created_at) })),
    source_records: accepted.map((row) => ({ type: 'request', id: row.id })),
  };
}

async function downtimeReport(s: Services, sc: Scope) {
  const now = s.clock.now();
  const { rows } = await s.db.query(
    `SELECT id, asset_id, started_at, restored_at, classification FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND validated AND ($3::uuid IS NULL OR asset_id = $3)
        AND started_at < $5 AND coalesce(restored_at, 'infinity') > $4`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  const end = (r: Record<string, any>) => r.restored_at ?? new Date(Math.min(now.getTime(), sc.to.getTime()));
  const byAsset = new Map<string, typeof rows>();
  for (const r of rows) byAsset.set(r.asset_id, [...(byAsset.get(r.asset_id) ?? []), r]);
  const items = [...byAsset.entries()].map(([assetId, list]) => {
    const hours = (filter: (r: Record<string, any>) => boolean) => Math.round(unionHours(list.filter(filter).map((r) => ({ start: r.started_at, end: end(r) })), sc.from, sc.to) * 100) / 100;
    return {
      asset_id: assetId,
      unplanned_hours: hours((r) => r.classification === 'unplanned_failure'),
      planned_hours: hours((r) => r.classification === 'planned_stop'),
      other_hours: hours((r) => !['unplanned_failure', 'planned_stop'].includes(r.classification)),
      open_events: list.filter((r) => !r.restored_at).length,
      event_ids: list.map((r) => r.id),
    };
  });
  const { rows: unvalidated } = await s.db.query(
    `SELECT count(*)::int AS n FROM maintenance.failure_event WHERE tenant_id = $1 AND site_id = $2 AND NOT validated AND ($3::uuid IS NULL OR asset_id = $3) AND started_at < $5 AND coalesce(restored_at, 'infinity') > $4`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  return { items, exclusions: [{ reason: 'not validated', count: unvalidated[0]!.n }], note: 'Overlapping intervals are merged per asset and clipped to the period; open events run to the earlier of now and the period end.' };
}

async function overdueBacklog(s: Services, sc: Scope) {
  const now = s.clock.now();
  const { rows } = await s.db.query(
    `SELECT id, display_number, title, priority, team_id, asset_id, due_at, state FROM maintenance.work_order
      WHERE tenant_id = $1 AND site_id = $2 AND ($3::uuid IS NULL OR asset_id = $3) AND state = ANY($4::text[]) AND due_at < $5 ORDER BY due_at`,
    [sc.tenantId, sc.siteId, sc.assetId, OPEN_STATES, now],
  );
  return {
    value: rows.length,
    as_of: now.toISOString(),
    items: rows.map((r) => ({ ...r, due_at: iso(r.due_at), age_hours: Math.round(((now.getTime() - r.due_at.getTime()) / 3_600_000) * 10) / 10 })),
  };
}

function occurrenceLine(r: Record<string, any>) {
  return {
    occurrence_id: r.id,
    key: r.occurrence_key,
    original_due_at: iso(r.due_at),
    status: r.status,
    work_order_id: r.work_order_id,
    state: r.state,
    closed_at: iso(r.closed_at),
  };
}

function isApprovedExemption(r: Record<string, any>): boolean {
  return r.state === 'cancelled' && r.cancel_exemption === true;
}

async function pmCompliance(s: Services, sc: Scope) {
  const { rows } = await s.db.query(
    `SELECT o.id, o.occurrence_key, o.due_at, o.status, o.work_order_id, w.state, w.closed_at, w.cancel_exemption
       FROM maintenance.pm_occurrence o LEFT JOIN maintenance.work_order w ON w.id = o.work_order_id
      WHERE o.tenant_id = $1 AND o.site_id = $2 AND ($3::uuid IS NULL OR o.asset_id = $3) AND o.due_at >= $4 AND o.due_at < $5 AND o.status NOT IN ('blocked_asset', 'blocked_shortage')`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  const exempt = rows.filter(isApprovedExemption);
  const eligible = rows.filter((r) => !isApprovedExemption(r));
  const onTime = eligible.filter((r) => r.state === 'closed' && r.closed_at <= r.due_at);
  return {
    eligible: eligible.length,
    on_time: onTime.length,
    compliance_pct: eligible.length ? Math.round((onTime.length / eligible.length) * 1000) / 10 : null,
    not_issued: eligible.filter((r) => r.status !== 'issued').length,
    cancelled: eligible.filter((r) => r.state === 'cancelled').length,
    exemptions: exempt.length,
    note: 'Approved exemptions are left out of the eligible count. Other cancellations stay in the count.',
    items: eligible.map(occurrenceLine),
    exemption_items: exempt.map(occurrenceLine),
  };
}

async function repeatFaultReport(s: Services, sc: Scope) {
  const settings = await loadSiteSettings(s.db, sc.tenantId, sc.siteId);
  const failures = await qualifyingFailures(s, sc);
  return { window_days: settings.repeat_fault_window_days, ...repeatFaults(failures, settings.repeat_fault_window_days) };
}

async function maintenanceCost(s: Services, sc: Scope) {
  const { rows: labor } = await s.db.query(
    `SELECT l.currency, sum(l.duration_minutes * l.hourly_rate / 60.0)::float8 AS amount, count(*)::int AS entries, count(*) FILTER (WHERE l.hourly_rate IS NULL)::int AS unrated
       FROM maintenance.labor_entry l JOIN maintenance.work_order w ON w.id = l.work_order_id
      WHERE l.tenant_id = $1 AND l.site_id = $2 AND ($3::uuid IS NULL OR w.asset_id = $3) AND w.state = 'closed' AND w.closed_at >= $4 AND w.closed_at < $5
        AND NOT EXISTS (SELECT 1 FROM maintenance.labor_entry x WHERE x.amends_entry_id = l.id)
      GROUP BY l.currency`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  const { rows: external } = await s.db.query(
    `SELECT c.currency, sum(c.amount)::float8 AS amount FROM maintenance.external_service_cost c JOIN maintenance.work_order w ON w.id = c.work_order_id
      WHERE c.tenant_id = $1 AND c.site_id = $2 AND c.approved AND ($3::uuid IS NULL OR w.asset_id = $3) AND w.state = 'closed' AND w.closed_at >= $4 AND w.closed_at < $5 GROUP BY c.currency`,
    [sc.tenantId, sc.siteId, sc.assetId, sc.from, sc.to],
  );
  const { rows: parts } = await s.db.query(
    `SELECT m.currency, sum((-m.quantity) * coalesce(m.unit_cost, 0))::float8 AS amount, count(*)::int AS issues
       FROM maintenance.stock_movement m
      WHERE m.tenant_id = $1 AND m.site_id = $2 AND m.movement_type = 'issue' AND m.unit_cost IS NOT NULL
        AND m.created_at >= $3 AND m.created_at < $4
        AND ($5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM maintenance.work_order w WHERE w.id = m.work_order_id AND w.asset_id = $5
        ))
      GROUP BY m.currency`,
    [sc.tenantId, sc.siteId, sc.from, sc.to, sc.assetId],
  );
  const unrated = labor.reduce((a, l) => a + l.unrated, 0);
  return {
    basis: 'Approved labor at the rate in effect when work started, plus approved external service cost, plus issued parts with unit cost, for the period',
    labor: labor.filter((l) => l.currency).map((l) => ({ currency: l.currency, amount: Math.round(l.amount * 100) / 100 })),
    external_services: external.map((e) => ({ currency: e.currency, amount: e.amount })),
    parts: parts.filter((p) => p.currency).map((p) => ({ currency: p.currency, amount: Math.round(p.amount * 100) / 100, issue_count: p.issues })),
    coverage: { labor_entries_without_rate: unrated, parts: 'issued movements with unit_cost in the period' },
  };
}

export async function runReport(s: Services, actor: Actor, metric: ReportMetric, q: ReportQuery) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.report.view', q.site_id);
  if (metric === 'maintenance_cost') requirePermission(p, 'maintenance.cost.view', q.site_id);
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (!(to > from)) throw invalid('The period end must follow its start', { to: ['Must be after from'] });
  if (to.getTime() - from.getTime() > 3 * 366 * 86_400_000) throw invalid('Reports cover at most three years', { to: ['Period too long'] });
  const sc: Scope = { tenantId: p.tenantId, siteId: q.site_id, from, to, assetId: q.asset_id ?? null };
  const site = await siteInfo(s, actor, q.site_id);
  let data: Record<string, unknown>;
  switch (metric) {
    case 'failure_count':
      data = await failureCount(s, sc);
      break;
    case 'mtbf':
      data = await mtbfReport(s, sc);
      break;
    case 'mttr':
      data = await mttrReport(s, sc);
      break;
    case 'mtta':
      data = await mttaReport(s, sc);
      break;
    case 'downtime':
      data = await downtimeReport(s, sc);
      break;
    case 'overdue_backlog':
      data = await overdueBacklog(s, sc);
      break;
    case 'pm_compliance':
      data = await pmCompliance(s, sc);
      break;
    case 'repeat_faults':
      data = await repeatFaultReport(s, sc);
      break;
    case 'maintenance_cost':
      data = await maintenanceCost(s, sc);
      break;
    default: {
      const never: never = metric;
      throw new Error(`Unhandled metric ${String(never)}`);
    }
  }
  return {
    metric,
    period: { from: from.toISOString(), to: to.toISOString(), site_timezone: site.timezone },
    scope: { site_id: q.site_id, asset_id: q.asset_id ?? null },
    generated_at: s.clock.now().toISOString(),
    ...data,
  };
}

/** Runs the same metric for each permitted site and returns per-site results (R2 multi-site). */
export async function runMultiSiteReport(s: Services, actor: Actor, metric: ReportMetric, q: MultiSiteReportQuery) {
  if (!q.site_ids.length) throw invalid('At least one site_id is required', { site_ids: ['Required'] });
  if (q.site_ids.length > 50) throw invalid('At most 50 sites per multi-site report', { site_ids: ['Too many'] });
  const sites = [];
  for (const siteId of q.site_ids) {
    sites.push(await runReport(s, actor, metric, { site_id: siteId, from: q.from, to: q.to, asset_id: q.asset_id }));
  }
  return {
    metric,
    period: { from: q.from, to: q.to },
    scope: { site_ids: q.site_ids, asset_id: q.asset_id ?? null },
    generated_at: s.clock.now().toISOString(),
    sites,
  };
}
