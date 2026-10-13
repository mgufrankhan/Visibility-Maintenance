import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runPmScheduler } from '@vm/core';
import { createHarness, type Harness } from '../helpers/harness.ts';

const M = '/api/v1/maintenance';
let h: Harness;
let procRev1: string;
let currentProcRev: string;
let procedureId: string;

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-01T00:00:00Z') });
  const proc = await h.call(h.users.sup, 'POST', `${M}/procedures`, { site_id: h.siteA1, title: 'Monthly lubrication' });
  procedureId = proc.body.id;
  const rev = await h.call(h.users.sup, 'POST', `${M}/procedures/${procedureId}/revisions`, {
    safety_instructions: 'Isolate drive before greasing.',
    steps: [{ key: 'greased', label: 'Bearings greased', type: 'pass_fail' }],
  });
  procRev1 = rev.body.id;
  currentProcRev = procRev1;
  await h.call(h.users.sup, 'POST', `${M}/procedure-revisions/${procRev1}/publish`);
});
afterAll(async () => h?.close());

interface PlanOpts {
  code: string;
  trigger: Record<string, unknown>;
  lead_days?: number;
  effective_from?: string;
  procedureRevisionId?: string;
}

async function publishedPlan(o: PlanOpts) {
  const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, o.code);
  const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, { site_id: h.siteA1, asset_id: asset.id, title: `PM ${o.code}` });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  const rev = await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, {
    title: `Lubricate ${o.code}`,
    scope: 'Grease drive and non-drive bearings',
    procedure_revision_id: o.procedureRevisionId ?? currentProcRev,
    team_id: h.teamA1,
    estimated_minutes: 45,
    lead_days: o.lead_days ?? 7,
    trigger: { type: 'calendar', time_of_day: '09:00', ...o.trigger },
    effective_from: o.effective_from ?? '2026-10-01',
  });
  expect(rev.status, JSON.stringify(rev.body)).toBe(201);
  const pub = await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${rev.body.id}/publish`);
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return { asset, planId: plan.body.id as string, revisionId: rev.body.id as string };
}

const run = (tenantId = h.tenantA) => runPmScheduler(h.services, 'test-worker', { tenantId });
const occurrences = async (planId: string) => (await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`)).body.occurrences as any[];
const orderCount = async (planId: string) =>
  Number((await h.db.query(`SELECT count(*) FROM maintenance.work_order w JOIN maintenance.pm_occurrence o ON o.id = w.plan_occurrence_id WHERE o.plan_id = $1`, [planId])).rows[0].count);

describe('calendar PM plans (MP-01..MP-03)', () => {
  it('previews a month-end schedule in the site timezone', async () => {
    const { revisionId } = await publishedPlan({ code: 'PREV-1', trigger: { unit: 'month', interval: 1, anchor_date: '2026-10-31' } });
    const r = await h.call(h.users.tech, 'GET', `${M}/plan-revisions/${revisionId}/preview?count=4`);
    expect(r.body.items.map((o: any) => o.due_date)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31']);
    // Site A1 is Asia/Karachi (UTC+5): 09:00 local is 04:00 UTC.
    expect(r.body.items[0].due_at).toBe('2026-10-31T04:00:00.000Z');
    expect(r.body.items[0].generate_at).toBe('2026-10-24T04:00:00.000Z');
  });

  it('rejects plans with unpublished procedures, foreign teams or invalid triggers', async () => {
    const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'BAD-1');
    const plan = await h.call(h.users.sup, 'POST', `${M}/plans`, { site_id: h.siteA1, asset_id: asset.id, title: 'Bad' });
    const draftProc = await h.call(h.users.sup, 'POST', `${M}/procedures/${procedureId}/revisions`, { safety_instructions: 'x', steps: [{ key: 'a', label: 'a', type: 'pass_fail' }] });
    const base = { title: 't', scope: 's', team_id: h.teamA1, estimated_minutes: 30, trigger: { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2026-10-05', time_of_day: '09:00' }, effective_from: '2026-10-01' };
    expect((await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, { ...base, procedure_revision_id: draftProc.body.id })).status).toBe(422);
    expect((await h.call(h.users.sup, 'POST', `${M}/plans/${plan.body.id}/revisions`, { ...base, procedure_revision_id: procRev1, trigger: { ...base.trigger, time_of_day: '24:00' } })).status).toBe(422);
    expect((await h.call(h.users.tech, 'POST', `${M}/plans/${plan.body.id}/revisions`, { ...base, procedure_revision_id: procRev1 })).status).toBe(403);
    expect((await h.call(h.users.supB, 'GET', `${M}/plans/${plan.body.id}`)).status).toBe(404);
  });

  it('generates one Ready order when the lead time begins, and never twice on retry', async () => {
    h.clock.set('2026-10-01T00:00:00Z');
    const { planId, asset } = await publishedPlan({ code: 'GEN-1', trigger: { unit: 'month', interval: 1, anchor_date: '2026-10-31' } });
    await run();
    expect(await orderCount(planId)).toBe(0);

    h.clock.set('2026-10-24T04:00:00Z');
    const first = await run();
    expect(first.issued).toBeGreaterThanOrEqual(1);
    await run();
    expect(await orderCount(planId)).toBe(1);

    const occ = await occurrences(planId);
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({ occurrence_key: '2026-10-31', status: 'issued' });
    const wo = (await h.call(h.users.tech, 'GET', `${M}/work-orders/${occ[0].work_order_id}`)).body;
    expect(wo).toMatchObject({ type: 'preventive', state: 'ready', asset_id: asset.id, team_id: h.teamA1, assignee_id: null, due_at: '2026-10-31T04:00:00.000Z' });
    expect(wo.procedure_snapshot.procedure_revision_id).toBe(procRev1);
    const queue = await h.call(h.users.tech, 'GET', `${M}/my-work`);
    expect(queue.body.items.map((i: any) => i.id)).toContain(wo.id);
  });

  it('creates one occurrence and order under concurrent schedulers', async () => {
    h.clock.set('2026-10-02T00:00:00Z');
    const { planId } = await publishedPlan({ code: 'CONC-1', trigger: { unit: 'day', interval: 1, anchor_date: '2026-10-05' }, lead_days: 1 });
    h.clock.set('2026-10-04T05:00:00Z');
    await Promise.all([run(), run(), run(), runPmScheduler(h.services, 'other-worker')]);
    expect(await orderCount(planId)).toBe(1);
    const dup = await h.db.query(`SELECT occurrence_key, count(*) FROM maintenance.pm_occurrence WHERE plan_id = $1 GROUP BY 1 HAVING count(*) > 1`, [planId]);
    expect(dup.rows).toEqual([]);
  });

  it('issues only the latest missed occurrence after scheduler downtime and logs the rest', async () => {
    h.clock.set('2026-10-05T00:00:00Z');
    const { planId } = await publishedPlan({ code: 'CATCH-1', trigger: { unit: 'week', interval: 1, anchor_date: '2026-10-06' }, lead_days: 0 });
    h.clock.set('2026-11-04T00:00:00Z');
    const sum = await run();
    expect(sum.issued).toBeGreaterThanOrEqual(1);
    const occ = await occurrences(planId);
    const byKey = Object.fromEntries(occ.map((o) => [o.occurrence_key, o.status]));
    expect(byKey).toEqual({ '2026-10-06': 'missed', '2026-10-13': 'missed', '2026-10-20': 'missed', '2026-10-27': 'missed', '2026-11-03': 'issued' });
    expect(await orderCount(planId)).toBe(1);
  });

  it('keeps at most one overdue order open per plan and asset', async () => {
    h.clock.set('2026-11-05T00:00:00Z');
    const { planId } = await publishedPlan({ code: 'OVER-1', trigger: { unit: 'week', interval: 1, anchor_date: '2026-11-06' }, lead_days: 1 });
    h.clock.set('2026-11-05T05:00:00Z');
    await run();
    expect(await orderCount(planId)).toBe(1);
    // The first order is never worked; three more weeks pass with the scheduler running.
    for (const day of ['2026-11-12T05:00:00Z', '2026-11-19T05:00:00Z', '2026-11-26T05:00:00Z']) {
      h.clock.set(day);
      await run();
    }
    expect(await orderCount(planId)).toBe(1);
    const statuses = (await occurrences(planId)).map((o) => o.status).sort();
    expect(statuses).toEqual(['issued', 'skipped_open_overdue', 'skipped_open_overdue', 'skipped_open_overdue']);
  });

  it('respects the site policy for the initial state of generated orders (D16)', async () => {
    const settings = (await h.call(h.users.admin, 'GET', `${M}/sites/${h.siteA1}/settings`)).body;
    const put = await h.call(h.users.admin, 'PUT', `${M}/sites/${h.siteA1}/settings`, { pm_initial_state: 'pending_approval', record_version: settings.version });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    try {
      h.clock.set('2026-12-01T00:00:00Z');
      const { planId } = await publishedPlan({ code: 'APPR-1', trigger: { unit: 'day', interval: 7, anchor_date: '2026-12-03' }, lead_days: 3 });
      await run();
      const occ = await occurrences(planId);
      expect((await h.call(h.users.sup, 'GET', `${M}/work-orders/${occ[0].work_order_id}`)).body.state).toBe('pending_approval');
    } finally {
      const cur = (await h.call(h.users.admin, 'GET', `${M}/sites/${h.siteA1}/settings`)).body;
      await h.call(h.users.admin, 'PUT', `${M}/sites/${h.siteA1}/settings`, { pm_initial_state: 'ready', record_version: cur.version });
    }
  });
});

describe('plan lifecycle and eligibility (MP-01, MP-05)', () => {
  it('pausing stops generation without cancelling issued work, and resuming does not backfill', async () => {
    h.clock.set('2027-01-01T00:00:00Z');
    const { planId } = await publishedPlan({ code: 'PAUSE-1', trigger: { unit: 'week', interval: 1, anchor_date: '2027-01-04' }, lead_days: 2 });
    h.clock.set('2027-01-02T05:00:00Z');
    await run();
    const issued = await occurrences(planId);
    expect(issued).toHaveLength(1);
    let plan = (await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`)).body;
    expect((await h.call(h.users.sup, 'POST', `${M}/plans/${planId}/pause`, { record_version: plan.version })).status).toBe(422);
    const paused = await h.call(h.users.sup, 'POST', `${M}/plans/${planId}/pause`, { record_version: plan.version, reason: 'Line shut for refit' });
    expect(paused.body.status).toBe('paused');
    h.clock.set('2027-02-01T00:00:00Z');
    await run();
    expect(await occurrences(planId)).toHaveLength(1);
    expect((await h.call(h.users.sup, 'GET', `${M}/work-orders/${issued[0].work_order_id}`)).body.state).toBe('ready');

    plan = (await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`)).body;
    await h.call(h.users.sup, 'POST', `${M}/plans/${planId}/resume`, { record_version: plan.version, reason: 'Refit complete' });
    await run();
    const after = await occurrences(planId);
    expect(after.filter((o) => o.status === 'missed')).toHaveLength(0);
    expect(after.every((o) => o.occurrence_key === '2027-01-04' || o.occurrence_key >= '2027-02-01')).toBe(true);
  });

  it('blocks generation for an archived asset and records why', async () => {
    h.clock.set('2027-03-01T00:00:00Z');
    const { planId, asset } = await publishedPlan({ code: 'ARCH-1', trigger: { unit: 'day', interval: 1, anchor_date: '2027-03-02' }, lead_days: 1 });
    const archived = await h.platformCall(h.users.assetAdmin, 'POST', `/api/v1/assets/${asset.id}/archive`, { reason: 'Decommissioned' }, { 'if-match': `"${asset.version}"` });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    h.clock.set('2027-03-01T05:00:00Z');
    await run();
    const occ = await occurrences(planId);
    expect(occ[0]).toMatchObject({ status: 'blocked_asset', work_order_id: null });
    expect(await orderCount(planId)).toBe(0);
  });

  it('keeps already-issued orders on their procedure snapshot after a new revision is published', async () => {
    h.clock.set('2027-04-01T00:00:00Z');
    const { planId } = await publishedPlan({ code: 'REV-1', trigger: { unit: 'week', interval: 1, anchor_date: '2027-04-05' }, lead_days: 8 });
    await run();
    const first = (await occurrences(planId))[0];
    const rev2 = await h.call(h.users.sup, 'POST', `${M}/procedures/${procedureId}/revisions`, { safety_instructions: 'Isolate drive; wear gloves.', steps: [{ key: 'greased', label: 'Bearings greased', type: 'pass_fail' }, { key: 'temp', label: 'Bearing temperature', type: 'numeric', unit: 'C', max: 80 }] });
    await h.call(h.users.sup, 'POST', `${M}/procedure-revisions/${rev2.body.id}/publish`);
    currentProcRev = rev2.body.id;

    // The old plan revision now points at an obsolete procedure: generation stops with a visible reason.
    h.clock.set('2027-04-05T00:00:00Z');
    await run();
    let plan = (await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`)).body;
    expect(plan.last_generation_issue).toMatch(/Procedure revision cannot be issued/);

    const planRev2 = await h.call(h.users.sup, 'POST', `${M}/plans/${planId}/revisions`, {
      title: 'Lubricate REV-1 v2', scope: 'Grease and check temperature', procedure_revision_id: rev2.body.id, team_id: h.teamA1,
      estimated_minutes: 60, lead_days: 8, trigger: { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2027-04-05', time_of_day: '09:00' }, effective_from: '2027-04-01',
    });
    await h.call(h.users.sup, 'POST', `${M}/plan-revisions/${planRev2.body.id}/publish`);
    await run();
    plan = (await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`)).body;
    expect(plan.revisions.map((r: any) => r.status)).toEqual(['published', 'superseded']);
    const occ = await occurrences(planId);
    const newest = occ.find((o) => o.plan_revision_id === planRev2.body.id && o.status === 'issued');
    expect(newest).toBeDefined();
    const [oldWo, newWo] = await Promise.all([first.work_order_id, newest.work_order_id].map(async (id) => (await h.call(h.users.sup, 'GET', `${M}/work-orders/${id}`)).body));
    expect(oldWo.procedure_snapshot.procedure_revision_id).toBe(procRev1);
    expect(newWo.procedure_snapshot.procedure_revision_id).toBe(rev2.body.id);
  });

  it('rejects edits to published plan revisions at the database level', async () => {
    const { revisionId } = await publishedPlan({ code: 'IMM-1', trigger: { unit: 'week', interval: 1, anchor_date: '2027-05-03' } });
    await expect(h.db.query(`UPDATE maintenance.pm_plan_revision SET lead_days = 1 WHERE id = $1`, [revisionId])).rejects.toThrow(/immutable/);
  });
});

describe('inspections (MP-06)', () => {
  let templateId: string;
  let revisionId: string;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('gauge')]);

  beforeAll(async () => {
    const t = await h.call(h.users.sup, 'POST', `${M}/inspection-templates`, { site_id: h.siteA1, title: 'Compressor walkdown' });
    templateId = t.body.id;
    await h.call(h.users.sup, 'POST', `${M}/inspection-templates/${templateId}/revisions`, {
      checks: [
        { key: 'pressure', label: 'Discharge pressure', type: 'numeric', unit: 'bar', min: 2, max: 6 },
        { key: 'no_leaks', label: 'No oil leaks', type: 'pass_fail', safety_critical: true },
        { key: 'gauge_photo', label: 'Gauge photo', type: 'photo', evidence_required: true },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
    });
    const pub = await h.call(h.users.sup, 'POST', `${M}/inspection-templates/${templateId}/publish`);
    revisionId = pub.body.id;
  });

  async function start(clientId: string, assetId?: string) {
    const asset = assetId ?? (await h.createAsset(h.users.assetAdmin, h.siteA1, `CMP-${clientId}`)).id;
    const r = await h.call(h.users.tech, 'POST', `${M}/inspection-results`, { template_revision_id: revisionId, asset_id: asset, client_submission_id: clientId });
    return { r, asset };
  }

  async function photo(resultId: string) {
    const slot = await h.call(h.users.tech, 'POST', `${M}/attachments`, {
      owner_type: 'inspection_result', owner_id: resultId, file_name: 'gauge.png', media_type: 'image/png', size_bytes: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex'),
    });
    expect(slot.status, JSON.stringify(slot.body)).toBe(201);
    expect((await h.call(h.users.tech, 'PUT', slot.body.upload_url, PNG, { 'content-type': 'application/octet-stream' })).status).toBe(200);
    return slot.body.id as string;
  }

  it('reuses the result for a repeated start', async () => {
    const { r, asset } = await start('walk-1');
    expect(r.status).toBe(201);
    const again = await h.call(h.users.tech, 'POST', `${M}/inspection-results`, { template_revision_id: revisionId, asset_id: asset, client_submission_id: 'walk-1' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);
  });

  it('creates exactly one reviewable request for failed checks, even on resubmission', async () => {
    const { r } = await start('walk-2');
    const att = await photo(r.body.id);
    const body = {
      observed_at: '2027-05-01T06:00:00Z',
      values: [
        { key: 'pressure', value: 7.4, unit: 'bar' },
        { key: 'no_leaks', value: false },
        { key: 'gauge_photo', value: null, attachment_ids: [att] },
      ],
    };
    const sub = await h.call(h.users.tech, 'POST', `${M}/inspection-results/${r.body.id}/submit`, body);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({ status: 'submitted', passed: false, replayed: false });
    expect(sub.body.request_id).toBeTruthy();
    const again = await h.call(h.users.tech, 'POST', `${M}/inspection-results/${r.body.id}/submit`, body);
    expect(again.body).toMatchObject({ replayed: true, request_id: sub.body.request_id });
    const reqs = await h.db.query(`SELECT id FROM maintenance.request WHERE source_ref->>'inspection_result_id' = $1`, [r.body.id]);
    expect(reqs.rows).toHaveLength(1);
    const req = (await h.call(h.users.sup, 'GET', `${M}/requests/${sub.body.request_id}`)).body;
    expect(req).toMatchObject({ origin: 'inspection', state: 'submitted', proposed_priority: 'high' });
    expect(req.description).toContain('Discharge pressure: 7.4 bar');
    expect((await h.call(h.users.tech, 'POST', `${M}/attachments`, { owner_type: 'inspection_result', owner_id: r.body.id, file_name: 'late.png', media_type: 'image/png', size_bytes: PNG.length, sha256: 'a'.repeat(64) })).status).toBe(409);
  });

  it('passes without a request and validates units, required checks and evidence', async () => {
    const { r } = await start('walk-3');
    const missingEvidence = await h.call(h.users.tech, 'POST', `${M}/inspection-results/${r.body.id}/submit`, {
      observed_at: '2027-05-01T06:00:00Z',
      values: [{ key: 'pressure', value: 4, unit: 'psi' }, { key: 'no_leaks', value: true }, { key: 'gauge_photo', value: null }],
    });
    expect(missingEvidence.status).toBe(422);
    expect(Object.keys(missingEvidence.body.error.field_errors).sort()).toEqual(['values.gauge_photo', 'values.pressure']);
    const att = await photo(r.body.id);
    const ok = await h.call(h.users.tech, 'POST', `${M}/inspection-results/${r.body.id}/submit`, {
      observed_at: '2027-05-01T06:00:00Z',
      values: [{ key: 'pressure', value: 4, unit: 'bar' }, { key: 'no_leaks', value: true }, { key: 'gauge_photo', value: null, attachment_ids: [att] }],
    });
    expect(ok.body).toMatchObject({ passed: true, request_id: null });
  });

  it('enforces permissions and scoping', async () => {
    const asset = await h.createAsset(h.users.assetAdmin, h.siteA1, 'CMP-SCOPE');
    expect((await h.call(h.users.viewer, 'POST', `${M}/inspection-results`, { template_revision_id: revisionId, asset_id: asset.id, client_submission_id: 'v-1' })).status).toBe(403);
    const { r } = await start('walk-4', asset.id);
    expect((await h.call(h.users.supB, 'GET', `${M}/inspection-results/${r.body.id}`)).status).toBe(404);
    expect((await h.call(h.users.tech2, 'POST', `${M}/inspection-results/${r.body.id}/submit`, { observed_at: '2027-05-01T06:00:00Z', values: [] })).status).toBe(403);
    const otherSite = await h.createAsset(h.users.assetAdmin, h.siteA2, 'CMP-A2');
    expect((await h.call(h.users.supA2, 'POST', `${M}/inspection-results`, { template_revision_id: revisionId, asset_id: otherSite.id, client_submission_id: 'a2-1' })).status).toBe(422);
  });
});

describe('licensing and PM generation (ML-03)', () => {
  it('stops generation after grace and records a visible reason, without touching issued work', async () => {
    h.clock.set('2027-06-01T00:00:00Z');
    const { planId } = await publishedPlan({ code: 'LIC-1', trigger: { unit: 'day', interval: 1, anchor_date: '2027-06-02' }, lead_days: 1 });
    h.clock.set('2027-06-01T05:00:00Z');
    await run();
    const before = await orderCount(planId);
    expect(before).toBeGreaterThan(0);
    const expired = h.signLicense({ term: { starts_at: '2026-01-01T00:00:00Z', ends_at: '2027-06-01T00:00:00Z' }, grace_days: 0 });
    expect((await h.call(h.users.admin, 'POST', `${M}/licenses`, expired)).status).toBe(201);
    h.clock.set('2027-06-05T00:00:00Z');
    const sum = await run();
    expect(sum.issues.some((i) => i.plan_id === planId && i.issue === 'license')).toBe(true);
    expect(await orderCount(planId)).toBe(before);
    const plan = (await h.call(h.users.sup, 'GET', `${M}/plans/${planId}`)).body;
    expect(plan.last_generation_issue).toMatch(/license/i);
    expect(plan.status).toBe('active');
  });
});
