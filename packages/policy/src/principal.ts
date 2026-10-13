import type { MaintenanceRole, Permission, PlatformRole } from '@vm/contracts';
import { ROLE_GRANTS } from './roles.ts';

export interface RoleAssignment {
  role: MaintenanceRole;
  /** null grants the role on every site the principal is a platform member of. */
  siteId: string | null;
}

export interface Principal {
  userId: string;
  tenantId: string;
  kind: 'human' | 'service';
  displayName: string;
  /** Platform site memberships from the validated identity token. */
  memberSiteIds: readonly string[];
  platformRoles: ReadonlyArray<{ role: PlatformRole; siteId: string | null }>;
  roles: readonly RoleAssignment[];
}

/**
 * A permission applies on a site only when the principal is a platform member
 * of that site and holds a maintenance role granting it there.
 */
export function can(principal: Principal, permission: Permission, siteId: string): boolean {
  if (!principal.memberSiteIds.includes(siteId)) return false;
  return principal.roles.some(
    (a) => (a.siteId === null || a.siteId === siteId) && ROLE_GRANTS[a.role].includes(permission),
  );
}

/** Tenant-level checks (licensing, access administration) require a tenant-wide role assignment. */
export function canTenantWide(principal: Principal, permission: Permission): boolean {
  return principal.roles.some((a) => a.siteId === null && ROLE_GRANTS[a.role].includes(permission));
}

export function sitesWith(principal: Principal, permission: Permission): string[] {
  return principal.memberSiteIds.filter((s) => can(principal, permission, s));
}

export function canAny(principal: Principal, permissions: readonly Permission[], siteId: string): boolean {
  return permissions.some((p) => can(principal, p, siteId));
}

export function effectivePermissions(principal: Principal, siteId: string): Permission[] {
  if (!principal.memberSiteIds.includes(siteId)) return [];
  const out = new Set<Permission>();
  for (const a of principal.roles) {
    if (a.siteId === null || a.siteId === siteId) ROLE_GRANTS[a.role].forEach((p) => out.add(p));
  }
  return [...out].sort();
}
