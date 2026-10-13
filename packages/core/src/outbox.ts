import { randomUUID } from 'node:crypto';
import type { Queryable } from '@vm/db';
import type { MaintenanceRole, Permission } from '@vm/contracts';
import { can, ROLE_GRANTS } from '@vm/policy';
import type { Actor, Services } from './context.ts';
import type { EventType } from './records.ts';

export interface OutboxRow {
  event_id: string;
  tenant_id: string;
  site_id: string | null;
  event_type: EventType;
  aggregate_id: string;
  aggregate_version: number;
  occurred_at: Date;
  correlation_id: string | null;
  payload: Record<string, any>;
  attempts: number;
}

/** External sinks (webhooks, email) plug in here; in-app notifications are always delivered. */
export type OutboxSink = (e: OutboxRow) => Promise<void>;

const MAX_ATTEMPTS = 8;

function rolesWith(permission: Permission): MaintenanceRole[] {
  return (Object.keys(ROLE_GRANTS) as MaintenanceRole[]).filter((r) => ROLE_GRANTS[r].includes(permission));
}

async function holders(db: Queryable, tenantId: string, siteId: string, permission: Permission): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM maintenance.role_assignment WHERE tenant_id = $1 AND role = ANY($2::text[]) AND (site_id IS NULL OR site_id = $3)`,
    [tenantId, rolesWith(permission), siteId],
  );
  return rows.map((r) => r.user_id);
}

async function teamMembers(db: Queryable, tenantId: string, teamId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM maintenance.team_member WHERE tenant_id = $1 AND team_id = $2`, [tenantId, teamId]);
  return rows.map((r) => r.user_id);
}

interface Notice {
  users: string[];
  kind: string;
  title: string;
  body: string;
  link: string | null;
}

async function noticesFor(db: Queryable, e: OutboxRow): Promise<Notice[]> {
  const p = e.payload;
  if (e.event_type === 'maintenance.license.status_changed') {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM maintenance.role_assignment WHERE tenant_id = $1 AND role = ANY($2::text[])`,
      [e.tenant_id, rolesWith('maintenance.license.manage')],
    );
    return [{ users: rows.map((r) => r.user_id), kind: 'license.status_changed', title: `License status: ${p.to}`, body: (p.warnings as string[]).join(' '), link: '/admin/license' }];
  }
  const site = e.site_id;
  if (!site) return [];
  const actorId = p.actor_id as string | null;
  const except = (ids: string[]) => ids.filter((id) => id !== actorId);
  switch (e.event_type) {
    case 'maintenance.request.created':
      return [{ users: except(await holders(db, e.tenant_id, site, 'maintenance.request.triage')), kind: 'request.created', title: `New ${p.priority} request #${p.display_number}`, body: String(p.description ?? ''), link: `/requests/${p.request_id}` }];
    case 'maintenance.request.triaged':
      return [{ users: except([p.reporter_id]), kind: 'request.triaged', title: `Request #${p.display_number} is ${String(p.to).replace('_', ' ')}`, body: '', link: `/requests/${p.request_id}` }];
    case 'maintenance.work_order.assigned':
      return [{ users: except([p.assignee_id]), kind: 'work_order.assigned', title: `Assigned: WO-${p.display_number}`, body: String(p.title ?? ''), link: `/work-orders/${p.work_order_id}` }];
    case 'maintenance.work_order.state_changed': {
      const link = `/work-orders/${p.work_order_id}`;
      const title = `WO-${p.display_number} ${String(p.to).replace(/_/g, ' ')}`;
      if (p.to === 'ready') {
        const users = p.assignee_id ? [p.assignee_id] : p.team_id ? await teamMembers(db, e.tenant_id, p.team_id) : [];
        return [{ users: except(users), kind: 'work_order.ready', title, body: String(p.title ?? ''), link }];
      }
      if (p.to === 'pending_review') return [{ users: except(await holders(db, e.tenant_id, site, 'maintenance.work_order.approve')), kind: 'work_order.review', title, body: String(p.title ?? ''), link }];
      if (p.to === 'pending_approval') return [{ users: except(await holders(db, e.tenant_id, site, 'maintenance.work_order.approve')), kind: 'work_order.approval', title, body: String(p.title ?? ''), link }];
      if (p.action === 'return_for_rework' && p.assignee_id) return [{ users: except([p.assignee_id]), kind: 'work_order.rework', title, body: String(p.title ?? ''), link }];
      if (p.to === 'closed' && p.source_request_id) {
        const { rows } = await db.query(`SELECT reporter_id FROM maintenance.request WHERE id = $1`, [p.source_request_id]);
        return rows[0] ? [{ users: except([rows[0].reporter_id]), kind: 'work_order.closed', title, body: String(p.title ?? ''), link: `/requests/${p.source_request_id}` }] : [];
      }
      return [];
    }
    case 'maintenance.inspection.failed':
      return [{ users: except(await holders(db, e.tenant_id, site, 'maintenance.request.triage')), kind: 'inspection.failed', title: 'Inspection failed', body: String(p.summary ?? ''), link: p.request_id ? `/requests/${p.request_id}` : null }];
    case 'maintenance.plan.occurrence_due':
    case 'maintenance.downtime.updated':
    case 'maintenance.recommendation.decided':
    case 'maintenance.work_order.created':
      return [];
    case 'maintenance.incident.opened':
      // When a request was created its own notice covers triage; otherwise surface the blocked incident.
      if (!p.request_blocked_reason) return [];
      return [{ users: await holders(db, e.tenant_id, site, 'maintenance.request.triage'), kind: 'incident.request_blocked', title: `${p.simulated ? '[SIMULATED] ' : ''}Condition incident without request`, body: String(p.request_blocked_reason), link: `/incidents/${p.incident_id}` }];
    default: {
      const never: never = e.event_type;
      throw new Error(`Unhandled event type ${String(never)}`);
    }
  }
}

/** Consumers deduplicate by event ID: a redelivered event cannot create a second notification. */
async function deliverInApp(db: Queryable, e: OutboxRow): Promise<void> {
  for (const n of await noticesFor(db, e)) {
    for (const userId of new Set(n.users)) {
      await db.query(
        `INSERT INTO maintenance.notification (id, tenant_id, site_id, user_id, event_id, kind, title, body, link)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, event_id, kind) DO NOTHING`,
        [randomUUID(), e.tenant_id, e.site_id, userId, e.event_id, n.kind, n.title, n.body, n.link],
      );
    }
  }
}

/**
 * Claims a batch with a lease so concurrent workers never process the same
 * event, delivers it, and backs off failures into a visible exception queue.
 */
export async function dispatchOutbox(s: Services, workerId: string, opts: { batch?: number; sinks?: OutboxSink[] } = {}): Promise<{ delivered: number; failed: number }> {
  const { rows } = await s.db.query<OutboxRow>(
    `UPDATE maintenance.outbox SET lease_owner = $1, lease_expires_at = now() + interval '60 seconds', attempts = attempts + 1
      WHERE event_id IN (
        SELECT event_id FROM maintenance.outbox
         WHERE status = 'pending' AND next_attempt_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY occurred_at, event_id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING event_id, tenant_id, site_id, event_type, aggregate_id, aggregate_version, occurred_at, correlation_id, payload, attempts`,
    [workerId, opts.batch ?? 50],
  );
  let delivered = 0;
  let failed = 0;
  for (const e of rows) {
    try {
      await deliverInApp(s.db, e);
      for (const sink of opts.sinks ?? []) await sink(e);
      await s.db.query(`UPDATE maintenance.outbox SET status = 'delivered', delivered_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL WHERE event_id = $1 AND lease_owner = $2`, [e.event_id, workerId]);
      delivered++;
    } catch (err) {
      const terminal = e.attempts >= MAX_ATTEMPTS;
      await s.db.query(
        `UPDATE maintenance.outbox SET status = $3, next_attempt_at = now() + ($4 || ' seconds')::interval, lease_owner = NULL, lease_expires_at = NULL, last_error = $5
          WHERE event_id = $1 AND lease_owner = $2`,
        [e.event_id, workerId, terminal ? 'failed' : 'pending', String(Math.min(3600, 2 ** e.attempts * 5)), (err as Error).message.slice(0, 1000)],
      );
      failed++;
    }
  }
  return { delivered, failed };
}

export async function listNotifications(s: Services, actor: Actor, unreadOnly: boolean) {
  const p = actor.principal;
  const { rows } = await s.db.query(
    `SELECT id, site_id, kind, title, body, link, created_at, acknowledged_at FROM maintenance.notification
      WHERE tenant_id = $1 AND user_id = $2 AND ($3::boolean = false OR acknowledged_at IS NULL)
      ORDER BY created_at DESC LIMIT 100`,
    [p.tenantId, p.userId, unreadOnly],
  );
  // Notifications are re-scoped at read time so revoked site access hides them.
  return rows.filter((n) => !n.site_id || can(p, 'maintenance.view', n.site_id) || can(p, 'maintenance.request.view_own', n.site_id));
}

export async function acknowledgeNotification(s: Services, actor: Actor, id: string): Promise<void> {
  await s.db.query(`UPDATE maintenance.notification SET acknowledged_at = coalesce(acknowledged_at, now()) WHERE tenant_id = $1 AND user_id = $2 AND id::text = $3`, [actor.principal.tenantId, actor.principal.userId, id]);
}

export async function listOutboxExceptions(s: Services, actor: Actor) {
  const { rows } = await s.db.query(
    `SELECT event_id, site_id, event_type, aggregate_id, attempts, last_error, occurred_at FROM maintenance.outbox
      WHERE tenant_id = $1 AND status = 'failed' ORDER BY occurred_at DESC LIMIT 200`,
    [actor.principal.tenantId],
  );
  return rows.filter((r) => !r.site_id || can(actor.principal, 'maintenance.settings.manage', r.site_id));
}

export async function retryOutboxEvent(s: Services, actor: Actor, eventId: string): Promise<boolean> {
  const { rows } = await s.db.query(`SELECT site_id FROM maintenance.outbox WHERE tenant_id = $1 AND event_id::text = $2 AND status = 'failed'`, [actor.principal.tenantId, eventId]);
  if (!rows[0] || (rows[0].site_id && !can(actor.principal, 'maintenance.settings.manage', rows[0].site_id))) return false;
  await s.db.query(`UPDATE maintenance.outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE event_id = $1`, [eventId]);
  return true;
}
