/**
 * A SPACE'S WALL CLOCK <-> UTC INSTANTS, on the screen (D25: every date of a space is read and
 * written in the SPACE's zone, never the device's). The client twin of the server's
 * `apps/social-service/src/bookings/zoned-time.ts`, with the same two rules for the holes a wall
 * clock has (`Temporal`'s 'compatible' disambiguation): a wall time that does not exist (a
 * spring-forward gap) moves FORWARD by the gap, one that exists twice (a fall-back night) is the
 * EARLIER instant - so what the organiser types is the instant the server would compute.
 */

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

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

/** The wall clock of `instantMs` in `zone`, read back as if it were UTC (milliseconds). */
function wallClockMs(instantMs: number, zone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetMs(instantMs: number, zone: string): number {
  const whole = instantMs - (((instantMs % 1000) + 1000) % 1000);
  return wallClockMs(whole, zone) - whole;
}

/** `instantMs` as `zone`'s wall clock, `YYYY-MM-DDTHH:mm` - the DateTimeField's value. */
export function wallTimeIn(instantMs: number, zone: string): string {
  return new Date(wallClockMs(instantMs, zone)).toISOString().slice(0, 16);
}

/** The local calendar date (`YYYY-MM-DD`) of `instantMs` in `zone`. */
export function localDateIn(instantMs: number, zone: string): string {
  return wallTimeIn(instantMs, zone).slice(0, 10);
}

/**
 * The instant of the wall time `value` (`YYYY-MM-DDTHH:mm`) in `zone`, or null when `value` is
 * not one. The offsets a day either side bound every offset the wall time can have.
 */
export function instantOfWallTime(value: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(wall);
  if (back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) {
    return null;
  }
  const before = offsetMs(wall - DAY_MS, zone);
  const after = offsetMs(wall + DAY_MS, zone);
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((c) => c + offsetMs(c, zone) === wall)
    .sort((a, b) => a - b);
  return candidates[0] ?? wall - before;
}
