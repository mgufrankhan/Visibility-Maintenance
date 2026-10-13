import { describe, expect, it } from 'vitest';
import { NO_HOLIDAYS, nextOccurrences, occurrenceAt, occurrencesBetween, type CalendarTrigger } from '../../packages/core/src/recurrence.ts';

const monthly31: CalendarTrigger = { type: 'calendar', unit: 'month', interval: 1, anchor_date: '2026-01-31', time_of_day: '08:00' };

describe('calendar recurrence (MP-02)', () => {
  it('clamps month end without drifting the schedule', () => {
    const dates = [0, 1, 2, 3, 12, 13].map((n) => occurrenceAt(monthly31, 'UTC', NO_HOLIDAYS, n).dueDate);
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2027-01-31', '2027-02-28']);
    expect(occurrenceAt({ ...monthly31, anchor_date: '2027-01-31' }, 'UTC', NO_HOLIDAYS, 1).dueDate).toBe('2027-02-28');
    expect(occurrenceAt({ ...monthly31, anchor_date: '2028-01-31' }, 'UTC', NO_HOLIDAYS, 1).dueDate).toBe('2028-02-29');
  });

  it('keeps the local wall-clock time across DST changes', () => {
    const weekly: CalendarTrigger = { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2026-03-22', time_of_day: '09:00' };
    const [before, after] = [0, 1].map((n) => occurrenceAt(weekly, 'Europe/London', NO_HOLIDAYS, n).dueAt.toISOString());
    expect(before).toBe('2026-03-22T09:00:00.000Z');
    expect(after).toBe('2026-03-29T08:00:00.000Z');
  });

  it('moves a nonexistent spring-forward time later and resolves the repeated hour once', () => {
    const gap: CalendarTrigger = { type: 'calendar', unit: 'day', interval: 1, anchor_date: '2026-03-29', time_of_day: '01:30' };
    expect(occurrenceAt(gap, 'Europe/London', NO_HOLIDAYS, 0).dueAt.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    const overlap: CalendarTrigger = { ...gap, anchor_date: '2026-10-25' };
    const o = occurrencesBetween(overlap, 'Europe/London', NO_HOLIDAYS, new Date('2026-10-24T00:00:00Z'), new Date('2026-10-26T00:00:00Z'));
    expect(o.map((x) => x.key)).toEqual(['2026-10-25']);
  });

  it('uses the site timezone for the due instant', () => {
    const daily: CalendarTrigger = { type: 'calendar', unit: 'day', interval: 1, anchor_date: '2026-10-12', time_of_day: '06:00' };
    expect(occurrenceAt(daily, 'Asia/Karachi', NO_HOLIDAYS, 0).dueAt.toISOString()).toBe('2026-10-12T01:00:00.000Z');
  });

  it('shifts holidays only when configured and keeps the nominal key', () => {
    const t: CalendarTrigger = { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2026-12-25', time_of_day: '07:00' };
    const rule = { policy: 'shift_to_next_working_day' as const, holidays: new Set(['2026-12-25', '2026-12-26']) };
    expect(occurrenceAt(t, 'UTC', { ...rule, policy: 'none' }, 0).dueDate).toBe('2026-12-25');
    const shifted = occurrenceAt(t, 'UTC', rule, 0);
    expect(shifted).toMatchObject({ key: '2026-12-25', dueDate: '2026-12-27' });
  });

  it('returns each occurrence in a window exactly once, in order', () => {
    const t: CalendarTrigger = { type: 'calendar', unit: 'day', interval: 3, anchor_date: '2026-01-01', time_of_day: '00:00' };
    const o = occurrencesBetween(t, 'UTC', NO_HOLIDAYS, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-31T00:00:00Z'));
    expect(o.map((x) => x.key)).toEqual(['2026-01-01', '2026-01-04', '2026-01-07', '2026-01-10', '2026-01-13', '2026-01-16', '2026-01-19', '2026-01-22', '2026-01-25', '2026-01-28']);
    expect(nextOccurrences(monthly31, 'UTC', NO_HOLIDAYS, new Date('2030-05-01T00:00:00Z'), 3).map((x) => x.key)).toEqual(['2030-05-31', '2030-06-30', '2030-07-31']);
  });

  it('rejects invalid triggers', () => {
    expect(() => occurrencesBetween({ ...monthly31, interval: 0 }, 'UTC', NO_HOLIDAYS, new Date(), new Date())).toThrow();
    expect(() => occurrencesBetween({ ...monthly31, time_of_day: '25:00' }, 'UTC', NO_HOLIDAYS, new Date(), new Date())).toThrow();
    expect(() => occurrencesBetween(monthly31, 'Mars/Olympus', NO_HOLIDAYS, new Date(), new Date())).toThrow();
  });
});
