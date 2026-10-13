import { createHash, randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import {
  canonicalJson,
  normalizedEvent,
  type IngestDecision,
  type IngestResult,
  type NormalizedEvent,
  type createConnectorRequest,
  type createMappingRequest,
  type discoveryReport,
  type healthReport,
  type ingestBatchRequest,
  type recordStatusRequest,
  type resolveReviewItemRequest,
  type startCutoverRequest,
} from '@vm/contracts';
import { can, canAny, sitesWith } from '@vm/policy';
import { RegistryRequestError } from '@vm/registry';
import { AppError, conflict, forbidden, invalid, notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import { processAlarm, evaluateReading, type CurrentSignalEvent } from './conditions.ts';
import type { Actor, Services } from './context.ts';
import { resolveAsset } from './identity-snapshots.ts';
import { applyMeterReading } from './meters.ts';
import { iso, writeAudit } from './records.ts';

type Conversion = { factor: number; offset: number };

function convert(value: number, c: Conversion): number {
  return value * c.factor + c.offset;
}

function payloadHash(e: Pick<NormalizedEvent, 'value' | 'unit' | 'quality' | 'observed_at' | 'historical' | 'routing_epoch' | 'external_asset_id' | 'external_attribute'>): string {
  return createHash('sha256').update(canonicalJson(e)).digest('hex');
}

function connectorDto(c: Record<string, any>) {
  return {
    id: c.id,
    site_id: c.site_id,
    provider: c.provider,
    name: c.name,
    provider_instance: c.provider_instance,
    secret_ref: c.secret_ref,
    service_account_id: c.service_account_id,
    status: c.status,
    status_reason: c.status_reason,
    simulated: c.simulated,
    last_receipt_at: iso(c.last_receipt_at),
    last_report: c.last_report,
    last_report_at: iso(c.last_report_at),
    version: c.version,
  };
}

function routeDto(r: Record<string, any>) {
  return {
    id: r.id,
    connector_id: r.connector_id,
    site_id: r.site_id,
    asset_id: r.asset_id,
    signal_key: r.signal_key,
    kind: r.kind,
    external_asset_id: r.external_asset_id,
    external_attribute: r.external_attribute,
    value_type: r.value_type,
    source_unit: r.source_unit,
    target_unit: r.target_unit,
    conversion: r.conversion,
    freshness_seconds: r.freshness_seconds,
    evaluation_window_seconds: r.evaluation_window_seconds,
    correlation_group: r.correlation_group,
    status: r.status,
    status_reason: r.status_reason,
    routing_epoch: r.routing_epoch,
    preview: r.preview,
    previewed_at: iso(r.previewed_at),
    approved_at: iso(r.approved_at),
    activated_at: iso(r.activated_at),
    last_observed_at: iso(r.last_observed_at),
    last_receipt_at: iso(r.last_receipt_at),
    version: r.version,
  };
}

async function loadConnector(db: Queryable, actor: Actor, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM integration.connector WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const c = rows[0];
  if (!c || !canAny(actor.principal, ['maintenance.view', 'maintenance.event.ingest'], c.site_id)) throw notFound('Connector');
  return c;
}

function ingestActorMatches(actor: Actor, connector: Record<string, any>): boolean {
  return actor.principal.kind === 'service' && actor.principal.userId === connector.service_account_id;
}

function requireIngest(actor: Actor, connector: Record<string, any>): void {
  requirePermission(actor.principal, 'maintenance.event.ingest', connector.site_id);
  if (!ingestActorMatches(actor, connector)) throw forbidden();
}

export async function createConnector(s: Services, actor: Actor, input: z.infer<typeof createConnectorRequest>) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.integration.manage', input.site_id);
  await s.entitlements.require(p.tenantId, 'connected.configure');
  if (input.provider === 'simulated' && !s.config.allowSimulatedConnectors) {
    throw new AppError(409, 'simulation_disabled', 'Simulated connectors are disabled. Set ALLOW_SIMULATED_CONNECTORS=true only in demonstration or test environments.');
  }
  if (input.provider !== 'simulated' && input.provider !== 'visibility_live' && input.provider !== 'openremote') {
    const never: never = input.provider;
    throw invalid(`Unknown provider ${String(never)}`);
  }
  const directory = await s.registry.directory(actor.token, input.site_id);
  if (!directory.some((d) => d.id === input.service_account_id && d.kind === 'service')) {
    throw invalid('Service account must be a member of this site', { service_account_id: ['Unknown service account for this site'] });
  }
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    try {
      const { rows } = await tx.query(
        `INSERT INTO integration.connector
           (id, tenant_id, site_id, provider, name, provider_instance, secret_ref, service_account_id, simulated, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, p.tenantId, input.site_id, input.provider, input.name, input.provider_instance, input.secret_ref, input.service_account_id, input.provider === 'simulated', p.userId],
      );
      await writeAudit(tx, actor, { siteId: input.site_id, action: 'connector.created', targetType: 'connector', targetId: id, afterVersion: 1, detail: { provider: input.provider, simulated: input.provider === 'simulated' } });
      return connectorDto(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('duplicate_connector', 'A connector for this provider instance already exists at the site');
      throw err;
    }
  });
}

export async function listConnectors(s: Services, actor: Actor, q: { site_id?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const { rows } = await s.db.query(`SELECT * FROM integration.connector WHERE tenant_id = $1 AND site_id = ANY($2::uuid[]) ORDER BY name, id`, [actor.principal.tenantId, sites]);
  return rows.map(connectorDto);
}

export async function getConnector(s: Services, actor: Actor, id: string) {
  const c = await loadConnector(s.db, actor, id);
  const [routes, reviews] = await Promise.all([
    s.db.query(`SELECT * FROM integration.signal_route WHERE connector_id = $1 ORDER BY signal_key, id`, [c.id]),
    s.db.query(`SELECT id, kind, subject, occurrences, first_seen_at, last_seen_at, status FROM integration.review_item WHERE connector_id = $1 AND status = 'open' ORDER BY last_seen_at DESC LIMIT 50`, [c.id]),
  ]);
  return { ...connectorDto(c), mappings: routes.rows.map(routeDto), open_review_items: reviews.rows.map((r) => ({ ...r, first_seen_at: iso(r.first_seen_at), last_seen_at: iso(r.last_seen_at) })) };
}

export async function setConnectorStatus(s: Services, actor: Actor, id: string, status: 'active' | 'paused' | 'disabled', input: z.infer<typeof recordStatusRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const c = await loadConnector(tx, actor, id, true);
    requirePermission(p, 'maintenance.integration.manage', c.site_id);
    await s.entitlements.require(p.tenantId, 'connected.configure');
    if (c.version !== input.record_version) throw staleVersion(c.version);
    if (status === 'active' && c.status === 'disabled') throw conflict('invalid_state', 'A disabled connector cannot be reactivated; create a replacement');
    if (status === 'active' && c.status === 'draft') {
      /* first activation from draft is allowed */
    } else if (status === 'paused' && c.status !== 'active') {
      throw conflict('invalid_state', `Connector is ${c.status}`);
    } else if (status === 'active' && c.status !== 'paused' && c.status !== 'draft') {
      throw conflict('invalid_state', `Connector is ${c.status}`);
    } else if (status === 'disabled' && c.status === 'disabled') {
      throw conflict('invalid_state', 'Connector is already disabled');
    }
    const { rows } = await tx.query(
      `UPDATE integration.connector SET status = $2, status_reason = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [c.id, status, input.reason],
    );
    await writeAudit(tx, actor, { siteId: c.site_id, action: `connector.${status}`, targetType: 'connector', targetId: c.id, beforeVersion: c.version, afterVersion: c.version + 1, reason: input.reason });
    return connectorDto(rows[0]);
  });
}

export async function createMapping(s: Services, actor: Actor, connectorId: string, input: z.infer<typeof createMappingRequest>) {
  const p = actor.principal;
  const c = await loadConnector(s.db, actor, connectorId);
  requirePermission(p, 'maintenance.integration.manage', c.site_id);
  await s.entitlements.require(p.tenantId, 'connected.configure');
  const asset = await resolveAsset(s, actor, input.asset_id);
  if (asset.site_id !== c.site_id) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  const valueType = input.kind === 'alarm' ? 'boolean' : 'number';
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO integration.signal_route
         (id, tenant_id, site_id, connector_id, asset_id, signal_key, kind, external_asset_id, external_attribute, value_type,
          source_unit, target_unit, conversion, freshness_seconds, evaluation_window_seconds, correlation_group, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        id, p.tenantId, c.site_id, c.id, asset.asset_id, input.signal_key, input.kind, input.external_asset_id, input.external_attribute, valueType,
        input.source_unit, input.target_unit, JSON.stringify(input.conversion), input.freshness_seconds, input.evaluation_window_seconds,
        input.correlation_group ?? input.signal_key, p.userId,
      ],
    );
    await writeAudit(tx, actor, { siteId: c.site_id, action: 'mapping.drafted', targetType: 'signal_route', targetId: id, detail: { connector_id: c.id, signal_key: input.signal_key, kind: input.kind } });
    return routeDto(rows[0]);
  });
}

async function registryMapping(s: Services, actor: Actor, connector: Record<string, any>, externalAssetId: string, assetId: string): Promise<void> {
  try {
    const ref = await s.registry.lookupExternalRef(actor.token, { provider: connector.provider, provider_instance: connector.provider_instance, external_id: externalAssetId });
    if (!ref || ref.asset_id !== assetId) {
      throw invalid('Activate requires an active registry external identity mapping for this provider instance and asset', { external_asset_id: ['No matching registry external reference'] });
    }
  } catch (err) {
    if (err instanceof RegistryRequestError && (err.status === 403 || err.status === 404)) {
      throw invalid('Activate requires an active registry external identity mapping for this provider instance and asset', { external_asset_id: ['No matching registry external reference'] });
    }
    throw err;
  }
}

export async function previewMapping(s: Services, actor: Actor, mappingId: string) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM integration.signal_route WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, mappingId]);
    const r = rows[0];
    if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Mapping');
    requirePermission(p, 'maintenance.integration.manage', r.site_id);
    const { rows: disc } = await tx.query(
      `SELECT value_type, unit, sample_value, sample_observed_at FROM integration.discovered_signal WHERE connector_id = $1 AND external_asset_id = $2 AND external_attribute = $3`,
      [r.connector_id, r.external_asset_id, r.external_attribute],
    );
    const sample = disc[0];
    const issues: string[] = [];
    if (!sample) issues.push('No discovery sample is available for this source attribute');
    else {
      if (sample.value_type !== r.value_type && !(sample.value_type === 'number' && r.value_type === 'number')) issues.push(`Discovered type ${sample.value_type} does not match mapping type ${r.value_type}`);
      if (r.kind !== 'alarm' && sample.unit && sample.unit !== r.source_unit) issues.push(`Discovered unit ${sample.unit} does not match mapping source unit ${r.source_unit}`);
    }
    const preview = { ok: issues.length === 0, issues, sample: sample ? { value: sample.sample_value, unit: sample.unit, observed_at: iso(sample.sample_observed_at) } : null };
    const { rows: u } = await tx.query(`UPDATE integration.signal_route SET preview = $2, previewed_at = $3, version = version + 1 WHERE id = $1 RETURNING *`, [r.id, JSON.stringify(preview), s.clock.now()]);
    return routeDto(u[0]);
  });
}

export async function approveMapping(s: Services, actor: Actor, mappingId: string, input: z.infer<typeof recordStatusRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM integration.signal_route WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, mappingId]);
    const r = rows[0];
    if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Mapping');
    requirePermission(p, 'maintenance.integration.manage', r.site_id);
    await s.entitlements.require(p.tenantId, 'connected.configure');
    if (r.version !== input.record_version) throw staleVersion(r.version);
    if (r.status !== 'draft' && r.status !== 'review_required') throw conflict('invalid_state', `Mapping is ${r.status}`);
    const { rows: u } = await tx.query(
      `UPDATE integration.signal_route SET status = 'approved', status_reason = $2, approved_by = $3, approved_at = $4, version = version + 1 WHERE id = $1 RETURNING *`,
      [r.id, input.reason, p.userId, s.clock.now()],
    );
    await writeAudit(tx, actor, { siteId: r.site_id, action: 'mapping.approved', targetType: 'signal_route', targetId: r.id, beforeVersion: r.version, afterVersion: r.version + 1, reason: input.reason });
    return routeDto(u[0]);
  });
}

export async function activateMapping(s: Services, actor: Actor, mappingId: string, input: z.infer<typeof recordStatusRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM integration.signal_route WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, mappingId]);
    const r = rows[0];
    if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Mapping');
    requirePermission(p, 'maintenance.integration.manage', r.site_id);
    await s.entitlements.require(p.tenantId, 'connected.configure');
    if (r.version !== input.record_version) throw staleVersion(r.version);
    if (r.status !== 'approved' && r.status !== 'paused') throw conflict('invalid_state', `Mapping is ${r.status}`);
    const { rows: cRows } = await tx.query(`SELECT * FROM integration.connector WHERE id = $1`, [r.connector_id]);
    const c = cRows[0]!;
    await registryMapping(s, actor, c, r.external_asset_id, r.asset_id);
    if (r.kind === 'meter') {
      const { rows: m } = await tx.query(`SELECT unit FROM maintenance.meter WHERE tenant_id = $1 AND asset_id = $2 AND signal_key = $3`, [p.tenantId, r.asset_id, r.signal_key]);
      if (!m[0]) throw invalid('Meter mappings require a meter for this asset and signal', { signal_key: ['Create the meter first'] });
      if (m[0].unit !== r.target_unit) throw invalid(`Meter unit ${m[0].unit} does not match mapping target unit ${r.target_unit}`, { target_unit: ['Units must match'] });
    }
    const { rows: competing } = await tx.query(
      `SELECT id FROM integration.signal_route WHERE tenant_id = $1 AND asset_id = $2 AND signal_key = $3 AND status = 'active' AND id <> $4`,
      [p.tenantId, r.asset_id, r.signal_key, r.id],
    );
    if (competing[0]) throw conflict('active_route_exists', 'Another active route already supplies this asset signal; use an approved cutover to switch sources');
    const epoch = r.status === 'paused' ? r.routing_epoch : Math.max(r.routing_epoch, 1);
    const now = s.clock.now();
    const { rows: u } = await tx.query(
      `UPDATE integration.signal_route SET status = 'active', status_reason = NULL, routing_epoch = $2, activated_at = coalesce(activated_at, $3), version = version + 1 WHERE id = $1 RETURNING *`,
      [r.id, epoch, now],
    );
    await writeAudit(tx, actor, { siteId: r.site_id, action: 'mapping.activated', targetType: 'signal_route', targetId: r.id, beforeVersion: r.version, afterVersion: r.version + 1, reason: input.reason, detail: { routing_epoch: epoch } });
    return routeDto(u[0]);
  });
}

export async function pauseMapping(s: Services, actor: Actor, mappingId: string, input: z.infer<typeof recordStatusRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM integration.signal_route WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, mappingId]);
    const r = rows[0];
    if (!r || !can(p, 'maintenance.view', r.site_id)) throw notFound('Mapping');
    requirePermission(p, 'maintenance.integration.manage', r.site_id);
    if (r.version !== input.record_version) throw staleVersion(r.version);
    if (r.status !== 'active') throw conflict('invalid_state', `Mapping is ${r.status}`);
    const { rows: u } = await tx.query(`UPDATE integration.signal_route SET status = 'paused', status_reason = $2, version = version + 1 WHERE id = $1 RETURNING *`, [r.id, input.reason]);
    await writeAudit(tx, actor, { siteId: r.site_id, action: 'mapping.paused', targetType: 'signal_route', targetId: r.id, beforeVersion: r.version, afterVersion: r.version + 1, reason: input.reason });
    return routeDto(u[0]);
  });
}

/** Runtime configuration for an authenticated connector service (no secrets). */
export async function connectorRuntimeConfig(s: Services, actor: Actor, connectorId: string) {
  const c = await loadConnector(s.db, actor, connectorId);
  requireIngest(actor, c);
  const [routes, checkpoints] = await Promise.all([
    s.db.query(
      `SELECT id, asset_id, signal_key, kind, external_asset_id, external_attribute, value_type, source_unit, routing_epoch, freshness_seconds
         FROM integration.signal_route WHERE connector_id = $1 AND status IN ('active','paused')`,
      [c.id],
    ),
    s.db.query(`SELECT stream, cursor FROM integration.checkpoint WHERE connector_id = $1`, [c.id]),
  ]);
  return {
    connector: { id: c.id, tenant_id: c.tenant_id, site_id: c.site_id, provider: c.provider, provider_instance: c.provider_instance, status: c.status, simulated: c.simulated },
    routes: routes.rows.map((r) => ({
      route_id: r.id,
      asset_id: r.asset_id,
      signal_key: r.signal_key,
      kind: r.kind,
      external_asset_id: r.external_asset_id,
      external_attribute: r.external_attribute,
      value_type: r.value_type,
      source_unit: r.source_unit,
      routing_epoch: r.routing_epoch,
      freshness_seconds: r.freshness_seconds,
    })),
    checkpoints: Object.fromEntries(checkpoints.rows.map((r) => [r.stream, r.cursor])),
  };
}

export async function reportDiscovery(s: Services, actor: Actor, input: z.infer<typeof discoveryReport>) {
  const c = await loadConnector(s.db, actor, input.connector_id);
  requireIngest(actor, c);
  const now = s.clock.now();
  await withTransaction(s.db, async (tx) => {
    for (const asset of input.assets) {
      for (const attr of asset.attributes) {
        await tx.query(
          `INSERT INTO integration.discovered_signal
             (tenant_id, connector_id, external_asset_id, external_asset_name, external_attribute, value_type, unit, sample_value, sample_observed_at, reported_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (connector_id, external_asset_id, external_attribute) DO UPDATE SET
             external_asset_name = EXCLUDED.external_asset_name, value_type = EXCLUDED.value_type, unit = EXCLUDED.unit,
             sample_value = EXCLUDED.sample_value, sample_observed_at = EXCLUDED.sample_observed_at, reported_at = EXCLUDED.reported_at`,
          [c.tenant_id, c.id, asset.external_asset_id, asset.name, attr.name, attr.value_type, attr.unit, attr.sample ? JSON.stringify(attr.sample.value) : null, attr.sample?.observed_at ?? null, now],
        );
      }
    }
  });
  return { recorded: input.assets.reduce((n, a) => n + a.attributes.length, 0) };
}

export async function reportConnectorHealth(s: Services, actor: Actor, input: z.infer<typeof healthReport>) {
  const c = await loadConnector(s.db, actor, input.connector_id);
  requireIngest(actor, c);
  const now = s.clock.now();
  const report = {
    adapter: input.adapter,
    connected: input.connected,
    backlog: input.backlog,
    buffer_capacity: input.buffer_capacity,
    oldest_buffered_at: input.oldest_buffered_at,
    gaps: input.gaps,
    credential_expires_at: input.credential_expires_at,
    last_error: input.last_error,
  };
  await s.db.query(`UPDATE integration.connector SET last_report = $2, last_report_at = $3 WHERE id = $1`, [c.id, JSON.stringify(report), now]);
  return { ok: true };
}

async function openReview(tx: Queryable, connector: Record<string, any>, kind: string, subject: string, detail: Record<string, unknown>, now: Date): Promise<void> {
  await tx.query(
    `INSERT INTO integration.review_item (id, tenant_id, site_id, connector_id, kind, subject, detail, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (connector_id, kind, subject) WHERE status = 'open'
     DO UPDATE SET occurrences = integration.review_item.occurrences + 1, last_seen_at = EXCLUDED.last_seen_at, detail = EXCLUDED.detail`,
    [randomUUID(), connector.tenant_id, connector.site_id, connector.id, kind, subject, JSON.stringify(detail), now],
  );
}

export async function listReviewItems(s: Services, actor: Actor, q: { site_id?: string; connector_id?: string; status?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.integration.manage').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
  if (q.connector_id) where.push(`connector_id::text = $${params.push(q.connector_id)}`);
  if (q.status) where.push(`status = $${params.push(q.status)}`);
  const { rows } = await s.db.query(`SELECT * FROM integration.review_item WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC LIMIT 200`, params);
  return rows.map((r) => ({ ...r, first_seen_at: iso(r.first_seen_at), last_seen_at: iso(r.last_seen_at), resolved_at: iso(r.resolved_at) }));
}

export async function resolveReviewItem(s: Services, actor: Actor, id: string, input: z.infer<typeof resolveReviewItemRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM integration.review_item WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, id]);
    const item = rows[0];
    if (!item || !can(p, 'maintenance.integration.manage', item.site_id)) throw notFound('Review item');
    if (item.status !== 'open') throw conflict('invalid_state', `Review item is ${item.status}`);
    const now = s.clock.now();
    const { rows: u } = await tx.query(
      `UPDATE integration.review_item SET status = $2, resolution = $3, resolved_by = $4, resolved_at = $5 WHERE id = $1 RETURNING *`,
      [item.id, input.status, input.resolution, p.userId, now],
    );
    await writeAudit(tx, actor, { siteId: item.site_id, action: 'review_item.resolved', targetType: 'review_item', targetId: item.id, reason: input.resolution, detail: { status: input.status } });
    return { ...u[0], first_seen_at: iso(u[0].first_seen_at), last_seen_at: iso(u[0].last_seen_at), resolved_at: iso(u[0].resolved_at) };
  });
}

interface Classified {
  decision: IngestDecision;
  reason: string;
  route: Record<string, any> | null;
  value: unknown;
  unit: string | null;
  historical: boolean;
  observedAt: Date | null;
}

function classify(connector: Record<string, any>, event: NormalizedEvent, route: Record<string, any> | null, now: Date, activeEpoch: number | null): Classified {
  if (event.tenant_id !== connector.tenant_id || event.site_id !== connector.site_id || event.connector_instance_id !== connector.id) {
    return { decision: 'quarantined_invalid', reason: 'Envelope tenant, site or connector does not match this connector', route: null, value: event.value, unit: event.unit, historical: true, observedAt: event.observed_at ? new Date(event.observed_at) : null };
  }
  if (event.quality !== 'good') {
    return { decision: 'quarantined_quality', reason: `Quality is ${event.quality}`, route, value: event.value, unit: event.unit, historical: true, observedAt: event.observed_at ? new Date(event.observed_at) : null };
  }
  if (!route) {
    return { decision: 'quarantined_unmapped', reason: 'No mapping for this external asset and attribute', route: null, value: event.value, unit: event.unit, historical: true, observedAt: event.observed_at ? new Date(event.observed_at) : null };
  }
  const observedAt = event.observed_at ? new Date(event.observed_at) : null;
  if (!observedAt) {
    return { decision: 'quarantined_invalid', reason: 'Source timestamp is missing; it is not synthesized from receipt time', route, value: event.value, unit: event.unit, historical: true, observedAt: null };
  }
  if (route.value_type === 'boolean') {
    if (typeof event.value !== 'boolean') return { decision: 'quarantined_invalid', reason: 'Alarm mappings require a boolean value', route, value: event.value, unit: event.unit, historical: true, observedAt };
  } else if (typeof event.value !== 'number' || !Number.isFinite(event.value)) {
    return { decision: 'quarantined_invalid', reason: 'Reading and meter mappings require a finite number', route, value: event.value, unit: event.unit, historical: true, observedAt };
  }
  if (route.kind !== 'alarm' && event.unit !== route.source_unit) {
    return { decision: 'quarantined_unit', reason: `Event unit ${event.unit ?? 'none'} does not match mapping source unit ${route.source_unit}`, route, value: event.value, unit: event.unit, historical: true, observedAt };
  }
  const conversion = (route.conversion ?? { factor: 1, offset: 0 }) as Conversion;
  const value = route.kind === 'alarm' ? event.value : convert(event.value as number, conversion);
  const unit = route.kind === 'alarm' ? null : route.target_unit;
  const expectedEpoch = activeEpoch ?? route.routing_epoch;
  if (event.routing_epoch !== expectedEpoch && !event.historical) {
    return { decision: 'fenced_epoch', reason: `Live event epoch ${event.routing_epoch} does not match active route epoch ${expectedEpoch}`, route, value, unit, historical: true, observedAt };
  }
  if (route.status === 'paused' && !event.historical) {
    return { decision: 'route_paused', reason: 'Route is paused', route, value, unit, historical: true, observedAt };
  }
  if (event.historical) {
    return { decision: 'historical', reason: 'Marked historical by the adapter (backfill or replay)', route, value, unit, historical: true, observedAt };
  }
  if (now.getTime() - observedAt.getTime() > route.freshness_seconds * 1000) {
    return { decision: 'stale', reason: `Observed time is older than the ${route.freshness_seconds}s freshness limit`, route, value, unit, historical: true, observedAt };
  }
  const last = route.last_observed_at as Date | null;
  if (last && observedAt.getTime() < last.getTime() - route.evaluation_window_seconds * 1000) {
    return { decision: 'out_of_window', reason: `Observed time is outside the ${route.evaluation_window_seconds}s evaluation window of the latest current reading`, route, value, unit, historical: true, observedAt };
  }
  return { decision: 'current', reason: 'Accepted as a current reading', route, value, unit, historical: false, observedAt };
}

async function applyCurrent(tx: Queryable, s: Services, actor: Actor, connector: Record<string, any>, event: NormalizedEvent, classified: Classified, receiptId: string, now: Date): Promise<void> {
  const route = classified.route!;
  const ev: CurrentSignalEvent = {
    receiptId,
    tenantId: connector.tenant_id,
    siteId: connector.site_id,
    assetId: route.asset_id,
    signalKey: route.signal_key,
    correlationGroup: route.correlation_group,
    value: classified.value as number | boolean,
    unit: classified.unit,
    observedAt: classified.observedAt!,
    receivedAt: new Date(event.received_at),
    simulated: connector.simulated,
    connectorId: connector.id,
  };
  if (route.kind === 'meter') {
    const { rows } = await tx.query(`SELECT * FROM maintenance.meter WHERE tenant_id = $1 AND asset_id = $2 AND signal_key = $3 FOR UPDATE`, [connector.tenant_id, route.asset_id, route.signal_key]);
    if (rows[0]) await applyMeterReading(tx, rows[0], { raw: classified.value as number, observedAt: classified.observedAt!, source: 'connector', receiptId, enteredBy: null, clientEntryId: null, historical: false, actorId: actor.principal.userId }, now);
  } else if (route.kind === 'alarm') {
    await processAlarm(tx, s, actor, ev);
  } else {
    await evaluateReading(tx, s, actor, ev);
  }
}

/**
 * Authenticated adapter ingestion. Delivery is at-least-once: retries with the
 * same connector/source key return the original receipt. Current events never
 * create work from stale, unmapped, bad-unit, replayed or fenced arrivals.
 */
export async function ingestEvents(s: Services, actor: Actor, input: z.infer<typeof ingestBatchRequest>): Promise<{ results: IngestResult[] }> {
  const c = await loadConnector(s.db, actor, input.connector_id);
  requireIngest(actor, c);
  await s.entitlements.require(c.tenant_id, 'connected.ingest');
  if (c.status === 'draft' || c.status === 'disabled') throw conflict('connector_inactive', `Connector is ${c.status}`);
  const now = s.clock.now();
  return withTransaction(s.db, async (tx) => {
    await tx.query(`SELECT 1 FROM integration.connector WHERE id = $1 FOR UPDATE`, [c.id]);
    const results: IngestResult[] = [];
    for (let i = 0; i < input.events.length; i++) {
      const parsed = normalizedEvent.safeParse(input.events[i]);
      if (!parsed.success) {
        results.push({ index: i, source_event_id: null, status: 'rejected', decision: 'quarantined_invalid', receipt_id: null, reason: parsed.error.issues[0]?.message ?? 'Invalid event' });
        continue;
      }
      const event = parsed.data;
      const { rows: existing } = await tx.query(`SELECT id, payload_hash, decision FROM integration.event_receipt WHERE connector_id = $1 AND source_event_id = $2`, [c.id, event.source_event_id]);
      const hash = payloadHash(event);
      if (existing[0]) {
        if (existing[0].payload_hash !== hash) {
          await openReview(tx, c, 'source_id_collision', event.source_event_id, { existing_receipt_id: existing[0].id, incoming_hash: hash }, now);
          results.push({ index: i, source_event_id: event.source_event_id, status: 'collision', decision: null, receipt_id: existing[0].id, reason: 'The same source event ID arrived with a different payload' });
        } else {
          results.push({ index: i, source_event_id: event.source_event_id, status: 'duplicate', decision: existing[0].decision, receipt_id: existing[0].id, reason: null });
        }
        continue;
      }
      const { rows: routeRows } = await tx.query(
        `SELECT * FROM integration.signal_route WHERE connector_id = $1 AND external_asset_id = $2 AND external_attribute = $3 AND status IN ('active','paused','retired') ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, routing_epoch DESC LIMIT 1`,
        [c.id, event.external_asset_id, event.external_attribute],
      );
      const sourceRoute = routeRows[0] ?? null;
      let activeEpoch: number | null = null;
      if (sourceRoute) {
        const { rows: active } = await tx.query(
          `SELECT routing_epoch FROM integration.signal_route WHERE tenant_id = $1 AND asset_id = $2 AND signal_key = $3 AND status = 'active'`,
          [c.tenant_id, sourceRoute.asset_id, sourceRoute.signal_key],
        );
        activeEpoch = active[0] ? Number(active[0].routing_epoch) : sourceRoute.routing_epoch;
      }
      const classified = classify(c, event, sourceRoute, now, activeEpoch);
      if (classified.decision === 'quarantined_unmapped') {
        await openReview(tx, c, 'unmapped_signal', `${event.external_asset_id}:${event.external_attribute}`, { source_event_id: event.source_event_id }, now);
      }
      const receiptId = randomUUID();
      await tx.query(
        `INSERT INTO integration.event_receipt
           (id, tenant_id, site_id, connector_id, route_id, source_system, source_event_id, payload_hash, external_asset_id, external_attribute,
            asset_id, signal_key, observed_at, adapter_received_at, ingested_at, raw_value, raw_unit, value, unit, quality, routing_epoch, historical, simulated, decision, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          receiptId, c.tenant_id, c.site_id, c.id, classified.route?.id ?? null, event.source_system, event.source_event_id, hash,
          event.external_asset_id, event.external_attribute, classified.route?.asset_id ?? null, classified.route?.signal_key ?? null,
          classified.observedAt, event.received_at, now, JSON.stringify(event.value), event.unit, JSON.stringify(classified.value), classified.unit,
          event.quality, event.routing_epoch, classified.historical, c.simulated, classified.decision, classified.reason,
        ],
      );
      if (classified.decision === 'current' && classified.route) {
        await tx.query(
          `UPDATE integration.signal_route SET last_observed_at = $2, last_receipt_at = $3 WHERE id = $1`,
          [classified.route.id, classified.observedAt, now],
        );
        await applyCurrent(tx, s, actor, c, event, classified, receiptId, now);
      }
      results.push({ index: i, source_event_id: event.source_event_id, status: 'recorded', decision: classified.decision, receipt_id: receiptId, reason: classified.decision === 'current' ? null : classified.reason });
    }
    await tx.query(`UPDATE integration.connector SET last_receipt_at = $2 WHERE id = $1`, [c.id, now]);
    if (input.checkpoint) {
      await tx.query(
        `INSERT INTO integration.checkpoint (connector_id, stream, tenant_id, cursor, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (connector_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
        [c.id, input.checkpoint.stream, c.tenant_id, input.checkpoint.cursor, now],
      );
    }
    return { results };
  });
}

export async function listReceipts(s: Services, actor: Actor, connectorId: string, q: { decision?: string; limit?: number }) {
  const c = await loadConnector(s.db, actor, connectorId);
  requirePermission(actor.principal, 'maintenance.integration.manage', c.site_id);
  const params: unknown[] = [c.id];
  let where = 'connector_id = $1';
  if (q.decision) where += ` AND decision = $${params.push(q.decision)}`;
  const { rows } = await s.db.query(
    `SELECT id, source_event_id, external_asset_id, external_attribute, asset_id, signal_key, observed_at, ingested_at, value, unit, quality, routing_epoch, historical, decision, decision_reason
       FROM integration.event_receipt WHERE ${where} ORDER BY ingested_at DESC LIMIT $${params.push(q.limit ?? 100)}`,
    params,
  );
  return rows.map((r) => ({ ...r, observed_at: iso(r.observed_at), ingested_at: iso(r.ingested_at) }));
}

async function pauseRulesForSignal(tx: Queryable, tenantId: string, assetId: string, signalKey: string, cutoverId: string, now: Date): Promise<string[]> {
  const { rows } = await tx.query(`SELECT id FROM maintenance.condition_rule WHERE tenant_id = $1 AND asset_id = $2 AND signal_key = $3 AND status = 'active'`, [tenantId, assetId, signalKey]);
  for (const r of rows) {
    await tx.query(
      `INSERT INTO maintenance.rule_state (rule_id, tenant_id, paused_by_cutover, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (rule_id) DO UPDATE SET paused_by_cutover = EXCLUDED.paused_by_cutover, updated_at = EXCLUDED.updated_at`,
      [r.id, tenantId, cutoverId, now],
    );
  }
  return rows.map((r) => r.id);
}

async function resumeRules(tx: Queryable, cutoverId: string, now: Date): Promise<void> {
  await tx.query(`UPDATE maintenance.rule_state SET paused_by_cutover = NULL, updated_at = $2 WHERE paused_by_cutover = $1`, [cutoverId, now]);
}

/**
 * MC-07 source cutover: pause rules, record watermarks, activate the replacement
 * at a new epoch, fence the old route, then resume. History and meter baselines stay.
 */
export async function startCutover(s: Services, actor: Actor, fromMappingId: string, input: z.infer<typeof startCutoverRequest>) {
  const p = actor.principal;
  await s.entitlements.require(p.tenantId, 'connected.configure');
  return withTransaction(s.db, async (tx) => {
    const { rows: fromRows } = await tx.query(`SELECT * FROM integration.signal_route WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, fromMappingId]);
    const from = fromRows[0];
    if (!from || !can(p, 'maintenance.view', from.site_id)) throw notFound('Mapping');
    requirePermission(p, 'maintenance.integration.manage', from.site_id);
    const { rows: toRows } = await tx.query(`SELECT * FROM integration.signal_route WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, input.to_mapping_id]);
    const to = toRows[0];
    if (!to || to.site_id !== from.site_id) throw notFound('Replacement mapping');
    if (from.status !== 'active') throw conflict('invalid_state', `Current route is ${from.status}`);
    if (to.status !== 'approved') throw conflict('invalid_state', `Replacement mapping is ${to.status}`);
    if (to.asset_id !== from.asset_id || to.signal_key !== from.signal_key) throw invalid('Replacement must map the same canonical asset and signal');
    if (to.kind !== from.kind) throw invalid('Replacement must have the same signal kind');
    if (from.kind !== 'alarm' && to.target_unit !== from.target_unit) throw invalid('Replacement target unit must match the current route');
    if (from.kind === 'meter' && !input.meter_continuity) throw invalid('Meter cutovers must declare whether the replacement is the same counter or a new baseline', { meter_continuity: ['Required for meter routes'] });
    if (from.kind !== 'meter' && input.meter_continuity) throw invalid('meter_continuity applies only to meter routes', { meter_continuity: ['Not applicable'] });
    const { rows: cRows } = await tx.query(`SELECT * FROM integration.connector WHERE id = $1`, [to.connector_id]);
    await registryMapping(s, actor, cRows[0], to.external_asset_id, to.asset_id);
    const now = s.clock.now();
    const id = randomUUID();
    const { rows: cps } = await tx.query(`SELECT stream, cursor FROM integration.checkpoint WHERE connector_id = $1`, [from.connector_id]);
    const { rows: meters } = await tx.query(`SELECT id, last_raw, last_usage, last_observed_at FROM maintenance.meter WHERE tenant_id = $1 AND asset_id = $2 AND signal_key = $3`, [p.tenantId, from.asset_id, from.signal_key]);
    const meter = meters[0];
    const manifest = {
      from_route_id: from.id,
      to_route_id: to.id,
      from_epoch: from.routing_epoch,
      to_epoch: from.routing_epoch + 1,
      from_last_observed_at: iso(from.last_observed_at),
      checkpoints: cps,
      meter: meter ? { id: meter.id, last_raw: meter.last_raw === null ? null : Number(meter.last_raw), last_usage: meter.last_usage === null ? null : Number(meter.last_usage), last_observed_at: iso(meter.last_observed_at) } : null,
    };
    await tx.query(
      `INSERT INTO integration.cutover (id, tenant_id, site_id, asset_id, signal_key, from_route_id, to_route_id, status, manifest, reason, started_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'in_progress',$8,$9,$10,$11)`,
      [id, p.tenantId, from.site_id, from.asset_id, from.signal_key, from.id, to.id, JSON.stringify(manifest), input.reason, p.userId, now],
    );
    await pauseRulesForSignal(tx, p.tenantId, from.asset_id, from.signal_key, id, now);
    await tx.query(`UPDATE integration.signal_route SET status = 'paused', status_reason = $2, version = version + 1 WHERE id = $1`, [from.id, `Cutover ${id}`]);
    await tx.query(
      `UPDATE integration.signal_route SET status = 'active', routing_epoch = $2, activated_at = $3, status_reason = NULL, version = version + 1 WHERE id = $1`,
      [to.id, from.routing_epoch + 1, now],
    );
    if (input.meter_continuity === 'rebaseline' && meter) {
      await tx.query(`UPDATE maintenance.meter SET rebaseline_cutover_id = $2, version = version + 1 WHERE id = $1`, [meter.id, id]);
    }
    await resumeRules(tx, id, now);
    await tx.query(`UPDATE integration.cutover SET status = 'completed', finished_by = $2, finished_at = $3 WHERE id = $1`, [id, p.userId, now]);
    await writeAudit(tx, actor, { siteId: from.site_id, action: 'cutover.completed', targetType: 'cutover', targetId: id, reason: input.reason, detail: manifest });
    return { id, status: 'completed', manifest, from_route_id: from.id, to_route_id: to.id };
  });
}

export async function rollbackCutover(s: Services, actor: Actor, cutoverId: string, input: z.infer<typeof recordStatusRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM integration.cutover WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, cutoverId]);
    const cut = rows[0];
    if (!cut || !can(p, 'maintenance.view', cut.site_id)) throw notFound('Cutover');
    requirePermission(p, 'maintenance.integration.manage', cut.site_id);
    if (cut.status !== 'completed' && cut.status !== 'in_progress') throw conflict('invalid_state', `Cutover is ${cut.status}`);
    const now = s.clock.now();
    const manifest = cut.manifest as { from_epoch: number; from_route_id: string; to_route_id: string };
    await pauseRulesForSignal(tx, p.tenantId, cut.asset_id, cut.signal_key, cut.id, now);
    await tx.query(`UPDATE integration.signal_route SET status = 'approved', version = version + 1 WHERE id = $1`, [manifest.to_route_id]);
    await tx.query(`UPDATE integration.signal_route SET status = 'active', routing_epoch = $2, status_reason = NULL, version = version + 1 WHERE id = $1`, [manifest.from_route_id, manifest.from_epoch]);
    await resumeRules(tx, cut.id, now);
    await tx.query(`UPDATE integration.cutover SET status = 'rolled_back', finished_by = $2, finished_at = $3, version = version + 1 WHERE id = $1`, [cut.id, p.userId, now]);
    await writeAudit(tx, actor, { siteId: cut.site_id, action: 'cutover.rolled_back', targetType: 'cutover', targetId: cut.id, reason: input.reason, detail: { restored_epoch: manifest.from_epoch } });
    return { id: cut.id, status: 'rolled_back' };
  });
}

export async function connectorHealthSummary(s: Services, actor: Actor, connectorId: string) {
  const c = await loadConnector(s.db, actor, connectorId);
  requirePermission(actor.principal, 'maintenance.view', c.site_id);
  const now = s.clock.now();
  const { rows } = await s.db.query(
    `SELECT
       (SELECT count(*) FROM integration.signal_route WHERE connector_id = $1 AND status = 'active')::int AS active_routes,
       (SELECT count(*) FROM integration.signal_route WHERE connector_id = $1 AND status = 'draft')::int AS draft_routes,
       (SELECT count(*) FROM integration.review_item WHERE connector_id = $1 AND status = 'open')::int AS open_review,
       (SELECT count(*) FROM integration.event_receipt WHERE connector_id = $1 AND decision LIKE 'quarantined%' AND ingested_at > $2::timestamptz - interval '24 hours')::int AS quarantined_24h,
       (SELECT count(*) FROM integration.signal_route r WHERE r.connector_id = $1 AND r.status = 'active' AND (r.last_observed_at IS NULL OR extract(epoch FROM $2::timestamptz - r.last_observed_at) > r.freshness_seconds))::int AS stale_routes`,
    [c.id, now],
  );
  const m = rows[0]!;
  return {
    ...connectorDto(c),
    active_routes: m.active_routes,
    draft_routes: m.draft_routes,
    open_review_items: m.open_review,
    quarantined_24h: m.quarantined_24h,
    stale_routes: m.stale_routes,
    lag_seconds: c.last_receipt_at ? Math.max(0, Math.round((now.getTime() - (c.last_receipt_at as Date).getTime()) / 1000)) : null,
  };
}

/** Used by /health/details: connector loss never fails core readiness. */
export async function connectorOperationalCounts(db: Queryable) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM integration.connector WHERE status = 'active')::int AS active,
       (SELECT count(*) FROM integration.connector WHERE simulated AND status = 'active')::int AS simulated_active,
       (SELECT count(*) FROM integration.review_item WHERE status = 'open')::int AS open_review,
       (SELECT count(*) FROM integration.event_receipt WHERE decision LIKE 'quarantined%' AND ingested_at > now() - interval '24 hours')::int AS quarantined_24h`,
  );
  return rows[0]!;
}
