import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import { MAINTENANCE_ROLES, OPERATIONAL_ROLES, type MaintenanceRole, type Permission, type PlatformRole } from '@vm/contracts';
import { can, canTenantWide, type Principal } from '@vm/policy';
import { AppError, conflict, forbidden, notFound } from '@vm/server-kit';
import { limitAllows } from '@vm/licensing';
import type { Actor, Services } from './context.ts';
import { writeAudit } from './records.ts';

export interface IdentityClaims {
  sub: string;
  tid: string;
  kind: 'human' | 'service';
  name: string;
  sites: string[];
  proles: Array<{ r: PlatformRole; s: string | null }>;
}

/** Maintenance roles are loaded per request so revocation applies immediately. */
export async function loadPrincipal(db: Queryable, claims: IdentityClaims): Promise<Principal> {
  const { rows } = await db.query<{ role: MaintenanceRole; site_id: string | null }>(
    `SELECT role, site_id FROM maintenance.role_assignment WHERE tenant_id = $1 AND user_id = $2`,
    [claims.tid, claims.sub],
  );
  return {
    userId: claims.sub,
    tenantId: claims.tid,
    kind: claims.kind,
    displayName: claims.name,
    memberSiteIds: claims.sites,
    platformRoles: claims.proles.map((r) => ({ role: r.r, siteId: r.s })),
    roles: rows.filter((r) => (MAINTENANCE_ROLES as readonly string[]).includes(r.role)).map((r) => ({ role: r.role, siteId: r.site_id })),
  };
}

export function requirePermission(p: Principal, permission: Permission, siteId: string): void {
  if (!can(p, permission, siteId)) throw forbidden();
}

/** For record reads: absence of view rights is indistinguishable from absence of the record. */
export function requireVisible(p: Principal, permission: Permission | Permission[], siteId: string, what: string): void {
  const perms = Array.isArray(permission) ? permission : [permission];
  if (!perms.some((perm) => can(p, perm, siteId))) throw notFound(what);
}

export function requireTenantPermission(p: Principal, permission: Permission): void {
  if (!canTenantWide(p, permission)) throw forbidden();
}

export async function listRoleAssignments(s: Services, actor: Actor) {
  requireTenantPermission(actor.principal, 'maintenance.access.manage');
  const { rows } = await s.db.query(
    `SELECT id, user_id, role, site_id, granted_by, granted_at FROM maintenance.role_assignment WHERE tenant_id = $1 ORDER BY user_id, role`,
    [actor.principal.tenantId],
  );
  return rows;
}

export async function grantRole(s: Services, actor: Actor, input: { user_id: string; role: MaintenanceRole; site_id: string | null }) {
  const p = actor.principal;
  // Site-scoped grants may be made by a site manager; tenant-wide grants need a tenant-wide admin.
  const allowed = input.site_id ? can(p, 'maintenance.access.manage', input.site_id) : canTenantWide(p, 'maintenance.access.manage');
  if (!allowed) throw forbidden();
  if (input.user_id === p.userId && input.role !== 'reporter') {
    throw new AppError(409, 'self_grant_forbidden', 'Administrators cannot grant roles to themselves');
  }
  if (OPERATIONAL_ROLES.includes(input.role)) {
    const view = await s.entitlements.view(p.tenantId);
    const { rowCount } = await s.db.query(
      `SELECT 1 FROM maintenance.role_assignment WHERE tenant_id = $1 AND user_id = $2 AND role = ANY($3::text[]) LIMIT 1`,
      [p.tenantId, input.user_id, OPERATIONAL_ROLES],
    );
    if (!rowCount && !limitAllows(view, 'operational_users')) {
      throw new AppError(409, 'license_limit_reached', 'The licensed operational user limit has been reached');
    }
  }
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.role_assignment (id, tenant_id, user_id, role, site_id, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id, user_id, role, site_id, granted_by, granted_at`,
      [id, p.tenantId, input.user_id, input.role, input.site_id, p.userId],
    );
    if (!rows[0]) throw conflict('role_exists', 'This role is already assigned');
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'role.granted', targetType: 'user', targetId: input.user_id, detail: { role: input.role } });
    s.entitlements.invalidate(p.tenantId);
    return rows[0];
  });
}

export async function revokeRole(s: Services, actor: Actor, assignmentId: string) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.role_assignment WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, assignmentId]);
    const a = rows[0];
    if (!a) throw notFound('Role assignment');
    const allowed = a.site_id ? can(p, 'maintenance.access.manage', a.site_id) : canTenantWide(p, 'maintenance.access.manage');
    if (!allowed) throw forbidden();
    await tx.query(`DELETE FROM maintenance.role_assignment WHERE id = $1`, [a.id]);
    await writeAudit(tx, actor, { siteId: a.site_id, action: 'role.revoked', targetType: 'user', targetId: a.user_id, detail: { role: a.role } });
    s.entitlements.invalidate(p.tenantId);
  });
}

// ---------- Teams ----------

export async function listTeams(s: Services, actor: Actor, siteId?: string) {
  const p = actor.principal;
  const sites = p.memberSiteIds.filter((sid) => can(p, 'maintenance.view', sid) && (!siteId || sid === siteId));
  const { rows } = await s.db.query(
    `SELECT t.id, t.site_id, t.name, t.status, t.version,
            coalesce(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
       FROM maintenance.team t LEFT JOIN maintenance.team_member m ON m.team_id = t.id
      WHERE t.tenant_id = $1 AND t.site_id = ANY($2::uuid[])
      GROUP BY t.id ORDER BY t.name, t.id`,
    [p.tenantId, sites],
  );
  return rows;
}

export async function createTeam(s: Services, actor: Actor, input: { site_id: string; name: string; member_ids: string[] }) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.settings.manage', input.site_id);
  const members = await s.registry.directory(actor.token, input.site_id);
  const memberSet = new Set(members.map((m) => m.id));
  const unknown = input.member_ids.filter((id) => !memberSet.has(id));
  if (unknown.length) throw new AppError(422, 'validation_failed', 'Team members must belong to the site', { member_ids: unknown });
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    try {
      await tx.query(`INSERT INTO maintenance.team (id, tenant_id, site_id, name, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, p.tenantId, input.site_id, input.name, p.userId]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('duplicate_team', 'A team with this name exists at the site');
      throw err;
    }
    for (const m of input.member_ids) {
      await tx.query(`INSERT INTO maintenance.team_member (tenant_id, team_id, user_id) VALUES ($1,$2,$3)`, [p.tenantId, id, m]);
    }
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'team.created', targetType: 'team', targetId: id, afterVersion: 1, detail: { members: input.member_ids.length } });
    return { id, site_id: input.site_id, name: input.name, status: 'active', version: 1, member_ids: input.member_ids };
  });
}

export async function setTeamMembers(s: Services, actor: Actor, teamId: string, memberIds: string[]) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.team WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, teamId]);
    const team = rows[0];
    if (!team || !can(p, 'maintenance.view', team.site_id)) throw notFound('Team');
    requirePermission(p, 'maintenance.settings.manage', team.site_id);
    const members = new Set((await s.registry.directory(actor.token, team.site_id)).map((m) => m.id));
    const unknown = memberIds.filter((id) => !members.has(id));
    if (unknown.length) throw new AppError(422, 'validation_failed', 'Team members must belong to the site', { member_ids: unknown });
    await tx.query(`DELETE FROM maintenance.team_member WHERE team_id = $1`, [team.id]);
    for (const m of memberIds) await tx.query(`INSERT INTO maintenance.team_member (tenant_id, team_id, user_id) VALUES ($1,$2,$3)`, [p.tenantId, team.id, m]);
    await tx.query(`UPDATE maintenance.team SET version = version + 1 WHERE id = $1`, [team.id]);
    await writeAudit(tx, actor, { siteId: team.site_id, action: 'team.members_set', targetType: 'team', targetId: team.id, beforeVersion: team.version, afterVersion: team.version + 1, detail: { members: memberIds.length } });
    return { ...team, version: team.version + 1, member_ids: memberIds };
  });
}

/** Installation bootstrap: grants an initial role before any administrator exists. */
export async function bootstrapRoleAssignment(db: Queryable, tenantId: string, userId: string, role: MaintenanceRole, siteId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO maintenance.role_assignment (id, tenant_id, user_id, role, site_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [randomUUID(), tenantId, userId, role, siteId],
  );
  await db.query(
    `INSERT INTO maintenance.audit_event (tenant_id, site_id, actor_id, actor_kind, action, target_type, target_id, detail)
     VALUES ($1,$2,NULL,'system','role.bootstrapped','user',$3,$4)`,
    [tenantId, siteId, userId, JSON.stringify({ role })],
  );
}

export async function isTeamMember(db: Queryable, tenantId: string, teamId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM maintenance.team_member WHERE tenant_id = $1 AND team_id = $2 AND user_id = $3`, [tenantId, teamId, userId]);
  return (rowCount ?? 0) > 0;
}
