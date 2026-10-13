import type { Capability, EntitlementStatus, EntitlementView, LicenseDocument } from '@vm/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock moving backwards by more than this is flagged for administrator review. */
const CLOCK_TOLERANCE_MS = 60 * 60 * 1000;

export interface EvaluateInput {
  /** Verified license, or null when none is installed. */
  license: LicenseDocument | null;
  /** Set when a license is installed but failed verification. */
  verificationError: string | null;
  now: Date;
  /** Highest trusted time previously observed by this installation. */
  lastSeenAt: Date | null;
  usage: EntitlementView['usage'];
}

/** Always available regardless of license state: data is never locked away (ML-03, ML-06). */
const CONTINUITY: Capability[] = ['core.read', 'core.export', 'core.admin', 'core.report_fault', 'core.complete_active_work', 'core.inspect'];

export function evaluateEntitlement(input: EvaluateInput): EntitlementView {
  const { license, verificationError, usage } = input;
  const clockAnomaly = input.lastSeenAt !== null && input.now.getTime() < input.lastSeenAt.getTime() - CLOCK_TOLERANCE_MS;
  // A rolled-back clock cannot extend a term: evaluate against the trusted high-water mark.
  const effectiveNow = clockAnomaly && input.lastSeenAt ? input.lastSeenAt : input.now;
  const warnings: string[] = [];
  if (clockAnomaly) warnings.push('System clock moved backwards; administrator review required.');

  if (!license) {
    const status: EntitlementStatus = verificationError ? 'invalid' : 'missing';
    warnings.push(verificationError ? `Installed license rejected: ${verificationError}` : 'No license installed.');
    return base(status, null, CONTINUITY, warnings, clockAnomaly, usage, null);
  }

  const starts = Date.parse(license.term.starts_at);
  const ends = Date.parse(license.term.ends_at);
  const graceEnds = ends + license.grace_days * DAY_MS;
  const t = effectiveNow.getTime();

  let status: EntitlementStatus;
  if (t < starts) status = 'not_yet_valid';
  else if (t <= ends) status = 'valid';
  else if (t <= graceEnds) status = 'grace';
  else status = 'expired';

  const caps = new Set<Capability>(CONTINUITY);
  const active = status === 'valid' || status === 'grace';
  const has = (f: LicenseDocument['features'][number]) => license.features.includes(f);
  if (active && has('core')) {
    caps.add('core.create_work');
    caps.add('core.generate_pm');
  }
  if (has('connected_operations')) {
    // Evidence keeps flowing after expiry so nothing is discarded (ML-05); new requests stop.
    if (status !== 'not_yet_valid') caps.add('connected.ingest');
    if (active) {
      caps.add('connected.create_requests');
      caps.add('connected.configure');
    }
  }
  if (active && has('neo_assistance')) caps.add('neo.assist');

  if (status === 'valid' && ends - t < 30 * DAY_MS) {
    warnings.push(`License term ends ${new Date(ends).toISOString()}.`);
  }
  if (status === 'grace') {
    warnings.push(`License term ended; continuity grace ends ${new Date(graceEnds).toISOString()}.`);
  }
  if (status === 'expired') {
    warnings.push('License grace period ended. Records remain readable and exportable; new work and PM generation are blocked.');
  }
  if (status === 'not_yet_valid') warnings.push(`License term starts ${license.term.starts_at}.`);
  for (const key of ['sites', 'operational_users', 'maintainable_assets'] as const) {
    const limit = license.limits[key];
    if (limit === null) continue;
    if (usage[key] > limit) warnings.push(`Usage for ${key} (${usage[key]}) exceeds the licensed limit (${limit}).`);
    else if (usage[key] >= Math.ceil(limit * 0.9)) warnings.push(`Usage for ${key} is ${usage[key]} of ${limit}.`);
  }

  return base(status, license, [...caps], warnings, clockAnomaly, usage, new Date(graceEnds).toISOString());
}

function base(
  status: EntitlementStatus,
  license: LicenseDocument | null,
  capabilities: Capability[],
  warnings: string[],
  clockAnomaly: boolean,
  usage: EntitlementView['usage'],
  graceEndsAt: string | null,
): EntitlementView {
  return {
    status,
    license_id: license?.license_id ?? null,
    features: license?.features ?? [],
    limits: license?.limits ?? null,
    term: license?.term ?? null,
    grace_ends_at: graceEndsAt,
    policy_tag: license?.policy_tag ?? null,
    capabilities: capabilities.sort(),
    warnings,
    clock_anomaly: clockAnomaly,
    usage,
  };
}

export function hasCapability(view: EntitlementView, capability: Capability): boolean {
  return view.capabilities.includes(capability);
}

/** Whether one more allocation of `key` fits within the licensed limit (ML-05). */
export function limitAllows(view: EntitlementView, key: keyof EntitlementView['usage']): boolean {
  const limit = view.limits?.[key] ?? null;
  return limit === null || view.usage[key] + 1 <= limit;
}
