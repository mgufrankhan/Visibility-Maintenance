import { DateTime } from 'luxon';

export interface CalendarTrigger {
  type: 'calendar';
  unit: 'day' | 'week' | 'month';
  interval: number;
  /** Local date of the first occurrence (YYYY-MM-DD) in the site timezone. */
  anchor_date: string;
  /** Local wall-clock due time (HH:mm). */
  time_of_day: string;
}

export interface HolidayRule {
  policy: 'none' | 'shift_to_next_working_day';
  holidays: ReadonlySet<string>;
}

export interface Occurrence {
  index: number;
  /** Stable generation key: the nominal local date before any holiday shift. */
  key: string;
  nominalDate: string;
  /** Local date the work is due after holiday handling. */
  dueDate: string;
  dueAt: Date;
}

export const NO_HOLIDAYS: HolidayRule = { policy: 'none', holidays: new Set() };

function anchor(t: CalendarTrigger, zone: string): DateTime {
  const d = DateTime.fromISO(t.anchor_date, { zone });
  if (!d.isValid) throw new Error(`Invalid anchor date ${t.anchor_date}`);
  return d.startOf('day');
}

/**
 * Each occurrence is computed from the anchor rather than the previous
 * occurrence, so a clamped month end (Jan 31 → Feb 28) never drifts the
 * schedule: March is the 31st again.
 */
function nominal(t: CalendarTrigger, zone: string, n: number): DateTime {
  const a = anchor(t, zone);
  switch (t.unit) {
    case 'day':
      return a.plus({ days: n * t.interval });
    case 'week':
      return a.plus({ weeks: n * t.interval });
    case 'month':
      return a.plus({ months: n * t.interval });
    default: {
      const never: never = t.unit;
      throw new Error(`Unsupported unit ${String(never)}`);
    }
  }
}

function applyHolidays(d: DateTime, rule: HolidayRule): DateTime {
  if (rule.policy === 'none') return d;
  let out = d;
  for (let i = 0; i < 366 && rule.holidays.has(out.toISODate()!); i++) out = out.plus({ days: 1 });
  return out;
}

/** Wall-clock time in the site zone; nonexistent DST-gap times move forward, ambiguous ones use the first instant. */
function atLocalTime(date: DateTime, time: string, zone: string): Date {
  const [h, m] = time.split(':').map(Number);
  return DateTime.fromObject({ year: date.year, month: date.month, day: date.day, hour: h, minute: m }, { zone }).toJSDate();
}

export function occurrenceAt(t: CalendarTrigger, zone: string, rule: HolidayRule, n: number): Occurrence {
  const nom = nominal(t, zone, n);
  const due = applyHolidays(nom, rule);
  return { index: n, key: nom.toISODate()!, nominalDate: nom.toISODate()!, dueDate: due.toISODate()!, dueAt: atLocalTime(due, t.time_of_day, zone) };
}

function approxIndex(t: CalendarTrigger, zone: string, at: Date): number {
  const a = anchor(t, zone);
  const target = DateTime.fromJSDate(at, { zone });
  const span = t.unit === 'month' ? target.diff(a, 'months').months : target.diff(a, 'days').days / (t.unit === 'week' ? 7 : 1);
  return Math.max(0, Math.floor(span / t.interval) - 2);
}

/** Occurrences whose due instant lies in [from, to), in schedule order. */
export function occurrencesBetween(t: CalendarTrigger, zone: string, rule: HolidayRule, from: Date, to: Date, limit = 500): Occurrence[] {
  validateTrigger(t, zone);
  const out: Occurrence[] = [];
  // Holiday shifts can push an occurrence a few days later, so start a little early.
  let n = approxIndex(t, zone, new Date(from.getTime() - 400 * 86_400_000));
  for (let guard = 0; guard < 100_000 && out.length < limit; guard++, n++) {
    const o = occurrenceAt(t, zone, rule, n);
    const nominalAt = atLocalTime(DateTime.fromISO(o.nominalDate, { zone }), t.time_of_day, zone);
    if (nominalAt >= to && o.dueAt >= to) break;
    if (o.dueAt >= from && o.dueAt < to) out.push(o);
  }
  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.index - b.index);
}

export function nextOccurrences(t: CalendarTrigger, zone: string, rule: HolidayRule, from: Date, count: number): Occurrence[] {
  const horizon = { day: 1, week: 7, month: 31 }[t.unit] * t.interval * (count + 2) + 400;
  return occurrencesBetween(t, zone, rule, from, new Date(from.getTime() + horizon * 86_400_000), count);
}

export function validateTrigger(t: CalendarTrigger, zone: string): void {
  if (!DateTime.local().setZone(zone).isValid) throw new Error(`Unknown timezone ${zone}`);
  if (!Number.isInteger(t.interval) || t.interval < 1) throw new Error('interval must be a positive integer');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time_of_day)) throw new Error('time_of_day must be HH:mm');
  anchor(t, zone);
}

/** Local calendar date of an instant in the site zone. */
export function localDate(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toISODate()!;
}
