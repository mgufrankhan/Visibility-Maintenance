import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import type { CheckDefinition, createProcedureRequest, procedureRevisionRequest } from '@vm/contracts';
import { can, canTenantWide, sitesWith } from '@vm/policy';
import { conflict, forbidden, invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import type { Actor, Services } from './context.ts';
import { iso, writeAudit } from './records.ts';

export interface ProcedureSnapshot {
  procedure_id: string;
  procedure_revision_id: string;
  revision_no: number;
  title: string;
  summary: string;
  safety_instructions: string;
  steps: CheckDefinition[];
  estimated_minutes: number | null;
  signature_required: boolean;
  published_at: string | null;
}

function canManage(actor: Actor, siteId: string | null): boolean {
  return siteId ? can(actor.principal, 'maintenance.procedure.manage', siteId) : canTenantWide(actor.principal, 'maintenance.procedure.manage');
}

function canRead(actor: Actor, siteId: string | null): boolean {
  return siteId ? can(actor.principal, 'maintenance.view', siteId) : sitesWith(actor.principal, 'maintenance.view').length > 0;
}

export async function createProcedure(s: Services, actor: Actor, input: z.infer<typeof createProcedureRequest>) {
  if (!canManage(actor, input.site_id)) throw forbidden();
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    await tx.query(`INSERT INTO maintenance.procedure (id, tenant_id, site_id, title, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, actor.principal.tenantId, input.site_id, input.title, actor.principal.userId]);
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'procedure.created', targetType: 'procedure', targetId: id });
    return { id, site_id: input.site_id, title: input.title, status: 'active', revisions: [] };
  });
}

async function loadProcedure(db: Queryable, tenantId: string, id: string) {
  const { rows } = await db.query(`SELECT * FROM maintenance.procedure WHERE tenant_id = $1 AND id::text = $2`, [tenantId, id]);
  return rows[0] ?? null;
}

export async function addProcedureRevision(s: Services, actor: Actor, procedureId: string, input: z.infer<typeof procedureRevisionRequest>) {
  return withTransaction(s.db, async (tx) => {
    const proc = await loadProcedure(tx, actor.principal.tenantId, procedureId);
    if (!proc || !canRead(actor, proc.site_id)) throw notFound('Procedure');
    if (!canManage(actor, proc.site_id)) throw forbidden();
    await tx.query(`SELECT 1 FROM maintenance.procedure WHERE id = $1 FOR UPDATE`, [proc.id]);
    const { rows: n } = await tx.query<{ next: number }>(`SELECT coalesce(max(revision_no), 0) + 1 AS next FROM maintenance.procedure_revision WHERE procedure_id = $1`, [proc.id]);
    const id = randomUUID();
    const revisionNo = n[0]!.next;
    await tx.query(
      `INSERT INTO maintenance.procedure_revision (id, tenant_id, procedure_id, revision_no, status, summary, safety_instructions, steps, estimated_minutes, signature_required, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10)`,
      [id, actor.principal.tenantId, proc.id, revisionNo, input.summary, input.safety_instructions, JSON.stringify(input.steps), input.estimated_minutes, input.signature_required, actor.principal.userId],
    );
    await writeAudit(tx, actor, { siteId: proc.site_id, action: 'procedure.revision_drafted', targetType: 'procedure_revision', targetId: id, detail: { revision_no: revisionNo } });
    return { id, procedure_id: proc.id, revision_no: revisionNo, status: 'draft' };
  });
}

export async function publishProcedureRevision(s: Services, actor: Actor, revisionId: string) {
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT r.*, p.site_id FROM maintenance.procedure_revision r JOIN maintenance.procedure p ON p.id = r.procedure_id
        WHERE r.tenant_id = $1 AND r.id::text = $2 FOR UPDATE OF r`,
      [actor.principal.tenantId, revisionId],
    );
    const rev = rows[0];
    if (!rev || !canRead(actor, rev.site_id)) throw notFound('Procedure revision');
    if (!canManage(actor, rev.site_id)) throw forbidden();
    if (rev.status !== 'draft') throw conflict('revision_not_draft', 'Only draft revisions can be published');
    await tx.query(`UPDATE maintenance.procedure_revision SET status = 'obsolete' WHERE procedure_id = $1 AND status = 'published'`, [rev.procedure_id]);
    await tx.query(`UPDATE maintenance.procedure_revision SET status = 'published', published_at = $2, published_by = $3 WHERE id = $1`, [rev.id, s.clock.now(), actor.principal.userId]);
    await writeAudit(tx, actor, { siteId: rev.site_id, action: 'procedure.revision_published', targetType: 'procedure_revision', targetId: rev.id, detail: { revision_no: rev.revision_no } });
    return { id: rev.id, procedure_id: rev.procedure_id, revision_no: rev.revision_no, status: 'published' };
  });
}

export async function listProcedures(s: Services, actor: Actor, siteId?: string) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !siteId || x === siteId);
  const { rows } = await s.db.query(
    `SELECT p.id, p.site_id, p.title, p.status,
            coalesce(json_agg(json_build_object('id', r.id, 'revision_no', r.revision_no, 'status', r.status, 'published_at', r.published_at)
                     ORDER BY r.revision_no) FILTER (WHERE r.id IS NOT NULL), '[]') AS revisions
       FROM maintenance.procedure p LEFT JOIN maintenance.procedure_revision r ON r.procedure_id = p.id
      WHERE p.tenant_id = $1 AND (p.site_id IS NULL OR p.site_id = ANY($2::uuid[]))
      GROUP BY p.id ORDER BY p.title, p.id`,
    [actor.principal.tenantId, sites],
  );
  return sites.length ? rows : [];
}

export async function getProcedureRevision(s: Services, actor: Actor, revisionId: string) {
  const { rows } = await s.db.query(
    `SELECT r.*, p.site_id, p.title FROM maintenance.procedure_revision r JOIN maintenance.procedure p ON p.id = r.procedure_id
      WHERE r.tenant_id = $1 AND r.id::text = $2`,
    [actor.principal.tenantId, revisionId],
  );
  const r = rows[0];
  if (!r || !canRead(actor, r.site_id)) throw notFound('Procedure revision');
  return { ...toSnapshot(r), status: r.status, site_id: r.site_id };
}

function toSnapshot(r: Record<string, any>): ProcedureSnapshot {
  return {
    procedure_id: r.procedure_id,
    procedure_revision_id: r.id,
    revision_no: r.revision_no,
    title: r.title,
    summary: r.summary,
    safety_instructions: r.safety_instructions,
    steps: r.steps,
    estimated_minutes: r.estimated_minutes,
    signature_required: r.signature_required === true,
    published_at: iso(r.published_at),
  };
}

/** Only published revisions applicable to the site may be issued with work. */
export async function issuableRevision(db: Queryable, tenantId: string, revisionId: string, siteId: string): Promise<ProcedureSnapshot> {
  const { rows } = await db.query(
    `SELECT r.*, p.site_id, p.title FROM maintenance.procedure_revision r JOIN maintenance.procedure p ON p.id = r.procedure_id
      WHERE r.tenant_id = $1 AND r.id = $2`,
    [tenantId, revisionId],
  );
  const r = rows[0];
  if (!r || (r.site_id !== null && r.site_id !== siteId)) throw invalid('Procedure revision not found for this site', { procedure_revision_id: ['Unknown procedure revision'] });
  if (r.status !== 'published') throw invalid('Only published procedure revisions can be issued', { procedure_revision_id: [`Revision is ${r.status}`] });
  return toSnapshot(r);
}
