import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '@vm/db';
import type { conditionRuleRevisionRequest, createConditionRuleRequest } from '@vm/contracts';
import { can, sitesWith } from '@vm/policy';
import { conflict, invalid, notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission } from './access.ts';
import type { Actor, Services } from './context.ts';
import { identitySnapshot, resolveAsset } from './identity-snapshots.ts';
import { enqueueEvent, iso, writeAudit } from './records.ts';
import { insertRequest } from './requests.ts';

type Priority = 'critical' | 'high' | 'normal' | 'low';

// ---------- Rule administration ----------

function ruleDto(r: Record<string, any>, rev: Record<string, any> | null) {
  return {
    id: r.id,
    site_id: r.site_id,
    asset_id: r.asset_id,
    asset_snapshot: r.asset_snapshot,
    signal_key: r.signal_key,
    name: r.name,
    status: r.status,
    current_revision: rev ? revisionDto(rev) : null,
    version: r.version,
  };
}

function revisionDto(v: Record<string, any>) {
  return {
    id: v.id,
    rule_id: v.rule_id,
    revision_no: v.revision_no,
    status: v.status,
    operator: v.operator,
    threshold: Number(v.threshold),
    unit: v.unit,
    duration_seconds: v.duration_seconds,
    hysteresis: Number(v.hysteresis),
    cooldown_seconds: v.cooldown_seconds,
    priority: v.priority,
    team_id: v.team_id,
    correlation_group: v.correlation_group,
    published_at: iso(v.published_at),
    published_by: v.published_by,
  };
}

async function loadRule(db: Queryable, actor: Actor, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM maintenance.condition_rule WHERE tenant_id = $1 AND id::text = $2 ${lock ? 'FOR UPDATE' : ''}`, [actor.principal.tenantId, id]);
  const r = rows[0];
  if (!r || !can(actor.principal, 'maintenance.view', r.site_id)) throw notFound('Condition rule');
  return r;
}

export async function createConditionRule(s: Services, actor: Actor, input: z.infer<typeof createConditionRuleRequest>) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.automation.manage', input.site_id);
  await s.entitlements.require(p.tenantId, 'connected.configure');
  const asset = await resolveAsset(s, actor, input.asset_id);
  if (asset.site_id !== input.site_id) throw invalid('Asset belongs to a different site', { asset_id: ['Asset is not at this site'] });
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.condition_rule (id, tenant_id, site_id, asset_id, asset_snapshot, signal_key, name, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, p.tenantId, input.site_id, asset.asset_id, JSON.stringify(identitySnapshot(asset)), input.signal_key, input.name, p.userId],
    );
    await writeAudit(tx, actor, { siteId: input.site_id, action: 'condition_rule.created', targetType: 'condition_rule', targetId: id, afterVersion: 1, detail: { signal_key: input.signal_key } });
    return ruleDto(rows[0], null);
  });
}

export async function addRuleRevision(s: Services, actor: Actor, ruleId: string, input: z.infer<typeof conditionRuleRevisionRequest>) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const rule = await loadRule(tx, actor, ruleId, true);
    requirePermission(p, 'maintenance.automation.manage', rule.site_id);
    if (rule.status === 'archived') throw conflict('rule_archived', 'Archived rules cannot be revised');
    const { rows: team } = await tx.query(`SELECT site_id, status FROM maintenance.team WHERE tenant_id = $1 AND id = $2`, [p.tenantId, input.team_id]);
    if (team[0]?.site_id !== rule.site_id || team[0]?.status !== 'active') throw invalid('Responsible team must be an active team at this site', { team_id: ['Unknown team for this site'] });
    const { rows: n } = await tx.query<{ next: number }>(`SELECT coalesce(max(revision_no), 0) + 1 AS next FROM maintenance.condition_rule_revision WHERE rule_id = $1`, [rule.id]);
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.condition_rule_revision
         (id, tenant_id, rule_id, revision_no, operator, threshold, unit, duration_seconds, hysteresis, cooldown_seconds, priority, team_id, correlation_group, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, p.tenantId, rule.id, n[0]!.next, input.operator, input.threshold, input.unit, input.duration_seconds, input.hysteresis, input.cooldown_seconds, input.priority, input.team_id, input.correlation_group ?? rule.signal_key, p.userId],
    );
    await writeAudit(tx, actor, { siteId: rule.site_id, action: 'condition_rule.revision_drafted', targetType: 'condition_rule', targetId: rule.id, detail: { revision_id: id, revision_no: n[0]!.next } });
    return revisionDto(rows[0]);
  });
}

/** Publishing versions the rule; evaluations always record the revision that decided them (MI-02). */
export async function publishRuleRevision(s: Services, actor: Actor, revisionId: string) {
  const p = actor.principal;
  await s.entitlements.require(p.tenantId, 'connected.configure');
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.condition_rule_revision WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, revisionId]);
    const rev = rows[0];
    if (!rev) throw notFound('Rule revision');
    const rule = await loadRule(tx, actor, rev.rule_id, true);
    requirePermission(p, 'maintenance.automation.manage', rule.site_id);
    if (rev.status !== 'draft') throw conflict('revision_not_draft', `Revision is ${rev.status}`);
    const now = s.clock.now();
    await tx.query(`UPDATE maintenance.condition_rule_revision SET status = 'superseded' WHERE rule_id = $1 AND status = 'published'`, [rule.id]);
    const { rows: pub } = await tx.query(`UPDATE maintenance.condition_rule_revision SET status = 'published', published_by = $2, published_at = $3 WHERE id = $1 RETURNING *`, [rev.id, p.userId, now]);
    const { rows: updated } = await tx.query(`UPDATE maintenance.condition_rule SET current_revision_id = $2, status = 'active', version = version + 1 WHERE id = $1 RETURNING *`, [rule.id, rev.id]);
    // A new revision starts its own duration tracking.
    await tx.query(
      `INSERT INTO maintenance.rule_state (rule_id, tenant_id, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (rule_id) DO UPDATE SET breach_since = NULL, updated_at = EXCLUDED.updated_at`,
      [rule.id, p.tenantId, now],
    );
    await writeAudit(tx, actor, { siteId: rule.site_id, action: 'condition_rule.revision_published', targetType: 'condition_rule', targetId: rule.id, beforeVersion: rule.version, afterVersion: rule.version + 1, detail: { revision_id: rev.id, revision_no: rev.revision_no } });
    return ruleDto(updated[0], pub[0]);
  });
}

export async function listConditionRules(s: Services, actor: Actor, q: { site_id?: string; asset_id?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  let where = 'r.tenant_id = $1 AND r.site_id = ANY($2::uuid[])';
  if (q.asset_id) where += ` AND r.asset_id::text = $${params.push(q.asset_id)}`;
  const { rows } = await s.db.query(
    `SELECT r.*, to_jsonb(v) AS rev FROM maintenance.condition_rule r LEFT JOIN maintenance.condition_rule_revision v ON v.id = r.current_revision_id
      WHERE ${where} ORDER BY r.name, r.id LIMIT 500`,
    params,
  );
  return rows.map((r) => ruleDto(r, r.rev));
}

// ---------- Incidents ----------

function incidentDto(i: Record<string, any>) {
  return {
    id: i.id,
    site_id: i.site_id,
    asset_id: i.asset_id,
    asset_snapshot: i.asset_snapshot,
    correlation_group: i.correlation_group,
    episode: i.episode,
    status: i.status,
    source: i.source,
    rule_id: i.rule_id,
    rule_revision_id: i.rule_revision_id,
    priority: i.priority,
    simulated: i.simulated,
    opened_at: iso(i.opened_at),
    recovered_at: iso(i.recovered_at),
    closed_at: iso(i.closed_at),
    close_reason: i.close_reason,
    cooldown_until: iso(i.cooldown_until),
    request_id: i.request_id,
    request_blocked_reason: i.request_blocked_reason,
    evidence_count: i.evidence_count,
    last_evidence_at: iso(i.last_evidence_at),
    version: i.version,
  };
}

export async function listIncidents(s: Services, actor: Actor, q: { site_id?: string; status?: string; asset_id?: string }) {
  const sites = sitesWith(actor.principal, 'maintenance.view').filter((x) => !q.site_id || x === q.site_id);
  if (!sites.length) return [];
  const params: unknown[] = [actor.principal.tenantId, sites];
  const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
  if (q.status) where.push(`status = $${params.push(q.status)}`);
  if (q.asset_id) where.push(`asset_id::text = $${params.push(q.asset_id)}`);
  const { rows } = await s.db.query(`SELECT * FROM maintenance.incident WHERE ${where.join(' AND ')} ORDER BY opened_at DESC, id LIMIT 200`, params);
  return rows.map(incidentDto);
}

export async function getIncident(s: Services, actor: Actor, id: string) {
  const { rows } = await s.db.query(`SELECT * FROM maintenance.incident WHERE tenant_id = $1 AND id::text = $2`, [actor.principal.tenantId, id]);
  const i = rows[0];
  if (!i || !can(actor.principal, 'maintenance.view', i.site_id)) throw notFound('Incident');
  const { rows: ev } = await s.db.query(
    `SELECT id, receipt_id, kind, observed_at, value, detail, created_at FROM maintenance.incident_evidence WHERE incident_id = $1 ORDER BY observed_at, created_at LIMIT 500`,
    [i.id],
  );
  return { ...incidentDto(i), evidence: ev.map((e) => ({ ...e, observed_at: iso(e.observed_at), created_at: iso(e.created_at) })) };
}

export async function closeIncident(s: Services, actor: Actor, id: string, input: { record_version: number; reason: string }) {
  const p = actor.principal;
  return withTransaction(s.db, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM maintenance.incident WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, id]);
    const i = rows[0];
    if (!i || !can(p, 'maintenance.view', i.site_id)) throw notFound('Incident');
    requirePermission(p, 'maintenance.request.triage', i.site_id);
    if (i.version !== input.record_version) throw staleVersion(i.version);
    if (i.status === 'closed') throw conflict('invalid_state', 'Incident is already closed');
    const now = s.clock.now();
    const { rows: u } = await tx.query(
      `UPDATE maintenance.incident SET status = 'closed', closed_at = $2, close_reason = $3, cooldown_until = $2::timestamptz + make_interval(secs => cooldown_seconds), version = version + 1 WHERE id = $1 RETURNING *`,
      [i.id, now, `manual: ${input.reason}`],
    );
    await writeAudit(tx, actor, { siteId: i.site_id, action: 'incident.closed', targetType: 'incident', targetId: i.id, beforeVersion: i.version, afterVersion: i.version + 1, reason: input.reason });
    return incidentDto(u[0]);
  });
}

// ---------- Evaluation engine ----------

export interface CurrentSignalEvent {
  receiptId: string;
  tenantId: string;
  siteId: string;
  assetId: string;
  signalKey: string;
  correlationGroup: string;
  value: number | boolean;
  unit: string | null;
  observedAt: Date;
  receivedAt: Date;
  simulated: boolean;
  connectorId: string;
}

type Decision =
  | 'normal'
  | 'breach_pending'
  | 'incident_opened'
  | 'evidence_appended'
  | 'suppressed_cooldown'
  | 'recovered'
  | 'rule_paused'
  | 'unit_mismatch'
  | 'alarm_cleared';

async function recordEvaluation(tx: Queryable, ev: CurrentSignalEvent, ruleRevisionId: string | null, evaluated: Record<string, unknown>, decision: Decision, incidentId: string | null, now: Date) {
  await tx.query(
    `INSERT INTO maintenance.rule_evaluation (tenant_id, receipt_id, rule_revision_id, asset_id, observed_at, received_at, evaluated, decision, incident_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ev.tenantId, ev.receiptId, ruleRevisionId, ev.assetId, ev.observedAt, ev.receivedAt, JSON.stringify(evaluated), decision, incidentId, now],
  );
}

async function addEvidence(tx: Queryable, incidentId: string, ev: CurrentSignalEvent, kind: string, detail: Record<string, unknown>, now: Date): Promise<boolean> {
  const { rowCount } = await tx.query(
    `INSERT INTO maintenance.incident_evidence (id, tenant_id, incident_id, receipt_id, kind, observed_at, value, detail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (incident_id, receipt_id) DO NOTHING`,
    [randomUUID(), ev.tenantId, incidentId, ev.receiptId, kind, ev.observedAt, JSON.stringify(ev.value), JSON.stringify({ unit: ev.unit, ...detail }), now],
  );
  return (rowCount ?? 0) > 0;
}

/** Why an incident's linked request/work no longer needs it open, or null while work is outstanding. */
async function resolvedWork(tx: Queryable, requestId: string | null): Promise<string | null> {
  if (!requestId) return null;
  const { rows } = await tx.query(
    `SELECT r.state, w.state AS wo_state FROM maintenance.request r LEFT JOIN maintenance.work_order w ON w.id = r.linked_work_order_id WHERE r.id = $1`,
    [requestId],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.state === 'rejected' || r.state === 'duplicate') return `request_${r.state}`;
  if (r.wo_state === 'closed' || r.wo_state === 'cancelled') return `work_order_${r.wo_state}`;
  return null;
}

async function closeIfResolved(tx: Queryable, incident: Record<string, any>, now: Date): Promise<boolean> {
  const reason = await resolvedWork(tx, incident.request_id);
  if (!reason) return false;
  await tx.query(
    `UPDATE maintenance.incident SET status = 'closed', closed_at = $2, close_reason = $3, cooldown_until = $2::timestamptz + make_interval(secs => cooldown_seconds), version = version + 1 WHERE id = $1`,
    [incident.id, now, reason],
  );
  return true;
}

interface RaiseInput {
  source: 'rule' | 'provider_alarm';
  ruleId: string | null;
  ruleRevisionId: string | null;
  priority: Priority;
  cooldownSeconds: number;
  title: string;
  detail: Record<string, unknown>;
}

/**
 * MI-03: one active episode per (asset, correlation group). Alarm and reading
 * paths share the key, so one condition cannot open two requests. An
 * advisory lock serializes concurrent batches for the same key.
 */
async function raiseCondition(tx: Queryable, s: Services, actor: Actor, ev: CurrentSignalEvent, r: RaiseInput): Promise<{ decision: Decision; incidentId: string | null }> {
  const now = s.clock.now();
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`incident:${ev.tenantId}:${ev.assetId}:${ev.correlationGroup}`]);
  const { rows } = await tx.query(
    `SELECT * FROM maintenance.incident WHERE tenant_id = $1 AND asset_id = $2 AND correlation_group = $3 AND status <> 'closed' FOR UPDATE`,
    [ev.tenantId, ev.assetId, ev.correlationGroup],
  );
  let active = rows[0] ?? null;
  if (active && (await closeIfResolved(tx, active, now))) active = null;
  if (active) {
    if (await addEvidence(tx, active.id, ev, r.source === 'rule' ? 'breach' : 'alarm', r.detail, now)) {
      await tx.query(
        `UPDATE maintenance.incident SET evidence_count = evidence_count + 1, last_evidence_at = $2, status = 'open', recovered_at = NULL, version = version + 1 WHERE id = $1`,
        [active.id, now],
      );
    }
    return { decision: 'evidence_appended', incidentId: active.id };
  }
  const { rows: last } = await tx.query(
    `SELECT id, episode, cooldown_until FROM maintenance.incident WHERE tenant_id = $1 AND asset_id = $2 AND correlation_group = $3 ORDER BY episode DESC LIMIT 1`,
    [ev.tenantId, ev.assetId, ev.correlationGroup],
  );
  if (last[0]?.cooldown_until && last[0].cooldown_until.getTime() > now.getTime()) {
    await addEvidence(tx, last[0].id, ev, 'follow_up', { ...r.detail, suppressed: 'cooldown' }, now);
    return { decision: 'suppressed_cooldown', incidentId: last[0].id };
  }

  const asset = await resolveAsset(s, actor, ev.assetId);
  const incidentId = randomUUID();
  const episode = (last[0]?.episode ?? 0) + 1;
  let requestId: string | null = null;
  let blocked: string | null = null;
  const view = await s.entitlements.view(ev.tenantId);
  if (!view.capabilities.includes('connected.create_requests')) {
    blocked = `Connector-created requests are not available under the current license (status: ${view.status}); evidence is retained.`;
  } else if (asset.lifecycle !== 'active') {
    blocked = `Asset is ${asset.lifecycle}`;
  } else {
    const label = ev.simulated ? '[SIMULATED DATA] ' : '';
    const req = await insertRequest(tx, s, actor, {
      siteId: ev.siteId,
      origin: 'connector',
      reporterId: actor.principal.userId,
      asset,
      locationText: asset.location,
      description: `${label}${r.title}`,
      observedAt: ev.observedAt,
      priority: r.priority,
      reading: { signal_key: ev.signalKey, value: ev.value, unit: ev.unit, provenance: ev.simulated ? 'simulated_connector' : 'connector', observed_at: ev.observedAt.toISOString() },
      voiceTranscript: null,
      sourceRef: { incident_id: incidentId, episode, rule_id: r.ruleId, rule_revision_id: r.ruleRevisionId, receipt_id: ev.receiptId, connector_id: ev.connectorId, simulated: ev.simulated },
      clientRequestId: `incident:${incidentId}`,
    });
    requestId = req.id;
  }
  await tx.query(
    `INSERT INTO maintenance.incident
       (id, tenant_id, site_id, asset_id, asset_snapshot, correlation_group, episode, status, source, rule_id, rule_revision_id, opening_receipt_id,
        priority, simulated, opened_at, cooldown_seconds, request_id, request_blocked_reason, last_evidence_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$14)`,
    [incidentId, ev.tenantId, ev.siteId, ev.assetId, JSON.stringify(identitySnapshot(asset)), ev.correlationGroup, episode, r.source, r.ruleId, r.ruleRevisionId, ev.receiptId, r.priority, ev.simulated, now, r.cooldownSeconds, requestId, blocked],
  );
  await addEvidence(tx, incidentId, ev, 'opening', r.detail, now);
  await enqueueEvent(tx, actor, {
    siteId: ev.siteId,
    type: 'maintenance.incident.opened',
    aggregateType: 'incident',
    aggregateId: incidentId,
    aggregateVersion: 1,
    occurredAt: now,
    payload: { incident_id: incidentId, asset_id: ev.assetId, correlation_group: ev.correlationGroup, episode, source: r.source, request_id: requestId, request_blocked_reason: blocked, simulated: ev.simulated },
  });
  return { decision: 'incident_opened', incidentId };
}

/** MI-05: recovery is evidence only; linked work still needs human verification to close. */
async function recordRecovery(tx: Queryable, s: Services, ev: CurrentSignalEvent, kind: 'recovery' | 'alarm_cleared', detail: Record<string, unknown>): Promise<string | null> {
  const now = s.clock.now();
  const { rows } = await tx.query(
    `SELECT * FROM maintenance.incident WHERE tenant_id = $1 AND asset_id = $2 AND correlation_group = $3 AND status <> 'closed' FOR UPDATE`,
    [ev.tenantId, ev.assetId, ev.correlationGroup],
  );
  const i = rows[0];
  if (!i) return null;
  if (await addEvidence(tx, i.id, ev, kind, detail, now)) {
    const closeNow = i.request_id === null;
    await tx.query(
      `UPDATE maintenance.incident SET status = $3, recovered_at = coalesce(recovered_at, $2), evidence_count = evidence_count + 1, last_evidence_at = $2,
         closed_at = CASE WHEN $3 = 'closed' THEN $2::timestamptz END, close_reason = CASE WHEN $3 = 'closed' THEN 'recovered_without_request' END,
         cooldown_until = CASE WHEN $3 = 'closed' THEN $2::timestamptz + make_interval(secs => cooldown_seconds) END, version = version + 1 WHERE id = $1`,
      [i.id, now, closeNow ? 'closed' : 'recovered'],
    );
  }
  return i.id;
}

/** Readings within a closed incident's cooldown are follow-up evidence for verification. */
async function followUp(tx: Queryable, s: Services, ev: CurrentSignalEvent, detail: Record<string, unknown>): Promise<void> {
  const now = s.clock.now();
  const { rows } = await tx.query(
    `SELECT id FROM maintenance.incident WHERE tenant_id = $1 AND asset_id = $2 AND correlation_group = $3 AND status = 'closed' AND cooldown_until > $4 ORDER BY episode DESC LIMIT 1`,
    [ev.tenantId, ev.assetId, ev.correlationGroup, now],
  );
  if (rows[0]) await addEvidence(tx, rows[0].id, ev, 'follow_up', detail, now);
}

function breaches(op: 'gt' | 'gte' | 'lt' | 'lte', value: number, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    default: {
      const never: never = op;
      throw new Error(`Unknown operator ${String(never)}`);
    }
  }
}

function recoveredBeyondHysteresis(op: string, value: number, threshold: number, hysteresis: number): boolean {
  return op === 'gt' || op === 'gte' ? value < threshold - hysteresis : value > threshold + hysteresis;
}

/** Evaluates a current, validated numeric reading against the asset's published rules. */
export async function evaluateReading(tx: Queryable, s: Services, actor: Actor, ev: CurrentSignalEvent): Promise<Decision[]> {
  const now = s.clock.now();
  const value = ev.value as number;
  const { rows: rules } = await tx.query(
    `SELECT r.id AS rule_id, r.name, v.* FROM maintenance.condition_rule r JOIN maintenance.condition_rule_revision v ON v.id = r.current_revision_id
      WHERE r.tenant_id = $1 AND r.asset_id = $2 AND r.signal_key = $3 AND r.status = 'active' ORDER BY r.id`,
    [ev.tenantId, ev.assetId, ev.signalKey],
  );
  const out: Decision[] = [];
  for (const rule of rules) {
    const threshold = Number(rule.threshold);
    const hysteresis = Number(rule.hysteresis);
    const group = rule.correlation_group as string;
    const gev = { ...ev, correlationGroup: group };
    const { rows: st } = await tx.query(`SELECT * FROM maintenance.rule_state WHERE rule_id = $1 FOR UPDATE`, [rule.rule_id]);
    const state = st[0];
    const evaluated: Record<string, unknown> = { value, unit: ev.unit, operator: rule.operator, threshold, hysteresis, duration_seconds: rule.duration_seconds };
    let decision: Decision;
    let incidentId: string | null = null;
    const late = state?.last_observed_at && ev.observedAt.getTime() < state.last_observed_at.getTime();
    if (state?.paused_by_cutover) {
      decision = 'rule_paused';
    } else if (rule.unit !== ev.unit) {
      decision = 'unit_mismatch';
    } else {
      const inBreach = breaches(rule.operator as 'gt' | 'gte' | 'lt' | 'lte', value, threshold) || (state?.breach_since && !recoveredBeyondHysteresis(rule.operator, value, threshold, hysteresis));
      if (late) {
        // Late but inside the evaluation window: evidence only, no state change.
        evaluated.late = true;
        decision = inBreach ? 'breach_pending' : 'normal';
      } else if (inBreach) {
        const since: Date = state?.breach_since ?? ev.observedAt;
        evaluated.breach_since = since.toISOString();
        if ((ev.observedAt.getTime() - since.getTime()) / 1000 >= rule.duration_seconds) {
          const res = await raiseCondition(tx, s, actor, gev, {
            source: 'rule',
            ruleId: rule.rule_id,
            ruleRevisionId: rule.id,
            priority: rule.priority,
            cooldownSeconds: rule.cooldown_seconds,
            title: `${rule.name}: ${ev.signalKey} ${value} ${ev.unit ?? ''} ${rule.operator} ${threshold} for at least ${rule.duration_seconds}s (rule revision ${rule.revision_no}).`.replace(/\s+/g, ' '),
            detail: { rule_revision_id: rule.id, ...evaluated },
          });
          decision = res.decision;
          incidentId = res.incidentId;
        } else {
          decision = 'breach_pending';
        }
        await tx.query(`UPDATE maintenance.rule_state SET breach_since = $2, last_observed_at = $3, last_value = $4, updated_at = $5 WHERE rule_id = $1`, [rule.rule_id, since, ev.observedAt, value, now]);
      } else {
        incidentId = state?.breach_since ? await recordRecovery(tx, s, gev, 'recovery', { rule_revision_id: rule.id, ...evaluated }) : null;
        decision = incidentId ? 'recovered' : 'normal';
        if (!incidentId) await followUp(tx, s, gev, { rule_revision_id: rule.id, ...evaluated });
        await tx.query(`UPDATE maintenance.rule_state SET breach_since = NULL, last_observed_at = $2, last_value = $3, updated_at = $4 WHERE rule_id = $1`, [rule.rule_id, ev.observedAt, value, now]);
      }
    }
    await recordEvaluation(tx, ev, rule.id, evaluated, decision, incidentId, now);
    out.push(decision);
  }
  return out;
}

/** Provider alarms enter the same incident model as reading rules (PRD §11). */
export async function processAlarm(tx: Queryable, s: Services, actor: Actor, ev: CurrentSignalEvent): Promise<Decision> {
  const now = s.clock.now();
  const active = ev.value === true;
  const evaluated = { alarm_active: active, correlation_group: ev.correlationGroup };
  let decision: Decision;
  let incidentId: string | null;
  if (active) {
    const res = await raiseCondition(tx, s, actor, ev, {
      source: 'provider_alarm',
      ruleId: null,
      ruleRevisionId: null,
      priority: 'high',
      cooldownSeconds: 0,
      title: `Provider alarm ${ev.signalKey} active (source ${ev.connectorId}).`,
      detail: evaluated,
    });
    decision = res.decision;
    incidentId = res.incidentId;
  } else {
    incidentId = await recordRecovery(tx, s, ev, 'alarm_cleared', evaluated);
    decision = 'alarm_cleared';
  }
  await recordEvaluation(tx, ev, null, evaluated, decision, incidentId, now);
  return decision;
}

/** Closes incidents whose linked request or work order has been resolved by people. */
export async function reconcileIncidents(s: Services, opts: { tenantId?: string } = {}): Promise<number> {
  const now = s.clock.now();
  const { rows } = await s.db.query(
    `SELECT id FROM maintenance.incident WHERE status <> 'closed' AND request_id IS NOT NULL AND ($1::uuid IS NULL OR tenant_id = $1) LIMIT 1000`,
    [opts.tenantId ?? null],
  );
  let closed = 0;
  for (const r of rows) {
    await withTransaction(s.db, async (tx) => {
      const { rows: i } = await tx.query(`SELECT * FROM maintenance.incident WHERE id = $1 AND status <> 'closed' FOR UPDATE SKIP LOCKED`, [r.id]);
      if (i[0] && (await closeIfResolved(tx, i[0], now))) closed++;
    });
  }
  return closed;
}
