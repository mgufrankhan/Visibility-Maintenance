import {
  checkExceptionRequest,
  commentRequest,
  completionSignatureRequest,
  createProcedureRequest,
  createWorkOrderRequest,
  linkChildRequest,
  laborEntryRequest,
  pageQuery,
  patchWorkOrderRequest,
  priority,
  procedureRevisionRequest,
  taskResultRequest,
  transitionRequest,
  uuid,
  WORK_ORDER_STATES,
} from '@vm/contracts';
import {
  addComment,
  addLaborEntry,
  addProcedureRevision,
  createProcedure,
  createWorkOrder,
  getProcedureRevision,
  linkShutdownChild,
  getWorkOrder,
  grantCheckException,
  listProcedures,
  listWorkOrders,
  patchWorkOrder,
  publishProcedureRevision,
  recordTaskResults,
  setLaborRate,
  signWorkOrder,
  transitionWorkOrder,
  unlinkShutdownChild,
} from '@vm/core';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, expectedVersion, idempotencyKey, param, type RouteDeps } from '../http.ts';

const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item)).optional();

const workOrderListQuery = pageQuery.extend({
  site_id: uuid.optional(),
  state: csv(z.enum(WORK_ORDER_STATES)),
  assignee: z.union([z.literal('me'), uuid]).optional(),
  my_work: z.stringbool().optional(),
  team_id: uuid.optional(),
  asset_id: z.string().max(100).optional(),
  priority: priority.optional(),
  type: z.enum(['corrective', 'preventive', 'inspection', 'follow_up']).optional(),
  unassigned: z.stringbool().optional(),
  overdue: z.stringbool().optional(),
  q: z.string().max(200).optional(),
});

const laborRateRequest = z.object({
  user_id: uuid,
  hourly_rate: z.number().nonnegative().max(1_000_000),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  effective_from: z.iso.datetime({ offset: true }),
});

export function registerWorkRoutes({ app, s, actor }: RouteDeps): void {
  // ---- Procedures ----
  app.get(`${API}/procedures`, async (req) => {
    const q = parse(z.object({ site_id: uuid.optional() }), req.query);
    return { items: await listProcedures(s, await actor(req), q.site_id), next_cursor: null };
  });
  app.post(`${API}/procedures`, async (req, reply) => reply.status(201).send(await createProcedure(s, await actor(req), parse(createProcedureRequest, req.body))));
  app.post(`${API}/procedures/:id/revisions`, async (req, reply) =>
    reply.status(201).send(await addProcedureRevision(s, await actor(req), param(req, 'id'), parse(procedureRevisionRequest, req.body))),
  );
  app.get(`${API}/procedure-revisions/:id`, async (req) => getProcedureRevision(s, await actor(req), param(req, 'id')));
  app.post(`${API}/procedure-revisions/:id/publish`, async (req) => publishProcedureRevision(s, await actor(req), param(req, 'id')));

  // ---- Work orders ----
  app.get(`${API}/work-orders`, async (req) => listWorkOrders(s, await actor(req), parse(workOrderListQuery, req.query)));
  app.get(`${API}/my-work`, async (req) => {
    const q = parse(pageQuery.extend({ site_id: uuid.optional() }), req.query);
    return listWorkOrders(s, await actor(req), { ...q, my_work: true });
  });
  app.post(`${API}/work-orders`, async (req, reply) => {
    const r = await createWorkOrder(s, await actor(req), parse(createWorkOrderRequest, req.body), idempotencyKey(req));
    return reply.status(r.status).send(r.body);
  });
  app.get(`${API}/work-orders/:id`, async (req, reply) => {
    const wo = await getWorkOrder(s, await actor(req), param(req, 'id'));
    return reply.header('etag', `"${wo.version}"`).send(wo);
  });
  app.patch(`${API}/work-orders/:id`, async (req, reply) => {
    const body = parse(patchWorkOrderRequest.extend({ record_version: z.number().int().positive().optional() }), req.body);
    const { record_version, ...patch } = body;
    const wo = await patchWorkOrder(s, await actor(req), param(req, 'id'), expectedVersion(req, record_version), patch);
    return reply.header('etag', `"${wo.version}"`).send(wo);
  });
  app.post(`${API}/work-orders/:id/children`, async (req, reply) => {
    const body = parse(linkChildRequest, req.body);
    const r = await linkShutdownChild(s, await actor(req), param(req, 'id'), body.work_order_id);
    return reply.status(r.status).send(r.body);
  });
  app.delete(`${API}/work-orders/:id/children/:childId`, async (req) =>
    unlinkShutdownChild(s, await actor(req), param(req, 'id'), param(req, 'childId')),
  );
  app.post(`${API}/work-orders/:id/signature`, async (req) =>
    signWorkOrder(s, await actor(req), param(req, 'id'), parse(completionSignatureRequest, req.body)),
  );
  app.post(`${API}/work-orders/:id/transitions`, async (req, reply) => {
    const r = await transitionWorkOrder(s, await actor(req), param(req, 'id'), parse(transitionRequest, req.body), idempotencyKey(req));
    return reply.status(r.status).send(r.body);
  });

  // ---- Execution ----
  app.post(`${API}/work-orders/:id/results`, async (req, reply) =>
    reply.status(201).send(await recordTaskResults(s, await actor(req), param(req, 'id'), parse(taskResultRequest, req.body))),
  );
  app.post(`${API}/work-orders/:id/check-exceptions`, async (req, reply) =>
    reply.status(201).send(await grantCheckException(s, await actor(req), param(req, 'id'), parse(checkExceptionRequest, req.body))),
  );
  app.post(`${API}/work-orders/:id/labor`, async (req, reply) =>
    reply.status(201).send(await addLaborEntry(s, await actor(req), param(req, 'id'), parse(laborEntryRequest, req.body))),
  );
  app.post(`${API}/work-orders/:id/comments`, async (req, reply) =>
    reply.status(201).send(await addComment(s, await actor(req), param(req, 'id'), parse(commentRequest, req.body))),
  );

  app.post(`${API}/sites/:siteId/labor-rates`, async (req, reply) =>
    reply.status(201).send(await setLaborRate(s, await actor(req), param(req, 'siteId'), parse(laborRateRequest, req.body))),
  );
}
