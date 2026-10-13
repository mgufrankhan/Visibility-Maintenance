export interface EvidenceItem {
  kind: 'procedure' | 'work_order' | 'failure' | 'incident' | 'document' | 'signal' | 'metric';
  id: string;
  title: string;
  freshness: string | null;
  excerpt: string;
  untrusted: boolean;
}

export interface Synthesis {
  observations: string;
  possible_causes: string[];
  recommended_checks: string[];
  missing_evidence: string[];
  abstain: boolean;
}

const PROMPT_VERSION = 'deterministic-retrieval-v1';

export function promptVersion(): string {
  return PROMPT_VERSION;
}

/**
 * Deterministic, citation-bound answer. No model is invoked: this runtime is
 * the only production path until a qualified local or cloud model exists.
 */
export function synthesize(query: string, evidence: EvidenceItem[]): Synthesis {
  const missing: string[] = [];
  if (!evidence.some((e) => e.kind === 'procedure')) missing.push('No approved procedure revision is on file for this asset.');
  if (!evidence.some((e) => e.kind === 'work_order' || e.kind === 'failure')) missing.push('No prior repair or failure record was in scope.');
  const stale = evidence.filter((e) => e.kind === 'signal' && /stale|unavailable/i.test(e.excerpt));
  if (stale.length) missing.push('Selected telemetry is stale or unavailable; do not treat it as a current condition.');
  const procedures = evidence.filter((e) => e.kind === 'procedure');
  if (procedures.length > 1) {
    return {
      observations: 'More than one approved procedure revision is in scope and their instructions may conflict. Neo will not invent a combined procedure.',
      possible_causes: [],
      recommended_checks: ['Have a maintenance engineer review the cited procedure revisions and issue one approved revision.'],
      missing_evidence: missing,
      abstain: true,
    };
  }
  const facts = evidence.filter((e) => !e.untrusted).map((e) => `${e.kind} ${e.id}: ${e.excerpt}`).join(' ');
  const observations = facts
    ? `Observed records in scope for ${query.slice(0, 120)}: ${facts.slice(0, 1500)}`
    : `No authorized structured records matched ${query.slice(0, 120)}.`;
  const causes = evidence.some((e) => e.kind === 'failure' || e.kind === 'incident')
    ? ['A prior validated failure or open incident exists; treat it as a hypothesis until inspection confirms the current condition.']
    : [];
  const checks = procedures.length
    ? [`Follow issued procedure ${procedures[0]!.title} (revision ${procedures[0]!.id}).`]
    : ['Inspect the asset and record evidence; Neo will not invent a procedure.'];
  return {
    observations,
    possible_causes: causes,
    recommended_checks: checks,
    missing_evidence: missing,
    abstain: evidence.length === 0,
  };
}
