import {
  createInspectionTemplateRequest,
  createPlanRequest,
  inspectionRevisionRequest,
  planRevisionRequest,
  planStatusRequest,
  startInspectionRequest,
  submitInspectionRequest,
  uuid,
} from '@vm/contracts';
import {
  addInspectionRevision,
  addPlanRevision,
  createInspectionTemplate,
  createPlan,
  getInspectionResult,
  getPlan,
  listInspectionResults,
  listInspectionTemplates,
  listPlans,
  previewPlanRevision,
  publishInspectionTemplate,
  publishPlanRevision,
  setPlanPaused,
  startInspection,
  submitInspection,
} from '@vm/core';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

export function registerPlanningRoutes({ app, s, actor }: RouteDeps): void {
  // ---- PM plans ----
  app.get(`${API}/plans`, async (req) => {
    const q = parse(z.object({ site_id: uuid.optional(), asset_id: z.string().max(100).optional(), status: z.enum(['draft', 'active', 'paused', 'archived']).optional() }), req.query);
    return { items: await listPlans(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/plans`, async (req, reply) => reply.status(201).send(await createPlan(s, await actor(req), parse(createPlanRequest, req.body))));
  app.get(`${API}/plans/:id`, async (req) => getPlan(s, await actor(req), param(req, 'id')));
  app.post(`${API}/plans/:id/revisions`, async (req, reply) =>
    reply.status(201).send(await addPlanRevision(s, await actor(req), param(req, 'id'), parse(planRevisionRequest, req.body))),
  );
  app.get(`${API}/plan-revisions/:id/preview`, async (req) => {
    const q = parse(z.object({ count: z.coerce.number().int().min(1).max(50).default(6) }), req.query);
    return { items: await previewPlanRevision(s, await actor(req), param(req, 'id'), q.count) };
  });
  app.post(`${API}/plan-revisions/:id/publish`, async (req) => publishPlanRevision(s, await actor(req), param(req, 'id')));
  app.post(`${API}/plans/:id/pause`, async (req) => setPlanPaused(s, await actor(req), param(req, 'id'), true, parse(planStatusRequest, req.body)));
  app.post(`${API}/plans/:id/resume`, async (req) => setPlanPaused(s, await actor(req), param(req, 'id'), false, parse(planStatusRequest, req.body)));

  // ---- Inspections ----
  app.get(`${API}/inspection-templates`, async (req) => {
    const q = parse(z.object({ site_id: uuid.optional() }), req.query);
    return { items: await listInspectionTemplates(s, await actor(req), q.site_id), next_cursor: null };
  });
  app.post(`${API}/inspection-templates`, async (req, reply) =>
    reply.status(201).send(await createInspectionTemplate(s, await actor(req), parse(createInspectionTemplateRequest, req.body))),
  );
  app.post(`${API}/inspection-templates/:id/revisions`, async (req, reply) =>
    reply.status(201).send(await addInspectionRevision(s, await actor(req), param(req, 'id'), parse(inspectionRevisionRequest, req.body))),
  );
  app.post(`${API}/inspection-templates/:id/publish`, async (req) => publishInspectionTemplate(s, await actor(req), param(req, 'id')));

  app.get(`${API}/inspection-results`, async (req) => {
    const q = parse(z.object({ site_id: uuid.optional(), asset_id: z.string().max(100).optional(), passed: z.stringbool().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return { items: await listInspectionResults(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/inspection-results`, async (req, reply) => {
    const r = await startInspection(s, await actor(req), parse(startInspectionRequest, req.body));
    return reply.status(r.status).send(r.body);
  });
  app.get(`${API}/inspection-results/:id`, async (req) => getInspectionResult(s, await actor(req), param(req, 'id')));
  app.post(`${API}/inspection-results/:id/submit`, async (req) => submitInspection(s, await actor(req), param(req, 'id'), parse(submitInspectionRequest, req.body)));
}
