import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPmScheduler } from '@vm/core';
import { createHarness, type Harness, type TestUser } from '../helpers/harness.ts';
import { publishSimpleProcedure } from '../helpers/work.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let procedureRevisionId: string;

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
  procedureRevisionId = await publishSimpleProcedure(h, 'Completion service');
});
afterAll(async () => h?.close());

const run = () => runPmScheduler(h.services, 's5-worker', { tenantId: h.tenantA });
const orders = (planId: string) => h.db.query(
  `SELECT w.id, w.state, w.closed_at, w.cancel_exemption, o.occurrence_key, o.due_at
     FROM maintenance.pm_occurrence o
     LEFT JOIN maintenance.work_order w ON w.id = o.work_order_id
    WHERE o.plan_id = $1 ORDER BY o.created_at`,
  [planId],
);

async function publishedPlan(code: string, trigger: Record<string, unknown>) {
  const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, code);
  const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, {
    site_id: h.siteA1,
    asset_id: asset.id,
    title: `Completion ${code}`,
    trigger_kind: 'completion',
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  const rev = await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
    title: `Service ${code}`,
    scope: 'Service the asset after the previous closure',
    procedure_revision_id: procedureRevisionId,
    team_id: h.teamA1,
    estimated_minutes: 30,
    lead_days: 0,
    trigger: { type: 'completion', time_of_day: '09:00', ...trigger },
    effective_from: '2026-01-01',
  });
  expect(rev.status, JSON.stringify(rev.body)).toBe(201);
  expect((await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${rev.body.id}/publish`)).status).toBe(200);
  return { planId: plan.body.id as string, assetId: asset.id };
}

async function act(id: string, user: TestUser, action: string, extra: Record<string, unknown> = {}) {
  const wo = await h.call(h.users.sup, 'GET', `${M}/work-orders/${id}`);
  const r = await h.call(user, 'POST', `${M}/work-orders/${id}/transitions`, { action, record_version: wo.body.version, ...extra });
  if (r.status !== 200) throw new Error(`${action} failed: ${JSON.stringify(r.body)}`);
  return r;
}

async function closeReady(id: string) {
  await act(id, h.users.tech, 'start');
  const results = await h.call(h.users.tech, 'POST', `${M}/work-orders/${id}/results`, { results: [{ key: 'checked', value: true }] });
  if (results.status !== 201) throw new Error(`results failed: ${JSON.stringify(results.body)}`);
  await act(id, h.users.tech, 'submit_completion', { completion: { corrective_action: 'Serviced', cause_code: 'WEAR' } });
  await act(id, h.users.sup, 'close', { closure_outcome: 'restored' });
}

describe('shop floor S5 completion-relative plans', () => {
  it('issues the next order from the previous closure and only once on retry', async () => {
    h.clock.set('2026-10-10T04:00:00Z');
    const { planId } = await publishedPlan('COMP-1', { unit: 'day', interval: 10, anchor_date: '2026-10-10' });
    await run();
    await run();
    let rows = (await orders(planId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrence_key).toBe('2026-10-10');
    expect(rows[0].state).toBe('ready');
    await closeReady(rows[0].id);
    h.clock.set('2026-10-19T04:00:00Z');
    await run();
    expect((await orders(planId)).rows).toHaveLength(1);
    h.clock.set('2026-10-20T04:00:00Z');
    await run();
    await run();
    rows = (await orders(planId)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].occurrence_key).toBe('2026-10-20');
    expect(new Date(rows[1].due_at).toISOString()).toBe('2026-10-20T04:00:00.000Z');
  });

  it('keeps the anchor when a cancellation is exempt and moves it otherwise', async () => {
    h.clock.set('2026-11-01T04:00:00Z');
    const exempted = await publishedPlan('COMP-EX', { unit: 'day', interval: 10, anchor_date: '2026-11-01' });
    await run();
    const first = (await orders(exempted.planId)).rows[0];
    await closeReady(first.id);
    h.clock.set('2026-11-11T04:00:00Z');
    await run();
    const second = (await orders(exempted.planId)).rows[1];
    await act(second.id, h.users.sup, 'cancel', { reason: 'Window missed with an exemption', exemption: true });
    await run();
    const replaced = (await orders(exempted.planId)).rows;
    expect(replaced).toHaveLength(3);
    expect(replaced[2].occurrence_key).toBe('2026-11-11#2');
    expect(replaced[1].cancel_exemption).toBe(true);
    h.clock.set('2026-11-12T04:00:00Z');
    await run();
    expect((await orders(exempted.planId)).rows).toHaveLength(3);

    h.clock.set('2026-12-01T04:00:00Z');
    const plain = await publishedPlan('COMP-NOEX', { unit: 'day', interval: 10, anchor_date: '2026-12-01' });
    await run();
    const opened = (await orders(plain.planId)).rows[0];
    await closeReady(opened.id);
    h.clock.set('2026-12-11T04:00:00Z');
    await run();
    const cancelled = (await orders(plain.planId)).rows[1];
    await act(cancelled.id, h.users.sup, 'cancel', { reason: 'Window missed' });
    h.clock.set('2026-12-12T04:00:00Z');
    await run();
    expect((await orders(plain.planId)).rows).toHaveLength(2);
    h.clock.set('2026-12-21T04:00:00Z');
    await run();
    const moved = (await orders(plain.planId)).rows;
    expect(moved).toHaveLength(3);
    expect(moved[2].occurrence_key).toBe('2026-12-21');
  });

  it('keeps the original closure until the reopened cycle is closed', async () => {
    h.clock.set('2027-01-05T04:00:00Z');
    const { planId } = await publishedPlan('COMP-RE', { unit: 'day', interval: 10, anchor_date: '2027-01-05' });
    await run();
    const first = (await orders(planId)).rows[0];
    await closeReady(first.id);
    const original = await h.db.query(`SELECT cycle, verified_at FROM maintenance.work_order_closure WHERE work_order_id = $1 ORDER BY cycle`, [first.id]);
    await act(first.id, h.users.sup, 'reopen', { reason: 'The service did not hold' });
    h.clock.set('2027-01-15T04:00:00Z');
    await run();
    expect((await orders(planId)).rows).toHaveLength(1);
    const kept = await h.db.query(`SELECT cycle, verified_at FROM maintenance.work_order_closure WHERE work_order_id = $1 ORDER BY cycle`, [first.id]);
    expect(kept.rows).toEqual(original.rows);

    await h.call(h.users.tech, 'POST', `${M}/work-orders/${first.id}/results`, { results: [{ key: 'checked', value: true }] });
    await act(first.id, h.users.tech, 'submit_completion', { completion: { corrective_action: 'Serviced again', cause_code: 'WEAR' } });
    await act(first.id, h.users.sup, 'close', { closure_outcome: 'restored' });
    await run();
    expect((await orders(planId)).rows).toHaveLength(1);
    h.clock.set('2027-01-25T04:00:00Z');
    await run();
    const rows = (await orders(planId)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].occurrence_key).toBe('2027-01-25');
  });

  it('stops generation on pause and leaves the open order alone', async () => {
    h.clock.set('2027-02-02T04:00:00Z');
    const { planId } = await publishedPlan('COMP-PAUSE', { unit: 'day', interval: 10, anchor_date: '2027-02-02' });
    await run();
    const before = (await orders(planId)).rows[0];
    const plan = await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`);
    const paused = await h.call(h.users.sup, 'POST', `${M}/plans/${planId}/pause`, { record_version: plan.body.version, reason: 'Line is down' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    h.clock.set('2027-03-01T04:00:00Z');
    await run();
    const after = (await orders(planId)).rows;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, state: 'ready' });
  });

  it('clamps a month interval from the 31st to the end of February', async () => {
    h.clock.set('2026-01-31T04:00:00Z');
    const { planId } = await publishedPlan('COMP-MONTH', { unit: 'month', interval: 1, anchor_date: '2026-01-31' });
    await run();
    const first = (await orders(planId)).rows[0];
    await closeReady(first.id);
    h.clock.set('2026-02-27T04:00:00Z');
    await run();
    expect((await orders(planId)).rows).toHaveLength(1);
    h.clock.set('2026-02-28T04:00:00Z');
    await run();
    const rows = (await orders(planId)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].occurrence_key).toBe('2026-02-28');
    expect(new Date(rows[1].due_at).toISOString()).toBe('2026-02-28T04:00:00.000Z');
  });
});
