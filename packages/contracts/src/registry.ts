import { z } from 'zod';

export const ASSET_LIFECYCLES = ['active', 'archived', 'tombstoned'] as const;
export type AssetLifecycle = (typeof ASSET_LIFECYCLES)[number];

export const EXTERNAL_PROVIDERS = ['visibility_live', 'openremote', 'cmms', 'import', 'simulated'] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export const createAssetRequest = z.object({
  site_id: z.uuid(),
  code: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  asset_type: z.string().min(1).max(80).default('equipment'),
  location: z.string().max(300).nullable().default(null),
  parent_id: z.uuid().nullable().default(null),
});

export const updateAssetRequest = z
  .object({
    code: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    asset_type: z.string().min(1).max(80),
    location: z.string().max(300).nullable(),
    parent_id: z.uuid().nullable(),
  })
  .partial()
  .strict();

export const lifecycleRequest = z.object({ reason: z.string().min(3).max(1000) });

export const moveAssetRequest = z.object({
  site_id: z.uuid(),
  reason: z.string().min(3).max(1000),
});

export const externalRefRequest = z.object({
  provider: z.enum(EXTERNAL_PROVIDERS),
  provider_instance: z.string().min(1).max(200),
  external_id: z.string().min(1).max(300),
});

export const importRow = z.object({
  site_id: z.uuid(),
  code: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  asset_type: z.string().min(1).max(80).default('equipment'),
  location: z.string().max(300).nullable().default(null),
  existing_asset_id: z.uuid().nullable().default(null),
  external_ref: externalRefRequest.nullable().default(null),
});
export const importRequest = z.object({ rows: z.array(importRow).min(1).max(2000) });

export interface AssetDto {
  id: string;
  tenant_id: string;
  site_id: string;
  parent_id: string | null;
  code: string;
  name: string;
  asset_type: string;
  location: string | null;
  lifecycle: AssetLifecycle;
  qr_token: string;
  version: number;
  change_seq: string;
  created_at: string;
  updated_at: string;
}

export interface ExternalAssetRefDto {
  id: string;
  asset_id: string;
  provider: ExternalProvider;
  provider_instance: string;
  external_id: string;
  status: 'active' | 'archived';
}

export type ImportDecision =
  | { row: number; action: 'create' }
  | { row: number; action: 'link'; asset_id: string; reason: string }
  | { row: number; action: 'error'; errors: string[] }
  | { row: number; action: 'ambiguous'; candidates: string[]; reason: string };

/** Bumped only for breaking changes to the platform identity/registry HTTP contract. */
export const PLATFORM_API_VERSION = 1;

export interface PlatformMeta {
  service: 'visibility-platform';
  api_version: number;
  build_version: string;
  /** Stable identity of this registry; products bind to it and refuse a different one. */
  registry_id: string;
}
