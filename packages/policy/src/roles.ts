import type { MaintenanceRole, Permission } from '@vm/contracts';

const reporter: Permission[] = ['maintenance.request.create', 'maintenance.request.view_own'];

const technician: Permission[] = [
  ...reporter,
  'maintenance.view',
  'maintenance.work_order.execute',
  'maintenance.work_order.complete',
  'maintenance.inspection.execute',
  'maintenance.downtime.create',
  'maintenance.neo.use',
];

const supervisor: Permission[] = [
  ...technician,
  'maintenance.request.triage',
  'maintenance.work_order.create',
  'maintenance.work_order.edit',
  'maintenance.work_order.assign',
  'maintenance.work_order.approve',
  'maintenance.work_order.cancel',
  'maintenance.procedure.manage',
  'maintenance.plan.manage',
  'maintenance.inspection.manage',
  'maintenance.downtime.correct',
  'maintenance.report.view',
  'maintenance.export',
  'maintenance.recommendation.decide',
  'maintenance.neo.draft',
  'maintenance.stores.view',
];

/**
 * Default grants per PRD §4 and 04_PERMISSIONS_AND_LICENSING. Cost visibility
 * is never implied: it requires the explicit cost_viewer role.
 */
export const ROLE_GRANTS: Record<MaintenanceRole, readonly Permission[]> = {
  reporter,
  technician,
  supervisor,
  maintenance_manager: [...supervisor, 'maintenance.settings.manage', 'maintenance.access.manage', 'maintenance.stores.manage'],
  asset_administrator: ['maintenance.view', 'maintenance.profile.manage'],
  viewer: ['maintenance.view', 'maintenance.report.view', 'maintenance.export', 'maintenance.stores.view'],
  cost_viewer: ['maintenance.cost.view'],
  maintenance_admin: [
    'maintenance.view',
    'maintenance.report.view',
    'maintenance.export',
    'maintenance.settings.manage',
    'maintenance.access.manage',
    'maintenance.license.manage',
    'maintenance.integration.manage',
    'maintenance.automation.manage',
    'maintenance.stores.view',
    'maintenance.stores.manage',
    'maintenance.stores.move',
    'maintenance.stores.reserve',
  ],
  stores_user: [
    'maintenance.view',
    'maintenance.stores.view',
    'maintenance.stores.move',
    'maintenance.stores.reserve',
  ],
  connector_service: ['maintenance.event.ingest'],
  neo_service: ['maintenance.view', 'maintenance.neo.use', 'maintenance.neo.draft'],
};

export function permissionsForRole(role: MaintenanceRole): readonly Permission[] {
  return ROLE_GRANTS[role];
}
