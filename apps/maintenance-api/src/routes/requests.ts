import { createRequestRequest, pageQuery, REQUEST_STATES, triageRequest, uuid } from '@vm/contracts';
import {
  acknowledgeNotification,
  createRequest,
  getRequest,
  listNotifications,
  listOutboxExceptions,
  listRequests,
  requireTenantPermission,
  retryOutboxEvent,
  triageRequest as triage,
} from '@vm/core';
import { notFound, parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, idempotencyKey, param, type RouteDeps } from '../http.ts';

const requestListQuery = pageQuery.extend({
  site_id: uuid.optional(),
  state: z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(z.enum(REQUEST_STATES))).optional(),
  asset_id: z.string().max(100).optional(),
  mine: z.stringbool().optional(),
});

export function registerRequestRoutes({ app, s, actor }: RouteDeps): void {
  app.post(`${API}/requests`, async (req, reply) => {
    const r = await createRequest(s, await actor(req), parse(createRequestRequest, req.body), idempotencyKey(req));
    return reply.status(r.status).send(r.body);
  });
  app.get(`${API}/requests`, async (req) => listRequests(s, await actor(req), parse(requestListQuery, req.query)));
  app.get(`${API}/requests/:id`, async (req) => getRequest(s, await actor(req), param(req, 'id')));
  app.post(`${API}/requests/:id/triage`, async (req, reply) => {
    const r = await triage(s, await actor(req), param(req, 'id'), parse(triageRequest, req.body), idempotencyKey(req));
    return reply.status(r.status).send(r.body);
  });

  app.get(`${API}/notifications`, async (req) => {
    const q = parse(z.object({ unread: z.stringbool().default(false) }), req.query);
    return { items: await listNotifications(s, await actor(req), q.unread), next_cursor: null };
  });
  app.post(`${API}/notifications/:id/acknowledge`, async (req, reply) => {
    await acknowledgeNotification(s, await actor(req), param(req, 'id'));
    return reply.status(204).send();
  });

  app.get(`${API}/admin/outbox/failed`, async (req) => {
    const a = await actor(req);
    requireTenantPermission(a.principal, 'maintenance.settings.manage');
    return { items: await listOutboxExceptions(s, a), next_cursor: null };
  });
  app.post(`${API}/admin/outbox/:eventId/retry`, async (req, reply) => {
    const a = await actor(req);
    requireTenantPermission(a.principal, 'maintenance.settings.manage');
    if (!(await retryOutboxEvent(s, a, param(req, 'eventId')))) throw notFound('Failed event');
    return reply.status(202).send({ status: 'pending' });
  });
}
