import { checkRegistryBinding, dispatchOutbox, reconcileIncidents, recordHeartbeat, recordJobStatus, runAutomations, runMeterPlans, runPmScheduler, syncRegistry, watchLicenses, type OutboxSink, type Services } from '@vm/core';

export interface WorkerJob {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface WorkerOptions {
  services: Services;
  workerId: string;
  /** Tenants whose system service accounts this worker may use. */
  tenantIds: () => string[];
  sinks?: OutboxSink[];
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

export function maintenanceJobs(o: WorkerOptions): WorkerJob[] {
  const s = o.services;
  return [
    { name: 'outbox', intervalMs: 2_000, run: () => dispatchOutbox(s, o.workerId, { sinks: o.sinks }) },
    { name: 'pm-scheduler', intervalMs: 60_000, run: () => runPmScheduler(s, o.workerId) },
    { name: 'meter-pm', intervalMs: 60_000, run: () => runMeterPlans(s, o.workerId) },
    { name: 'incident-reconcile', intervalMs: 30_000, run: () => reconcileIncidents(s) },
    { name: 'automation', intervalMs: 60_000, run: () => runAutomations(s, o.workerId) },
    { name: 'license-watch', intervalMs: 15 * 60_000, run: () => watchLicenses(s, o.workerId, o.tenantIds()) },
    {
      name: 'registry-sync',
      intervalMs: 5 * 60_000,
      run: async () => {
        const binding = await checkRegistryBinding(s, { bind: false });
        if (binding.status !== 'bound') throw new Error(`Registry sync skipped: registry is ${binding.status}`);
        const out: Record<string, unknown> = {};
        for (const t of o.tenantIds()) out[t] = await syncRegistry(s, t);
        return out;
      },
    },
    { name: 'heartbeat', intervalMs: 30_000, run: () => recordHeartbeat(s, o.workerId) },
  ];
}

/**
 * Runs each job on its own timer without overlapping itself. Correctness under
 * several workers comes from database leases, SKIP LOCKED and unique keys,
 * not from this loop. Each run's outcome is recorded for /health/details.
 */
export function startWorker(
  jobs: WorkerJob[],
  opts: { services: Pick<Services, 'db' | 'clock'>; workerId: string; log?: WorkerOptions['log'] },
): { stop: () => Promise<void> } {
  const log = opts.log ?? (() => {});
  let stopping = false;
  const running = new Set<Promise<void>>();
  const timers: NodeJS.Timeout[] = [];
  const record = (job: string, error: string | null) =>
    recordJobStatus(opts.services, opts.workerId, job, error).catch((err: Error) => log('job status not recorded', { job, error: err.message }));
  for (const job of jobs) {
    let busy = false;
    const tick = () => {
      if (stopping || busy) return;
      busy = true;
      const p = job
        .run()
        .then(async (result) => {
          log(`${job.name} ok`, { result: result as Record<string, unknown> });
          await record(job.name, null);
        })
        .catch(async (err: Error) => {
          log(`${job.name} failed`, { error: err.message });
          await record(job.name, err.message);
        })
        .finally(() => {
          busy = false;
          running.delete(p);
        });
      running.add(p);
    };
    tick();
    timers.push(setInterval(tick, job.intervalMs));
  }
  return {
    async stop() {
      stopping = true;
      for (const t of timers) clearInterval(t);
      await Promise.allSettled([...running]);
    },
  };
}
