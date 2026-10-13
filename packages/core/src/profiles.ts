import { randomUUID } from 'node:crypto';
import { withTransaction } from '@vm/db';
import type { AssetDto } from '@vm/contracts';
import { upsertProfileRequest } from '@vm/contracts';
import { can, sitesWith } from '@vm/policy';
import { limitAllows } from '@vm/licensing';
import { RegistryUnavailableError } from '@vm/registry';
import { AppError, invalid, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import type { Actor, Services } from './context.ts';
import { requirePermission, requireVisible } from './access.ts';
import { resolveAsset, type AssetIdentity } from './identity-snapshots.ts';
import { writeAudit } from './records.ts';

export interface AssetProfileView {
  asset: Omit<AssetIdentity, 'from_snapshot' | 'fetched_at'> & { id: string };
  identity_source: 'registry' | 'snapshot';
  identity_fetched_at: string;
  profile: Record<string, unknown> | null;
}

function profileRow(r: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!r) return null;
  return {
    id: r.id,
    maintainable: r.maintainable,
    criticality: r.criticality,
    team_id: r.team_id,
    warranty_reference: r.warranty_reference,
    service_interval_defaults: r.service_interval_defaults,
    failure_taxonomy: r.failure_taxonomy,
    document_links: r.document_links,
    version: r.version,
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

function viewOf(a: AssetIdentity, profile: Record<string, unknown> | undefined): AssetProfileView {
  const { from_snapshot, fetched_at, ...asset } = a;
  return {
    asset: { ...asset, id: a.asset_id },
    identity_source: from_snapshot ? 'snapshot' : 'registry',
    identity_fetched_at: fetched_at,
    profile: profileRow(profile),
  };
}

function dtoToIdentity(a: AssetDto, fetchedAt: string): AssetIdentity {
  return { asset_id: a.id, site_id: a.site_id, parent_id: a.parent_id, code: a.code, name: a.name, asset_type: a.asset_type, location: a.location, lifecycle: a.lifecycle, qr_token: a.qr_token, version: a.version, from_snapshot: false, fetched_at: fetchedAt };
}

export async function listAssetProfiles(
  s: Services,
  actor: Actor,
  q: { site_id?: string; q?: string; lifecycle?: string; cursor?: string; limit: number },
): Promise<{ items: AssetProfileView[]; next_cursor: string | null; identity_source: 'registry' | 'snapshot' }> {
  const p = actor.principal;
  const sites = sitesWith(p, 'maintenance.view').filter((sid) => !q.site_id || sid === q.site_id);
  if (sites.length === 0) return { items: [], next_cursor: null, identity_source: 'registry' };
  let identities: AssetIdentity[];
  let next: string | null = null;
  let source: 'registry' | 'snapshot' = 'registry';
  try {
    const page = await s.registry.listAssets(actor.token, { site_id: q.site_id, q: q.q, lifecycle: q.lifecycle, cursor: q.cursor, limit: q.limit });
    const now = s.clock.now().toISOString();
    identities = page.items.filter((a) => sites.includes(a.site_id)).map((a) => dtoToIdentity(a, now));
    next = page.next_cursor;
  } catch (err) {
    if (!(err instanceof RegistryUnavailableError)) throw err;
    source = 'snapshot';
    const { rows } = await s.db.query(
      `SELECT * FROM maintenance.asset_snapshot WHERE tenant_id = $1 AND site_id = ANY($2::uuid[])
         AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR code ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR lifecycle = $4)
       ORDER BY code, asset_id LIMIT $5`,
      [p.tenantId, sites, q.q ?? null, q.lifecycle ?? null, q.limit],
    );
    identities = rows.map((r) => ({ ...r, from_snapshot: true, fetched_at: (r.fetched_at as Date).toISOString() }) as AssetIdentity);
  }
  const ids = identities.map((a) => a.asset_id);
  const { rows: profiles } = await s.db.query(`SELECT * FROM maintenance.profile WHERE tenant_id = $1 AND asset_id = ANY($2::uuid[])`, [p.tenantId, ids]);
  const byAsset = new Map(profiles.map((r) => [r.asset_id as string, r]));
  return { items: identities.map((a) => viewOf(a, byAsset.get(a.asset_id))), next_cursor: next, identity_source: source };
}

export async function getAssetProfile(s: Services, actor: Actor, assetId: string): Promise<AssetProfileView & { summary: Record<string, number> }> {
  const asset = await resolveAsset(s, actor, assetId);
  requireVisible(actor.principal, 'maintenance.view', asset.site_id, 'Asset');
  const { rows } = await s.db.query(`SELECT * FROM maintenance.profile WHERE tenant_id = $1 AND asset_id = $2`, [actor.principal.tenantId, assetId]);
  // Work history is scoped by the site where the work happened, so a moved asset
  // does not expose previous-site records to users without access there (MA-05).
  const visibleSites = sitesWith(actor.principal, 'maintenance.view');
  const { rows: counts } = await s.db.query(
    `SELECT
       (SELECT count(*) FROM maintenance.work_order WHERE tenant_id = $1 AND asset_id = $2 AND site_id = ANY($3::uuid[])
          AND state NOT IN ('closed','cancelled')) AS open_work_orders,
       (SELECT count(*) FROM maintenance.work_order WHERE tenant_id = $1 AND asset_id = $2 AND site_id = ANY($3::uuid[])
          AND state = 'closed') AS closed_work_orders,
       (SELECT count(*) FROM maintenance.request WHERE tenant_id = $1 AND asset_id = $2 AND site_id = ANY($3::uuid[])
          AND state IN ('submitted','under_review')) AS open_requests`,
    [actor.principal.tenantId, assetId, visibleSites],
  );
  const c = counts[0]!;
  return {
    ...viewOf(asset, rows[0]),
    summary: { open_work_orders: Number(c.open_work_orders), closed_work_orders: Number(c.closed_work_orders), open_requests: Number(c.open_requests) },
  };
}

export async function upsertProfile(s: Services, actor: Actor, assetId: string, raw: z.infer<typeof upsertProfileRequest>) {
  const p = actor.principal;
  const asset = await resolveAsset(s, actor, assetId);
  requireVisible(p, 'maintenance.view', asset.site_id, 'Asset');
  requirePermission(p, 'maintenance.profile.manage', asset.site_id);
  if (raw.team_id) {
    const { rows } = await s.db.query(`SELECT site_id FROM maintenance.team WHERE tenant_id = $1 AND id = $2`, [p.tenantId, raw.team_id]);
    if (rows[0]?.site_id !== asset.site_id) throw invalid('Team must belong to the asset site', { team_id: ['Unknown team for this site'] });
  }
  if (raw.document_links.length > 0) {
    const ids = raw.document_links.map((d) => d.attachment_id);
    const { rows } = await s.db.query(
      `SELECT id FROM maintenance.attachment WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND site_id = $3 AND status = 'available'`,
      [p.tenantId, ids, asset.site_id],
    );
    if (rows.length !== new Set(ids).size) throw invalid('Document links must reference available attachments at this site');
  }
  const view = await s.entitlements.view(p.tenantId);
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.profile WHERE tenant_id = $1 AND asset_id = $2 FOR UPDATE`, [p.tenantId, assetId]);
    const existing = rows[0];
    const becomesMaintainable = raw.maintainable && !existing?.maintainable;
    if (becomesMaintainable && !limitAllows(view, 'maintainable_assets')) {
      throw new AppError(409, 'license_limit_reached', 'The licensed maintainable asset limit has been reached');
    }
    const values = [raw.maintainable, raw.criticality, raw.team_id, raw.warranty_reference, JSON.stringify(raw.service_interval_defaults), raw.failure_taxonomy, JSON.stringify(raw.document_links)];
    let row;
    if (existing) {
      if (raw.record_version !== undefined && raw.record_version !== existing.version) throw staleVersion(existing.version);
      if (raw.record_version === undefined) throw invalid('record_version is required to update an existing profile');
      ({ rows: [row] } = await tx.query(
        `UPDATE maintenance.profile SET maintainable = $3, criticality = $4, team_id = $5, warranty_reference = $6,
           service_interval_defaults = $7, failure_taxonomy = $8, document_links = $9, site_id = $10,
           version = version + 1, updated_at = now(), updated_by = $11
         WHERE tenant_id = $1 AND asset_id = $2 RETURNING *`,
        [p.tenantId, assetId, ...values, asset.site_id, p.userId],
      ));
    } else {
      ({ rows: [row] } = await tx.query(
        `INSERT INTO maintenance.profile (id, tenant_id, asset_id, maintainable, criticality, team_id, warranty_reference,
           service_interval_defaults, failure_taxonomy, document_links, site_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
        [randomUUID(), p.tenantId, assetId, ...values, asset.site_id, p.userId],
      ));
    }
    await writeAudit(tx, actor, {
      siteId: asset.site_id,
      action: existing ? 'profile.updated' : 'profile.created',
      targetType: 'asset_profile',
      targetId: assetId,
      beforeVersion: existing?.version ?? null,
      afterVersion: row.version,
    });
    s.entitlements.invalidate(p.tenantId);
    return viewOf(asset, row);
  });
}

export function canViewSite(actor: Actor, siteId: string): boolean {
  return can(actor.principal, 'maintenance.view', siteId);
}
