import type { ConnectorProvider, SignalKind } from '@vm/contracts';

/** Active route configuration the runner receives from Maintenance. */
export interface RouteConfig {
  route_id: string;
  asset_id: string;
  signal_key: string;
  kind: SignalKind;
  external_asset_id: string;
  external_attribute: string;
  value_type: 'number' | 'boolean';
  source_unit: string | null;
  routing_epoch: number;
  freshness_seconds: number;
}

/** Provider-side event before normalization. */
export interface ProviderEvent {
  /** Stable provider event ID when the provider has one; otherwise a deterministic key is derived. */
  source_event_id: string | null;
  external_asset_id: string;
  external_attribute: string;
  /** Source time; null when the provider omits it. Never replaced with receipt time. */
  observed_at: string | null;
  value: number | boolean | string | null;
  unit: string | null;
  quality: 'good' | 'uncertain' | 'bad';
  /** True when produced by provider history/backfill rather than live delivery. */
  historical: boolean;
}

export interface DiscoveredAttribute {
  name: string;
  value_type: 'number' | 'boolean' | 'string';
  unit: string | null;
  sample: { value: number | boolean | string | null; observed_at: string | null } | null;
}

export interface DiscoveredAsset {
  external_asset_id: string;
  name: string | null;
  attributes: DiscoveredAttribute[];
}

export interface AdapterHealth {
  connected: boolean;
  credential_expires_at: string | null;
  last_error: string | null;
}

export interface PollResult {
  events: ProviderEvent[];
  /** Provider cursor after these events; persisted only after Maintenance commits receipt. */
  cursor: string | null;
}

/**
 * Provider adapter contract (06_IOT_CONNECTORS). Adapters are read-only: they
 * never write work-order state, asset master data or PLC/device values.
 */
export interface ProviderAdapter {
  readonly provider: ConnectorProvider;
  readonly name: string;
  readonly version: string;
  readonly simulated: boolean;
  /** Whether the provider can serve history for gap backfill. */
  readonly supportsHistory: boolean;
  testConnection(): Promise<AdapterHealth>;
  discoverAssets(): Promise<DiscoveredAsset[]>;
  discoverSignals(externalAssetId: string): Promise<DiscoveredAttribute[]>;
  previewMapping(route: Pick<RouteConfig, 'external_asset_id' | 'external_attribute'>): Promise<DiscoveredAttribute | null>;
  startIngestion(routes: RouteConfig[], checkpoint: string | null): Promise<void>;
  /** Next batch of events since the checkpoint the adapter was started or resumed with. */
  poll(maxEvents: number): Promise<PollResult>;
  pauseIngestion(): Promise<void>;
  resumeFromCheckpoint(checkpoint: string | null): Promise<void>;
  /** Historical events for a gap, when supportsHistory. Returned events must be marked historical. */
  backfill(from: Date, to: Date, routes: RouteConfig[]): Promise<ProviderEvent[]>;
  health(): Promise<AdapterHealth>;
}

export class ProviderNotQualifiedError extends Error {
  constructor(readonly provider: ConnectorProvider) {
    super(
      `The ${provider} adapter is not qualified for this deployment. Provider endpoints, authentication and subscription ` +
        'mechanisms must be selected against the deployed provider version and recorded in the compatibility matrix before use.',
    );
    this.name = 'ProviderNotQualifiedError';
  }
}

export class SimulationDisabledError extends Error {
  constructor() {
    super('Simulated connectors are disabled. Set ALLOW_SIMULATED_CONNECTORS=true only in demonstration or test environments.');
    this.name = 'SimulationDisabledError';
  }
}
