import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import { withTransaction, type Db, type Queryable } from '@vm/db';
import {
  createServiceAccountRequest,
  createSiteRequest,
  createUserRequest,
  loginRequest,
  membershipRequest,
  platformRoleRequest,
  tokenRequest,
  type SiteDto,
  type TokenResponse,
  type UserDto,
} from '@vm/contracts';
import {
  AppError,
  conflict,
  hashSecret,
  invalid,
  newOpaqueToken,
  notFound,
  parse,
  sha256,
  unauthorized,
  verifySecret,
  type Clock,
} from '@vm/server-kit';
import type { PlatformConfig } from './config.ts';
import type { SigningKey } from './keys.ts';
import { audit } from './audit.ts';
import { canReadSite, loadPrincipal, requireTenantAdmin, type PlatformPrincipal } from './principal.ts';

export interface IdentityDeps {
  db: Db;
  config: PlatformConfig;
  key: SigningKey;
  clock: Clock;
  authenticate: (req: FastifyRequest) => Promise<PlatformPrincipal>;
}

// Constant-cost dummy hash so unknown accounts take as long as wrong passwords.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function issueAccessToken(deps: Pick<IdentityDeps, 'config' | 'key' | 'clock'>, p: PlatformPrincipal): Promise<string> {
  const now = Math.floor(deps.clock.now().getTime() / 1000);
  return new SignJWT({
    tid: p.tenantId,
    kind: p.kind,
    name: p.displayName,
    ...(p.email ? { email: p.email } : {}),
    sites: p.siteIds,
    proles: p.roles.map((r) => ({ r: r.role, s: r.siteId })),
  })
    .setProtectedHeader({ alg: 'ES256', kid: deps.key.kid, typ: 'JWT' })
    .setIssuer(deps.config.issuer)
    .setAudience(deps.config.audiences)
    .setSubject(p.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + deps.config.accessTokenTtlSeconds)
    .setJti(randomUUID())
    .sign(deps.key.privateKey);
}

async function issueRefreshToken(db: Queryable, deps: IdentityDeps, p: PlatformPrincipal): Promise<string> {
  const { token, hash } = newOpaqueToken();
  const expires = new Date(deps.clock.now().getTime() + deps.config.refreshTokenTtlSeconds * 1000);
  await db.query(
    `INSERT INTO platform.refresh_token (id, tenant_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), p.tenantId, p.userId, hash, expires],
  );
  return token;
}

async function userDto(db: Queryable, tenantId: string, userId: string): Promise<UserDto> {
  const { rows } = await db.query(
    `SELECT u.id, u.tenant_id, u.kind, u.email, u.display_name, u.status,
            coalesce((SELECT array_agg(site_id ORDER BY site_id) FROM platform.site_membership m WHERE m.user_id = u.id), '{}') AS site_ids,
            coalesce((SELECT json_agg(json_build_object('role', role, 'site_id', site_id)) FROM platform.platform_role r WHERE r.user_id = u.id), '[]') AS platform_roles
       FROM platform.user_account u WHERE u.tenant_id = $1 AND u.id = $2`,
    [tenantId, userId],
  );
  if (!rows[0]) throw notFound('User');
  return rows[0] as UserDto;
}

function siteDto(r: Record<string, unknown>): SiteDto {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    code: r.code as string,
    name: r.name as string,
    timezone: r.timezone as string,
    status: r.status as SiteDto['status'],
    version: r.version as number,
  };
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  const { db } = deps;

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: deps.config.issuer,
    jwks_uri: `${deps.config.issuer}/api/v1/identity/jwks`,
    token_endpoint: `${deps.config.issuer}/api/v1/identity/token`,
    grant_types_supported: ['refresh_token', 'client_credentials'],
    id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    claims_supported: ['sub', 'tid', 'kind', 'name', 'email', 'sites', 'proles'],
  }));

  app.get('/api/v1/identity/jwks', async () => ({ keys: [deps.key.publicJwk] }));

  app.post('/api/v1/identity/sessions', async (req, reply): Promise<TokenResponse> => {
    const body = parse(loginRequest, req.body);
    const { rows } = await db.query<{ id: string; tenant_id: string; password_hash: string | null; status: string }>(
      `SELECT u.id, u.tenant_id, u.password_hash, u.status
         FROM platform.user_account u JOIN platform.tenant t ON t.id = u.tenant_id
        WHERE t.slug = $1 AND lower(u.email) = lower($2) AND u.kind = 'human'`,
      [body.tenant, body.email],
    );
    const user = rows[0];
    const ok = await verifySecret(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.status !== 'active') {
      await audit(db, {
        tenantId: user?.tenant_id ?? '00000000-0000-0000-0000-000000000000',
        actorId: null,
        action: 'identity.login_failed',
        targetType: 'user',
        targetId: user?.id ?? 'unknown',
        correlationId: req.correlationId,
      }).catch(() => undefined);
      throw unauthorized('Invalid credentials');
    }
    const p = await loadPrincipal(db, user.tenant_id, user.id);
    const access = await issueAccessToken(deps, p);
    const refresh = await issueRefreshToken(db, deps, p);
    await audit(db, { tenantId: p.tenantId, actorId: p.userId, action: 'identity.login', targetType: 'user', targetId: p.userId, correlationId: req.correlationId });
    reply.header('cache-control', 'no-store');
    return { access_token: access, token_type: 'Bearer', expires_in: deps.config.accessTokenTtlSeconds, refresh_token: refresh };
  });

  app.post('/api/v1/identity/token', async (req, reply): Promise<TokenResponse> => {
    const body = parse(tokenRequest, req.body);
    reply.header('cache-control', 'no-store');
    if (body.grant_type === 'client_credentials') {
      const { rows } = await db.query<{ id: string; tenant_id: string; client_secret_hash: string | null; status: string }>(
        `SELECT id, tenant_id, client_secret_hash, status FROM platform.user_account WHERE client_id = $1 AND kind = 'service'`,
        [body.client_id],
      );
      const svc = rows[0];
      const ok = await verifySecret(body.client_secret, svc?.client_secret_hash ?? DUMMY_HASH);
      if (!svc || !ok || svc.status !== 'active') throw unauthorized('Invalid client credentials');
      const p = await loadPrincipal(db, svc.tenant_id, svc.id);
      return { access_token: await issueAccessToken(deps, p), token_type: 'Bearer', expires_in: deps.config.accessTokenTtlSeconds };
    }
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; tenant_id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
        `SELECT id, tenant_id, user_id, expires_at, revoked_at FROM platform.refresh_token WHERE token_hash = $1 FOR UPDATE`,
        [sha256(body.refresh_token)],
      );
      const rt = rows[0];
      if (!rt || rt.revoked_at || rt.expires_at.getTime() <= deps.clock.now().getTime()) {
        throw unauthorized('Refresh token is invalid or expired');
      }
      const p = await loadPrincipal(tx, rt.tenant_id, rt.user_id);
      const next = await issueRefreshToken(tx, deps, p);
      await tx.query(`UPDATE platform.refresh_token SET revoked_at = now() WHERE id = $1`, [rt.id]);
      return {
        access_token: await issueAccessToken(deps, p),
        token_type: 'Bearer' as const,
        expires_in: deps.config.accessTokenTtlSeconds,
        refresh_token: next,
      };
    });
  });

  app.post('/api/v1/identity/sessions/revoke', async (req, reply) => {
    const token = (req.body as { refresh_token?: unknown } | undefined)?.refresh_token;
    if (typeof token === 'string') {
      await db.query(`UPDATE platform.refresh_token SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
    }
    return reply.status(204).send();
  });

  app.get('/api/v1/identity/me', async (req) => {
    const p = await deps.authenticate(req);
    return { ...(await userDto(db, p.tenantId, p.userId)), tenant_id: p.tenantId };
  });

  // ----- Sites -----
  app.get('/api/v1/identity/sites', async (req) => {
    const p = await deps.authenticate(req);
    const { rows } = await db.query(`SELECT * FROM platform.site WHERE tenant_id = $1 ORDER BY code, id`, [p.tenantId]);
    return { items: rows.filter((r) => canReadSite(p, r.id)).map(siteDto), next_cursor: null };
  });

  app.get('/api/v1/identity/sites/:id', async (req) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    const { rows } = await db.query(`SELECT * FROM platform.site WHERE tenant_id = $1 AND id::text = $2`, [p.tenantId, id]);
    if (!rows[0] || !canReadSite(p, rows[0].id)) throw notFound('Site');
    return siteDto(rows[0]);
  });

  app.post('/api/v1/identity/sites', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const body = parse(createSiteRequest, req.body);
    if (!isValidTimezone(body.timezone)) throw invalid('Unknown timezone', { timezone: ['Use an IANA timezone name'] });
    const site = await withTransaction(db, async (tx) => {
      const id = randomUUID();
      try {
        const { rows } = await tx.query(
          `INSERT INTO platform.site (id, tenant_id, code, name, timezone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [id, p.tenantId, body.code, body.name, body.timezone],
        );
        await tx.query(
          `INSERT INTO platform.site_membership (tenant_id, user_id, site_id)
           SELECT tenant_id, id, $2 FROM platform.user_account WHERE tenant_id = $1 AND auto_site_membership AND status = 'active'`,
          [p.tenantId, id],
        );
        await audit(tx, { tenantId: p.tenantId, siteId: id, actorId: p.userId, action: 'site.created', targetType: 'site', targetId: id, afterVersion: 1, correlationId: req.correlationId });
        return siteDto(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('duplicate_site_code', 'A site with this code already exists');
        throw err;
      }
    });
    return reply.status(201).send(site);
  });

  // ----- Users and directory -----
  app.get('/api/v1/identity/directory', async (req) => {
    const p = await deps.authenticate(req);
    const siteId = (req.query as { site_id?: string }).site_id;
    if (!siteId || !canReadSite(p, siteId)) throw notFound('Site');
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.kind FROM platform.user_account u
         JOIN platform.site_membership m ON m.user_id = u.id
        WHERE u.tenant_id = $1 AND m.site_id = $2 AND u.status = 'active'
        ORDER BY u.display_name, u.id`,
      [p.tenantId, siteId],
    );
    return { items: rows, next_cursor: null };
  });

  app.get('/api/v1/identity/users', async (req) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM platform.user_account WHERE tenant_id = $1 ORDER BY display_name, id`,
      [p.tenantId],
    );
    return { items: await Promise.all(rows.map((r) => userDto(db, p.tenantId, r.id))), next_cursor: null };
  });

  app.post('/api/v1/identity/users', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const body = parse(createUserRequest, req.body);
    const id = randomUUID();
    const hash = await hashSecret(body.password);
    await withTransaction(db, async (tx) => {
      try {
        await tx.query(
          `INSERT INTO platform.user_account (id, tenant_id, kind, email, display_name, password_hash) VALUES ($1,$2,'human',$3,$4,$5)`,
          [id, p.tenantId, body.email, body.display_name, hash],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('duplicate_email', 'A user with this email already exists');
        throw err;
      }
      await addMemberships(tx, p, id, body.site_ids, req.correlationId);
      await audit(tx, { tenantId: p.tenantId, actorId: p.userId, action: 'user.created', targetType: 'user', targetId: id, correlationId: req.correlationId });
    });
    return reply.status(201).send(await userDto(db, p.tenantId, id));
  });

  app.post('/api/v1/identity/service-accounts', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const body = parse(createServiceAccountRequest, req.body);
    const id = randomUUID();
    const clientId = `svc_${randomBytes(9).toString('base64url')}`;
    const secret = randomBytes(32).toString('base64url');
    await withTransaction(db, async (tx) => {
      await tx.query(
        `INSERT INTO platform.user_account (id, tenant_id, kind, display_name, client_id, client_secret_hash) VALUES ($1,$2,'service',$3,$4,$5)`,
        [id, p.tenantId, body.name, clientId, await hashSecret(secret)],
      );
      await addMemberships(tx, p, id, body.site_ids, req.correlationId);
      await audit(tx, { tenantId: p.tenantId, actorId: p.userId, action: 'service_account.created', targetType: 'user', targetId: id, correlationId: req.correlationId });
    });
    // The secret is returned once and never stored in recoverable form.
    return reply.status(201).send({ ...(await userDto(db, p.tenantId, id)), client_id: clientId, client_secret: secret });
  });

  app.post('/api/v1/identity/users/:id/memberships', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const { id } = req.params as { id: string };
    const body = parse(membershipRequest, req.body);
    await withTransaction(db, (tx) => addMemberships(tx, p, id, [body.site_id], req.correlationId));
    return reply.status(201).send(await userDto(db, p.tenantId, id));
  });

  app.delete('/api/v1/identity/users/:id/memberships/:siteId', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const { id, siteId } = req.params as { id: string; siteId: string };
    await withTransaction(db, async (tx) => {
      const r = await tx.query(`DELETE FROM platform.site_membership WHERE tenant_id = $1 AND user_id::text = $2 AND site_id::text = $3`, [p.tenantId, id, siteId]);
      if (r.rowCount === 0) throw notFound('Membership');
      await tx.query(`UPDATE platform.refresh_token SET revoked_at = now() WHERE user_id::text = $1 AND revoked_at IS NULL`, [id]);
      await audit(tx, { tenantId: p.tenantId, siteId, actorId: p.userId, action: 'membership.removed', targetType: 'user', targetId: id, correlationId: req.correlationId });
    });
    return reply.status(204).send();
  });

  app.post('/api/v1/identity/users/:id/platform-roles', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const { id } = req.params as { id: string };
    const body = parse(platformRoleRequest, req.body);
    await withTransaction(db, async (tx) => {
      await ensureUser(tx, p.tenantId, id);
      if (body.site_id) await ensureSite(tx, p.tenantId, body.site_id);
      await tx.query(
        `INSERT INTO platform.platform_role (id, tenant_id, user_id, role, site_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [randomUUID(), p.tenantId, id, body.role, body.site_id, p.userId],
      );
      await audit(tx, { tenantId: p.tenantId, siteId: body.site_id, actorId: p.userId, action: 'platform_role.granted', targetType: 'user', targetId: id, detail: { role: body.role }, correlationId: req.correlationId });
    });
    return reply.status(201).send(await userDto(db, p.tenantId, id));
  });

  app.post('/api/v1/identity/users/:id/disable', async (req, reply) => {
    const p = await deps.authenticate(req);
    requireTenantAdmin(p);
    const { id } = req.params as { id: string };
    if (id === p.userId) throw new AppError(409, 'cannot_disable_self', 'Administrators cannot disable their own account');
    await withTransaction(db, async (tx) => {
      const r = await tx.query(`UPDATE platform.user_account SET status = 'disabled', version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id::text = $2`, [p.tenantId, id]);
      if (r.rowCount === 0) throw notFound('User');
      await tx.query(`UPDATE platform.refresh_token SET revoked_at = now() WHERE user_id::text = $1 AND revoked_at IS NULL`, [id]);
      await audit(tx, { tenantId: p.tenantId, actorId: p.userId, action: 'user.disabled', targetType: 'user', targetId: id, correlationId: req.correlationId });
    });
    return reply.status(204).send();
  });
}

async function ensureUser(db: Queryable, tenantId: string, userId: string): Promise<void> {
  const { rowCount } = await db.query(`SELECT 1 FROM platform.user_account WHERE tenant_id = $1 AND id::text = $2`, [tenantId, userId]);
  if (!rowCount) throw notFound('User');
}

async function ensureSite(db: Queryable, tenantId: string, siteId: string): Promise<void> {
  const { rowCount } = await db.query(`SELECT 1 FROM platform.site WHERE tenant_id = $1 AND id::text = $2`, [tenantId, siteId]);
  if (!rowCount) throw notFound('Site');
}

async function addMemberships(db: Queryable, p: PlatformPrincipal, userId: string, siteIds: string[], correlationId: string): Promise<void> {
  await ensureUser(db, p.tenantId, userId);
  for (const siteId of siteIds) {
    await ensureSite(db, p.tenantId, siteId);
    await db.query(
      `INSERT INTO platform.site_membership (tenant_id, user_id, site_id, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [p.tenantId, userId, siteId, p.userId],
    );
    await audit(db, { tenantId: p.tenantId, siteId, actorId: p.userId, action: 'membership.added', targetType: 'user', targetId: userId, correlationId });
  }
}
