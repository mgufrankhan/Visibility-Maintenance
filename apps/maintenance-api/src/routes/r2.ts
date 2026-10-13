import {
  automationPolicyRequest,
  cmmsExceptionResolveRequest,
  createPartRequest,
  createStoreRequest,
  siteAuthorityRequest,
  stockAdjustRequest,
  stockIssueRequest,
  stockReceiveRequest,
  stockReserveRequest,
  stockReturnRequest,
  uuid,
} from '@vm/contracts';
import {
  adjustStock,
  createPart,
  createStore,
  getSiteAuthority,
  issueStock,
  listAutomationPolicies,
  listBalances,
  listCmmsExceptions,
  listMovements,
  listParts,
  listStores,
  receiveStock,
  reserveStock,
  resolveCmmsException,
  returnStock,
  setSiteAuthority,
  upsertAutomationPolicy,
} from '@vm/core';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

export function registerR2Routes({ app, s, actor }: RouteDeps): void {
  // ---- Parts / stores ----
  app.get(`${API}/stores`, async (req) => {
    const q = parse(z.object({ site_id: uuid.optional() }), req.query);
    return { items: await listStores(s, await actor(req), q.site_id), next_cursor: null };
  });
  app.post(`${API}/stores`, async (req, reply) =>
    reply.status(201).send(await createStore(s, await actor(req), parse(createStoreRequest, req.body))),
  );
  app.get(`${API}/parts`, async (req) => ({ items: await listParts(s, await actor(req)), next_cursor: null }));
  app.post(`${API}/parts`, async (req, reply) =>
    reply.status(201).send(await createPart(s, await actor(req), parse(createPartRequest, req.body))),
  );
  app.get(`${API}/stores/:id/balances`, async (req) => ({
    items: await listBalances(s, await actor(req), param(req, 'id')),
    next_cursor: null,
  }));
  app.get(`${API}/stock-movements`, async (req) => {
    const q = parse(
      z.object({
        store_id: uuid.optional(),
        work_order_id: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return { items: await listMovements(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/stock/receive`, async (req, reply) =>
    reply.status(201).send(await receiveStock(s, await actor(req), parse(stockReceiveRequest, req.body))),
  );
  app.post(`${API}/stock/issue`, async (req, reply) =>
    reply.status(201).send(await issueStock(s, await actor(req), parse(stockIssueRequest, req.body))),
  );
  app.post(`${API}/stock/return`, async (req, reply) =>
    reply.status(201).send(await returnStock(s, await actor(req), parse(stockReturnRequest, req.body))),
  );
  app.post(`${API}/stock/adjust`, async (req, reply) =>
    reply.status(201).send(await adjustStock(s, await actor(req), parse(stockAdjustRequest, req.body))),
  );
  app.post(`${API}/stock/reservations`, async (req, reply) =>
    reply.status(201).send(await reserveStock(s, await actor(req), parse(stockReserveRequest, req.body))),
  );

  // ---- CMMS authority ----
  app.get(`${API}/sites/:siteId/authority`, async (req) => getSiteAuthority(s, await actor(req), param(req, 'siteId')));
  app.put(`${API}/sites/:siteId/authority`, async (req) => {
    const body = parse(siteAuthorityRequest, { ...((req.body as object) ?? {}), site_id: param(req, 'siteId') });
    return setSiteAuthority(s, await actor(req), body);
  });
  app.get(`${API}/cmms-exceptions`, async (req) => {
    const q = parse(z.object({ site_id: uuid, status: z.enum(['open', 'resolved', 'ignored', 'all']).default('open') }), req.query);
    return { items: await listCmmsExceptions(s, await actor(req), q.site_id, q.status), next_cursor: null };
  });
  app.post(`${API}/cmms-exceptions/:id/resolve`, async (req) =>
    resolveCmmsException(s, await actor(req), param(req, 'id'), parse(cmmsExceptionResolveRequest, req.body)),
  );

  // ---- Automation ----
  app.get(`${API}/automation-policies`, async (req) => {
    const q = parse(z.object({ site_id: uuid }), req.query);
    return { items: await listAutomationPolicies(s, await actor(req), q.site_id), next_cursor: null };
  });
  app.put(`${API}/automation-policies`, async (req) =>
    upsertAutomationPolicy(s, await actor(req), parse(automationPolicyRequest, req.body)),
  );
}
