import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOutbox } from '@vm/core';
import { createHarness, type Harness, type TestUser } from '../helpers/harness.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let assetId: string;
let revisionId: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  h = await createHarness();
  assetId = (await h.createAsset(h.users.assetAdmin, h.siteA1, 'PUMP-101', 'Cooling water pump')).id;
  const proc = await h.call(h.users.sup, 'POST', `${M}/procedures`, { site_id: h.siteA1, title: 'Pump bearing service' });
  expect(proc.status).toBe(201);
  const rev = await h.call(h.users.sup, 'POST', `${M}/procedures/${proc.body.id}/revisions`, {
    safety_instructions: 'Isolate and lock out the pump before opening the guard.',
    steps: [
      { key: 'lockout', label: 'Lockout applied', type: 'acknowledgment', safety_critical: true },
      { key: 'vibration', label: 'Vibration after service', type: 'numeric', unit: 'mm/s', min: 0, max: 7.1 },
      { key: 'guard', label: 'Guard refitted', type: 'pass_fail' },
      { key: 'photo', label: 'Photo of refitted guard', type: 'photo', evidence_required: true },
    ],
  });
  expect(rev.status).toBe(201);
  revisionId = rev.body.id;
  expect((await h.call(h.users.sup, 'POST', `${M}/procedure-revisions/${revisionId}/publish`)).status).toBe(200);
});
afterAll(async () => h?.close());

async function report(user: TestUser = h.users.reporter, extra: Record<string, unknown> = {}) {
  const r = await h.call(user, 'POST', `${M}/requests`, {
    site_id: h.siteA1,
    asset_id: assetId,
    description: 'Pump is vibrating and noisy',
    observed_at: '2026-10-12T05:00:00Z',
    proposed_priority: 'high',
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

async function acceptAsDraft(requestId: string, version: number) {
  const r = await h.call(h.users.sup, 'POST', `${M}/requests/${requestId}/triage`, {
    action: 'accept',
    record_version: version,
    draft: { title: 'Replace pump bearing', priority: 'high', team_id: h.teamA1, scope: 'Replace drive-end bearing' },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.created_work_order_id as string;
}

async function getWo(id: string, user: TestUser = h.users.sup) {
  const r = await h.call(user, 'GET', `${M}/work-orders/${id}`);
  expect(r.status).toBe(200);
  return r.body;
}

async function act(user: TestUser, id: string, action: string, extra: Record<string, unknown> = {}) {
  const wo = await getWo(id);
  return h.call(user, 'POST', `${M}/work-orders/${id}/transitions`, { action, record_version: wo.version, ...extra });
}

/** Draft → Ready with procedure issued and tech assigned. */
async function readyWorkOrder(): Promise<string> {
  const req = await report();
  const woId = await acceptAsDraft(req.id, req.version);
  const wo = await getWo(woId);
  const patch = await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${woId}`, {
    planned_start: '2026-10-13T04:00:00Z',
    planned_end: '2026-10-13T08:00:00Z',
    procedure_revision_id: revisionId,
    assignee_id: h.users.tech.id,
  }, { 'if-match': `"${wo.version}"` });
  expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  expect((await act(h.users.sup, woId, 'submit_for_approval')).status).toBe(200);
  expect((await act(h.users.sup2, woId, 'approve')).status).toBe(200);
  return woId;
}

async function attachPhoto(user: TestUser, woId: string, bytes = PNG, declared = bytes) {
  const slot = await h.call(user, 'POST', `${M}/attachments`, {
    owner_type: 'work_order', owner_id: woId, file_name: 'guard.png', media_type: 'image/png', size_bytes: declared.length, sha256: sha(declared), step_key: 'photo',
  });
  expect(slot.status, JSON.stringify(slot.body)).toBe(201);
  const put = await h.call(user, 'PUT', slot.body.upload_url, bytes, { 'content-type': 'application/octet-stream' });
  return { id: slot.body.id as string, put };
}

describe('request intake and triage (MR-01..MR-04)', () => {
  it('lets a reporter submit a fault and returns incident instructions for high priority', async () => {
    const r = await report();
    expect(r.state).toBe('submitted');
    expect(r.asset_snapshot).toMatchObject({ code: 'PUMP-101' });
    expect(r).toHaveProperty('incident_contact_instructions');
    expect(r.can_triage).toBe(false);
  });

  it('deduplicates by idempotency key and client_request_id', async () => {
    const body = { site_id: h.siteA1, location_text: 'Boiler room', description: 'Steam leak at valve', observed_at: '2026-10-12T05:00:00Z' };
    const a = await h.call(h.users.reporter, 'POST', `${M}/requests`, body, { 'idempotency-key': 'req-key-1' });
    const b = await h.call(h.users.reporter, 'POST', `${M}/requests`, body, { 'idempotency-key': 'req-key-1' });
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const changed = await h.call(h.users.reporter, 'POST', `${M}/requests`, { ...body, description: 'Different' }, { 'idempotency-key': 'req-key-1' });
    expect(changed.status).toBe(409);
    const c1 = await h.call(h.users.reporter, 'POST', `${M}/requests`, { ...body, client_request_id: 'offline-7' });
    const c2 = await h.call(h.users.reporter, 'POST', `${M}/requests`, { ...body, client_request_id: 'offline-7' });
    expect(c2.body.id).toBe(c1.body.id);
  });

  it('requires an asset or a location', async () => {
    const r = await h.call(h.users.reporter, 'POST', `${M}/requests`, { site_id: h.siteA1, description: 'Something broke', observed_at: '2026-10-12T05:00:00Z' });
    expect(r.status).toBe(422);
    expect(r.body.error.field_errors).toHaveProperty('location_text');
  });

  it('rejects an asset from another site or tenant', async () => {
    const otherSite = await h.createAsset(h.users.assetAdmin, h.siteA2, 'FAN-201');
    const r = await h.call(h.users.reporter, 'POST', `${M}/requests`, { site_id: h.siteA1, asset_id: otherSite.id, description: 'Wrong site', observed_at: '2026-10-12T05:00:00Z' });
    expect([404, 422]).toContain(r.status);
    const tenantB = await h.createAsset(h.users.supB, h.siteB1, 'B-1');
    const x = await h.call(h.users.reporter, 'POST', `${M}/requests`, { site_id: h.siteA1, asset_id: tenantB.id, description: 'Cross tenant', observed_at: '2026-10-12T05:00:00Z' });
    expect(x.status).toBe(404);
  });

  it('conceals requests from other sites and tenants and limits reporters to their own', async () => {
    const r = await report();
    expect((await h.call(h.users.supA2, 'GET', `${M}/requests/${r.id}`)).status).toBe(404);
    expect((await h.call(h.users.supB, 'GET', `${M}/requests/${r.id}`)).status).toBe(404);
    expect((await h.call(h.users.tech, 'GET', `${M}/requests/${r.id}`)).status).toBe(200);
    const mine = await report(h.users.tech);
    expect((await h.call(h.users.reporter, 'GET', `${M}/requests/${mine.id}`)).status).toBe(404);
    const list = await h.call(h.users.reporter, 'GET', `${M}/requests`);
    expect(list.body.items.every((i: any) => i.reporter_id === h.users.reporter.id)).toBe(true);
  });

  it('only triage roles can triage, and acceptance happens once', async () => {
    const r = await report();
    expect((await h.call(h.users.reporter, 'POST', `${M}/requests/${r.id}/triage`, { action: 'reject', record_version: r.version, reason: 'nope' })).status).toBe(403);
    expect((await h.call(h.users.tech, 'POST', `${M}/requests/${r.id}/triage`, { action: 'reject', record_version: r.version, reason: 'nope' })).status).toBe(403);
    const woId = await acceptAsDraft(r.id, r.version);
    const wo = await getWo(woId);
    expect(wo).toMatchObject({ state: 'draft', source_request_id: r.id, asset_id: assetId });
    const again = await h.call(h.users.sup, 'POST', `${M}/requests/${r.id}/triage`, { action: 'accept', record_version: r.version + 1, draft: { title: 'x', priority: 'low', team_id: h.teamA1, scope: 'x' } });
    expect(again.status).toBe(409);
  });

  it('rejects stale triage and requires reasons for rejection and duplicates', async () => {
    const r = await report();
    expect((await h.call(h.users.sup, 'POST', `${M}/requests/${r.id}/triage`, { action: 'start_review', record_version: r.version })).status).toBe(200);
    expect((await h.call(h.users.sup, 'POST', `${M}/requests/${r.id}/triage`, { action: 'reject', record_version: r.version, reason: 'stale' })).body.error.code).toBe('version_conflict');
    expect((await h.call(h.users.sup, 'POST', `${M}/requests/${r.id}/triage`, { action: 'reject', record_version: r.version + 1 })).status).toBe(422);
    const other = await report();
    const dup = await h.call(h.users.sup, 'POST', `${M}/requests/${other.id}/triage`, { action: 'mark_duplicate', record_version: other.version, reason: 'Same pump fault', duplicate_of_request_id: r.id });
    expect(dup.status).toBe(200);
    expect(dup.body.request.state).toBe('duplicate');
  });
});

describe('work order lifecycle (MW-01..MW-08, AC-03, AC-04)', () => {
  it('blocks approval until planning gaps are resolved', async () => {
    const req = await report();
    const woId = await acceptAsDraft(req.id, req.version);
    expect((await act(h.users.sup, woId, 'submit_for_approval')).status).toBe(200);
    const r = await act(h.users.sup2, woId, 'approve');
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.error.field_errors)).toEqual(expect.arrayContaining(['planned_start', 'procedure_revision_id']));
  });

  it('requires If-Match on edits and rejects stale versions', async () => {
    const req = await report();
    const woId = await acceptAsDraft(req.id, req.version);
    expect((await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${woId}`, { title: 'No version' })).status).toBe(428);
    const wo = await getWo(woId);
    expect((await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${woId}`, { title: 'First' }, { 'if-match': `"${wo.version}"` })).status).toBe(200);
    const stale = await h.call(h.users.sup2, 'PATCH', `${M}/work-orders/${woId}`, { title: 'Second' }, { 'if-match': `"${wo.version}"` });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect((await getWo(woId)).title).toBe('First');
  });

  it('snapshots the issued procedure revision on the work order', async () => {
    const woId = await readyWorkOrder();
    const wo = await getWo(woId);
    expect(wo.state).toBe('ready');
    expect(wo.procedure_snapshot).toMatchObject({ procedure_revision_id: revisionId, revision_no: 1 });
    expect(wo.procedure_snapshot.steps).toHaveLength(4);
  });

  it('runs request to closure with evidence, labor and independent verification', async () => {
    const woId = await readyWorkOrder();
    expect((await act(h.users.tech2, woId, 'start')).status).toBe(403);
    expect((await act(h.users.tech, woId, 'start')).status).toBe(200);

    const photo = await attachPhoto(h.users.tech, woId);
    expect(photo.put.status, JSON.stringify(photo.put.body)).toBe(200);

    const res = await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/results`, {
      results: [
        { key: 'lockout', value: true },
        { key: 'vibration', value: 9.5, unit: 'mm/s' },
        { key: 'guard', value: true },
        { key: 'photo', value: null, attachment_ids: [photo.id] },
      ],
      client_op_id: 'op-1',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const replay = await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/results`, { results: [{ key: 'guard', value: true }], client_op_id: 'op-1' });
    expect(replay.body.replayed).toBe(true);

    const completion = { corrective_action: 'Replaced bearing', cause_code: 'BEARING_WEAR' };
    const blocked = await act(h.users.tech, woId, 'submit_completion', { completion });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('completion_blocked');
    expect(blocked.body.error.field_errors).toHaveProperty(['steps.vibration']);

    const fixed = await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/results`, { results: [{ key: 'vibration', value: 3.2, unit: 'mm/s' }] });
    expect(fixed.status).toBe(201);
    const labor = await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/labor`, { started_at: '2026-10-13T04:00:00Z', duration_minutes: 90 });
    expect(labor.status).toBe(201);
    expect(labor.body).not.toHaveProperty('hourly_rate');

    const submitted = await act(h.users.tech, woId, 'submit_completion', { completion });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect((await act(h.users.tech, woId, 'close', { closure_outcome: 'restored' })).status).toBe(403);
    const verified = await act(h.users.sup, woId, 'close', { closure_outcome: 'restored' });
    expect(verified.status).toBe(200);

    const closed = await getWo(woId);
    expect(closed).toMatchObject({ state: 'closed', closure_outcome: 'restored', corrective_action: 'Replaced bearing' });
    expect(closed.transitions.map((t: any) => t.action)).toEqual(['create', 'submit_for_approval', 'approve', 'start', 'submit_completion', 'close']);
    const req = await h.call(h.users.reporter, 'GET', `${M}/requests/${closed.source_request_id}`);
    expect(req.body.linked_work_order).toMatchObject({ id: woId, state: 'closed' });
  });

  it('blocks the submitting technician from approving their own completion', async () => {
    const woId = await readyWorkOrder();
    await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${woId}`, { assignee_id: h.users.sup.id }, { 'if-match': `"${(await getWo(woId)).version}"` });
    const wo = await getWo(woId);
    expect(wo.state).toBe('ready');
    expect((await act(h.users.sup, woId, 'start')).status).toBe(200);
    const photo = await attachPhoto(h.users.sup, woId);
    expect(photo.put.status).toBe(200);
    await h.call(h.users.sup, 'POST', `${M}/work-orders/${woId}/results`, {
      results: [{ key: 'lockout', value: true }, { key: 'vibration', value: 2, unit: 'mm/s' }, { key: 'guard', value: true }, { key: 'photo', value: null, attachment_ids: [photo.id] }],
    });
    expect((await act(h.users.sup, woId, 'submit_completion', { completion: { corrective_action: 'Adjusted', cause_unknown_reason: 'Intermittent' } })).status).toBe(200);
    const self = await act(h.users.sup, woId, 'close', { closure_outcome: 'restored' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('independent_approval_required');
    expect((await act(h.users.sup2, woId, 'close', { closure_outcome: 'restored' })).status).toBe(200);
  });

  it('never waives a safety-critical check but allows an authorized exception for others', async () => {
    const woId = await readyWorkOrder();
    await act(h.users.tech, woId, 'start');
    const safety = await h.call(h.users.sup, 'POST', `${M}/work-orders/${woId}/check-exceptions`, { step_key: 'lockout', reason: 'Trying to skip lockout' });
    expect(safety.status).toBe(409);
    expect(safety.body.error.code).toBe('safety_critical_check');
    expect((await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/check-exceptions`, { step_key: 'photo', reason: 'Camera unavailable today' })).status).toBe(403);
    expect((await h.call(h.users.sup, 'POST', `${M}/work-orders/${woId}/check-exceptions`, { step_key: 'photo', reason: 'Camera unavailable today' })).status).toBe(201);
  });

  it('reopens closed work into a new cycle and keeps the previous closure', async () => {
    const woId = await readyWorkOrder();
    await act(h.users.tech, woId, 'start');
    await h.call(h.users.sup, 'POST', `${M}/work-orders/${woId}/check-exceptions`, { step_key: 'photo', reason: 'Camera unavailable today' });
    await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/results`, { results: [{ key: 'lockout', value: true }, { key: 'vibration', value: 2, unit: 'mm/s' }, { key: 'guard', value: true }] });
    expect((await act(h.users.tech, woId, 'submit_completion', { completion: { corrective_action: 'Tightened', cause_code: 'LOOSE' } })).status).toBe(200);
    expect((await act(h.users.sup, woId, 'close', { closure_outcome: 'restored' })).status).toBe(200);
    expect((await act(h.users.sup, woId, 'reopen')).status).toBe(422);
    expect((await act(h.users.sup, woId, 'reopen', { reason: 'Fault returned after one hour' })).status).toBe(200);
    const wo = await getWo(woId);
    expect(wo).toMatchObject({ state: 'in_progress', cycle: 2, closed_at: null });
    expect(wo.closures).toHaveLength(1);
    // New cycle: earlier results do not count toward completion.
    const r = await act(h.users.tech, woId, 'submit_completion', { completion: { corrective_action: 'x', cause_code: 'LOOSE' } });
    expect(r.body.error.code).toBe('completion_blocked');
  });

  it('cancels with a reason and refuses further execution', async () => {
    const req = await report();
    const woId = await acceptAsDraft(req.id, req.version);
    expect((await act(h.users.tech, woId, 'cancel', { reason: 'not mine' })).status).toBe(403);
    expect((await act(h.users.sup, woId, 'cancel')).status).toBe(422);
    expect((await act(h.users.sup, woId, 'cancel', { reason: 'Raised in error' })).status).toBe(200);
    expect((await act(h.users.sup, woId, 'submit_for_approval')).status).toBe(409);
  });

  it('replays transitions with the same idempotency key without double-applying', async () => {
    const req = await report();
    const woId = await acceptAsDraft(req.id, req.version);
    const wo = await getWo(woId);
    const body = { action: 'submit_for_approval', record_version: wo.version };
    const a = await h.call(h.users.sup, 'POST', `${M}/work-orders/${woId}/transitions`, body, { 'idempotency-key': 'tx-1' });
    const b = await h.call(h.users.sup, 'POST', `${M}/work-orders/${woId}/transitions`, body, { 'idempotency-key': 'tx-1' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await getWo(woId)).transitions.filter((t: any) => t.action === 'submit_for_approval')).toHaveLength(1);
  });

  it('hides work orders across sites and tenants', async () => {
    const woId = await readyWorkOrder();
    expect((await h.call(h.users.supA2, 'GET', `${M}/work-orders/${woId}`)).status).toBe(404);
    expect((await h.call(h.users.supB, 'GET', `${M}/work-orders/${woId}`)).status).toBe(404);
    expect((await h.call(h.users.supB, 'POST', `${M}/work-orders/${woId}/transitions`, { action: 'start', record_version: 1 })).status).toBe(404);
    expect((await h.call(h.users.reporter, 'GET', `${M}/work-orders/${woId}`)).status).toBe(404);
  });

  it('shows the technician their assigned and team-queued work', async () => {
    const woId = await readyWorkOrder();
    const mine = await h.call(h.users.tech, 'GET', `${M}/my-work`);
    expect(mine.body.items.map((i: any) => i.id)).toContain(woId);
    const other = await h.call(h.users.tech2, 'GET', `${M}/my-work`);
    expect(other.body.items.map((i: any) => i.id)).not.toContain(woId);
  });
});

describe('evidence uploads', () => {
  it('rejects hash mismatches and quarantines content that does not match its type', async () => {
    const woId = await readyWorkOrder();
    await act(h.users.tech, woId, 'start');
    const wrongHash = await attachPhoto(h.users.tech, woId, PNG, Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from('x')]));
    expect(wrongHash.put.status).toBe(422);
    expect(wrongHash.put.body.error.code).toBe('attachment_rejected');
    const notPng = Buffer.from('this is plain text pretending to be png');
    const disguised = await attachPhoto(h.users.tech, woId, notPng);
    expect(disguised.put.body.error.code).toBe('attachment_quarantined');
    const list = await h.call(h.users.sup, 'GET', `${M}/attachments?owner_type=work_order&owner_id=${woId}`);
    expect(list.body.items.map((a: any) => a.status).sort()).toEqual(['quarantined', 'rejected']);
    const res = await h.call(h.users.tech, 'POST', `${M}/work-orders/${woId}/results`, { results: [{ key: 'photo', value: null, attachment_ids: [disguised.id] }] });
    expect(res.status).toBe(422);
  });

  it('serves content only via short-lived signed links to authorized users', async () => {
    const woId = await readyWorkOrder();
    await act(h.users.tech, woId, 'start');
    const photo = await attachPhoto(h.users.tech, woId);
    expect((await h.call(h.users.supB, 'POST', `${M}/attachments/${photo.id}/download-link`)).status).toBe(404);
    const link = await h.call(h.users.viewer, 'POST', `${M}/attachments/${photo.id}/download-link`);
    expect(link.status).toBe(200);
    const dl = await h.api.inject({ method: 'GET', url: link.body.url });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
    const tampered = await h.api.inject({ method: 'GET', url: link.body.url.replace(/sig=[^&]+/, 'sig=AAAA') });
    expect(tampered.statusCode).toBe(404);
    expect((await h.call(h.users.viewer, 'POST', `${M}/attachments`, { owner_type: 'work_order', owner_id: woId, file_name: 'a.png', media_type: 'image/png', size_bytes: 10, sha256: sha(PNG) })).status).toBe(403);
    expect((await h.call(h.users.tech, 'POST', `${M}/attachments`, { owner_type: 'work_order', owner_id: woId, file_name: 'a.exe', media_type: 'application/x-msdownload', size_bytes: 10, sha256: sha(PNG) })).status).toBe(422);
  });
});

describe('notifications via the transactional outbox', () => {
  it('delivers each event once to the right recipients, even when dispatched twice', async () => {
    const r = await report();
    await dispatchOutbox(h.services, 'test-worker');
    await dispatchOutbox(h.services, 'test-worker-2');
    const sup = await h.call(h.users.sup, 'GET', `${M}/notifications?unread=true`);
    const forThis = sup.body.items.filter((n: any) => n.link === `/requests/${r.id}`);
    expect(forThis).toHaveLength(1);
    expect((await h.call(h.users.supA2, 'GET', `${M}/notifications`)).body.items.some((n: any) => n.link === `/requests/${r.id}`)).toBe(false);
    expect((await h.call(h.users.sup, 'POST', `${M}/notifications/${forThis[0].id}/acknowledge`)).status).toBe(204);
    const after = await h.call(h.users.sup, 'GET', `${M}/notifications?unread=true`);
    expect(after.body.items.some((n: any) => n.id === forThis[0].id)).toBe(false);
  });

  it('records failures with backoff and exposes them to administrators', async () => {
    await report();
    let failures = 0;
    for (let i = 0; i < 10; i++) {
      await h.db.query(`UPDATE maintenance.outbox SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`);
      failures += (await dispatchOutbox(h.services, 'flaky', { sinks: [async () => { throw new Error('webhook down'); }] })).failed;
    }
    expect(failures).toBeGreaterThan(0);
    const failed = await h.call(h.users.admin, 'GET', `${M}/admin/outbox/failed`);
    expect(failed.status).toBe(200);
    expect(failed.body.items.length).toBeGreaterThan(0);
    expect(failed.body.items[0].last_error).toBe('webhook down');
    expect((await h.call(h.users.tech, 'GET', `${M}/admin/outbox/failed`)).status).toBe(403);
    expect((await h.call(h.users.admin, 'POST', `${M}/admin/outbox/${failed.body.items[0].event_id}/retry`)).status).toBe(202);
  });
});

describe('licensing gates on corrective work (ML-03)', () => {
  it('keeps fault reporting available in setup mode but blocks turning it into work', async () => {
    const bare = await createHarness({ license: 'none' });
    try {
      const asset = await bare.createAsset(bare.users.assetAdmin, bare.siteA1, 'X-1');
      const r = await bare.call(bare.users.reporter, 'POST', `${M}/requests`, { site_id: bare.siteA1, asset_id: asset.id, description: 'Broken', observed_at: '2026-10-12T05:00:00Z' });
      expect(r.status).toBe(201);
      const accept = await bare.call(bare.users.sup, 'POST', `${M}/requests/${r.body.id}/triage`, {
        action: 'accept', record_version: r.body.version, draft: { title: 'Fix', priority: 'normal', team_id: bare.teamA1, scope: 'Fix it' },
      });
      expect(accept.status).toBe(403);
      expect(accept.body.error.code).toBe('entitlement_required');
      expect((await bare.call(bare.users.sup, 'GET', `${M}/requests/${r.body.id}`)).body.state).toBe('submitted');
      const wo = await bare.call(bare.users.sup, 'POST', `${M}/work-orders`, { site_id: bare.siteA1, asset_id: asset.id, title: 't', priority: 'normal', team_id: bare.teamA1, scope: 's' });
      expect(wo.body.error.code).toBe('entitlement_required');
    } finally {
      await bare.close();
    }
  });
});
