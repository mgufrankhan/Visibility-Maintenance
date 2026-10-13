import {
  conditionRuleRevisionRequest,
  createConditionRuleRequest,
  createMeterRequest,
  manualMeterReadingRequest,
  meterBaselineRequest,
  recordStatusRequest,
} from '@vm/contracts';
import {
  addRuleRevision,
  closeIncident,
  createConditionRule,
  createMeter,
  getIncident,
  getMeter,
  listConditionRules,
  listIncidents,
  listMeters,
  publishRuleRevision,
  recordManualReading,
  recordMeterBaseline,
} from '@vm/core';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

export function registerMonitoringRoutes({ app, s, actor }: RouteDeps): void {
  app.get(`${API}/condition-rules`, async (req) => {
    const q = parse(z.object({ site_id: z.string().uuid().optional(), asset_id: z.string().max(100).optional() }), req.query);
    return { items: await listConditionRules(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/condition-rules`, async (req, reply) => reply.status(201).send(await createConditionRule(s, await actor(req), parse(createConditionRuleRequest, req.body))));
  app.post(`${API}/condition-rules/:id/revisions`, async (req, reply) =>
    reply.status(201).send(await addRuleRevision(s, await actor(req), param(req, 'id'), parse(conditionRuleRevisionRequest, req.body))),
  );
  app.post(`${API}/condition-rule-revisions/:id/publish`, async (req) => publishRuleRevision(s, await actor(req), param(req, 'id')));

  app.get(`${API}/incidents`, async (req) => {
    const q = parse(z.object({ site_id: z.string().uuid().optional(), asset_id: z.string().max(100).optional(), status: z.enum(['open', 'recovered', 'closed']).optional() }), req.query);
    return { items: await listIncidents(s, await actor(req), q), next_cursor: null };
  });
  app.get(`${API}/incidents/:id`, async (req) => getIncident(s, await actor(req), param(req, 'id')));
  app.post(`${API}/incidents/:id/close`, async (req) => closeIncident(s, await actor(req), param(req, 'id'), parse(recordStatusRequest, req.body)));

  app.get(`${API}/meters`, async (req) => {
    const q = parse(z.object({ site_id: z.string().uuid().optional(), asset_id: z.string().max(100).optional() }), req.query);
    return { items: await listMeters(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/meters`, async (req, reply) => reply.status(201).send(await createMeter(s, await actor(req), parse(createMeterRequest, req.body))));
  app.get(`${API}/meters/:id`, async (req) => getMeter(s, await actor(req), param(req, 'id')));
  app.post(`${API}/meters/:id/readings`, async (req) => recordManualReading(s, await actor(req), param(req, 'id'), parse(manualMeterReadingRequest, req.body)));
  app.post(`${API}/meters/:id/baselines`, async (req) => recordMeterBaseline(s, await actor(req), param(req, 'id'), parse(meterBaselineRequest, req.body)));
}
