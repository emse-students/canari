/**
 * LOCAL WALL TIME IN A ZONE <-> UTC INSTANT, with the platform's own time-zone database (`Intl`),
 * no library. A space has ONE zone (D25): its rules are local wall times, its bookings UTC instants,
 * so a recurrent 18:00 stays 18:00 across a daylight-saving change.
 *
 * The two holes a wall clock has are resolved as `Temporal`'s `disambiguation: 'compatible'` does,
 * so the answer is the one a later move to `Temporal` would keep:
 * - a wall time that does NOT exist (02:30 on a spring-forward night in Paris) is moved FORWARD by
 *   the gap (03:30 local);
 * - a wall time that exists TWICE (02:30 on a fall-back night) is the EARLIER instant.
 *
 * Dates are `YYYY-MM-DD` strings and times `HH:MM` or `HH:MM:SS` (PostgreSQL `date` and `time` as
 * TypeORM returns them). `24:00` is accepted as the end of a day: it is the next day's 00:00.
 */

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone, built once: constructing an `Intl.DateTimeFormat` is the costly part. */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** Whether `zone` is an IANA zone this runtime knows. A space's zone is checked with it on write. */
export function isValidTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `instantMs` in `zone`, read back as if it were UTC (milliseconds). */
function wallClockMs(instantMs: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The zone's offset from UTC at `instantMs`, in milliseconds (Paris in winter: +3_600_000). */
export function offsetMs(instantMs: number, zone: string): number {
  // The formatter has a one-second resolution: drop the milliseconds so they do not count as offset.
  const whole = instantMs - (((instantMs % 1000) + 1000) % 1000);
  return wallClockMs(whole, zone) - whole;
}

/** `YYYY-MM-DD` -> [year, month, day]. Throws on anything else: a malformed date is a bug upstream. */
function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `HH:MM[:SS]` -> seconds since midnight, `24:00` included. */
export function timeToSeconds(time: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) throw new RangeError(`not a HH:MM[:SS] time: ${time}`);
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (seconds > 86_400 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) {
    throw new RangeError(`out-of-range time: ${time}`);
  }
  return seconds;
}

/**
 * The UTC instant of the local wall time `date` `time` in `zone` (milliseconds), resolved as
 * `Temporal`'s 'compatible' disambiguation (see the file header).
 *
 * The offsets one day before and one day after bound every offset the wall time can have, since no
 * zone changes its offset twice within two days.
 */
export function zonedToUtcMs(date: string, time: string, zone: string): number {
  const [y, mo, d] = parseDate(date);
  const wall = Date.UTC(y, mo - 1, d) + timeToSeconds(time) * 1000;
  const before = offsetMs(wall - DAY_MS, zone);
  const after = offsetMs(wall + DAY_MS, zone);
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((c) => c + offsetMs(c, zone) === wall)
    .sort((a, b) => a - b);
  // Exists once, or twice (fall-back night): the earlier one.
  if (candidates.length > 0) return candidates[0];
  // Does not exist (spring-forward gap): read with the offset in force BEFORE the change, which
  // lands the same distance past the gap's end.
  return wall - before;
}

/** The local calendar date (`YYYY-MM-DD`) of `instantMs` in `zone`. */
export function localDate(instantMs: number, zone: string): string {
  return new Date(wallClockMs(instantMs, zone)).toISOString().slice(0, 10);
}

/** `date` plus `days` calendar days (negative allowed). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The ISO weekday of a calendar date: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parseDate(date);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** The Monday of the ISO week holding `date`: the key of a weekly quota period (D17). */
export function isoWeekMonday(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Every calendar date from `from` to `to`, both INCLUDED. Empty when `to` is before `from`. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
