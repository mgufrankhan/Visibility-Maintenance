import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { checkRegistryBinding, operationalHealth, requireTenantPermission } from '@vm/core';
import { BUILD_VERSION } from '@vm/contracts';
import type { RouteDeps } from '../http.ts';

type Probe = () => Promise<'ok' | 'degraded' | 'unavailable' | 'disabled'>;

function digest(v: string): Buffer {
  return createHash('sha256').update(v).digest();
}

export function registerHealthRoutes({ app, s, actor }: RouteDeps, optional: Record<string, Probe>, monitoringToken: string | undefined): void {
  app.get('/health/live', async () => ({ status: 'ok' }));

  /** Core readiness depends only on core components; optional adapters are reported separately. */
  app.get('/health/ready', async (_req, reply) => {
    const core: Record<string, string> = {};
    try {
      await s.db.query('SELECT 1');
      core.database = 'ok';
    } catch {
      core.database = 'unavailable';
    }
    const optionalStatus: Record<string, string> = {};
    for (const [name, probe] of Object.entries(optional)) {
      optionalStatus[name] = await probe().catch(() => 'unavailable' as const);
    }
    const ready = Object.values(core).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', core, optional: optionalStatus });
  });

  /** Operational detail for administrators or a monitoring agent holding the configured token. */
  const authorizeDetails = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (monitoringToken && typeof header === 'string' && header.startsWith('Bearer ')) {
      if (timingSafeEqual(digest(header.slice(7).trim()), digest(monitoringToken))) return;
    }
    requireTenantPermission((await actor(req)).principal, 'maintenance.settings.manage');
  };

  app.get('/health/details', async (req) => {
    await authorizeDetails(req);
    const [ops, registry] = await Promise.all([operationalHealth(s), checkRegistryBinding(s, { bind: false })]);
    return { build_version: BUILD_VERSION, blob_store: s.blobs.kind, registry, ...ops };
  });
}
