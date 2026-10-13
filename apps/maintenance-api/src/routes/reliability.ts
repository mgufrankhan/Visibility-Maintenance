import {
  amendDowntimeRequest,
  createDowntimeRequest,
  exposureRequest,
  externalCostRequest,
  failureLinkRequest,
  isoTimestamp,
  restoreDowntimeRequest,
  uuid,
} from '@vm/contracts';
import {
  addExternalCost,
  amendDowntime,
  applySyncOperations,
  createDowntime,
  EXPORT_DATASETS,
  exportDataset,
  getDowntime,
  linkFailure,
  listDowntime,
  recordExposure,
  REPORT_METRICS,
  restoreDowntime,
  runReport,
  SYNC_OPERATION_TYPES,
  syncChanges,
} from '@vm/core';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

const periodQuery = z.object({ site_id: uuid, from: isoTimestamp, to: isoTimestamp, asset_id: uuid.optional() });

const syncOperationsBody = z.object({
  operations: z
    .array(
      z.object({
        client_op_id: z.string().min(1).max(100),
        type: z.enum(SYNC_OPERATION_TYPES),
        record_id: z.string().max(100).nullable().default(null),
        base_version: z.number().int().positive().nullable().default(null),
        client_time: isoTimestamp,
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(100),
});

export function registerReliabilityRoutes({ app, s, actor }: RouteDeps): void {
  // ---- Downtime ----
  app.get(`${API}/downtime-events`, async (req) => {
    const q = parse(
      z.object({ site_id: uuid.optional(), asset_id: z.string().max(100).optional(), from: isoTimestamp.optional(), to: isoTimestamp.optional(), open: z.stringbool().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );
    return { items: await listDowntime(s, await actor(req), q), next_cursor: null };
  });
  app.post(`${API}/downtime-events`, async (req, reply) => {
    const r = await createDowntime(s, await actor(req), parse(createDowntimeRequest, req.body));
    return reply.status(r.status).send(r.body);
  });
  app.get(`${API}/downtime-events/:id`, async (req) => getDowntime(s, await actor(req), param(req, 'id')));
  app.post(`${API}/downtime-events/:id/restore`, async (req) => restoreDowntime(s, await actor(req), param(req, 'id'), parse(restoreDowntimeRequest, req.body)));
  app.post(`${API}/downtime-events/:id/amendments`, async (req, reply) =>
    reply.status(201).send(await amendDowntime(s, await actor(req), param(req, 'id'), parse(amendDowntimeRequest, req.body))),
  );
  app.post(`${API}/work-orders/:id/failure-links`, async (req, reply) =>
    reply.status(201).send(await linkFailure(s, await actor(req), param(req, 'id'), parse(failureLinkRequest, req.body).failure_event_id)),
  );
  app.post(`${API}/work-orders/:id/external-costs`, async (req, reply) =>
    reply.status(201).send(await addExternalCost(s, await actor(req), param(req, 'id'), parse(externalCostRequest, req.body))),
  );
  app.post(`${API}/operating-exposure`, async (req, reply) => reply.status(201).send(await recordExposure(s, await actor(req), parse(exposureRequest, req.body))));

  // ---- Reports and exports ----
  app.get(`${API}/reports/:metric`, async (req) => {
    const metric = parse(z.enum(REPORT_METRICS), param(req, 'metric'));
    return runReport(s, await actor(req), metric, parse(periodQuery, req.query));
  });
  app.get(`${API}/exports/:dataset`, async (req, reply) => {
    const dataset = parse(z.enum(EXPORT_DATASETS), param(req, 'dataset').replace(/\.csv$/, ''));
    const q = parse(periodQuery.omit({ asset_id: true }), req.query);
    const out = await exportDataset(s, await actor(req), dataset, q);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${out.filename}"`)
      .header('cache-control', 'private, no-store')
      .send(out.csv);
  });

  // ---- Offline sync ----
  app.get(`${API}/sync/changes`, async (req) => {
    const q = parse(z.object({ cursor: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    return syncChanges(s, await actor(req), q.cursor, q.limit);
  });
  app.post(`${API}/sync/operations`, async (req) => {
    const body = parse(syncOperationsBody, req.body);
    return { results: await applySyncOperations(s, await actor(req), body.operations) };
  });
}
