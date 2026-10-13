import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { LicenseDocument, MaintenanceRole, SignedLicense } from '@vm/contracts';
import { bootstrapRoleAssignment, checkRegistryBinding, createServices, type Services } from '@vm/core';
import { createPool, migrate, type Db } from '@vm/db';
import { generateSigningKeyPair, signLicense } from '@vm/licensing';
import { buildMaintenanceApp, INTEGRATION_MIGRATIONS_DIR, MAINTENANCE_MIGRATIONS_DIR } from '@vm/maintenance-api';
import { bootstrap, buildPlatformApp, loadOrCreateSigningKey, PLATFORM_MIGRATIONS_DIR } from '@vm/platform-api';
import type { RegistryClient } from '@vm/registry';
import { FixedClock } from '@vm/server-kit';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://localhost:5432/postgres';
export const PASSWORD = 'correct-horse-battery-staple';

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export interface Harness {
  db: Db;
  databaseUrl: string;
  blobRoot: string;
  /** Scratch directory removed by close(). */
  tmp: string;
  services: Services;
  clock: FixedClock;
  platform: FastifyInstance;
  platformUrl: string;
  api: FastifyInstance;
  tenantA: string;
  tenantB: string;
  siteA1: string;
  siteA2: string;
  siteB1: string;
  teamA1: string;
  users: Record<UserName, TestUser>;
  licenseKey: { kid: string; privateKeyPem: string; publicKeyPem: string };
  systemCredentials: Record<string, { client_id: string; client_secret: string }>;
  installationId: string;
  call<T = any>(user: TestUser | null, method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<CallResult<T>>;
  platformCall<T = any>(user: TestUser | null, method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<CallResult<T>>;
  login(email: string, tenant?: string): Promise<string>;
  signLicense(overrides?: Partial<LicenseDocument>): SignedLicense;
  createAsset(user: TestUser, siteId: string, code: string, name?: string): Promise<any>;
  close(): Promise<void>;
}

export type UserName =
  | 'admin'
  | 'sup'
  | 'sup2'
  | 'tech'
  | 'tech2'
  | 'reporter'
  | 'viewer'
  | 'assetAdmin'
  | 'costSup'
  | 'supA2'
  | 'supB';

export interface HarnessOptions {
  license?: 'full' | 'core' | 'none';
  now?: Date;
  registry?: (real: RegistryClient) => RegistryClient;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dbName = `vm_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const db = createPool(url.toString(), { max: 20 });

  await migrate(db, 'platform', PLATFORM_MIGRATIONS_DIR);
  await migrate(db, 'maintenance', MAINTENANCE_MIGRATIONS_DIR);
  await migrate(db, 'integration', INTEGRATION_MIGRATIONS_DIR);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vm-test-'));
  const key = await loadOrCreateSigningKey(path.join(tmp, 'identity', 'signing-key.json'));
  const platformConfig = {
    databaseUrl: url.toString(),
    issuer: 'http://platform.test',
    keyFile: '',
    port: 0,
    host: '127.0.0.1',
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    audiences: ['visibility-platform', 'visibility-maintenance'],
  };
  const platform = await buildPlatformApp({ db, config: platformConfig, key });
  await platform.listen({ port: 0, host: '127.0.0.1' });
  const platformUrl = `http://127.0.0.1:${(platform.server.address() as AddressInfo).port}`;

  // ----- Fixture: two tenants, two sites in tenant A -----
  const tenantA = await bootstrap.createTenant(db, { slug: 'acme', name: 'Acme Foundry' });
  const tenantB = await bootstrap.createTenant(db, { slug: 'other', name: 'Other Co' });
  const siteA1 = await bootstrap.createSite(db, tenantA, { code: 'A1', name: 'Foundry', timezone: 'Asia/Karachi' });
  const siteA2 = await bootstrap.createSite(db, tenantA, { code: 'A2', name: 'Assembly', timezone: 'Europe/London' });
  const siteB1 = await bootstrap.createSite(db, tenantB, { code: 'B1', name: 'Other plant', timezone: 'UTC' });

  const mk = async (name: UserName, tenant: string, sites: string[], platformRoles: Array<{ role: any; siteId: string | null }>, roles: Array<[MaintenanceRole, string | null]>) => {
    const email = `${name.toLowerCase()}@example.test`;
    const id = await bootstrap.createHumanUser(db, tenant, { email, displayName: name, password: PASSWORD, siteIds: sites, platformRoles });
    for (const [role, site] of roles) await bootstrapRoleAssignment(db, tenant, id, role, site);
    return { id, email, token: '' };
  };
  const users = {
    admin: await mk('admin', tenantA, [siteA1, siteA2], [{ role: 'platform_admin', siteId: null }], [['maintenance_admin', null]]),
    sup: await mk('sup', tenantA, [siteA1], [], [['supervisor', siteA1]]),
    sup2: await mk('sup2', tenantA, [siteA1], [], [['supervisor', siteA1]]),
    tech: await mk('tech', tenantA, [siteA1], [], [['technician', siteA1]]),
    tech2: await mk('tech2', tenantA, [siteA1], [], [['technician', siteA1]]),
    reporter: await mk('reporter', tenantA, [siteA1], [], [['reporter', siteA1]]),
    viewer: await mk('viewer', tenantA, [siteA1], [], [['viewer', siteA1]]),
    assetAdmin: await mk('assetAdmin', tenantA, [siteA1, siteA2], [{ role: 'asset_admin', siteId: null }, { role: 'mapping_admin', siteId: null }], [['asset_administrator', null]]),
    costSup: await mk('costSup', tenantA, [siteA1], [], [['supervisor', siteA1], ['cost_viewer', siteA1]]),
    supA2: await mk('supA2', tenantA, [siteA2], [], [['supervisor', siteA2]]),
    supB: await mk('supB', tenantB, [siteB1], [{ role: 'platform_admin', siteId: null }], [['supervisor', siteB1], ['maintenance_admin', null]]),
  } satisfies Record<UserName, TestUser>;

  const sysA = await bootstrap.createServiceAccount(db, tenantA, { name: 'maintenance-system', siteIds: [siteA1, siteA2] });
  const sysB = await bootstrap.createServiceAccount(db, tenantB, { name: 'maintenance-system', siteIds: [siteB1] });

  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  const kid = 'test-key-1';
  const clock = new FixedClock(opts.now ?? new Date());
  const services = createServices({
    db,
    platformUrl,
    clock,
    blobRoot: path.join(tmp, 'blobs'),
    licensePublicKeys: { [kid]: publicKeyPem },
    systemCredentials: { [tenantA]: sysA, [tenantB]: sysB },
    config: { downloadLinkSecret: randomBytes(32).toString('hex'), allowSimulatedConnectors: true, neoInferencePolicy: 'private_only' },
    entitlementCacheTtlMs: 0,
  });
  if (opts.registry) services.registry = opts.registry(services.registry);
  const api = await buildMaintenanceApp({ services, auth: { issuer: platformConfig.issuer, audience: 'visibility-maintenance', jwksUrl: `${platformUrl}/api/v1/identity/jwks` } });
  await api.ready();
  const installationId = await services.entitlements.installationId();
  const binding = await checkRegistryBinding(services, { bind: true });
  if (binding.status !== 'newly_bound') throw new Error(`registry binding failed: ${JSON.stringify(binding)}`);

  const inject = async (target: FastifyInstance, user: TestUser | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await target.inject({
      method: method as any,
      url,
      payload: body === undefined ? undefined : (body as any),
      headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...headers },
    });
    let parsed: any = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      // keep raw body
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  };

  const login = async (email: string, tenant = 'acme') => {
    const r = await inject(platform, null, 'POST', '/api/v1/identity/sessions', { tenant, email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
    return r.body.access_token as string;
  };
  for (const [name, u] of Object.entries(users)) u.token = await login(u.email, name === 'supB' ? 'other' : 'acme');

  const sign = (overrides: Partial<LicenseDocument> = {}) =>
    signLicense(
      {
        license_id: `LIC-${randomUUID().slice(0, 8)}`,
        product: 'visibility-maintenance',
        tenant_id: tenantA,
        installation_id: installationId,
        features: ['core', 'connected_operations', 'neo_assistance'],
        limits: { sites: null, operational_users: null, maintainable_assets: null },
        term: { starts_at: '2020-01-01T00:00:00Z', ends_at: '2099-01-01T00:00:00Z' },
        grace_days: 30,
        policy_tag: 'proposed-default-pending-commercial-approval',
        issued_at: '2026-10-01T00:00:00Z',
        key_id: kid,
        ...overrides,
      },
      privateKeyPem,
    );

  const h: Harness = {
    db,
    databaseUrl: url.toString(),
    blobRoot: path.join(tmp, 'blobs'),
    tmp,
    services,
    clock,
    platform,
    platformUrl,
    api,
    tenantA,
    tenantB,
    siteA1,
    siteA2,
    siteB1,
    teamA1: '',
    users,
    licenseKey: { kid, privateKeyPem, publicKeyPem },
    systemCredentials: { [tenantA]: sysA, [tenantB]: sysB },
    installationId,
    call: (user, method, url, body, headers) => inject(api, user, method, url, body, headers),
    platformCall: (user, method, url, body, headers) => inject(platform, user, method, url, body, headers),
    login,
    signLicense: sign,
    async createAsset(user, siteId, code, name) {
      const r = await inject(platform, user, 'POST', '/api/v1/assets', { site_id: siteId, code, name: name ?? `Asset ${code}`, location: 'Bay 1' });
      if (r.status !== 201) throw new Error(`asset create failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async close() {
      await api.close();
      await platform.close();
      await db.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
      await rm(tmp, { recursive: true, force: true });
    },
  };

  const licenseMode = opts.license ?? 'full';
  if (licenseMode !== 'none') {
    const doc = licenseMode === 'core' ? sign({ features: ['core'] }) : sign();
    const r = await h.call(users.admin, 'POST', '/api/v1/maintenance/licenses', doc);
    if (r.status !== 201) throw new Error(`license import failed: ${JSON.stringify(r.body)}`);
    const docB = sign({ tenant_id: tenantB });
    const rb = await h.call(users.supB, 'POST', '/api/v1/maintenance/licenses', docB);
    if (rb.status !== 201) throw new Error(`license import B failed: ${JSON.stringify(rb.body)}`);
  }

  const team = await h.call(users.admin, 'POST', '/api/v1/maintenance/teams', { site_id: siteA1, name: 'Mechanical', member_ids: [users.tech.id, users.tech2.id] });
  if (team.status !== 201) throw new Error(`team create failed: ${JSON.stringify(team.body)}`);
  h.teamA1 = team.body.id;
  return h;
}
