import { assertRegistryUsable, checkRegistryBinding, createServices, readJsonFile } from '@vm/core';
import { assertSchemaCompatible, createPool } from '@vm/db';
import { buildMaintenanceApp } from './app.ts';
import { loadMaintenanceConfig } from './config.ts';
import { MAINTENANCE_MIGRATIONS_DIR } from './index.ts';

const config = loadMaintenanceConfig();
const db = createPool(config.databaseUrl, { applicationName: 'vm-maintenance-api' });
await assertSchemaCompatible(db, 'maintenance', process.env.MAINTENANCE_MIGRATIONS_DIR ?? MAINTENANCE_MIGRATIONS_DIR);

const services = createServices({
  db,
  platformUrl: config.platformUrl,
  blobRoot: config.blobRoot,
  licensePublicKeys: readJsonFile(config.licensePublicKeysFile, {}),
  systemCredentials: readJsonFile(config.systemCredentialsFile, {}),
  config: {
    downloadLinkSecret: config.downloadLinkSecret,
    allowSimulatedConnectors: config.allowSimulatedConnectors,
    neoInferencePolicy: config.neoInferencePolicy,
  },
});

const binding = await checkRegistryBinding(services, { bind: false });
assertRegistryUsable(binding);

const app = await buildMaintenanceApp({
  services,
  auth: { issuer: config.issuer, audience: 'visibility-maintenance', jwksUrl: config.jwksUrl },
  logger: true,
  monitoringToken: config.monitoringToken,
  optionalHealth: {
    neo: async () => (config.neoInferencePolicy === 'disabled' ? 'disabled' : 'ok'),
    visibility_live: async () => 'disabled',
    openremote: async () => 'disabled',
  },
});
if (binding.status === 'unreachable') app.log.warn({ reason: binding.reason }, 'registry unreachable at startup; continuing with local snapshots');
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
