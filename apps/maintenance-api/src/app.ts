import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { loadPrincipal, type Actor, type Services } from '@vm/core';
import { createTokenVerifier, registerErrorHandling, type TokenVerifierOptions } from '@vm/server-kit';
import { registerFoundationRoutes } from './routes/foundation.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerRequestRoutes } from './routes/requests.ts';
import { registerWorkRoutes } from './routes/work.ts';
import { registerPlanningRoutes } from './routes/planning.ts';
import { registerReliabilityRoutes } from './routes/reliability.ts';
import { registerIntegrationRoutes } from './routes/integrations.ts';
import { registerMonitoringRoutes } from './routes/monitoring.ts';
import { registerNeoRoutes } from './routes/neo.ts';
import { registerR2Routes } from './routes/r2.ts';

export interface MaintenanceAppOptions {
  services: Services;
  auth: TokenVerifierOptions;
  logger?: boolean;
  /** Optional components report health separately and never fail core readiness. */
  optionalHealth?: Record<string, () => Promise<'ok' | 'degraded' | 'unavailable' | 'disabled'>>;
  /** Bearer token accepted by /health/details in addition to administrator sessions. */
  monitoringToken?: string;
}

export async function buildMaintenanceApp(opts: MaintenanceAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  registerErrorHandling(app);
  const verify = createTokenVerifier({ ...opts.auth, audience: 'visibility-maintenance' });
  const s = opts.services;

  const actor = async (req: FastifyRequest): Promise<Actor> => {
    const claims = await verify(req.headers.authorization);
    const principal = await loadPrincipal(s.db, claims);
    return { principal, token: req.headers.authorization!.slice(7).trim(), correlationId: req.correlationId };
  };

  const deps = { app, s, actor };
  registerHealthRoutes(deps, opts.optionalHealth ?? {}, opts.monitoringToken);
  registerFoundationRoutes(deps);
  registerRequestRoutes(deps);
  registerWorkRoutes(deps);
  registerPlanningRoutes(deps);
  registerReliabilityRoutes(deps);
  registerIntegrationRoutes(deps);
  registerMonitoringRoutes(deps);
  registerNeoRoutes(deps);
  registerR2Routes(deps);
  registerAttachmentRoutes(deps);
  return app;
}
