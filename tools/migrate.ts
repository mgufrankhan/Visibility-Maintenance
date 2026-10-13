/**
 * Applies platform, maintenance and integration migrations after a preflight.
 *
 *   npm run db:migrate -- [--check] [--allow-unreachable-platform]
 *
 * Env: PLATFORM_DATABASE_URL[_FILE], MAINTENANCE_DATABASE_URL[_FILE] (defaults
 * to the platform URL), PLATFORM_URL (enables registry compatibility checks),
 * MIGRATIONS_ROOT (packaged releases).
 */
import { parseArgs } from 'node:util';
import { migrateAll, migrationDirs, preflight } from '@vm/ops';
import { connectDatabases, print, registryFromEnv } from './lib/cli.ts';

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, 'allow-unreachable-platform': { type: 'boolean', default: false } } });
const conn = connectDatabases();
const dirs = migrationDirs();
let code = 0;
try {
  const report = await preflight(conn.dbs, dirs, registryFromEnv(), { allowUnreachablePlatform: values['allow-unreachable-platform'] });
  print({ preflight: report.checks });
  if (!report.ok) {
    console.error('Preflight failed; no migrations were applied.');
    code = 2;
  } else if (!values.check) {
    print({ applied: await migrateAll(conn.dbs, dirs) });
  }
} finally {
  await conn.close();
}
process.exit(code);
