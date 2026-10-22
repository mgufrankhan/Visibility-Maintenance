import type { CheckDefinition, CheckValue } from '@vm/contracts';

export interface EvaluatedCheck {
  passed: boolean | null;
  error: string | null;
}

/**
 * Validates one typed check result against its issued definition. Units must
 * match exactly: values are never silently converted.
 */
export function evaluateCheck(def: CheckDefinition, v: CheckValue, availableAttachmentIds: ReadonlySet<string>): EvaluatedCheck {
  const missingAttachments = v.attachment_ids.filter((id) => !availableAttachmentIds.has(id));
  if (missingAttachments.length) return { passed: null, error: 'Referenced evidence is not an available attachment of this record' };
  switch (def.type) {
    case 'pass_fail':
      if (typeof v.value !== 'boolean') return { passed: null, error: 'Expected true (pass) or false (fail)' };
      return { passed: v.value, error: null };
    case 'acknowledgment':
      if (v.value !== true) return { passed: null, error: 'Acknowledgment must be confirmed' };
      return { passed: true, error: null };
    case 'numeric': {
      if (typeof v.value !== 'number' || !Number.isFinite(v.value)) return { passed: null, error: 'Expected a number' };
      if (v.unit !== def.unit) return { passed: null, error: `Unit must be ${def.unit}` };
      const low = def.min === null || v.value >= def.min;
      const high = def.max === null || v.value <= def.max;
      return { passed: low && high, error: null };
    }
    case 'text':
      if (typeof v.value !== 'string' || v.value.trim().length === 0) return { passed: null, error: 'Expected text' };
      return { passed: true, error: null };
    case 'photo':
      if (v.attachment_ids.length === 0) return { passed: null, error: 'A photo attachment is required' };
      return { passed: true, error: null };
    default: {
      const never: never = def.type;
      throw new Error(`Unhandled check type ${String(never)}`);
    }
  }
}

export interface CurrentResult {
  step_key: string;
  passed: boolean | null;
  note?: string | null;
  attachment_ids: string[];
}

export interface CompletionGap {
  field: string;
  message: string;
}

/** A step with no rule is always shown. A missing or not-applicable prior result keeps the later step hidden. */
export function isStepVisible(
  step: { visible_when?: { key: string; when: 'failed' | 'passed' | 'outside_limits' } | null },
  results: ReadonlyMap<string, { passed: boolean | null; note?: string | null }>,
): boolean {
  const rule = step.visible_when;
  if (!rule) return true;
  const prior = results.get(rule.key);
  if (!prior || prior.note === 'not_applicable' || prior.passed === null || prior.passed === undefined) return false;
  if (rule.when === 'passed') return prior.passed === true;
  return prior.passed === false;
}

/** Explains every reason a completion submission is blocked (MW-05). */
export function completionGaps(input: {
  steps: CheckDefinition[];
  results: ReadonlyMap<string, CurrentResult>;
  exceptions: ReadonlySet<string>;
  requireCause: boolean;
  completion: {
    cause_code: string | null;
    cause_unknown_reason: string | null;
    corrective_action: string | null;
    failure_code: string | null;
  };
}): CompletionGap[] {
  const gaps: CompletionGap[] = [];
  for (const step of input.steps) {
    if (!isStepVisible(step, input.results)) continue;
    const r = input.results.get(step.key);
    const excepted = input.exceptions.has(step.key);
    const unanswered = !r || r.passed === null || r.note === 'not_applicable';
    if (unanswered) {
      if (step.required && !excepted) gaps.push({ field: `steps.${step.key}`, message: `Required check "${step.label}" has no result` });
      continue;
    }
    if (r.passed === false && step.required && !excepted) {
      gaps.push({ field: `steps.${step.key}`, message: `Required check "${step.label}" failed; resolve it or obtain an authorized exception` });
    }
    if (step.evidence_required && r.attachment_ids.length === 0 && !excepted) {
      gaps.push({ field: `steps.${step.key}`, message: `Check "${step.label}" requires evidence` });
    }
  }
  if (input.requireCause) {
    if (!input.completion.corrective_action?.trim()) gaps.push({ field: 'completion.corrective_action', message: 'Corrective action is required' });
    if (!input.completion.cause_code && !input.completion.cause_unknown_reason?.trim()) {
      gaps.push({ field: 'completion.cause_code', message: 'Provide a cause code or explain why the cause is unknown' });
    }
  }
  return gaps;
}
