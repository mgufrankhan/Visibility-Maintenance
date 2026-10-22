import { z } from 'zod';
import { NEO_TOOLS, type NeoToolName } from '@vm/contracts';

export const TOOL_SCHEMAS: Record<NeoToolName, z.ZodType> = {
  search_asset_knowledge: z.object({ asset_id: z.uuid(), query: z.string().min(1).max(500) }),
  get_maintenance_history: z.object({ asset_id: z.uuid(), days: z.number().int().min(1).max(3650).default(90) }),
  get_signal_summary: z.object({ asset_id: z.uuid(), signal_key: z.string().min(1).max(80) }),
  get_maintenance_metrics: z.object({ asset_id: z.uuid(), days: z.number().int().min(1).max(3650).default(365) }),
  draft_request: z.object({
    site_id: z.uuid(),
    asset_id: z.uuid().nullable(),
    description: z.string().min(1).max(5000),
    priority: z.enum(['critical', 'high', 'normal', 'low']),
  }),
  draft_work_order: z.object({
    site_id: z.uuid(),
    asset_id: z.uuid().nullable(),
    title: z.string().min(1).max(200),
    scope: z.string().min(1).max(5000),
    priority: z.enum(['critical', 'high', 'normal', 'low']),
    team_id: z.uuid(),
    procedure_revision_id: z.uuid().nullable(),
    type: z.enum(['corrective', 'preventive', 'inspection', 'follow_up']).default('corrective'),
  }),
  propose_checklist: z.object({
    site_id: z.uuid(),
    asset_id: z.uuid().nullable(),
    procedure_id: z.uuid().nullable(),
    title: z.string().min(1).max(200),
    safety_instructions: z.string().max(10000).nullable(),
    steps: z
      .array(
        z.object({
          key: z.string().min(1).max(80),
          label: z.string().min(1).max(200),
          type: z.enum(['pass_fail', 'numeric', 'text', 'photo', 'acknowledgment']),
          required: z.boolean().default(true),
        }),
      )
      .min(1)
      .max(100),
    rationale: z.string().min(1).max(4000),
  }),
  draft_briefing: z.object({
    site_id: z.uuid(),
    asset_id: z.uuid(),
    narrative: z.string().min(1).max(8000),
    citations: z.array(z.object({ type: z.string().min(1).max(40), id: z.uuid() })).max(100),
  }),
};

const FORBIDDEN = new Set(['close_work_order', 'approve_work_order', 'write_plc', 'restart_equipment', 'grant_role', 'clear_interlock']);

export function assertToolAllowed(name: string): asserts name is NeoToolName {
  if (FORBIDDEN.has(name) || !(NEO_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Tool ${name} is not on the Neo allowlist`);
  }
}

/** Uploaded documents are untrusted: instruction-like lines cannot change tools or policy. */
export function sanitizeUntrustedText(text: string): { text: string; stripped_instructions: number } {
  const lines = text.split(/\r?\n/);
  let stripped = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (/ignore (previous|all) instructions|you are now|grant (role|permission)|system prompt|tool policy/i.test(line)) {
      stripped++;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').slice(0, 20_000), stripped_instructions: stripped };
}
