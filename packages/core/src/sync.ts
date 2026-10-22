import { commentRequest, completionSignatureRequest, createDowntimeRequest, createRequestRequest, laborEntryRequest, taskResultRequest, transitionRequest } from '@vm/contracts';
import { AppError, parse } from '@vm/server-kit';
import { sitesWith } from '@vm/policy';
import type { Actor, Services } from './context.ts';
import { createDowntime } from './downtime.ts';
import { addComment, addLaborEntry, recordTaskResults } from './execution.ts';
import { getInspectionResult, signInspection } from './inspections.ts';
import { iso } from './records.ts';
import { createRequest } from './requests.ts';
import { getWorkOrder, signWorkOrder, transitionWorkOrder, workOrderDto } from './work-orders.ts';

/** Assigned child orders stay in this queue. Creating a shutdown, linking a child, and editing its schedule stay on the server. */
export const SYNC_OPERATION_TYPES = ['task_results', 'labor', 'comment', 'transition', 'request', 'downtime', 'completion_signature'] as const;
export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

export interface SyncOperation {
  client_op_id: string;
  type: SyncOperationType;
  record_id: string | null;
  base_version: number | null;
  client_time: string;
  payload: Record<string, unknown>;
}

export type SyncOutcome =
  | { client_op_id: string; outcome: 'applied'; duplicate: boolean; result: unknown }
  | { client_op_id: string; outcome: 'conflict'; duplicate: boolean; code: string; message: string; server_record: unknown; client_payload: unknown }
  | { client_op_id: string; outcome: 'rejected'; duplicate: boolean; code: string; message: string; field_errors?: Record<string, string[]>; preserve_draft: true }
  | { client_op_id: string; outcome: 'retry'; message: string };

const CACHE_TTL_HOURS = 72;

/**
 * Offline cache feed: My Work orders with their issued procedure snapshots and
 * the user's own requests. `in_scope_ids` lets the client drop records that
 * are no longer assigned or authorized (MO-04/MO-05).
 */
export async function syncChanges(s: Services, actor: Actor, since: number, limit: number) {
  const p = actor.principal;
  const sites = sitesWith(p, 'maintenance.work_order.execute');
  const now = s.clock.now();
  const scope = `w.tenant_id = $1 AND w.site_id = ANY($2::uuid[]) AND w.state IN ('ready','in_progress','on_hold','pending_review')
      AND (w.assignee_id = $3 OR (w.assignee_id IS NULL AND w.team_id IN (SELECT team_id FROM maintenance.team_member WHERE user_id = $3)))`;
  const [changed, inScope, requests] = await Promise.all([
    s.db.query(`SELECT w.* FROM maintenance.work_order w WHERE ${scope} AND w.change_seq > $4 ORDER BY w.change_seq LIMIT $5`, [p.tenantId, sites, p.userId, since, limit]),
    s.db.query<{ id: string }>(`SELECT w.id FROM maintenance.work_order w WHERE ${scope}`, [p.tenantId, sites, p.userId]),
    s.db.query(
      `SELECT id, site_id, display_number, state, description, asset_id, proposed_priority, version, change_seq, created_at FROM maintenance.request
        WHERE tenant_id = $1 AND reporter_id = $2 AND change_seq > $3 ORDER BY change_seq LIMIT $4`,
      [p.tenantId, p.userId, since, limit],
    ),
  ]);
  const items = await Promise.all(changed.rows.map(async (w) => ({ type: 'work_order' as const, id: w.id, version: w.version, change_seq: Number(w.change_seq), record: await workOrderDto(s.db, actor, w, s.clock.now()) })));
  const reqs = requests.rows.map((r) => ({ type: 'request' as const, id: r.id, version: r.version, change_seq: Number(r.change_seq), record: { ...r, change_seq: undefined, created_at: iso(r.created_at) } }));
  const all = [...items, ...reqs].sort((a, b) => a.change_seq - b.change_seq);
  const cursor = all.reduce((m, i) => Math.max(m, i.change_seq), since);
  return {
    items: all,
    in_scope_work_order_ids: inScope.rows.map((r) => r.id),
    cursor: String(cursor),
    has_more: changed.rows.length === limit || requests.rows.length === limit,
    server_time: now.toISOString(),
    cache_expires_at: new Date(now.getTime() + CACHE_TTL_HOURS * 3_600_000).toISOString(),
  };
}

async function execute(s: Services, actor: Actor, op: SyncOperation): Promise<unknown> {
  const recordId = op.record_id ?? '';
  switch (op.type) {
    case 'task_results':
      return recordTaskResults(s, actor, recordId, parse(taskResultRequest, { ...op.payload, client_op_id: op.client_op_id, recorded_at: op.payload.recorded_at ?? op.client_time }));
    case 'labor':
      return addLaborEntry(s, actor, recordId, parse(laborEntryRequest, { ...op.payload, client_op_id: op.client_op_id }));
    case 'comment':
      return addComment(s, actor, recordId, parse(commentRequest, { ...op.payload, client_op_id: op.client_op_id }));
    case 'transition': {
      if (op.base_version === null) throw new AppError(428, 'precondition_required', 'Offline transitions must carry the record version they were based on');
      const r = await transitionWorkOrder(s, actor, recordId, parse(transitionRequest, { ...op.payload, record_version: op.base_version }), `sync:${op.client_op_id}`);
      return r.body;
    }
    case 'request':
      return (await createRequest(s, actor, parse(createRequestRequest, { ...op.payload, client_request_id: op.client_op_id }), undefined)).body;
    case 'downtime':
      return (await createDowntime(s, actor, parse(createDowntimeRequest, { ...op.payload, client_op_id: op.client_op_id }))).body;
    case 'completion_signature': {
      if (op.base_version === null) throw new AppError(428, 'precondition_required', 'Offline signatures must carry the record version they were based on');
      const body = parse(completionSignatureRequest, { ...op.payload, record_version: op.base_version, client_op_id: op.client_op_id });
      if (op.payload.owner_type === 'inspection_result') return signInspection(s, actor, recordId, body);
      return signWorkOrder(s, actor, recordId, body);
    }
    default: {
      const never: never = op.type;
      throw new Error(`Unhandled sync operation ${String(never)}`);
    }
  }
}

async function serverRecord(s: Services, actor: Actor, op: SyncOperation): Promise<unknown> {
  if (!op.record_id || op.type === 'request' || op.type === 'downtime') return null;
  try {
    if (op.type === 'completion_signature' && op.payload.owner_type === 'inspection_result') return await getInspectionResult(s, actor, op.record_id);
    return await getWorkOrder(s, actor, op.record_id);
  } catch {
    return null;
  }
}

/**
 * MO-02..MO-04: each queued operation is applied at most once. Append-only
 * entries merge; workflow changes are version-checked and surface conflicts
 * with both versions instead of last-write-wins. Authorization and record
 * state are re-checked on the server; rejected drafts stay on the device.
 */
export async function applySyncOperations(s: Services, actor: Actor, operations: SyncOperation[]): Promise<SyncOutcome[]> {
  const p = actor.principal;
  const out: SyncOutcome[] = [];
  for (const op of operations) {
    const { rows } = await s.db.query(`SELECT outcome, result FROM maintenance.sync_operation WHERE tenant_id = $1 AND actor_id = $2 AND client_op_id = $3`, [p.tenantId, p.userId, op.client_op_id]);
    if (rows[0]) {
      out.push({ ...(rows[0].result as SyncOutcome), duplicate: true } as SyncOutcome);
      continue;
    }
    let outcome: SyncOutcome;
    try {
      outcome = { client_op_id: op.client_op_id, outcome: 'applied', duplicate: false, result: await execute(s, actor, op) };
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) {
        out.push({ client_op_id: op.client_op_id, outcome: 'retry', message: 'Temporary server problem; the operation was not recorded and can be retried' });
        continue;
      }
      if (err.status === 409 || err.status === 412 || err.status === 428) {
        outcome = { client_op_id: op.client_op_id, outcome: 'conflict', duplicate: false, code: err.code, message: err.message, server_record: await serverRecord(s, actor, op), client_payload: op.payload };
      } else {
        outcome = { client_op_id: op.client_op_id, outcome: 'rejected', duplicate: false, code: err.code, message: err.message, field_errors: err.fieldErrors, preserve_draft: true };
      }
    }
    await s.db.query(
      `INSERT INTO maintenance.sync_operation (tenant_id, actor_id, client_op_id, op_type, record_id, base_version, client_time, received_at, outcome, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [p.tenantId, p.userId, op.client_op_id, op.type, op.record_id, op.base_version, op.client_time, s.clock.now(), outcome.outcome, JSON.stringify(outcome)],
    );
    out.push(outcome);
  }
  return out;
}
