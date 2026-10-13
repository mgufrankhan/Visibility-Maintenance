import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { withTransaction, type Queryable } from '@vm/db';
import type { evidenceRequest } from '@vm/contracts';
import { can } from '@vm/policy';
import { AppError, conflict, forbidden, invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import type { Actor, Services } from './context.ts';
import { resolveAsset } from './identity-snapshots.ts';
import { iso, writeAudit } from './records.ts';

export type AttachmentOwner = 'work_order' | 'request' | 'inspection_result' | 'procedure_revision' | 'asset_document' | 'downtime_event';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv']);

interface OwnerScope {
  siteId: string;
}

/**
 * Authorizes the parent record before any attachment operation, so an
 * allowed parent cannot be used to reach a forbidden file or vice versa.
 */
async function authorizeOwner(db: Queryable, s: Services, actor: Actor, type: AttachmentOwner, ownerId: string, mode: 'read' | 'write'): Promise<OwnerScope> {
  const p = actor.principal;
  const t = p.tenantId;
  switch (type) {
    case 'work_order': {
      const { rows } = await db.query(`SELECT site_id, state, assignee_id FROM maintenance.work_order WHERE tenant_id = $1 AND id::text = $2`, [t, ownerId]);
      const wo = rows[0];
      if (!wo || !can(p, 'maintenance.view', wo.site_id)) throw notFound('Work order');
      if (mode === 'write') {
        const executing = ['in_progress', 'on_hold'].includes(wo.state) && can(p, 'maintenance.work_order.execute', wo.site_id);
        const reviewing = ['pending_review', 'closed'].includes(wo.state) && can(p, 'maintenance.work_order.approve', wo.site_id);
        if (!executing && !reviewing) throw forbidden('Evidence can be added during execution, or by an approver during review');
      }
      return { siteId: wo.site_id };
    }
    case 'request': {
      const { rows } = await db.query(`SELECT site_id, reporter_id, state FROM maintenance.request WHERE tenant_id = $1 AND id::text = $2`, [t, ownerId]);
      const r = rows[0];
      const own = r && r.reporter_id === p.userId && can(p, 'maintenance.request.view_own', r.site_id);
      if (!r || (!own && !can(p, 'maintenance.view', r.site_id))) throw notFound('Request');
      if (mode === 'write' && !(own && ['submitted', 'under_review'].includes(r.state)) && !can(p, 'maintenance.request.triage', r.site_id)) throw forbidden();
      return { siteId: r.site_id };
    }
    case 'procedure_revision': {
      const { rows } = await db.query(
        `SELECT p.site_id, r.status FROM maintenance.procedure_revision r JOIN maintenance.procedure p ON p.id = r.procedure_id WHERE r.tenant_id = $1 AND r.id::text = $2`,
        [t, ownerId],
      );
      const r = rows[0];
      const siteId: string | undefined = r?.site_id ?? p.memberSiteIds.find((sid) => can(p, 'maintenance.view', sid));
      if (!r || !siteId || !can(p, 'maintenance.view', siteId)) throw notFound('Procedure revision');
      if (mode === 'write') {
        if (!can(p, 'maintenance.procedure.manage', siteId)) throw forbidden();
        if (r.status !== 'draft') throw conflict('revision_not_draft', 'Documents can only be attached to draft revisions');
      }
      return { siteId };
    }
    case 'asset_document': {
      const asset = await resolveAsset(s, actor, ownerId);
      if (!can(p, 'maintenance.view', asset.site_id)) throw notFound('Asset');
      if (mode === 'write' && !can(p, 'maintenance.profile.manage', asset.site_id)) throw forbidden();
      return { siteId: asset.site_id };
    }
    case 'inspection_result': {
      const { rows } = await db.query(`SELECT site_id, submitted_by, status FROM maintenance.inspection_result WHERE tenant_id = $1 AND id::text = $2`, [t, ownerId]);
      const r = rows[0];
      if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Inspection result');
      if (mode === 'write') {
        if (!(r.submitted_by === p.userId && can(p, 'maintenance.inspection.execute', r.site_id))) throw forbidden();
        if (r.status !== 'in_progress') throw conflict('inspection_submitted', 'Evidence cannot be added after submission');
      }
      return { siteId: r.site_id };
    }
    case 'downtime_event': {
      const { rows } = await db.query(`SELECT site_id FROM maintenance.failure_event WHERE tenant_id = $1 AND id::text = $2`, [t, ownerId]);
      const r = rows[0];
      if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Downtime event');
      if (mode === 'write' && !can(p, 'maintenance.downtime.create', r.site_id)) throw forbidden();
      return { siteId: r.site_id };
    }
    default: {
      const never: never = type;
      throw new Error(`Unhandled attachment owner ${String(never)}`);
    }
  }
}

export async function createUploadSlot(s: Services, actor: Actor, ownerType: AttachmentOwner, ownerId: string, meta: z.infer<typeof evidenceRequest>) {
  const p = actor.principal;
  const media = meta.media_type.toLowerCase();
  const isImage = IMAGE_TYPES.has(media);
  if (!isImage && !DOCUMENT_TYPES.has(media)) {
    throw invalid('This file type is not accepted', { media_type: ['Accepted: JPEG, PNG, WebP, PDF, plain text, Markdown, CSV'] });
  }
  const limit = isImage ? s.config.maxImageBytes : s.config.maxDocumentBytes;
  if (meta.size_bytes > limit) throw invalid(`File exceeds the ${Math.round(limit / 1024 / 1024)} MiB limit`, { size_bytes: ['Too large'] });
  return withTransaction(s.db, async (tx) => {
    const scope = await authorizeOwner(tx, s, actor, ownerType, ownerId, 'write');
    if (meta.client_op_id) {
      const { rows } = await tx.query(`SELECT * FROM maintenance.attachment WHERE tenant_id = $1 AND uploaded_by = $2 AND client_op_id = $3`, [p.tenantId, p.userId, meta.client_op_id]);
      if (rows[0]) return slotDto(rows[0]);
    }
    const id = randomUUID();
    const storageKey = `${p.tenantId}/${scope.siteId}/${id}`;
    const { rows } = await tx.query(
      `INSERT INTO maintenance.attachment (id, tenant_id, site_id, owner_type, owner_id, step_key, file_name, media_type, size_bytes, sha256, storage_key, client_op_id, uploaded_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, p.tenantId, scope.siteId, ownerType, ownerId, meta.step_key, meta.file_name, media, meta.size_bytes, meta.sha256, storageKey, meta.client_op_id, p.userId, s.clock.now()],
    );
    return slotDto(rows[0]);
  });
}

function slotDto(r: Record<string, any>) {
  return { id: r.id, status: r.status, upload_url: `/api/v1/maintenance/attachments/${r.id}/content`, file_name: r.file_name, media_type: r.media_type, size_bytes: Number(r.size_bytes) };
}

function sniff(media: string, bytes: Buffer): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (media) {
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/pdf':
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    default: {
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    }
  }
}

/** Second stage: bytes must match the declared size, hash and media type, otherwise they are quarantined. */
export async function uploadAttachmentContent(s: Services, actor: Actor, attachmentId: string, bytes: Buffer) {
  const p = actor.principal;
  const outcome = await withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.attachment WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, attachmentId]);
    const a = rows[0];
    if (!a || a.uploaded_by !== p.userId) throw notFound('Attachment');
    if (a.status === 'available') return { id: a.id as string, status: a.status as string, reason: null };
    if (a.status !== 'pending') throw conflict('attachment_finalized', `Attachment is ${a.status}`);
    let status = 'available';
    let reason: string | null = null;
    if (bytes.length !== Number(a.size_bytes)) [status, reason] = ['rejected', 'Size does not match the declared size'];
    else if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) [status, reason] = ['rejected', 'Content hash does not match'];
    else if (!sniff(a.media_type, bytes)) [status, reason] = ['quarantined', 'Content does not match the declared media type'];
    if (status === 'available') await s.blobs.put(a.storage_key, bytes);
    await tx.query(`UPDATE maintenance.attachment SET status = $2, status_reason = $3, finalized_at = $4 WHERE id = $1`, [a.id, status, reason, s.clock.now()]);
    await writeAudit(tx, actor, { siteId: a.site_id, action: `attachment.${status}`, targetType: a.owner_type, targetId: a.owner_id, reason, detail: { attachment_id: a.id, sha256: a.sha256 } });
    return { id: a.id as string, status, reason };
  });
  // Rejection is committed first so the quarantine record and audit survive.
  if (outcome.status !== 'available') throw new AppError(422, `attachment_${outcome.status}`, outcome.reason ?? 'Upload rejected');
  return { id: outcome.id, status: outcome.status };
}

function sign(secret: string, id: string, exp: number, userId: string): string {
  return createHmac('sha256', secret).update(`${id}.${exp}.${userId}`).digest('base64url');
}

export async function issueDownloadLink(s: Services, actor: Actor, attachmentId: string) {
  const p = actor.principal;
  const { rows } = await s.db.query(`SELECT * FROM maintenance.attachment WHERE tenant_id = $1 AND id::text = $2`, [p.tenantId, attachmentId]);
  const a = rows[0];
  if (!a) throw notFound('Attachment');
  await authorizeOwner(s.db, s, actor, a.owner_type, a.owner_id, 'read');
  if (a.status !== 'available') throw conflict('attachment_unavailable', `Attachment is ${a.status}`);
  const exp = Math.floor(s.clock.now().getTime() / 1000) + s.config.downloadLinkTtlSeconds;
  const sig = sign(s.config.downloadLinkSecret, a.id, exp, p.userId);
  await writeAudit(s.db, actor, { siteId: a.site_id, action: 'attachment.download_link_issued', targetType: a.owner_type, targetId: a.owner_id, detail: { attachment_id: a.id } });
  return { url: `/api/v1/maintenance/attachments/${a.id}/content?exp=${exp}&u=${p.userId}&sig=${sig}`, expires_at: new Date(exp * 1000).toISOString() };
}

export async function openSignedDownload(s: Services, attachmentId: string, q: { exp?: string; u?: string; sig?: string }): Promise<{ stream: Readable; media_type: string; file_name: string; size: number }> {
  const exp = Number(q.exp);
  if (!q.sig || !q.u || !Number.isInteger(exp)) throw notFound('Attachment');
  if (exp < Math.floor(s.clock.now().getTime() / 1000)) throw new AppError(410, 'link_expired', 'Download link has expired');
  const expected = Buffer.from(sign(s.config.downloadLinkSecret, attachmentId, exp, q.u));
  const given = Buffer.from(q.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw notFound('Attachment');
  const { rows } = await s.db.query(`SELECT * FROM maintenance.attachment WHERE id::text = $1 AND status = 'available'`, [attachmentId]);
  const a = rows[0];
  if (!a) throw notFound('Attachment');
  return { stream: await s.blobs.get(a.storage_key), media_type: a.media_type, file_name: a.file_name, size: Number(a.size_bytes) };
}

export async function listAttachments(s: Services, actor: Actor, ownerType: AttachmentOwner, ownerId: string) {
  await authorizeOwner(s.db, s, actor, ownerType, ownerId, 'read');
  const { rows } = await s.db.query(
    `SELECT id, step_key, file_name, media_type, size_bytes, sha256, status, status_reason, uploaded_by, created_at FROM maintenance.attachment
      WHERE tenant_id = $1 AND owner_type = $2 AND owner_id::text = $3 ORDER BY created_at`,
    [actor.principal.tenantId, ownerType, ownerId],
  );
  return rows.map((r) => ({ ...r, size_bytes: Number(r.size_bytes), created_at: iso(r.created_at) }));
}
