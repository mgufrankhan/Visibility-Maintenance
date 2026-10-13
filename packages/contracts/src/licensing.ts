import { z } from 'zod';

export const PRODUCT_ID = 'visibility-maintenance';

export const FEATURES = ['core', 'connected_operations', 'neo_assistance', 'private_deployment'] as const;
export type Feature = (typeof FEATURES)[number];

export const licenseDocument = z.object({
  license_id: z.string().min(1).max(100),
  product: z.literal(PRODUCT_ID),
  tenant_id: z.uuid(),
  installation_id: z.string().min(1).max(100),
  features: z.array(z.enum(FEATURES)).min(1),
  limits: z
    .object({
      sites: z.number().int().positive().nullable().default(null),
      operational_users: z.number().int().positive().nullable().default(null),
      maintainable_assets: z.number().int().positive().nullable().default(null),
    })
    .strict(),
  term: z.object({ starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }) }),
  grace_days: z.number().int().min(0).max(365),
  policy_tag: z.string().min(1).max(100),
  issued_at: z.iso.datetime({ offset: true }),
  key_id: z.string().min(1).max(100),
});
export type LicenseDocument = z.infer<typeof licenseDocument>;

export const signedLicense = z.object({
  license: licenseDocument,
  signature: z.string().min(10).max(1000),
});
export type SignedLicense = z.infer<typeof signedLicense>;

export const ENTITLEMENT_STATUSES = [
  'missing',
  'invalid',
  'not_yet_valid',
  'valid',
  'grace',
  'expired',
] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/** Server-evaluated capabilities. Clients display these; they cannot enable them. */
export const CAPABILITIES = [
  'core.read',
  'core.export',
  'core.admin',
  'core.report_fault',
  'core.create_work',
  'core.complete_active_work',
  'core.generate_pm',
  'core.inspect',
  'connected.ingest',
  'connected.create_requests',
  'connected.configure',
  'neo.assist',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface EntitlementView {
  status: EntitlementStatus;
  license_id: string | null;
  features: Feature[];
  limits: LicenseDocument['limits'] | null;
  term: LicenseDocument['term'] | null;
  grace_ends_at: string | null;
  policy_tag: string | null;
  capabilities: Capability[];
  warnings: string[];
  clock_anomaly: boolean;
  usage: { sites: number; operational_users: number; maintainable_assets: number };
}
