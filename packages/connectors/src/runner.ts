import { randomUUID } from 'node:crypto';
import type { ConnectorProvider, IngestResult, NormalizedEvent } from '@vm/contracts';
import type { ProviderAdapter, ProviderEvent, RouteConfig } from './adapter.ts';
import { deterministicSourceKey } from './source-key.ts';

export interface RunnerConfig {
  connector: { id: string; tenant_id: string; site_id: string; provider: ConnectorProvider; provider_instance: string; status: string; simulated: boolean };
  routes: RouteConfig[];
  checkpoints: Record<string, string>;
}

export interface Transport {
  (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

/** Maintenance ingestion API as seen by a connector runtime authenticated as its service identity. */
export class MaintenanceIngestClient {
  constructor(
    private readonly transport: Transport,
    private readonly connectorId: string,
  ) {}

  async config(): Promise<RunnerConfig> {
    const r = await this.transport('GET', `/api/v1/maintenance/connectors/${this.connectorId}/config`);
    if (r.status !== 200) throw new IngestHttpError(r.status, r.body);
    return r.body as RunnerConfig;
  }

  async ingest(events: NormalizedEvent[], checkpoint: { stream: string; cursor: string } | null): Promise<IngestResult[]> {
    const r = await this.transport('POST', '/api/v1/maintenance/integrations/events', { connector_id: this.connectorId, events, checkpoint });
    if (r.status !== 200) throw new IngestHttpError(r.status, r.body);
    return r.body.results as IngestResult[];
  }

  async reportDiscovery(assets: unknown[]): Promise<void> {
    const r = await this.transport('POST', '/api/v1/maintenance/integrations/discovery', { connector_id: this.connectorId, assets });
    if (r.status !== 200) throw new IngestHttpError(r.status, r.body);
  }

  async reportHealth(report: Record<string, unknown>): Promise<void> {
    const r = await this.transport('POST', '/api/v1/maintenance/integrations/health', { connector_id: this.connectorId, ...report });
    if (r.status !== 200) throw new IngestHttpError(r.status, r.body);
  }
}

export class IngestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Maintenance ingestion returned ${status}: ${JSON.stringify(body)?.slice(0, 300)}`);
    this.name = 'IngestHttpError';
  }
  /** Transient: retry with backoff while buffering. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

export interface RunnerOptions {
  stream?: string;
  /** Maximum buffered events (qualified capacity, e.g. 72 h at pilot rate). */
  bufferCapacity: number;
  batchSize?: number;
  /** Buffered events older than this when delivered are marked historical (MC-05). */
  historicalAfterSeconds?: number;
  maxBackoffMs?: number;
  now?: () => Date;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

interface BufferedGroup {
  events: NormalizedEvent[];
  cursor: string | null;
}

/**
 * Pulls from a provider adapter, buffers within capacity and delivers at least
 * once. The provider checkpoint is only advanced through the same request that
 * commits receipt, so a crash replays rather than loses events.
 */
export class ConnectorRunner {
  private config: RunnerConfig | null = null;
  private buffer: BufferedGroup[] = [];
  private failures = 0;
  private retryAt = 0;
  private lastError: string | null = null;
  private readonly stream: string;
  private readonly now: () => Date;

  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly client: MaintenanceIngestClient,
    private readonly opts: RunnerOptions,
  ) {
    this.stream = opts.stream ?? 'default';
    this.now = opts.now ?? (() => new Date());
  }

  get backlog(): number {
    return this.buffer.reduce((n, g) => n + g.events.length, 0);
  }

  async start(): Promise<void> {
    this.config = await this.client.config();
    if (this.config.connector.provider !== this.adapter.provider) {
      throw new Error(`Connector is configured for ${this.config.connector.provider}, adapter is ${this.adapter.provider}`);
    }
    await this.adapter.startIngestion(this.config.routes, this.config.checkpoints[this.stream] ?? null);
    await this.client.reportDiscovery(await this.adapter.discoverAssets());
  }

  async refreshConfig(): Promise<void> {
    this.config = await this.client.config();
  }

  private normalize(e: ProviderEvent): NormalizedEvent {
    const c = this.config!.connector;
    const route = this.config!.routes.find((r) => r.external_asset_id === e.external_asset_id && r.external_attribute === e.external_attribute);
    const sourceEventId = e.source_event_id ?? (e.observed_at ? deterministicSourceKey(c.provider_instance, e) : `unkeyed:${randomUUID()}`);
    return {
      schema_version: 1,
      event_id: randomUUID(),
      tenant_id: c.tenant_id,
      site_id: c.site_id,
      connector_instance_id: c.id,
      source_system: c.provider,
      source_event_id: sourceEventId,
      external_asset_id: e.external_asset_id,
      external_attribute: e.external_attribute,
      asset_id: route?.asset_id ?? null,
      signal_id: route?.signal_key ?? null,
      observed_at: e.observed_at,
      received_at: this.now().toISOString(),
      value: e.value,
      unit: e.unit,
      quality: e.quality,
      routing_epoch: route?.routing_epoch ?? 0,
      historical: e.historical,
    };
  }

  /** One cycle: pull while within capacity, then deliver buffered groups oldest first. */
  async tick(): Promise<{ polled: number; delivered: number; results: IngestResult[] }> {
    if (!this.config) throw new Error('Runner not started');
    const batchSize = this.opts.batchSize ?? 200;
    let polled = 0;
    const room = this.opts.bufferCapacity - this.backlog;
    if (room > 0) {
      const r = await this.adapter.poll(Math.min(room, batchSize));
      if (r.events.length || r.cursor !== null) {
        this.buffer.push({ events: r.events.map((e) => this.normalize(e)), cursor: r.cursor });
        polled = r.events.length;
      }
    } else {
      this.opts.log?.('buffer full; pausing provider reads until delivery resumes', { capacity: this.opts.bufferCapacity });
    }

    let delivered = 0;
    const results: IngestResult[] = [];
    while (this.buffer.length && this.now().getTime() >= this.retryAt) {
      const groups: BufferedGroup[] = [];
      let count = 0;
      for (const g of this.buffer) {
        if (groups.length && count + g.events.length > 500) break;
        groups.push(g);
        count += g.events.length;
      }
      const cutoff = this.now().getTime() - (this.opts.historicalAfterSeconds ?? 300) * 1000;
      const events = groups.flatMap((g) => g.events).map((e) => (!e.historical && e.observed_at && Date.parse(e.observed_at) < cutoff ? { ...e, historical: true } : e));
      const cursor = [...groups].reverse().find((g) => g.cursor !== null)?.cursor ?? null;
      try {
        if (events.length) results.push(...(await this.client.ingest(events, cursor ? { stream: this.stream, cursor } : null)));
        else if (cursor) await this.client.ingest([], { stream: this.stream, cursor });
        this.buffer.splice(0, groups.length);
        delivered += events.length;
        this.failures = 0;
        this.lastError = null;
      } catch (err) {
        this.failures++;
        this.lastError = (err as Error).message;
        const backoff = Math.min((this.opts.maxBackoffMs ?? 300_000), 1000 * 2 ** Math.min(this.failures, 20));
        this.retryAt = this.now().getTime() + backoff;
        this.opts.log?.('delivery failed; buffering', { error: this.lastError, backlog: this.backlog, retry_in_ms: backoff });
        if (err instanceof IngestHttpError && !err.retryable) throw err;
        break;
      }
    }
    if (results.some((r) => r.decision === 'fenced_epoch')) await this.refreshConfig().catch(() => undefined);
    return { polled, delivered, results };
  }

  async reportHealth(): Promise<void> {
    const h = await this.adapter.health().catch((err: Error) => ({ connected: false, credential_expires_at: null, last_error: err.message }));
    const oldest = this.buffer.flatMap((g) => g.events).reduce<string | null>((min, e) => (e.observed_at && (!min || e.observed_at < min) ? e.observed_at : min), null);
    await this.client.reportHealth({
      adapter: { name: this.adapter.name, version: this.adapter.version, simulated: this.adapter.simulated },
      connected: h.connected,
      backlog: this.backlog,
      buffer_capacity: this.opts.bufferCapacity,
      oldest_buffered_at: oldest,
      gaps: [],
      credential_expires_at: h.credential_expires_at,
      last_error: this.lastError ?? h.last_error,
    });
  }
}
