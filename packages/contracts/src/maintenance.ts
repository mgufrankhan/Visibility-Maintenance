import { z } from 'zod';
import { criticality, isoTimestamp, priority } from './common.ts';
import { MAINTENANCE_ROLES } from './permissions.ts';

// ---------- Profiles, teams, access ----------

export const upsertProfileRequest = z.object({
  maintainable: z.boolean(),
  criticality: criticality.nullable().default(null),
  team_id: z.uuid().nullable().default(null),
  warranty_reference: z.string().max(200).nullable().default(null),
  service_interval_defaults: z.record(z.string(), z.unknown()).default({}),
  failure_taxonomy: z.array(z.string().min(1).max(60)).max(200).default([]),
  document_links: z.array(z.object({ title: z.string().min(1).max(200), attachment_id: z.uuid() })).max(100).default([]),
  record_version: z.number().int().positive().optional(),
});

export const createTeamRequest = z.object({
  site_id: z.uuid(),
  name: z.string().min(1).max(120),
  member_ids: z.array(z.uuid()).max(500).default([]),
});

export const roleAssignmentRequest = z.object({
  user_id: z.uuid(),
  role: z.enum(MAINTENANCE_ROLES),
  site_id: z.uuid().nullable().default(null),
});

export const shiftWindow = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().min(1).max(80),
  start_minute: z.number().int().min(0).max(1439),
  end_minute: z.number().int().min(0).max(1439),
});
export type ShiftWindow = z.infer<typeof shiftWindow>;

export const siteSettingsRequest = z
  .object({
    incident_contact_instructions: z.string().max(2000).nullable().optional(),
    pm_initial_state: z.enum(['ready', 'pending_approval']).optional(),
    allow_self_approval: z.boolean().optional(),
    self_approval_justification: z.string().max(1000).nullable().optional(),
    repeat_fault_window_days: z.number().int().min(1).max(365).optional(),
    holiday_policy: z.enum(['none', 'shift_to_next_working_day']).optional(),
    holidays: z.array(z.iso.date()).max(400).optional(),
    shifts: z.array(shiftWindow).max(12).optional(),
    working_languages: z.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/)).min(1).max(8).optional(),
    pm_block_on_shortage: z.boolean().optional(),
    record_version: z.number().int().positive(),
  })
  .refine((s) => !s.shifts || new Set(s.shifts.map((w) => w.code)).size === s.shifts.length, {
    message: 'shift codes must be unique',
    path: ['shifts'],
  })
  .refine((s) => !s.working_languages || new Set(s.working_languages).size === s.working_languages.length, {
    message: 'working languages must be unique',
    path: ['working_languages'],
  });

export const captureFields = z.object({
  symptom: z.string().max(500).nullable().default(null),
  failure_code: z.string().max(60).nullable().default(null),
  cause: z.string().max(2000).nullable().default(null),
  action: z.string().max(2000).nullable().default(null),
  notes: z.string().max(5000).nullable().default(null),
});

export const structuredCaptureRequest = z
  .object({
    site_id: z.uuid(),
    request_id: z.uuid().nullable().default(null),
    work_order_id: z.uuid().nullable().default(null),
    text: z.string().max(5000).nullable().default(null),
    attachment_id: z.uuid().nullable().default(null),
    fields: captureFields.nullable().default(null),
  })
  .refine((v) => Boolean(v.request_id || v.work_order_id), { message: 'A request or work order is required' })
  .refine((v) => Boolean(v.text || v.attachment_id || v.fields), { message: 'Provide text, an audio attachment, or marked fields' });

export const requestTranslationRequest = z.object({
  target_language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  body: z.string().min(1).max(5000),
  record_version: z.number().int().positive(),
});

// ---------- Typed checks (procedures and inspections share this schema) ----------

export const CHECK_TYPES = ['pass_fail', 'numeric', 'text', 'photo', 'acknowledgment'] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const VISIBLE_WHEN = ['failed', 'passed', 'outside_limits'] as const;
export type VisibleWhen = (typeof VISIBLE_WHEN)[number];

export const visibleWhen = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,60}$/),
  when: z.enum(VISIBLE_WHEN),
});

export const checkDefinition = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{1,60}$/),
    label: z.string().min(1).max(300),
    type: z.enum(CHECK_TYPES),
    required: z.boolean().default(true),
    min: z.number().nullable().default(null),
    max: z.number().nullable().default(null),
    unit: z.string().max(30).nullable().default(null),
    evidence_required: z.boolean().default(false),
    safety_critical: z.boolean().default(false),
    visible_when: visibleWhen.nullable().default(null),
  })
  .refine((c) => c.type !== 'numeric' || c.unit !== null, { message: 'numeric checks require a unit', path: ['unit'] })
  .refine((c) => c.min === null || c.max === null || c.min <= c.max, { message: 'min must not exceed max', path: ['min'] });
export type CheckDefinition = z.infer<typeof checkDefinition>;

/** Rejects forward references, cycles, unknown keys, and conditions the prior check cannot produce. */
export function checkGraphError(list: Array<Pick<CheckDefinition, 'key' | 'type' | 'visible_when'>>): string | null {
  const index = new Map(list.map((step, i) => [step.key, i]));
  for (const step of list) {
    const rule = step.visible_when;
    if (!rule) continue;
    const priorAt = index.get(rule.key);
    if (priorAt === undefined) return `Check "${step.key}" references unknown check "${rule.key}"`;
    if (priorAt >= index.get(step.key)!) return `Check "${step.key}" must reference an earlier check`;
    const prior = list[priorAt]!;
    if (rule.when === 'outside_limits' && prior.type !== 'numeric') {
      return `Check "${step.key}" uses outside_limits, which requires numeric check "${rule.key}"`;
    }
    if ((rule.when === 'failed' || rule.when === 'passed') && prior.type !== 'pass_fail' && prior.type !== 'numeric') {
      return `Check "${step.key}" uses ${rule.when}, which requires a pass/fail or numeric check`;
    }
  }
  return null;
}

export const checkListSchema = z
  .array(checkDefinition)
  .min(1)
  .max(200)
  .refine((list) => new Set(list.map((c) => c.key)).size === list.length, { message: 'check keys must be unique' })
  .check((ctx) => {
    const message = checkGraphError(ctx.value);
    if (message) ctx.issues.push({ code: 'custom', message, input: ctx.value });
  });

export const checkValue = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,60}$/),
  value: z.union([z.boolean(), z.number(), z.string().max(5000), z.null()]),
  unit: z.string().max(30).nullable().default(null),
  note: z.string().max(5000).nullable().default(null),
  attachment_ids: z.array(z.uuid()).max(20).default([]),
});
export type CheckValue = z.infer<typeof checkValue>;

// ---------- Procedures ----------

export const createProcedureRequest = z.object({
  site_id: z.uuid().nullable().default(null),
  title: z.string().min(1).max(200),
});

export const procedureRevisionRequest = z.object({
  summary: z.string().max(2000).default(''),
  safety_instructions: z.string().min(1).max(10000),
  steps: checkListSchema,
  estimated_minutes: z.number().int().positive().max(100000).nullable().default(null),
  signature_required: z.boolean().default(false),
});

export const completionSignatureRequest = z.object({
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  record_version: z.number().int().positive(),
  client_op_id: z.string().max(100).nullable().default(null),
  amendment_reason: z.string().max(2000).nullable().default(null),
});
export type CompletionSignatureRequest = z.infer<typeof completionSignatureRequest>;

// ---------- Requests ----------

export const REQUEST_STATES = ['submitted', 'under_review', 'accepted', 'rejected', 'duplicate'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_ORIGINS = ['manual', 'inspection', 'connector', 'neo'] as const;
export type RequestOrigin = (typeof REQUEST_ORIGINS)[number];

export const createRequestRequest = z
  .object({
    site_id: z.uuid(),
    asset_id: z.uuid().nullable().default(null),
    location_text: z.string().max(300).nullable().default(null),
    description: z.string().min(3).max(5000),
    observed_at: isoTimestamp,
    proposed_priority: priority.default('normal'),
    reading: z
      .object({ value: z.number(), unit: z.string().min(1).max(30), label: z.string().max(100).nullable().default(null) })
      .nullable()
      .default(null),
    voice_transcript: z.string().max(5000).nullable().default(null),
    client_request_id: z.string().max(100).nullable().default(null),
  })
  .refine((r) => r.asset_id !== null || (r.location_text?.trim().length ?? 0) > 0, {
    message: 'Requests without an asset require a location',
    path: ['location_text'],
  });

const workOrderDraftFields = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['corrective', 'preventive', 'inspection', 'follow_up']).default('corrective'),
  priority,
  team_id: z.uuid(),
  scope: z.string().min(1).max(5000),
  asset_id: z.uuid().nullable().default(null),
  non_asset_category: z.string().max(100).nullable().default(null),
  non_asset_justification: z.string().max(2000).nullable().default(null),
});

export const triageRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start_review'), record_version: z.number().int().positive() }),
  z.object({
    action: z.literal('accept'),
    record_version: z.number().int().positive(),
    reason: z.string().max(2000).nullable().default(null),
    link_work_order_id: z.uuid().nullable().default(null),
    draft: workOrderDraftFields.nullable().default(null),
  }),
  z.object({ action: z.literal('reject'), record_version: z.number().int().positive(), reason: z.string().min(3).max(2000) }),
  z.object({
    action: z.literal('mark_duplicate'),
    record_version: z.number().int().positive(),
    reason: z.string().min(3).max(2000),
    duplicate_of_request_id: z.uuid().nullable().default(null),
    duplicate_of_work_order_id: z.uuid().nullable().default(null),
  }),
]);
export type TriageRequest = z.infer<typeof triageRequest>;

// ---------- Work orders ----------

export const WORK_ORDER_TYPES = ['corrective', 'preventive', 'inspection', 'follow_up'] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

export const WORK_ORDER_STATES = [
  'draft',
  'pending_approval',
  'ready',
  'in_progress',
  'on_hold',
  'pending_review',
  'closed',
  'cancelled',
] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

export const WORK_ORDER_ACTIONS = [
  'submit_for_approval',
  'approve',
  'return_to_draft',
  'request_reapproval',
  'start',
  'hold',
  'resume',
  'submit_completion',
  'return_for_rework',
  'close',
  'reopen',
  'cancel',
] as const;
export type WorkOrderAction = (typeof WORK_ORDER_ACTIONS)[number];

export const createWorkOrderRequest = workOrderDraftFields.extend({
  site_id: z.uuid(),
  description: z.string().max(10000).default(''),
  source_request_id: z.uuid().nullable().default(null),
  planned_start: isoTimestamp.nullable().default(null),
  planned_end: isoTimestamp.nullable().default(null),
  due_at: isoTimestamp.nullable().default(null),
  assignee_id: z.uuid().nullable().default(null),
  procedure_revision_id: z.uuid().nullable().default(null),
  safety_instructions: z.string().max(10000).nullable().default(null),
});

/** Links an existing asset order under a shutdown parent. Repeating the same pair is a no-op. */
export const linkChildRequest = z.object({
  work_order_id: z.uuid(),
});

export const patchWorkOrderRequest = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(10000),
    priority,
    team_id: z.uuid(),
    scope: z.string().min(1).max(5000),
    planned_start: isoTimestamp.nullable(),
    planned_end: isoTimestamp.nullable(),
    due_at: isoTimestamp.nullable(),
    procedure_revision_id: z.uuid().nullable(),
    safety_instructions: z.string().max(10000).nullable(),
    assignee_id: z.uuid().nullable(),
    asset_id: z.uuid(),
    non_asset_category: z.string().max(100).nullable(),
    non_asset_justification: z.string().max(2000).nullable(),
  })
  .partial()
  .strict();
export type PatchWorkOrder = z.infer<typeof patchWorkOrderRequest>;

export const completionDetails = z.object({
  observed_symptoms: z.string().max(5000).nullable().default(null),
  failure_code: z.string().max(60).nullable().default(null),
  cause_code: z.string().max(60).nullable().default(null),
  cause_unknown_reason: z.string().max(2000).nullable().default(null),
  corrective_action: z.string().max(5000).nullable().default(null),
  acknowledgments: z.array(z.string().max(100)).max(20).default([]),
});
export type CompletionDetails = z.infer<typeof completionDetails>;

export const transitionRequest = z.object({
  action: z.enum(WORK_ORDER_ACTIONS),
  record_version: z.number().int().positive(),
  reason: z.string().max(2000).nullable().default(null),
  completion: completionDetails.nullable().default(null),
  closure_outcome: z.enum(['restored', 'partially_restored', 'not_restored', 'not_applicable']).nullable().default(null),
});
export type TransitionRequest = z.infer<typeof transitionRequest>;

export const taskResultRequest = z.object({
  results: z.array(checkValue).min(1).max(200),
  client_op_id: z.string().max(100).nullable().default(null),
  /** Device capture time for offline entries; the server records its own receipt time separately. */
  recorded_at: isoTimestamp.nullable().default(null),
  amends_result_id: z.uuid().nullable().default(null),
  amendment_reason: z.string().max(2000).nullable().default(null),
});

export const checkExceptionRequest = z.object({
  step_key: z.string().regex(/^[a-z0-9_]{1,60}$/),
  reason: z.string().min(10).max(2000),
});

export const laborEntryRequest = z
  .object({
    person_id: z.uuid().nullable().default(null),
    started_at: isoTimestamp,
    ended_at: isoTimestamp.nullable().default(null),
    duration_minutes: z.number().int().min(0).max(7 * 24 * 60).nullable().default(null),
    note: z.string().max(2000).nullable().default(null),
    client_op_id: z.string().max(100).nullable().default(null),
    amends_entry_id: z.uuid().nullable().default(null),
    amendment_reason: z.string().max(2000).nullable().default(null),
  })
  .refine((l) => l.ended_at !== null || l.duration_minutes !== null, {
    message: 'Provide ended_at or duration_minutes',
    path: ['ended_at'],
  });

export const commentRequest = z.object({
  body: z.string().min(1).max(5000),
  client_op_id: z.string().max(100).nullable().default(null),
});

export const evidenceRequest = z.object({
  file_name: z.string().min(1).max(255),
  media_type: z.string().min(3).max(120),
  size_bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  step_key: z.string().regex(/^[a-z0-9_]{1,60}$/).nullable().default(null),
  client_op_id: z.string().max(100).nullable().default(null),
});

export const failureLinkRequest = z.object({ failure_event_id: z.uuid() });

// ---------- Planned maintenance ----------

export const calendarTrigger = z.object({
  type: z.literal('calendar'),
  unit: z.enum(['day', 'week', 'month']),
  interval: z.number().int().min(1).max(366),
  anchor_date: z.iso.date(),
  time_of_day: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

/** Usage-based trigger on a validated cumulative meter (MP-04). Amounts are in the meter's unit. */
export const meterTrigger = z.object({
  type: z.literal('meter'),
  interval: z.number().positive().finite(),
  /** Issue the order this much usage before the threshold is reached. */
  lead_usage: z.number().min(0).finite().default(0),
  /** Calendar days allowed to complete after issue. */
  due_days: z.number().int().min(0).max(365).default(7),
});

export const planTrigger = z.discriminatedUnion('type', [calendarTrigger, meterTrigger]);

export const createPlanRequest = z
  .object({
    site_id: z.uuid(),
    asset_id: z.uuid(),
    title: z.string().min(1).max(200),
    trigger_kind: z.enum(['calendar', 'meter']).default('calendar'),
    meter_id: z.uuid().nullable().default(null),
  })
  .refine((p) => (p.trigger_kind === 'meter') === (p.meter_id !== null), { message: 'Meter plans require meter_id; calendar plans must not set it', path: ['meter_id'] });

export const expectedPart = z.object({
  part_id: z.uuid(),
  quantity: z.number().positive().max(1_000_000),
});

export const planRevisionRequest = z
  .object({
    title: z.string().min(1).max(200),
    scope: z.string().min(1).max(5000),
    procedure_revision_id: z.uuid(),
    team_id: z.uuid(),
    priority: priority.default('normal'),
    estimated_minutes: z.number().int().positive().max(100000),
    lead_days: z.number().int().min(0).max(365).default(7),
    trigger: planTrigger,
    effective_from: z.iso.date(),
    effective_to: z.iso.date().nullable().default(null),
    expected_parts: z.array(expectedPart).max(40).default([]),
  })
  .refine((r) => r.effective_to === null || r.effective_to >= r.effective_from, { message: 'effective_to precedes effective_from', path: ['effective_to'] })
  .refine((r) => new Set(r.expected_parts.map((p) => p.part_id)).size === r.expected_parts.length, {
    message: 'expected parts must be unique',
    path: ['expected_parts'],
  });

export const planStatusRequest = z.object({
  record_version: z.number().int().positive(),
  reason: z.string().min(3).max(2000),
});

// ---------- Downtime and reliability ----------

export const FAILURE_CLASSIFICATIONS = ['candidate', 'unplanned_failure', 'planned_stop', 'break', 'communication_loss', 'other'] as const;
export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

export const createDowntimeRequest = z
  .object({
    asset_id: z.uuid(),
    started_at: isoTimestamp,
    restored_at: isoTimestamp.nullable().default(null),
    classification: z.enum(FAILURE_CLASSIFICATIONS).default('candidate'),
    symptom: z.string().max(2000).nullable().default(null),
    failure_code: z.string().max(60).nullable().default(null),
    production_impact: z.string().max(2000).nullable().default(null),
    work_order_id: z.uuid().nullable().default(null),
    client_op_id: z.string().max(100).nullable().default(null),
  })
  .refine((d) => d.restored_at === null || d.restored_at >= d.started_at, { message: 'restored_at precedes started_at', path: ['restored_at'] });

export const restoreDowntimeRequest = z.object({
  record_version: z.number().int().positive(),
  restored_at: isoTimestamp,
});

export const amendDowntimeRequest = z.object({
  record_version: z.number().int().positive(),
  reason: z.string().min(3).max(2000),
  changes: z
    .object({
      started_at: isoTimestamp,
      restored_at: isoTimestamp.nullable(),
      classification: z.enum(FAILURE_CLASSIFICATIONS),
      validated: z.boolean(),
      symptom: z.string().max(2000).nullable(),
      failure_code: z.string().max(60).nullable(),
      production_impact: z.string().max(2000).nullable(),
    })
    .partial()
    .strict()
    .refine((c) => Object.keys(c).length > 0, { message: 'No changes supplied' }),
});

export const exposureRequest = z
  .object({
    asset_id: z.uuid(),
    period_start: isoTimestamp,
    period_end: isoTimestamp,
    hours: z.number().min(0).max(100000),
    basis: z.enum(['verified', 'estimated']),
    source: z.string().min(1).max(200),
  })
  .refine((e) => e.period_end > e.period_start, { message: 'period_end must follow period_start', path: ['period_end'] })
  .refine((e) => e.hours <= (Date.parse(e.period_end) - Date.parse(e.period_start)) / 3_600_000, { message: 'Hours exceed the period length', path: ['hours'] });

export const externalCostRequest = z.object({
  amount: z.number().nonnegative().max(1e9),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  description: z.string().min(1).max(500),
});

// ---------- Inspections ----------

export const createInspectionTemplateRequest = z.object({
  site_id: z.uuid().nullable().default(null),
  title: z.string().min(1).max(200),
  asset_type: z.string().max(100).nullable().default(null),
});

export const inspectionRevisionRequest = z.object({
  instructions: z.string().max(10000).default(''),
  checks: checkListSchema,
  signature_required: z.boolean().default(false),
});

export const startInspectionRequest = z.object({
  template_revision_id: z.uuid(),
  asset_id: z.uuid(),
  work_order_id: z.uuid().nullable().default(null),
  client_submission_id: z.string().min(1).max(100),
});

export const submitInspectionRequest = z.object({
  observed_at: isoTimestamp,
  values: z.array(checkValue).max(200),
  signature: z.object({ snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().default(null),
});

export interface TransitionResult {
  id: string;
  state: WorkOrderState;
  version: number;
  transition: { action: WorkOrderAction; from: WorkOrderState; to: WorkOrderState; at: string; reason: string | null };
  correlation_id: string;
}
