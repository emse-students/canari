/**
 * A SPACE'S WALL CLOCK AS THE DATE FIELD HOLDS IT (D25): every date of a space is read and written
 * in the SPACE's zone, never the device's. `DateTimeField`'s value is `YYYY-MM-DDTHH:mm`; these two
 * functions put it on `zonedTime.ts`, the server's own clock copied byte for byte - so what the
 * organiser types is the instant the server would compute, both DST holes included (a time in a
 * spring-forward gap moves forward, a doubled hour is its earlier instant).
 */
import { isCalendarDate, localDate, localTime, zonedToUtcMs } from './zonedTime';

/** `instantMs` as `zone`'s wall clock, `YYYY-MM-DDTHH:mm`. */
export function wallTimeIn(instantMs: number, zone: string): string {
  return `${localDate(instantMs, zone)}T${localTime(instantMs, zone)}`;
}

/** The instant of the wall time `value` (`YYYY-MM-DDTHH:mm`) in `zone`, or null when it is not one. */
export function instantOfWallTime(value: string, zone: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!m || !isCalendarDate(m[1])) return null;
  return zonedToUtcMs(m[1], m[2], zone);
}
