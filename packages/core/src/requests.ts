import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction, type Queryable } from '@vm/db';
import { decodeCursor, encodeCursor, type createRequestRequest, type RequestOrigin, type RequestState, type TriageRequest } from '@vm/contracts';
import { can, sitesWith } from '@vm/policy';
import { AppError, conflict, invalid, notFound, runIdempotent, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { tenantOf, type Actor, type AnyActor, type Services } from './context.ts';
import { requirePermission } from './access.ts';
import { identitySnapshot, resolveAsset, type AssetIdentity } from './identity-snapshots.ts';
import { enqueueEvent, iso, nextDisplayNumber, writeAudit } from './records.ts';
import { loadSiteSettings } from './settings.ts';
import { insertWorkOrder } from './work-orders.ts';

const IDEM = 'maintenance.idempotency_key';

export interface NewRequest {
  siteId: string;
  origin: RequestOrigin;
  reporterId: string;
  asset: AssetIdentity | null;
  locationText: string | null;
  description: string;
  observedAt: Date;
  priority: 'critical' | 'high' | 'normal' | 'low';
  reading: Record<string, unknown> | null;
  voiceTranscript: string | null;
  sourceRef: Record<string, unknown> | null;
  clientRequestId: string | null;
}

/** Shared insertion path for manual, inspection, connector and Neo-originated requests. */
export async function insertRequest(tx: Queryable, s: Services, actor: AnyActor, r: NewRequest): Promise<Record<string, any>> {
  const tenantId = tenantOf(actor);
  if (r.asset && r.asset.site_id !== r.siteId) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  const id = randomUUID();
  const number = await nextDisplayNumber(tx, tenantId, r.siteId, 'request');
  const now = s.clock.now();
  const { rows } = await tx.query(
    `INSERT INTO maintenance.request
       (id, tenant_id, site_id, display_number, origin, reporter_id, asset_id, asset_snapshot, location_text, description, observed_at,
        proposed_priority, reading, voice_transcript, source_ref, client_request_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *`,
    [
      id, tenantId, r.siteId, number, r.origin, r.reporterId, r.asset?.asset_id ?? null, r.asset ? JSON.stringify(identitySnapshot(r.asset)) : null,
      r.locationText ?? (r.asset ? null : 'Unspecified'), r.description, r.observedAt, r.priority, r.reading ? JSON.stringify(r.reading) : null,
      r.voiceTranscript, r.sourceRef ? JSON.stringify(r.sourceRef) : null, r.clientRequestId, now,
    ],
  );
  await writeAudit(tx, actor, { siteId: r.siteId, action: 'request.created', targetType: 'request', targetId: id, afterVersion: 1, detail: { origin: r.origin, priority: r.priority } });
  await enqueueEvent(tx, actor, {
    siteId: r.siteId,
    type: 'maintenance.request.created',
    aggregateType: 'request',
    aggregateId: id,
    aggregateVersion: 1,
    occurredAt: now,
    payload: { request_id: id, display_number: number, origin: r.origin, priority: r.priority, asset_id: r.asset?.asset_id ?? null, reporter_id: r.reporterId, description: r.description.slice(0, 200) },
  });
  return rows[0];
}

export async function createRequest(s: Services, actor: Actor, input: z.infer<typeof createRequestRequest>, key: string | undefined) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.request.create', input.site_id);
  await s.entitlements.require(p.tenantId, 'core.report_fault');
  const asset = input.asset_id ? await resolveAsset(s, actor, input.asset_id) : null;
  const result = await withTransaction(s.db, (tx) =>
    runIdempotent(tx, IDEM, { tenantId: p.tenantId, actorId: p.userId, operation: 'request.create' }, key, input, async () => {
      if (input.client_request_id) {
        const { rows } = await tx.query(`SELECT * FROM maintenance.request WHERE tenant_id = $1 AND reporter_id = $2 AND client_request_id = $3`, [p.tenantId, p.userId, input.client_request_id]);
        if (rows[0]) return { status: 200, body: await requestDto(tx, actor, rows[0]) };
      }
      const row = await insertRequest(tx, s, actor, {
        siteId: input.site_id,
        origin: 'manual',
        reporterId: p.userId,
        asset,
        locationText: input.location_text,
        description: input.description,
        observedAt: new Date(input.observed_at),
        priority: input.proposed_priority,
        reading: input.reading ? { ...input.reading, provenance: 'manual_entry' } : null,
        voiceTranscript: input.voice_transcript,
        sourceRef: null,
        clientRequestId: input.client_request_id,
      });
      return { status: 201, body: await requestDto(tx, actor, row) };
    }),
  );
  return result;
}

function canSeeRequest(actor: Actor, r: Record<string, any>): boolean {
  const p = actor.principal;
  return can(p, 'maintenance.view', r.site_id) || (r.reporter_id === p.userId && can(p, 'maintenance.request.view_own', r.site_id));
}

async function requestDto(db: Queryable, actor: Actor, r: Record<string, any>) {
  const settings = await loadSiteSettings(db, actor.principal.tenantId, r.site_id);
  let linked: Record<string, unknown> | null = null;
  if (r.linked_work_order_id) {
    const { rows } = await db.query(`SELECT id, display_number, state FROM maintenance.work_order WHERE id = $1`, [r.linked_work_order_id]);
    linked = rows[0] ?? null;
  }
  return {
    id: r.id,
    site_id: r.site_id,
    display_number: r.display_number,
    origin: r.origin,
    reporter_id: r.reporter_id,
    asset_id: r.asset_id,
    asset_snapshot: r.asset_snapshot,
    location_text: r.location_text,
    description: r.description,
    observed_at: iso(r.observed_at),
    proposed_priority: r.proposed_priority,
    reading: r.reading,
    voice_transcript: r.voice_transcript,
    source_ref: r.source_ref,
    state: r.state as RequestState,
    triage_reason: r.triage_reason,
    triaged_by: r.triaged_by,
    triaged_at: iso(r.triaged_at),
    linked_work_order: linked,
    duplicate_of_request_id: r.duplicate_of_request_id,
    duplicate_of_work_order_id: r.duplicate_of_work_order_id,
    version: r.version,
    created_at: iso(r.created_at),
    // Reporting never replaces emergency procedures (MR-04).
    incident_contact_instructions: ['critical', 'high'].includes(r.proposed_priority) ? settings.incident_contact_instructions : null,
    can_triage: can(actor.principal, 'maintenance.request.triage', r.site_id),
  };
}

export async function getRequest(s: Services, actor: Actor, id: string) {
  const { rows } = await s.db.query(`SELECT * FROM maintenance.request WHERE tenant_id = $1 AND id::text = $2`, [actor.principal.tenantId, id]);
  if (!rows[0] || !canSeeRequest(actor, rows[0])) throw notFound('Request');
  return requestDto(s.db, actor, rows[0]);
}

export async function listRequests(s: Services, actor: Actor, q: { site_id?: string; state?: RequestState[]; asset_id?: string; mine?: boolean; cursor?: string; limit: number }) {
  const p = actor.principal;
  const fullSites = sitesWith(p, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  const ownSites = sitesWith(p, 'maintenance.request.view_own').filter((x) => !q.site_id || x === q.site_id);
  if (!fullSites.length && !ownSites.length) return { items: [], next_cursor: null };
  const params: unknown[] = [p.tenantId, fullSites, ownSites, p.userId];
  const where = ['tenant_id = $1', '(site_id = ANY($2::uuid[]) OR (site_id = ANY($3::uuid[]) AND reporter_id = $4))'];
  if (q.mine) where.push('reporter_id = $4');
  if (q.state?.length) where.push(`state = ANY($${params.push(q.state)}::text[])`);
  if (q.asset_id) where.push(`asset_id = $${params.push(q.asset_id)}`);
  const cursor = decodeCursor(q.cursor);
  if (cursor) where.push(`(created_at, id) < ($${params.push(cursor[0])}::timestamptz, $${params.push(cursor[1])}::uuid)`);
  const { rows } = await s.db.query(`SELECT * FROM maintenance.request WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`, params);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: await Promise.all(page.map((r) => requestDto(s.db, actor, r))),
    next_cursor: rows.length > q.limit && last ? encodeCursor(iso(last.created_at)!, last.id) : null,
  };
}

async function lockRequest(tx: PoolClient, actor: Actor, id: string) {
  const { rows } = await tx.query(`SELECT * FROM maintenance.request WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [actor.principal.tenantId, id]);
  const r = rows[0];
  if (!r || !canSeeRequest(actor, r)) throw notFound('Request');
  return r;
}

/** MR-02/MR-03: explicit triage decisions; acceptance happens at most once under a row lock. */
export async function triageRequest(s: Services, actor: Actor, id: string, input: TriageRequest, key: string | undefined) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const preview = await lockRequest(tx, actor, id);
    requirePermission(p, 'maintenance.request.triage', preview.site_id);
    return runIdempotent(tx, IDEM, { tenantId: p.tenantId, actorId: p.userId, operation: `request.triage:${preview.id}` }, key, input, async () => {
      const r = preview;
      if (r.version !== input.record_version) throw staleVersion(r.version);
      const open = ['submitted', 'under_review'].includes(r.state);
      if (!open) throw new AppError(409, 'request_already_triaged', `Request is already ${r.state}`);
      const now = s.clock.now();
      let next: RequestState;
      const set: Record<string, unknown> = { triaged_by: p.userId, triaged_at: now };
      let createdWorkOrderId: string | null = null;
      switch (input.action) {
        case 'start_review':
          if (r.state !== 'submitted') throw new AppError(409, 'invalid_transition', 'Request is already under review');
          next = 'under_review';
          break;
        case 'reject':
          next = 'rejected';
          set.triage_reason = input.reason;
          break;
        case 'mark_duplicate': {
          if (!input.duplicate_of_request_id && !input.duplicate_of_work_order_id) throw invalid('Identify the surviving request or work order');
          if (input.duplicate_of_request_id) {
            if (input.duplicate_of_request_id === r.id) throw invalid('A request cannot duplicate itself');
            const { rows } = await tx.query(`SELECT site_id FROM maintenance.request WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.duplicate_of_request_id]);
            if (rows[0]?.site_id !== r.site_id) throw invalid('Surviving request not found at this site');
          }
          if (input.duplicate_of_work_order_id) {
            const { rows } = await tx.query(`SELECT site_id FROM maintenance.work_order WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.duplicate_of_work_order_id]);
            if (rows[0]?.site_id !== r.site_id) throw invalid('Surviving work order not found at this site');
          }
          next = 'duplicate';
          Object.assign(set, { triage_reason: input.reason, duplicate_of_request_id: input.duplicate_of_request_id, duplicate_of_work_order_id: input.duplicate_of_work_order_id });
          break;
        }
        case 'accept': {
          next = 'accepted';
          set.triage_reason = input.reason;
          if (input.link_work_order_id) {
            const { rows } = await tx.query(`SELECT site_id, state FROM maintenance.work_order WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.link_work_order_id]);
            const wo = rows[0];
            if (wo?.site_id !== r.site_id) throw invalid('Work order not found at this site', { link_work_order_id: ['Unknown work order'] });
            if (['closed', 'cancelled'].includes(wo.state)) throw conflict('work_order_not_open', 'Requests can only be linked to open work');
            set.linked_work_order_id = input.link_work_order_id;
          } else {
            if (!input.draft) throw invalid('Provide a draft work order or an existing work order to link', { draft: ['Required'] });
            requirePermission(p, 'maintenance.work_order.create', r.site_id);
            await s.entitlements.require(p.tenantId, 'core.create_work');
            const assetId = input.draft.asset_id ?? r.asset_id;
            const asset = assetId ? await resolveAsset(s, actor, assetId) : null;
            if (!asset && input.draft.non_asset_category && !input.draft.non_asset_justification) {
              throw invalid('A non-asset category requires a justification', { 'draft.non_asset_justification': ['Required'] });
            }
            const wo = await insertWorkOrder(tx, s, actor, {
              siteId: r.site_id,
              type: input.draft.type,
              priority: input.draft.priority,
              title: input.draft.title,
              description: r.description,
              scope: input.draft.scope,
              asset,
              nonAssetCategory: asset ? null : input.draft.non_asset_category,
              nonAssetJustification: asset ? null : input.draft.non_asset_justification,
              locationText: r.location_text,
              teamId: input.draft.team_id,
              assigneeId: null,
              plannedStart: null,
              plannedEnd: null,
              dueAt: null,
              procedureRevisionId: null,
              safetyInstructions: null,
              sourceRequestId: r.id,
              planOccurrenceId: null,
              followUpOfId: null,
              initialState: 'draft',
              creationReason: `Accepted from request #${r.display_number}`,
            });
            createdWorkOrderId = wo.id;
            set.linked_work_order_id = wo.id;
          }
          break;
        }
        default: {
          const never: never = input;
          throw new Error(`Unhandled triage action ${String((never as { action: string }).action)}`);
        }
      }
      const cols = Object.keys(set);
      const { rows } = await tx.query(
        `UPDATE maintenance.request SET state = $3, version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $4,
           ${cols.map((c, i) => `${c} = $${i + 5}`).join(', ')}
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [r.id, p.tenantId, next, now, ...cols.map((c) => set[c])],
      );
      await writeAudit(tx, actor, { siteId: r.site_id, action: `request.${input.action}`, targetType: 'request', targetId: r.id, beforeVersion: r.version, afterVersion: r.version + 1, reason: (set.triage_reason as string | null) ?? null, detail: { from: r.state, to: next, work_order_id: set.linked_work_order_id ?? null } });
      await enqueueEvent(tx, actor, { siteId: r.site_id, type: 'maintenance.request.triaged', aggregateType: 'request', aggregateId: r.id, aggregateVersion: r.version + 1, occurredAt: now, payload: { request_id: r.id, display_number: r.display_number, from: r.state, to: next, reporter_id: r.reporter_id, work_order_id: set.linked_work_order_id ?? null } });
      return { status: 200, body: { request: await requestDto(tx, actor, rows[0]), created_work_order_id: createdWorkOrderId } };
    });
  });
}
