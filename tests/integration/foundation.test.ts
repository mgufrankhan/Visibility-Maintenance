import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryUnavailableError, type RegistryClient } from '@vm/registry';
import { createHarness, type Harness } from '../helpers/harness.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let registryDown = false;

beforeAll(async () => {
  h = await createHarness({
    registry: (real) =>
      new Proxy(real, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            if (registryDown) return Promise.reject(new RegistryUnavailableError('simulated outage'));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as RegistryClient,
  });
});
afterAll(async () => h?.close());

describe('standalone foundation (Phase 1, AC-15 subset)', () => {
  it('reports core ready with no optional components configured', async () => {
    const r = await h.call(null, 'GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ready', core: { database: 'ok' }, optional: {} });
  });

  it('rejects unauthenticated and forged requests', async () => {
    expect((await h.call(null, 'GET', `${M}/me`)).status).toBe(401);
    const forged = { id: 'x', email: 'x', token: 'eyJhbGciOiJFUzI1NiJ9.e30.invalid' };
    expect((await h.call(forged, 'GET', `${M}/me`)).status).toBe(401);
  });

  it('reports effective permissions per site', async () => {
    const r = await h.call(h.users.tech, 'GET', `${M}/me`);
    expect(r.status).toBe(200);
    expect(r.body.maintenance_sites).toEqual([h.siteA1]);
    const perms = r.body.sites[0].permissions as string[];
    expect(perms).toContain('maintenance.work_order.execute');
    expect(perms).not.toContain('maintenance.work_order.approve');
  });
});

describe('included identity service', () => {
  it('rejects wrong passwords without revealing whether the account exists', async () => {
    const bad = await h.platformCall(null, 'POST', '/api/v1/identity/sessions', { tenant: 'acme', email: h.users.tech.email, password: 'wrong-password-123' });
    const missing = await h.platformCall(null, 'POST', '/api/v1/identity/sessions', { tenant: 'acme', email: 'nobody@example.test', password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(bad.body.error.message).toBe(missing.body.error.message);
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const login = await h.platformCall(null, 'POST', '/api/v1/identity/sessions', { tenant: 'acme', email: h.users.tech.email, password: 'correct-horse-battery-staple' });
    const first = login.body.refresh_token;
    const r1 = await h.platformCall(null, 'POST', '/api/v1/identity/token', { grant_type: 'refresh_token', refresh_token: first });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(first);
    const reuse = await h.platformCall(null, 'POST', '/api/v1/identity/token', { grant_type: 'refresh_token', refresh_token: first });
    expect(reuse.status).toBe(401);
  });

  it('publishes OIDC discovery metadata and JWKS', async () => {
    const d = await h.platformCall(null, 'GET', '/.well-known/openid-configuration');
    expect(d.body.jwks_uri).toMatch(/\/api\/v1\/identity\/jwks$/);
    const j = await h.platformCall(null, 'GET', '/api/v1/identity/jwks');
    expect(j.body.keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256' });
    expect(j.body.keys[0].d).toBeUndefined();
  });
});

describe('canonical registry (MA-01..MA-04)', () => {
  let asset: any;

  it('creates one canonical identity per idempotent request', async () => {
    const body = { site_id: h.siteA1, code: 'LIFT-01', name: 'Lifter 1', location: 'Bay 2' };
    const a = await h.platformCall(h.users.assetAdmin, 'POST', '/api/v1/assets', body, { 'idempotency-key': 'create-lift-01' });
    const b = await h.platformCall(h.users.assetAdmin, 'POST', '/api/v1/assets', body, { 'idempotency-key': 'create-lift-01' });
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const c = await h.platformCall(h.users.assetAdmin, 'POST', '/api/v1/assets', { ...body, name: 'Different' }, { 'idempotency-key': 'create-lift-01' });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('idempotency_key_reused');
    const dup = await h.platformCall(h.users.assetAdmin, 'POST', '/api/v1/assets', body);
    expect(dup.status).toBe(409);
    asset = a.body;
  });

  it('requires registry permissions to create assets; maintenance roles do not imply them', async () => {
    const r = await h.platformCall(h.users.sup, 'POST', '/api/v1/assets', { site_id: h.siteA1, code: 'X-1', name: 'X' });
    expect(r.status).toBe(403);
  });

  it('conceals assets across tenants and sites', async () => {
    expect((await h.platformCall(h.users.supB, 'GET', `/api/v1/assets/${asset.id}`)).status).toBe(404);
    expect((await h.platformCall(h.users.supA2, 'GET', `/api/v1/assets/${asset.id}`)).status).toBe(404);
    expect((await h.call(h.users.supB, 'GET', `${M}/asset-profiles/${asset.id}`)).status).toBe(404);
    expect((await h.call(h.users.supA2, 'GET', `${M}/asset-profiles/${asset.id}`)).status).toBe(404);
    const list = await h.call(h.users.supA2, 'GET', `${M}/asset-profiles`);
    expect(list.body.items.map((i: any) => i.asset.id)).not.toContain(asset.id);
  });

  it('shows registry renames in Maintenance without reconciliation (MA-03)', async () => {
    const r = await h.platformCall(h.users.assetAdmin, 'PATCH', `/api/v1/assets/${asset.id}`, { name: 'Lifter One' }, { 'if-match': '1' });
    expect(r.status).toBe(200);
    const stale = await h.platformCall(h.users.assetAdmin, 'PATCH', `/api/v1/assets/${asset.id}`, { name: 'Stale' }, { 'if-match': '1' });
    expect(stale.status).toBe(409);
    const view = await h.call(h.users.sup, 'GET', `${M}/asset-profiles/${asset.id}`);
    expect(view.body.asset.name).toBe('Lifter One');
    expect(view.body.identity_source).toBe('registry');
  });

  it('prevents hierarchy cycles', async () => {
    const child = await h.createAsset(h.users.assetAdmin, h.siteA1, 'LIFT-01-HYD', 'Hydraulic unit');
    await h.platformCall(h.users.assetAdmin, 'PATCH', `/api/v1/assets/${child.id}`, { parent_id: asset.id }, { 'if-match': '1' });
    const cyc = await h.platformCall(h.users.assetAdmin, 'PATCH', `/api/v1/assets/${asset.id}`, { parent_id: child.id }, { 'if-match': '2' });
    expect(cyc.status).toBe(422);
  });

  it('resolves QR tokens only for authenticated, authorized users', async () => {
    expect((await h.call(null, 'GET', `${M}/qr/${asset.qr_token}`)).status).toBe(401);
    expect((await h.call(h.users.supA2, 'GET', `${M}/qr/${asset.qr_token}`)).status).toBe(404);
    const r = await h.call(h.users.reporter, 'GET', `${M}/qr/${asset.qr_token}`);
    expect(r.status).toBe(200);
    expect(r.body.asset_id).toBe(asset.id);
  });

  it('import preview links by code or external reference and never merges by name', async () => {
    const r = await h.platformCall(h.users.assetAdmin, 'POST', '/api/v1/assets/import/preview', {
      rows: [
        { site_id: h.siteA1, code: 'LIFT-01', name: 'Anything' },
        { site_id: h.siteA1, code: 'NEW-9', name: 'Lifter One' },
        { site_id: h.siteA1, code: 'NEW-10', name: 'Brand new pump' },
      ],
    });
    expect(r.body.decisions.map((d: any) => d.action)).toEqual(['link', 'ambiguous', 'create']);
    const commit = await h.platformCall(h.users.assetAdmin, 'POST', '/api/v1/assets/import/commit', { rows: [{ site_id: h.siteA1, code: 'NEW-9', name: 'Lifter One' }] });
    expect(commit.status).toBe(409);
  });
});

describe('maintenance profiles (MA-02)', () => {
  let assetId: string;
  beforeAll(async () => {
    assetId = (await h.createAsset(h.users.assetAdmin, h.siteA1, 'PUMP-01', 'Pump 1')).id;
  });

  it('allows one profile per asset, requires profile permission and version checks', async () => {
    const body = { maintainable: true, criticality: 'a_critical', team_id: h.teamA1 };
    expect((await h.call(h.users.tech, 'PUT', `${M}/asset-profiles/${assetId}`, body)).status).toBe(403);
    const created = await h.call(h.users.assetAdmin, 'PUT', `${M}/asset-profiles/${assetId}`, body);
    expect(created.status).toBe(200);
    expect(created.body.profile.version).toBe(1);
    const noVersion = await h.call(h.users.assetAdmin, 'PUT', `${M}/asset-profiles/${assetId}`, body);
    expect(noVersion.status).toBe(422);
    const updated = await h.call(h.users.assetAdmin, 'PUT', `${M}/asset-profiles/${assetId}`, { ...body, criticality: 'b_important', record_version: 1 });
    expect(updated.body.profile.version).toBe(2);
    const stale = await h.call(h.users.assetAdmin, 'PUT', `${M}/asset-profiles/${assetId}`, { ...body, record_version: 1 });
    expect(stale.status).toBe(409);
    const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.profile WHERE asset_id = $1`, [assetId]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects a team from a different site', async () => {
    const otherTeam = await h.call(h.users.admin, 'POST', `${M}/teams`, { site_id: h.siteA2, name: 'A2 team' });
    const r = await h.call(h.users.assetAdmin, 'PUT', `${M}/asset-profiles/${assetId}`, { maintainable: true, team_id: otherTeam.body.id, record_version: 2 });
    expect(r.status).toBe(422);
  });

  it('serves cached identity snapshots during a registry outage (MA-08)', async () => {
    registryDown = true;
    try {
      const r = await h.call(h.users.sup, 'GET', `${M}/asset-profiles/${assetId}`);
      expect(r.status).toBe(200);
      expect(r.body.identity_source).toBe('snapshot');
      const unknown = await h.call(h.users.sup, 'GET', `${M}/asset-profiles/00000000-0000-4000-8000-000000000000`);
      expect(unknown.status).toBe(503);
      expect(unknown.body.error.code).toBe('registry_unavailable');
    } finally {
      registryDown = false;
    }
  });
});

describe('local licensing (ML-02)', () => {
  it('exposes entitlement state without license secrets', async () => {
    const r = await h.call(h.users.tech, 'GET', `${M}/entitlements`);
    expect(r.body.status).toBe('valid');
    expect(r.body.capabilities).toContain('core.create_work');
    expect(JSON.stringify(r.body)).not.toMatch(/signature/);
  });

  it('rejects a license for another installation and records the attempt', async () => {
    const r = await h.call(h.users.admin, 'POST', `${M}/licenses`, h.signLicense({ installation_id: 'someone-else' }));
    expect(r.status).toBe(422);
    const { rows } = await h.db.query(`SELECT status FROM maintenance.license_installation WHERE tenant_id = $1 ORDER BY imported_at`, [h.tenantA]);
    expect(rows.map((x) => x.status)).toEqual(['active', 'rejected']);
    expect((await h.call(h.users.tech, 'GET', `${M}/entitlements`)).body.status).toBe('valid');
  });

  it('only license administrators can import licenses', async () => {
    expect((await h.call(h.users.sup, 'POST', `${M}/licenses`, h.signLicense())).status).toBe(403);
  });

  it('keeps audit events append-only even for the application role', async () => {
    await expect(h.db.query(`DELETE FROM maintenance.audit_event`)).rejects.toThrow(/append-only/);
  });
});
