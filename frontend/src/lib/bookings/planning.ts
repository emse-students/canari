/**
 * THE PHONE'S PLANNING, AS PURE FUNCTIONS (owner, 2026-11-01: "vue planning, comme l'agenda Canari",
 * a "+" and a form, instead of painting a range with a finger).
 *
 * Two jobs, both over what `SpaceWeek` already holds, so the planning is a second way to read the
 * SAME week read as the grid and never a second request:
 *  - `planningDays`: each day as the grid's runs (a booking, a block, a free stretch, a stretch not
 *    offered now), already merged by `buildRuns`;
 *  - the range form's choices: which units a range may start on, how far it may go, and which units
 *    a chosen start and end cover. THE CHOICES ARE DRAWN FROM THE FREE RUNS, so a form built on them
 *    cannot name a range over a booking, past a block or beyond what one booking may cover; the
 *    server stays the judge (`slot-taken`, `notice`, ... say so in plain words at the send).
 */
import type { BookerSpace, SlotUnit } from './api';
import { buildRuns, type GridRun, type RunKind } from './gridRuns';
import {
  freeRunFrom,
  isOfferedStart,
  isPastUnit,
  unitDay,
  type DayState,
  type WeekLayout,
} from './grid';

/** One day of the planning: its date, what it holds for a booker, and its blocks in time order. */
export interface PlanningDay {
  date: string;
  state: DayState;
  rows: GridRun[];
}

/**
 * The week as a list. `past` stretches are left out (over, nothing to read or tap); a day with
 * nothing offered keeps its date and has no rows.
 */
export function planningDays(
  layout: Pick<WeekLayout, 'days'>,
  kindOf: (unit: SlotUnit) => RunKind,
  splitFree: boolean
): PlanningDay[] {
  return layout.days.map((day) => ({
    date: day.date,
    state: day.state,
    rows: buildRuns(day.placed, kindOf, splitFree).filter((run) => run.kind !== 'past'),
  }));
}

/** The units of one column that START on `date` (the day a unit is on), in time order. */
export function dayUnits(units: readonly SlotUnit[], date: string, zone: string): SlotUnit[] {
  return units.filter((u) => unitDay(u, zone) === date);
}

/** The free units of `units` a range may start on (`offered` is the screen's rule for a start). */
export function startChoices(
  units: readonly SlotUnit[],
  offered: (unit: SlotUnit) => boolean
): SlotUnit[] {
  return units.filter((u) => u.state === 'free' && offered(u));
}

/**
 * The units a range starting at `start` may cover, in order: contiguous free units, at most `limit`.
 * Each one's end is a choice for the range's end. Empty when `start` is not a free unit of `units`.
 */
export function endChoices(units: readonly SlotUnit[], start: SlotUnit, limit: number): SlotUnit[] {
  return freeRunFrom(units, start, limit);
}

/** What the form's start and end name: the first unit and how many it covers, or null when stale. */
export function resolveRange(
  units: readonly SlotUnit[],
  startMs: number,
  endMs: number,
  limit: number
): { first: SlotUnit; count: number } | null {
  const first = units.find((u) => u.startMs === startMs && u.state === 'free');
  if (!first) return null;
  const run = freeRunFrom(units, first, limit);
  const idx = run.findIndex((u) => u.endMs === endMs);
  return idx < 0 ? null : { first, count: idx + 1 };
}

/**
 * The planning's reading of a unit, as a `RunKind`: taken, blocked, over, free, or free but not
 * offered now (the booking window, a refused start). The organiser (`blockMode`) is not bound by
 * the window, so every free unit that is not over reads `free` for them.
 */
export function planningKind(
  space: Pick<BookerSpace, 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  nowMs: number,
  lastRefusedStart: number | null,
  blockMode: boolean
): (unit: SlotUnit) => RunKind {
  return (unit) => {
    if (unit.state === 'booked') return 'booked';
    if (unit.state === 'blocked') return 'blocked';
    if (isPastUnit(unit, nowMs)) return 'past';
    return isOfferedStart(space, unit, nowMs, lastRefusedStart, blockMode) ? 'free' : 'closed';
  };
}
