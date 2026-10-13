import type { Queryable } from '@vm/db';
import type { Services } from './context.ts';
import { connectorOperationalCounts } from './ingestion.ts';

/** A worker that has not written a heartbeat for this long is reported stale. */
export const WORKER_STALE_SECONDS = 120;
/** Proposed pilot RPO (24 h); an older successful backup is flagged. */
export const BACKUP_STALE_SECONDS = 24 * 3600;

export interface JobStatus {
  ok: boolean;
  at: string;
  error: string | null;
}

export async function recordJobStatus(s: Pick<Services, 'db' | 'clock'>, workerId: string, job: string, error: string | null): Promise<void> {
  await s.db.query(
    `INSERT INTO maintenance.installation_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`job_status:${job}:${workerId}`, JSON.stringify({ ok: error === null, at: s.clock.now().toISOString(), error } satisfies JobStatus)],
  );
}

export async function recordHeartbeat(s: Pick<Services, 'db' | 'clock'>, workerId: string): Promise<void> {
  await s.db.query(
    `INSERT INTO maintenance.installation_state (key, value) VALUES ($1, to_jsonb($2::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`worker_heartbeat:${workerId}`, s.clock.now().toISOString()],
  );
}

export async function recordBackup(db: Queryable, info: { backup_id: string; completed_at: string; location: string }): Promise<void> {
  await db.query(
    `INSERT INTO maintenance.installation_state (key, value) VALUES ('last_backup', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(info)],
  );
}

/**
 * Installation-wide operational signals (docs/08 Monitoring). Only counts and
 * ages are returned so the endpoint discloses no tenant records.
 */
export async function operationalHealth(s: Pick<Services, 'db' | 'clock' | 'config'>) {
  const now = s.clock.now();
  const { rows } = await s.db.query(
    `SELECT
       (SELECT count(*) FROM maintenance.outbox WHERE status = 'pending')::int AS outbox_pending,
       (SELECT extract(epoch FROM $1::timestamptz - min(occurred_at)) FROM maintenance.outbox WHERE status = 'pending')::float AS outbox_oldest_seconds,
       (SELECT count(*) FROM maintenance.outbox WHERE status = 'failed')::int AS outbox_failed,
       (SELECT count(*) FROM maintenance.outbox WHERE status = 'pending' AND attempts > 0)::int AS outbox_retrying,
       (SELECT extract(epoch FROM $1::timestamptz - min(next_generate_at)) FROM maintenance.pm_plan
         WHERE status = 'active' AND next_generate_at < $1::timestamptz)::float AS scheduler_lag_seconds,
       (SELECT count(*) FROM maintenance.pm_plan WHERE status = 'active' AND last_generation_issue IS NOT NULL)::int AS plans_with_issues,
       (SELECT coalesce(sum(size_bytes), 0) FROM maintenance.attachment WHERE status = 'available')::bigint AS attachment_bytes`,
    [now],
  );
  const state = await s.db.query<{ key: string; value: any; updated_at: Date }>(
    `SELECT key, value, updated_at FROM maintenance.installation_state
      WHERE key LIKE 'worker_heartbeat:%' OR key LIKE 'job_status:%' OR key LIKE 'license_status:%' OR key IN ('last_backup', 'registry_binding')`,
  );
  const workers: Array<{ worker_id: string; age_seconds: number; stale: boolean }> = [];
  const failingJobs: Array<{ job: string; worker_id: string; at: string; error: string | null }> = [];
  const licenseStatuses: Record<string, number> = {};
  let lastBackup: { completed_at: string; age_seconds: number; stale: boolean } | null = null;
  let registryBound = false;
  for (const r of state.rows) {
    if (r.key.startsWith('worker_heartbeat:')) {
      const age = Math.max(0, (now.getTime() - new Date(r.value as string).getTime()) / 1000);
      workers.push({ worker_id: r.key.slice('worker_heartbeat:'.length), age_seconds: Math.round(age), stale: age > WORKER_STALE_SECONDS });
    } else if (r.key.startsWith('job_status:')) {
      const v = r.value as JobStatus;
      const [, job, ...rest] = r.key.split(':');
      if (!v.ok) failingJobs.push({ job: job!, worker_id: rest.join(':'), at: v.at, error: v.error });
    } else if (r.key.startsWith('license_status:')) {
      const status = String(r.value.status);
      licenseStatuses[status] = (licenseStatuses[status] ?? 0) + 1;
    } else if (r.key === 'last_backup') {
      const age = Math.max(0, (now.getTime() - Date.parse(r.value.completed_at)) / 1000);
      lastBackup = { completed_at: r.value.completed_at, age_seconds: Math.round(age), stale: age > BACKUP_STALE_SECONDS };
    } else if (r.key === 'registry_binding') {
      registryBound = true;
    }
  }
  const m = rows[0]!;
  const warnings: string[] = [];
  if (workers.length === 0) warnings.push('No maintenance worker has reported a heartbeat; PM generation and notifications are not running.');
  else if (workers.every((w) => w.stale)) warnings.push('All maintenance workers are stale.');
  if (m.outbox_failed > 0) warnings.push(`${m.outbox_failed} outbox events failed delivery and need administrator retry.`);
  if (m.plans_with_issues > 0) warnings.push(`${m.plans_with_issues} active PM plans have generation issues.`);
  if (!lastBackup) warnings.push('No completed backup has been recorded.');
  else if (lastBackup.stale) warnings.push('Last backup is older than the proposed 24 hour RPO.');
  if (failingJobs.length > 0) warnings.push(`Failing background jobs: ${[...new Set(failingJobs.map((j) => j.job))].join(', ')}.`);
  if ((licenseStatuses.expired ?? 0) + (licenseStatuses.invalid ?? 0) + (licenseStatuses.missing ?? 0) > 0) warnings.push('One or more tenants lack a valid license; new work creation is restricted.');
  if (!registryBound) warnings.push('Installation is not bound to a registry.');
  const connectors = await connectorOperationalCounts(s.db).catch(() => ({ active: 0, simulated_active: 0, open_review: 0, quarantined_24h: 0 }));
  if (connectors.simulated_active > 0) warnings.push('A labeled simulated connector is active; it is not a production telemetry source.');
  if (connectors.open_review > 0) warnings.push(`${connectors.open_review} connector review items are open.`);
  if (s.config.neoInferencePolicy !== 'disabled') warnings.push('Neo is using the deterministic retrieval runtime; no qualified model is installed.');
  return {
    outbox: { pending: m.outbox_pending, retrying: m.outbox_retrying, failed: m.outbox_failed, oldest_pending_seconds: m.outbox_oldest_seconds === null ? null : Math.round(m.outbox_oldest_seconds) },
    scheduler: { lag_seconds: m.scheduler_lag_seconds === null ? 0 : Math.round(m.scheduler_lag_seconds), plans_with_issues: m.plans_with_issues },
    workers,
    failing_jobs: failingJobs,
    storage: { attachment_bytes: Number(m.attachment_bytes) },
    backup: lastBackup,
    license_statuses: licenseStatuses,
    registry_bound: registryBound,
    connectors: { active: Number(connectors.active), simulated_active: Number(connectors.simulated_active), open_review: Number(connectors.open_review), quarantined_24h: Number(connectors.quarantined_24h) },
    neo: {
      inference_policy: s.config.neoInferencePolicy,
      runtime: s.config.neoInferencePolicy === 'disabled' ? 'disabled' : 'deterministic-retrieval',
      model_qualified: false,
      cloud_calls: false,
    },
    warnings,
  };
}
