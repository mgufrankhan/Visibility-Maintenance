import { randomUUID } from 'node:crypto';
import type { automationPolicyRequest } from '@vm/contracts';
import { withTransaction } from '@vm/db';
import { invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission, requireVisible } from './access.ts';
import type { Actor, Services, SystemActor } from './context.ts';
import { writeAudit } from './records.ts';
import { insertWorkOrder } from './work-orders.ts';

type PolicyInput = z.infer<typeof automationPolicyRequest>;

function policyDto(r: Record<string, any>) {
  return {
    id: r.id,
    site_id: r.site_id,
    kind: r.kind,
    enabled: r.enabled,
    config: r.config,
    version: r.version,
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export async function listAutomationPolicies(s: Services, actor: Actor, siteId: string) {
  requireVisible(actor.principal, 'maintenance.view', siteId, 'Site');
  const { rows } = await s.db.query(
    `SELECT * FROM maintenance.automation_policy WHERE tenant_id = $1 AND site_id = $2 ORDER BY kind`,
    [actor.principal.tenantId, siteId],
  );
  return rows.map(policyDto);
}

export async function upsertAutomationPolicy(s: Services, actor: Actor, input: PolicyInput) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.automation.manage', input.site_id);
  if (input.enabled && !input.config.team_id) {
    throw invalid('team_id is required when enabling auto-draft automation', { 'config.team_id': ['Required'] });
  }
  return withTransaction(s.db, async (tx) => {
    const { rows: existing } = await tx.query(
      `SELECT * FROM maintenance.automation_policy WHERE tenant_id = $1 AND site_id = $2 AND kind = $3 FOR UPDATE`,
      [p.tenantId, input.site_id, input.kind],
    );
    if (existing[0]) {
      const { rows } = await tx.query(
        `UPDATE maintenance.automation_policy
            SET enabled = $3, config = $4::jsonb, version = version + 1, updated_at = now(), updated_by = $5
          WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [existing[0].id, p.tenantId, input.enabled, JSON.stringify(input.config), p.userId],
      );
      await writeAudit(tx, actor, {
        siteId: input.site_id,
        action: input.enabled ? 'automation.enabled' : 'automation.disabled',
        targetType: 'automation_policy',
        targetId: rows[0].id,
        beforeVersion: existing[0].version,
        afterVersion: rows[0].version,
      });
      return policyDto(rows[0]);
    }
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.automation_policy (id, tenant_id, site_id, kind, enabled, config, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7) RETURNING *`,
      [id, p.tenantId, input.site_id, input.kind, input.enabled, JSON.stringify(input.config), p.userId],
    );
    await writeAudit(tx, actor, {
      siteId: input.site_id,
      action: input.enabled ? 'automation.enabled' : 'automation.created',
      targetType: 'automation_policy',
      targetId: id,
    });
    return policyDto(rows[0]);
  });
}

/**
 * Runs enabled auto-draft policies. Creates a draft WO from high-priority
 * requests that have waited past the configured delay and are still submitted.
 */
export async function runAutomations(s: Services, workerId: string): Promise<{ processed: number; drafted: number }> {
  const { rows: policies } = await s.db.query(
    `SELECT * FROM maintenance.automation_policy WHERE enabled = true AND kind = 'auto_draft_high_priority_request'`,
  );
  let processed = 0;
  let drafted = 0;
  for (const policy of policies) {
    const delayHours = Number(policy.config?.delay_hours ?? 4);
    const teamId = policy.config?.team_id as string | null;
    if (!teamId) continue;
    if (!(await s.entitlements.has(policy.tenant_id, 'core.create_work'))) continue;
    const cutoff = new Date(s.clock.now().getTime() - delayHours * 3600_000);
    const system: SystemActor = {
      kind: 'system',
      tenantId: policy.tenant_id,
      label: `automation:${workerId}`,
      correlationId: randomUUID(),
    };
    await withTransaction(s.db, async (tx) => {
      const { rows: requests } = await tx.query(
        `SELECT * FROM maintenance.request
          WHERE tenant_id = $1 AND site_id = $2 AND state = 'submitted' AND proposed_priority = 'high'
            AND created_at <= $3
          ORDER BY created_at
          LIMIT 20
          FOR UPDATE SKIP LOCKED`,
        [policy.tenant_id, policy.site_id, cutoff],
      );
      for (const req of requests) {
        processed += 1;
        let asset = null;
        if (req.asset_id) {
          const { rows } = await tx.query(`SELECT * FROM maintenance.asset_snapshot WHERE tenant_id = $1 AND asset_id = $2`, [
            policy.tenant_id,
            req.asset_id,
          ]);
          if (rows[0]) {
            asset = {
              asset_id: rows[0].asset_id,
              site_id: rows[0].site_id,
              parent_id: rows[0].parent_id,
              code: rows[0].code,
              name: rows[0].name,
              asset_type: rows[0].asset_type,
              location: rows[0].location,
              lifecycle: rows[0].lifecycle,
              qr_token: rows[0].qr_token,
              version: rows[0].version,
              from_snapshot: true,
              fetched_at: new Date(rows[0].fetched_at).toISOString(),
            };
          }
        }
        const wo = await insertWorkOrder(tx, s, system, {
          siteId: policy.site_id,
          type: 'corrective',
          priority: 'high',
          title: `Auto-draft: ${String(req.description).slice(0, 80)}`,
          description: req.description,
          scope: 'Created by approved automation policy auto_draft_high_priority_request',
          asset,
          nonAssetCategory: null,
          nonAssetJustification: null,
          locationText: req.location_text,
          teamId,
          assigneeId: null,
          plannedStart: null,
          plannedEnd: null,
          dueAt: null,
          procedureRevisionId: null,
          safetyInstructions: null,
          sourceRequestId: req.id,
          planOccurrenceId: null,
          followUpOfId: null,
          initialState: 'draft',
          creationReason: `Automation ${policy.id} from request ${req.display_number}`,
        });
        const now = s.clock.now();
        await tx.query(
          `UPDATE maintenance.request SET state = 'accepted', linked_work_order_id = $3, triaged_at = $4, triage_reason = $5,
             version = version + 1, change_seq = nextval('maintenance.change_seq'), updated_at = $4
           WHERE id = $1 AND tenant_id = $2`,
          [req.id, policy.tenant_id, wo.id, now, 'Accepted by approved automation policy'],
        );
        drafted += 1;
      }
    });
  }
  return { processed, drafted };
}

export async function getAutomationPolicy(s: Services, actor: Actor, id: string) {
  const { rows } = await s.db.query(`SELECT * FROM maintenance.automation_policy WHERE tenant_id = $1 AND id::text = $2`, [
    actor.principal.tenantId,
    id,
  ]);
  if (!rows[0]) throw notFound('Automation policy');
  requireVisible(actor.principal, 'maintenance.view', rows[0].site_id, 'Automation policy');
  return policyDto(rows[0]);
}
