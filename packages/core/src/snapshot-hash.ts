import { createHash } from 'node:crypto';

/** Stable JSON so a snapshot hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function procedureSnapshotHash(snapshot: {
  procedure_revision_id: string;
  revision_no: number;
  signature_required?: boolean;
  safety_instructions: string;
  steps: unknown;
}): string {
  return sha256Canonical({
    procedure_revision_id: snapshot.procedure_revision_id,
    revision_no: snapshot.revision_no,
    signature_required: snapshot.signature_required === true,
    safety_instructions: snapshot.safety_instructions,
    steps: snapshot.steps,
  });
}

export function inspectionSnapshotHash(snapshot: { template_revision_id: string; signature_required?: boolean; checks: unknown }): string {
  return sha256Canonical({
    template_revision_id: snapshot.template_revision_id,
    signature_required: snapshot.signature_required === true,
    checks: snapshot.checks,
  });
}
