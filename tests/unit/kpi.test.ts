import { describe, expect, it } from 'vitest';
import { exposureInPeriod, mtbf, mttr, repeatFaults, unionHours } from '../../packages/core/src/kpi.ts';

const t = (hhmm: string, day = '2026-10-10') => new Date(`${day}T${hhmm}:00Z`);

describe('KPI fixture (PRD §15, test plan KPI fixture)', () => {
  it('overlapping downtime 10:00–12:00 and 11:00–13:00 totals 3 hours, not 4', () => {
    expect(unionHours([{ start: t('10:00'), end: t('12:00') }, { start: t('11:00'), end: t('13:00') }], t('00:00'), t('23:59'))).toBe(3);
  });

  it('clips downtime at the period boundary', () => {
    expect(unionHours([{ start: t('10:00'), end: t('14:00') }], t('12:00'), t('23:00'))).toBe(2);
    expect(unionHours([{ start: t('10:00'), end: t('11:00') }, { start: t('12:00'), end: t('13:00') }], t('00:00'), t('23:00'))).toBe(2);
  });

  it('100 verified hours and two failures give MTBF 50', () => {
    const exp = exposureInPeriod([{ period_start: t('00:00', '2026-10-01'), period_end: t('00:00', '2026-11-01'), hours: 100, basis: 'verified' }], t('00:00', '2026-10-01'), t('00:00', '2026-11-01'));
    expect(mtbf(exp, 2)).toEqual({ status: 'ok', mtbf_hours: 50, exposure_hours: 100, failures: 2, approximate: false });
  });

  it('restoration durations of 2 and 4 hours give MTTR 3', () => {
    expect(mttr([{ start: t('10:00'), end: t('12:00') }, { start: t('14:00'), end: t('18:00') }])).toEqual({ mttr_hours: 3, restored: 2 });
    expect(mttr([])).toEqual({ mttr_hours: null, restored: 0 });
  });

  it('shows no observed failure for zero failures and unavailable MTBF without exposure', () => {
    expect(mtbf({ hours: 100, approximate: false }, 0)).toMatchObject({ status: 'no_observed_failure', mtbf_hours: null, exposure_hours: 100 });
    expect(mtbf(null, 2)).toMatchObject({ status: 'unavailable_no_exposure', mtbf_hours: null });
  });

  it('marks MTBF approximate when exposure is estimated and prorates partial overlap', () => {
    const exp = exposureInPeriod([{ period_start: t('00:00', '2026-10-01'), period_end: t('00:00', '2026-10-03'), hours: 40, basis: 'estimated' }], t('00:00', '2026-10-02'), t('00:00', '2026-10-10'));
    expect(exp).toEqual({ hours: 20, approximate: true, records: 1 });
  });

  it('groups repeat faults within the window and reports unknown codes', () => {
    const r = repeatFaults(
      [
        { id: 'a', asset_id: 'p1', failure_code: 'SEAL', started_at: t('00:00', '2026-10-01') },
        { id: 'b', asset_id: 'p1', failure_code: 'SEAL', started_at: t('00:00', '2026-10-20') },
        { id: 'c', asset_id: 'p1', failure_code: 'SEAL', started_at: t('00:00', '2026-12-30') },
        { id: 'd', asset_id: 'p1', failure_code: null, started_at: t('00:00', '2026-10-02') },
        { id: 'e', asset_id: 'p2', failure_code: 'SEAL', started_at: t('00:00', '2026-10-03') },
      ],
      30,
    );
    expect(r).toEqual({ groups: [{ asset_id: 'p1', failure_code: 'SEAL', failure_ids: ['a', 'b'] }], unknown_code: 1 });
  });
});
