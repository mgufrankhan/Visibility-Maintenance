import { describe, expect, it } from 'vitest';
import { availableActions, can, sitesWith, transitionFor, type Principal } from '@vm/policy';

const site1 = 's1';
const site2 = 's2';
const principal = (roles: Principal['roles'], memberSiteIds = [site1]): Principal => ({
  userId: 'u',
  tenantId: 't',
  kind: 'human',
  displayName: 'U',
  memberSiteIds,
  platformRoles: [],
  roles,
});

describe('permission evaluation', () => {
  it('requires both platform membership and a maintenance role on the site', () => {
    const p = principal([{ role: 'supervisor', siteId: null }], [site1]);
    expect(can(p, 'maintenance.work_order.approve', site1)).toBe(true);
    expect(can(p, 'maintenance.work_order.approve', site2)).toBe(false);
  });

  it('does not let platform administration imply maintenance rights', () => {
    const p = { ...principal([]), platformRoles: [{ role: 'platform_admin' as const, siteId: null }] };
    expect(can(p, 'maintenance.view', site1)).toBe(false);
  });

  it('keeps cost visibility separate from managerial roles', () => {
    expect(can(principal([{ role: 'maintenance_manager', siteId: site1 }]), 'maintenance.cost.view', site1)).toBe(false);
    expect(can(principal([{ role: 'cost_viewer', siteId: site1 }]), 'maintenance.cost.view', site1)).toBe(true);
  });

  it('gives reporters only request creation and own-request visibility', () => {
    const p = principal([{ role: 'reporter', siteId: site1 }]);
    expect(can(p, 'maintenance.request.create', site1)).toBe(true);
    expect(can(p, 'maintenance.view', site1)).toBe(false);
    expect(can(p, 'maintenance.work_order.execute', site1)).toBe(false);
  });

  it('gives viewers no mutation rights', () => {
    const p = principal([{ role: 'viewer', siteId: site1 }]);
    expect(sitesWith(p, 'maintenance.view')).toEqual([site1]);
    expect(can(p, 'maintenance.request.triage', site1)).toBe(false);
    expect(can(p, 'maintenance.work_order.create', site1)).toBe(false);
  });

  it('keeps connector and Neo service identities away from closure and approval', () => {
    for (const role of ['connector_service', 'neo_service'] as const) {
      const p = principal([{ role, siteId: null }]);
      expect(can(p, 'maintenance.work_order.approve', site1)).toBe(false);
      expect(can(p, 'maintenance.recommendation.decide', site1)).toBe(false);
    }
  });
});

describe('work-order lifecycle table', () => {
  it('allows only the documented transitions', () => {
    expect(availableActions('draft').sort()).toEqual(['cancel', 'submit_for_approval']);
    expect(availableActions('in_progress').sort()).toEqual(['hold', 'submit_completion']);
    expect(availableActions('closed')).toEqual(['reopen']);
    expect(availableActions('cancelled')).toEqual([]);
    expect(transitionFor('cancel', 'in_progress')).toBeNull();
    expect(transitionFor('close', 'in_progress')).toBeNull();
    expect(transitionFor('reopen', 'closed')?.to).toBe('in_progress');
  });
});
