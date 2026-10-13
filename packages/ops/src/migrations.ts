import path from 'node:path';
import { boundRegistryId, checkRegistryBinding, type RegistryBinding } from '@vm/core';
import { migrate, schemaStatus, type Db, type MigrationResult, type SchemaStatus } from '@vm/db';
import { INTEGRATION_MIGRATIONS_DIR, MAINTENANCE_MIGRATIONS_DIR } from '@vm/maintenance-api';
import { PLATFORM_MIGRATIONS_DIR } from '@vm/platform-api';
import type { RegistryClient } from '@vm/registry';

export interface MigrationDirs {
  platform: string;
  maintenance: string;
  integration: string;
}

/** Source-tree locations, or `<root>/{platform,maintenance,integration}` in a packaged release. */
export function migrationDirs(root: string | undefined = process.env.MIGRATIONS_ROOT): MigrationDirs {
  if (root) return { platform: path.join(root, 'platform'), maintenance: path.join(root, 'maintenance'), integration: path.join(root, 'integration') };
  return { platform: PLATFORM_MIGRATIONS_DIR, maintenance: MAINTENANCE_MIGRATIONS_DIR, integration: INTEGRATION_MIGRATIONS_DIR };
}

/** The platform owns its schema; Maintenance owns `maintenance` and `integration`. They may share a server or not. */
export interface Databases {
  platform: Db;
  maintenance: Db;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  schemas: SchemaStatus[];
  registry: RegistryBinding | null;
}

function schemaCheck(st: SchemaStatus): PreflightCheck {
  if (st.modified.length > 0) return { name: `schema:${st.schema}`, status: 'fail', detail: `Applied migrations differ from this build: ${st.modified.join(', ')}` };
  if (st.unknown.length > 0) {
    return { name: `schema:${st.schema}`, status: 'fail', detail: `Database is ahead of this build (${st.unknown.join(', ')}); downgrade requires restoring a backup` };
  }
  if (st.pending.length > 0) return { name: `schema:${st.schema}`, status: 'warn', detail: `Pending: ${st.pending.join(', ')}` };
  return { name: `schema:${st.schema}`, status: 'ok', detail: `At ${st.current ?? 'none'}` };
}

/**
 * Compares the binding recorded by Maintenance with the registry identity in
 * the configured platform database, so a re-pointed database URL is caught
 * even when the platform API is not running yet.
 */
async function registryDatabaseCheck(dbs: Databases): Promise<PreflightCheck> {
  const bound = await boundRegistryId({ db: dbs.maintenance });
  const exists = await dbs.platform.query(`SELECT to_regclass('platform.installation') AS t`);
  if (!exists.rows[0]?.t) return { name: 'registry_database', status: 'warn', detail: 'Platform schema has no installation identity yet (pending platform migration)' };
  const { rows } = await dbs.platform.query<{ registry_id: string }>(`SELECT registry_id FROM platform.installation`);
  const actual = rows[0]?.registry_id ?? null;
  if (!bound) return { name: 'registry_database', status: 'warn', detail: 'Installation is not bound to a registry yet; run setup' };
  if (actual !== bound) return { name: 'registry_database', status: 'fail', detail: `Platform database holds registry ${actual}, but this installation is bound to ${bound}` };
  return { name: 'registry_database', status: 'ok', detail: `Platform database registry ${actual} matches the binding` };
}

/**
 * Upgrade/attach preflight (docs/08 Upgrade, AC-21). Detects a database ahead
 * of the build, edited migrations, an incompatible platform API or a
 * different registry before any migration is applied.
 */
export async function preflight(
  dbs: Databases,
  dirs: MigrationDirs,
  registry: RegistryClient | null,
  opts: { allowUnreachablePlatform?: boolean } = {},
): Promise<PreflightReport> {
  const schemas = [
    await schemaStatus(dbs.platform, 'platform', dirs.platform),
    await schemaStatus(dbs.maintenance, 'maintenance', dirs.maintenance),
    await schemaStatus(dbs.maintenance, 'integration', dirs.integration),
  ];
  const checks = schemas.map(schemaCheck);
  let binding: RegistryBinding | null = null;
  const maintenanceInitialized = schemas[1]!.current !== null;
  if (maintenanceInitialized) checks.push(await registryDatabaseCheck(dbs));
  if (registry && maintenanceInitialized) {
    binding = await checkRegistryBinding({ db: dbs.maintenance, registry }, { bind: false });
    switch (binding.status) {
      case 'bound':
        checks.push({ name: 'registry', status: 'ok', detail: `Bound to ${binding.registry_id} (platform API ${binding.api_version}, build ${binding.platform_build})` });
        break;
      case 'newly_bound':
        checks.push({ name: 'registry', status: 'ok', detail: `Bound to ${binding.registry_id}` });
        break;
      case 'unbound':
        checks.push({ name: 'registry', status: 'warn', detail: binding.reason });
        break;
      case 'unreachable':
        checks.push({ name: 'registry', status: opts.allowUnreachablePlatform ? 'warn' : 'fail', detail: `Platform unreachable: ${binding.reason}` });
        break;
      case 'incompatible_api':
        checks.push({ name: 'registry', status: 'fail', detail: `Platform API ${binding.api_version} unsupported (needs ${binding.supported.min}-${binding.supported.max}); upgrade the platform first` });
        break;
      case 'registry_mismatch':
        checks.push({ name: 'registry', status: 'fail', detail: `Configured registry ${binding.reported_registry_id} is not the bound registry ${binding.bound_registry_id}` });
        break;
      default: {
        const never: never = binding;
        throw new Error(`Unhandled binding ${JSON.stringify(never)}`);
      }
    }
  }
  return { ok: checks.every((c) => c.status !== 'fail'), checks, schemas, registry: binding };
}

/** Platform first, so a Maintenance migration never lands against an older shared schema. */
export async function migrateAll(dbs: Databases, dirs: MigrationDirs): Promise<MigrationResult[]> {
  return [
    await migrate(dbs.platform, 'platform', dirs.platform),
    await migrate(dbs.maintenance, 'maintenance', dirs.maintenance),
    await migrate(dbs.maintenance, 'integration', dirs.integration),
  ];
}
