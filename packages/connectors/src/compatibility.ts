import type { ConnectorProvider } from '@vm/contracts';

export type QualificationStatus = 'qualified' | 'not_qualified' | 'simulation_only';

/** One row of the provider compatibility matrix (MC-08). */
export interface CompatibilityEntry {
  provider: ConnectorProvider;
  status: QualificationStatus;
  provider_versions: string[];
  auth_mode: string | null;
  ingestion_mechanism: string | null;
  historical_access: string | null;
  limitations: string[];
  test_environment: string | null;
  evidence_date: string | null;
  evidence_location: string | null;
}

/**
 * Shipped compatibility matrix. A provider moves to `qualified` only with
 * evidence from a run against the deployed provider version; Live and
 * OpenRemote are qualified independently. Mocked results never qualify a provider.
 */
export const COMPATIBILITY_MATRIX: readonly CompatibilityEntry[] = [
  {
    provider: 'visibility_live',
    status: 'not_qualified',
    provider_versions: [],
    auth_mode: null,
    ingestion_mechanism: null,
    historical_access: null,
    limitations: ['Upstream API, authentication and subscription mechanism not yet confirmed against a deployed Live version.'],
    test_environment: null,
    evidence_date: null,
    evidence_location: null,
  },
  {
    provider: 'openremote',
    status: 'not_qualified',
    provider_versions: [],
    auth_mode: null,
    ingestion_mechanism: null,
    historical_access: null,
    limitations: ['Upstream API, authentication and subscription mechanism not yet confirmed against a deployed OpenRemote version.'],
    test_environment: null,
    evidence_date: null,
    evidence_location: null,
  },
  {
    provider: 'simulated',
    status: 'simulation_only',
    provider_versions: ['builtin'],
    auth_mode: 'none',
    ingestion_mechanism: 'in-process scripted generator',
    historical_access: 'scripted backfill',
    limitations: ['Synthetic data for demonstration and tests only; disabled unless ALLOW_SIMULATED_CONNECTORS=true.'],
    test_environment: 'local',
    evidence_date: null,
    evidence_location: null,
  },
];

export function compatibilityFor(provider: ConnectorProvider): CompatibilityEntry {
  const entry = COMPATIBILITY_MATRIX.find((e) => e.provider === provider);
  if (!entry) throw new Error(`No compatibility entry for ${provider}`);
  return entry;
}
