import { hostname } from 'node:os';
import { assertRegistryUsable, checkRegistryBinding, createServices, readJsonFile } from '@vm/core';
import { assertSchemaCompatible, createPool } from '@vm/db';
import { requiredSecret } from '@vm/server-kit';
import { maintenanceJobs, startWorker } from './worker.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}`;
const log = (msg: string, detail?: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), worker: workerId, msg, ...detail }));

const db = createPool(requiredSecret('MAINTENANCE_DATABASE_URL'), { applicationName: 'vm-maintenance-worker' });
await assertSchemaCompatible(db, 'maintenance', process.env.MAINTENANCE_MIGRATIONS_DIR ?? new URL('../../../database/migrations/maintenance', import.meta.url).pathname);

const systemCredentials = readJsonFile<Record<string, { client_id: string; client_secret: string }>>(process.env.SYSTEM_CREDENTIALS_FILE, {});
const services = createServices({
  db,
  platformUrl: required('PLATFORM_URL'),
  blobRoot: required('BLOB_ROOT'),
  licensePublicKeys: readJsonFile(process.env.LICENSE_PUBLIC_KEYS_FILE, {}),
  systemCredentials,
  config: { downloadLinkSecret: requiredSecret('DOWNLOAD_LINK_SECRET') },
});

const binding = await checkRegistryBinding(services, { bind: false });
assertRegistryUsable(binding);
if (binding.status === 'unreachable') log('registry unreachable at startup; continuing with local snapshots', { reason: binding.reason });

const worker = startWorker(maintenanceJobs({ services, workerId, tenantIds: () => Object.keys(systemCredentials), log }), { services, workerId, log });
log('worker started', { tenants: Object.keys(systemCredentials).length });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log('worker stopping');
    await worker.stop();
    await db.end();
    process.exit(0);
  });
}
