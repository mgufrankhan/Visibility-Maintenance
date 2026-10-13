import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRegistryUsable, createServices, readJsonFile, runPmScheduler, type Services } from '@vm/core';
import { assertSchemaCompatible, createPool, migrate, type Db } from '@vm/db';
import { generateSigningKeyPair, signLicense } from '@vm/licensing';
import { buildMaintenanceApp, INTEGRATION_MIGRATIONS_DIR, MAINTENANCE_MIGRATIONS_DIR } from '@vm/maintenance-api';
import { maintenanceJobs } from '@vm/maintenance-worker';
import { migrateAll, preflight, SetupError, setupTenant, type Databases, type TenantSetupResult } from '@vm/ops';
import { buildPlatformApp, loadOrCreateSigningKey, PLATFORM_MIGRATIONS_DIR } from '@vm/platform-api';
import { HttpRegistryClient, type RegistryClient } from '@vm/registry';
import { FixedClock } from '@vm/server-kit';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://localhost:5432/postgres';
const M = '/api/v1/maintenance';
const dirs = { platform: PLATFORM_MIGRATIONS_DIR, maintenance: MAINTENANCE_MIGRATIONS_DIR, integration: INTEGRATION_MIGRATIONS_DIR };

let dbName: string;
let db: Db;
let dbs: Databases;
let tmp: string;
let platform: FastifyInstance;
let api: FastifyInstance;
let platformUrl: string;
let registry: RegistryClient;
let services: Services;
let setup: TenantSetupResult;
let credentialsFile: string;
const clock = new FixedClock(new Date('2026-10-12T00:00:00Z'));
const licenseKeys = generateSigningKeyPair();
const tokens = {} as Record<'admin' | 'tech' | 'sup' | 'sup2' | 'techId' | 'assetId', string>;

async function call(target: FastifyInstance, token: string | null, method: string, url: string, body?: unknown) {
  const res = await target.inject({ method: method as any, url, payload: body as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let parsed: any = res.body;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    // raw body
  }
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

async function login(email: string, password: string): Promise<string> {
  const r = await call(platform, null, 'POST', '/api/v1/identity/sessions', { tenant: 'plant', email, password });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

beforeAll(async () => {
  dbName = `vm_install_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  db = createPool(url.toString(), { max: 10 });
  dbs = { platform: db, maintenance: db };
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vm-install-'));
  credentialsFile = path.join(tmp, 'secrets', 'system-credentials.json');
});

afterAll(async () => {
  await api?.close();
  await platform?.close();
  await db?.end();
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.end();
  await rm(tmp, { recursive: true, force: true });
});

describe('fresh standalone installation (AC-15, AC-20)', () => {
  it('reports pending migrations on a blank database without failing preflight, then migrates', async () => {
    const before = await preflight(dbs, dirs, null);
    expect(before.ok).toBe(true);
    expect(before.checks.map((c) => c.status)).toEqual(['warn', 'warn', 'warn']);
    await expect(assertSchemaCompatible(db, 'maintenance', dirs.maintenance)).rejects.toThrow(/pending migrations/);
    const results = await migrateAll(dbs, dirs);
    expect(results.map((r) => r.schema)).toEqual(['platform', 'maintenance', 'integration']);
    expect((await migrateAll(dbs, dirs)).every((r) => r.applied.length === 0)).toBe(true);
  });

  it('runs setup without Live, OpenRemote, Neo or connectors configured', async () => {
    const key = await loadOrCreateSigningKey(path.join(tmp, 'identity', 'signing-key.json'));
    platform = await buildPlatformApp({
      db,
      key,
      config: { databaseUrl: '', issuer: 'http://platform.install.test', keyFile: '', port: 0, host: '127.0.0.1', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400, audiences: ['visibility-platform', 'visibility-maintenance'] },
    });
    await platform.listen({ port: 0, host: '127.0.0.1' });
    platformUrl = `http://127.0.0.1:${(platform.server.address() as AddressInfo).port}`;
    registry = new HttpRegistryClient({ baseUrl: platformUrl });

    await expect(
      setupTenant(dbs, registry, { tenant: { slug: 'plant', name: 'Plant' }, site: { code: 'P1', name: 'Plant 1', timezone: 'Mars/Olympus' }, admin: { email: 'admin@plant.test', displayName: 'Admin' }, systemCredentialsFile: credentialsFile }),
    ).rejects.toThrow(/unknown IANA timezone/);

    setup = await setupTenant(dbs, registry, {
      tenant: { slug: 'plant', name: 'Plant' },
      site: { code: 'P1', name: 'Plant 1', timezone: 'Asia/Karachi' },
      admin: { email: 'admin@plant.test', displayName: 'Admin' },
      systemCredentialsFile: credentialsFile,
    });
    expect(setup.registry.status).toBe('newly_bound');
    expect(setup.generated_admin_password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(await readFile(credentialsFile, 'utf8'));
    expect(Object.keys(creds)).toEqual([setup.tenant_id]);
    const stored = await db.query(`SELECT password_hash FROM platform.user_account WHERE id = $1`, [setup.admin_user_id]);
    expect(stored.rows[0].password_hash).not.toContain(setup.generated_admin_password);

    await expect(
      setupTenant(dbs, registry, { tenant: { slug: 'plant', name: 'Again' }, site: { code: 'P1', name: 'Plant 1', timezone: 'UTC' }, admin: { email: 'x@plant.test', displayName: 'X' }, systemCredentialsFile: credentialsFile }),
    ).rejects.toBeInstanceOf(SetupError);

    services = createServices({
      db,
      platformUrl,
      clock,
      blobRoot: path.join(tmp, 'blobs'),
      licensePublicKeys: { 'vendor-1': licenseKeys.publicKeyPem },
      systemCredentials: readJsonFile(credentialsFile, {}),
      config: { downloadLinkSecret: randomBytes(32).toString('hex'), allowSimulatedConnectors: false, neoInferencePolicy: 'disabled' },
      entitlementCacheTtlMs: 0,
    });
    api = await buildMaintenanceApp({ services, auth: { issuer: 'http://platform.install.test', audience: 'visibility-maintenance', jwksUrl: `${platformUrl}/api/v1/identity/jwks` } });
    await api.ready();
    const ready = await call(api, null, 'GET', '/health/ready');
    expect(ready.body).toEqual({ status: 'ready', core: { database: 'ok' }, optional: {} });
    tokens.admin = await login('admin@plant.test', setup.generated_admin_password!);
  });

  it('keeps continuity capabilities without a license and unlocks work with a Core-only license', async () => {
    const ent = await call(api, tokens.admin, 'GET', `${M}/entitlements`);
    expect(ent.body.status).toBe('missing');
    expect(ent.body.capabilities).toEqual(expect.arrayContaining(['core.read', 'core.export', 'core.report_fault']));
    expect(ent.body.capabilities).not.toContain('core.create_work');

    const doc = signLicense(
      {
        license_id: 'LIC-INSTALL-1',
        product: 'visibility-maintenance',
        tenant_id: setup.tenant_id,
        installation_id: setup.installation_id,
        features: ['core'],
        limits: { sites: 2, operational_users: 10, maintainable_assets: 50 },
        term: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2027-10-01T00:00:00Z' },
        grace_days: 30,
        policy_tag: 'proposed-default-pending-commercial-approval',
        issued_at: '2026-10-01T00:00:00Z',
        key_id: 'vendor-1',
      },
      licenseKeys.privateKeyPem,
    );
    const wrongInstall = signLicense({ ...doc.license, license_id: 'LIC-OTHER', installation_id: randomUUID() }, licenseKeys.privateKeyPem);
    expect((await call(api, tokens.admin, 'POST', `${M}/licenses`, wrongInstall)).status).toBe(422);
    const imported = await call(api, tokens.admin, 'POST', `${M}/licenses`, doc);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body.status).toBe('valid');
    expect(imported.body.capabilities).toContain('core.create_work');
    // Core does not need, and is not granted, connected operations or Neo (AC-20).
    expect(imported.body.capabilities.filter((c: string) => !c.startsWith('core.'))).toEqual([]);
  });

  it('administers users, sites and assets, and adds new sites to the system identity', async () => {
    const mkUser = async (name: 'tech' | 'sup' | 'sup2', role: string) => {
      const password = `pw-${randomBytes(12).toString('hex')}`;
      const u = await call(platform, tokens.admin, 'POST', '/api/v1/identity/users', { email: `${name}@plant.test`, display_name: name, password, site_ids: [setup.site_id] });
      expect(u.status, JSON.stringify(u.body)).toBe(201);
      const g = await call(api, tokens.admin, 'POST', `${M}/role-assignments`, { user_id: u.body.id, role, site_id: setup.site_id });
      expect(g.status, JSON.stringify(g.body)).toBe(201);
      tokens[name] = await login(`${name}@plant.test`, password);
      return u.body.id as string;
    };
    tokens.techId = await mkUser('tech', 'technician');
    await mkUser('sup', 'supervisor');
    await mkUser('sup2', 'supervisor');

    const site2 = await call(platform, tokens.admin, 'POST', '/api/v1/identity/sites', { code: 'P2', name: 'Plant 2', timezone: 'Europe/London' });
    expect(site2.status).toBe(201);
    const members = await db.query(
      `SELECT m.site_id FROM platform.site_membership m JOIN platform.user_account u ON u.id = m.user_id WHERE u.kind = 'service' AND u.tenant_id = $1 ORDER BY m.site_id`,
      [setup.tenant_id],
    );
    expect(members.rows.map((r) => r.site_id).sort()).toEqual([setup.site_id, site2.body.id].sort());

    const asset = await call(platform, tokens.admin, 'POST', '/api/v1/assets', { site_id: setup.site_id, code: 'CMP-1', name: 'Air compressor', location: 'Utility room' });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    tokens.assetId = asset.body.id;
  });

  it('executes request, calendar PM, inspection, report and export flows', async () => {
    const team = await call(api, tokens.admin, 'POST', `${M}/teams`, { site_id: setup.site_id, name: 'Utilities', member_ids: [tokens.techId] });
    expect(team.status).toBe(201);

    const req = await call(api, tokens.tech, 'POST', `${M}/requests`, { site_id: setup.site_id, asset_id: tokens.assetId, description: 'Compressor tripping', observed_at: '2026-10-11T10:00:00Z', proposed_priority: 'normal' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);

    const proc = await call(api, tokens.sup, 'POST', `${M}/procedures`, { site_id: setup.site_id, title: 'Weekly drain' });
    const rev = await call(api, tokens.sup, 'POST', `${M}/procedures/${proc.body.id}/revisions`, { safety_instructions: 'Depressurize first.', steps: [{ key: 'drained', label: 'Condensate drained', type: 'pass_fail' }] });
    expect((await call(api, tokens.sup, 'POST', `${M}/procedure-revisions/${rev.body.id}/publish`)).status).toBe(200);
    const plan = await call(api, tokens.sup, 'POST', `${M}/plans`, { site_id: setup.site_id, asset_id: tokens.assetId, title: 'Weekly drain' });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const planRev = await call(api, tokens.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
      title: 'Drain condensate',
      scope: 'Drain receiver condensate',
      procedure_revision_id: rev.body.id,
      team_id: team.body.id,
      estimated_minutes: 15,
      lead_days: 3,
      trigger: { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2026-10-14', time_of_day: '08:00' },
      effective_from: '2026-10-12',
    });
    expect(planRev.status, JSON.stringify(planRev.body)).toBe(201);
    expect((await call(api, tokens.sup, 'POST', `${M}/plan-revisions/${planRev.body.id}/publish`)).status).toBe(200);

    // The worker's scheduler authenticates with the system identity written by setup.
    const sum = await runPmScheduler(services, 'install-worker');
    expect(sum.issued).toBe(1);
    const orders = await call(api, tokens.sup, 'GET', `${M}/work-orders?site_id=${setup.site_id}`);
    expect(orders.body.items.filter((w: any) => w.plan_occurrence_id)).toHaveLength(1);

    const tpl = await call(api, tokens.sup, 'POST', `${M}/inspection-templates`, { site_id: setup.site_id, title: 'Daily round' });
    await call(api, tokens.sup, 'POST', `${M}/inspection-templates/${tpl.body.id}/revisions`, { checks: [{ key: 'no_leaks', label: 'No air leaks', type: 'pass_fail' }] });
    const pub = await call(api, tokens.sup, 'POST', `${M}/inspection-templates/${tpl.body.id}/publish`);
    const start = await call(api, tokens.tech, 'POST', `${M}/inspection-results`, { template_revision_id: pub.body.id, asset_id: tokens.assetId, client_submission_id: 'round-1' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const submit = await call(api, tokens.tech, 'POST', `${M}/inspection-results/${start.body.id}/submit`, { observed_at: '2026-10-11T23:00:00Z', values: [{ key: 'no_leaks', value: true }] });
    expect(submit.body).toMatchObject({ status: 'submitted', passed: true });

    const period = `site_id=${setup.site_id}&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`;
    const rep = await call(api, tokens.sup, 'GET', `${M}/reports/failure_count?${period}`);
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const csv = await call(api, tokens.sup, 'GET', `${M}/exports/work_orders.csv?${period}`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(String(csv.body)).toContain('Drain condensate');
  });

  it('runs worker registry sync against the bound registry', async () => {
    const job = maintenanceJobs({ services, workerId: 'install-worker', tenantIds: () => [setup.tenant_id] }).find((j) => j.name === 'registry-sync')!;
    const out = (await job.run()) as Record<string, { assets: number; sites: number }>;
    expect(out[setup.tenant_id]!.sites).toBe(2);
  });
});

describe('upgrade and attach preflight (AC-21)', () => {
  const fake = (meta: Record<string, unknown>) => ({ meta: async () => meta }) as unknown as RegistryClient;

  it('passes on a current installation bound to its registry', async () => {
    const r = await preflight(dbs, dirs, registry);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'registry')).toMatchObject({ status: 'ok' });
    expect(r.checks.find((c) => c.name === 'registry_database')).toMatchObject({ status: 'ok' });
    // Without the platform API (as in the packaged migrate step) the database check still applies.
    expect((await preflight(dbs, dirs, null)).ok).toBe(true);
  });

  it('fails when the platform database URL points at a different registry', async () => {
    const otherName = `vm_other_${randomBytes(6).toString('hex')}`;
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`CREATE DATABASE ${otherName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${otherName}`;
    const other = createPool(url.toString(), { max: 2 });
    try {
      await migrate(other, 'platform', dirs.platform);
      const r = await preflight({ platform: other, maintenance: db }, dirs, null);
      expect(r.ok).toBe(false);
      expect(r.checks.find((x) => x.name === 'registry_database')!.detail).toMatch(/bound to/);
    } finally {
      await other.end();
      await c.query(`DROP DATABASE IF EXISTS ${otherName} WITH (FORCE)`);
      await c.end();
    }
  });

  it('fails when the database is ahead of the build or a migration was edited', async () => {
    await db.query(`INSERT INTO maintenance.schema_migrations (version, file, checksum) VALUES ('9999', '9999_future.sql', 'x')`);
    try {
      const r = await preflight(dbs, dirs, registry);
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.name === 'schema:maintenance')!.detail).toMatch(/ahead of this build/);
      await expect(assertSchemaCompatible(db, 'maintenance', dirs.maintenance)).rejects.toThrow(/newer than this build/);
    } finally {
      await db.query(`DELETE FROM maintenance.schema_migrations WHERE version = '9999'`);
    }
    const orig = (await db.query(`SELECT checksum FROM platform.schema_migrations WHERE version = '0001'`)).rows[0].checksum;
    await db.query(`UPDATE platform.schema_migrations SET checksum = 'edited' WHERE version = '0001'`);
    try {
      expect((await preflight(dbs, dirs, registry)).checks.find((c) => c.name === 'schema:platform')).toMatchObject({ status: 'fail' });
      await expect(migrateAll(dbs, dirs)).rejects.toThrow(/modified after being applied/);
    } finally {
      await db.query(`UPDATE platform.schema_migrations SET checksum = $1 WHERE version = '0001'`, [orig]);
    }
  });

  it('detects a different registry or an incompatible platform API before migrating', async () => {
    const mismatch = await preflight(dbs, dirs, fake({ service: 'visibility-platform', api_version: 1, build_version: 'x', registry_id: randomUUID() }));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.registry?.status).toBe('registry_mismatch');
    expect(() => assertRegistryUsable(mismatch.registry!)).toThrow(/differs from the bound registry/);

    const newer = await preflight(dbs, dirs, fake({ service: 'visibility-platform', api_version: 2, build_version: 'x', registry_id: randomUUID() }));
    expect(newer.registry?.status).toBe('incompatible_api');
    expect(newer.ok).toBe(false);
  });

  it('treats an unreachable platform as a failure for upgrades but not for service startup', async () => {
    const down = new HttpRegistryClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
    const r = await preflight(dbs, dirs, down);
    expect(r.ok).toBe(false);
    expect((await preflight(dbs, dirs, down, { allowUnreachablePlatform: true })).ok).toBe(true);
    expect(() => assertRegistryUsable(r.registry!)).not.toThrow();
  });
});
