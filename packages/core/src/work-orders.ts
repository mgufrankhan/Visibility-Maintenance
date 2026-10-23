import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction, type Queryable } from '@vm/db';
import {
  decodeCursor,
  encodeCursor,
  type CheckDefinition,
  type CompletionSignatureRequest,
  type createWorkOrderRequest,
  type PatchWorkOrder,
  type TransitionRequest,
  type TransitionResult,
  type WorkOrderAction,
  type WorkOrderState,
} from '@vm/contracts';
import { APPROVED_ACTIVE_STATES, can, ROLE_GRANTS, sitesWith, TRANSITIONS, transitionFor } from '@vm/policy';
import { AppError, conflict, forbidden, invalid, notFound, runIdempotent, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { completionGaps, type CurrentResult } from './checks.ts';
import { actorId, actorKind, isSystem, tenantOf, type Actor, type AnyActor, type Services } from './context.ts';
import { isTeamMember, requirePermission } from './access.ts';
import { assertNativeFieldMutable } from './authority.ts';
import { assertAssetAcceptsNewWork, identitySnapshot, resolveAsset, type AssetIdentity } from './identity-snapshots.ts';
import { issuableRevision, type ProcedureSnapshot } from './procedures.ts';
import { enqueueEvent, iso, nextDisplayNumber, writeAudit } from './records.ts';
import { loadSiteSettings } from './settings.ts';
import { insertSignature, latestSignature } from './signatures.ts';
import { procedureSnapshotHash } from './snapshot-hash.ts';

const IDEM = 'maintenance.idempotency_key';

export interface NewWorkOrder {
  siteId: string;
  type: 'corrective' | 'preventive' | 'inspection' | 'follow_up';
  priority: 'critical' | 'high' | 'normal' | 'low';
  title: string;
  description: string;
  scope: string;
  asset: AssetIdentity | null;
  nonAssetCategory: string | null;
  nonAssetJustification: string | null;
  locationText: string | null;
  teamId: string;
  assigneeId: string | null;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  dueAt: Date | null;
  procedureRevisionId: string | null;
  safetyInstructions: string | null;
  sourceRequestId: string | null;
  planOccurrenceId: string | null;
  followUpOfId: string | null;
  initialState: 'draft' | 'pending_approval' | 'ready';
  creationReason: string | null;
}

async function assertTeam(db: Queryable, tenantId: string, teamId: string, siteId: string): Promise<void> {
  const { rows } = await db.query(`SELECT site_id, status FROM maintenance.team WHERE tenant_id = $1 AND id = $2`, [tenantId, teamId]);
  if (rows[0]?.site_id !== siteId || rows[0]?.status !== 'active') throw invalid('Owning team must be an active team at this site', { team_id: ['Unknown team for this site'] });
}

/** Assignees must hold execution rights at the site; maintenance roles are checked locally. */
async function assertAssignable(s: Services, actor: AnyActor, tenantId: string, siteId: string, userId: string): Promise<void> {
  const { rows } = await s.db.query<{ role: keyof typeof ROLE_GRANTS; site_id: string | null }>(
    `SELECT role, site_id FROM maintenance.role_assignment WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  const ok = rows.some((r) => (r.site_id === null || r.site_id === siteId) && ROLE_GRANTS[r.role]?.includes('maintenance.work_order.execute'));
  if (!ok) throw invalid('Assignee cannot execute work at this site', { assignee_id: ['User lacks execution rights at this site'] });
  const token = isSystem(actor) ? await s.systemToken(tenantId) : actor.token;
  const members = await s.registry.directory(token, siteId);
  if (!members.some((m) => m.id === userId)) throw invalid('Assignee is not a member of this site', { assignee_id: ['Not a site member'] });
}

async function recordTransition(
  tx: Queryable,
  actor: AnyActor,
  wo: { id: string; cycle: number },
  t: { action: string; from: WorkOrderState | null; to: WorkOrderState; fromVersion: number | null; toVersion: number; reason: string | null; detail?: Record<string, unknown>; at: Date },
): Promise<void> {
  await tx.query(
    `INSERT INTO maintenance.work_order_transition
       (id, tenant_id, work_order_id, action, from_state, to_state, from_version, to_version, cycle, actor_id, actor_kind, reason, detail, correlation_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [randomUUID(), tenantOf(actor), wo.id, t.action, t.from, t.to, t.fromVersion, t.toVersion, wo.cycle, actorId(actor), actorKind(actor), t.reason, JSON.stringify(t.detail ?? {}), actor.correlationId, t.at],
  );
}

/**
 * Single insertion path for all work-order origins (manual, triage, PM,
 * inspection follow-up). Callers enforce permissions and entitlements.
 * parent_id stays null: preventive generation never creates a shutdown or a child link.
 */
export async function insertWorkOrder(tx: PoolClient, s: Services, actor: AnyActor, w: NewWorkOrder): Promise<Record<string, any>> {
  const tenantId = tenantOf(actor);
  await assertTeam(tx, tenantId, w.teamId, w.siteId);
  if (w.asset) {
    if (w.asset.site_id !== w.siteId) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
    assertAssetAcceptsNewWork(w.asset);
  }
  let procedure: ProcedureSnapshot | null = null;
  if (w.procedureRevisionId) procedure = await issuableRevision(tx, tenantId, w.procedureRevisionId, w.siteId);
  const id = randomUUID();
  const number = await nextDisplayNumber(tx, tenantId, w.siteId, 'work_order');
  const now = s.clock.now();
  const by = actorId(actor) ?? '00000000-0000-0000-0000-000000000000';
  const { rows } = await tx.query(
    `INSERT INTO maintenance.work_order
       (id, tenant_id, site_id, display_number, type, state, priority, title, description, scope, asset_id, asset_snapshot,
        non_asset_category, non_asset_justification, location_text, team_id, assignee_id, planned_start, planned_end, due_at,
        procedure_revision_id, procedure_snapshot, safety_instructions, source_request_id, plan_occurrence_id, follow_up_of_id,
        approved_by, approved_at, created_at, created_by, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$29,$30)
     RETURNING *`,
    [
      id, tenantId, w.siteId, number, w.type, w.initialState, w.priority, w.title, w.description, w.scope,
      w.asset?.asset_id ?? null, w.asset ? JSON.stringify(identitySnapshot(w.asset)) : null,
      w.nonAssetCategory, w.nonAssetJustification, w.locationText, w.teamId, w.assigneeId, w.plannedStart, w.plannedEnd, w.dueAt,
      w.procedureRevisionId, procedure ? JSON.stringify(procedure) : null, w.safetyInstructions, w.sourceRequestId, w.planOccurrenceId, w.followUpOfId,
      w.initialState === 'ready' ? actorId(actor) : null, w.initialState === 'ready' ? now : null, now, by,
    ],
  );
  const wo = rows[0];
  await recordTransition(tx, actor, wo, { action: 'create', from: null, to: w.initialState, fromVersion: null, toVersion: 1, reason: w.creationReason, at: now });
  await writeAudit(tx, actor, { siteId: w.siteId, action: 'work_order.created', targetType: 'work_order', targetId: id, afterVersion: 1, reason: w.creationReason, detail: { display_number: number, type: w.type, state: w.initialState } });
  await enqueueEvent(tx, actor, {
    siteId: w.siteId,
    type: 'maintenance.work_order.created',
    aggregateType: 'work_order',
    aggregateId: id,
    aggregateVersion: 1,
    occurredAt: now,
    payload: { work_order_id: id, display_number: number, state: w.initialState, type: w.type, priority: w.priority, asset_id: w.asset?.asset_id ?? null, assignee_id: w.assigneeId, team_id: w.teamId },
  });
  return wo;
}

export async function createWorkOrder(s: Services, actor: Actor, input: z.infer<typeof createWorkOrderRequest>, key: string | undefined) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.work_order.create', input.site_id);
  if (input.assignee_id) requirePermission(p, 'maintenance.work_order.assign', input.site_id);
  await s.entitlements.require(p.tenantId, 'core.create_work');
  const asset = input.asset_id ? await resolveAsset(s, actor, input.asset_id) : null;
  if (input.assignee_id) await assertAssignable(s, actor, p.tenantId, input.site_id, input.assignee_id);
  if (!asset && input.non_asset_category && !input.non_asset_justification) {
    throw invalid('A non-asset category requires a justification', { non_asset_justification: ['Required'] });
  }
  const result = await withTransaction(s.db, (tx) =>
    runIdempotent(tx, IDEM, { tenantId: p.tenantId, actorId: p.userId, operation: 'work_order.create' }, key, input, async () => {
      if (input.source_request_id) {
        const { rows } = await tx.query(`SELECT site_id FROM maintenance.request WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.source_request_id]);
        if (rows[0]?.site_id !== input.site_id) throw invalid('Source request not found at this site', { source_request_id: ['Unknown request'] });
      }
      const wo = await insertWorkOrder(tx, s, actor, {
        siteId: input.site_id,
        type: input.type,
        priority: input.priority,
        title: input.title,
        description: input.description,
        scope: input.scope,
        asset,
        nonAssetCategory: asset ? null : input.non_asset_category,
        nonAssetJustification: asset ? null : input.non_asset_justification,
        locationText: null,
        teamId: input.team_id,
        assigneeId: input.assignee_id,
        plannedStart: input.planned_start ? new Date(input.planned_start) : null,
        plannedEnd: input.planned_end ? new Date(input.planned_end) : null,
        dueAt: input.due_at ? new Date(input.due_at) : null,
        procedureRevisionId: input.procedure_revision_id,
        safetyInstructions: input.safety_instructions,
        sourceRequestId: input.source_request_id,
        planOccurrenceId: null,
        followUpOfId: null,
        initialState: 'draft',
        creationReason: null,
      });
      return { status: 201, body: await workOrderDto(tx, actor, wo, s.clock.now()) };
    }),
  );
  return result;
}

// ---------- Reading ----------

async function loadVisible(db: Queryable, actor: Actor, id: string, lock = false): Promise<Record<string, any>> {
  const { rows } = await db.query(`SELECT * FROM maintenance.work_order WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const wo = rows[0];
  if (!wo || !can(actor.principal, 'maintenance.view', wo.site_id)) throw notFound('Work order');
  return wo;
}

function isOverdue(wo: Record<string, any>, now: Date): boolean {
  return wo.due_at !== null && !['closed', 'cancelled'].includes(wo.state) && new Date(wo.due_at).getTime() < now.getTime();
}

export async function actionsFor(db: Queryable, actor: Actor, wo: Record<string, any>): Promise<WorkOrderAction[]> {
  const p = actor.principal;
  const out: WorkOrderAction[] = [];
  const isAssignee = wo.assignee_id === p.userId;
  const teamMember = !wo.assignee_id && (await isTeamMember(db, p.tenantId, wo.team_id, p.userId));
  for (const action of Object.keys(TRANSITIONS) as WorkOrderAction[]) {
    const rule = transitionFor(action, wo.state);
    if (!rule || !can(p, rule.permission, wo.site_id)) continue;
    if (action === 'start' && !isAssignee && !teamMember) continue;
    if (action === 'submit_completion' && !isAssignee) continue;
    if ((action === 'hold' || action === 'resume') && !isAssignee && !can(p, 'maintenance.work_order.approve', wo.site_id)) continue;
    out.push(action);
  }
  return out;
}

export async function workOrderDto(db: Queryable, actor: Actor, wo: Record<string, any>, now: Date) {
  return {
    id: wo.id,
    site_id: wo.site_id,
    display_number: wo.display_number,
    type: wo.type,
    state: wo.state,
    priority: wo.priority,
    title: wo.title,
    description: wo.description,
    scope: wo.scope,
    asset_id: wo.asset_id,
    asset_snapshot: wo.asset_snapshot,
    non_asset_category: wo.non_asset_category,
    non_asset_justification: wo.non_asset_justification,
    location_text: wo.location_text,
    team_id: wo.team_id,
    assignee_id: wo.assignee_id,
    planned_start: iso(wo.planned_start),
    planned_end: iso(wo.planned_end),
    due_at: iso(wo.due_at),
    overdue: isOverdue(wo, now),
    procedure_revision_id: wo.procedure_revision_id,
    procedure_snapshot: wo.procedure_snapshot,
    safety_instructions: wo.safety_instructions,
    source_request_id: wo.source_request_id,
    plan_occurrence_id: wo.plan_occurrence_id,
    follow_up_of_id: wo.follow_up_of_id,
    parent_id: wo.parent_id,
    cycle: wo.cycle,
    observed_symptoms: wo.observed_symptoms,
    failure_code: wo.failure_code,
    cause_code: wo.cause_code,
    cause_unknown_reason: wo.cause_unknown_reason,
    corrective_action: wo.corrective_action,
    submitted_by: wo.submitted_by,
    submitted_at: iso(wo.submitted_at),
    approved_by: wo.approved_by,
    approved_at: iso(wo.approved_at),
    closed_by: wo.closed_by,
    closed_at: iso(wo.closed_at),
    closure_outcome: wo.closure_outcome,
    cancel_reason: wo.cancel_reason,
    cancel_exemption: wo.cancel_exemption === true,
    version: wo.version,
    created_at: iso(wo.created_at),
    created_by: wo.created_by,
    updated_at: iso(wo.updated_at),
    available_actions: await actionsFor(db, actor, wo),
  };
}

export async function currentResults(db: Queryable, tenantId: string, woId: string, cycle: number): Promise<Map<string, CurrentResult & Record<string, any>>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (step_key) * FROM maintenance.task_result
      WHERE tenant_id = $1 AND work_order_id = $2 AND cycle = $3
      ORDER BY step_key, entry_seq DESC`,
    [tenantId, woId, cycle],
  );
  return new Map(rows.map((r) => [r.step_key, { ...r, attachment_ids: r.attachment_ids ?? [] }]));
}

export async function getWorkOrder(s: Services, actor: Actor, id: string) {
  const wo = await loadVisible(s.db, actor, id);
  const tenantId = actor.principal.tenantId;
  const showCost = can(actor.principal, 'maintenance.cost.view', wo.site_id);
  const [results, exceptions, labor, comments, attachments, transitions, closures] = await Promise.all([
    currentResults(s.db, tenantId, wo.id, wo.cycle),
    s.db.query(`SELECT step_key, reason, granted_by, granted_at, cycle FROM maintenance.check_exception WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY granted_at`, [tenantId, wo.id]),
    s.db.query(`SELECT * FROM maintenance.labor_entry WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY started_at, id`, [tenantId, wo.id]),
    s.db.query(`SELECT id, author_id, body, created_at FROM maintenance.comment WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at, id`, [tenantId, wo.id]),
    s.db.query(`SELECT id, step_key, file_name, media_type, size_bytes, sha256, status, uploaded_by, created_at FROM maintenance.attachment WHERE tenant_id = $1 AND owner_type = 'work_order' AND owner_id = $2 ORDER BY created_at`, [tenantId, wo.id]),
    s.db.query(`SELECT action, from_state, to_state, from_version, to_version, cycle, actor_id, actor_kind, reason, detail, occurred_at FROM maintenance.work_order_transition WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY to_version`, [tenantId, wo.id]),
    s.db.query(`SELECT cycle, submitted_by, verifier_id, verified_at, outcome, self_approval_exception FROM maintenance.work_order_closure WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY cycle`, [tenantId, wo.id]),
  ]);
  const supersededLabor = new Set(labor.rows.map((l) => l.amends_entry_id).filter(Boolean));
  const failureLinks = (
    await s.db.query(`SELECT failure_event_id FROM maintenance.order_failure_link WHERE tenant_id = $1 AND work_order_id = $2`, [tenantId, wo.id])
  ).rows.map((x) => x.failure_event_id);
  const { rows: children } = await s.db.query(
    `SELECT id, display_number, title, state, asset_id FROM maintenance.work_order WHERE tenant_id = $1 AND parent_id = $2 ORDER BY display_number`,
    [tenantId, wo.id],
  );
  return {
    ...(await workOrderDto(s.db, actor, wo, s.clock.now())),
    task_results: [...results.values()].map((r) => ({ id: r.id, step_key: r.step_key, value: r.value, unit: r.unit, passed: r.passed, note: r.note, attachment_ids: r.attachment_ids, recorded_by: r.recorded_by, recorded_at: iso(r.recorded_at), amendment_reason: r.amendment_reason })),
    check_exceptions: exceptions.rows,
    labor: labor.rows.map((l) => ({
      id: l.id,
      person_id: l.person_id,
      started_at: iso(l.started_at),
      ended_at: iso(l.ended_at),
      duration_minutes: l.duration_minutes,
      note: l.note,
      amends_entry_id: l.amends_entry_id,
      amendment_reason: l.amendment_reason,
      superseded: supersededLabor.has(l.id),
      ...(showCost ? { hourly_rate: l.hourly_rate, currency: l.currency } : {}),
    })),
    comments: comments.rows,
    attachments: attachments.rows,
    transitions: transitions.rows,
    closures: closures.rows,
    failure_event_ids: failureLinks,
    children,
    procedure_snapshot_hash: wo.procedure_snapshot ? procedureSnapshotHash(wo.procedure_snapshot) : null,
    completion_signature: await latestSignature(s.db, tenantId, 'work_order', wo.id, wo.cycle),
  };
}

export interface WorkOrderListQuery {
  site_id?: string;
  state?: WorkOrderState[];
  assignee?: 'me' | string;
  my_work?: boolean;
  team_id?: string;
  asset_id?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  type?: 'corrective' | 'preventive' | 'inspection' | 'follow_up';
  unassigned?: boolean;
  overdue?: boolean;
  q?: string;
  cursor?: string;
  limit: number;
}

export async function listWorkOrders(s: Services, actor: Actor, q: WorkOrderListQuery) {
  const p = actor.principal;
  const sites = sitesWith(p, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (sites.length === 0) return { items: [], next_cursor: null };
  const params: unknown[] = [p.tenantId, sites];
  const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
  if (q.state?.length) where.push(`state = ANY($${params.push(q.state)}::text[])`);
  if (q.assignee) where.push(`assignee_id = $${params.push(q.assignee === 'me' ? p.userId : q.assignee)}`);
  if (q.my_work) {
    where.push(`state IN ('ready','in_progress','on_hold','pending_review')`);
    where.push(`(assignee_id = $${params.push(p.userId)} OR (assignee_id IS NULL AND team_id IN (SELECT team_id FROM maintenance.team_member WHERE user_id = $${params.length})))`);
  }
  if (q.team_id) where.push(`team_id = $${params.push(q.team_id)}`);
  if (q.asset_id) where.push(`asset_id = $${params.push(q.asset_id)}`);
  if (q.priority) where.push(`priority = $${params.push(q.priority)}`);
  if (q.type) where.push(`type = $${params.push(q.type)}`);
  if (q.unassigned) where.push(`assignee_id IS NULL AND state NOT IN ('closed','cancelled')`);
  if (q.overdue) where.push(`due_at < $${params.push(s.clock.now())} AND state NOT IN ('closed','cancelled')`);
  if (q.q) where.push(`(title ILIKE $${params.push(`%${q.q}%`)} OR display_number::text = $${params.push(q.q)})`);
  const cursor = decodeCursor(q.cursor);
  if (cursor) where.push(`(created_at, id) < ($${params.push(cursor[0])}::timestamptz, $${params.push(cursor[1])}::uuid)`);
  const { rows } = await s.db.query(`SELECT * FROM maintenance.work_order WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`, params);
  const page = rows.slice(0, q.limit);
  const items = await Promise.all(page.map((r) => workOrderDto(s.db, actor, r, s.clock.now())));
  const last = page.at(-1);
  return { items, next_cursor: rows.length > q.limit && last ? encodeCursor(iso(last.created_at)!, last.id) : null };
}

// ---------- Editing ----------

const MATERIAL_FIELDS = ['scope', 'procedure_revision_id', 'safety_instructions', 'planned_start', 'planned_end', 'team_id', 'non_asset_category', 'non_asset_justification'] as const;
const EXECUTION_EDITABLE = ['title', 'description', 'priority', 'due_at', 'assignee_id'] as const;

export async function patchWorkOrder(s: Services, actor: Actor, id: string, expected: number, patch: PatchWorkOrder) {
  const p = actor.principal;
  const fields = Object.keys(patch) as Array<keyof PatchWorkOrder>;
  if (fields.length === 0) throw invalid('No fields to update');
  const preview = await loadVisible(s.db, actor, id);
  await assertNativeFieldMutable(s, actor, preview.site_id, preview.id, fields as string[]);
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisible(tx, actor, id, true);
    const nonAssign = fields.filter((f) => f !== 'assignee_id');
    if (nonAssign.length) requirePermission(p, 'maintenance.work_order.edit', wo.site_id);
    if (fields.includes('assignee_id')) requirePermission(p, 'maintenance.work_order.assign', wo.site_id);
    if (wo.version !== expected) throw staleVersion(wo.version);
    const state = wo.state as WorkOrderState;
    if (['pending_review', 'closed', 'cancelled'].includes(state)) throw conflict('record_locked', `Work orders in ${state} cannot be edited`);
    if (['in_progress', 'on_hold'].includes(state)) {
      const locked = fields.filter((f) => !(EXECUTION_EDITABLE as readonly string[]).includes(f));
      if (locked.length) throw conflict('field_locked', `Fields cannot change during execution: ${locked.join(', ')}`);
    }
    if (patch.asset_id !== undefined) {
      if (isShutdownParent(wo)) throw conflict('shutdown_parent', 'A shutdown parent cannot take an asset');
      if (state !== 'draft' || wo.asset_id !== null) throw conflict('asset_identity_immutable', 'Asset identity can only be set once, on a draft without an asset');
    }
    if (isShutdownParent(wo) && patch.non_asset_category !== undefined && patch.non_asset_category !== 'shutdown') {
      throw conflict('shutdown_parent', 'A shutdown parent keeps its category');
    }
    const next: Record<string, any> = { ...wo };
    if (patch.asset_id) {
      const asset = await resolveAsset(s, actor, patch.asset_id);
      if (asset.site_id !== wo.site_id) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
      assertAssetAcceptsNewWork(asset);
      next.asset_id = asset.asset_id;
      next.asset_snapshot = identitySnapshot(asset);
    }
    if (patch.team_id) await assertTeam(tx, p.tenantId, patch.team_id, wo.site_id);
    if (patch.assignee_id) await assertAssignable(s, actor, p.tenantId, wo.site_id, patch.assignee_id);
    if (patch.procedure_revision_id) next.procedure_snapshot = await issuableRevision(tx, p.tenantId, patch.procedure_revision_id, wo.site_id);
    if (patch.procedure_revision_id === null) next.procedure_snapshot = null;
    for (const f of fields) if (f !== 'asset_id') next[f] = patch[f];
    for (const f of ['planned_start', 'planned_end', 'due_at'] as const) if (typeof next[f] === 'string') next[f] = new Date(next[f]);
    if (next.planned_start && next.planned_end && next.planned_end < next.planned_start) throw invalid('planned_end must not precede planned_start');
    const material = state === 'ready' && fields.some((f) => (MATERIAL_FIELDS as readonly string[]).includes(f));
    const newState: WorkOrderState = material ? 'pending_approval' : state;
    const dueFrom = iso(wo.due_at);
    const dueTo = iso(next.due_at);
    const now = s.clock.now();
    const { rows } = await tx.query(
      `UPDATE maintenance.work_order SET title = $3, description = $4, priority = $5, team_id = $6, scope = $7, planned_start = $8,
         planned_end = $9, due_at = $10, procedure_revision_id = $11, procedure_snapshot = $12, safety_instructions = $13,
         assignee_id = $14, asset_id = $15, asset_snapshot = $16, non_asset_category = $17, non_asset_justification = $18,
         state = $19, approved_by = CASE WHEN $20 THEN NULL ELSE approved_by END, approved_at = CASE WHEN $20 THEN NULL ELSE approved_at END,
         version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $21, updated_by = $22
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [
        wo.id, p.tenantId, next.title, next.description, next.priority, next.team_id, next.scope, next.planned_start, next.planned_end, next.due_at,
        next.procedure_revision_id, next.procedure_snapshot ? JSON.stringify(next.procedure_snapshot) : null, next.safety_instructions,
        next.assignee_id, next.asset_id, next.asset_snapshot ? JSON.stringify(next.asset_snapshot) : null, next.non_asset_category, next.non_asset_justification,
        newState, material, now, p.userId,
      ],
    );
    const updated = rows[0];
    if (material) {
      await recordTransition(tx, actor, updated, { action: 'request_reapproval', from: state, to: newState, fromVersion: wo.version, toVersion: updated.version, reason: `Material change: ${fields.join(', ')}`, at: now });
      await enqueueEvent(tx, actor, { siteId: wo.site_id, type: 'maintenance.work_order.state_changed', aggregateType: 'work_order', aggregateId: wo.id, aggregateVersion: updated.version, occurredAt: now, payload: { work_order_id: wo.id, display_number: wo.display_number, title: updated.title, from: state, to: newState, action: 'request_reapproval' } });
    }
    if (fields.includes('assignee_id') && patch.assignee_id) {
      await enqueueEvent(tx, actor, { siteId: wo.site_id, type: 'maintenance.work_order.assigned', aggregateType: 'work_order', aggregateId: wo.id, aggregateVersion: updated.version, occurredAt: now, payload: { work_order_id: wo.id, assignee_id: patch.assignee_id, display_number: wo.display_number, title: updated.title } });
    }
    const editDetail: Record<string, unknown> = { fields, reapproval_required: material };
    if (fields.includes('due_at') && dueFrom !== dueTo) editDetail.due_at = { from: dueFrom, to: dueTo };
    await writeAudit(tx, actor, { siteId: wo.site_id, action: 'work_order.edited', targetType: 'work_order', targetId: wo.id, beforeVersion: wo.version, afterVersion: updated.version, detail: editDetail });
    return workOrderDto(tx, actor, updated, now);
  });
}

// ---------- Transitions ----------

function requireReason(reason: string | null, action: string): string {
  if (!reason || reason.trim().length < 3) throw invalid(`A reason is required to ${action.replace(/_/g, ' ')}`, { reason: ['Required'] });
  return reason.trim();
}

function planningGaps(wo: Record<string, any>): Record<string, string[]> {
  const gaps: Record<string, string[]> = {};
  if (!wo.asset_id && !(wo.non_asset_category && wo.non_asset_justification)) gaps.asset_id = ['Resolve an asset or a justified non-asset category'];
  if (!wo.scope?.trim()) gaps.scope = ['Scope is required'];
  return gaps;
}

export async function signWorkOrder(s: Services, actor: Actor, id: string, input: CompletionSignatureRequest) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const wo = await loadVisible(tx, actor, id, true);
    if (wo.version !== input.record_version) throw staleVersion(wo.version);
    if (!wo.procedure_snapshot?.signature_required) throw conflict('signature_not_required', 'This procedure does not require a completion signature');
    const executing = wo.assignee_id === p.userId && ['in_progress', 'on_hold'].includes(wo.state);
    const canAmend = can(p, 'maintenance.work_order.approve', wo.site_id) && ['in_progress', 'on_hold', 'pending_review'].includes(wo.state);
    if (!executing && !canAmend) throw forbidden('Only the assigned technician can sign, or an approver can amend the signature');
    if (executing) requirePermission(p, 'maintenance.work_order.execute', wo.site_id);
    const hash = procedureSnapshotHash(wo.procedure_snapshot);
    const now = s.clock.now();
    const signature = await insertSignature(tx, {
      tenantId: p.tenantId,
      siteId: wo.site_id,
      ownerType: 'work_order',
      ownerId: wo.id,
      cycle: wo.cycle,
      signerId: p.userId,
      signedAt: now,
      snapshotHash: hash,
      presentedHash: input.snapshot_hash,
      clientOpId: input.client_op_id,
      amendmentReason: input.amendment_reason,
    });
    await tx.query(
      `UPDATE maintenance.work_order SET version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $3, updated_by = $4 WHERE id = $1 AND tenant_id = $2`,
      [wo.id, p.tenantId, now, p.userId],
    );
    await writeAudit(tx, actor, { siteId: wo.site_id, action: 'work_order.signed', targetType: 'work_order', targetId: wo.id, beforeVersion: wo.version, afterVersion: wo.version + 1, reason: input.amendment_reason, detail: { snapshot_hash: hash } });
    return { signature, version: wo.version + 1, procedure_snapshot_hash: hash };
  });
}

function approvalGaps(wo: Record<string, any>): Record<string, string[]> {
  const gaps = planningGaps(wo);
  if (!wo.planned_start || !wo.planned_end) gaps.planned_start = ['Planned start and end dates are required before approval'];
  if (!wo.procedure_revision_id) gaps.procedure_revision_id = ['An approved procedure revision is required before approval'];
  const safety = `${wo.procedure_snapshot?.safety_instructions ?? ''}${wo.safety_instructions ?? ''}`.trim();
  if (!safety) gaps.safety_instructions = ['Applicable safety instructions are required before approval'];
  return gaps;
}

export function isShutdownParent(wo: { asset_id?: string | null; non_asset_category?: string | null }): boolean {
  return !wo.asset_id && wo.non_asset_category === 'shutdown';
}

export async function linkShutdownChild(s: Services, actor: Actor, parentId: string, childId: string) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const parent = await loadVisible(tx, actor, parentId, true);
    requirePermission(p, 'maintenance.work_order.edit', parent.site_id);
    await assertNativeFieldMutable(s, actor, parent.site_id, parent.id, ['parent_id']);
    if (!isShutdownParent(parent)) throw invalid('Only a shutdown order without an asset can be a parent', { parent_id: ['Not a shutdown'] });
    const { rows: found } = await tx.query(`SELECT * FROM maintenance.work_order WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [p.tenantId, childId]);
    const child = found[0];
    if (!child) throw notFound('Work order');
    if (child.site_id !== parent.site_id) throw invalid('A child order must be at the same site as the shutdown', { work_order_id: ['Different site'] });
    if (!can(p, 'maintenance.view', child.site_id)) throw notFound('Work order');
    if (child.id === parent.id) throw invalid('An order cannot be its own parent', { work_order_id: ['Same order'] });
    if (!child.asset_id) throw invalid('A shutdown child must name one asset', { work_order_id: ['Asset required'] });
    if (isShutdownParent(child)) throw invalid('A shutdown order cannot be a child', { work_order_id: ['Not an asset order'] });
    if (child.parent_id === parent.id) return { status: 200, body: { work_order_id: child.id, parent_id: parent.id, version: child.version } };
    if (child.parent_id) {
      const { rows: current } = await tx.query(`SELECT state FROM maintenance.work_order WHERE tenant_id = $1 AND id = $2`, [p.tenantId, child.parent_id]);
      if (current[0]?.state !== 'cancelled') throw conflict('already_linked', 'Cancel the current shutdown or unlink the child before linking another parent');
    }
    const now = s.clock.now();
    const { rows } = await tx.query(
      `UPDATE maintenance.work_order SET parent_id = $3, version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $4, updated_by = $5
       WHERE id = $1 AND tenant_id = $2 RETURNING id, version`,
      [child.id, p.tenantId, parent.id, now, p.userId],
    );
    await writeAudit(tx, actor, { siteId: parent.site_id, action: 'work_order.child_linked', targetType: 'work_order', targetId: parent.id, beforeVersion: child.version, afterVersion: rows[0].version, detail: { child_id: child.id } });
    return { status: 200, body: { work_order_id: child.id, parent_id: parent.id, version: rows[0].version } };
  });
}

export async function unlinkShutdownChild(s: Services, actor: Actor, parentId: string, childId: string) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const parent = await loadVisible(tx, actor, parentId, true);
    requirePermission(p, 'maintenance.work_order.edit', parent.site_id);
    const child = await loadVisible(tx, actor, childId, true);
    if (child.parent_id !== parent.id) throw notFound('Work order');
    const now = s.clock.now();
    const { rows } = await tx.query(
      `UPDATE maintenance.work_order SET parent_id = NULL, version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $3, updated_by = $4
       WHERE id = $1 AND tenant_id = $2 RETURNING version`,
      [child.id, p.tenantId, now, p.userId],
    );
    await writeAudit(tx, actor, { siteId: parent.site_id, action: 'work_order.child_unlinked', targetType: 'work_order', targetId: parent.id, beforeVersion: child.version, afterVersion: rows[0].version, detail: { child_id: child.id } });
    return { work_order_id: child.id, parent_id: null, version: rows[0].version };
  });
}

async function reopenClosedParent(tx: PoolClient, s: Services, actor: Actor, parentId: string, reason: string, now: Date): Promise<void> {
  const p = actor.principal;
  const { rows } = await tx.query(`SELECT * FROM maintenance.work_order WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [p.tenantId, parentId]);
  const parent = rows[0];
  if (!parent || parent.state !== 'closed' || !isShutdownParent(parent)) return;
  const cycle = parent.cycle + 1;
  const { rows: updated } = await tx.query(
    `UPDATE maintenance.work_order SET state = 'in_progress', cycle = $3, closed_by = NULL, closed_at = NULL, closure_outcome = NULL,
       submitted_by = NULL, submitted_at = NULL, version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $4, updated_by = $5
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [parent.id, p.tenantId, cycle, now, p.userId],
  );
  const next = updated[0];
  const detail = { previous_closure: { closed_by: parent.closed_by, closed_at: iso(parent.closed_at), outcome: parent.closure_outcome, cycle: parent.cycle }, cause: 'child_reopened' };
  await recordTransition(tx, actor, next, { action: 'reopen', from: 'closed', to: 'in_progress', fromVersion: parent.version, toVersion: next.version, reason, detail, at: now });
  await writeAudit(tx, actor, { siteId: parent.site_id, action: 'work_order.reopen', targetType: 'work_order', targetId: parent.id, beforeVersion: parent.version, afterVersion: next.version, reason, detail });
  await enqueueEvent(tx, actor, {
    siteId: parent.site_id,
    type: 'maintenance.work_order.state_changed',
    aggregateType: 'work_order',
    aggregateId: parent.id,
    aggregateVersion: next.version,
    occurredAt: now,
    payload: { work_order_id: parent.id, display_number: parent.display_number, title: parent.title, from: 'closed', to: 'in_progress', action: 'reopen', assignee_id: parent.assignee_id, team_id: parent.team_id, source_request_id: parent.source_request_id },
  });
}

export async function transitionWorkOrder(s: Services, actor: Actor, id: string, req: TransitionRequest, key: string | undefined) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const preview = await loadVisible(tx, actor, id);
    await assertNativeFieldMutable(s, actor, preview.site_id, preview.id, ['state']);
    return runIdempotent(tx, IDEM, { tenantId: p.tenantId, actorId: p.userId, operation: `work_order.transition:${preview.id}` }, key, req, async () => {
      const wo = await loadVisible(tx, actor, id, true);
      const from = wo.state as WorkOrderState;
      const rule = transitionFor(req.action, from);
      if (!can(p, TRANSITIONS[req.action].permission, wo.site_id)) throw forbidden();
      if (wo.version !== req.record_version) throw staleVersion(wo.version);
      if (!rule) throw new AppError(409, 'invalid_transition', `Cannot ${req.action.replace(/_/g, ' ')} a work order that is ${from.replace(/_/g, ' ')}`);
      const reason = rule.reasonRequired ? requireReason(req.reason, req.action) : req.reason;
      const now = s.clock.now();
      const set: Record<string, unknown> = {};
      const detail: Record<string, unknown> = {};

      const newWork = ['submit_for_approval', 'approve', 'reopen'].includes(req.action);
      if (newWork) await s.entitlements.require(p.tenantId, 'core.create_work');
      else if (APPROVED_ACTIVE_STATES.includes(from)) await s.entitlements.require(p.tenantId, 'core.complete_active_work');

      switch (req.action) {
        case 'submit_for_approval': {
          const gaps = planningGaps(wo);
          if (Object.keys(gaps).length) throw invalid('Planned scope is incomplete', gaps);
          break;
        }
        case 'approve': {
          const gaps = approvalGaps(wo);
          if (Object.keys(gaps).length) throw invalid('Work order is not ready for approval', gaps);
          if (wo.asset_id) assertAssetAcceptsNewWork(await resolveAsset(s, actor, wo.asset_id));
          set.approved_by = p.userId;
          set.approved_at = now;
          break;
        }
        case 'return_to_draft':
        case 'request_reapproval':
          set.approved_by = null;
          set.approved_at = null;
          break;
        case 'start': {
          if (wo.assignee_id && wo.assignee_id !== p.userId) throw forbidden('Only the assigned technician can start this work');
          if (!wo.assignee_id) {
            if (!(await isTeamMember(tx, p.tenantId, wo.team_id, p.userId))) throw forbidden('Only members of the owning team can take queued work');
            set.assignee_id = p.userId;
            detail.self_assigned = true;
          }
          break;
        }
        case 'hold':
        case 'resume':
          if (wo.assignee_id !== p.userId && !can(p, 'maintenance.work_order.approve', wo.site_id)) throw forbidden();
          break;
        case 'submit_completion': {
          if (wo.assignee_id !== p.userId) throw forbidden('Only the assigned technician can submit completion');
          const completion = req.completion ?? { observed_symptoms: null, failure_code: null, cause_code: null, cause_unknown_reason: null, corrective_action: null, acknowledgments: [] };
          const steps: CheckDefinition[] = wo.procedure_snapshot?.steps ?? [];
          const results = await currentResults(tx, p.tenantId, wo.id, wo.cycle);
          const { rows: ex } = await tx.query(`SELECT step_key FROM maintenance.check_exception WHERE work_order_id = $1 AND cycle = $2`, [wo.id, wo.cycle]);
          const gaps = completionGaps({
            steps,
            results,
            exceptions: new Set(ex.map((e) => e.step_key)),
            requireCause: wo.type === 'corrective' || wo.type === 'follow_up',
            completion,
          });
          if (wo.procedure_snapshot?.signature_required) {
            const hash = procedureSnapshotHash(wo.procedure_snapshot);
            const signature = await latestSignature(tx, p.tenantId, 'work_order', wo.id, wo.cycle);
            if (!signature || signature.snapshot_hash !== hash) {
              gaps.push({ field: 'completion.signature', message: 'A completion signature matching the issued procedure is required' });
            }
          }
          if (gaps.length) {
            const fe: Record<string, string[]> = {};
            for (const g of gaps) (fe[g.field] ??= []).push(g.message);
            throw new AppError(422, 'completion_blocked', 'Completion cannot be submitted until the listed items are resolved', fe);
          }
          Object.assign(set, {
            observed_symptoms: completion.observed_symptoms,
            failure_code: completion.failure_code,
            cause_code: completion.cause_code,
            cause_unknown_reason: completion.cause_unknown_reason,
            corrective_action: completion.corrective_action,
            acknowledgments: JSON.stringify(completion.acknowledgments),
            submitted_by: p.userId,
            submitted_at: now,
          });
          break;
        }
        case 'return_for_rework':
          set.submitted_at = null;
          break;
        case 'close': {
          if (!req.closure_outcome) throw invalid('A closure outcome is required', { closure_outcome: ['Required'] });
          if (isShutdownParent(wo)) {
            const { rows: openChildren } = await tx.query(
              `SELECT id FROM maintenance.work_order WHERE tenant_id = $1 AND parent_id = $2 AND state NOT IN ('closed', 'cancelled') LIMIT 1`,
              [p.tenantId, wo.id],
            );
            if (openChildren[0]) throw conflict('children_open', 'Close or cancel every child order before closing the shutdown');
          }
          let selfApproval = false;
          if (wo.submitted_by === p.userId) {
            const settings = await loadSiteSettings(tx, p.tenantId, wo.site_id);
            if (!settings.allow_self_approval) throw new AppError(403, 'independent_approval_required', 'Completion must be approved by someone other than the submitting technician');
            selfApproval = true;
            detail.self_approval_exception = settings.self_approval_justification;
          }
          Object.assign(set, { closed_by: p.userId, closed_at: now, closure_outcome: req.closure_outcome });
          await tx.query(
            `INSERT INTO maintenance.work_order_closure (id, tenant_id, work_order_id, cycle, submitted_by, verifier_id, verified_at, outcome, self_approval_exception)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), p.tenantId, wo.id, wo.cycle, wo.submitted_by, p.userId, now, req.closure_outcome, selfApproval],
          );
          detail.outcome = req.closure_outcome;
          break;
        }
        case 'reopen':
          Object.assign(set, { cycle: wo.cycle + 1, closed_by: null, closed_at: null, closure_outcome: null, submitted_by: null, submitted_at: null });
          detail.previous_closure = { closed_by: wo.closed_by, closed_at: iso(wo.closed_at), outcome: wo.closure_outcome, cycle: wo.cycle };
          if (wo.parent_id) await reopenClosedParent(tx, s, actor, wo.parent_id, reason ?? 'Child reopened', now);
          break;
        case 'cancel':
          set.cancel_reason = reason;
          detail.due_at = iso(wo.due_at);
          detail.exemption = req.exemption === true;
          if (req.exemption) {
            if (!can(p, 'maintenance.work_order.approve', wo.site_id)) throw forbidden('An approved exemption requires an approver');
            set.cancel_exemption = true;
          }
          break;
        default: {
          const never: never = req.action;
          throw new Error(`Unhandled action ${String(never)}`);
        }
      }

      const cols = Object.keys(set);
      const assignments = cols.map((c, i) => `${c} = $${i + 6}`).join(', ');
      const { rows } = await tx.query(
        `UPDATE maintenance.work_order SET state = $3, version = version + 1, change_seq = nextval('maintenance.change_seq'),
           updated_at = $4, updated_by = $5${cols.length ? `, ${assignments}` : ''}
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [wo.id, p.tenantId, rule.to, now, p.userId, ...cols.map((c) => set[c])],
      );
      const updated = rows[0];
      await recordTransition(tx, actor, { id: wo.id, cycle: req.action === 'reopen' ? updated.cycle : wo.cycle }, { action: req.action, from, to: rule.to, fromVersion: wo.version, toVersion: updated.version, reason, detail, at: now });
      await writeAudit(tx, actor, { siteId: wo.site_id, action: `work_order.${req.action}`, targetType: 'work_order', targetId: wo.id, beforeVersion: wo.version, afterVersion: updated.version, reason, detail: { from, to: rule.to, ...detail } });
      await enqueueEvent(tx, actor, {
        siteId: wo.site_id,
        type: 'maintenance.work_order.state_changed',
        aggregateType: 'work_order',
        aggregateId: wo.id,
        aggregateVersion: updated.version,
        occurredAt: now,
        payload: { work_order_id: wo.id, display_number: wo.display_number, title: wo.title, from, to: rule.to, action: req.action, assignee_id: updated.assignee_id, team_id: updated.team_id, source_request_id: wo.source_request_id, submitted_by: updated.submitted_by ?? wo.submitted_by },
      });
      const body: TransitionResult = {
        id: wo.id,
        state: rule.to,
        version: updated.version,
        transition: { action: req.action, from, to: rule.to, at: now.toISOString(), reason },
        correlation_id: actor.correlationId,
      };
      return { status: 200, body };
    });
  });
}

export { loadVisible as loadVisibleWorkOrder };
