import { PLATFORM_API_VERSION } from '@vm/contracts';
import { RegistryUnavailableError } from '@vm/registry';
import type { Services } from './context.ts';

/** Platform API versions this build can talk to. */
export const SUPPORTED_PLATFORM_API = { min: PLATFORM_API_VERSION, max: PLATFORM_API_VERSION } as const;

const BINDING_KEY = 'registry_binding';

export type RegistryBinding =
  | { status: 'bound'; registry_id: string; api_version: number; platform_build: string }
  | { status: 'newly_bound'; registry_id: string; api_version: number; platform_build: string }
  | { status: 'unbound'; reason: string }
  | { status: 'unreachable'; bound_registry_id: string | null; reason: string }
  | { status: 'incompatible_api'; api_version: number; supported: typeof SUPPORTED_PLATFORM_API }
  | { status: 'registry_mismatch'; bound_registry_id: string; reported_registry_id: string };

export async function boundRegistryId(s: Pick<Services, 'db'>): Promise<string | null> {
  const { rows } = await s.db.query<{ value: string }>(`SELECT value #>> '{}' AS value FROM maintenance.installation_state WHERE key = $1`, [BINDING_KEY]);
  return rows[0]?.value ?? null;
}

/**
 * Confirms the configured platform is the registry this installation's
 * records refer to. The first successful contact binds the installation when
 * `bind` is set; afterwards a different registry is refused so asset identity
 * is never silently forked by a re-pointed URL or a second registry (AC-21).
 */
export async function checkRegistryBinding(s: Pick<Services, 'db' | 'registry'>, opts: { bind: boolean }): Promise<RegistryBinding> {
  const bound = await boundRegistryId(s);
  let meta;
  try {
    meta = await s.registry.meta();
  } catch (err) {
    if (err instanceof RegistryUnavailableError) return { status: 'unreachable', bound_registry_id: bound, reason: err.message };
    throw err;
  }
  if (meta.api_version < SUPPORTED_PLATFORM_API.min || meta.api_version > SUPPORTED_PLATFORM_API.max) {
    return { status: 'incompatible_api', api_version: meta.api_version, supported: SUPPORTED_PLATFORM_API };
  }
  if (bound && bound !== meta.registry_id) {
    return { status: 'registry_mismatch', bound_registry_id: bound, reported_registry_id: meta.registry_id };
  }
  const info = { registry_id: meta.registry_id, api_version: meta.api_version, platform_build: meta.build_version };
  if (bound) return { status: 'bound', ...info };
  if (!opts.bind) return { status: 'unbound', reason: 'Installation has not been bound to a registry; run setup.' };
  const r = await s.db.query(
    `INSERT INTO maintenance.installation_state (key, value) VALUES ($1, to_jsonb($2::text)) ON CONFLICT (key) DO NOTHING`,
    [BINDING_KEY, meta.registry_id],
  );
  if (r.rowCount === 0) return checkRegistryBinding(s, { bind: false });
  return { status: 'newly_bound', ...info };
}

/** Startup gate: unreachable is tolerated (local continuity), a wrong or incompatible registry is not. */
export function assertRegistryUsable(b: RegistryBinding): void {
  switch (b.status) {
    case 'bound':
    case 'newly_bound':
    case 'unreachable':
      return;
    case 'unbound':
      throw new Error(b.reason);
    case 'incompatible_api':
      throw new Error(`Platform API version ${b.api_version} is outside the supported range ${b.supported.min}-${b.supported.max}`);
    case 'registry_mismatch':
      throw new Error(`Configured registry ${b.reported_registry_id} differs from the bound registry ${b.bound_registry_id}; refusing to start`);
    default: {
      const never: never = b;
      throw new Error(`Unhandled binding ${JSON.stringify(never)}`);
    }
  }
}
