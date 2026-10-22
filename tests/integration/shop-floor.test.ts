import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { readyOrder } from '../helpers/work.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let assetId: string;
let signedRevision: string;
let altSignedRevision: string;
let plainRevision: string;

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
  assetId = (await h.createAsset(h.users.assetAdmin, h.siteA1, 'SF-1', 'Shop floor pump')).id;
  signedRevision = await publishProcedure('Signed service', true);
  altSignedRevision = await publishProcedure('Signed service alternate', true);
  plainRevision = await publishProcedure('Plain service', false);
});
afterAll(async () => h?.close());

async function publishProcedure(title: string, signatureRequired: boolean): Promise<string> {
  const proc = await h.call(h.users.sup, 'POST', `${M}/procedures`, { site_id: h.siteA1, title });
  const rev = await h.call(h.users.sup, 'POST', `${M}/procedures/${proc.body.id}/revisions`, {
    safety_instructions: 'Isolate the pump.',
    signature_required: signatureRequired,
    steps: [
      { key: 'gauge', label: 'Bearing temperature', type: 'numeric', unit: 'C', min: 0, max: 80, required: false },
      { key: 'follow', label: 'Cooling restored', type: 'pass_fail', visible_when: { key: 'gauge', when: 'outside_limits' } },
    ],
  });
  expect(rev.status, JSON.stringify(rev.body)).toBe(201);
  expect((await h.call(h.users.sup, 'POST', `${M}/procedure-revisions/${rev.body.id}/publish`)).status).toBe(200);
  return rev.body.id as string;
}

async function start(revisionId: string) {
  const wo = await readyOrder(h, { assetId, procedureRevisionId: revisionId, assignee: h.users.tech, title: 'Shop floor job' });
  const started = await h.call(h.users.tech, 'POST', `${M}/work-orders/${wo.id}/transitions`, { action: 'start', record_version: wo.version });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return { id: wo.id, version: started.body.version as number };
}

async function record(id: string, results: Array<Record<string, unknown>>) {
  const saved = await h.call(h.users.tech, 'POST', `${M}/work-orders/${id}/results`, { results });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
}

async function submit(id: string) {
  const current = await h.call(h.users.sup, 'GET', `${M}/work-orders/${id}`);
  return h.call(h.users.tech, 'POST', `${M}/work-orders/${id}/transitions`, {
    action: 'submit_completion',
    record_version: current.body.version,
    completion: { corrective_action: 'Restored cooling', cause_code: 'WEAR' },
  });
}

describe('shop floor S1', () => {
  it('measures accepted response time and keeps rejected and open requests out of the average', async () => {
    h.clock.set(new Date('2026-10-02T00:00:00Z'));
    const accepted = await h.call(h.users.reporter, 'POST', `${M}/requests`, {
      site_id: h.siteA1, asset_id: assetId, description: 'Accepted leak', observed_at: '2026-10-02T00:00:00Z',
    });
    h.clock.advance(2 * 60 * 60 * 1000);
    const triage = await h.call(h.users.sup, 'POST', `${M}/requests/${accepted.body.id}/triage`, {
      action: 'accept', record_version: accepted.body.version,
      draft: { title: 'Fix leak', priority: 'normal', team_id: h.teamA1, scope: 'Replace the seal' },
    });
    expect(triage.status, JSON.stringify(triage.body)).toBe(200);

    const rejected = await h.call(h.users.reporter, 'POST', `${M}/requests`, {
      site_id: h.siteA1, asset_id: assetId, description: 'Duplicate leak', observed_at: '2026-10-02T02:00:00Z',
    });
    h.clock.advance(60 * 60 * 1000);
    expect((await h.call(h.users.sup, 'POST', `${M}/requests/${rejected.body.id}/triage`, {
      action: 'reject', record_version: rejected.body.version, reason: 'Already reported on the same seal',
    })).status).toBe(200);

    const open = await h.call(h.users.reporter, 'POST', `${M}/requests`, {
      site_id: h.siteA1, asset_id: assetId, description: 'Still waiting', observed_at: '2026-10-02T03:00:00Z',
    });
    expect(open.status).toBe(201);

    const report = await h.call(h.users.sup, 'GET', `${M}/reports/mtta?site_id=${h.siteA1}&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.average_hours).toBe(2);
    expect(report.body.accepted_count).toBe(1);
    expect(report.body.rejected_count).toBe(1);
    expect(report.body.open_requests.map((row: { id: string }) => row.id)).toContain(open.body.id);

    const empty = await h.call(h.users.sup, 'GET', `${M}/reports/mtta?site_id=${h.siteA1}&from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`);
    expect(empty.body).toMatchObject({ average_hours: null, accepted_count: 0, rejected_count: 0, open_requests: [] });
  });

  it('blocks completion until the issued procedure is signed, and rejects a stale hash', async () => {
    const job = await start(signedRevision);
    await record(job.id, [{ key: 'gauge', value: 40, unit: 'C' }]);
    const blocked = await submit(job.id);
    expect(blocked.status).toBe(422);
    expect(JSON.stringify(blocked.body)).toContain('completion.signature');

    const detail = (await h.call(h.users.tech, 'GET', `${M}/work-orders/${job.id}`)).body;
    const wrong = await h.call(h.users.tech, 'POST', `${M}/work-orders/${job.id}/signature`, {
      snapshot_hash: 'ab'.repeat(32), record_version: detail.version,
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('snapshot_hash_mismatch');

    const signed = await h.call(h.users.tech, 'POST', `${M}/work-orders/${job.id}/signature`, {
      snapshot_hash: detail.procedure_snapshot_hash, record_version: detail.version,
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const done = await submit(job.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  });

  it('requires a hidden follow-up only after the controlling check fails', async () => {
    const quiet = await start(plainRevision);
    await record(quiet.id, [{ key: 'gauge', value: 40, unit: 'C' }]);
    expect((await submit(quiet.id)).status).toBe(200);

    const hot = await start(plainRevision);
    await record(hot.id, [{ key: 'gauge', value: 95, unit: 'C' }]);
    const missing = await submit(hot.id);
    expect(missing.status).toBe(422);
    expect(JSON.stringify(missing.body)).toContain('follow');
    await record(hot.id, [{ key: 'follow', value: true }]);
    expect((await submit(hot.id)).status).toBe(200);
  });

  it('conflicts when a signature uses the hash from before a procedure change', async () => {
    const wo = await readyOrder(h, { assetId, procedureRevisionId: signedRevision, assignee: h.users.tech, title: 'Hash change' });
    const before = (await h.call(h.users.sup, 'GET', `${M}/work-orders/${wo.id}`)).body;
    const changed = await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${wo.id}`, { procedure_revision_id: altSignedRevision }, { 'if-match': `"${wo.version}"` });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.state).toBe('pending_approval');
    const approved = await h.call(h.users.sup2, 'POST', `${M}/work-orders/${wo.id}/transitions`, { action: 'approve', record_version: changed.body.version });
    const started = await h.call(h.users.tech, 'POST', `${M}/work-orders/${wo.id}/transitions`, { action: 'start', record_version: approved.body.version });
    const stale = await h.call(h.users.tech, 'POST', `${M}/work-orders/${wo.id}/signature`, {
      snapshot_hash: before.procedure_snapshot_hash, record_version: started.body.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('snapshot_hash_mismatch');
  });

  it('moves a ready order on the planning board and rejects a stale version', async () => {
    const wo = await readyOrder(h, { assetId, procedureRevisionId: plainRevision, assignee: h.users.tech, title: 'Board move' });
    const stale = await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${wo.id}`, {
      planned_start: '2026-10-20T06:00:00Z', planned_end: '2026-10-20T14:00:00Z',
    }, { 'if-match': `"${wo.version - 1}"` });
    expect(stale.status).toBe(409);

    const moved = await h.call(h.users.sup, 'PATCH', `${M}/work-orders/${wo.id}`, {
      planned_start: '2026-10-20T06:00:00Z', planned_end: '2026-10-20T14:00:00Z',
    }, { 'if-match': `"${wo.version}"` });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.state).toBe('pending_approval');
    expect(moved.body.planned_start).toContain('2026-10-20');
  });

  it('stores a shift without dropping the site policy, and a bad offline signature is a conflict', async () => {
    const current = (await h.call(h.users.admin, 'GET', `${M}/sites/${h.siteA1}/settings`)).body;
    const saved = await h.call(h.users.admin, 'PUT', `${M}/sites/${h.siteA1}/settings`, {
      record_version: current.version,
      shifts: [{ code: 'day', label: 'Day', start_minute: 480, end_minute: 960 }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.shifts).toEqual([{ code: 'day', label: 'Day', start_minute: 480, end_minute: 960 }]);
    expect(saved.body.pm_initial_state).toBe(current.pm_initial_state);

    const job = await start(signedRevision);
    const detail = (await h.call(h.users.tech, 'GET', `${M}/work-orders/${job.id}`)).body;
    const synced = await h.call(h.users.tech, 'POST', `${M}/sync/operations`, {
      operations: [{
        client_op_id: 'sf-sign-1',
        type: 'completion_signature',
        record_id: job.id,
        base_version: detail.version,
        client_time: '2026-10-02T04:00:00Z',
        payload: { snapshot_hash: 'cd'.repeat(32), record_version: detail.version },
      }],
    });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.results[0].outcome).toBe('conflict');
  });

  it('does not require a hidden inspection check and opens one request for a visible failure', async () => {
    const template = await h.call(h.users.sup, 'POST', `${M}/inspection-templates`, { site_id: h.siteA1, title: 'Conditional walkdown' });
    await h.call(h.users.sup, 'POST', `${M}/inspection-templates/${template.body.id}/revisions`, {
      checks: [
        { key: 'status', label: 'Running normally', type: 'pass_fail' },
        { key: 'follow', label: 'Leak contained', type: 'pass_fail', visible_when: { key: 'status', when: 'failed' } },
      ],
    });
    const published = await h.call(h.users.sup, 'POST', `${M}/inspection-templates/${template.body.id}/publish`);
    const asset = (await h.createAsset(h.users.assetAdmin, h.siteA1, 'SF-INSP')).id;
    const hidden = await h.call(h.users.tech, 'POST', `${M}/inspection-results`, {
      template_revision_id: published.body.id, asset_id: asset, client_submission_id: 'sf-pass',
    });
    const passed = await h.call(h.users.tech, 'POST', `${M}/inspection-results/${hidden.body.id}/submit`, {
      observed_at: '2026-10-02T04:00:00Z',
      values: [{ key: 'status', value: true }],
    });
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(passed.body.request_id).toBeFalsy();

    const failedStart = await h.call(h.users.tech, 'POST', `${M}/inspection-results`, {
      template_revision_id: published.body.id, asset_id: asset, client_submission_id: 'sf-fail',
    });
    const failed = await h.call(h.users.tech, 'POST', `${M}/inspection-results/${failedStart.body.id}/submit`, {
      observed_at: '2026-10-02T05:00:00Z',
      values: [{ key: 'status', value: false }, { key: 'follow', value: false }],
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.request_id).toBeTruthy();
    const rows = await h.db.query(`SELECT id FROM maintenance.request WHERE source_ref->>'inspection_result_id' = $1`, [failedStart.body.id]);
    expect(rows.rows).toHaveLength(1);
  });
});
