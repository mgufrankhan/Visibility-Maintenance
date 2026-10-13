import type { Db } from '@vm/db';
import type { Principal } from '@vm/policy';
import type { RegistryClient } from '@vm/registry';
import type { Clock } from '@vm/server-kit';
import type { BlobStore } from './blob-store.ts';
import type { EntitlementService } from './entitlements.ts';

export interface CoreConfig {
  /** Max upload sizes in bytes. */
  maxImageBytes: number;
  maxDocumentBytes: number;
  /** Secret used to sign short-lived attachment download links. */
  downloadLinkSecret: string;
  downloadLinkTtlSeconds: number;
  /** Simulated connectors are refused unless explicitly enabled (never in production by default). */
  allowSimulatedConnectors: boolean;
  /** Inference policy for Neo: disabled, local-only or customer-permitted cloud. */
  neoInferencePolicy: 'disabled' | 'private_only' | 'cloud_permitted';
}

export const defaultCoreConfig: CoreConfig = {
  maxImageBytes: 10 * 1024 * 1024,
  maxDocumentBytes: 50 * 1024 * 1024,
  downloadLinkSecret: '',
  downloadLinkTtlSeconds: 300,
  allowSimulatedConnectors: false,
  neoInferencePolicy: 'disabled',
};

export interface Services {
  db: Db;
  clock: Clock;
  registry: RegistryClient;
  blobs: BlobStore;
  entitlements: EntitlementService;
  config: CoreConfig;
  /** Token for background work under the tenant's narrowly scoped system service account. */
  systemToken: (tenantId: string) => Promise<string>;
}

/** Per-request identity. `token` is the caller's bearer token, forwarded to the registry boundary. */
export interface Actor {
  principal: Principal;
  token: string;
  correlationId: string;
}

/** Background jobs act as an explicit system identity, never as the user who configured them. */
export interface SystemActor {
  kind: 'system';
  tenantId: string;
  label: string;
  correlationId: string;
}

export type AnyActor = Actor | SystemActor;

export function isSystem(a: AnyActor): a is SystemActor {
  return (a as SystemActor).kind === 'system';
}

export function actorId(a: AnyActor): string | null {
  return isSystem(a) ? null : a.principal.userId;
}

export function actorKind(a: AnyActor): 'human' | 'service' | 'system' {
  return isSystem(a) ? 'system' : a.principal.kind;
}

export function tenantOf(a: AnyActor): string {
  return isSystem(a) ? a.tenantId : a.principal.tenantId;
}
