import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutomations } from '@vm/core';
import { createHarness, type Harness } from '../helpers/harness.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let siteId: string;
let assetId: string;
let teamId: string;
let woId: string;

beforeAll(async () => {
  h = await createHarness({ license: 'full' });
  siteId = h.siteA1;
  assetId = (await h.createAsset(h.users.assetAdmin, siteId, 'FURN-T', 'Test furnace')).id;
  const team = await h.call(h.users.admin, 'POST', `${M}/teams`, { site_id: siteId, name: 'Stores', member_ids: [h.users.tech.id] });
  expect(team.status).toBe(201);
  teamId = team.body.id;
  await h.call(h.users.admin, 'POST', `${M}/role-assignments`, { user_id: h.users.tech.id, role: 'stores_user', site_id: siteId });
  const wo = await h.call(h.users.sup, 'POST', `${M}/work-orders`, {
    site_id: siteId,
    asset_id: assetId,
    title: 'Jacket gasket',
    priority: 'normal',
    team_id: teamId,
    scope: 'Replace gasket',
  });
  expect(wo.status).toBe(201);
  woId = wo.body.id;
});
afterAll(async () => h?.close());

describe('R2 parts ledger', () => {
  it('receives, reserves, issues and returns without going negative', async () => {
    const store = await h.call(h.users.admin, 'POST', `${M}/stores`, { site_id: siteId, code: 'MELT', name: 'Melt deck stores' });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const part = await h.call(h.users.admin, 'POST', `${M}/parts`, { sku: 'GSKT-50', name: '50mm jacket gasket', unit: 'ea' });
    expect(part.status).toBe(201);

    const recv = await h.call(h.users.tech, 'POST', `${M}/stock/receive`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity: 10,
      unit_cost: 12.5,
      currency: 'USD',
      reason: 'PO-100',
      idempotency_key: 'recv-1',
    });
    expect(recv.status, JSON.stringify(recv.body)).toBe(201);
    expect(recv.body.quantity).toBe(10);
    const again = await h.call(h.users.tech, 'POST', `${M}/stock/receive`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity: 10,
      reason: 'PO-100',
      idempotency_key: 'recv-1',
    });
    expect(again.body.id).toBe(recv.body.id);
    expect(again.body.replayed).toBe(true);

    const res = await h.call(h.users.tech, 'POST', `${M}/stock/reservations`, {
      store_id: store.body.id,
      part_id: part.body.id,
      work_order_id: woId,
      quantity: 2,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const bal = await h.call(h.users.tech, 'GET', `${M}/stores/${store.body.id}/balances`);
    expect(bal.body.items[0]).toMatchObject({ on_hand: 10, reserved: 2, available: 8 });

    const over = await h.call(h.users.tech, 'POST', `${M}/stock/issue`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity: 9,
      work_order_id: woId,
    });
    expect(over.status).toBe(422);

    const issue = await h.call(h.users.tech, 'POST', `${M}/stock/issue`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity: 2,
      work_order_id: woId,
      reservation_id: res.body.id,
    });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    expect(issue.body.quantity).toBe(-2);

    const ret = await h.call(h.users.tech, 'POST', `${M}/stock/return`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity: 1,
      work_order_id: woId,
      reason: 'Unused gasket',
    });
    expect(ret.status).toBe(201);

    const bal2 = await h.call(h.users.tech, 'GET', `${M}/stores/${store.body.id}/balances`);
    expect(bal2.body.items[0]).toMatchObject({ on_hand: 9, reserved: 0, available: 9 });

    const neg = await h.call(h.users.tech, 'POST', `${M}/stock/adjust`, {
      store_id: store.body.id,
      part_id: part.body.id,
      quantity: -100,
      reason: 'Bad count',
    });
    expect(neg.status).toBe(422);
  });
});

describe('maintenance cost parts', () => {
  it('nets a return against the receipt cost and reports a movement that has no cost', async () => {
    const asset = await h.createAsset(h.users.assetAdmin, siteId, 'COST-1', 'Costed pump');
    const other = await h.createAsset(h.users.assetAdmin, siteId, 'COST-2', 'Other pump');
    const store = await h.call(h.users.admin, 'POST', `${M}/stores`, { site_id: siteId, code: 'COST', name: 'Cost cage' });
    const priced = await h.call(h.users.admin, 'POST', `${M}/parts`, { sku: 'COST-BOLT', name: 'Bolt', unit: 'ea' });
    const bare = await h.call(h.users.admin, 'POST', `${M}/parts`, { sku: 'COST-WASHER', name: 'Washer', unit: 'ea' });
    const order = async (assetId: string, title: string) => {
      const created = await h.call(h.users.sup, 'POST', `${M}/work-orders`, {
        site_id: siteId, asset_id: assetId, title, priority: 'normal', team_id: teamId, scope: 'Fit the part',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.id as string;
    };
    const pricedOrder = await order(asset.id, 'Fit bolt');
    const bareOrder = await order(asset.id, 'Fit washer');
    const otherOrder = await order(other.id, 'Fit elsewhere');
    expect((await h.call(h.users.tech, 'POST', `${M}/stock/receive`, {
      store_id: store.body.id, part_id: priced.body.id, quantity: 4, unit_cost: 12.5, currency: 'USD', reason: 'PO-cost',
    })).status).toBe(201);
    expect((await h.call(h.users.tech, 'POST', `${M}/stock/receive`, {
      store_id: store.body.id, part_id: bare.body.id, quantity: 2, reason: 'No price',
    })).status).toBe(201);
    const issue = (partId: string, workOrderId: string, quantity: number) => h.call(h.users.tech, 'POST', `${M}/stock/issue`, {
      store_id: store.body.id, part_id: partId, quantity, work_order_id: workOrderId,
    });
    const pricedIssue = await issue(priced.body.id, pricedOrder, 2);
    expect(pricedIssue.status).toBe(201);
    const pricedReturn = await h.call(h.users.tech, 'POST', `${M}/stock/return`, {
      store_id: store.body.id, part_id: priced.body.id, quantity: 1, work_order_id: pricedOrder, reason: 'One unused',
    });
    expect(pricedReturn.status).toBe(201);
    const bareIssue = await issue(bare.body.id, bareOrder, 1);
    expect(bareIssue.status).toBe(201);
    const otherIssue = await issue(priced.body.id, otherOrder, 1);
    expect(otherIssue.status).toBe(201);
    const period = 'from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z';
    const report = await h.call(h.users.costSup, 'GET', `${M}/reports/maintenance_cost?site_id=${siteId}&asset_id=${asset.id}&${period}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.parts).toEqual([{ currency: 'USD', amount: 12.5, issue_count: 1, return_count: 1 }]);
    expect(report.body.coverage.parts_movements_without_cost).toBe(1);
    expect(report.body.source_records).toEqual([
      { type: 'stock_movement', id: pricedIssue.body.id },
      { type: 'stock_movement', id: pricedReturn.body.id },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(report.body.coverage.stock_movement_ids_without_cost).toEqual([bareIssue.body.id]);
    const elsewhere = await h.call(h.users.costSup, 'GET', `${M}/reports/maintenance_cost?site_id=${siteId}&asset_id=${other.id}&${period}`);
    expect(elsewhere.body.parts).toEqual([{ currency: 'USD', amount: 12.5, issue_count: 1, return_count: 0 }]);
    expect(elsewhere.body.source_records).toEqual([{ type: 'stock_movement', id: otherIssue.body.id }]);
  });
});

describe('R2 CMMS authority (AC-13)', () => {
  it('blocks native edits of externally owned fields and queues an exception', async () => {
    const set = await h.call(h.users.admin, 'PUT', `${M}/sites/${siteId}/authority`, {
      site_id: siteId,
      work_order_mode: 'external_cmms',
      field_ownership: { title: 'external', state: 'external' },
      external_system: 'demo-cmms',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.work_order_mode).toBe('external_cmms');

    const wo = await h.call(h.users.sup, 'GET', `${M}/work-orders/${woId}`);
    const patched = await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${woId}`, { title: 'Hijacked' }, { 'if-match': `"${wo.body.version}"` });
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('external_field_owned');

    const ex = await h.call(h.users.admin, 'GET', `${M}/cmms-exceptions?site_id=${siteId}`);
    expect(ex.body.items.some((i: any) => i.conflict_type === 'native_overwrite_blocked')).toBe(true);

    const native = await h.call(h.users.admin, 'PUT', `${M}/sites/${siteId}/authority`, {
      site_id: siteId,
      work_order_mode: 'native',
      field_ownership: {},
      external_system: null,
    });
    expect(native.body.work_order_mode).toBe('native');
  });
});

describe('R2 multi-site reports and automation', () => {
  it('aggregates reports across permitted sites', async () => {
    const from = '2026-01-01T00:00:00Z';
    const to = '2027-01-01T00:00:00Z';
    const r = await h.call(h.users.admin, 'GET', `${M}/reports/failure_count/multi-site?site_ids=${h.siteA1},${h.siteA2}&from=${from}&to=${to}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sites).toHaveLength(2);
    expect(r.body.scope.site_ids).toEqual([h.siteA1, h.siteA2]);
  });

  it('runs approved auto-draft automation for aged high-priority requests', async () => {
    const req = await h.call(h.users.reporter, 'POST', `${M}/requests`, {
      site_id: siteId,
      asset_id: assetId,
      description: 'Furnace coolant leak during heat',
      observed_at: '2026-10-01T00:00:00Z',
      proposed_priority: 'high',
    });
    expect(req.status).toBe(201);
    await h.db.query(`UPDATE maintenance.request SET created_at = now() - interval '5 hours' WHERE id = $1`, [req.body.id]);

    const policy = await h.call(h.users.admin, 'PUT', `${M}/automation-policies`, {
      site_id: siteId,
      kind: 'auto_draft_high_priority_request',
      enabled: true,
      config: { delay_hours: 4, team_id: teamId },
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(policy.body.enabled).toBe(true);

    const out = await runAutomations(h.services, 'test-worker');
    expect(out.drafted).toBeGreaterThanOrEqual(1);

    const updated = await h.call(h.users.sup, 'GET', `${M}/requests/${req.body.id}`);
    expect(updated.body.state).toBe('accepted');
    expect(updated.body.linked_work_order?.id ?? updated.body.linked_work_order_id).toBeTruthy();
  });
});
