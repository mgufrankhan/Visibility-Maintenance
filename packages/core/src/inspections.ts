import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import type { CheckDefinition, createInspectionTemplateRequest, inspectionRevisionRequest, startInspectionRequest, submitInspectionRequest } from '@vm/contracts';
import { can, canTenantWide, sitesWith } from '@vm/policy';
import { conflict, forbidden, invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import { evaluateCheck } from './checks.ts';
import type { Actor, Services } from './context.ts';
import { identitySnapshot, resolveAsset } from './identity-snapshots.ts';
import { enqueueEvent, iso, writeAudit } from './records.ts';
import { insertRequest } from './requests.ts';

function canManage(actor: Actor, siteId: string | null): boolean {
  return siteId ? can(actor.principal, 'maintenance.inspection.manage', siteId) : canTenantWide(actor.principal, 'maintenance.inspection.manage');
}

function canRead(actor: Actor, siteId: string | null): boolean {
  return siteId ? can(actor.principal, 'maintenance.view', siteId) : sitesWith(actor.principal, 'maintenance.view').length > 0;
}

async function loadTemplate(db: Queryable, actor: Actor, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM maintenance.inspection_template WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const t = rows[0];
  if (!t || !canRead(actor, t.site_id)) throw notFound('Inspection template');
  return t;
}

export async function createInspectionTemplate(s: Services, actor: Actor, input: z.infer<typeof createInspectionTemplateRequest>) {
  if (!canManage(actor, input.site_id)) throw forbidden();
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    await tx.query(`INSERT INTO maintenance.inspection_template (id, tenant_id, site_id, title, asset_type, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, actor.principal.tenantId, input.site_id, input.title, input.asset_type, actor.principal.userId]);
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'inspection_template.created', targetType: 'inspection_template', targetId: id });
    return { id, site_id: input.site_id, title: input.title, asset_type: input.asset_type, status: 'active', revisions: [] };
  });
}

export async function addInspectionRevision(s: Services, actor: Actor, templateId: string, input: z.infer<typeof inspectionRevisionRequest>) {
  return withTransaction(s.db, async (tx) => {
    const t = await loadTemplate(tx, actor, templateId, true);
    if (!canManage(actor, t.site_id)) throw forbidden();
    const { rows: n } = await tx.query<{ next: number }>(`SELECT coalesce(max(revision_no), 0) + 1 AS next FROM maintenance.inspection_template_revision WHERE template_id = $1`, [t.id]);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO maintenance.inspection_template_revision (id, tenant_id, template_id, revision_no, instructions, checks, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.principal.tenantId, t.id, n[0]!.next, input.instructions, JSON.stringify(input.checks), actor.principal.userId],
    );
    await writeAudit(tx, actor, { siteId: t.site_id, action: 'inspection_template.revision_drafted', targetType: 'inspection_template', targetId: t.id, detail: { revision_id: id } });
    return { id, template_id: t.id, revision_no: n[0]!.next, status: 'draft' };
  });
}

/** Publishes the latest draft revision; issued results keep the checks they were run against. */
export async function publishInspectionTemplate(s: Services, actor: Actor, templateId: string) {
  return withTransaction(s.db, async (tx) => {
    const t = await loadTemplate(tx, actor, templateId, true);
    if (!canManage(actor, t.site_id)) throw forbidden();
    const { rows } = await tx.query(`SELECT id, revision_no FROM maintenance.inspection_template_revision WHERE template_id = $1 AND status = 'draft' ORDER BY revision_no DESC LIMIT 1`, [t.id]);
    const draft = rows[0];
    if (!draft) throw conflict('no_draft_revision', 'There is no draft revision to publish');
    await tx.query(`UPDATE maintenance.inspection_template_revision SET status = 'superseded' WHERE template_id = $1 AND status = 'published'`, [t.id]);
    await tx.query(`UPDATE maintenance.inspection_template_revision SET status = 'published', published_by = $2, published_at = $3 WHERE id = $1`, [draft.id, actor.principal.userId, s.clock.now()]);
    await writeAudit(tx, actor, { siteId: t.site_id, action: 'inspection_template.published', targetType: 'inspection_template', targetId: t.id, detail: { revision_id: draft.id, revision_no: draft.revision_no } });
    return { id: draft.id, template_id: t.id, revision_no: draft.revision_no, status: 'published' };
  });
}

export async function listInspectionTemplates(s: Services, actor: Actor, siteId?: string) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !siteId || x === siteId);
  if (!sites.length) return [];
  const { rows } = await s.db.query(
    `SELECT t.*, r.id AS revision_id, r.revision_no, r.instructions, r.checks
       FROM maintenance.inspection_template t
       LEFT JOIN maintenance.inspection_template_revision r ON r.template_id = t.id AND r.status = 'published'
      WHERE t.tenant_id = $1 AND (t.site_id IS NULL OR t.site_id = ANY($2::uuid[])) ORDER BY t.title`,
    [actor.principal.tenantId, sites],
  );
  return rows.map((r) => ({
    id: r.id,
    site_id: r.site_id,
    title: r.title,
    asset_type: r.asset_type,
    status: r.status,
    published_revision: r.revision_id ? { id: r.revision_id, revision_no: r.revision_no, instructions: r.instructions, checks: r.checks as CheckDefinition[] } : null,
  }));
}

function resultDto(r: Record<string, any>) {
  return {
    id: r.id,
    site_id: r.site_id,
    template_revision_id: r.template_revision_id,
    checks: r.checks_snapshot as CheckDefinition[],
    asset_id: r.asset_id,
    asset_snapshot: r.asset_snapshot,
    work_order_id: r.work_order_id,
    status: r.status,
    submitted_by: r.submitted_by,
    client_submission_id: r.client_submission_id,
    started_at: iso(r.started_at),
    observed_at: iso(r.observed_at),
    submitted_at: iso(r.submitted_at),
    values: r.values,
    evaluation: r.evaluation,
    passed: r.passed,
    request_id: r.request_id,
    version: r.version,
  };
}

/** Starting creates the result record so evidence can be attached before submission. Repeats reuse it. */
export async function startInspection(s: Services, actor: Actor, input: z.infer<typeof startInspectionRequest>) {
  const p = actor.principal;
  const asset = await resolveAsset(s, actor, input.asset_id);
  requirePermission(p, 'maintenance.inspection.execute', asset.site_id);
  await s.entitlements.require(p.tenantId, 'core.inspect');
  return withTransaction(s.db, async (tx) => {
    const { rows: existing } = await tx.query(`SELECT * FROM maintenance.inspection_result WHERE tenant_id = $1 AND submitted_by = $2 AND client_submission_id = $3`, [p.tenantId, p.userId, input.client_submission_id]);
    if (existing[0]) return { status: 200, body: resultDto(existing[0]) };
    const { rows: revs } = await tx.query(
      `SELECT r.*, t.site_id, t.asset_type FROM maintenance.inspection_template_revision r JOIN maintenance.inspection_template t ON t.id = r.template_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [p.tenantId, input.template_revision_id],
    );
    const rev = revs[0];
    if (!rev || (rev.site_id !== null && rev.site_id !== asset.site_id)) throw invalid('Inspection template not available at this site', { template_revision_id: ['Unknown template revision'] });
    if (rev.status !== 'published') throw invalid('Only published inspection revisions can be run', { template_revision_id: [`Revision is ${rev.status}`] });
    if (rev.asset_type && rev.asset_type !== asset.asset_type) throw invalid(`This template applies to ${rev.asset_type} assets`, { asset_id: ['Asset type does not match the template'] });
    if (asset.lifecycle !== 'active') throw conflict('asset_not_active', `Asset ${asset.code} is ${asset.lifecycle}`);
    if (input.work_order_id) {
      const { rows } = await tx.query(`SELECT site_id, asset_id, state FROM maintenance.work_order WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.work_order_id]);
      if (rows[0]?.site_id !== asset.site_id || rows[0]?.asset_id !== asset.asset_id) throw invalid('Work order does not match this asset', { work_order_id: ['Unknown work order'] });
    }
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.inspection_result (id, tenant_id, site_id, template_revision_id, checks_snapshot, asset_id, asset_snapshot, work_order_id, submitted_by, client_submission_id, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, p.tenantId, asset.site_id, rev.id, JSON.stringify(rev.checks), asset.asset_id, JSON.stringify(identitySnapshot(asset)), input.work_order_id, p.userId, input.client_submission_id, s.clock.now()],
    );
    return { status: 201, body: resultDto(rows[0]) };
  });
}

/**
 * MP-06: evaluates typed checks; a failed required check creates exactly one
 * reviewable request linked to the result. Re-submitting returns the stored
 * outcome and never creates another request.
 */
export async function submitInspection(s: Services, actor: Actor, resultId: string, input: z.infer<typeof submitInspectionRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.inspection_result WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, resultId]);
    const r = rows[0];
    if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Inspection result');
    if (r.submitted_by !== p.userId) throw forbidden('Only the inspector who started this inspection can submit it');
    if (r.status === 'submitted') return { ...resultDto(r), replayed: true };
    requirePermission(p, 'maintenance.inspection.execute', r.site_id);
    await s.entitlements.require(p.tenantId, 'core.inspect');

    const checks = r.checks_snapshot as CheckDefinition[];
    const { rows: att } = await tx.query(`SELECT id FROM maintenance.attachment WHERE tenant_id = $1 AND owner_type = 'inspection_result' AND owner_id = $2 AND status = 'available'`, [p.tenantId, r.id]);
    const available = new Set(att.map((a) => a.id as string));
    const byKey = new Map(input.values.map((v) => [v.key, v]));
    const errors: Record<string, string[]> = {};
    for (const key of byKey.keys()) if (!checks.some((c) => c.key === key)) errors[`values.${key}`] = ['Check is not part of this inspection revision'];
    const evaluation: Array<{ key: string; label: string; passed: boolean | null; safety_critical: boolean }> = [];
    for (const def of checks) {
      const v = byKey.get(def.key);
      if (!v) {
        if (def.required) errors[`values.${def.key}`] = ['Required'];
        continue;
      }
      const e = evaluateCheck(def, v, available);
      if (e.error) errors[`values.${def.key}`] = [e.error];
      else if (def.evidence_required && v.attachment_ids.length === 0) errors[`values.${def.key}`] = ['Evidence is required for this check'];
      evaluation.push({ key: def.key, label: def.label, passed: e.passed, safety_critical: def.safety_critical });
    }
    if (Object.keys(errors).length) throw invalid('Some inspection values are invalid or missing', errors);

    const failed = evaluation.filter((e) => e.passed === false && checks.find((c) => c.key === e.key)!.required);
    const passed = failed.length === 0;
    const observedAt = new Date(input.observed_at);
    let requestId: string | null = null;
    if (!passed) {
      const asset = await resolveAsset(s, actor, r.asset_id);
      const summary = failed.map((f) => {
        const v = byKey.get(f.key)!;
        return `${f.label}: ${v.value === false ? 'fail' : `${String(v.value)}${v.unit ? ` ${v.unit}` : ''}`}`;
      });
      const req = await insertRequest(tx, s, actor, {
        siteId: r.site_id,
        origin: 'inspection',
        reporterId: p.userId,
        asset,
        locationText: null,
        description: `Inspection failed: ${summary.join('; ')}`,
        observedAt,
        priority: failed.some((f) => f.safety_critical) ? 'high' : 'normal',
        reading: null,
        voiceTranscript: null,
        sourceRef: { inspection_result_id: r.id, template_revision_id: r.template_revision_id, failed_checks: failed.map((f) => f.key) },
        clientRequestId: `inspection:${r.id}`,
      });
      requestId = req.id;
      await enqueueEvent(tx, actor, {
        siteId: r.site_id,
        type: 'maintenance.inspection.failed',
        aggregateType: 'inspection_result',
        aggregateId: r.id,
        aggregateVersion: r.version + 1,
        occurredAt: s.clock.now(),
        payload: { inspection_result_id: r.id, asset_id: r.asset_id, request_id: requestId, failed_checks: failed.map((f) => f.key), summary: summary.join('; ') },
      });
    }
    const { rows: updated } = await tx.query(
      `UPDATE maintenance.inspection_result SET status = 'submitted', observed_at = $2, submitted_at = $3, values = $4, evaluation = $5, passed = $6, request_id = $7, version = version + 1
        WHERE id = $1 RETURNING *`,
      [r.id, observedAt, s.clock.now(), JSON.stringify(input.values), JSON.stringify(evaluation), passed, requestId],
    );
    await writeAudit(tx, actor, { siteId: r.site_id, action: 'inspection.submitted', targetType: 'inspection_result', targetId: r.id, afterVersion: r.version + 1, detail: { passed, request_id: requestId } });
    return { ...resultDto(updated[0]), replayed: false };
  });
}

export async function getInspectionResult(s: Services, actor: Actor, id: string) {
  const { rows } = await s.db.query(`SELECT * FROM maintenance.inspection_result WHERE tenant_id = $1 AND id::text = $2`, [actor.principal.tenantId, id]);
  if (!rows[0] || !can(actor.principal, 'maintenance.view', rows[0].site_id)) throw notFound('Inspection result');
  return resultDto(rows[0]);
}

export async function listInspectionResults(s: Services, actor: Actor, q: { site_id?: string; asset_id?: string; passed?: boolean; limit: number }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
  if (q.asset_id) where.push(`asset_id::text = $${params.push(q.asset_id)}`);
  if (q.passed !== undefined) where.push(`passed = $${params.push(q.passed)}`);
  const { rows } = await s.db.query(`SELECT * FROM maintenance.inspection_result WHERE ${where.join(' AND ')} ORDER BY coalesce(submitted_at, started_at) DESC LIMIT ${q.limit}`, params);
  return rows.map(resultDto);
}
