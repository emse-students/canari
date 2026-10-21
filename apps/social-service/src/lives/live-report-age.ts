import { datesBetween, isoWeekday, localDate, zonedToUtcMs } from '../bookings/zoned-time';

/**
 * How much WORKING time lies between two instants: the parts of `[fromMs, toMs)` that fall on a
 * Monday to Friday in `zone`, in milliseconds.
 *
 * The commitment it measures is "24 hours on working days" (owner, 2026-10-20), so a report filed
 * on a Friday evening is not late on Sunday. Each local day is cut at the zone's own midnights
 * (`zonedToUtcMs`), so a daylight-saving day counts its 23 or 25 hours, never a fixed 24. Public
 * holidays count as working days: nothing here knows them, and that errs early, never late.
 *
 * Zero when `toMs` is not after `fromMs`.
 */
export function workingMsBetween(fromMs: number, toMs: number, zone: string): number {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  for (const date of datesBetween(localDate(fromMs, zone), localDate(toMs, zone))) {
    if (isoWeekday(date) >= 6) continue;
    const start = zonedToUtcMs(date, '00:00', zone);
    const end = zonedToUtcMs(date, '24:00', zone);
    total += Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs));
  }
  return total;
}

/** What one hourly reading of the live report queue found. No id, no account: counts and ages. */
export interface LiveReportAgeReading {
  /** Pending `live` and `live_chat` reports. */
  pending: number;
  /** Of those, how many are past the working-time commitment. */
  overdue: number;
  /** The oldest pending report's age on the wall clock, ms; `null` when nothing is pending. */
  oldestWallMs: number | null;
  /** The oldest pending report's WORKING age, ms; `null` when nothing is pending. */
  oldestWorkingMs: number | null;
}

/**
 * Reads the queue from the creation instants of the pending reports and the database's `now`.
 *
 * Pure, so the arithmetic is tested without a database; the scheduler hands it what PostgreSQL
 * answered, on PostgreSQL's clock.
 */
export function readLiveReportAge(
  createdAt: readonly Date[],
  nowMs: number,
  limitWorkingMs: number,
  zone: string
): LiveReportAgeReading {
  if (createdAt.length === 0) {
    return { pending: 0, overdue: 0, oldestWallMs: null, oldestWorkingMs: null };
  }
  const oldest = Math.min(...createdAt.map((d) => d.getTime()));
  const overdue = createdAt.filter(
    (d) => workingMsBetween(d.getTime(), nowMs, zone) > limitWorkingMs
  ).length;
  return {
    pending: createdAt.length,
    overdue,
    oldestWallMs: Math.max(0, nowMs - oldest),
    oldestWorkingMs: workingMsBetween(oldest, nowMs, zone),
  };
}
