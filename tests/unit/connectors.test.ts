import { describe, expect, it } from 'vitest';
import { COMPATIBILITY_MATRIX, ConnectorRunner, MaintenanceIngestClient, SimulatedAdapter, SimulationDisabledError, createProviderAdapter, deterministicSourceKey, type ProviderEvent } from '@vm/connectors';

const sample: ProviderEvent = {
  source_event_id: null,
  external_asset_id: 'ext-1',
  external_attribute: 'temp',
  observed_at: '2026-10-13T00:00:00.000Z',
  value: 90,
  unit: 'C',
  quality: 'good',
  historical: false,
};

describe('connector contract', () => {
  it('qualifies neither Live nor OpenRemote from mocked results', () => {
    expect(COMPATIBILITY_MATRIX.find((e) => e.provider === 'visibility_live')?.status).toBe('not_qualified');
    expect(COMPATIBILITY_MATRIX.find((e) => e.provider === 'openremote')?.status).toBe('not_qualified');
    expect(() => createProviderAdapter('visibility_live')).toThrow(/not qualified/);
    expect(() => createProviderAdapter('openremote')).toThrow(/not qualified/);
  });

  it('refuses to construct the simulator unless explicitly allowed', () => {
    const scenario = { start_at: '2026-10-13T00:00:00Z', tick_seconds: 60, assets: [] };
    expect(() => new SimulatedAdapter({ allowSimulated: false, scenario })).toThrow(SimulationDisabledError);
    expect(new SimulatedAdapter({ allowSimulated: true, scenario }).simulated).toBe(true);
  });

  it('derives a deterministic source key without inventing sequence IDs', () => {
    const a = deterministicSourceKey('inst-a', sample);
    const b = deterministicSourceKey('inst-a', { external_asset_id: sample.external_asset_id, external_attribute: sample.external_attribute, observed_at: sample.observed_at, value: sample.value });
    expect(a).toBe(b);
    expect(a.startsWith('det:')).toBe(true);
    expect(deterministicSourceKey('inst-b', sample)).not.toBe(a);
    expect(() => deterministicSourceKey('inst-a', { ...sample, observed_at: null })).toThrow(/timestamp/);
  });

  it('buffers during delivery failure and advances the checkpoint only after a successful ingest', async () => {
    const adapter = new SimulatedAdapter({
      allowSimulated: true,
      now: () => new Date('2026-10-13T00:02:00Z'),
      scenario: {
        start_at: '2026-10-13T00:00:00Z',
        tick_seconds: 60,
        assets: [{ external_asset_id: 'ext-1', name: 'Lifter', attributes: [{ name: 'temp', value_type: 'number', unit: 'C', values: [80, 90, 100] }] }],
      },
    });
    let ingestCalls = 0;
    let lastCheckpoint: string | null = null;
    const client = new MaintenanceIngestClient(async (method, path, body) => {
      if (method === 'GET') {
        return {
          status: 200,
          body: {
            connector: { id: 'c1', tenant_id: 't', site_id: 's', provider: 'simulated', provider_instance: 'demo', status: 'active', simulated: true },
            routes: [{ route_id: 'r1', asset_id: 'a1', signal_key: 'temperature', kind: 'reading', external_asset_id: 'ext-1', external_attribute: 'temp', value_type: 'number', source_unit: 'C', routing_epoch: 1, freshness_seconds: 3600 }],
            checkpoints: {},
          },
        };
      }
      if (path.endsWith('/discovery') || path.endsWith('/health')) return { status: 200, body: { ok: true } };
      ingestCalls++;
      if (ingestCalls === 1) return { status: 503, body: { error: { code: 'unavailable', message: 'down' } } };
      lastCheckpoint = (body as { checkpoint: { cursor: string } | null }).checkpoint?.cursor ?? null;
      const events = (body as { events: unknown[] }).events;
      return { status: 200, body: { results: events.map((_, i) => ({ index: i, source_event_id: `sim:ext-1:temp:${i}`, status: 'recorded', decision: 'current', receipt_id: `r${i}`, reason: null })) } };
    }, 'c1');
    const runner = new ConnectorRunner(adapter, client, { bufferCapacity: 1000, batchSize: 50, maxBackoffMs: 0, now: () => new Date('2026-10-13T00:02:00Z') });
    await runner.start();
    const failed = await runner.tick();
    expect(failed.delivered).toBe(0);
    expect(runner.backlog).toBeGreaterThan(0);
    const ok = await runner.tick();
    expect(ok.delivered).toBeGreaterThan(0);
    expect(runner.backlog).toBe(0);
    expect(lastCheckpoint).not.toBeNull();
  });
});
