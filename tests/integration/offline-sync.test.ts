import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { publishSimpleProcedure, readyOrder } from '../helpers/work.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let assetId: string;
let procRev: string;

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-13T06:00:00Z') });
  assetId = (await h.createAsset(h.users.assetAdmin, h.siteA1, 'SYNC-1')).id;
  procRev = await publishSimpleProcedure(h);
});
afterAll(async () => h?.close());

const sync = (user = h.users.tech, operations: unknown[]) => h.call(user, 'POST', `${M}/sync/operations`, { operations });

describe('offline cache feed (MO-01, MO-05)', () => {
  it('delivers assigned work with its procedure snapshot and drops reassigned work', async () => {
    const wo = await readyOrder(h, { assetId, procedureRevisionId: procRev, assignee: h.users.tech });
    const feed = await h.call(h.users.tech, 'GET', `${M}/sync/changes?cursor=0`);
    expect(feed.status).toBe(200);
    const item = feed.body.items.find((i: any) => i.id === wo.id);
    expect(item.record.procedure_snapshot.steps[0].key).toBe('checked');
    expect(feed.body.in_scope_work_order_ids).toContain(wo.id);
    expect(Date.parse(feed.body.cache_expires_at)).toBeGreaterThan(Date.parse(feed.body.server_time));

    const again = await h.call(h.users.tech, 'GET', `${M}/sync/changes?cursor=${feed.body.cursor}`);
    expect(again.body.items.find((i: any) => i.id === wo.id)).toBeUndefined();

    await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${wo.id}`, { assignee_id: h.users.tech2.id }, { 'if-match': `"${wo.version}"` });
    const after = await h.call(h.users.tech, 'GET', `${M}/sync/changes?cursor=${feed.body.cursor}`);
    expect(after.body.in_scope_work_order_ids).not.toContain(wo.id);
    expect((await h.call(h.users.reporter, 'GET', `${M}/sync/changes`)).body.in_scope_work_order_ids).toEqual([]);
  });
});

describe('offline operations (MO-02..MO-04, AC-08)', () => {
  it('applies a disconnected session once, however often it is replayed', async () => {
    const wo = await readyOrder(h, { assetId, procedureRevisionId: procRev, assignee: h.users.tech });
    const ops = [
      { client_op_id: 'dev1-1', type: 'transition', record_id: wo.id, base_version: wo.version, client_time: '2026-10-13T05:00:00Z', payload: { action: 'start' } },
      { client_op_id: 'dev1-2', type: 'task_results', record_id: wo.id, client_time: '2026-10-13T05:10:00Z', payload: { results: [{ key: 'checked', value: true }] } },
      { client_op_id: 'dev1-3', type: 'labor', record_id: wo.id, client_time: '2026-10-13T05:30:00Z', payload: { started_at: '2026-10-13T05:00:00Z', duration_minutes: 30 } },
      { client_op_id: 'dev1-4', type: 'comment', record_id: wo.id, client_time: '2026-10-13T05:31:00Z', payload: { body: 'Seal replaced; no leak after test run' } },
    ];
    const first = await sync(h.users.tech, ops);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.results.map((r: any) => r.outcome)).toEqual(['applied', 'applied', 'applied', 'applied']);
    for (let i = 0; i < 3; i++) {
      const replay = await sync(h.users.tech, ops);
      expect(replay.body.results.every((r: any) => r.outcome === 'applied' && r.duplicate)).toBe(true);
    }
    const detail = (await h.call(h.users.sup, 'GET', `${M}/work-orders/${wo.id}`)).body;
    expect(detail.state).toBe('in_progress');
    expect(detail.comments).toHaveLength(1);
    expect(detail.labor).toHaveLength(1);
    expect(detail.transitions.filter((t: any) => t.action === 'start')).toHaveLength(1);
    const results = await h.db.query(`SELECT recorded_at, received_at FROM maintenance.task_result WHERE work_order_id = $1`, [wo.id]);
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0].recorded_at.toISOString()).toBe('2026-10-13T05:10:00.000Z');
    expect(results.rows[0].received_at.toISOString()).toBe('2026-10-13T06:00:00.000Z');
  });

  it('turns a stale offline completion into a visible conflict with both versions', async () => {
    const wo = await readyOrder(h, { assetId, procedureRevisionId: procRev, assignee: h.users.tech });
    const started = await sync(h.users.tech, [{ client_op_id: 'dev2-1', type: 'transition', record_id: wo.id, base_version: wo.version, client_time: '2026-10-13T05:00:00Z', payload: { action: 'start' } }]);
    const startedVersion = started.body.results[0].result.version;
    // While the technician is offline, the supervisor puts the work on hold.
    const hold = await h.call(h.users.sup, 'POST', `${M}/work-orders/${wo.id}/transitions`, { action: 'hold', record_version: startedVersion, reason: 'Awaiting spare seal' });
    expect(hold.status).toBe(200);
    const r = await sync(h.users.tech, [
      { client_op_id: 'dev2-2', type: 'comment', record_id: wo.id, client_time: '2026-10-13T05:40:00Z', payload: { body: 'Done, pending review' } },
      { client_op_id: 'dev2-3', type: 'transition', record_id: wo.id, base_version: startedVersion, client_time: '2026-10-13T05:45:00Z', payload: { action: 'submit_completion', completion: { corrective_action: 'Replaced seal', cause_code: 'WEAR' } } },
    ]);
    const [comment, completion] = r.body.results;
    expect(comment.outcome).toBe('applied');
    expect(completion).toMatchObject({ outcome: 'conflict', code: 'version_conflict' });
    expect(completion.server_record).toMatchObject({ id: wo.id, state: 'on_hold' });
    expect(completion.client_payload.action).toBe('submit_completion');
    expect((await h.call(h.users.sup, 'GET', `${M}/work-orders/${wo.id}`)).body.state).toBe('on_hold');
  });

  it('rejects operations after a revoked role and tells the client to keep its draft', async () => {
    const wo = await readyOrder(h, { assetId, procedureRevisionId: procRev, assignee: h.users.tech2 });
    const roles = await h.call(h.users.admin, 'GET', `${M}/role-assignments`);
    const grant = roles.body.items.find((r: any) => r.user_id === h.users.tech2.id && r.role === 'technician');
    expect((await h.call(h.users.admin, 'DELETE', `${M}/role-assignments/${grant.id}`)).status).toBe(204);
    const r = await sync(h.users.tech2, [{ client_op_id: 'dev3-1', type: 'transition', record_id: wo.id, base_version: wo.version, client_time: '2026-10-13T05:00:00Z', payload: { action: 'start' } }]);
    expect(r.body.results[0]).toMatchObject({ outcome: 'rejected', preserve_draft: true });
    expect((await h.call(h.users.sup, 'GET', `${M}/work-orders/${wo.id}`)).body.state).toBe('ready');
    await h.call(h.users.admin, 'POST', `${M}/role-assignments`, { user_id: h.users.tech2.id, role: 'technician', site_id: h.siteA1 });
  });

  it('creates offline fault reports and downtime once', async () => {
    const ops = [
      { client_op_id: 'rep-1', type: 'request', client_time: '2026-10-13T04:00:00Z', payload: { site_id: h.siteA1, asset_id: assetId, description: 'Belt slipping', observed_at: '2026-10-13T04:00:00Z' } },
    ];
    const a = await sync(h.users.reporter, ops);
    const b = await sync(h.users.reporter, ops);
    expect(a.body.results[0].outcome).toBe('applied');
    expect(b.body.results[0]).toMatchObject({ outcome: 'applied', duplicate: true });
    expect(b.body.results[0].result.id).toBe(a.body.results[0].result.id);
    const d = [{ client_op_id: 'dt-1', type: 'downtime', client_time: '2026-10-13T04:00:00Z', payload: { asset_id: assetId, started_at: '2026-10-13T03:00:00Z' } }];
    await sync(h.users.tech, d);
    await sync(h.users.tech, d);
    const rows = await h.db.query(`SELECT count(*)::int AS n FROM maintenance.failure_event WHERE client_op_id = 'dt-1'`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('validates operations without recording a partial apply', async () => {
    const r = await sync(h.users.tech, [{ client_op_id: 'bad-1', type: 'labor', record_id: '00000000-0000-0000-0000-000000000000', client_time: '2026-10-13T05:00:00Z', payload: { started_at: '2026-10-13T05:00:00Z', duration_minutes: 5 } }]);
    expect(r.body.results[0]).toMatchObject({ outcome: 'rejected', code: 'not_found' });
    expect((await h.call(h.users.tech, 'POST', `${M}/sync/operations`, { operations: [] })).status).toBe(422);
  });
});
