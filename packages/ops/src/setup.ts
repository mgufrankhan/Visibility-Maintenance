import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapRoleAssignment, checkRegistryBinding, EntitlementService, type RegistryBinding } from '@vm/core';
import { withTransaction } from '@vm/db';
import { bootstrap } from '@vm/platform-api';
import type { RegistryClient } from '@vm/registry';
import { systemClock } from '@vm/server-kit';
import type { Databases } from './migrations.ts';

export const SYSTEM_ACCOUNT_NAME = 'maintenance-system';
const MIN_PASSWORD_LENGTH = 12;

export interface TenantSetupInput {
  tenant: { slug: string; name: string };
  site: { code: string; name: string; timezone: string };
  admin: { email: string; displayName: string; password?: string };
  /** Where the worker reads per-tenant system credentials (SYSTEM_CREDENTIALS_FILE). */
  systemCredentialsFile: string;
}

export interface TenantSetupResult {
  tenant_id: string;
  site_id: string;
  admin_user_id: string;
  /** Present only when setup generated the password; shown once and never stored in plain text. */
  generated_admin_password: string | null;
  installation_id: string;
  registry: RegistryBinding;
}

export class SetupError extends Error {}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateSetupInput(input: TenantSetupInput): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.tenant.slug)) errors.push('tenant slug must be 2-63 lowercase letters, digits or hyphens');
  if (!input.tenant.name.trim()) errors.push('tenant name is required');
  if (!input.site.code.trim() || !input.site.name.trim()) errors.push('site code and name are required');
  if (!validTimezone(input.site.timezone)) errors.push(`unknown IANA timezone "${input.site.timezone}"`);
  if (!/^[^@\s]+@[^@\s]+$/.test(input.admin.email)) errors.push('administrator email is invalid');
  if (input.admin.password !== undefined && input.admin.password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`administrator password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!input.systemCredentialsFile) errors.push('system credentials file path is required');
  return errors;
}

/** Atomic owner-only write so a crash never leaves a truncated credentials file. */
async function mergeCredentials(file: string, tenantId: string, cred: { client_id: string; client_secret: string }): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...existing, [tenantId]: cred }, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/**
 * First-run tenant setup (docs/08 Setup sequence): binds the installation to
 * its registry, then creates tenant, first site, administrator and the
 * Maintenance system identity. Refuses to touch an existing tenant slug.
 */
export async function setupTenant(dbs: Databases, registry: RegistryClient, input: TenantSetupInput): Promise<TenantSetupResult> {
  const errors = validateSetupInput(input);
  if (errors.length > 0) throw new SetupError(`Invalid setup input: ${errors.join('; ')}`);

  const binding = await checkRegistryBinding({ db: dbs.maintenance, registry }, { bind: true });
  if (binding.status !== 'bound' && binding.status !== 'newly_bound') {
    throw new SetupError(`Registry is not usable for setup: ${JSON.stringify(binding)}`);
  }

  const existing = await dbs.platform.query(`SELECT 1 FROM platform.tenant WHERE slug = $1`, [input.tenant.slug]);
  if (existing.rowCount) throw new SetupError(`Tenant "${input.tenant.slug}" already exists; setup does not modify existing tenants`);

  const generated = input.admin.password === undefined ? randomBytes(18).toString('base64url') : null;
  const password = input.admin.password ?? generated!;

  const created = await withTransaction(dbs.platform, async (tx) => {
    const tenantId = await bootstrap.createTenant(tx, input.tenant);
    const system = await bootstrap.createServiceAccount(tx, tenantId, { name: SYSTEM_ACCOUNT_NAME, siteIds: [], autoSiteMembership: true });
    const siteId = await bootstrap.createSite(tx, tenantId, input.site);
    const adminId = await bootstrap.createHumanUser(tx, tenantId, {
      email: input.admin.email,
      displayName: input.admin.displayName,
      password,
      siteIds: [siteId],
      platformRoles: [{ role: 'platform_admin', siteId: null }],
    });
    return { tenantId, siteId, adminId, system };
  });

  await bootstrapRoleAssignment(dbs.maintenance, created.tenantId, created.adminId, 'maintenance_admin', null);
  await mergeCredentials(input.systemCredentialsFile, created.tenantId, { client_id: created.system.client_id, client_secret: created.system.client_secret });

  const installationId = await new EntitlementService({ db: dbs.maintenance, clock: systemClock, publicKeys: {} }).installationId();
  return {
    tenant_id: created.tenantId,
    site_id: created.siteId,
    admin_user_id: created.adminId,
    generated_admin_password: generated,
    installation_id: installationId,
    registry: binding,
  };
}
