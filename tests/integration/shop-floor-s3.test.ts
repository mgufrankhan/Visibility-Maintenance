import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPmScheduler } from '@vm/core';
import { createHarness, type Harness } from '../helpers/harness.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let procedureRevisionId: string;

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
  const proc = await h.call(h.users.sup, 'POST', `${M}/procedures`, { site_id: h.siteA1, title: 'Parts service' });
  const rev = await h.call(h.users.sup, 'POST', `${M}/procedures/${proc.body.id}/revisions`, {
    safety_instructions: 'Isolate the drive.',
    steps: [{ key: 'done', label: 'Service complete', type: 'pass_fail' }],
  });
  procedureRevisionId = rev.body.id;
  await h.call(h.users.sup, 'POST', `${M}/procedure-revisions/${procedureRevisionId}/publish`);
});
afterAll(async () => h?.close());

async function stock(siteId: string, sku: string, quantity: number) {
  const store = await h.call(h.users.admin, 'POST', `${M}/stores`, { site_id: siteId, code: sku.slice(0, 12), name: sku });
  expect(store.status, JSON.stringify(store.body)).toBe(201);
  const part = await h.call(h.users.admin, 'POST', `${M}/parts`, { sku, name: sku, unit: 'ea' });
  expect(part.status, JSON.stringify(part.body)).toBe(201);
  if (quantity > 0) {
    const recv = await h.call(h.users.admin, 'POST', `${M}/stock/receive`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity,
      reason: 'Opening balance',
    });
    expect(recv.status, JSON.stringify(recv.body)).toBe(201);
  }
  return { storeId: store.body.id as string, partId: part.body.id as string };
}

async function publishedPlan(code: string, partId: string, quantity: number) {
  const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, code);
  const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, { site_id: h.siteA1, asset_id: asset.id, title: `PM ${code}` });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  const rev = await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
    title: `Service ${code}`,
    scope: 'Replace the listed parts',
    procedure_revision_id: procedureRevisionId,
    team_id: h.teamA1,
    estimated_minutes: 30,
    lead_days: 7,
    trigger: { type: 'calendar', unit: 'month', interval: 1, anchor_date: '2026-10-31', time_of_day: '09:00' },
    effective_from: '2026-10-01',
    expected_parts: [{ part_id: partId, quantity }],
  });
  return { planId: plan.body.id as string, revision: rev };
}

const run = () => runPmScheduler(h.services, 's3-worker', { tenantId: h.tenantA });
const orders = (planId: string) => h.db.query(
  `SELECT count(*)::int AS n FROM maintenance.work_order w JOIN maintenance.pm_occurrence o ON o.id = w.plan_occurrence_id WHERE o.plan_id = $1`,
  [planId],
);

describe('shop floor S3 parts readiness', () => {
  it('rejects a part that is not stocked at the plan site', async () => {
    const elsewhere = await stock(h.siteA2, 'SEAL-A2', 4);
    const { revision } = await publishedPlan('SHORT-OTHER', elsewhere.partId, 1);
    expect(revision.status, JSON.stringify(revision.body)).toBe(422);
    expect(JSON.stringify(revision.body)).toMatch(/not stocked at this site/i);

    const bare = await h.call(h.users.admin, 'POST', `${M}/parts`, { sku: 'BARE-1', name: 'Bare part', unit: 'ea' });
    const missing = await publishedPlan('SHORT-NONE', bare.body.id, 1);
    expect(missing.revision.status).toBe(422);
  });

  it('shows a shortage and still issues the order when the site policy is off', async () => {
    const { partId } = await stock(h.siteA1, 'SEAL-A1', 1);
    const { planId, revision } = await publishedPlan('SHORT-WARN', partId, 2);
    expect(revision.status, JSON.stringify(revision.body)).toBe(201);
    expect((await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${revision.body.id}/publish`)).status).toBe(200);
    h.clock.set('2026-10-24T04:00:00Z');
    const first = await run();
    expect(first.issued).toBeGreaterThanOrEqual(1);
    await run();
    expect((await orders(planId)).rows[0].n).toBe(1);
    const detail = await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`);
    expect(detail.body.last_generation_issue).toMatch(/Parts shortage: SEAL-A1 needs 2, available 1/);
    expect(detail.body.occurrences).toHaveLength(1);
    expect(detail.body.occurrences[0].status).toBe('issued');
    expect(detail.body.occurrences[0].work_order_id).toBeTruthy();
  });

  it('records one blocked occurrence and issues nothing when the site blocks on shortage', async () => {
    const settings = (await h.call(h.users.admin, 'GET', `${M}/sites/${h.siteA1}/settings`)).body;
    expect(settings.pm_block_on_shortage).toBe(false);
    const saved = await h.call(h.users.admin, 'PUT', `${M}/sites/${h.siteA1}/settings`, {
      pm_block_on_shortage: true,
      record_version: settings.version,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.pm_block_on_shortage).toBe(true);
    expect(saved.body.pm_initial_state).toBe(settings.pm_initial_state);
    const audit = await h.db.query(`SELECT detail FROM maintenance.audit_event WHERE action = 'site_settings.updated' AND site_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [h.siteA1]);
    expect(JSON.stringify(audit.rows[0]?.detail)).toMatch(/pm_block_on_shortage/);

    const { partId } = await stock(h.siteA1, 'SEAL-BLOCK', 1);
    const { planId, revision } = await publishedPlan('SHORT-BLOCK', partId, 2);
    expect(revision.status, JSON.stringify(revision.body)).toBe(201);
    expect((await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${revision.body.id}/publish`)).status).toBe(200);
    h.clock.set('2026-10-24T04:00:00Z');
    const first = await run();
    expect(first.blocked).toBeGreaterThanOrEqual(1);
    await run();
    expect((await orders(planId)).rows[0].n).toBe(0);
    const detail = await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`);
    expect(detail.body.occurrences).toHaveLength(1);
    expect(detail.body.occurrences[0]).toMatchObject({ status: 'blocked_shortage', work_order_id: null });
    expect(detail.body.last_generation_issue).toMatch(/Parts shortage/);
  });
});
