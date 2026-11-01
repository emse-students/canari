/**
 * THE GRID'S BLOCKS, AS PURE FUNCTIONS (the owner's "propre et joli", 2026-10-31).
 *
 * The server sends one `SlotUnit` per step or slot, so a 90-minute booking is six units. The grid
 * used to draw one cell per unit; it now draws ONE block per contiguous run of units that read as the
 * same thing, and keeps the units only as the hit areas a press or a drag lands on (`SpaceGrid`).
 *
 * A run lives inside ONE day column (`DayColumn.placed`), so it never crosses midnight: a booking
 * that does is two runs, one at the end of its first day and one at the start of the next, exactly
 * as it is two columns. Units that overlap in time (the lanes of a fall-back night, or two slots of
 * a list) are never merged: each stays a run of its own, drawn side by side in its lane.
 */
import type { SlotUnit } from './api';
import type { PlacedUnit } from './grid';

/** What a run IS, for the eye: a taken, blocked, free, not-offered-now or already-over stretch. */
export type RunKind = 'booked' | 'blocked' | 'free' | 'closed' | 'past';

/** One block: units `first..last` of the day's `placed` list, drawn as a single rectangle. */
export interface GridRun {
  kind: RunKind;
  /** Index (in the day's `placed` and `cells`) of the first and last unit it covers. */
  first: number;
  last: number;
  startMs: number;
  endMs: number;
  /** Minutes from the day's midnight, and how long it lasts. */
  topMin: number;
  heightMin: number;
  lane: number;
  lanes: number;
  /** The units it covers, in order. */
  units: SlotUnit[];
}

/**
 * What two units must share to be ONE block: the booking for a taken stretch, the block for a
 * blocked one (two organiser blocks side by side stay two, each lifted on its own), and the kind
 * alone for the rest.
 */
function mergeKey(unit: SlotUnit, kind: RunKind, splitFree: boolean): string {
  if (splitFree && kind === 'free') return `free:${unit.startMs}`;
  if (unit.state === 'booked') return `booked:${unit.booking.id}`;
  if (unit.state === 'blocked') return `blocked:${unit.blockId ?? unit.blockReason ?? ''}`;
  return kind;
}

/**
 * The day's units as runs, in time order. `kindOf` is the screen's reading of a unit (it depends
 * on the device's clock and the booking window), so the same unit is `free` or `closed` by the
 * moment, and the run follows. Adjacent units merge when they touch (one starts where the previous
 * ends), share a merge key, and are not sharing the width with another unit. `splitFree` keeps
 * every FREE unit a block of its own: in a space of fixed slots a slot is booked whole, so the
 * stretch of free time is not one range a booker may pick from.
 */
export function buildRuns(
  placed: readonly PlacedUnit[],
  kindOf: (unit: SlotUnit) => RunKind,
  splitFree = false
): GridRun[] {
  const runs: GridRun[] = [];
  let key = '';
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const kind = kindOf(p.unit);
    const unitKey = mergeKey(p.unit, kind, splitFree);
    const open = runs[runs.length - 1];
    if (
      open &&
      key === unitKey &&
      open.lanes === 1 &&
      p.lanes === 1 &&
      open.endMs === p.unit.startMs
    ) {
      open.last = i;
      open.endMs = p.unit.endMs;
      open.heightMin += p.heightMin;
      open.units.push(p.unit);
      continue;
    }
    key = unitKey;
    runs.push({
      kind,
      first: i,
      last: i,
      startMs: p.unit.startMs,
      endMs: p.unit.endMs,
      topMin: p.topMin,
      heightMin: p.heightMin,
      lane: p.lane,
      lanes: p.lanes,
      units: [p.unit],
    });
  }
  return runs;
}

/**
 * The runs with units `first..last` (the range being drawn) taken out: a run that holds the range
 * is cut into the part before it and the part after it, so the selection block sits where the free
 * block was and nothing shows through. Runs that do not touch the range come back unchanged.
 */
export function cutRange(
  runs: readonly GridRun[],
  placed: readonly PlacedUnit[],
  first: number,
  last: number
): GridRun[] {
  const out: GridRun[] = [];
  const piece = (run: GridRun, from: number, to: number): GridRun => ({
    ...run,
    first: from,
    last: to,
    startMs: placed[from].unit.startMs,
    endMs: placed[to].unit.endMs,
    topMin: placed[from].topMin,
    heightMin: placed[to].topMin + placed[to].heightMin - placed[from].topMin,
    units: placed.slice(from, to + 1).map((p) => p.unit),
  });
  for (const run of runs) {
    if (run.last < first || run.first > last) {
      out.push(run);
      continue;
    }
    if (run.first < first) out.push(piece(run, run.first, first - 1));
    if (run.last > last) out.push(piece(run, last + 1, run.last));
  }
  return out;
}

/** The rectangle of units `first..last` of a day, for the selection block. */
export function spanOf(
  placed: readonly PlacedUnit[],
  first: number,
  last: number
): {
  startMs: number;
  endMs: number;
  topMin: number;
  heightMin: number;
  lane: number;
  lanes: number;
} {
  const a = placed[first];
  const b = placed[last];
  return {
    startMs: a.unit.startMs,
    endMs: b.unit.endMs,
    topMin: a.topMin,
    heightMin: b.topMin + b.heightMin - a.topMin,
    lane: a.lane,
    lanes: a.lanes,
  };
}

/**
 * How much a block of `heightRem` has room to say: its name and range on two lines, one line, or
 * only its avatar (the full reading then lives in its tooltip and accessible name).
 */
export type BlockDensity = 'full' | 'line' | 'icon';

/**
 * What a block too NARROW for a row of avatar and text (under `STACK_BELOW_REM` wide) has room to
 * stack under its avatar, by height alone: 0 only the avatar, 1 the name, 2 the name and the hours
 * on one line, 3 the name and the hours on two lines (start, then end). Widths are the container
 * query's business; this is the height half of the same decision.
 */
export type StackedLines = 0 | 1 | 2 | 3;

/** Rem thresholds: avatar 1.5, a line 1 each, padding 0.5 and the gap 0.25 between them. */
export function stackedLines(heightRem: number): StackedLines {
  if (heightRem >= 5.25) return 3;
  if (heightRem >= 4.25) return 2;
  if (heightRem >= 2.75) return 1;
  return 0;
}

/** The container width (rem) under which a booking's avatar and text stack instead of sitting in a row. */
export const STACK_BELOW_REM = 7;
/** The container width (rem) under which the hours go on two lines, the start and then the end. */
export const SPLIT_TIME_BELOW_REM = 5;

/** Rem thresholds: two text lines need about 2.75rem with padding, one line about 1.5rem. */
export function blockDensity(heightRem: number): BlockDensity {
  if (heightRem >= 2.75) return 'full';
  if (heightRem >= 1.5) return 'line';
  return 'icon';
}

/**
 * Which way a range being drawn should scroll its box: 1 (down) or -1 (up) when the pointer is
 * within `edgePx` of the VISIBLE part of the box, 0 otherwise. The box may extend below the window
 * (its bottom is then off screen), so the edges are clamped to the viewport first: a pointer can
 * never reach an edge it cannot see.
 */
export function edgeScrollDirection(
  y: number,
  box: { top: number; bottom: number },
  viewportHeight: number,
  edgePx: number
): -1 | 0 | 1 {
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, viewportHeight);
  if (y > bottom - edgePx) return 1;
  if (y < top + edgePx) return -1;
  return 0;
}
