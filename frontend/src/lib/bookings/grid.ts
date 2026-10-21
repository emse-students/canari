/**
 * THE BOOKER'S GRID AND PLANNING, AS PURE FUNCTIONS (WP-B5, D14).
 *
 * The server sends every unit of every resource with its state (`GET bookings/spaces/:id/slots`);
 * this module lays them out - the grid of one date (resources as columns, units as rows), the
 * planning (the next units one may book, per resource), the run of free steps a booking or a block
 * may cover - and says when a unit is outside the booking window. Times are read in the SPACE's
 * zone (D25: a traveller sees the space's time) through `zonedTime.ts`, the server's own clock.
 *
 * A unit's DAY is the local date of its START, never `unit.date`: the server stamps a unit with the
 * date its availability WINDOW started, so the 00:30 of a "Friday 22:00 to 02:00" window is
 * Friday's on the grid (the night is one window) and Saturday's on every sentence that names a day.
 *
 * The window check is `bookingWindowRefusal`, the server's own (`bookingWindow.ts`). It only
 * DRAWS: the device's clock may be wrong, so the screen never withholds a request on it.
 */
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { BookerSpace, ResourceSlots, SlotUnit } from './api';
import { bookingWindowRefusal, type WindowRefusal } from './bookingWindow';
import { addDays, dayCount, localDate, localTime, offsetMs } from './zonedTime';

export type { WindowRefusal } from './bookingWindow';

/** How many lengths a block offers at most: past a day of short steps, a list is no longer a choice. */
export const BLOCK_LENGTH_CHOICES = 48;

const DAY_MS = 86_400_000;

const intlLocale = () => (getLocale() === 'en' ? 'en-US' : 'fr-FR');

/** The day a unit is ON: the local date of its start in the space's zone (see the header). */
export function unitDay(unit: { startMs: number }, zone: string): string {
  return localDate(unit.startMs, zone);
}

/** A calendar date as the reader's language writes it: "lundi 2 novembre". */
export function formatDay(date: string, withYear = false): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(), {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(Date.UTC(y, mo - 1, d)));
}

/** A calendar date, short: "sam. 7 nov.". */
function formatShortDay(date: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(), {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, mo - 1, d)));
}

/** The zone's offset at an instant: "UTC+2". */
function offsetLabel(instantMs: number, zone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(instantMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  return (name ?? 'GMT').replace('GMT', 'UTC');
}

/**
 * Whether the wall time of `instantMs` happens TWICE in `zone` (the doubled hour of a fall-back
 * night): the instant one offset change away reads the same wall clock.
 */
function wallTimeRepeats(instantMs: number, zone: string): boolean {
  const here = offsetMs(instantMs, zone);
  return [offsetMs(instantMs - DAY_MS, zone), offsetMs(instantMs + DAY_MS, zone)].some((other) => {
    if (other === here) return false;
    const twin = instantMs + here - other;
    return offsetMs(twin, zone) === other;
  });
}

/** A wall time, followed by its offset when the same wall time happens twice that night. */
function wallTimeLabel(instantMs: number, zone: string): string {
  const time = localTime(instantMs, zone);
  return wallTimeRepeats(instantMs, zone) ? `${time} (${offsetLabel(instantMs, zone)})` : time;
}

/**
 * "10:00 - 11:30" in the space's zone. An end at the next midnight reads `24:00`, never `00:00`; an
 * end later on the next day is marked "(lendemain)"; an end further on names its day. A time of
 * a fall-back night's doubled hour carries its offset - "02:00 (UTC+2) - 02:00 (UTC+1)" - so two
 * different ranges never read the same.
 */
export function formatTimeRange(startMs: number, endMs: number, zone: string): string {
  const startDay = localDate(startMs, zone);
  const endDay = localDate(endMs, zone);
  const endTime = wallTimeLabel(endMs, zone);
  const days = dayCount(startDay, endDay) - 1;
  let end = endTime;
  if (days === 1 && endTime === '00:00') end = '24:00';
  else if (days === 1) end = `${endTime} ${m.bookings_time_next_day()}`;
  else if (days > 1) end = `${formatShortDay(endDay)} ${endTime}`;
  return `${wallTimeLabel(startMs, zone)} - ${end}`;
}

/** "lundi 2 novembre, 10:00 - 11:30" in the space's zone, the day being the start's. */
export function formatBookingRange(startMs: number, endMs: number, zone: string): string {
  return `${formatDay(localDate(startMs, zone))}, ${formatTimeRange(startMs, endMs, zone)}`;
}

/**
 * Whether the device reads a different wall clock than the space at `nowMs`: the screen then names
 * the space's zone, so a traveller knows the times are the space's (D25).
 */
export function zoneDiffersFromDevice(zone: string, nowMs: number): boolean {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!device || device === zone) return false;
  return (
    localDate(nowMs, zone) !== localDate(nowMs, device) ||
    localTime(nowMs, zone) !== localTime(nowMs, device)
  );
}

/**
 * The server's window rule (`bookingWindow.ts`) for one start, on the DEVICE's clock: it draws a
 * unit as bookable or not, nothing more - the server answers every request on its own clock.
 */
export function windowRefusal(
  space: Pick<BookerSpace, 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  startMs: number,
  nowMs: number
): WindowRefusal | null {
  return bookingWindowRefusal(
    {
      opensAtMs: space.opensAt ? Date.parse(space.opensAt) : null,
      minNoticeMinutes: space.minNoticeMinutes,
      horizonDays: space.horizonDays,
    },
    startMs,
    nowMs
  );
}

/** One row of the grid of a date: one time range, and each resource's unit on it (or none). */
export interface GridRow {
  key: string;
  startMs: number;
  endMs: number;
  /** What the row header reads (`formatTimeRange`: a fall-back night's hours carry their offset). */
  label: string;
  /** The row starts after the date's midnight: part of a night window, marked as the next day. */
  nextDay: boolean;
  /** In the order of `resourceIds`; `null` where that resource has no unit on this range. */
  cells: (SlotUnit | null)[];
}

/**
 * The grid of one WINDOW date: every distinct range any resource offers in the windows that
 * started that date, by start then end, each with the unit of every resource. In slots mode two
 * resources may offer different ranges (D3): a resource without a unit on a row has an empty cell.
 */
export function gridRows(
  resourceIds: readonly string[],
  slots: readonly ResourceSlots[],
  date: string,
  zone: string
): GridRow[] {
  const byResource = new Map(slots.map((r) => [r.resourceId, r.units]));
  const rows = new Map<string, Omit<GridRow, 'label'>>();
  resourceIds.forEach((id, column) => {
    for (const unit of byResource.get(id) ?? []) {
      if (unit.date !== date) continue;
      const key = `${unit.startMs}-${unit.endMs}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          startMs: unit.startMs,
          endMs: unit.endMs,
          nextDay: unitDay(unit, zone) !== date,
          cells: resourceIds.map(() => null),
        };
        rows.set(key, row);
      }
      row.cells[column] = unit;
    }
  });
  return [...rows.values()]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((row) => ({ ...row, label: formatTimeRange(row.startMs, row.endMs, zone) }));
}

/**
 * The dates to read for a view anchored on `anchor` and showing `days` days: FROM THE DAY BEFORE.
 * The server keeps a unit in a read only when its WINDOW's date is in the range (see the header),
 * so the 00:30 of a "Friday 22:00 to 02:00" window, still to come at Saturday 00:15, is in no read
 * that starts on Saturday. A window crosses at most one midnight (WP-B2), so one day back is enough.
 */
export function slotsReadRange(anchor: string, days: number): { from: string; to: string } {
  return { from: addDays(anchor, -1), to: addDays(anchor, days - 1) };
}

/**
 * The window date the grid opens on: the date of a window that started before `today` and is
 * still running at `nowMs` (a night window after midnight), else `today`. The grid lays out a
 * window date (`gridRows`), so opening on `today` after midnight would hide the rest of the night.
 */
export function gridOpeningDate(
  slots: readonly ResourceSlots[],
  today: string,
  nowMs: number
): string {
  let opening = today;
  for (const resource of slots) {
    for (const unit of resource.units) {
      if (unit.date < opening && unit.endMs > nowMs) opening = unit.date;
    }
  }
  return opening;
}

/** A resource's units in time order (the server's order is by window; this does not rely on it). */
export function unitsInOrder(slots: readonly ResourceSlots[], resourceId: string): SlotUnit[] {
  const units = slots.find((r) => r.resourceId === resourceId)?.units ?? [];
  return [...units].sort((a, b) => a.startMs - b.startMs);
}

/**
 * The FREE units a range starting at `first` may cover, `first` included: each next unit starts
 * where the previous ends and is free, at most `limit` of them. One unit for a slot (D3: a slot is
 * booked whole), up to `maxSteps` for a booking in steps, and any length for a block. Empty when
 * `first` is not a free unit of `units`.
 */
export function freeRunFrom(
  units: readonly SlotUnit[],
  first: SlotUnit,
  limit: number
): SlotUnit[] {
  const start = units.findIndex((u) => u.startMs === first.startMs && u.endMs === first.endMs);
  if (start < 0 || units[start].state !== 'free') return [];
  const run = [units[start]];
  for (let i = start + 1; i < units.length && run.length < limit; i++) {
    const unit = units[i];
    if (unit.state !== 'free' || unit.startMs !== run[run.length - 1].endMs) break;
    run.push(unit);
  }
  return run;
}

/**
 * What a DRAG over one resource's column selects. `cells` is that column, one entry per grid row
 * (`null` where the resource has no unit); the drag was pressed on row `anchor` and the pointer is
 * now over row `current`, above or below it.
 *
 * The range grows from the anchor toward the pointer one row at a time and stops at the first row
 * that is not a free unit TOUCHING the previous one (a booked or blocked unit, the gap between two
 * windows, a row where this resource has no unit) or when `limit` units are covered - so the
 * selection can never be longer than one booking may be, and never covers anything taken. It is
 * the same rule as `freeRunFrom`, read in both directions. `count` is 0 when the anchor is not a
 * free unit.
 */
export function dragRange(
  cells: readonly (SlotUnit | null)[],
  anchor: number,
  current: number,
  limit: number
): { first: number; count: number } {
  const start = cells[anchor];
  if (!start || start.state !== 'free' || limit < 1) return { first: anchor, count: 0 };
  const direction = current >= anchor ? 1 : -1;
  let last = anchor;
  for (let i = anchor + direction; i >= 0 && i < cells.length; i += direction) {
    if (direction === 1 ? i > current : i < current) break;
    if (Math.abs(i - anchor) + 1 > limit) break;
    const unit = cells[i];
    const previous = cells[last];
    if (!unit || !previous || unit.state !== 'free') break;
    const touching =
      direction === 1 ? unit.startMs === previous.endMs : unit.endMs === previous.startMs;
    if (!touching) break;
    last = i;
  }
  return { first: Math.min(anchor, last), count: Math.abs(last - anchor) + 1 };
}

/** How many units one booking may cover in this space: a whole slot, or 1..`maxSteps` steps. */
export function bookingUnitLimit(space: Pick<BookerSpace, 'slotMode' | 'maxSteps'>): number {
  return space.slotMode === 'slots' ? 1 : Math.max(1, space.maxSteps ?? 1);
}

/** One resource's next units a booker may take now - the planning view (D14). */
export interface PlanningEntry {
  resourceId: string;
  units: SlotUnit[];
}

/**
 * For each resource in order, its first `perResource` FREE units the booking window accepts now.
 * A resource with none is kept, empty, so the planning can say it is full rather than leave it out.
 */
export function planning(
  space: Pick<BookerSpace, 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  resourceIds: readonly string[],
  slots: readonly ResourceSlots[],
  nowMs: number,
  perResource: number
): PlanningEntry[] {
  return resourceIds.map((resourceId) => ({
    resourceId,
    units: unitsInOrder(slots, resourceId)
      .filter((u) => u.state === 'free' && windowRefusal(space, u.startMs, nowMs) === null)
      .slice(0, perResource),
  }));
}
