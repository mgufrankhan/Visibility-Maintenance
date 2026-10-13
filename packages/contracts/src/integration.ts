import { z } from 'zod';
import { isoTimestamp, priority, uuid } from './common.ts';

export const CONNECTOR_PROVIDERS = ['visibility_live', 'openremote', 'simulated'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const SIGNAL_KINDS = ['reading', 'alarm', 'meter'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const EVENT_QUALITIES = ['good', 'uncertain', 'bad'] as const;

export const signalKey = z.string().regex(/^[a-z][a-z0-9_.]{0,79}$/, 'lowercase letters, digits, "_" or "."');

/**
 * MC-01 normalized envelope. observed_at is nullable so a missing source time is
 * reported as missing rather than synthesized. asset_id/signal_id are optional
 * hints: the server resolves the canonical pair from the active route.
 */
export const normalizedEvent = z
  .object({
    schema_version: z.literal(1),
    event_id: z.string().min(1).max(200),
    tenant_id: uuid,
    site_id: uuid,
    connector_instance_id: uuid,
    source_system: z.string().min(1).max(100),
    source_event_id: z.string().min(1).max(300),
    external_asset_id: z.string().min(1).max(300),
    external_attribute: z.string().min(1).max(300),
    asset_id: uuid.nullable().default(null),
    signal_id: signalKey.nullable().default(null),
    observed_at: isoTimestamp.nullable(),
    received_at: isoTimestamp,
    value: z.union([z.number(), z.boolean(), z.string().max(500), z.null()]),
    unit: z.string().max(40).nullable(),
    quality: z.enum(EVENT_QUALITIES),
    routing_epoch: z.number().int().min(0),
    historical: z.boolean(),
  })
  .strict();
export type NormalizedEvent = z.infer<typeof normalizedEvent>;

export const ingestBatchRequest = z
  .object({
    connector_id: uuid,
    // Each event is validated individually so one malformed event cannot block a batch.
    events: z.array(z.unknown()).max(500).default([]),
    checkpoint: z.object({ stream: z.string().min(1).max(100), cursor: z.string().min(1).max(1000) }).nullable().default(null),
  })
  .refine((b) => b.events.length > 0 || b.checkpoint !== null, { message: 'A batch must include events or a checkpoint' });

export const INGEST_DECISIONS = [
  'current',
  'historical',
  'stale',
  'out_of_window',
  'uncertain_quality',
  'route_paused',
  'fenced_epoch',
  'quarantined_unmapped',
  'quarantined_unit',
  'quarantined_quality',
  'quarantined_invalid',
] as const;
export type IngestDecision = (typeof INGEST_DECISIONS)[number];

export interface IngestResult {
  index: number;
  source_event_id: string | null;
  status: 'recorded' | 'duplicate' | 'collision' | 'rejected';
  decision: IngestDecision | null;
  receipt_id: string | null;
  reason: string | null;
}

export const discoveryReport = z.object({
  connector_id: uuid,
  assets: z
    .array(
      z.object({
        external_asset_id: z.string().min(1).max(300),
        name: z.string().max(300).nullable().default(null),
        attributes: z
          .array(
            z.object({
              name: z.string().min(1).max(300),
              value_type: z.enum(['number', 'boolean', 'string']),
              unit: z.string().max(40).nullable().default(null),
              sample: z.object({ value: z.union([z.number(), z.boolean(), z.string().max(500), z.null()]), observed_at: isoTimestamp.nullable() }).nullable().default(null),
            }),
          )
          .max(500),
      }),
    )
    .max(2000),
});

export const healthReport = z.object({
  connector_id: uuid,
  adapter: z.object({ name: z.string().max(100), version: z.string().max(50), simulated: z.boolean() }),
  connected: z.boolean(),
  backlog: z.number().int().min(0),
  buffer_capacity: z.number().int().positive(),
  oldest_buffered_at: isoTimestamp.nullable(),
  gaps: z.array(z.object({ from: isoTimestamp, to: isoTimestamp, backfill: z.enum(['pending', 'complete', 'unavailable']) })).max(100).default([]),
  credential_expires_at: isoTimestamp.nullable(),
  last_error: z.string().max(2000).nullable(),
});

export const createConnectorRequest = z.object({
  site_id: uuid,
  provider: z.enum(CONNECTOR_PROVIDERS),
  name: z.string().min(1).max(200),
  provider_instance: z.string().min(1).max(200),
  secret_ref: z.string().regex(/^[A-Za-z0-9_.\/-]{1,200}$/).nullable().default(null),
  service_account_id: uuid,
});

export const recordStatusRequest = z.object({
  record_version: z.number().int().positive(),
  reason: z.string().min(3).max(2000),
});

export const createMappingRequest = z
  .object({
    asset_id: uuid,
    signal_key: signalKey,
    kind: z.enum(SIGNAL_KINDS),
    external_asset_id: z.string().min(1).max(300),
    external_attribute: z.string().min(1).max(300),
    source_unit: z.string().min(1).max(40).nullable().default(null),
    target_unit: z.string().min(1).max(40).nullable().default(null),
    conversion: z.object({ factor: z.number().finite().refine((f) => f !== 0, 'factor cannot be zero'), offset: z.number().finite() }).default({ factor: 1, offset: 0 }),
    freshness_seconds: z.number().int().min(1).max(604800),
    evaluation_window_seconds: z.number().int().min(0).max(86400).default(300),
    correlation_group: signalKey.nullable().default(null),
  })
  .refine((m) => m.kind === 'alarm' || (m.source_unit !== null && m.target_unit !== null), { message: 'Readings and meters require source and target units', path: ['source_unit'] });

export const startCutoverRequest = z.object({
  to_mapping_id: uuid,
  reason: z.string().min(3).max(2000),
  /** Required for meter routes: whether the replacement reports the same physical counter. */
  meter_continuity: z.enum(['same_counter', 'rebaseline']).nullable().default(null),
});

export const resolveReviewItemRequest = z.object({
  status: z.enum(['resolved', 'dismissed']),
  resolution: z.string().min(3).max(2000),
});

export const createConditionRuleRequest = z.object({
  site_id: uuid,
  asset_id: uuid,
  signal_key: signalKey,
  name: z.string().min(1).max(200),
});

export const conditionRuleRevisionRequest = z.object({
  operator: z.enum(['gt', 'gte', 'lt', 'lte']),
  threshold: z.number().finite(),
  unit: z.string().min(1).max(40),
  duration_seconds: z.number().int().min(0).max(86400),
  hysteresis: z.number().finite().min(0).default(0),
  cooldown_seconds: z.number().int().min(0).max(2592000),
  priority: priority.default('normal'),
  team_id: uuid,
  correlation_group: signalKey.nullable().default(null),
});

export const createMeterRequest = z.object({
  site_id: uuid,
  asset_id: uuid,
  signal_key: signalKey,
  name: z.string().min(1).max(200),
  unit: z.string().min(1).max(40),
  freshness_seconds: z.number().int().min(60).max(2592000),
});

export const manualMeterReadingRequest = z.object({
  value: z.number().finite().min(0),
  observed_at: isoTimestamp,
  client_entry_id: z.string().min(1).max(100).nullable().default(null),
});

export const meterBaselineRequest = z.object({
  kind: z.enum(['reset', 'replacement']),
  new_raw: z.number().finite().min(0),
  reason: z.string().min(3).max(2000),
  record_version: z.number().int().positive(),
});
