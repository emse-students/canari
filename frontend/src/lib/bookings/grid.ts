/**
 * THE BOOKER'S WEEK, AS PURE FUNCTIONS (WP-B5, D14; WP-R2, D46-D48).
 *
 * The server sends every unit of every resource with its state (`GET bookings/spaces/:id/slots`);
 * this module lays ONE resource's units out as a week - the days as columns, each unit placed by
 * its wall time on a shared axis - and gives the run of free steps a booking or a block may cover,
 * and says when a unit is outside the booking window. Times are read in the SPACE's zone (D25: a
 * traveller sees the space's time) through `zonedTime.ts`, the server's own clock.
 *
 * A unit's DAY is the local date of its START, never `unit.date`: the server stamps a unit with the
 * date its availability WINDOW started, so the 00:30 of a "Friday 22:00 to 02:00" window is
 * Saturday's column (it is a Saturday morning) while the read that holds it starts the day before
 * (`slotsReadRange`).
 *
 * The window check is `bookingWindowRefusal`, the server's own (`bookingWindow.ts`). It only
 * DRAWS: the device's clock may be wrong, so the screen never withholds a request on it.
 */
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { BookerSpace, ResourceSlots, SlotUnit } from './api';
import { bookingWindowRefusal, type WindowRefusal } from './bookingWindow';
import {
  addDays,
  datesBetween,
  dayCount,
  isoWeekMonday,
  localDate,
  localTime,
  offsetMs,
} from './zonedTime';

export type { WindowRefusal } from './bookingWindow';

/** How many lengths a block offers at most: past a day of short steps, a list is no longer a choice. */
export const BLOCK_LENGTH_CHOICES = 48;

const DAY_MS = 86_400_000;

/** The Intl locale this client formats dates and numbers in. */
export const intlLocale = () => (getLocale() === 'en' ? 'en-US' : 'fr-FR');

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

/**
 * A unit that is over on the device's clock. The grid DIMS it and says nothing in it: "not
 * bookable" is news only for a unit that is still to come, and repeating it down every past cell
 * of the week buried the cells that were still worth reading.
 */
export function isPastUnit(unit: { endMs: number }, nowMs: number): boolean {
  return unit.endMs <= nowMs;
}

/** Days of one week on the booker's page. */
export const WEEK_DAYS = 7;

/** The seven dates of the ISO week (Monday first) holding `anchor`. */
export function weekDates(anchor: string): string[] {
  const monday = isoWeekMonday(anchor);
  return datesBetween(monday, addDays(monday, WEEK_DAYS - 1));
}

/** The read that holds the week of `anchor`, with the day before it (see `slotsReadRange`). */
export function weekReadRange(anchor: string): { from: string; to: string } {
  return slotsReadRange(isoWeekMonday(anchor), WEEK_DAYS);
}

/** "26 octobre - 1 novembre 2026", the week of `dates` in the reader's language. */
export function formatWeekRange(dates: readonly string[]): string {
  const at = (date: string) => {
    const [y, mo, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, d));
  };
  return new Intl.DateTimeFormat(intlLocale(), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatRange(at(dates[0]), at(dates[dates.length - 1]));
}

/** A day's header: its short weekday ("lun.") and its day of the month. */
export function formatDayHead(date: string): { weekday: string; num: number } {
  const [y, mo, d] = date.split('-').map(Number);
  return {
    weekday: new Intl.DateTimeFormat(intlLocale(), { timeZone: 'UTC', weekday: 'short' }).format(
      new Date(Date.UTC(y, mo - 1, d))
    ),
    num: d,
  };
}

/** One unit placed on a day's column: minutes from the day's midnight, and its lane when units overlap. */
export interface PlacedUnit {
  unit: SlotUnit;
  topMin: number;
  heightMin: number;
  /** Side by side only when two units overlap in time (two slots of a predefined list may). */
  lane: number;
  lanes: number;
}

/** What a day holds for a booker: nothing offered, nothing left to take, or something free. */
export type DayState = 'closed' | 'none' | 'open';

/** One day of the week: its units in time order (`cells`, what a drag walks) and where they sit. */
export interface DayColumn {
  date: string;
  cells: SlotUnit[];
  placed: PlacedUnit[];
  state: DayState;
}

export interface WeekLayout {
  days: DayColumn[];
  /** The shared axis, in minutes from midnight, whole hours. Both 0 when nothing is offered. */
  startMin: number;
  endMin: number;
  /** The height of one hour, in rem: tall enough that the shortest unit holds a line of text. */
  remPerHour: number;
}

/** The wall-clock minute of the day (0..1439) an instant falls on, in `zone`. */
function wallMinutes(instantMs: number, zone: string): number {
  const [h, min] = localTime(instantMs, zone).split(':').map(Number);
  return h * 60 + min;
}

const MIN_HOUR_REM = 4;
const MAX_HOUR_REM = 12;
/** The least height (rem) a unit may be drawn at, so its label reads. */
const MIN_UNIT_REM = 1.75;

/**
 * Where one day's units sit. A unit sits at its start's WALL minute and is as tall as it LASTS, so a
 * 18:00 unit is at 18:00 on every day, daylight saving included, and nothing is ever shifted: the
 * only place wall time and elapsed time disagree is a change night. On a fall-back night the doubled
 * 02:00 hour holds two units at the same wall time; they OVERLAP like two slots of a list and share
 * the width in lanes, so every later unit stays on its own wall time. (Displacing the second one
 * pushed the whole rest of the day an hour down.)
 */
function placeDay(units: readonly SlotUnit[], zone: string): PlacedUnit[] {
  const placed: PlacedUnit[] = units.map((unit) => ({
    unit,
    topMin: wallMinutes(unit.startMs, zone),
    heightMin: (unit.endMs - unit.startMs) / 60_000,
    lane: 0,
    lanes: 1,
  }));
  let cluster: PlacedUnit[] = [];
  let laneEnds: number[] = [];
  const closeCluster = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const p of placed) {
    if (laneEnds.length > 0 && laneEnds.every((end) => end <= p.topMin)) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= p.topMin);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = p.topMin + p.heightMin;
    p.lane = lane;
    cluster.push(p);
  }
  closeCluster();
  return placed;
}

/**
 * ONE resource's units laid out as `dates` (the week, or the one day of a phone): each unit on the
 * date it STARTS on, the axis shared by every day so the same hour lines up. A date with no unit is
 * `closed` (the screen folds it); one whose units are all taken, blocked or outside the booking
 * window on the device's clock is `none`. The server decides every request on its own clock.
 */
export function weekLayout(
  units: readonly SlotUnit[],
  dates: readonly string[],
  space: Pick<BookerSpace, 'timeZone' | 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  nowMs: number
): WeekLayout {
  const zone = space.timeZone;
  const byDay = new Map<string, SlotUnit[]>(dates.map((d) => [d, []]));
  for (const unit of [...units].sort((a, b) => a.startMs - b.startMs)) {
    byDay.get(unitDay(unit, zone))?.push(unit);
  }
  const days: DayColumn[] = dates.map((date) => {
    const cells = byDay.get(date) ?? [];
    const open = cells.some(
      (u) => u.state === 'free' && windowRefusal(space, u.startMs, nowMs) === null
    );
    return {
      date,
      cells,
      placed: placeDay(cells, zone),
      state: cells.length === 0 ? 'closed' : open ? 'open' : 'none',
    };
  });
  const all = days.flatMap((d) => d.placed);
  if (all.length === 0) return { days, startMin: 0, endMin: 0, remPerHour: MIN_HOUR_REM };
  const shortest = Math.min(...all.map((p) => p.heightMin));
  return {
    days,
    startMin: Math.floor(Math.min(...all.map((p) => p.topMin)) / 60) * 60,
    endMin: Math.ceil(Math.max(...all.map((p) => p.topMin + p.heightMin)) / 60) * 60,
    remPerHour: Math.min(MAX_HOUR_REM, Math.max(MIN_HOUR_REM, (MIN_UNIT_REM * 60) / shortest)),
  };
}

/** How many units of `units` a booker may take now, on the device's clock: the selector's count. */
export function freeCount(
  units: readonly SlotUnit[],
  space: Pick<BookerSpace, 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  nowMs: number
): number {
  return units.filter((u) => u.state === 'free' && windowRefusal(space, u.startMs, nowMs) === null)
    .length;
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
