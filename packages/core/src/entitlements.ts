import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Queryable } from '@vm/db';
import { OPERATIONAL_ROLES, type Capability, type EntitlementView, type LicenseDocument } from '@vm/contracts';
import { evaluateEntitlement, verifyLicense } from '@vm/licensing';
import { AppError, invalid, type Clock } from '@vm/server-kit';
import type { Actor } from './context.ts';
import { writeAudit } from './records.ts';

export class EntitlementRequiredError extends AppError {
  constructor(capability: Capability, status: string) {
    super(403, 'entitlement_required', `This action requires the ${capability} entitlement (license status: ${status})`);
  }
}

export interface EntitlementServiceOptions {
  db: Db;
  clock: Clock;
  publicKeys: Readonly<Record<string, string>>;
  cacheTtlMs?: number;
}

/**
 * Evaluates the locally installed signed license. No network call is made:
 * private installations stay licensed during internet loss (ML-02, ML-04).
 */
export class EntitlementService {
  private cache = new Map<string, { at: number; view: EntitlementView }>();

  constructor(private readonly opts: EntitlementServiceOptions) {}

  async installationId(db: Queryable = this.opts.db): Promise<string> {
    const { rows } = await db.query<{ value: string }>(
      `INSERT INTO maintenance.installation_state (key, value) VALUES ('installation_id', to_jsonb($1::text))
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING value #>> '{}' AS value`,
      [randomUUID()],
    );
    return rows[0]!.value;
  }

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  async view(tenantId: string): Promise<EntitlementView> {
    const ttl = this.opts.cacheTtlMs ?? 5000;
    const hit = this.cache.get(tenantId);
    const nowMs = this.opts.clock.now().getTime();
    if (hit && ttl > 0 && nowMs - hit.at < ttl) return hit.view;
    const view = await this.evaluate(tenantId);
    this.cache.set(tenantId, { at: nowMs, view });
    return view;
  }

  private async evaluate(tenantId: string): Promise<EntitlementView> {
    const { db, clock } = this.opts;
    const now = clock.now();
    const installationId = await this.installationId();
    const { rows } = await db.query<{ document: unknown }>(
      `SELECT document FROM maintenance.license_installation WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    );
    let license: LicenseDocument | null = null;
    let verificationError: string | null = null;
    if (rows[0]) {
      const v = verifyLicense(rows[0].document, this.opts.publicKeys, { tenantId, installationId });
      if (v.ok) license = v.license;
      else verificationError = v.reason;
    }
    const lastSeenAt = await this.touchClock(now);
    return evaluateEntitlement({ license, verificationError, now, lastSeenAt, usage: await this.usage(tenantId) });
  }

  /** Maintains a monotonic time high-water mark to detect clock rollback. */
  private async touchClock(now: Date): Promise<Date | null> {
    const { rows } = await this.opts.db.query<{ value: string }>(
      `SELECT value #>> '{}' AS value FROM maintenance.installation_state WHERE key = 'clock_high_water'`,
    );
    const prior = rows[0] ? new Date(rows[0].value) : null;
    if (!prior || now.getTime() > prior.getTime() + 60_000) {
      await this.opts.db.query(
        `INSERT INTO maintenance.installation_state (key, value, updated_at) VALUES ('clock_high_water', to_jsonb($1::text), now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         WHERE (maintenance.installation_state.value #>> '{}')::timestamptz < $1::timestamptz`,
        [now.toISOString()],
      );
    }
    return prior;
  }

  async usage(tenantId: string, db: Queryable = this.opts.db): Promise<EntitlementView['usage']> {
    const { rows } = await db.query<{ sites: string; users: string; assets: string }>(
      `SELECT
         (SELECT count(*) FROM maintenance.site_snapshot WHERE tenant_id = $1 AND status = 'active') AS sites,
         (SELECT count(DISTINCT user_id) FROM maintenance.role_assignment WHERE tenant_id = $1 AND role = ANY($2::text[])) AS users,
         (SELECT count(*) FROM maintenance.profile WHERE tenant_id = $1 AND maintainable) AS assets`,
      [tenantId, OPERATIONAL_ROLES],
    );
    const r = rows[0]!;
    return { sites: Number(r.sites), operational_users: Number(r.users), maintainable_assets: Number(r.assets) };
  }

  async require(tenantId: string, capability: Capability): Promise<EntitlementView> {
    const view = await this.view(tenantId);
    if (!view.capabilities.includes(capability)) throw new EntitlementRequiredError(capability, view.status);
    return view;
  }

  async has(tenantId: string, capability: Capability): Promise<boolean> {
    return (await this.view(tenantId)).capabilities.includes(capability);
  }

  /** Audited license import. Rejected documents are kept for review; data is never removed. */
  async importLicense(actor: Actor, document: unknown): Promise<EntitlementView> {
    const tenantId = actor.principal.tenantId;
    const installationId = await this.installationId();
    const v = verifyLicense(document, this.opts.publicKeys, { tenantId, installationId });
    await withTransaction(this.opts.db, async (tx) => {
      const id = randomUUID();
      if (v.ok) {
        await tx.query(`UPDATE maintenance.license_installation SET status = 'superseded' WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
      }
      await tx.query(
        `INSERT INTO maintenance.license_installation (id, tenant_id, license_id, document, status, verification_error, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          tenantId,
          v.ok ? v.license.license_id : String((document as { license?: { license_id?: unknown } })?.license?.license_id ?? 'unknown'),
          JSON.stringify(document),
          v.ok ? 'active' : 'rejected',
          v.ok ? null : v.reason,
          actor.principal.userId,
        ],
      );
      await writeAudit(tx, actor, {
        siteId: null,
        action: v.ok ? 'license.imported' : 'license.rejected',
        targetType: 'license',
        targetId: id,
        reason: v.ok ? null : v.reason,
        detail: v.ok ? { license_id: v.license.license_id, features: v.license.features, term: v.license.term } : {},
      });
    });
    this.invalidate(tenantId);
    if (!v.ok) throw invalid(`License rejected: ${v.reason}`);
    return this.view(tenantId);
  }
}
