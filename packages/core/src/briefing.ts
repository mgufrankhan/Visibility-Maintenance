import { randomUUID } from 'node:crypto';
import type { structuredCaptureRequest } from '@vm/contracts';
import { withTransaction, type Queryable } from '@vm/db';
import { can } from '@vm/policy';
import { sanitizeUntrustedText } from '@vm/neo';
import { conflict, invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import { requireVisible } from './access.ts';
import type { Actor, Services } from './context.ts';
import { resolveAsset } from './identity-snapshots.ts';
import { writeAudit } from './records.ts';

const CAPTURE_RUNTIME = 'deterministic-capture';

export interface BriefingCitation {
  type: 'work_order' | 'failure_event' | 'procedure_revision' | 'attachment' | 'part';
  id: string;
}

/** Deterministic shop-floor briefing. It does not call Neo or a model. */
export async function getBriefing(s: Services, actor: Actor, q: { asset_id?: string | null; work_order_id?: string | null }) {
  const p = actor.principal;
  if (!q.asset_id && !q.work_order_id) throw invalid('An asset or work order is required', { asset_id: ['Required'] });
  let siteId: string | null = null;
  let assetId = q.asset_id ?? null;
  let procedureRevisionId: string | null = null;
  if (q.work_order_id) {
    const { rows } = await s.db.query(
      `SELECT id, site_id, asset_id, procedure_revision_id, state FROM maintenance.work_order WHERE tenant_id = $1 AND id::text = $2`,
      [p.tenantId, q.work_order_id],
    );
    const wo = rows[0];
    if (!wo || !can(p, 'maintenance.view', wo.site_id)) throw notFound('Work order');
    if (assetId && wo.asset_id && assetId !== wo.asset_id) throw invalid('Work order belongs to a different asset', { work_order_id: ['Asset mismatch'] });
    if (!wo.asset_id) throw invalid('Briefing needs an asset', { work_order_id: ['This order has no asset'] });
    siteId = wo.site_id;
    assetId = wo.asset_id;
    procedureRevisionId = wo.procedure_revision_id;
  }
  if (!assetId) throw invalid('An asset is required', { asset_id: ['Required'] });
  const asset = await resolveAsset(s, actor, assetId);
  siteId = siteId ?? asset.site_id;
  if (asset.site_id !== siteId) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  requireVisible(p, 'maintenance.view', siteId, 'Asset');

  if (!procedureRevisionId) {
    const { rows } = await s.db.query(
      `SELECT procedure_revision_id FROM maintenance.work_order
        WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND procedure_revision_id IS NOT NULL
          AND state NOT IN ('closed', 'cancelled')
        ORDER BY updated_at DESC LIMIT 1`,
      [p.tenantId, siteId, assetId],
    );
    procedureRevisionId = rows[0]?.procedure_revision_id ?? null;
  }

  const { rows: orders } = await s.db.query(
    `SELECT id, display_number, state, title FROM maintenance.work_order
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND state NOT IN ('closed', 'cancelled')
      ORDER BY created_at DESC LIMIT 20`,
    [p.tenantId, siteId, assetId],
  );
  const { rows: failures } = await s.db.query(
    `SELECT id, started_at, classification FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND validated
      ORDER BY started_at DESC LIMIT 10`,
    [p.tenantId, siteId, assetId],
  );
  const { rows: counted } = await s.db.query(
    `SELECT count(*)::int AS n FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND validated`,
    [p.tenantId, siteId, assetId],
  );
  const documents = await readableDocuments(s.db, p.tenantId, assetId);
  const parts = await partsCoverage(s.db, p.tenantId, siteId);
  const citations: BriefingCitation[] = [
    ...orders.map((row) => ({ type: 'work_order' as const, id: row.id as string })),
    ...failures.map((row) => ({ type: 'failure_event' as const, id: row.id as string })),
    ...(procedureRevisionId ? [{ type: 'procedure_revision' as const, id: procedureRevisionId }] : []),
    ...documents.map((row) => ({ type: 'attachment' as const, id: row.attachment_id })),
    ...parts.lines.map((row) => ({ type: 'part' as const, id: row.part_id })),
  ];
  return {
    asset_id: assetId,
    site_id: siteId,
    open_orders: orders.map((row) => ({ id: row.id, display_number: row.display_number, state: row.state, title: row.title })),
    failure_events: failures.map((row) => ({ id: row.id, started_at: new Date(row.started_at).toISOString(), classification: row.classification })),
    validated_failure_count: counted[0]?.n ?? 0,
    procedure_revision_id: procedureRevisionId,
    documents,
    parts,
    citations,
  };
}

async function readableDocuments(db: Queryable, tenantId: string, assetId: string) {
  const { rows } = await db.query(`SELECT document_links FROM maintenance.profile WHERE tenant_id = $1 AND asset_id = $2`, [tenantId, assetId]);
  const links = (rows[0]?.document_links ?? []) as Array<{ title?: string; attachment_id?: string }>;
  const documents = [];
  for (const link of links) {
    if (!link.attachment_id) continue;
    const { rows: att } = await db.query(
      `SELECT id, file_name, status FROM maintenance.attachment WHERE tenant_id = $1 AND id = $2`,
      [tenantId, link.attachment_id],
    );
    if (att[0]?.status === 'available') documents.push({ attachment_id: att[0].id as string, title: link.title || att[0].file_name });
  }
  return documents;
}

async function partsCoverage(db: Queryable, tenantId: string, siteId: string) {
  const { rows: stores } = await db.query(
    `SELECT count(*)::int AS n FROM maintenance.store WHERE tenant_id = $1 AND site_id = $2 AND status = 'active'`,
    [tenantId, siteId],
  );
  if (!stores[0]?.n) return { present: false, lines: [] as Array<{ part_id: string; on_hand: number; reserved: number; available: number }> };
  const { rows } = await db.query(
    `SELECT b.part_id, sum(b.on_hand)::float AS on_hand, sum(b.reserved)::float AS reserved
       FROM maintenance.inventory_balance b
       JOIN maintenance.store st ON st.id = b.store_id
      WHERE b.tenant_id = $1 AND st.site_id = $2
      GROUP BY b.part_id
      ORDER BY b.part_id
      LIMIT 20`,
    [tenantId, siteId],
  );
  return {
    present: true,
    lines: rows.map((row) => ({
      part_id: row.part_id as string,
      on_hand: Number(row.on_hand),
      reserved: Number(row.reserved),
      available: Number(row.on_hand) - Number(row.reserved),
    })),
  };
}

interface MarkedFields {
  symptom: string | null;
  failure_code: string | null;
  cause: string | null;
  action: string | null;
  notes: string | null;
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const sanitized = sanitizeUntrustedText(value);
  const text = sanitized.text.trim();
  return text.length ? text : null;
}

function markedFromText(text: string): MarkedFields | null {
  const fields: MarkedFields = { symptom: null, failure_code: null, cause: null, action: null, notes: null };
  const extra: string[] = [];
  let any = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(symptom|failure_code|cause|action|notes):\s*(.*)$/i.exec(line.trim());
    if (!match) {
      extra.push(line);
      continue;
    }
    any = true;
    const key = match[1]!.toLowerCase() as keyof MarkedFields;
    fields[key] = clean(match[2] ?? '');
  }
  if (!any) return null;
  const rest = clean(extra.join('\n'));
  if (rest) fields.notes = fields.notes ? `${fields.notes}\n${rest}` : rest;
  return fields;
}

/** Turns marked text, or an already stored audio file, into a reviewable proposal. Audio is not transcribed. */
export async function captureStructuredFields(s: Services, actor: Actor, input: z.infer<typeof structuredCaptureRequest>) {
  const p = actor.principal;
  requireVisible(p, 'maintenance.view', input.site_id, 'Site');
  const now = s.clock.now();
  return withTransaction(s.db, async (tx) => {
    let assetId: string | null = null;
    if (input.request_id) {
      const { rows } = await tx.query(`SELECT * FROM maintenance.request WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, input.request_id]);
      const request = rows[0];
      if (!request || request.site_id !== input.site_id || !can(p, 'maintenance.view', request.site_id)) throw notFound('Request');
      assetId = request.asset_id;
    }
    if (input.work_order_id) {
      const { rows } = await tx.query(`SELECT * FROM maintenance.work_order WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, input.work_order_id]);
      const order = rows[0];
      if (!order || order.site_id !== input.site_id || !can(p, 'maintenance.view', order.site_id)) throw notFound('Work order');
      if (order.state !== 'in_progress') throw conflict('invalid_state', 'Structured capture on a work order is available while it is in progress');
      if (assetId && order.asset_id && assetId !== order.asset_id) throw invalid('Work order belongs to a different asset', { work_order_id: ['Asset mismatch'] });
      assetId = order.asset_id ?? assetId;
    }
    let transcript: string | null = null;
    let attachmentId: string | null = null;
    if (input.attachment_id) {
      const { rows } = await tx.query(`SELECT * FROM maintenance.attachment WHERE tenant_id = $1 AND id::text = $2`, [p.tenantId, input.attachment_id]);
      const attachment = rows[0];
      const ownerOk = attachment && ((input.request_id && attachment.owner_type === 'request' && attachment.owner_id === input.request_id) || (input.work_order_id && attachment.owner_type === 'work_order' && attachment.owner_id === input.work_order_id));
      if (!ownerOk || attachment.status !== 'available') throw invalid('Audio attachment is not available on this record', { attachment_id: ['Unknown attachment'] });
      if (!String(attachment.media_type).startsWith('audio/')) throw invalid('Only an audio attachment can be captured without a transcript', { attachment_id: ['Not audio'] });
      attachmentId = attachment.id;
      transcript = null;
    }
    const marked = input.fields
      ? {
          symptom: clean(input.fields.symptom),
          failure_code: clean(input.fields.failure_code),
          cause: clean(input.fields.cause),
          action: clean(input.fields.action),
          notes: clean(input.fields.notes),
        }
      : input.text
        ? markedFromText(sanitizeUntrustedText(input.text).text)
        : null;
    let failureCode = marked?.failure_code ?? null;
    if (failureCode && assetId) {
      const { rows } = await tx.query(`SELECT failure_taxonomy FROM maintenance.profile WHERE tenant_id = $1 AND asset_id = $2`, [p.tenantId, assetId]);
      const taxonomy = (rows[0]?.failure_taxonomy ?? []) as string[];
      if (!taxonomy.includes(failureCode)) failureCode = null;
    } else {
      failureCode = null;
    }
    const notes = marked?.notes ?? (input.text && !marked ? clean(input.text) : null);
    const payload = {
      request_id: input.request_id,
      work_order_id: input.work_order_id,
      asset_id: assetId,
      symptom: marked?.symptom ?? null,
      failure_code: failureCode,
      cause: marked?.cause ?? null,
      action: marked?.action ?? null,
      notes,
      attachment_id: attachmentId,
      transcript,
    };
    const runId = randomUUID();
    const recommendationId = randomUUID();
    await tx.query(
      `INSERT INTO maintenance.agent_run
         (id, tenant_id, site_id, asset_id, actor_id, trigger, query, inference_policy, runtime, model_version, prompt_version,
          evidence, observations, possible_causes, recommended_checks, citations, missing_evidence, proposed_action_id, outcome, created_at)
       VALUES ($1,$2,$3,$4,$5,'user_query',$6,'private_only',$7,NULL,'capture-v1','[]',$8,'[]','[]','[]',$9,NULL,'drafted',$10)`,
      [runId, p.tenantId, input.site_id, assetId, p.userId, (input.text ?? 'audio').slice(0, 4000), CAPTURE_RUNTIME, 'Structured capture is a review proposal. It does not change the request or the work order.', JSON.stringify(attachmentId ? ['No qualified transcription runtime. Audio was stored and no transcript was created.'] : []), now],
    );
    await tx.query(
      `INSERT INTO maintenance.recommendation
         (id, tenant_id, site_id, run_id, action_type, action_payload, status, proposed_by, created_at)
       VALUES ($1,$2,$3,$4,'structured_capture',$5,'pending',$6,$7)`,
      [recommendationId, p.tenantId, input.site_id, runId, JSON.stringify(payload), p.userId, now],
    );
    await tx.query(`UPDATE maintenance.agent_run SET proposed_action_id = $2 WHERE id = $1`, [runId, recommendationId]);
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'capture.proposed', targetType: 'recommendation', targetId: recommendationId, detail: { request_id: input.request_id, work_order_id: input.work_order_id, transcript: null } });
    return { id: recommendationId, status: 'pending', action_type: 'structured_capture', action_payload: payload, runtime: CAPTURE_RUNTIME, model_version: null };
  });
}
