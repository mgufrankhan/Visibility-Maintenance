import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPmScheduler } from '@vm/core';
import { createHarness, type Harness, type TestUser } from '../helpers/harness.ts';
import { closeOrder, publishSimpleProcedure, readyOrder } from '../helpers/work.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let procedureRevisionId: string;

beforeAll(async () => {
  h = await createHarness();
  procedureRevisionId = await publishSimpleProcedure(h, 'Shutdown check');
});
afterAll(async () => h?.close());

async function act(id: string, user: TestUser, action: string, extra: Record<string, unknown> = {}) {
  const wo = await h.call(h.users.sup, 'GET', `${M}/work-orders/${id}`);
  return h.call(user, 'POST', `${M}/work-orders/${id}/transitions`, { action, record_version: wo.body.version, ...extra });
}

describe('shop floor S4 shutdown parent', () => {
  it('keeps labor, evidence and downtime on the children and refuses an early parent close', async () => {
    const pump = await h.createAsset(h.users.assetAdmin, h.siteA1, 'SHUT-PUMP');
    const motor = await h.createAsset(h.users.assetAdmin, h.siteA1, 'SHUT-MOTOR');
    const parent = await h.call(h.users.sup, 'POST', `${M}/work-orders`, {
      site_id: h.siteA1,
      title: 'Line shutdown',
      type: 'inspection',
      priority: 'high',
      team_id: h.teamA1,
      scope: 'Coordinate the stop',
      assignee_id: h.users.tech.id,
      non_asset_category: 'shutdown',
      non_asset_justification: 'Planned stop across the pump and the motor',
      procedure_revision_id: procedureRevisionId,
      planned_start: '2026-10-20T04:00:00Z',
      planned_end: '2026-10-20T12:00:00Z',
    });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    expect(parent.body.parent_id).toBeNull();
    expect(parent.body.asset_id).toBeNull();

    const childA = await readyOrder(h, { assetId: pump.id, procedureRevisionId, assignee: h.users.tech, title: 'Pump isolation' });
    const childB = await readyOrder(h, { assetId: motor.id, procedureRevisionId, assignee: h.users.tech, title: 'Motor isolation' });
    const linkA = await h.call(h.users.sup, 'POST', `${M}/work-orders/${parent.body.id}/children`, { work_order_id: childA.id });
    const again = await h.call(h.users.sup, 'POST', `${M}/work-orders/${parent.body.id}/children`, { work_order_id: childA.id });
    const linkB = await h.call(h.users.sup, 'POST', `${M}/work-orders/${parent.body.id}/children`, { work_order_id: childB.id });
    expect(linkA.status, JSON.stringify(linkA.body)).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ work_order_id: childA.id, parent_id: parent.body.id, version: linkA.body.version });
    expect(linkB.status).toBe(200);
    const { rows: linked } = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.work_order WHERE parent_id = $1`, [parent.body.id]);
    expect(linked[0].n).toBe(2);

    const foreignAsset = await h.createAsset(h.users.assetAdmin, h.siteA2, 'SHUT-OTHER');
    const foreignTeam = await h.call(h.users.admin, 'POST', `${M}/teams`, { site_id: h.siteA2, name: 'Assembly shutdown' });
    const foreign = await h.call(h.users.supA2, 'POST', `${M}/work-orders`, {
      site_id: h.siteA2,
      asset_id: foreignAsset.id,
      title: 'Other site job',
      priority: 'normal',
      team_id: foreignTeam.body.id,
      scope: 'Not part of this shutdown',
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    const crossed = await h.call(h.users.sup, 'POST', `${M}/work-orders/${parent.body.id}/children`, { work_order_id: foreign.body.id });
    expect(crossed.status).toBe(422);
    expect(JSON.stringify(crossed.body)).toMatch(/Different site/);

    const downA = await h.call(h.users.tech, 'POST', `${M}/downtime-events`, {
      asset_id: pump.id,
      started_at: '2026-10-20T04:00:00Z',
      restored_at: '2026-10-20T05:00:00Z',
      classification: 'planned_stop',
      work_order_id: childA.id,
    });
    const downB = await h.call(h.users.tech, 'POST', `${M}/downtime-events`, {
      asset_id: motor.id,
      started_at: '2026-10-20T04:30:00Z',
      restored_at: '2026-10-20T05:30:00Z',
      classification: 'planned_stop',
      work_order_id: childB.id,
    });
    expect(downA.status, JSON.stringify(downA.body)).toBe(201);
    expect(downB.status, JSON.stringify(downB.body)).toBe(201);
    const parentDown = await h.call(h.users.tech, 'POST', `${M}/downtime-events`, {
      asset_id: pump.id,
      started_at: '2026-10-20T06:00:00Z',
      restored_at: '2026-10-20T06:30:00Z',
      classification: 'planned_stop',
      work_order_id: parent.body.id,
    });
    expect(parentDown.status).toBe(409);
    expect(parentDown.body.error.code).toBe('shutdown_parent');
    const links = async (id: string) => (await h.db.query(`SELECT count(*)::int AS n FROM maintenance.order_failure_link WHERE work_order_id = $1`, [id])).rows[0].n;
    expect(await links(childA.id)).toBe(1);
    expect(await links(childB.id)).toBe(1);
    expect(await links(parent.body.id)).toBe(0);

    expect((await act(parent.body.id, h.users.sup, 'submit_for_approval')).status).toBe(200);
    expect((await act(parent.body.id, h.users.sup2, 'approve')).status).toBe(200);
    expect((await act(parent.body.id, h.users.tech, 'start')).status).toBe(200);
    const labor = await h.call(h.users.tech, 'POST', `${M}/work-orders/${parent.body.id}/labor`, {
      started_at: '2026-10-20T04:00:00Z',
      duration_minutes: 30,
    });
    expect(labor.status).toBe(409);
    expect(labor.body.error.code).toBe('shutdown_parent');
    const evidence = await h.call(h.users.tech, 'POST', `${M}/attachments`, {
      owner_type: 'work_order',
      owner_id: parent.body.id,
      file_name: 'parent.png',
      media_type: 'image/png',
      size_bytes: 8,
      sha256: 'ab'.repeat(32),
    });
    expect(evidence.status).toBe(409);
    expect(evidence.body.error.code).toBe('shutdown_parent');

    expect((await h.call(h.users.tech, 'POST', `${M}/work-orders/${parent.body.id}/results`, { results: [{ key: 'checked', value: true }] })).status).toBe(201);
    expect((await act(parent.body.id, h.users.tech, 'submit_completion')).status).toBe(200);
    const early = await act(parent.body.id, h.users.sup, 'close', { closure_outcome: 'restored' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('children_open');

    await closeOrder(h, childA.id, h.users.tech);
    await closeOrder(h, childB.id, h.users.tech);
    const closed = await act(parent.body.id, h.users.sup, 'close', { closure_outcome: 'restored' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const reopened = await act(childA.id, h.users.sup, 'reopen', { reason: 'The pump still leaks' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const parentAfter = await h.call(h.users.sup, 'GET', `${M}/work-orders/${parent.body.id}`);
    expect(parentAfter.body.state).toBe('in_progress');
    expect(parentAfter.body.closure_outcome).toBeNull();
    expect(parentAfter.body.closures).toEqual([expect.objectContaining({ outcome: 'restored', cycle: 1 })]);

    const spareParent = await h.call(h.users.sup, 'POST', `${M}/work-orders`, {
      site_id: h.siteA1,
      title: 'Cancelled shutdown',
      type: 'inspection',
      priority: 'normal',
      team_id: h.teamA1,
      scope: 'Will be cancelled',
      non_asset_category: 'shutdown',
      non_asset_justification: 'Superseded before the stop',
    });
    const spareAsset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'SHUT-VALVE');
    const spareChild = await readyOrder(h, { assetId: spareAsset.id, procedureRevisionId, assignee: h.users.tech, title: 'Valve check' });
    expect((await h.call(h.users.sup, 'POST', `${M}/work-orders/${spareParent.body.id}/children`, { work_order_id: spareChild.id })).status).toBe(200);
    const cancelled = await act(spareParent.body.id, h.users.sup, 'cancel', { reason: 'Stop no longer required' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const spareAfter = await h.call(h.users.sup, 'GET', `${M}/work-orders/${spareChild.id}`);
    expect(spareAfter.body.state).toBe('ready');
    expect(spareAfter.body.parent_id).toBe(spareParent.body.id);

    const replacement = await h.call(h.users.sup, 'POST', `${M}/work-orders`, {
      site_id: h.siteA1,
      title: 'Replacement shutdown',
      type: 'inspection',
      priority: 'normal',
      team_id: h.teamA1,
      scope: 'The child moves here',
      non_asset_category: 'shutdown',
      non_asset_justification: 'The previous shutdown was cancelled',
    });
    const relink = await h.call(h.users.sup, 'POST', `${M}/work-orders/${replacement.body.id}/children`, { work_order_id: spareChild.id });
    expect(relink.status, JSON.stringify(relink.body)).toBe(200);
    expect(relink.body.parent_id).toBe(replacement.body.id);
  });

  it('does not create a parent when a preventive plan generates an order', async () => {
    const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'SHUT-PM');
    const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, { site_id: h.siteA1, asset_id: asset.id, title: 'Shutdown PM control' });
    const rev = await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
      title: 'Monthly service',
      scope: 'Service the asset',
      procedure_revision_id: procedureRevisionId,
      team_id: h.teamA1,
      estimated_minutes: 30,
      lead_days: 7,
      trigger: { type: 'calendar', unit: 'month', interval: 1, anchor_date: '2026-10-31', time_of_day: '09:00' },
      effective_from: '2026-10-01',
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(201);
    expect((await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${rev.body.id}/publish`)).status).toBe(200);
    h.clock.set('2026-10-24T04:00:00Z');
    await runPmScheduler(h.services, 's4-worker', { tenantId: h.tenantA });
    const { rows } = await h.db.query(
      `SELECT w.parent_id, w.asset_id, w.non_asset_category FROM maintenance.work_order w
        JOIN maintenance.pm_occurrence o ON o.id = w.plan_occurrence_id WHERE o.plan_id = $1`,
      [plan.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_id).toBeNull();
    expect(rows[0].asset_id).toBe(asset.id);
    expect(rows[0].non_asset_category).toBeNull();
  });
});
