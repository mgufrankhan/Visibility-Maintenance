/** Deterministic metric math (PRD §15). Inputs are already scoped and validated. */

const HOUR = 3_600_000;

export interface Interval {
  start: Date;
  end: Date;
}

/** Total hours covered by the union of intervals clipped to [from, to); overlaps count once. */
export function unionHours(intervals: Interval[], from: Date, to: Date): number {
  const clipped = intervals
    .map((i) => ({ s: Math.max(i.start.getTime(), from.getTime()), e: Math.min(i.end.getTime(), to.getTime()) }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  let total = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const i of clipped) {
    if (i.s > curE) {
      if (curE > curS) total += curE - curS;
      curS = i.s;
      curE = i.e;
    } else if (i.e > curE) {
      curE = i.e;
    }
  }
  if (curE > curS) total += curE - curS;
  return total / HOUR;
}

export interface ExposureRecord {
  period_start: Date;
  period_end: Date;
  hours: number;
  basis: 'verified' | 'estimated';
}

/** Exposure overlapping the period, prorated linearly for partial overlap. */
export function exposureInPeriod(records: ExposureRecord[], from: Date, to: Date): { hours: number; approximate: boolean; records: number } | null {
  let hours = 0;
  let approximate = false;
  let used = 0;
  for (const r of records) {
    const span = r.period_end.getTime() - r.period_start.getTime();
    const overlap = Math.min(r.period_end.getTime(), to.getTime()) - Math.max(r.period_start.getTime(), from.getTime());
    if (overlap <= 0 || span <= 0) continue;
    hours += (r.hours * overlap) / span;
    // Prorating assumes uniform running time, so partial records are approximate too.
    if (r.basis === 'estimated' || overlap < span) approximate = true;
    used++;
  }
  return used === 0 ? null : { hours: Math.round(hours * 100) / 100, approximate, records: used };
}

export type MtbfResult =
  | { status: 'ok'; mtbf_hours: number; exposure_hours: number; failures: number; approximate: boolean }
  | { status: 'no_observed_failure'; mtbf_hours: null; exposure_hours: number; failures: 0; approximate: boolean }
  | { status: 'unavailable_no_exposure'; mtbf_hours: null; exposure_hours: null; failures: number; approximate: false };

/** MTBF = operating hours / qualifying failures; never an invented infinity for zero failures. */
export function mtbf(exposure: { hours: number; approximate: boolean } | null, failures: number): MtbfResult {
  if (!exposure) return { status: 'unavailable_no_exposure', mtbf_hours: null, exposure_hours: null, failures, approximate: false };
  if (failures === 0) return { status: 'no_observed_failure', mtbf_hours: null, exposure_hours: exposure.hours, failures: 0, approximate: exposure.approximate };
  return { status: 'ok', mtbf_hours: Math.round((exposure.hours / failures) * 100) / 100, exposure_hours: exposure.hours, failures, approximate: exposure.approximate };
}

/** MTTR over the restored cohort: elapsed failure-to-restoration hours including waiting. */
export function mttr(restored: Interval[]): { mttr_hours: number | null; restored: number } {
  if (restored.length === 0) return { mttr_hours: null, restored: 0 };
  const total = restored.reduce((acc, i) => acc + (i.end.getTime() - i.start.getTime()), 0) / HOUR;
  return { mttr_hours: Math.round((total / restored.length) * 100) / 100, restored: restored.length };
}

/** Validated failures sharing asset and failure code within the window of the previous one. */
export function repeatFaults(
  failures: Array<{ id: string; asset_id: string; failure_code: string | null; started_at: Date }>,
  windowDays: number,
): { groups: Array<{ asset_id: string; failure_code: string; failure_ids: string[] }>; unknown_code: number } {
  const unknown = failures.filter((f) => !f.failure_code).length;
  const byKey = new Map<string, typeof failures>();
  for (const f of failures) {
    if (!f.failure_code) continue;
    const k = `${f.asset_id}|${f.failure_code}`;
    byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const groups: Array<{ asset_id: string; failure_code: string; failure_ids: string[] }> = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => a.started_at.getTime() - b.started_at.getTime());
    const ids = new Set<string>();
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.started_at.getTime() - sorted[i - 1]!.started_at.getTime() <= windowDays * 24 * HOUR) {
        ids.add(sorted[i - 1]!.id);
        ids.add(sorted[i]!.id);
      }
    }
    if (ids.size) groups.push({ asset_id: sorted[0]!.asset_id, failure_code: sorted[0]!.failure_code!, failure_ids: sorted.filter((f) => ids.has(f.id)).map((f) => f.id) });
  }
  return { groups, unknown_code: unknown };
}
