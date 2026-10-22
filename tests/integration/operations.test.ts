import { createHash, randomBytes } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRegistryBinding, createServices, dispatchOutbox, operationalHealth, runPmScheduler, watchLicenses, type Services } from '@vm/core';
import { createPool, type Db } from '@vm/db';
import { buildMaintenanceApp } from '@vm/maintenance-api';
import { maintenanceJobs, startWorker } from '@vm/maintenance-worker';
import { createBackup, restoreBackup, verifyBackup, type BackupManifest } from '@vm/ops';
import { FixedClock } from '@vm/server-kit';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { publishSimpleProcedure } from '../helpers/work.ts';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://localhost:5432/postgres';
const M = '/api/v1/maintenance';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('restore-me')]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function createDatabase(): Promise<{ name: string; url: string }> {
  const name = `vm_restore_${randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropDatabase(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.end();
}

async function weeklyPlan(h: Harness, code: string, procRev: string) {
  const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, code);
  const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, { site_id: h.siteA1, asset_id: asset.id, title: `PM ${code}` });
  const rev = await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
    title: `Inspect ${code}`, scope: 'Weekly inspection', procedure_revision_id: procRev, team_id: h.teamA1, estimated_minutes: 30, lead_days: 7,
    trigger: { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2026-10-03', time_of_day: '09:00' }, effective_from: '2026-10-01',
  });
  expect((await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${rev.body.id}/publish`)).status).toBe(200);
  return { asset, planId: plan.body.id as string };
}

describe('backup and restore (AC-12)', () => {
  let h: Harness;
  let restored: { name: string; url: string } | null = null;
  let other: { name: string; url: string } | null = null;
  let restoredDb: Db | null = null;
  let backupDir: string;
  let manifest: BackupManifest;
  let planId: string;
  let attachmentKey: string;

  beforeAll(async () => {
    h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
    const procRev = await publishSimpleProcedure(h);
    ({ planId } = await weeklyPlan(h, 'BK-1', procRev));
    expect((await runPmScheduler(h.services, 'w1', { tenantId: h.tenantA })).issued).toBe(1);

    const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'BK-2');
    const req = await h.call(h.users.reporter, 'POST', `${M}/requests`, { site_id: h.siteA1, asset_id: asset.id, description: 'Leaking seal', observed_at: '2026-09-30T08:00:00Z', proposed_priority: 'normal' });
    const slot = await h.call(h.users.reporter, 'POST', `${M}/attachments`, { owner_type: 'request', owner_id: req.body.id, file_name: 'seal.png', media_type: 'image/png', size_bytes: PNG.length, sha256: sha(PNG) });
    expect(slot.status, JSON.stringify(slot.body)).toBe(201);
    const put = await h.call(h.users.reporter, 'PUT', slot.body.upload_url, PNG, { 'content-type': 'application/octet-stream' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    attachmentKey = (await h.db.query(`SELECT storage_key FROM maintenance.attachment WHERE id = $1`, [slot.body.id])).rows[0].storage_key;
  });

  afterAll(async () => {
    await restoredDb?.end();
    if (restored) await dropDatabase(restored.name);
    if (other) await dropDatabase(other.name);
    await h?.close();
  });

  it('writes a manifest with snapshot-consistent counts, attachment hashes and pending events', async () => {
    const credsFile = path.join(h.tmp, 'system-credentials.json');
    await writeFile(credsFile, JSON.stringify(h.systemCredentials), { mode: 0o600 });
    ({ dir: backupDir, manifest } = await createBackup({
      platformDatabaseUrl: h.databaseUrl,
      maintenanceDatabaseUrl: h.databaseUrl,
      blobRoot: h.blobRoot,
      outDir: path.join(h.tmp, 'backups'),
      configFiles: { 'system-credentials.json': credsFile, 'absent.json': path.join(h.tmp, 'nope.json') },
    }));
    expect(manifest.databases.map((d) => d.name)).toEqual(['combined']);
    expect(manifest.installation_id).toBe(h.installationId);
    expect(manifest.registry_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(manifest.blobs.files).toHaveLength(1);
    expect(manifest.blobs.files[0]!.sha256).toBe(sha(PNG));
    expect(manifest.blob_problems).toEqual([]);
    expect(manifest.pending_outbox_events).toBeGreaterThan(0);
    expect(manifest.config_files.map((f) => f.name)).toEqual(['system-credentials.json']);
    const counts = manifest.databases[0]!.table_counts;
    expect(counts['maintenance.pm_occurrence']).toBe(1);
    expect(counts['platform.asset']).toBe(2);
    expect(manifest.databases[0]!.schema_versions).toMatchObject({ platform: '0002', maintenance: '0013', integration: '0001' });
    expect((await verifyBackup(backupDir)).failures).toEqual([]);
    const health = await operationalHealth(h.services);
    expect(health.backup).toMatchObject({ completed_at: manifest.completed_at });
  });

  it('refuses a damaged backup', async () => {
    const damaged = `${backupDir}-damaged`;
    await cp(backupDir, damaged, { recursive: true });
    await writeFile(path.join(damaged, 'blobs', manifest.blobs.files[0]!.path), 'tampered');
    expect((await verifyBackup(damaged)).failures).toEqual([manifest.blobs.files[0]!.path]);
    other = await createDatabase();
    await expect(
      restoreBackup({ backupDir: damaged, platformDatabaseUrl: other.url, maintenanceDatabaseUrl: other.url, blobRoot: path.join(h.tmp, 'blobs-damaged') }),
    ).rejects.toThrow(/damaged/);
  });

  it('restores records, attachment bytes, config and pending events into an empty installation', async () => {
    restored = await createDatabase();
    const report = await restoreBackup({
      backupDir,
      platformDatabaseUrl: restored.url,
      maintenanceDatabaseUrl: restored.url,
      blobRoot: path.join(h.tmp, 'blobs-restored'),
      configTargets: { 'system-credentials.json': path.join(h.tmp, 'restored-secrets', 'system-credentials.json') },
    });
    expect(report).toMatchObject({ ok: true, count_mismatches: [], blob_hash_failures: [], blobs_restored: 1, config_restored: ['system-credentials.json'], installation_id: h.installationId });
    expect(JSON.parse(await readFile(path.join(h.tmp, 'restored-secrets', 'system-credentials.json'), 'utf8'))).toEqual(h.systemCredentials);

    await expect(
      restoreBackup({ backupDir, platformDatabaseUrl: restored.url, maintenanceDatabaseUrl: restored.url, blobRoot: path.join(h.tmp, 'blobs-again') }),
    ).rejects.toThrow(/restore requires an empty database/);
    await expect(
      restoreBackup({ backupDir, platformDatabaseUrl: restored.url, maintenanceDatabaseUrl: restored.url, blobRoot: path.join(h.tmp, 'blobs-restored') }),
    ).rejects.toThrow(/not empty/);
  });

  it('keeps license, registry identity and PM uniqueness after restore, and delivers pending events once', async () => {
    restoredDb = createPool(restored!.url, { max: 5 });
    const rs: Services = createServices({
      db: restoredDb,
      platformUrl: h.platformUrl,
      clock: new FixedClock(new Date('2026-10-01T00:00:00Z')),
      blobRoot: path.join(h.tmp, 'blobs-restored'),
      licensePublicKeys: { [h.licenseKey.kid]: h.licenseKey.publicKeyPem },
      systemCredentials: h.systemCredentials,
      config: { downloadLinkSecret: randomBytes(32).toString('hex') },
      entitlementCacheTtlMs: 0,
    });
    rs.registry = h.services.registry;
    expect((await rs.entitlements.view(h.tenantA)).status).toBe('valid');
    expect((await checkRegistryBinding(rs, { bind: false })).status).toBe('bound');

    // Stale scheduling pointers (as after restoring onto a fresh worker) must not re-issue the occurrence.
    await restoredDb.query(`UPDATE maintenance.pm_plan SET next_generate_at = NULL, last_occurrence_due_at = NULL WHERE id = $1`, [planId]);
    const sum = await runPmScheduler(rs, 'restored-worker', { tenantId: h.tenantA });
    expect(sum.issued).toBe(0);
    const occ = await restoredDb.query(`SELECT count(*)::int AS n FROM maintenance.pm_occurrence WHERE plan_id = $1`, [planId]);
    const wo = await restoredDb.query(`SELECT count(*)::int AS n FROM maintenance.work_order WHERE plan_occurrence_id IS NOT NULL`);
    expect([occ.rows[0].n, wo.rows[0].n]).toEqual([1, 1]);

    const out = await dispatchOutbox(rs, 'restored-worker', { batch: 500 });
    expect(out.delivered).toBe(manifest.pending_outbox_events);
    expect((await dispatchOutbox(rs, 'restored-worker', { batch: 500 })).delivered).toBe(0);

    expect(sha(await buffer(await rs.blobs.get(attachmentKey)))).toBe(sha(PNG));
  });
});

describe('license grace and expiry in the worker (AC-20, ML-03)', () => {
  let h: Harness;
  let planId: string;

  beforeAll(async () => {
    h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
    const lic = h.signLicense({ features: ['core'], term: { starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-10-10T00:00:00Z' }, grace_days: 14 });
    expect((await h.call(h.users.admin, 'POST', `${M}/licenses`, lic)).status).toBe(201);
    const procRev = await publishSimpleProcedure(h);
    ({ planId } = await weeklyPlan(h, 'LIC-1', procRev));
  });
  afterAll(async () => h?.close());

  const watch = () => watchLicenses(h.services, 'w1', [h.tenantA]);

  it('records the initial state without notifying, then notifies administrators once per change', async () => {
    expect(await watch()).toEqual([{ tenant_id: h.tenantA, status: 'valid', changed: false }]);
    expect((await watch())[0]!.changed).toBe(false);
    h.clock.set(new Date('2026-10-12T00:00:00Z'));
    expect(await watch()).toEqual([{ tenant_id: h.tenantA, status: 'grace', changed: true }]);
    expect((await watch())[0]!.changed).toBe(false);
    await dispatchOutbox(h.services, 'w1');
    const notes = await h.call(h.users.admin, 'GET', `${M}/notifications`);
    const lic = notes.body.items.filter((n: any) => n.kind === 'license.status_changed');
    expect(lic).toHaveLength(1);
    expect(lic[0].title).toBe('License status: grace');
    expect((await h.call(h.users.tech, 'GET', `${M}/notifications`)).body.items.some((n: any) => n.kind === 'license.status_changed')).toBe(false);
    const audit = await h.db.query(`SELECT detail FROM maintenance.audit_event WHERE action = 'license.status_changed'`);
    expect(audit.rows[0].detail).toMatchObject({ from: 'valid', to: 'grace' });
  });

  it('keeps generating PM during grace', async () => {
    expect((await runPmScheduler(h.services, 'w1', { tenantId: h.tenantA })).issued).toBeGreaterThan(0);
  });

  it('after grace blocks new work and PM generation but keeps every record readable and exportable', async () => {
    const before = await h.db.query(`SELECT (SELECT count(*) FROM maintenance.work_order)::int AS wo, (SELECT count(*) FROM maintenance.pm_occurrence)::int AS occ`);
    h.clock.set(new Date('2026-11-05T00:00:00Z'));
    expect((await watch())[0]).toMatchObject({ status: 'expired', changed: true });
    const sum = await runPmScheduler(h.services, 'w1', { tenantId: h.tenantA });
    expect(sum.issued).toBe(0);
    expect(sum.blocked).toBeGreaterThan(0);
    const plan = await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`);
    expect(plan.body.last_generation_issue).toMatch(/license/);

    const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'LIC-2');
    const create = await h.call(h.users.sup, 'POST', `${M}/work-orders`, { site_id: h.siteA1, asset_id: asset.id, title: 'New', priority: 'normal', team_id: h.teamA1, scope: 'x' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('entitlement_required');
    const fault = await h.call(h.users.reporter, 'POST', `${M}/requests`, { site_id: h.siteA1, asset_id: asset.id, description: 'Still reportable', observed_at: '2026-11-04T08:00:00Z', proposed_priority: 'normal' });
    expect(fault.status).toBe(201);
    expect((await h.call(h.users.sup, 'GET', `${M}/work-orders?site_id=${h.siteA1}`)).status).toBe(200);
    const csv = await h.call(h.users.sup, 'GET', `${M}/exports/work_orders.csv?site_id=${h.siteA1}&from=2026-09-01T00:00:00Z&to=2026-12-01T00:00:00Z`);
    expect(csv.status).toBe(200);
    const after = await h.db.query(`SELECT (SELECT count(*) FROM maintenance.work_order)::int AS wo, (SELECT count(*) FROM maintenance.pm_occurrence)::int AS occ`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('operational health and worker job status (docs/08 Monitoring)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
  });
  afterAll(async () => h?.close());

  it('restricts details to administrators or the monitoring token', async () => {
    expect((await h.call(null, 'GET', '/health/details')).status).toBe(401);
    expect((await h.call(h.users.tech, 'GET', '/health/details')).status).toBe(403);
    const r = await h.call(h.users.admin, 'GET', '/health/details');
    expect(r.status).toBe(200);
    expect(r.body.registry.status).toBe('bound');
    expect(r.body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/No maintenance worker/), expect.stringMatching(/No completed backup/)]));

    const token = randomBytes(24).toString('hex');
    const app = await buildMaintenanceApp({ services: h.services, auth: { issuer: 'http://platform.test', audience: 'visibility-maintenance', jwksUrl: `${h.platformUrl}/api/v1/identity/jwks` }, monitoringToken: token });
    try {
      expect((await app.inject({ method: 'GET', url: '/health/details', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/health/details', headers: { authorization: `Bearer ${token}x` } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('reports heartbeats, stale workers and failing jobs', async () => {
    const jobs = [
      maintenanceJobs({ services: h.services, workerId: 'w-ok', tenantIds: () => [] }).find((j) => j.name === 'heartbeat')!,
      { name: 'boom', intervalMs: 60_000, run: async () => { throw new Error('disk full'); } },
    ];
    const worker = startWorker(jobs, { services: h.services, workerId: 'w-ok' });
    await worker.stop();
    let health = await operationalHealth(h.services);
    expect(health.workers).toEqual([{ worker_id: 'w-ok', age_seconds: 0, stale: false }]);
    expect(health.failing_jobs).toEqual([{ job: 'boom', worker_id: 'w-ok', at: '2026-10-01T00:00:00.000Z', error: 'disk full' }]);
    h.clock.advance(10 * 60_000);
    health = await operationalHealth(h.services);
    expect(health.workers[0]!.stale).toBe(true);
    expect(health.warnings).toEqual(expect.arrayContaining(['All maintenance workers are stale.', 'Failing background jobs: boom.']));
  });
});
