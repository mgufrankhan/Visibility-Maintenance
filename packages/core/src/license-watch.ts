import { randomUUID } from 'node:crypto';
import { withTransaction } from '@vm/db';
import type { EntitlementStatus } from '@vm/contracts';
import type { Services, SystemActor } from './context.ts';
import { enqueueEvent, writeAudit } from './records.ts';

/**
 * Re-evaluates each tenant's entitlement on the worker so grace and expiry
 * take effect (and advance the clock high-water mark) even when nobody is
 * using the API, and tells administrators when the state changes. Nothing is
 * deleted or hidden on expiry; capabilities alone narrow (ML-03).
 */
export async function watchLicenses(s: Services, workerId: string, tenantIds: string[]): Promise<Array<{ tenant_id: string; status: EntitlementStatus; changed: boolean }>> {
  const out: Array<{ tenant_id: string; status: EntitlementStatus; changed: boolean }> = [];
  for (const tenantId of tenantIds) {
    s.entitlements.invalidate(tenantId);
    const view = await s.entitlements.view(tenantId);
    const key = `license_status:${tenantId}`;
    const changed = await withTransaction(s.db, async (tx) => {
      const { rows } = await tx.query<{ status: string; seq: number }>(
        `SELECT value->>'status' AS status, (value->>'seq')::int AS seq FROM maintenance.installation_state WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const prior = rows[0];
      if (prior?.status === view.status) return false;
      const seq = (prior?.seq ?? 0) + 1;
      await tx.query(
        `INSERT INTO maintenance.installation_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify({ status: view.status, seq })],
      );
      if (!prior) return false;
      const system: SystemActor = { kind: 'system', tenantId, label: `license-watch:${workerId}`, correlationId: randomUUID() };
      await writeAudit(tx, system, {
        siteId: null,
        action: 'license.status_changed',
        targetType: 'tenant',
        targetId: tenantId,
        detail: { from: prior.status, to: view.status, license_id: view.license_id, grace_ends_at: view.grace_ends_at },
      });
      await enqueueEvent(tx, system, {
        siteId: null,
        type: 'maintenance.license.status_changed',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        aggregateVersion: seq,
        occurredAt: s.clock.now(),
        payload: { from: prior.status, to: view.status, license_id: view.license_id, grace_ends_at: view.grace_ends_at, warnings: view.warnings },
      });
      return true;
    });
    out.push({ tenant_id: tenantId, status: view.status, changed });
  }
  return out;
}
