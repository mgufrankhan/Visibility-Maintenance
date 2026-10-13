import { randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from '@vm/db';
import type { PlatformRole } from '@vm/contracts';
import { hashSecret } from '@vm/server-kit';

/**
 * Installation bootstrap used by the setup CLI. These run with database
 * access during installation, before any administrator can sign in.
 */
export async function createTenant(db: Queryable, input: { slug: string; name: string }): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO platform.tenant (id, slug, name) VALUES ($1,$2,$3)`, [id, input.slug, input.name]);
  return id;
}

export async function createSite(db: Queryable, tenantId: string, input: { code: string; name: string; timezone: string }): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO platform.site (id, tenant_id, code, name, timezone) VALUES ($1,$2,$3,$4,$5)`, [id, tenantId, input.code, input.name, input.timezone]);
  await db.query(
    `INSERT INTO platform.site_membership (tenant_id, user_id, site_id)
     SELECT tenant_id, id, $2 FROM platform.user_account WHERE tenant_id = $1 AND auto_site_membership AND status = 'active'`,
    [tenantId, id],
  );
  return id;
}

export async function createHumanUser(
  db: Queryable,
  tenantId: string,
  input: { email: string; displayName: string; password: string; siteIds: string[]; platformRoles?: Array<{ role: PlatformRole; siteId: string | null }> },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO platform.user_account (id, tenant_id, kind, email, display_name, password_hash) VALUES ($1,$2,'human',$3,$4,$5)`,
    [id, tenantId, input.email, input.displayName, await hashSecret(input.password)],
  );
  for (const siteId of input.siteIds) {
    await db.query(`INSERT INTO platform.site_membership (tenant_id, user_id, site_id) VALUES ($1,$2,$3)`, [tenantId, id, siteId]);
  }
  for (const r of input.platformRoles ?? []) {
    await db.query(`INSERT INTO platform.platform_role (id, tenant_id, user_id, role, site_id) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), tenantId, id, r.role, r.siteId]);
  }
  return id;
}

export async function createServiceAccount(
  db: Queryable,
  tenantId: string,
  input: { name: string; siteIds: string[]; autoSiteMembership?: boolean },
): Promise<{ id: string; client_id: string; client_secret: string }> {
  const id = randomUUID();
  const clientId = `svc_${randomBytes(9).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO platform.user_account (id, tenant_id, kind, display_name, client_id, client_secret_hash, auto_site_membership) VALUES ($1,$2,'service',$3,$4,$5,$6)`,
    [id, tenantId, input.name, clientId, await hashSecret(secret), input.autoSiteMembership ?? false],
  );
  for (const siteId of input.siteIds) {
    await db.query(`INSERT INTO platform.site_membership (tenant_id, user_id, site_id) VALUES ($1,$2,$3)`, [tenantId, id, siteId]);
  }
  return { id, client_id: clientId, client_secret: secret };
}

export async function addSiteMembership(db: Queryable, tenantId: string, userId: string, siteId: string): Promise<void> {
  await db.query(`INSERT INTO platform.site_membership (tenant_id, user_id, site_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, userId, siteId]);
}
