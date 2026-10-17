/**
 * SLOT GENERATION, ON DEMAND (D11): nothing but the rules and the bookings is stored; the slots of a
 * resource are computed from its availability lines for the dates asked. Pure functions - no
 * database, no clock - so every case is a table-driven test (`slots.spec.ts`), daylight-saving
 * changes included.
 *
 * The shape (docs/wiki/bookings-chantier.md, "WP-B2 as built"):
 *
 * 1. Each availability line gives, for every local date it applies to and no exception removes, a
 *    PIECE `[start, end)` in UTC, read in the space's zone (`zoned-time.ts`, D25).
 * 2. In a `step` space the pieces of a resource are UNITED into WINDOWS (overlapping or touching
 *    pieces become one), and a window is cut into steps of `stepMinutes` of ELAPSED time from its
 *    start; a booking is 1..`maxSteps` consecutive steps of ONE window (D3). Because touching pieces
 *    join, a window crossing midnight - written as two lines, 22:00-24:00 and 00:00-02:00 the next
 *    day, since `startTime < endTime` is a CHECK - is one window again.
 * 3. In a `slots` space each piece IS one slot (D3). Two pieces join only across MIDNIGHT (one ends
 *    at 24:00, the next day's starts at 00:00): joining every touching pair would merge two
 *    back-to-back interviews into one.
 *
 * A window belongs to the local date it STARTS on: asked for `[from, to]`, the generation reads
 * the days on either side, so a window starting on `to` and crossing midnight is whole, and the
 * after-midnight tail of a window starting the day before `from` is never shown as a window of its own.
 */
import type { BookingSlotMode } from './entities/booking-space.entity';
import { addDays, datesBetween, isoWeekday, localDate, zonedToUtcMs } from './zoned-time';

const MINUTE_MS = 60_000;

/** The space settings slot generation reads. */
export interface SlotConfig {
  timeZone: string;
  slotMode: BookingSlotMode;
  stepMinutes: number | null;
  maxSteps: number | null;
}

/** An availability line as stored (`booking_availability_rules`). */
export interface AvailabilityLine {
  weekday: number | null;
  onDate: string | null;
  startTime: string;
  endTime: string;
}

/** Whole local days removed, both ends included (`booking_availability_exceptions`). */
export interface AvailabilityException {
  fromDate: string;
  toDate: string;
}

/** A half-open UTC range `[startMs, endMs)`. */
export interface Range {
  startMs: number;
  endMs: number;
}

/** A window (step space) or a slot (slots space), with the local date it starts on. */
export interface Window extends Range {
  date: string;
}

/** One piece of availability: a line applied to one local date. */
interface Piece extends Window {
  startTime: string;
  endTime: string;
}

const isMidnightEnd = (time: string) => time.startsWith('24:00');
const isMidnightStart = (time: string) => /^00:00(:00)?$/.test(time);

/** Whether `date` falls inside one of the exceptions. */
function excluded(date: string, exceptions: readonly AvailabilityException[]): boolean {
  return exceptions.some((e) => e.fromDate <= date && date <= e.toDate);
}

/** Every piece the lines give on the dates `[from, to]`, sorted by start. */
function pieces(
  config: SlotConfig,
  lines: readonly AvailabilityLine[],
  exceptions: readonly AvailabilityException[],
  from: string,
  to: string
): Piece[] {
  const out: Piece[] = [];
  for (const date of datesBetween(from, to)) {
    if (excluded(date, exceptions)) continue;
    const weekday = isoWeekday(date);
    for (const line of lines) {
      if (line.onDate !== null ? line.onDate !== date : line.weekday !== weekday) continue;
      const startMs = zonedToUtcMs(date, line.startTime, config.timeZone);
      const endMs = zonedToUtcMs(date, line.endTime, config.timeZone);
      // A line inside a spring-forward gap can collapse to nothing: no piece, rather than a reversed one.
      if (endMs <= startMs) continue;
      out.push({ date, startMs, endMs, startTime: line.startTime, endTime: line.endTime });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * The windows (step space) or slots (slots space) of ONE resource whose local start date is in
 * `[from, to]`, sorted by start. See the file header for the joining rules.
 */
export function availabilityWindows(
  config: SlotConfig,
  lines: readonly AvailabilityLine[],
  exceptions: readonly AvailabilityException[],
  from: string,
  to: string
): Window[] {
  // The day before `from` too, so the tail of a window it starts is joined to it and dropped with it.
  const all = pieces(config, lines, exceptions, addDays(from, -1), addDays(to, 1));
  const joined: Piece[] = [];
  for (const p of all) {
    const last = joined[joined.length - 1];
    const joins =
      last !== undefined &&
      (config.slotMode === 'step'
        ? p.startMs <= last.endMs
        : p.startMs === last.endMs &&
          isMidnightEnd(last.endTime) &&
          isMidnightStart(p.startTime) &&
          p.date === addDays(last.date, 1));
    if (joins) {
      if (p.endMs > last.endMs) {
        last.endMs = p.endMs;
        last.endTime = p.endTime;
      }
      continue;
    }
    // The same slot from two lines (a weekly and a dated line agreeing) is one slot.
    if (last && last.startMs === p.startMs && last.endMs === p.endMs) continue;
    joined.push({ ...p });
  }
  return joined
    .filter((w) => w.date >= from && w.date <= to)
    .map(({ date, startMs, endMs }) => ({ date, startMs, endMs }));
}

/**
 * The bookable UNITS of the windows: the steps of a step space (a booking takes 1..maxSteps
 * consecutive ones), or the slots themselves. A trailing piece shorter than a step is not a step.
 */
export function slotUnits(config: SlotConfig, windows: readonly Window[]): Window[] {
  if (config.slotMode === 'slots') return windows.map((w) => ({ ...w }));
  const step = (config.stepMinutes ?? 0) * MINUTE_MS;
  if (step <= 0) return [];
  const out: Window[] = [];
  for (const w of windows) {
    for (let s = w.startMs; s + step <= w.endMs; s += step) {
      out.push({ date: w.date, startMs: s, endMs: s + step });
    }
  }
  return out;
}

/** Why a range is not a bookable shape of the availability. */
export type RangeRefusal = 'outside-availability' | 'misaligned' | 'too-many-steps';

/**
 * Whether `range` is a bookable shape: one slot exactly, or 1..maxSteps consecutive steps of one
 * window. It does NOT look at bookings, blocks or the booking window: those are separate checks.
 */
export function checkRangeShape(
  config: SlotConfig,
  windows: readonly Window[],
  range: Range
): RangeRefusal | null {
  if (range.endMs <= range.startMs) return 'misaligned';
  if (config.slotMode === 'slots') {
    return windows.some((w) => w.startMs === range.startMs && w.endMs === range.endMs)
      ? null
      : 'outside-availability';
  }
  const window = windows.find((w) => w.startMs <= range.startMs && range.endMs <= w.endMs);
  if (!window) return 'outside-availability';
  const step = (config.stepMinutes ?? 0) * MINUTE_MS;
  if (step <= 0) return 'misaligned';
  if ((range.startMs - window.startMs) % step !== 0 || (range.endMs - range.startMs) % step !== 0) {
    return 'misaligned';
  }
  return (range.endMs - range.startMs) / step > (config.maxSteps ?? 1) ? 'too-many-steps' : null;
}

/** The local dates a range may belong to: a window starts at most one day before the range. */
export function datesAround(range: Range, timeZone: string): [string, string] {
  return [addDays(localDate(range.startMs, timeZone), -1), localDate(range.endMs, timeZone)];
}

/** What a unit is, for the grid and the planning (D14). */
export type UnitState =
  | { state: 'free' }
  | { state: 'booked'; bookingId: string }
  | { state: 'blocked'; blockId: string };

/** A live booking or a block, as the states read them. */
export interface Occupation extends Range {
  id: string;
}

const overlaps = (a: Range, b: Range) => a.startMs < b.endMs && b.startMs < a.endMs;

/**
 * The state of each unit: BLOCKED wins over BOOKED (an organiser's "Indisponible" is what the
 * grid must say), and either wins over free. `bookings` must be LIVE ones (cancelled rows free
 * their range, D15).
 */
export function unitStates(
  units: readonly Range[],
  bookings: readonly Occupation[],
  blocks: readonly Occupation[]
): UnitState[] {
  return units.map((u) => {
    const block = blocks.find((b) => overlaps(u, b));
    if (block) return { state: 'blocked', blockId: block.id };
    const booking = bookings.find((b) => overlaps(u, b));
    if (booking) return { state: 'booked', bookingId: booking.id };
    return { state: 'free' };
  });
}

/**
 * D29: the coming live bookings an availability change would leave OUTSIDE the new availability -
 * a range that is no longer a bookable shape of it. The change is refused while this is not empty,
 * naming them; the organiser cancels them explicitly (D20) and retries.
 */
export function bookingsOutsideAvailability<T extends Occupation>(
  config: SlotConfig,
  lines: readonly AvailabilityLine[],
  exceptions: readonly AvailabilityException[],
  bookings: readonly T[]
): T[] {
  return bookings.filter((b) => {
    const [from, to] = datesAround(b, config.timeZone);
    const windows = availabilityWindows(config, lines, exceptions, from, to);
    // A booking longer than maxSteps under the NEW settings is outside them too.
    return checkRangeShape(config, windows, b) !== null;
  });
}
