import { can } from '@vm/policy';
import { invalid } from '@vm/server-kit';
import { requirePermission } from './access.ts';
import type { Actor, Services } from './context.ts';
import { writeAudit } from './records.ts';

export const EXPORT_DATASETS = ['work_orders', 'requests', 'downtime', 'labor', 'pm_occurrences', 'inspection_results'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/** Quotes every cell and neutralizes leading formula characters so spreadsheets never execute exported text. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

interface DatasetDef {
  columns: (costVisible: boolean) => string[];
  sql: (costVisible: boolean) => string;
}

const MAX_ROWS = 50_000;

const DATASETS: Record<ExportDataset, DatasetDef> = {
  work_orders: {
    columns: () => ['display_number', 'id', 'type', 'state', 'priority', 'title', 'asset_code', 'asset_id', 'team_id', 'assignee_id', 'due_at', 'created_at', 'closed_at', 'closure_outcome', 'failure_code', 'cause_code', 'corrective_action'],
    sql: () => `SELECT display_number, id, type, state, priority, title, asset_snapshot->>'code' AS asset_code, asset_id, team_id, assignee_id, due_at, created_at, closed_at, closure_outcome, failure_code, cause_code, corrective_action
                  FROM maintenance.work_order WHERE tenant_id = $1 AND site_id = $2 AND created_at >= $3 AND created_at < $4 ORDER BY created_at, id`,
  },
  requests: {
    columns: () => ['display_number', 'id', 'origin', 'state', 'proposed_priority', 'asset_code', 'asset_id', 'location_text', 'description', 'observed_at', 'created_at', 'linked_work_order_id', 'triage_reason'],
    sql: () => `SELECT display_number, id, origin, state, proposed_priority, asset_snapshot->>'code' AS asset_code, asset_id, location_text, description, observed_at, created_at, linked_work_order_id, triage_reason
                  FROM maintenance.request WHERE tenant_id = $1 AND site_id = $2 AND created_at >= $3 AND created_at < $4 ORDER BY created_at, id`,
  },
  downtime: {
    columns: () => ['id', 'asset_code', 'asset_id', 'started_at', 'restored_at', 'classification', 'validated', 'symptom', 'failure_code', 'production_impact', 'source', 'version'],
    sql: () => `SELECT id, asset_snapshot->>'code' AS asset_code, asset_id, started_at, restored_at, classification, validated, symptom, failure_code, production_impact, source, version
                  FROM maintenance.failure_event WHERE tenant_id = $1 AND site_id = $2 AND started_at >= $3 AND started_at < $4 ORDER BY started_at, id`,
  },
  labor: {
    columns: (cost) => ['id', 'work_order_id', 'person_id', 'started_at', 'ended_at', 'duration_minutes', 'note', 'amends_entry_id', 'amendment_reason', ...(cost ? ['hourly_rate', 'currency'] : [])],
    sql: (cost) => `SELECT id, work_order_id, person_id, started_at, ended_at, duration_minutes, note, amends_entry_id, amendment_reason${cost ? ', hourly_rate, currency' : ''}
                  FROM maintenance.labor_entry WHERE tenant_id = $1 AND site_id = $2 AND started_at >= $3 AND started_at < $4 ORDER BY started_at, id`,
  },
  pm_occurrences: {
    columns: () => ['id', 'plan_id', 'plan_revision_id', 'asset_id', 'occurrence_key', 'due_at', 'status', 'reason', 'work_order_id'],
    sql: () => `SELECT id, plan_id, plan_revision_id, asset_id, occurrence_key, due_at, status, reason, work_order_id
                  FROM maintenance.pm_occurrence WHERE tenant_id = $1 AND site_id = $2 AND due_at >= $3 AND due_at < $4 ORDER BY due_at, id`,
  },
  inspection_results: {
    columns: () => ['id', 'asset_id', 'template_revision_id', 'status', 'passed', 'submitted_by', 'observed_at', 'submitted_at', 'request_id', 'evaluation'],
    sql: () => `SELECT id, asset_id, template_revision_id, status, passed, submitted_by, observed_at, submitted_at, request_id, evaluation
                  FROM maintenance.inspection_result WHERE tenant_id = $1 AND site_id = $2 AND started_at >= $3 AND started_at < $4 ORDER BY started_at, id`,
  },
};

/** Exports apply the same site scope as reads; cost columns require cost.view (PRD §15). */
export async function exportDataset(s: Services, actor: Actor, dataset: ExportDataset, q: { site_id: string; from: string; to: string }) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.export', q.site_id);
  requirePermission(p, 'maintenance.view', q.site_id);
  await s.entitlements.require(p.tenantId, 'core.export');
  if (!(new Date(q.to) > new Date(q.from))) throw invalid('The period end must follow its start', { to: ['Must be after from'] });
  const cost = can(p, 'maintenance.cost.view', q.site_id);
  const def = DATASETS[dataset];
  const { rows } = await s.db.query(`${def.sql(cost)} LIMIT ${MAX_ROWS + 1}`, [p.tenantId, q.site_id, q.from, q.to]);
  if (rows.length > MAX_ROWS) throw invalid(`Export exceeds ${MAX_ROWS} rows; narrow the period`);
  await writeAudit(s.db, actor, { siteId: q.site_id, action: 'export.generated', targetType: 'export', targetId: dataset, detail: { dataset, from: q.from, to: q.to, rows: rows.length, cost_columns: cost } });
  return { filename: `${dataset}_${q.from.slice(0, 10)}_${q.to.slice(0, 10)}.csv`, csv: toCsv(def.columns(cost), rows), rows: rows.length };
}
