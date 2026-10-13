import { readFileSync } from 'node:fs';
import type { Db } from '@vm/db';
import { HttpRegistryClient, ServiceTokenProvider, type RegistryClient } from '@vm/registry';
import { systemClock, type Clock } from '@vm/server-kit';
import type { BlobStore } from './blob-store.ts';
import { blobStoreFromEnv } from './blob-store-s3.ts';
import { defaultCoreConfig, type CoreConfig, type Services } from './context.ts';
import { EntitlementService } from './entitlements.ts';

export interface ServicesOptions {
  db: Db;
  platformUrl: string;
  clock?: Clock;
  registry?: RegistryClient;
  blobs?: BlobStore;
  blobRoot?: string;
  licensePublicKeys: Readonly<Record<string, string>>;
  systemCredentials: Readonly<Record<string, { client_id: string; client_secret: string }>>;
  config?: Partial<CoreConfig>;
  entitlementCacheTtlMs?: number;
}

export function createServices(o: ServicesOptions): Services {
  const clock = o.clock ?? systemClock;
  const providers = new Map<string, ServiceTokenProvider>();
  const config = { ...defaultCoreConfig, ...o.config };
  if (!config.downloadLinkSecret || config.downloadLinkSecret.length < 32) {
    throw new Error('downloadLinkSecret must be at least 32 characters');
  }
  return {
    db: o.db,
    clock,
    registry: o.registry ?? new HttpRegistryClient({ baseUrl: o.platformUrl }),
    blobs: o.blobs ?? blobStoreFromEnv(o.blobRoot ?? './var/blobs'),
    entitlements: new EntitlementService({ db: o.db, clock, publicKeys: o.licensePublicKeys, cacheTtlMs: o.entitlementCacheTtlMs }),
    config,
    systemToken: async (tenantId: string) => {
      let p = providers.get(tenantId);
      if (!p) {
        const cred = o.systemCredentials[tenantId];
        if (!cred) throw new Error(`No system service credentials configured for tenant ${tenantId}`);
        p = new ServiceTokenProvider({ baseUrl: o.platformUrl, clientId: cred.client_id, clientSecret: cred.client_secret });
        providers.set(tenantId, p);
      }
      return p.token();
    },
  };
}

export function readJsonFile<T>(file: string | undefined, fallback: T): T {
  if (!file) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}
