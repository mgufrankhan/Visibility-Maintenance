import { SimulationDisabledError, type AdapterHealth, type DiscoveredAsset, type DiscoveredAttribute, type PollResult, type ProviderAdapter, type ProviderEvent, type RouteConfig } from './adapter.ts';

export interface SimulatedAttribute {
  name: string;
  value_type: 'number' | 'boolean';
  unit: string | null;
  /** Values emitted on successive ticks, cycling. */
  values: Array<number | boolean>;
}

export interface SimulationScenario {
  start_at: string;
  tick_seconds: number;
  assets: Array<{ external_asset_id: string; name: string; attributes: SimulatedAttribute[] }>;
}

export interface SimulatedAdapterOptions {
  allowSimulated: boolean;
  scenario: SimulationScenario;
  now?: () => Date;
}

/**
 * Labeled synthetic data source for demonstrations and tests. It refuses to
 * construct unless simulation is explicitly allowed, and every event it emits
 * is attributed to the `simulated` provider.
 */
export class SimulatedAdapter implements ProviderAdapter {
  readonly provider = 'simulated' as const;
  readonly name = 'simulator';
  readonly version = '1.0.0';
  readonly simulated = true;
  readonly supportsHistory = true;
  private readonly scenario: SimulationScenario;
  private readonly now: () => Date;
  private nextTick = 0;
  private routes: RouteConfig[] = [];
  private paused = true;

  constructor(opts: SimulatedAdapterOptions) {
    if (!opts.allowSimulated) throw new SimulationDisabledError();
    if (!(opts.scenario.tick_seconds > 0)) throw new Error('tick_seconds must be positive');
    this.scenario = opts.scenario;
    this.now = opts.now ?? (() => new Date());
  }

  private tickTime(i: number): Date {
    return new Date(Date.parse(this.scenario.start_at) + i * this.scenario.tick_seconds * 1000);
  }

  private eventsForTick(i: number, routes: RouteConfig[], historical: boolean): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    for (const r of routes) {
      const asset = this.scenario.assets.find((a) => a.external_asset_id === r.external_asset_id);
      const attr = asset?.attributes.find((a) => a.name === r.external_attribute);
      if (!attr || attr.values.length === 0) continue;
      out.push({
        source_event_id: `sim:${r.external_asset_id}:${r.external_attribute}:${i}`,
        external_asset_id: r.external_asset_id,
        external_attribute: r.external_attribute,
        observed_at: this.tickTime(i).toISOString(),
        value: attr.values[i % attr.values.length]!,
        unit: attr.unit,
        quality: 'good',
        historical,
      });
    }
    return out;
  }

  async testConnection(): Promise<AdapterHealth> {
    return { connected: true, credential_expires_at: null, last_error: null };
  }

  async discoverAssets(): Promise<DiscoveredAsset[]> {
    return this.scenario.assets.map((a) => ({ external_asset_id: a.external_asset_id, name: a.name, attributes: this.attributes(a.external_asset_id) }));
  }

  private attributes(externalAssetId: string): DiscoveredAttribute[] {
    const asset = this.scenario.assets.find((a) => a.external_asset_id === externalAssetId);
    const t = this.currentTick();
    return (asset?.attributes ?? []).map((a) => ({
      name: a.name,
      value_type: a.value_type,
      unit: a.unit,
      sample: a.values.length ? { value: a.values[Math.max(t, 0) % a.values.length]!, observed_at: this.tickTime(Math.max(t, 0)).toISOString() } : null,
    }));
  }

  private currentTick(): number {
    return Math.floor((this.now().getTime() - Date.parse(this.scenario.start_at)) / (this.scenario.tick_seconds * 1000));
  }

  async discoverSignals(externalAssetId: string): Promise<DiscoveredAttribute[]> {
    return this.attributes(externalAssetId);
  }

  async previewMapping(route: Pick<RouteConfig, 'external_asset_id' | 'external_attribute'>): Promise<DiscoveredAttribute | null> {
    return this.attributes(route.external_asset_id).find((a) => a.name === route.external_attribute) ?? null;
  }

  async startIngestion(routes: RouteConfig[], checkpoint: string | null): Promise<void> {
    this.routes = routes;
    await this.resumeFromCheckpoint(checkpoint);
  }

  async resumeFromCheckpoint(checkpoint: string | null): Promise<void> {
    this.nextTick = checkpoint === null ? Math.max(this.currentTick(), 0) : Number(checkpoint) + 1;
    this.paused = false;
  }

  async pauseIngestion(): Promise<void> {
    this.paused = true;
  }

  async poll(maxEvents: number): Promise<PollResult> {
    if (this.paused) return { events: [], cursor: null };
    const events: ProviderEvent[] = [];
    let last: number | null = null;
    const current = this.currentTick();
    while (this.nextTick <= current) {
      const batch = this.eventsForTick(this.nextTick, this.routes, false);
      if (events.length + batch.length > maxEvents && events.length > 0) break;
      events.push(...batch);
      last = this.nextTick;
      this.nextTick++;
    }
    return { events, cursor: last === null ? null : String(last) };
  }

  async backfill(from: Date, to: Date, routes: RouteConfig[]): Promise<ProviderEvent[]> {
    const step = this.scenario.tick_seconds * 1000;
    const start = Math.ceil((from.getTime() - Date.parse(this.scenario.start_at)) / step);
    const end = Math.floor((to.getTime() - Date.parse(this.scenario.start_at)) / step);
    const out: ProviderEvent[] = [];
    for (let i = Math.max(start, 0); i <= end; i++) out.push(...this.eventsForTick(i, routes, true));
    return out;
  }

  async health(): Promise<AdapterHealth> {
    return { connected: !this.paused, credential_expires_at: null, last_error: null };
  }
}
