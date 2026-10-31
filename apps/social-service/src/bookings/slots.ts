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
 * 2. In a `step` space the pieces of ONE DATE are UNITED into a window (overlapping or touching
 *    pieces become one), cut into steps of `stepMinutes` of ELAPSED time from its start; a booking
 *    is 1..`maxSteps` consecutive steps, each starting where the previous ends (D3) - so it may run
 *    from one window into the next one that TOUCHES it ({@link checkRangeShape}).
 * 3. In a `slots` space each distinct piece IS one slot (D3).
 * 4. A window CROSSES AT MOST ONE MIDNIGHT ({@link availabilityWindows}): one ending at 24:00 takes
 *    in the next date's TAIL (00:00 to before 24:00), so a window written as two lines - 22:00-24:00
 *    and 00:00-02:00 the next day, since `startTime < endTime` is a CHECK - is one window again, in
 *    both modes. It belongs to the local date it STARTS on. That bounds what the GRID lists per
 *    date; it does not bound a booking: two whole days in a row are one continuous opening.
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

/** The pieces the lines give on ONE local date, sorted by start then end. */
function piecesOn(
  config: SlotConfig,
  lines: readonly AvailabilityLine[],
  exceptions: readonly AvailabilityException[],
  date: string
): Piece[] {
  if (excluded(date, exceptions)) return [];
  const weekday = isoWeekday(date);
  const out: Piece[] = [];
  for (const line of lines) {
    if (line.onDate !== null ? line.onDate !== date : line.weekday !== weekday) continue;
    const startMs = zonedToUtcMs(date, line.startTime, config.timeZone);
    const endMs = zonedToUtcMs(date, line.endTime, config.timeZone);
    // A line inside a spring-forward gap can collapse to nothing: no piece, rather than a reversed one.
    if (endMs <= startMs) continue;
    out.push({ date, startMs, endMs, startTime: line.startTime, endTime: line.endTime });
  }
  return out.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
}

/**
 * The windows of ONE local date before any midnight join: in a step space the date's pieces UNITED
 * (overlapping or touching), in a slots space the date's DISTINCT pieces (a weekly and a dated line
 * giving the same slot are one slot; two overlapping slots stay two - see the wiki).
 */
function dayWindows(
  config: SlotConfig,
  lines: readonly AvailabilityLine[],
  exceptions: readonly AvailabilityException[],
  date: string
): Piece[] {
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const p of piecesOn(config, lines, exceptions, date)) {
    const last = out[out.length - 1];
    if (config.slotMode === 'step' && last && p.startMs <= last.endMs) {
      if (p.endMs > last.endMs) {
        last.endMs = p.endMs;
        last.endTime = p.endTime;
      }
      continue;
    }
    const key = `${p.startMs}:${p.endMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p });
  }
  return out;
}

/** A TAIL: a day window starting at 00:00 and ending BEFORE 24:00 - the after-midnight part of a window. */
const isTail = (w: Piece) => isMidnightStart(w.startTime) && !isMidnightEnd(w.endTime);

/**
 * THE ONE MIDNIGHT JOIN between a date's windows and the next date's: the first window of `day`
 * ending at 24:00 (the HEAD) and the first TAIL of `next` starting at that instant. Null when there
 * is none. Both sides of a date boundary ask this same function, so the head extending and the
 * tail disappearing always agree.
 */
function midnightJoin(
  day: readonly Piece[],
  next: readonly Piece[]
): { head: Piece; tail: Piece } | null {
  for (const head of day) {
    if (!isMidnightEnd(head.endTime)) continue;
    const tail = next.find((n) => isTail(n) && n.startMs === head.endMs);
    if (tail) return { head, tail };
  }
  return null;
}

/**
 * The windows (step space) or slots (slots space) of ONE resource whose local start date is in
 * `[from, to]`, sorted by start.
 *
 * A WINDOW CROSSES AT MOST ONE MIDNIGHT. A date's window ending at 24:00 takes in the next date's
 * TAIL (a window from 00:00 that ends before 24:00), and that tail is then no window of its own.
 * A whole day (00:00-24:00) is never a tail, so it is never swallowed: a 24/7 resource is one
 * window per day, and a run of days never chains into one window. Each date is decided from
 * itself and its two neighbours only, so asking for one day or for a range gives the same windows
 * for that day.
 */
export function availabilityWindows(
  config: SlotConfig,
  lines: readonly AvailabilityLine[],
  exceptions: readonly AvailabilityException[],
  from: string,
  to: string
): Window[] {
  const cache = new Map<string, Piece[]>();
  const windowsOf = (date: string) => {
    let w = cache.get(date);
    if (!w) {
      w = dayWindows(config, lines, exceptions, date);
      cache.set(date, w);
    }
    return w;
  };
  const out: Window[] = [];
  for (const date of datesBetween(from, to)) {
    const swallowed = midnightJoin(windowsOf(addDays(date, -1)), windowsOf(date))?.tail;
    const extended = midnightJoin(windowsOf(date), windowsOf(addDays(date, 1)));
    for (const w of windowsOf(date)) {
      if (w === swallowed) continue;
      const endMs = extended?.head === w ? extended.tail.endMs : w.endMs;
      out.push({ date, startMs: w.startMs, endMs });
    }
  }
  return out.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
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
 * Whether `range` lies inside ONE continuous opening: a run of windows, each starting no later than
 * where the previous one ends. Two whole days in a row (00:00-24:00 each), Sunday into Monday, or a
 * weekly day into a dated one are one opening; an exception (a closed day) or any gap cuts it.
 */
function insideOneOpening(windows: readonly Window[], range: Range): boolean {
  const sorted = [...windows].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  let reach: number | null = null;
  for (const w of sorted) {
    if (reach === null) {
      if (w.startMs <= range.startMs && range.startMs < w.endMs) reach = w.endMs;
    } else if (w.startMs <= reach && w.endMs > reach) {
      reach = w.endMs;
    }
    if (reach !== null && range.endMs <= reach) return true;
  }
  return false;
}

/**
 * Whether `range` is a bookable shape: one slot exactly, or 1..maxSteps consecutive steps, each
 * starting where the previous one ends. Consecutive steps may belong to two windows that TOUCH - a
 * booking from 23:00 to 01:00 between two whole days, or a several-day booking when `maxSteps`
 * allows it - which is the rule the booker's screen applies when it offers a run of free units
 * (`freeRunFrom` in the frontend's `grid.ts`). It does NOT look at bookings, blocks or the booking
 * window: those are separate checks, and a block refuses the booking it overlaps.
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
  if (!insideOneOpening(windows, range)) return 'outside-availability';
  const step = (config.stepMinutes ?? 0) * MINUTE_MS;
  if (step <= 0) return 'misaligned';
  // Walk the range one step at a time: every step must be a step of a window. A window whose length
  // is not a multiple of the step ends on a piece that is no step, so no booking runs past it.
  const starts = new Set(slotUnits(config, windows).map((u) => u.startMs));
  if (!starts.has(range.startMs) || (range.endMs - range.startMs) % step !== 0) return 'misaligned';
  const count = (range.endMs - range.startMs) / step;
  if (count > (config.maxSteps ?? 1)) return 'too-many-steps';
  for (let s = range.startMs + step; s < range.endMs; s += step) {
    if (!starts.has(s)) return 'misaligned';
  }
  return null;
}

/**
 * The local dates whose windows a range may need: from the day before it starts (a window starts at
 * most one day before the range) to the day it ends, every date between included - a booking across
 * several whole days runs through each of their windows.
 */
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
