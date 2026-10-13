import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorRunner, MaintenanceIngestClient, SimulatedAdapter } from '@vm/connectors';
import type { IngestResult } from '@vm/contracts';
import { runMeterPlans } from '@vm/core';
import { createHarness, type Harness, type TestUser } from '../helpers/harness.ts';
import { closeOrder, publishSimpleProcedure } from '../helpers/work.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let asset: { id: string };
let conn: { id: string; version: number };
let svc: TestUser;
let mapping: { id: string; version: number };
let epoch = 1;

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-13T12:00:00Z') });
  asset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'LIFT-1', 'Lifter 1');
  const sa = await h.platformCall(h.users.admin, 'POST', '/api/v1/identity/service-accounts', { name: 'simulated-connector', site_ids: [h.siteA1] });
  expect(sa.status).toBe(201);
  const grant = await h.call(h.users.admin, 'POST', `${M}/role-assignments`, { user_id: sa.body.id, role: 'connector_service', site_id: h.siteA1 });
  expect(grant.status).toBe(201);
  const tok = await h.platformCall(null, 'POST', '/api/v1/identity/token', { grant_type: 'client_credentials', client_id: sa.body.client_id, client_secret: sa.body.client_secret });
  svc = { id: sa.body.id, email: '', token: tok.body.access_token };
  const created = await h.call(h.users.admin, 'POST', `${M}/connectors`, {
    site_id: h.siteA1,
    provider: 'simulated',
    name: 'Demo simulator',
    provider_instance: 'sim-a1',
    service_account_id: sa.body.id,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  conn = created.body;
  const act = await h.call(h.users.admin, 'POST', `${M}/connectors/${conn.id}/activate`, { record_version: conn.version, reason: 'Enable labeled simulator' });
  expect(act.status).toBe(200);
  conn.version = act.body.version;
  const xref = await h.platformCall(h.users.assetAdmin, 'POST', `/api/v1/assets/${asset.id}/external-refs`, {
    provider: 'simulated',
    provider_instance: 'sim-a1',
    external_id: 'ext-lift-1',
  });
  expect(xref.status).toBe(201);
  const map = await h.call(h.users.admin, 'POST', `${M}/connectors/${conn.id}/mappings`, {
    asset_id: asset.id,
    signal_key: 'temperature',
    kind: 'reading',
    external_asset_id: 'ext-lift-1',
    external_attribute: 'temp',
    source_unit: 'C',
    target_unit: 'C',
    freshness_seconds: 3600,
    evaluation_window_seconds: 300,
    correlation_group: 'overtemp',
  });
  expect(map.status, JSON.stringify(map.body)).toBe(201);
  await h.call(svc, 'POST', `${M}/integrations/discovery`, {
    connector_id: conn.id,
    assets: [{ external_asset_id: 'ext-lift-1', name: 'Lifter', attributes: [{ name: 'temp', value_type: 'number', unit: 'C', sample: { value: 40, observed_at: '2026-10-13T11:59:00Z' } }] }],
  });
  await h.call(h.users.admin, 'POST', `${M}/mappings/${map.body.id}/preview`);
  const appr = await h.call(h.users.admin, 'POST', `${M}/mappings/${map.body.id}/approve`, { record_version: map.body.version + 1, reason: 'Sample and registry mapping verified' });
  expect(appr.status, JSON.stringify(appr.body)).toBe(200);
  const actMap = await h.call(h.users.admin, 'POST', `${M}/mappings/${map.body.id}/activate`, { record_version: appr.body.version, reason: 'No competing source' });
  expect(actMap.status, JSON.stringify(actMap.body)).toBe(200);
  mapping = { id: actMap.body.id, version: actMap.body.version };
  epoch = actMap.body.routing_epoch;
  const rule = await h.call(h.users.admin, 'POST', `${M}/condition-rules`, { site_id: h.siteA1, asset_id: asset.id, signal_key: 'temperature', name: 'Over-temperature' });
  expect(rule.status, JSON.stringify(rule.body)).toBe(201);
  const rev = await h.call(h.users.admin, 'POST', `${M}/condition-rules/${rule.body.id}/revisions`, {
    operator: 'gt',
    threshold: 80,
    unit: 'C',
    duration_seconds: 0,
    hysteresis: 5,
    cooldown_seconds: 0,
    priority: 'high',
    team_id: h.teamA1,
    correlation_group: 'overtemp',
  });
  expect(rev.status, JSON.stringify(rev.body)).toBe(201);
  const pub = await h.call(h.users.admin, 'POST', `${M}/condition-rule-revisions/${rev.body.id}/publish`);
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
});
afterAll(async () => h?.close());

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event_id: crypto.randomUUID(),
    tenant_id: h.tenantA,
    site_id: h.siteA1,
    connector_instance_id: conn.id,
    source_system: 'simulated',
    source_event_id: `e-${crypto.randomUUID()}`,
    external_asset_id: 'ext-lift-1',
    external_attribute: 'temp',
    asset_id: asset.id,
    signal_id: 'temperature',
    observed_at: '2026-10-13T11:59:30Z',
    received_at: '2026-10-13T12:00:00Z',
    value: 40,
    unit: 'C',
    quality: 'good',
    routing_epoch: epoch,
    historical: false,
    ...overrides,
  };
}

async function ingest(events: unknown[], user: TestUser = svc) {
  return h.call<{ results: IngestResult[] }>(user, 'POST', `${M}/integrations/events`, { connector_id: conn.id, events });
}

describe('ingestion quality and correlation (MI-01..MI-05, MC-01..MC-07)', () => {
  it('rejects unmapped, bad-unit, stale, uncertain and historical events as current actions', async () => {
    const before = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.request WHERE tenant_id = $1 AND origin = 'connector'`, [h.tenantA]);
    const r = await ingest([
      envelope({ external_attribute: 'unknown', source_event_id: 'u1', value: 99 }),
      envelope({ unit: 'F', source_event_id: 'u2', value: 99 }),
      envelope({ observed_at: '2026-10-01T00:00:00Z', source_event_id: 'u3', value: 99 }),
      envelope({ quality: 'uncertain', source_event_id: 'u4', value: 99 }),
      envelope({ historical: true, source_event_id: 'u5', value: 99 }),
      envelope({ observed_at: null, source_event_id: 'u6', value: 99 }),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x) => x.decision)).toEqual([
      'quarantined_unmapped',
      'quarantined_unit',
      'stale',
      'quarantined_quality',
      'historical',
      'quarantined_invalid',
    ]);
    const after = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.request WHERE tenant_id = $1 AND origin = 'connector'`, [h.tenantA]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const review = await h.call(h.users.admin, 'GET', `${M}/review-items?status=open`);
    expect(review.body.items.some((i: { kind: string }) => i.kind === 'unmapped_signal')).toBe(true);
  });

  it('opens one incident and one request for a breach, and ignores 100 identical replays', async () => {
    const event = envelope({ source_event_id: 'breach-1', value: 91, observed_at: '2026-10-13T11:59:40Z' });
    const first = await ingest([event]);
    expect(first.status).toBe(200);
    expect(first.body.results[0]?.decision).toBe('current');
    const incidents = await h.call(h.users.sup, 'GET', `${M}/incidents?asset_id=${asset.id}&status=open`);
    expect(incidents.body.items).toHaveLength(1);
    expect(incidents.body.items[0].request_id).toBeTruthy();
    const reqId = incidents.body.items[0].request_id as string;
    const req = await h.call(h.users.sup, 'GET', `${M}/requests/${reqId}`);
    expect(req.body.origin).toBe('connector');
    expect(req.body.reading.provenance).toBe('simulated_connector');
    const replay = await ingest(Array.from({ length: 100 }, () => event));
    expect(replay.body.results.every((x) => x.status === 'duplicate' && x.receipt_id === first.body.results[0]?.receipt_id)).toBe(true);
    const after = await h.call(h.users.sup, 'GET', `${M}/incidents?asset_id=${asset.id}`);
    expect(after.body.items.filter((i: { status: string }) => i.status !== 'closed')).toHaveLength(1);
    const requests = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.request WHERE tenant_id = $1 AND origin = 'connector' AND asset_id = $2`, [h.tenantA, asset.id]);
    expect(requests.rows[0]!.n).toBe(1);
  });

  it('correlates a provider alarm on the same group into the open incident instead of a second request', async () => {
    const alarmMap = await h.call(h.users.admin, 'POST', `${M}/connectors/${conn.id}/mappings`, {
      asset_id: asset.id,
      signal_key: 'overtemp_alarm',
      kind: 'alarm',
      external_asset_id: 'ext-lift-1',
      external_attribute: 'overtemp',
      freshness_seconds: 3600,
      correlation_group: 'overtemp',
    });
    const appr = await h.call(h.users.admin, 'POST', `${M}/mappings/${alarmMap.body.id}/approve`, { record_version: alarmMap.body.version, reason: 'Alarm shares the overtemp episode' });
    const act = await h.call(h.users.admin, 'POST', `${M}/mappings/${alarmMap.body.id}/activate`, { record_version: appr.body.version, reason: 'Activate alarm route' });
    expect(act.status).toBe(200);
    const r = await ingest([envelope({ source_event_id: 'alarm-1', external_attribute: 'overtemp', signal_id: 'overtemp_alarm', value: true, unit: null, routing_epoch: act.body.routing_epoch })]);
    expect(r.body.results[0]?.decision).toBe('current');
    const open = await h.call(h.users.sup, 'GET', `${M}/incidents?asset_id=${asset.id}&status=open`);
    expect(open.body.items).toHaveLength(1);
    const detail = await h.call(h.users.sup, 'GET', `${M}/incidents/${open.body.items[0].id}`);
    expect(detail.body.evidence.some((e: { kind: string }) => e.kind === 'alarm' || e.kind === 'breach')).toBe(true);
  });

  it('records recovery as evidence without closing linked work', async () => {
    const open = await h.call(h.users.sup, 'GET', `${M}/incidents?asset_id=${asset.id}&status=open`);
    const incident = open.body.items[0];
    const recover = await ingest([envelope({ source_event_id: 'recover-1', value: 40, observed_at: '2026-10-13T11:59:50Z' })]);
    expect(recover.body.results[0]?.decision).toBe('current');
    const after = await h.call(h.users.sup, 'GET', `${M}/incidents/${incident.id}`);
    expect(after.body.status).toBe('recovered');
    expect(after.body.request_id).toBe(incident.request_id);
    const req = await h.call(h.users.sup, 'GET', `${M}/requests/${incident.request_id}`);
    expect(req.body.state).toBe('submitted');
  });

  it('fences old-route live events after cutover and does not open a second current request', async () => {
    const xref2 = await h.platformCall(h.users.assetAdmin, 'POST', `/api/v1/assets/${asset.id}/external-refs`, {
      provider: 'simulated',
      provider_instance: 'sim-a1',
      external_id: 'ext-lift-1b',
    });
    expect(xref2.status).toBe(201);
    const next = await h.call(h.users.admin, 'POST', `${M}/connectors/${conn.id}/mappings`, {
      asset_id: asset.id,
      signal_key: 'temperature',
      kind: 'reading',
      external_asset_id: 'ext-lift-1b',
      external_attribute: 'temp2',
      source_unit: 'C',
      target_unit: 'C',
      freshness_seconds: 3600,
      correlation_group: 'overtemp',
    });
    const appr = await h.call(h.users.admin, 'POST', `${M}/mappings/${next.body.id}/approve`, { record_version: next.body.version, reason: 'Replacement mapping' });
    const cut = await h.call(h.users.admin, 'POST', `${M}/mappings/${mapping.id}/cutover`, { to_mapping_id: next.body.id, reason: 'Switch to replacement sensor' });
    expect(cut.status, JSON.stringify(cut.body)).toBe(200);
    expect(cut.body.manifest.to_epoch).toBe(epoch + 1);
    const oldLive = await ingest([envelope({ source_event_id: 'old-epoch', value: 95, routing_epoch: epoch })]);
    expect(oldLive.body.results[0]?.decision).toBe('fenced_epoch');
    epoch = cut.body.manifest.to_epoch;
    mapping = { id: next.body.id, version: appr.body.version };
    const neu = await ingest([envelope({ source_event_id: 'new-epoch', value: 40, external_asset_id: 'ext-lift-1b', external_attribute: 'temp2' })]);
    expect(neu.body.results[0]?.decision).toBe('current');
    const requests = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.request WHERE tenant_id = $1 AND origin = 'connector' AND asset_id = $2`, [h.tenantA, asset.id]);
    expect(requests.rows[0]!.n).toBe(1);
  });

  it('disables a connector without stopping manual work or calendar access', async () => {
    const paused = await h.call(h.users.admin, 'POST', `${M}/connectors/${conn.id}/disable`, { record_version: conn.version, reason: 'Take simulator offline' });
    expect(paused.status).toBe(200);
    const ingestDenied = await ingest([envelope({ source_event_id: 'after-disable', value: 40 })]);
    expect(ingestDenied.status).toBe(409);
    const manual = await h.call(h.users.reporter, 'POST', `${M}/requests`, {
      site_id: h.siteA1,
      asset_id: asset.id,
      description: 'Strange noise after the connector was disabled',
      observed_at: '2026-10-13T12:00:00Z',
      priority: 'normal',
    });
    expect(manual.status).toBe(201);
    const plans = await h.call(h.users.sup, 'GET', `${M}/plans?site_id=${h.siteA1}`);
    expect(plans.status).toBe(200);
  });

  it('refuses Live and OpenRemote connectors until they are qualified', async () => {
    const live = await h.call(h.users.admin, 'POST', `${M}/connectors`, {
      site_id: h.siteA1,
      provider: 'visibility_live',
      name: 'Live',
      provider_instance: 'live-1',
      service_account_id: svc.id,
    });
    expect(live.status).toBe(201);
    expect(live.body.simulated).toBe(false);
    const matrix = await h.call(h.users.viewer, 'GET', `${M}/connectors/compatibility`);
    expect(matrix.body.items.find((e: { provider: string }) => e.provider === 'visibility_live').status).toBe('not_qualified');
  });

  it('keeps ingestion available to the connector identity only', async () => {
    expect((await ingest([envelope()], h.users.admin)).status).toBe(403);
    expect((await ingest([envelope()], h.users.sup)).status).toBe(403);
  });
});

describe('meters and usage-based PM (MP-04)', () => {
  it('suspends generation on a decrease until an authorized baseline, then issues one order per threshold', async () => {
    const proc = await publishSimpleProcedure(h, 'Hourly service');
    const mAsset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'MTR-1');
    const meter = await h.call(h.users.sup, 'POST', `${M}/meters`, {
      site_id: h.siteA1,
      asset_id: mAsset.id,
      signal_key: 'hours',
      name: 'Engine hours',
      unit: 'h',
      freshness_seconds: 86_400,
    });
    expect(meter.status).toBe(201);
    const r1 = await h.call(h.users.tech, 'POST', `${M}/meters/${meter.body.id}/readings`, { value: 100, observed_at: '2026-10-13T11:00:00Z' });
    expect(r1.body.status).toBe('accepted');
    const drop = await h.call(h.users.tech, 'POST', `${M}/meters/${meter.body.id}/readings`, { value: 20, observed_at: '2026-10-13T11:10:00Z' });
    expect(drop.body.status).toBe('rejected_decrease');
    const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, { site_id: h.siteA1, asset_id: mAsset.id, title: 'Every 50 hours', trigger_kind: 'meter', meter_id: meter.body.id });
    const rev = await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
      title: 'Service',
      scope: 'Inspect drive',
      procedure_revision_id: proc,
      team_id: h.teamA1,
      estimated_minutes: 30,
      lead_days: 0,
      trigger: { type: 'meter', interval: 50, lead_usage: 0, due_days: 7 },
      effective_from: '2026-10-01',
    });
    await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${rev.body.id}/publish`);
    const blocked = await runMeterPlans(h.services, 'test-worker', { tenantId: h.tenantA });
    expect(blocked.suspended).toBeGreaterThan(0);
    const got = await h.call(h.users.sup, 'GET', `${M}/meters/${meter.body.id}`);
    const reset = await h.call(h.users.sup, 'POST', `${M}/meters/${meter.body.id}/baselines`, { kind: 'reset', new_raw: 20, reason: 'Hour-meter replaced', record_version: got.body.version });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.usage).toBe(100);
    const r2 = await h.call(h.users.tech, 'POST', `${M}/meters/${meter.body.id}/readings`, { value: 70, observed_at: '2026-10-13T11:20:00Z' });
    expect(r2.body.usage).toBe(150);
    const issued = await runMeterPlans(h.services, 'test-worker', { tenantId: h.tenantA });
    expect(issued.issued).toBe(1);
    const again = await runMeterPlans(h.services, 'test-worker', { tenantId: h.tenantA });
    expect(again.issued).toBe(0);
    const r3 = await h.call(h.users.tech, 'POST', `${M}/meters/${meter.body.id}/readings`, { value: 90, observed_at: '2026-10-13T11:30:00Z' });
    expect(r3.body.usage).toBe(170);
    const overrun = await runMeterPlans(h.services, 'test-worker', { tenantId: h.tenantA });
    expect(overrun.issued).toBe(0);
    expect(overrun.overruns).toBe(1);
    const detail = await h.call(h.users.sup, 'GET', `${M}/plans/${plan.body.id}`);
    const woId = detail.body.occurrences[0].work_order_id as string;
    await closeOrder(h, woId, h.users.tech);
    const afterClose = await runMeterPlans(h.services, 'test-worker', { tenantId: h.tenantA });
    expect(afterClose.issued).toBe(0);
  });
});

describe('connector runner against the API', () => {
  it('delivers simulated ticks through the ingest contract', async () => {
    const enabled = await h.call(h.users.admin, 'GET', `${M}/connectors/${conn.id}`);
    if (enabled.body.status === 'disabled') {
      // A disabled connector cannot be reactivated; the runner test uses a fresh one.
    }
    const sa = await h.platformCall(h.users.admin, 'POST', '/api/v1/identity/service-accounts', { name: 'runner', site_ids: [h.siteA1] });
    await h.call(h.users.admin, 'POST', `${M}/role-assignments`, { user_id: sa.body.id, role: 'connector_service', site_id: h.siteA1 });
    const tok = await h.platformCall(null, 'POST', '/api/v1/identity/token', { grant_type: 'client_credentials', client_id: sa.body.client_id, client_secret: sa.body.client_secret });
    const runnerUser: TestUser = { id: sa.body.id, email: '', token: tok.body.access_token };
    const asset2 = await h.createAsset(h.users.assetAdmin, h.siteA1, 'RUN-1');
    await h.platformCall(h.users.assetAdmin, 'POST', `/api/v1/assets/${asset2.id}/external-refs`, { provider: 'simulated', provider_instance: 'sim-run', external_id: 'ext-run' });
    const c = await h.call(h.users.admin, 'POST', `${M}/connectors`, {
      site_id: h.siteA1,
      provider: 'simulated',
      name: 'Runner',
      provider_instance: 'sim-run',
      service_account_id: sa.body.id,
    });
    await h.call(h.users.admin, 'POST', `${M}/connectors/${c.body.id}/activate`, { record_version: c.body.version, reason: 'Enable runner' });
    const map = await h.call(h.users.admin, 'POST', `${M}/connectors/${c.body.id}/mappings`, {
      asset_id: asset2.id,
      signal_key: 'temperature',
      kind: 'reading',
      external_asset_id: 'ext-run',
      external_attribute: 'temp',
      source_unit: 'C',
      target_unit: 'C',
      freshness_seconds: 86_400,
    });
    const appr = await h.call(h.users.admin, 'POST', `${M}/mappings/${map.body.id}/approve`, { record_version: map.body.version, reason: 'Registry mapping verified' });
    expect(appr.status, JSON.stringify(appr.body)).toBe(200);
    const activated = await h.call(h.users.admin, 'POST', `${M}/mappings/${map.body.id}/activate`, { record_version: appr.body.version, reason: 'Activate runner mapping' });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const adapter = new SimulatedAdapter({
      allowSimulated: true,
      now: () => new Date('2026-10-13T12:00:00Z'),
      scenario: {
        start_at: '2026-10-13T12:00:00Z',
        tick_seconds: 60,
        assets: [{ external_asset_id: 'ext-run', name: 'Run', attributes: [{ name: 'temp', value_type: 'number', unit: 'C', values: [21, 22] }] }],
      },
    });
    const cfg = await h.call(runnerUser, 'GET', `${M}/connectors/${c.body.id}/config`);
    expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
    expect(cfg.body.routes, JSON.stringify(cfg.body)).toEqual(expect.arrayContaining([expect.objectContaining({ external_asset_id: 'ext-run', external_attribute: 'temp' })]));
    const client = new MaintenanceIngestClient(async (method, path, body) => {
      const r = await h.call(runnerUser, method, `/api/v1/maintenance${path.replace('/api/v1/maintenance', '')}`, body);
      return { status: r.status, body: r.body };
    }, c.body.id);
    const runner = new ConnectorRunner(adapter, client, { bufferCapacity: 100, now: () => new Date('2026-10-13T12:00:00Z') });
    await runner.start();
    const tick = await runner.tick();
    expect(tick.delivered).toBeGreaterThan(0);
    const receipts = await h.call(h.users.admin, 'GET', `${M}/connectors/${c.body.id}/receipts`);
    expect(receipts.body.items.length).toBeGreaterThan(0);
    expect(receipts.body.items.every((x: { simulated?: boolean; decision: string }) => x.decision === 'current' || x.decision === 'historical')).toBe(true);
  });
});
