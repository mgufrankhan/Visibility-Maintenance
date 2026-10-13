import { neoAskRequest, recommendationDecisionRequest } from '@vm/contracts';
import { askNeo, decideRecommendation, getNeoRun, listRecommendations } from '@vm/core';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

export function registerNeoRoutes({ app, s, actor }: RouteDeps): void {
  app.post(`${API}/neo/ask`, async (req, reply) => reply.status(201).send(await askNeo(s, await actor(req), parse(neoAskRequest, req.body))));
  app.get(`${API}/neo/runs/:id`, async (req) => getNeoRun(s, await actor(req), param(req, 'id')));
  app.get(`${API}/recommendations`, async (req) => {
    const q = parse(z.object({ site_id: z.string().uuid().optional(), status: z.enum(['pending', 'approved', 'rejected', 'invalidated']).optional() }), req.query);
    return { items: await listRecommendations(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/recommendations/:id/decisions`, async (req) =>
    decideRecommendation(s, await actor(req), param(req, 'id'), parse(recommendationDecisionRequest, req.body)),
  );
}
