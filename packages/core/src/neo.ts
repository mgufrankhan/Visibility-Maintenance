import { randomUUID } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { withTransaction } from '@vm/db';
import type { neoAskRequest, recommendationDecisionRequest } from '@vm/contracts';
import { assertToolAllowed, promptVersion, sanitizeUntrustedText, synthesize, type EvidenceItem } from '@vm/neo';
import { can, sitesWith } from '@vm/policy';
import { conflict, forbidden, invalid, notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import type { Actor, Services } from './context.ts';
import { resolveAsset } from './identity-snapshots.ts';
import { enqueueEvent, iso, writeAudit } from './records.ts';
import { insertRequest } from './requests.ts';
import { insertWorkOrder } from './work-orders.ts';

const RUNTIME = 'deterministic-retrieval';

function runDto(r: Record<string, any>) {
  return {
    id: r.id,
    site_id: r.site_id,
    asset_id: r.asset_id,
    query: r.query,
    inference_policy: r.inference_policy,
    runtime: r.runtime,
    model_version: r.model_version,
    prompt_version: r.prompt_version,
    observations: r.observations,
    possible_causes: r.possible_causes,
    recommended_checks: r.recommended_checks,
    citations: r.citations,
    missing_evidence: r.missing_evidence,
    proposed_action_id: r.proposed_action_id,
    outcome: r.outcome,
    created_at: iso(r.created_at),
  };
}

async function gatherEvidence(s: Services, actor: Actor, siteId: string, assetId: string | null, query: string): Promise<EvidenceItem[]> {
  const p = actor.principal;
  const out: EvidenceItem[] = [];
  if (!assetId) return out;

  const { rows: issued } = await s.db.query(
    `SELECT DISTINCT procedure_revision_id AS id, procedure_snapshot FROM maintenance.work_order
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND procedure_revision_id IS NOT NULL
      ORDER BY procedure_revision_id LIMIT 5`,
    [p.tenantId, siteId, assetId],
  );
  for (const r of issued) {
    const snap = (r.procedure_snapshot ?? {}) as { title?: string; revision_no?: number; safety_instructions?: string };
    out.push({
      kind: 'procedure',
      id: r.id,
      title: `${snap.title ?? 'Issued procedure'} rev ${snap.revision_no ?? '?'}`,
      freshness: null,
      excerpt: String(snap.safety_instructions ?? '').slice(0, 400),
      untrusted: false,
    });
  }
  if (!issued.length) {
    const { rows: procs } = await s.db.query(
      `SELECT r.id, r.revision_no, p.title, r.safety_instructions, r.published_at
         FROM maintenance.procedure_revision r JOIN maintenance.procedure p ON p.id = r.procedure_id
        WHERE r.tenant_id = $1 AND r.status = 'published' AND (p.site_id = $2 OR p.site_id IS NULL)
        ORDER BY r.published_at DESC LIMIT 2`,
      [p.tenantId, siteId],
    );
    for (const r of procs) {
      out.push({
        kind: 'procedure',
        id: r.id,
        title: `${r.title} rev ${r.revision_no}`,
        freshness: iso(r.published_at),
        excerpt: String(r.safety_instructions ?? '').slice(0, 400),
        untrusted: false,
      });
    }
  }

  const { rows: wos } = await s.db.query(
    `SELECT id, display_number, title, state, closed_at, updated_at FROM maintenance.work_order
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 ORDER BY updated_at DESC LIMIT 10`,
    [p.tenantId, siteId, assetId],
  );
  for (const w of wos) {
    out.push({
      kind: 'work_order',
      id: w.id,
      title: `WO-${w.display_number} ${w.title}`,
      freshness: iso(w.closed_at ?? w.updated_at),
      excerpt: `state ${w.state}`,
      untrusted: false,
    });
  }

  const { rows: fails } = await s.db.query(
    `SELECT id, started_at, restored_at, classification, failure_code FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 ORDER BY started_at DESC LIMIT 5`,
    [p.tenantId, siteId, assetId],
  );
  for (const f of fails) {
    out.push({
      kind: 'failure',
      id: f.id,
      title: f.failure_code ?? f.classification,
      freshness: iso(f.restored_at ?? f.started_at),
      excerpt: `${f.classification} started ${iso(f.started_at)}`,
      untrusted: false,
    });
  }

  const { rows: incidents } = await s.db.query(
    `SELECT id, status, opened_at, correlation_group FROM maintenance.incident WHERE tenant_id = $1 AND asset_id = $2 ORDER BY opened_at DESC LIMIT 5`,
    [p.tenantId, assetId],
  ).catch(() => ({ rows: [] as Record<string, any>[] }));
  for (const i of incidents) {
    out.push({
      kind: 'incident',
      id: i.id,
      title: i.correlation_group,
      freshness: iso(i.opened_at),
      excerpt: `status ${i.status}`,
      untrusted: false,
    });
  }

  const { rows: docs } = await s.db.query(
    `SELECT id, file_name, media_type, storage_key FROM maintenance.attachment
      WHERE tenant_id = $1 AND owner_type = 'asset_document' AND owner_id = $2 AND status = 'available' LIMIT 10`,
    [p.tenantId, assetId],
  );
  for (const d of docs) {
    let excerpt = `Attached document ${d.file_name}`;
    let stripped = 0;
    if (d.media_type === 'text/plain' || d.media_type === 'text/markdown') {
      try {
        const bytes = await buffer(await s.blobs.get(d.storage_key));
        const sanitized = sanitizeUntrustedText(bytes.toString('utf8'));
        excerpt = sanitized.text.slice(0, 400) || excerpt;
        stripped = sanitized.stripped_instructions;
      } catch {
        excerpt = `Attached document ${d.file_name} (bytes unavailable)`;
      }
    }
    out.push({
      kind: 'document',
      id: d.id,
      title: d.file_name,
      freshness: null,
      excerpt: stripped ? `${excerpt} [untrusted document; ${stripped} instruction-like line(s) ignored]` : excerpt,
      untrusted: true,
    });
  }

  try {
    const { rows: routes } = await s.db.query(
      `SELECT signal_key, last_observed_at, freshness_seconds FROM integration.signal_route
        WHERE tenant_id = $1 AND asset_id = $2 AND status = 'active' LIMIT 20`,
      [p.tenantId, assetId],
    );
    const now = s.clock.now();
    for (const r of routes) {
      const last = r.last_observed_at as Date | null;
      const stale = !last || now.getTime() - last.getTime() > Number(r.freshness_seconds) * 1000;
      out.push({
        kind: 'signal',
        id: r.signal_key,
        title: r.signal_key,
        freshness: iso(last),
        excerpt: stale ? 'stale or unavailable' : 'last receipt within freshness',
        untrusted: false,
      });
    }
  } catch {
    // integration schema may be absent in isolated unit fixtures
  }

  const { rows: metrics } = await s.db.query(
    `SELECT count(*)::int AS failures FROM maintenance.failure_event
      WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND classification = 'unplanned_failure' AND validated`,
    [p.tenantId, siteId, assetId],
  );
  out.push({
    kind: 'metric',
    id: assetId,
    title: 'failure_count',
    freshness: iso(s.clock.now()),
    excerpt: `${metrics[0]?.failures ?? 0} validated unplanned failures on record`,
    untrusted: false,
  });

  void query;
  return out;
}

export async function askNeo(s: Services, actor: Actor, input: z.infer<typeof neoAskRequest>) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.neo.use', input.site_id);
  await s.entitlements.require(p.tenantId, 'neo.assist');
  if (s.config.neoInferencePolicy === 'disabled') throw conflict('neo_disabled', 'Neo inference is disabled on this installation');
  const asset = input.asset_id ? await resolveAsset(s, actor, input.asset_id) : null;
  if (asset && asset.site_id !== input.site_id) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  const now = s.clock.now();
  const evidence = await gatherEvidence(s, actor, input.site_id, asset?.asset_id ?? null, input.query);
  const synthesis = synthesize(input.query, evidence);
  if (s.config.neoInferencePolicy === 'private_only') {
    synthesis.missing_evidence = [
      ...synthesis.missing_evidence,
      'Cloud inference is disabled under the private-only policy. This answer is retrieval-only and did not call a remote model.',
    ];
  } else if (s.config.neoInferencePolicy === 'cloud_permitted') {
    synthesis.missing_evidence = [
      ...synthesis.missing_evidence,
      'No qualified local or cloud model is configured. This answer is retrieval-only and did not call a remote model.',
    ];
  }
  const citations = evidence.map((e) => ({
    kind: e.kind,
    id: e.id,
    title: e.title,
    freshness: e.freshness,
    excerpt: e.excerpt,
    untrusted: e.untrusted,
  }));
  return withTransaction(s.db, async (tx) => {
    const runId = randomUUID();
    let recommendationId: string | null = null;
    let actionType: 'draft_request' | 'draft_work_order' | 'propose_checklist' | null = null;
    let outcome: 'answered' | 'abstained' | 'drafted' | 'refused' = synthesis.abstain ? 'abstained' : 'answered';
    const wantsDraft = input.draft_work_order || input.propose_checklist || input.draft_request;
    if (wantsDraft && !synthesis.abstain) {
      requirePermission(p, 'maintenance.neo.draft', input.site_id);
      recommendationId = randomUUID();
      outcome = 'drafted';
      if (input.draft_work_order) actionType = 'draft_work_order';
      else if (input.propose_checklist) actionType = 'propose_checklist';
      else actionType = 'draft_request';
    }
    await tx.query(
      `INSERT INTO maintenance.agent_run
         (id, tenant_id, site_id, asset_id, actor_id, trigger, query, inference_policy, runtime, model_version, prompt_version,
          evidence, observations, possible_causes, recommended_checks, citations, missing_evidence, proposed_action_id, outcome, created_at)
       VALUES ($1,$2,$3,$4,$5,'user_query',$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17)`,
      [
        runId, p.tenantId, input.site_id, asset?.asset_id ?? null, p.userId, input.query, s.config.neoInferencePolicy, RUNTIME, promptVersion(),
        JSON.stringify(citations), synthesis.observations, JSON.stringify(synthesis.possible_causes), JSON.stringify(synthesis.recommended_checks),
        JSON.stringify(citations), JSON.stringify(synthesis.missing_evidence), outcome, now,
      ],
    );
    if (recommendationId && actionType) {
      let payload: Record<string, unknown>;
      if (actionType === 'draft_request') {
        if (!asset) throw invalid('draft_request requires an asset', { asset_id: ['Required'] });
        payload = {
          site_id: input.site_id,
          asset_id: asset.asset_id,
          description: `Neo draft from run ${runId}: ${input.query}`.slice(0, 5000),
          priority: 'normal',
          observed_at: now.toISOString(),
        };
      } else if (actionType === 'draft_work_order') {
        const { rows: teams } = await tx.query(
          `SELECT id FROM maintenance.team WHERE tenant_id = $1 AND site_id = $2 AND status = 'active' ORDER BY name LIMIT 1`,
          [p.tenantId, input.site_id],
        );
        if (!teams[0]) throw invalid('draft_work_order requires an active team at the site', { team_id: ['No active team'] });
        const procedureCitation = citations.find((c) => c.kind === 'procedure');
        payload = {
          site_id: input.site_id,
          asset_id: asset?.asset_id ?? null,
          title: input.query.slice(0, 200),
          scope: `Neo proposed work from run ${runId}: ${input.query}`.slice(0, 5000),
          priority: 'normal',
          team_id: teams[0].id,
          procedure_revision_id: procedureCitation?.id ?? null,
          type: 'corrective',
        };
      } else {
        const steps = (synthesis.recommended_checks.length ? synthesis.recommended_checks : ['Confirm condition', 'Record findings']).map((label, i) => ({
          key: `step_${i + 1}`,
          label: String(label).slice(0, 200),
          type: 'pass_fail' as const,
          required: true,
        }));
        payload = {
          site_id: input.site_id,
          asset_id: asset?.asset_id ?? null,
          procedure_id: null,
          title: `Proposed checklist: ${input.query}`.slice(0, 200),
          safety_instructions: 'Review and adapt site PPE / LOTO before publishing.',
          steps,
          rationale: `Neo checklist proposal from run ${runId}. Not published; supervisor must review.`.slice(0, 4000),
        };
      }
      assertToolAllowed(actionType);
      await tx.query(
        `INSERT INTO maintenance.recommendation
           (id, tenant_id, site_id, run_id, action_type, action_payload, status, proposed_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
        [recommendationId, p.tenantId, input.site_id, runId, actionType, JSON.stringify(payload), p.userId, now],
      );
      await tx.query(`UPDATE maintenance.agent_run SET proposed_action_id = $2 WHERE id = $1`, [runId, recommendationId]);
    }
    await writeAudit(tx, actor, {
      siteId: input.site_id,
      action: 'neo.run',
      targetType: 'agent_run',
      targetId: runId,
      detail: { outcome, evidence: citations.length, draft: Boolean(recommendationId), action_type: actionType },
    });
    const { rows } = await tx.query(`SELECT * FROM maintenance.agent_run WHERE id = $1`, [runId]);
    return {
      ...runDto(rows[0]),
      recommendation: recommendationId && actionType
        ? { id: recommendationId, status: 'pending', action_type: actionType, action_version: 1 }
        : null,
    };
  });
}

export async function getNeoRun(s: Services, actor: Actor, id: string) {
  const { rows } = await s.db.query(`SELECT * FROM maintenance.agent_run WHERE tenant_id = $1 AND id::text = $2`, [actor.principal.tenantId, id]);
  const r = rows[0];
  if (!r || (!can(actor.principal, 'maintenance.view', r.site_id) && !can(actor.principal, 'maintenance.neo.use', r.site_id))) {
    throw notFound('Neo run');
  }
  return runDto(r);
}

export async function listRecommendations(s: Services, actor: Actor, q: { site_id?: string; status?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.recommendation.decide').concat(sitesWith(actor.principal, 'maintenance.neo.use'));
  const scoped = [...new Set(sites)].filter((x) => !q.site_id || x === q.site_id);
  if (!scoped.length) return [];
  const params: unknown[] = [actor.principal.tenantId, scoped];
  let where = 'tenant_id = $1 AND site_id = ANY($2::uuid[])';
  if (q.status) where += ` AND status = $${params.push(q.status)}`;
  const { rows } = await s.db.query(`SELECT * FROM maintenance.recommendation WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
  return rows.map((r) => ({
    id: r.id,
    site_id: r.site_id,
    run_id: r.run_id,
    action_type: r.action_type,
    action_payload: r.action_payload,
    action_version: r.action_version,
    status: r.status,
    proposed_by: r.proposed_by,
    decided_by: r.decided_by,
    decided_at: iso(r.decided_at),
    created_at: iso(r.created_at),
  }));
}

/** Bound approval: the exact action version must still be pending, and the proposer cannot approve it. */
export async function decideRecommendation(s: Services, actor: Actor, id: string, input: z.infer<typeof recommendationDecisionRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.recommendation WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, id]);
    const rec = rows[0];
    if (!rec || !can(p, 'maintenance.view', rec.site_id)) throw notFound('Recommendation');
    requirePermission(p, 'maintenance.recommendation.decide', rec.site_id);
    if (rec.proposed_by === p.userId) throw forbidden('The proposer cannot approve or reject their own Neo recommendation');
    if (rec.status !== 'pending') throw conflict('invalid_state', `Recommendation is ${rec.status}`);
    if (rec.action_version !== input.action_version) throw staleVersion(rec.action_version);
    const now = s.clock.now();
    let requestId: string | null = null;
    let workOrderId: string | null = null;
    let checklistProposal: Record<string, unknown> | null = null;
    if (input.decision === 'approve') {
      const actionType = rec.action_type as 'draft_request' | 'draft_work_order' | 'propose_checklist';
      switch (actionType) {
        case 'draft_request': {
          const payload = rec.action_payload as {
            site_id: string;
            asset_id: string | null;
            description: string;
            priority: 'critical' | 'high' | 'normal' | 'low';
            observed_at: string;
          };
          const asset = payload.asset_id ? await resolveAsset(s, actor, payload.asset_id) : null;
          const req = await insertRequest(tx, s, actor, {
            siteId: rec.site_id,
            origin: 'neo',
            reporterId: rec.proposed_by,
            asset,
            locationText: asset?.location ?? null,
            description: payload.description,
            observedAt: new Date(payload.observed_at),
            priority: payload.priority,
            reading: null,
            voiceTranscript: null,
            sourceRef: { recommendation_id: rec.id, run_id: rec.run_id },
            clientRequestId: `neo:${rec.id}`,
          });
          requestId = req.id;
          break;
        }
        case 'draft_work_order': {
          const payload = rec.action_payload as {
            site_id: string;
            asset_id: string | null;
            title: string;
            scope: string;
            priority: 'critical' | 'high' | 'normal' | 'low';
            team_id: string;
            procedure_revision_id: string | null;
            type: 'corrective' | 'preventive' | 'inspection' | 'follow_up';
          };
          const asset = payload.asset_id ? await resolveAsset(s, actor, payload.asset_id) : null;
          requirePermission(p, 'maintenance.work_order.create', rec.site_id);
          await s.entitlements.require(p.tenantId, 'core.create_work');
          const wo = await insertWorkOrder(tx, s, actor, {
            siteId: rec.site_id,
            type: payload.type,
            priority: payload.priority,
            title: payload.title,
            description: `Approved Neo draft (${rec.id})`,
            scope: payload.scope,
            asset,
            nonAssetCategory: asset ? null : 'general',
            nonAssetJustification: asset ? null : 'Neo draft without a registered asset',
            locationText: null,
            teamId: payload.team_id,
            assigneeId: null,
            plannedStart: null,
            plannedEnd: null,
            dueAt: null,
            procedureRevisionId: payload.procedure_revision_id,
            safetyInstructions: null,
            sourceRequestId: null,
            planOccurrenceId: null,
            followUpOfId: null,
            initialState: 'draft',
            creationReason: `neo_recommendation:${rec.id}`,
          });
          workOrderId = wo.id as string;
          break;
        }
        case 'propose_checklist': {
          // Review-only: approving records the decision. It never publishes a procedure.
          checklistProposal = rec.action_payload as Record<string, unknown>;
          break;
        }
        default: {
          const _never: never = actionType;
          throw invalid(`Unsupported Neo action ${_never}`);
        }
      }
    }
    const { rows: updated } = await tx.query(
      `UPDATE maintenance.recommendation SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5, resulting_request_id = $6 WHERE id = $1 RETURNING *`,
      [rec.id, input.decision === 'approve' ? 'approved' : 'rejected', p.userId, now, input.reason, requestId],
    );
    await enqueueEvent(tx, actor, {
      siteId: rec.site_id,
      type: 'maintenance.recommendation.decided',
      aggregateType: 'recommendation',
      aggregateId: rec.id,
      aggregateVersion: rec.action_version,
      occurredAt: now,
      payload: {
        recommendation_id: rec.id,
        decision: input.decision,
        request_id: requestId,
        work_order_id: workOrderId,
        checklist_proposal: checklistProposal,
        run_id: rec.run_id,
        action_type: rec.action_type,
      },
    });
    await writeAudit(tx, actor, {
      siteId: rec.site_id,
      action: 'recommendation.decided',
      targetType: 'recommendation',
      targetId: rec.id,
      reason: input.reason,
      detail: { decision: input.decision, request_id: requestId, work_order_id: workOrderId, action_type: rec.action_type },
    });
    return {
      id: updated[0].id,
      status: updated[0].status,
      resulting_request_id: requestId,
      resulting_work_order_id: workOrderId,
      checklist_proposal: checklistProposal,
    };
  });
}

/** Used by tests: Neo never executes a tool that is not allowlisted. */
export function refuseUnauthorizedTool(name: string): never {
  assertToolAllowed(name);
  throw forbidden(`Neo cannot execute ${name}`);
}
