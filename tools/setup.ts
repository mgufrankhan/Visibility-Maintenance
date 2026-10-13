/**
 * First-run tenant setup. Requires migrated databases and a running platform API.
 *
 *   npm run setup -- --tenant-slug acme --tenant-name "Acme" \
 *     --site-code P1 --site-name "Plant 1" --timezone Asia/Karachi \
 *     --admin-email admin@example.com --admin-name "Admin"
 *
 * The administrator password is read from SETUP_ADMIN_PASSWORD[_FILE]; when
 * absent a random one is generated and printed once. System credentials are
 * written to SYSTEM_CREDENTIALS_FILE with owner-only permissions.
 */
import { parseArgs } from 'node:util';
import { SetupError, setupTenant } from '@vm/ops';
import { readSecret, requiredSecret } from '@vm/server-kit';
import { connectDatabases, fail, print, registryFromEnv } from './lib/cli.ts';

const { values: v } = parseArgs({
  options: {
    'tenant-slug': { type: 'string' },
    'tenant-name': { type: 'string' },
    'site-code': { type: 'string' },
    'site-name': { type: 'string' },
    timezone: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
  },
});
for (const k of ['tenant-slug', 'tenant-name', 'site-code', 'site-name', 'timezone', 'admin-email', 'admin-name'] as const) {
  if (!v[k]) fail(`--${k} is required`);
}
const registry = registryFromEnv() ?? fail('PLATFORM_URL is required so setup can bind the installation to its registry');
const conn = connectDatabases();
try {
  const result = await setupTenant(conn.dbs, registry, {
    tenant: { slug: v['tenant-slug']!, name: v['tenant-name']! },
    site: { code: v['site-code']!, name: v['site-name']!, timezone: v.timezone! },
    admin: { email: v['admin-email']!, displayName: v['admin-name']!, password: readSecret('SETUP_ADMIN_PASSWORD') },
    systemCredentialsFile: requiredSecret('SYSTEM_CREDENTIALS_FILE'),
  });
  const { generated_admin_password, ...rest } = result;
  print(rest);
  if (generated_admin_password) {
    console.log(`\nGenerated administrator password (shown once, store it securely): ${generated_admin_password}`);
  }
  console.log(`\nSend the installation ID ${result.installation_id} and tenant ID ${result.tenant_id} to your license issuer.`);
  console.log('Restart maintenance-worker so it loads the new system credentials.');
} catch (err) {
  if (err instanceof SetupError) fail(err.message);
  throw err;
} finally {
  await conn.close();
}
