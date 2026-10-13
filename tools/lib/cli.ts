import { createPool, type Db } from '@vm/db';
import type { Databases } from '@vm/ops';
import { HttpRegistryClient } from '@vm/registry';
import { readSecret, requiredSecret } from '@vm/server-kit';

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function connectDatabases(): { dbs: Databases; urls: { platform: string; maintenance: string }; close: () => Promise<void> } {
  const platformUrl = requiredSecret('PLATFORM_DATABASE_URL');
  const maintenanceUrl = readSecret('MAINTENANCE_DATABASE_URL') ?? platformUrl;
  const platform: Db = createPool(platformUrl, { max: 2, applicationName: 'vm-tools' });
  const maintenance: Db = maintenanceUrl === platformUrl ? platform : createPool(maintenanceUrl, { max: 2, applicationName: 'vm-tools' });
  return {
    dbs: { platform, maintenance },
    urls: { platform: platformUrl, maintenance: maintenanceUrl },
    close: async () => {
      await platform.end();
      if (maintenance !== platform) await maintenance.end();
    },
  };
}

export function registryFromEnv(): HttpRegistryClient | null {
  const url = process.env.PLATFORM_URL;
  return url ? new HttpRegistryClient({ baseUrl: url }) : null;
}

export function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
