import type { Permission, WorkOrderAction, WorkOrderState } from '@vm/contracts';

export interface TransitionRule {
  from: readonly WorkOrderState[];
  to: WorkOrderState;
  permission: Permission;
  reasonRequired: boolean;
}

/** PRD §7 lifecycle table. Overdue is derived, never a state. */
export const TRANSITIONS: Record<WorkOrderAction, TransitionRule> = {
  submit_for_approval: { from: ['draft'], to: 'pending_approval', permission: 'maintenance.work_order.create', reasonRequired: false },
  approve: { from: ['pending_approval'], to: 'ready', permission: 'maintenance.work_order.approve', reasonRequired: false },
  return_to_draft: { from: ['pending_approval'], to: 'draft', permission: 'maintenance.work_order.approve', reasonRequired: true },
  request_reapproval: { from: ['ready'], to: 'pending_approval', permission: 'maintenance.work_order.edit', reasonRequired: true },
  start: { from: ['ready'], to: 'in_progress', permission: 'maintenance.work_order.execute', reasonRequired: false },
  hold: { from: ['in_progress'], to: 'on_hold', permission: 'maintenance.work_order.execute', reasonRequired: true },
  resume: { from: ['on_hold'], to: 'in_progress', permission: 'maintenance.work_order.execute', reasonRequired: false },
  submit_completion: { from: ['in_progress'], to: 'pending_review', permission: 'maintenance.work_order.complete', reasonRequired: false },
  return_for_rework: { from: ['pending_review'], to: 'in_progress', permission: 'maintenance.work_order.approve', reasonRequired: true },
  close: { from: ['pending_review'], to: 'closed', permission: 'maintenance.work_order.approve', reasonRequired: false },
  reopen: { from: ['closed'], to: 'in_progress', permission: 'maintenance.work_order.approve', reasonRequired: true },
  cancel: {
    from: ['draft', 'pending_approval', 'ready', 'on_hold'],
    to: 'cancelled',
    permission: 'maintenance.work_order.cancel',
    reasonRequired: true,
  },
};

export function transitionFor(action: WorkOrderAction, from: WorkOrderState): TransitionRule | null {
  const rule = TRANSITIONS[action];
  return rule.from.includes(from) ? rule : null;
}

export function availableActions(state: WorkOrderState): WorkOrderAction[] {
  return (Object.keys(TRANSITIONS) as WorkOrderAction[]).filter((a) => TRANSITIONS[a].from.includes(state));
}

/** States in which already-approved work may continue after license grace ends (PRD ML-03). */
export const APPROVED_ACTIVE_STATES: readonly WorkOrderState[] = ['ready', 'in_progress', 'on_hold', 'pending_review'];

export const OPEN_STATES: readonly WorkOrderState[] = [
  'draft',
  'pending_approval',
  'ready',
  'in_progress',
  'on_hold',
  'pending_review',
];
