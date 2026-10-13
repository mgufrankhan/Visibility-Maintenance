import { evidenceRequest, uuid } from '@vm/contracts';
import { createUploadSlot, issueDownloadLink, listAttachments, openSignedDownload, uploadAttachmentContent } from '@vm/core';
import { invalid, parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

const OWNER_TYPES = ['work_order', 'request', 'inspection_result', 'procedure_revision', 'asset_document', 'downtime_event'] as const;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function registerAttachmentRoutes({ app, s, actor }: RouteDeps): void {
  // Binary uploads only; JSON keeps its default parser.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  app.post(`${API}/attachments`, async (req, reply) => {
    const body = parse(evidenceRequest.extend({ owner_type: z.enum(OWNER_TYPES), owner_id: z.string().min(1).max(100) }), req.body);
    const { owner_type, owner_id, ...meta } = body;
    return reply.status(201).send(await createUploadSlot(s, await actor(req), owner_type, owner_id, meta));
  });

  app.get(`${API}/attachments`, async (req) => {
    const q = parse(z.object({ owner_type: z.enum(OWNER_TYPES), owner_id: z.string().min(1).max(100) }), req.query);
    return { items: await listAttachments(s, await actor(req), q.owner_type, q.owner_id), next_cursor: null };
  });

  app.put(`${API}/attachments/:id/content`, { bodyLimit: MAX_UPLOAD_BYTES }, async (req) => {
    const a = await actor(req);
    const body = req.body;
    const bytes = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : null;
    if (!bytes) throw invalid('Send the file as application/octet-stream');
    return uploadAttachmentContent(s, a, parse(uuid, param(req, 'id')), bytes);
  });

  app.post(`${API}/attachments/:id/download-link`, async (req) => issueDownloadLink(s, await actor(req), param(req, 'id')));

  // Authorized by the short-lived signed link rather than a bearer token.
  app.get(`${API}/attachments/:id/content`, async (req, reply) => {
    const q = req.query as { exp?: string; u?: string; sig?: string };
    const file = await openSignedDownload(s, param(req, 'id'), q);
    return reply
      .header('content-type', file.media_type)
      .header('content-length', String(file.size))
      .header('content-disposition', `attachment; filename="${file.file_name.replace(/[^\w.\- ]/g, '_')}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(file.stream);
  });
}
