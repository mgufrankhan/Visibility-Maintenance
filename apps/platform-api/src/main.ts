import { assertSchemaCompatible, createPool } from '@vm/db';
import { buildPlatformApp } from './app.ts';
import { loadPlatformConfig } from './config.ts';
import { loadOrCreateSigningKey } from './keys.ts';
import { PLATFORM_MIGRATIONS_DIR } from './index.ts';

const config = loadPlatformConfig();
const db = createPool(config.databaseUrl, { applicationName: 'vm-platform-api' });
await assertSchemaCompatible(db, 'platform', process.env.PLATFORM_MIGRATIONS_DIR ?? PLATFORM_MIGRATIONS_DIR);
const key = await loadOrCreateSigningKey(config.keyFile);
const app = await buildPlatformApp({ db, config, key, logger: true });
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
