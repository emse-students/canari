/**
 * The arithmetic behind `DateTimeField` - pure, so the calendar it draws can be tested without one.
 *
 * VALUES ARE `datetime-local` STRINGS (`YYYY-MM-DDTHH:mm`, wall time in the viewer's zone), exactly
 * what the native inputs it replaces produced, so every caller keeps its parsing and its payloads.
 * `''` means "no date".
 */

/** A wall-clock date and time, months 0-based as `Date` has them. */
export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Reads a `datetime-local` value, or `null` for `''` or anything malformed. */
export function parseLocalDateTime(value: string): LocalDateTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return { year: y, month: mo - 1, day: d, hour: h, minute: mi };
}

/** Writes a `datetime-local` value. */
export function formatLocalDateTime(dt: LocalDateTime): string {
  return `${dt.year}-${pad2(dt.month + 1)}-${pad2(dt.day)}T${pad2(dt.hour)}:${pad2(dt.minute)}`;
}

/** The same wall time as a `Date`, for comparisons and `Intl` formatting. */
export function toDate(dt: LocalDateTime): Date {
  return new Date(dt.year, dt.month, dt.day, dt.hour, dt.minute);
}

/** A `LocalDateTime` from a `Date` - the starting point when a field is empty. */
export function fromDate(d: Date): LocalDateTime {
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
  };
}

/**
 * Whether a whole DAY lies before `min` - its last minute is earlier - so it cannot be picked at
 * all. A day that CONTAINS `min` stays pickable; its early times are what `clampToMin` corrects.
 */
export function dayBeforeMin(year: number, month: number, day: number, min: string): boolean {
  const floor = parseLocalDateTime(min);
  if (!floor) return false;
  return new Date(year, month, day, 23, 59) < toDate(floor);
}

/** `dt`, or `min` when `dt` is earlier - what a native input with `min` also refuses to keep. */
export function clampToMin(dt: LocalDateTime, min: string): LocalDateTime {
  const floor = parseLocalDateTime(min);
  if (!floor || toDate(dt) >= toDate(floor)) return dt;
  return floor;
}

/**
 * The minutes a person chooses from: every `step`, plus `current` if it is off the step.
 *
 * A value typed elsewhere - or seeded from a stored instant - is often 17 past; it is kept in the
 * list rather than silently rounded, so opening and validating the field never changes a date.
 */
export function minuteChoices(step: number, current: number): number[] {
  const choices = Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step);
  if (!choices.includes(current)) choices.push(current);
  return choices.sort((a, b) => a - b);
}

/** The month shown one step away, wrapping the year. */
export function shiftMonth(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}
