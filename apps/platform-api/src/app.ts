import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { BUILD_VERSION, PLATFORM_API_VERSION, type PlatformMeta } from '@vm/contracts';
import type { Db } from '@vm/db';
import { createTokenVerifier, registerErrorHandling, systemClock, type Clock } from '@vm/server-kit';
import type { PlatformConfig } from './config.ts';
import { registerIdentityRoutes } from './identity.ts';
import type { SigningKey } from './keys.ts';
import { loadPrincipal, type PlatformPrincipal } from './principal.ts';
import { registerRegistryRoutes } from './registry.ts';

export interface PlatformAppOptions {
  db: Db;
  config: PlatformConfig;
  key: SigningKey;
  clock?: Clock;
  logger?: boolean;
}

export async function buildPlatformApp(opts: PlatformAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { redact: ['req.headers.authorization', 'req.body.password', 'req.body.client_secret'] } : false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });
  registerErrorHandling(app);
  const clock = opts.clock ?? systemClock;
  const verify = createTokenVerifier({
    issuer: opts.config.issuer,
    audience: 'visibility-platform',
    jwks: { keys: [opts.key.publicJwk] },
  });
  const authenticate = async (req: FastifyRequest): Promise<PlatformPrincipal> => {
    const claims = await verify(req.headers.authorization);
    return loadPrincipal(opts.db, claims.tid, claims.sub);
  };

  app.get('/api/v1/meta', async (): Promise<PlatformMeta> => {
    const { rows } = await opts.db.query<{ registry_id: string }>(`SELECT registry_id FROM platform.installation`);
    if (!rows[0]) throw new Error('Platform installation identity missing; run migrations');
    return { service: 'visibility-platform', api_version: PLATFORM_API_VERSION, build_version: BUILD_VERSION, registry_id: rows[0].registry_id };
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await opts.db.query('SELECT 1');
      return { status: 'ready', components: { database: 'ok' } };
    } catch {
      return reply.status(503).send({ status: 'not_ready', components: { database: 'unavailable' } });
    }
  });

  registerIdentityRoutes(app, { db: opts.db, config: opts.config, key: opts.key, clock, authenticate });
  registerRegistryRoutes(app, { db: opts.db, authenticate });
  return app;
}
