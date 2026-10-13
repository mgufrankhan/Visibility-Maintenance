import type { Queryable } from '@vm/db';
import type { AssetDto, SiteDto } from '@vm/contracts';
import { RegistryRequestError, RegistryUnavailableError } from '@vm/registry';
import { AppError, notFound } from '@vm/server-kit';
import type { AnyActor, Services } from './context.ts';
import { isSystem, tenantOf } from './context.ts';

export interface AssetIdentity {
  asset_id: string;
  site_id: string;
  parent_id: string | null;
  code: string;
  name: string;
  asset_type: string;
  location: string | null;
  lifecycle: AssetDto['lifecycle'];
  qr_token: string;
  version: number;
  /** True when served from the local snapshot because the registry was unreachable. */
  from_snapshot: boolean;
  fetched_at: string;
}

export class RegistryOutageError extends AppError {
  constructor() {
    super(503, 'registry_unavailable', 'The asset registry is unavailable and no cached identity exists for this asset');
  }
}

async function upsertAssetSnapshot(db: Queryable, a: AssetDto): Promise<void> {
  await db.query(
    `INSERT INTO maintenance.asset_snapshot
       (tenant_id, asset_id, site_id, parent_id, code, name, asset_type, location, lifecycle, qr_token, version, change_seq, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (tenant_id, asset_id) DO UPDATE SET
       site_id = EXCLUDED.site_id, parent_id = EXCLUDED.parent_id, code = EXCLUDED.code, name = EXCLUDED.name,
       asset_type = EXCLUDED.asset_type, location = EXCLUDED.location, lifecycle = EXCLUDED.lifecycle,
       qr_token = EXCLUDED.qr_token, version = EXCLUDED.version, change_seq = EXCLUDED.change_seq, fetched_at = now()
     WHERE maintenance.asset_snapshot.version <= EXCLUDED.version`,
    [a.tenant_id, a.id, a.site_id, a.parent_id, a.code, a.name, a.asset_type, a.location, a.lifecycle, a.qr_token, a.version, a.change_seq],
  );
}

function fromDto(a: AssetDto, fromSnapshot: boolean, fetchedAt: Date): AssetIdentity {
  return {
    asset_id: a.id,
    site_id: a.site_id,
    parent_id: a.parent_id,
    code: a.code,
    name: a.name,
    asset_type: a.asset_type,
    location: a.location,
    lifecycle: a.lifecycle,
    qr_token: a.qr_token,
    version: a.version,
    from_snapshot: fromSnapshot,
    fetched_at: fetchedAt.toISOString(),
  };
}

async function readSnapshot(db: Queryable, tenantId: string, assetId: string): Promise<AssetIdentity | null> {
  const { rows } = await db.query(`SELECT * FROM maintenance.asset_snapshot WHERE tenant_id = $1 AND asset_id = $2`, [tenantId, assetId]);
  const r = rows[0];
  if (!r) return null;
  return {
    asset_id: r.asset_id,
    site_id: r.site_id,
    parent_id: r.parent_id,
    code: r.code,
    name: r.name,
    asset_type: r.asset_type,
    location: r.location,
    lifecycle: r.lifecycle,
    qr_token: r.qr_token,
    version: r.version,
    from_snapshot: true,
    fetched_at: (r.fetched_at as Date).toISOString(),
  };
}

async function tokenFor(s: Services, actor: AnyActor): Promise<string> {
  return isSystem(actor) ? s.systemToken(actor.tenantId) : actor.token;
}

/**
 * Resolves a canonical asset through the registry boundary using the caller's
 * own identity, so registry scoping applies. Cross-tenant or unauthorized IDs
 * resolve to not-found (MA-01). During a registry outage, an existing versioned
 * snapshot keeps already-authorized work moving (MA-08).
 */
export async function resolveAsset(s: Services, actor: AnyActor, assetId: string): Promise<AssetIdentity> {
  const tenantId = tenantOf(actor);
  try {
    const a = await s.registry.getAsset(await tokenFor(s, actor), assetId);
    if (!a || a.tenant_id !== tenantId) throw notFound('Asset');
    await upsertAssetSnapshot(s.db, a);
    return fromDto(a, false, s.clock.now());
  } catch (err) {
    if (err instanceof RegistryUnavailableError) {
      const snap = await readSnapshot(s.db, tenantId, assetId);
      if (!snap) throw new RegistryOutageError();
      if (!isSystem(actor) && !actor.principal.memberSiteIds.includes(snap.site_id)) throw notFound('Asset');
      return snap;
    }
    if (err instanceof RegistryRequestError && (err.status === 403 || err.status === 404)) throw notFound('Asset');
    throw err;
  }
}

/** New work and schedule generation are blocked on archived assets (MA-04). */
export function assertAssetAcceptsNewWork(a: AssetIdentity): void {
  if (a.lifecycle !== 'active') {
    throw new AppError(409, 'asset_not_active', `Asset ${a.code} is ${a.lifecycle}; reactivate it before creating new work`);
  }
}

export function identitySnapshot(a: AssetIdentity): Record<string, unknown> {
  return { asset_id: a.asset_id, code: a.code, name: a.name, location: a.location, site_id: a.site_id, registry_version: a.version, captured_at: a.fetched_at };
}

export async function snapshotsFor(db: Queryable, tenantId: string, assetIds: string[]): Promise<Map<string, AssetIdentity>> {
  if (assetIds.length === 0) return new Map();
  const { rows } = await db.query(`SELECT * FROM maintenance.asset_snapshot WHERE tenant_id = $1 AND asset_id = ANY($2::uuid[])`, [tenantId, assetIds]);
  return new Map(
    rows.map((r) => [
      r.asset_id,
      { asset_id: r.asset_id, site_id: r.site_id, parent_id: r.parent_id, code: r.code, name: r.name, asset_type: r.asset_type, location: r.location, lifecycle: r.lifecycle, qr_token: r.qr_token, version: r.version, from_snapshot: true, fetched_at: (r.fetched_at as Date).toISOString() },
    ]),
  );
}

export interface SiteInfo {
  site_id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
}

async function upsertSite(db: Queryable, tenantId: string, site: SiteDto): Promise<void> {
  await db.query(
    `INSERT INTO maintenance.site_snapshot (tenant_id, site_id, code, name, timezone, status, version, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (tenant_id, site_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, timezone = EXCLUDED.timezone,
       status = EXCLUDED.status, version = EXCLUDED.version, fetched_at = now()`,
    [tenantId, site.id, site.code, site.name, site.timezone, site.status, site.version],
  );
}

export async function siteInfo(s: Services, actor: AnyActor, siteId: string): Promise<SiteInfo> {
  const tenantId = tenantOf(actor);
  const { rows } = await s.db.query(`SELECT * FROM maintenance.site_snapshot WHERE tenant_id = $1 AND site_id = $2`, [tenantId, siteId]);
  if (rows[0]) return { site_id: rows[0].site_id, code: rows[0].code, name: rows[0].name, timezone: rows[0].timezone, status: rows[0].status };
  const site = await s.registry.getSite(await tokenFor(s, actor), siteId).catch((err) => {
    if (err instanceof RegistryUnavailableError) throw new RegistryOutageError();
    throw err;
  });
  if (!site || site.tenant_id !== tenantId) throw notFound('Site');
  await upsertSite(s.db, tenantId, site);
  return { site_id: site.id, code: site.code, name: site.name, timezone: site.timezone, status: site.status };
}

/**
 * Pulls registry changes into local snapshots so renames and moves appear
 * without manual reconciliation (MA-03). Run by the worker under the tenant's
 * system service identity.
 */
export async function syncRegistry(s: Services, tenantId: string): Promise<{ assets: number; sites: number }> {
  const token = await s.systemToken(tenantId);
  const sites = await s.registry.listSites(token);
  for (const site of sites) await upsertSite(s.db, tenantId, site);
  const key = `registry_cursor:${tenantId}`;
  const { rows } = await s.db.query<{ value: string }>(`SELECT value #>> '{}' AS value FROM maintenance.installation_state WHERE key = $1`, [key]);
  let cursor = rows[0]?.value ?? '0';
  let count = 0;
  for (;;) {
    const page = await s.registry.changes(token, cursor, 200);
    for (const a of page.items) if (a.tenant_id === tenantId) await upsertAssetSnapshot(s.db, a);
    count += page.items.length;
    if (page.last_seq === cursor || page.items.length === 0) break;
    cursor = page.last_seq;
    await s.db.query(
      `INSERT INTO maintenance.installation_state (key, value) VALUES ($1, to_jsonb($2::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, cursor],
    );
  }
  return { assets: count, sites: sites.length };
}
