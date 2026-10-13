import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { publishSimpleProcedure, readyOrder } from '../helpers/work.ts';

const M = '/api/v1/maintenance';
const PERIOD = 'from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z';
let h: Harness;
let k1: string;
let k2: string;
let k3: string;
let k4: string;
let procRev: string;
let f1: string;

const downtime = async (asset: string, start: string, end: string | null, classification = 'unplanned_failure', user = h.users.sup, extra: Record<string, unknown> = {}) => {
  const r = await h.call(user, 'POST', `${M}/downtime-events`, { asset_id: asset, started_at: start, restored_at: end, classification, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const report = async (metric: string, extra = '', user = h.users.sup) => h.call(user, 'GET', `${M}/reports/${metric}?site_id=${h.siteA1}&${PERIOD}${extra}`);

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-11-15T00:00:00Z') });
  [k1, k2, k3, k4] = await Promise.all(['K1', 'K2', 'K3', 'K4'].map(async (c) => (await h.createAsset(h.users.assetAdmin, h.siteA1, c)).id));
  procRev = await publishSimpleProcedure(h);

  const exposure = (asset: string, hours: number) =>
    h.call(h.users.sup, 'POST', `${M}/operating-exposure`, { asset_id: asset, period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z', hours, basis: 'verified', source: 'shift log' });
  expect((await exposure(k1, 100)).status).toBe(201);
  expect((await exposure(k3, 50)).status).toBe(201);

  // K1: two qualifying failures restored after 2h and 4h, plus non-failure stops.
  f1 = (await downtime(k1, '2026-10-10T10:00:00Z', '2026-10-10T12:00:00Z')).id;
  await downtime(k1, '2026-10-20T14:00:00Z', '2026-10-20T18:00:00Z');
  await downtime(k1, '2026-10-12T00:00:00Z', '2026-10-12T08:00:00Z', 'planned_stop');
  await downtime(k1, '2026-10-14T00:00:00Z', '2026-10-14T01:00:00Z', 'communication_loss');
  // K2: overlapping intervals and one open failure.
  await downtime(k2, '2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z');
  await downtime(k2, '2026-10-05T11:00:00Z', '2026-10-05T13:00:00Z');
  await downtime(k2, '2026-10-28T00:00:00Z', null);
  // K4: a technician-recorded candidate that is not yet validated.
  await downtime(k4, '2026-10-15T00:00:00Z', '2026-10-15T02:00:00Z', 'candidate', h.users.tech);
});
afterAll(async () => h?.close());

describe('downtime records (MD-01..MD-04)', () => {
  it('records technician downtime unvalidated and only lets supervisors correct it, keeping history', async () => {
    const e = await downtime(k4, '2026-10-16T00:00:00Z', null, 'unplanned_failure', h.users.tech);
    expect(e).toMatchObject({ validated: false, open: true, classification: 'unplanned_failure' });
    expect((await h.call(h.users.tech, 'POST', `${M}/downtime-events/${e.id}/amendments`, { record_version: e.version, reason: 'Correct it', changes: { validated: true } })).status).toBe(403);
    const restored = await h.call(h.users.tech, 'POST', `${M}/downtime-events/${e.id}/restore`, { record_version: e.version, restored_at: '2026-10-16T03:00:00Z' });
    expect(restored.status).toBe(200);
    expect((await h.call(h.users.tech, 'POST', `${M}/downtime-events/${e.id}/restore`, { record_version: restored.body.version, restored_at: '2026-10-16T04:00:00Z' })).status).toBe(409);
    const amended = await h.call(h.users.sup, 'POST', `${M}/downtime-events/${e.id}/amendments`, {
      record_version: restored.body.version,
      reason: 'Restoration time confirmed from shift log; reclassified as break',
      changes: { classification: 'break', validated: true, restored_at: '2026-10-16T02:30:00Z' },
    });
    expect(amended.status, JSON.stringify(amended.body)).toBe(201);
    const full = (await h.call(h.users.viewer, 'GET', `${M}/downtime-events/${e.id}`)).body;
    expect(full.amendments).toHaveLength(1);
    expect(full.amendments[0].original).toEqual({ classification: 'unplanned_failure', validated: false, restored_at: '2026-10-16T03:00:00.000Z' });
    expect(full.amendments[0].reason).toMatch(/shift log/);
    expect((await h.call(h.users.sup, 'POST', `${M}/downtime-events/${e.id}/amendments`, { record_version: full.version, reason: 'invalid', changes: { classification: 'candidate' } })).status).toBe(422);
    await expect(h.db.query(`DELETE FROM maintenance.failure_amendment WHERE failure_event_id = $1`, [e.id])).rejects.toThrow();
  });

  it('links several orders to one failure without double counting it', async () => {
    const a = await readyOrder(h, { assetId: k1, procedureRevisionId: procRev, assignee: h.users.tech });
    const b = await readyOrder(h, { assetId: k1, procedureRevisionId: procRev, assignee: h.users.tech2 });
    for (const wo of [a.id, b.id]) expect((await h.call(h.users.tech, 'POST', `${M}/work-orders/${wo}/failure-links`, { failure_event_id: f1 })).status).toBe(201);
    expect((await h.call(h.users.tech, 'POST', `${M}/work-orders/${a.id}/failure-links`, { failure_event_id: f1 })).status).toBe(201);
    const other = await readyOrder(h, { assetId: k2, procedureRevisionId: procRev, assignee: h.users.tech });
    expect((await h.call(h.users.tech, 'POST', `${M}/work-orders/${other.id}/failure-links`, { failure_event_id: f1 })).status).toBe(422);
    const ev = (await h.call(h.users.sup, 'GET', `${M}/downtime-events/${f1}`)).body;
    expect(ev.work_orders).toHaveLength(2);
    const fc = await report('failure_count', `&asset_id=${k1}`);
    expect(fc.body.value).toBe(2);
  });
});

describe('KPI reconciliation (AC-11)', () => {
  it('MTBF is 50 hours for 100 verified hours and two failures', async () => {
    const r = await report('mtbf');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((i: any) => [i.asset_id, i]));
    expect(byId[k1]).toMatchObject({ status: 'ok', mtbf_hours: 50, exposure_hours: 100, failures: 2, approximate: false });
    expect(byId[k3]).toMatchObject({ status: 'no_observed_failure', mtbf_hours: null, exposure_hours: 50 });
    expect(byId[k4]).toMatchObject({ status: 'unavailable_no_exposure', mtbf_hours: null });
    expect(r.body.coverage.assets_missing_exposure).toBeGreaterThanOrEqual(1);
    expect(r.body.period.site_timezone).toBe('Asia/Karachi');
  });

  it('MTTR is 3 hours for restorations of 2 and 4 hours, with open failures shown separately', async () => {
    const r = await report('mttr', `&asset_id=${k1}`);
    expect(r.body).toMatchObject({ mttr_hours: 3, restored: 2 });
    const site = await report('mttr');
    expect(site.body.open_failures.map((o: any) => o.asset_id)).toContain(k2);
  });

  it('merges overlapping downtime to 3 hours and separates planned from unplanned', async () => {
    const r = await report('downtime');
    const byId = Object.fromEntries(r.body.items.map((i: any) => [i.asset_id, i]));
    expect(byId[k2].open_events).toBe(1);
    const k2Only = await h.call(h.users.sup, 'GET', `${M}/reports/downtime?site_id=${h.siteA1}&from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z&asset_id=${k2}`);
    expect(k2Only.body.items[0].unplanned_hours).toBe(3);
    expect(byId[k1]).toMatchObject({ unplanned_hours: 6, planned_hours: 8, other_hours: 1 });
    expect(r.body.exclusions[0].count).toBeGreaterThanOrEqual(1);
  });

  it('excludes planned stops, communication loss and unvalidated events from failure counts', async () => {
    const r = await report('failure_count');
    expect(r.body.value).toBe(5);
    const reasons = r.body.exclusions.map((e: any) => e.reason);
    expect(reasons).toEqual(expect.arrayContaining(['classified planned_stop', 'classified communication_loss', 'not validated']));
  });

  it('requires report permission, and cost permission for cost metrics', async () => {
    expect((await report('mtbf', '', h.users.reporter)).status).toBe(403);
    expect((await report('maintenance_cost', '', h.users.sup)).status).toBe(403);
    expect((await report('maintenance_cost', '', h.users.costSup)).status).toBe(200);
    expect((await h.call(h.users.supB, 'GET', `${M}/reports/mtbf?site_id=${h.siteA1}&${PERIOD}`)).status).toBe(403);
  });
});

describe('exports', () => {
  it('scopes exports, hides cost columns without cost permission, and neutralizes formulas', async () => {
    await h.call(h.users.reporter, 'POST', `${M}/requests`, { site_id: h.siteA1, location_text: 'Yard', description: '=HYPERLINK("http://evil","x")', observed_at: '2026-11-14T00:00:00Z' });
    const q = `site_id=${h.siteA1}&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`;
    const req = await h.call(h.users.sup, 'GET', `${M}/exports/requests.csv?${q}`);
    expect(req.status).toBe(200);
    expect(req.headers['content-type']).toMatch(/text\/csv/);
    expect(req.body).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    const wo = (await h.call(h.users.sup, 'GET', `${M}/work-orders?site_id=${h.siteA1}&state=ready&assignee=${h.users.tech.id}&limit=1`)).body.items[0];
    await h.call(h.users.tech, 'POST', `${M}/work-orders/${wo.id}/transitions`, { action: 'start', record_version: wo.version });
    const labor = await h.call(h.users.tech, 'POST', `${M}/work-orders/${wo.id}/labor`, { started_at: '2026-11-14T08:00:00Z', duration_minutes: 30 });
    expect(labor.status, JSON.stringify(labor.body)).toBe(201);
    const plain = await h.call(h.users.sup, 'GET', `${M}/exports/labor?${q}`);
    expect(plain.body.split('\r\n')[0]).not.toContain('hourly_rate');
    const costed = await h.call(h.users.costSup, 'GET', `${M}/exports/labor?${q}`);
    expect(costed.body.split('\r\n')[0]).toContain('hourly_rate');
    expect((await h.call(h.users.tech, 'GET', `${M}/exports/requests?${q}`)).status).toBe(403);
    expect((await h.call(h.users.supB, 'GET', `${M}/exports/requests?${q}`)).status).toBe(403);
    const audit = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.audit_event WHERE action = 'export.generated'`);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
  });
});
