import {
  createConnectorRequest,
  createMappingRequest,
  discoveryReport,
  healthReport,
  ingestBatchRequest,
  recordStatusRequest,
  resolveReviewItemRequest,
  startCutoverRequest,
} from '@vm/contracts';
import {
  activateMapping,
  approveMapping,
  connectorHealthSummary,
  connectorRuntimeConfig,
  createConnector,
  createMapping,
  getConnector,
  ingestEvents,
  listConnectors,
  listReceipts,
  listReviewItems,
  pauseMapping,
  previewMapping,
  reportConnectorHealth,
  reportDiscovery,
  resolveReviewItem,
  rollbackCutover,
  setConnectorStatus,
  startCutover,
} from '@vm/core';
import { COMPATIBILITY_MATRIX } from '@vm/connectors';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

export function registerIntegrationRoutes({ app, s, actor }: RouteDeps): void {
  app.get(`${API}/connectors/compatibility`, async () => ({ items: COMPATIBILITY_MATRIX }));
  app.get(`${API}/connectors`, async (req) => {
    const q = parse(z.object({ site_id: z.string().uuid().optional() }), req.query);
    return { items: await listConnectors(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/connectors`, async (req, reply) => reply.status(201).send(await createConnector(s, await actor(req), parse(createConnectorRequest, req.body))));
  app.get(`${API}/connectors/:id`, async (req) => getConnector(s, await actor(req), param(req, 'id')));
  app.get(`${API}/connectors/:id/health`, async (req) => connectorHealthSummary(s, await actor(req), param(req, 'id')));
  app.get(`${API}/connectors/:id/config`, async (req) => connectorRuntimeConfig(s, await actor(req), param(req, 'id')));
  app.get(`${API}/connectors/:id/receipts`, async (req) => {
    const q = parse(z.object({ decision: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return { items: await listReceipts(s, await actor(req), param(req, 'id'), q), next_cursor: null };
  });
  app.post(`${API}/connectors/:id/activate`, async (req) => setConnectorStatus(s, await actor(req), param(req, 'id'), 'active', parse(recordStatusRequest, req.body)));
  app.post(`${API}/connectors/:id/pause`, async (req) => setConnectorStatus(s, await actor(req), param(req, 'id'), 'paused', parse(recordStatusRequest, req.body)));
  app.post(`${API}/connectors/:id/disable`, async (req) => setConnectorStatus(s, await actor(req), param(req, 'id'), 'disabled', parse(recordStatusRequest, req.body)));

  app.post(`${API}/connectors/:id/mappings`, async (req, reply) =>
    reply.status(201).send(await createMapping(s, await actor(req), param(req, 'id'), parse(createMappingRequest, req.body))),
  );
  app.post(`${API}/mappings/:id/preview`, async (req) => previewMapping(s, await actor(req), param(req, 'id')));
  app.post(`${API}/mappings/:id/approve`, async (req) => approveMapping(s, await actor(req), param(req, 'id'), parse(recordStatusRequest, req.body)));
  app.post(`${API}/mappings/:id/activate`, async (req) => activateMapping(s, await actor(req), param(req, 'id'), parse(recordStatusRequest, req.body)));
  app.post(`${API}/mappings/:id/pause`, async (req) => pauseMapping(s, await actor(req), param(req, 'id'), parse(recordStatusRequest, req.body)));
  app.post(`${API}/mappings/:id/cutover`, async (req) => startCutover(s, await actor(req), param(req, 'id'), parse(startCutoverRequest, req.body)));
  app.post(`${API}/cutovers/:id/rollback`, async (req) => rollbackCutover(s, await actor(req), param(req, 'id'), parse(recordStatusRequest, req.body)));

  app.get(`${API}/review-items`, async (req) => {
    const q = parse(z.object({ site_id: z.string().uuid().optional(), connector_id: z.string().uuid().optional(), status: z.enum(['open', 'resolved', 'dismissed']).optional() }), req.query);
    return { items: await listReviewItems(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/review-items/:id/resolve`, async (req) => resolveReviewItem(s, await actor(req), param(req, 'id'), parse(resolveReviewItemRequest, req.body)));

  app.post(`${API}/integrations/events`, async (req) => ingestEvents(s, await actor(req), parse(ingestBatchRequest, req.body)));
  app.post(`${API}/integrations/discovery`, async (req) => reportDiscovery(s, await actor(req), parse(discoveryReport, req.body)));
  app.post(`${API}/integrations/health`, async (req) => reportConnectorHealth(s, await actor(req), parse(healthReport, req.body)));
}
