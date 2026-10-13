import { z } from 'zod';
import { uuid } from './common.ts';
import { priority } from './common.ts';
import { checkDefinition } from './maintenance.ts';

export const NEO_TOOLS = [
  'search_asset_knowledge',
  'get_maintenance_history',
  'get_signal_summary',
  'get_maintenance_metrics',
  'draft_request',
  'draft_work_order',
  'propose_checklist',
] as const;
export type NeoToolName = (typeof NEO_TOOLS)[number];

export const neoAskRequest = z.object({
  site_id: uuid,
  asset_id: uuid.nullable().default(null),
  query: z.string().min(1).max(4000),
  /** When true, persist a reviewable draft request if evidence supports one. */
  draft_request: z.boolean().default(false),
  /** When true, persist a reviewable draft work order (does not auto-create). */
  draft_work_order: z.boolean().default(false),
  /** When true, persist a checklist proposal for human review (never publishes). */
  propose_checklist: z.boolean().default(false),
});

export const recommendationDecisionRequest = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(3).max(2000),
  action_version: z.number().int().positive(),
});

export const draftRequestPayload = z.object({
  site_id: uuid,
  asset_id: uuid.nullable(),
  description: z.string().min(1).max(5000),
  priority: priority,
  observed_at: z.iso.datetime({ offset: true }),
});

export const draftWorkOrderPayload = z.object({
  site_id: uuid,
  asset_id: uuid.nullable(),
  title: z.string().min(1).max(200),
  scope: z.string().min(1).max(5000),
  priority: priority,
  team_id: uuid,
  procedure_revision_id: uuid.nullable().default(null),
  type: z.enum(['corrective', 'preventive', 'inspection', 'follow_up']).default('corrective'),
});

export const proposeChecklistPayload = z.object({
  site_id: uuid,
  asset_id: uuid.nullable(),
  procedure_id: uuid.nullable().default(null),
  title: z.string().min(1).max(200),
  safety_instructions: z.string().max(10000).nullable().default(null),
  steps: z.array(checkDefinition).min(1).max(100),
  rationale: z.string().min(1).max(4000),
});
