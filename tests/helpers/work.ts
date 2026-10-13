import type { Harness, TestUser } from './harness.ts';

const M = '/api/v1/maintenance';

/** Publishes a one-step procedure at site A1 and returns its revision ID. */
export async function publishSimpleProcedure(h: Harness, title = 'Visual check'): Promise<string> {
  const proc = await h.call(h.users.sup, 'POST', `${M}/procedures`, { site_id: h.siteA1, title });
  const rev = await h.call(h.users.sup, 'POST', `${M}/procedures/${proc.body.id}/revisions`, {
    safety_instructions: 'Wear PPE.',
    steps: [{ key: 'checked', label: 'Checked', type: 'pass_fail' }],
  });
  await h.call(h.users.sup, 'POST', `${M}/procedure-revisions/${rev.body.id}/publish`);
  return rev.body.id;
}

/** Creates an approved (Ready) corrective order at site A1 assigned to `assignee`. */
export async function readyOrder(h: Harness, o: { assetId: string; procedureRevisionId: string; assignee: TestUser; title?: string }): Promise<{ id: string; version: number }> {
  const created = await h.call(h.users.sup, 'POST', `${M}/work-orders`, {
    site_id: h.siteA1,
    asset_id: o.assetId,
    title: o.title ?? 'Repair',
    priority: 'normal',
    team_id: h.teamA1,
    scope: 'Repair the fault',
    assignee_id: o.assignee.id,
    procedure_revision_id: o.procedureRevisionId,
    planned_start: '2026-10-13T04:00:00Z',
    planned_end: '2026-10-13T08:00:00Z',
  });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const sub = await h.call(h.users.sup, 'POST', `${M}/work-orders/${created.body.id}/transitions`, { action: 'submit_for_approval', record_version: created.body.version });
  const app = await h.call(h.users.sup2, 'POST', `${M}/work-orders/${created.body.id}/transitions`, { action: 'approve', record_version: sub.body.version });
  if (app.status !== 200) throw new Error(`approve failed: ${JSON.stringify(app.body)}`);
  return { id: created.body.id, version: app.body.version };
}

/** Takes an order from Ready through closure with an independent verifier. */
export async function closeOrder(h: Harness, woId: string, tech: TestUser): Promise<void> {
  const act = async (u: TestUser, action: string, extra: Record<string, unknown> = {}) => {
    const wo = await h.call(h.users.sup, 'GET', `${M}/work-orders/${woId}`);
    const r = await h.call(u, 'POST', `${M}/work-orders/${woId}/transitions`, { action, record_version: wo.body.version, ...extra });
    if (r.status !== 200) throw new Error(`${action} failed: ${JSON.stringify(r.body)}`);
  };
  await act(tech, 'start');
  await h.call(tech, 'POST', `${M}/work-orders/${woId}/results`, { results: [{ key: 'checked', value: true }] });
  await act(tech, 'submit_completion', { completion: { corrective_action: 'Fixed', cause_code: 'WEAR' } });
  await act(h.users.sup, 'close', { closure_outcome: 'restored' });
}
