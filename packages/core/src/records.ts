import { randomUUID } from 'node:crypto';
import type { Queryable } from '@vm/db';
import { actorId, actorKind, tenantOf, type AnyActor } from './context.ts';

export interface AuditInput {
  siteId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  beforeVersion?: number | null;
  afterVersion?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

export async function writeAudit(tx: Queryable, actor: AnyActor, e: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO maintenance.audit_event
       (tenant_id, site_id, actor_id, actor_kind, action, target_type, target_id, before_version, after_version, reason, detail, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      tenantOf(actor),
      e.siteId,
      actorId(actor),
      actorKind(actor),
      e.action,
      e.targetType,
      e.targetId,
      e.beforeVersion ?? null,
      e.afterVersion ?? null,
      e.reason ?? null,
      JSON.stringify(e.detail ?? {}),
      actor.correlationId,
    ],
  );
}

export const EVENT_TYPES = [
  'maintenance.request.created',
  'maintenance.request.triaged',
  'maintenance.work_order.created',
  'maintenance.work_order.state_changed',
  'maintenance.work_order.assigned',
  'maintenance.plan.occurrence_due',
  'maintenance.inspection.failed',
  'maintenance.downtime.updated',
  'maintenance.recommendation.decided',
  'maintenance.incident.opened',
  'maintenance.license.status_changed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface OutboxInput {
  siteId: string | null;
  type: EventType;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/** Written in the same transaction as the business change (transactional outbox). */
export async function enqueueEvent(tx: Queryable, actor: AnyActor, e: OutboxInput): Promise<string> {
  const eventId = randomUUID();
  await tx.query(
    `INSERT INTO maintenance.outbox
       (event_id, tenant_id, site_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, occurred_at, correlation_id, payload)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10)`,
    [
      eventId,
      tenantOf(actor),
      e.siteId,
      e.type,
      e.aggregateType,
      e.aggregateId,
      e.aggregateVersion,
      e.occurredAt,
      actor.correlationId,
      JSON.stringify({ ...e.payload, actor_id: actorId(actor) }),
    ],
  );
  return eventId;
}

/** Site-scoped sequential display numbers; the row lock serializes concurrent allocation. */
export async function nextDisplayNumber(tx: Queryable, tenantId: string, siteId: string, kind: 'request' | 'work_order'): Promise<number> {
  const { rows } = await tx.query<{ value: number }>(
    `INSERT INTO maintenance.site_counter (tenant_id, site_id, kind, next_value) VALUES ($1,$2,$3,2)
     ON CONFLICT (tenant_id, site_id, kind) DO UPDATE SET next_value = maintenance.site_counter.next_value + 1
     RETURNING next_value - 1 AS value`,
    [tenantId, siteId, kind],
  );
  return rows[0]!.value;
}

export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}
