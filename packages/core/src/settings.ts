import { withTransaction, type Queryable } from '@vm/db';
import type { siteSettingsRequest } from '@vm/contracts';
import { RegistryUnavailableError } from '@vm/registry';
import { notFound, staleVersion } from '@vm/server-kit';
import type { z } from 'zod';
import type { Actor, Services } from './context.ts';
import { requirePermission, requireVisible } from './access.ts';
import { RegistryOutageError } from './identity-snapshots.ts';
import { writeAudit } from './records.ts';

export interface SiteSettings {
  site_id: string;
  incident_contact_instructions: string | null;
  pm_initial_state: 'ready' | 'pending_approval';
  allow_self_approval: boolean;
  self_approval_justification: string | null;
  repeat_fault_window_days: number;
  holiday_policy: 'none' | 'shift_to_next_working_day';
  holidays: string[];
  shifts: Array<{ code: string; label: string; start_minute: number; end_minute: number }>;
  version: number;
}

export async function loadSiteSettings(db: Queryable, tenantId: string, siteId: string): Promise<SiteSettings> {
  const { rows } = await db.query(
    `INSERT INTO maintenance.site_settings (tenant_id, site_id) VALUES ($1,$2)
     ON CONFLICT (tenant_id, site_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
     RETURNING *, to_json(holidays) AS holidays_json`,
    [tenantId, siteId],
  );
  const r = rows[0]!;
  return {
    site_id: r.site_id,
    incident_contact_instructions: r.incident_contact_instructions,
    pm_initial_state: r.pm_initial_state,
    allow_self_approval: r.allow_self_approval,
    self_approval_justification: r.self_approval_justification,
    repeat_fault_window_days: r.repeat_fault_window_days,
    holiday_policy: r.holiday_policy,
    holidays: (r.holidays_json as string[]) ?? [],
    shifts: Array.isArray(r.shifts) ? r.shifts : [],
    version: r.version,
  };
}

export async function getSiteSettings(s: Services, actor: Actor, siteId: string): Promise<SiteSettings> {
  const p = actor.principal;
  requireVisible(p, ['maintenance.view', 'maintenance.request.create'], siteId, 'Site');
  return loadSiteSettings(s.db, p.tenantId, siteId);
}

export async function updateSiteSettings(s: Services, actor: Actor, siteId: string, input: z.infer<typeof siteSettingsRequest>): Promise<SiteSettings> {
  const p = actor.principal;
  requireVisible(p, 'maintenance.view', siteId, 'Site');
  requirePermission(p, 'maintenance.settings.manage', siteId);
  return withTransaction(s.db, async (tx) => {
    const current = await loadSiteSettings(tx, p.tenantId, siteId);
    await tx.query(`SELECT 1 FROM maintenance.site_settings WHERE tenant_id = $1 AND site_id = $2 FOR UPDATE`, [p.tenantId, siteId]);
    if (current.version !== input.record_version) throw staleVersion(current.version);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== 'record_version')),
    } as SiteSettings;
    await tx.query(
      `UPDATE maintenance.site_settings SET incident_contact_instructions = $3, pm_initial_state = $4, allow_self_approval = $5,
         self_approval_justification = $6, repeat_fault_window_days = $7, holiday_policy = $8, holidays = $9::date[],
         shifts = $10::jsonb, version = version + 1, updated_at = now(), updated_by = $11
       WHERE tenant_id = $1 AND site_id = $2`,
      [p.tenantId, siteId, next.incident_contact_instructions, next.pm_initial_state, next.allow_self_approval, next.self_approval_justification, next.repeat_fault_window_days, next.holiday_policy, next.holidays, JSON.stringify(next.shifts ?? []), p.userId],
    );
    await writeAudit(tx, actor, {
      siteId,
      action: 'site_settings.updated',
      targetType: 'site_settings',
      targetId: siteId,
      beforeVersion: current.version,
      afterVersion: current.version + 1,
      detail: { fields: Object.keys(input).filter((k) => k !== 'record_version') },
    });
    return { ...next, version: current.version + 1 };
  });
}

/** QR scanning never bypasses authentication: resolution runs under the scanning user's identity. */
export async function resolveQrToken(s: Services, actor: Actor, token: string) {
  try {
    const a = await s.registry.resolveQr(actor.token, token);
    if (!a || a.tenant_id !== actor.principal.tenantId) throw notFound('Asset');
    requireVisible(actor.principal, ['maintenance.view', 'maintenance.request.create'], a.site_id, 'Asset');
    return { asset_id: a.id, site_id: a.site_id, code: a.code, name: a.name, lifecycle: a.lifecycle, identity_source: 'registry' as const };
  } catch (err) {
    if (!(err instanceof RegistryUnavailableError)) throw err;
    const { rows } = await s.db.query(`SELECT * FROM maintenance.asset_snapshot WHERE tenant_id = $1 AND qr_token = $2`, [actor.principal.tenantId, token]);
    const r = rows[0];
    if (!r) throw new RegistryOutageError();
    requireVisible(actor.principal, ['maintenance.view', 'maintenance.request.create'], r.site_id, 'Asset');
    return { asset_id: r.asset_id, site_id: r.site_id, code: r.code, name: r.name, lifecycle: r.lifecycle, identity_source: 'snapshot' as const };
  }
}
