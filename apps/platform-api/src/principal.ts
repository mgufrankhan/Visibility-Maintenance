import type { Queryable } from '@vm/db';
import type { PlatformRole } from '@vm/contracts';
import { forbidden, unauthorized } from '@vm/server-kit';

export interface PlatformPrincipal {
  userId: string;
  tenantId: string;
  kind: 'human' | 'service';
  displayName: string;
  email: string | null;
  siteIds: string[];
  roles: Array<{ role: PlatformRole; siteId: string | null }>;
}

/** Platform authorizes against current database state, not only token claims. */
export async function loadPrincipal(db: Queryable, tenantId: string, userId: string): Promise<PlatformPrincipal> {
  const u = await db.query<{ id: string; tenant_id: string; kind: 'human' | 'service'; display_name: string; email: string | null; status: string }>(
    `SELECT u.id, u.tenant_id, u.kind, u.display_name, u.email, u.status
       FROM platform.user_account u JOIN platform.tenant t ON t.id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.id = $2 AND t.status = 'active'`,
    [tenantId, userId],
  );
  const user = u.rows[0];
  if (!user || user.status !== 'active') throw unauthorized('Account is not active');
  const sites = await db.query<{ site_id: string }>(
    `SELECT m.site_id FROM platform.site_membership m JOIN platform.site s ON s.id = m.site_id
      WHERE m.tenant_id = $1 AND m.user_id = $2 AND s.status = 'active' ORDER BY m.site_id`,
    [tenantId, userId],
  );
  const roles = await db.query<{ role: PlatformRole; site_id: string | null }>(
    `SELECT role, site_id FROM platform.platform_role WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return {
    userId: user.id,
    tenantId: user.tenant_id,
    kind: user.kind,
    displayName: user.display_name,
    email: user.email,
    siteIds: sites.rows.map((r) => r.site_id),
    roles: roles.rows.map((r) => ({ role: r.role, siteId: r.site_id })),
  };
}

export function hasRole(p: PlatformPrincipal, role: PlatformRole, siteId: string | null): boolean {
  return p.roles.some((r) => r.role === role && (r.siteId === null || r.siteId === siteId));
}

export function isTenantAdmin(p: PlatformPrincipal): boolean {
  return p.roles.some((r) => r.role === 'platform_admin' && r.siteId === null);
}

export function canReadSite(p: PlatformPrincipal, siteId: string): boolean {
  return p.siteIds.includes(siteId) || isTenantAdmin(p);
}

export function readableSites(p: PlatformPrincipal, allTenantSites: string[]): string[] {
  return isTenantAdmin(p) ? allTenantSites : p.siteIds;
}

export function canEditAssets(p: PlatformPrincipal, siteId: string): boolean {
  return canReadSite(p, siteId) && (hasRole(p, 'platform_admin', siteId) || hasRole(p, 'asset_admin', siteId));
}

export function canManageMappings(p: PlatformPrincipal, siteId: string): boolean {
  return canReadSite(p, siteId) && (hasRole(p, 'platform_admin', siteId) || hasRole(p, 'mapping_admin', siteId));
}

export function requireTenantAdmin(p: PlatformPrincipal): void {
  if (!isTenantAdmin(p)) throw forbidden();
}
