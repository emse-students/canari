/**
 * THE PAINTED WEEK AS PURE FUNCTIONS (WP-R4, D49).
 *
 * The organiser paints a typical week on a grid; the server still stores weekly and dated LINES
 * (`availability.ts`). The painter's model is the week as RUNS - per ISO weekday, the merged
 * `[start, end)` minute ranges that are open - and this module is the only place a paint meets the
 * lines: `weekRunsOf` reads the editor's weekly lines as runs (a line crossing midnight is its two
 * stored halves), a paint changes the runs, and `rowsOfWeek` writes them back through
 * `fromStoredLines`, which joins an evening and its morning into one line again.
 *
 * RUNS, NOT CELLS, so painting is lossless. The grain of a gesture is 30 min (Q-R11) but a line
 * typed as 18:45 (a slots space, an older screen) is a run ending at 18:45: a paint elsewhere never
 * rounds it, and only the part a rectangle covers changes.
 *
 * Dated lines are not the week's: they pass through untouched, in their own list.
 */
import {
  fromStoredLines,
  lineProblem,
  MAX_AVAILABILITY_LINES,
  minutesOf,
  toStoredLines,
  type EditorLine,
  type StoredLine,
  type Weekday,
} from './availability';

/** The painter's grain in minutes (Q-R11): the exact times are typed in the lines below it. */
export const GRAIN_MIN = 30;
/** Rows of the painter: a day of grains. */
export const DAY_SLOTS = (24 * 60) / GRAIN_MIN;
const DAY_MIN = 24 * 60;

/** One open range of a day, in minutes from midnight; `[1320, 1440]` is 22:00 to the day's end. */
export type Run = readonly [start: number, end: number];

/** The open runs of Monday..Sunday (index 0..6), each day sorted and merged. */
export type WeekRuns = Run[][];

/** Which way a gesture goes: it opens what is closed, or closes what is open. */
export type PaintMode = 'open' | 'close';

/** The four templates of D49. `event` empties the week: its hours are dated lines. */
export type TemplateKey = 'always' | 'weekdays' | 'event' | 'empty';

/** Sorts runs and merges those that overlap or touch. */
function merge(runs: readonly Run[]): Run[] {
  const sorted = [...runs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** `runs` without the range `[from, to)`: a run it cuts in the middle becomes two. */
function subtract(runs: readonly Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  for (const [start, end] of runs) {
    if (end <= from || start >= to) {
      out.push([start, end]);
      continue;
    }
    if (start < from) out.push([start, from]);
    if (end > to) out.push([to, end]);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Minutes from midnight as a stored time: `1440` is `24:00`. */
export function timeOfMinutes(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/**
 * The weekly lines of the editor as the week's open runs. A line the editor refuses to save
 * (`lineProblem`: a start equal to its end, an unreadable time) is NOT a run: the painter draws only
 * what the save would send, and `rowsOfWeek` keeps such a line where it is for the organiser to fix.
 */
export function weekRunsOf(rows: readonly EditorLine[]): WeekRuns {
  const week: Run[][] = Array.from({ length: 7 }, () => []);
  const valid = rows.filter((r) => r.kind === 'weekly' && lineProblem(r) === null);
  for (const line of toStoredLines(valid)) {
    if (line.weekday === null) continue;
    week[line.weekday - 1].push([minutesOf(line.startTime), minutesOf(line.endTime)]);
  }
  return week.map(merge);
}

/**
 * The week's runs as editor lines (an evening and its morning joined), then what `rows` holds that
 * is not a run: its dated lines, and any weekly line that has a problem (kept, never normalised).
 */
export function rowsOfWeek(week: WeekRuns, rows: readonly EditorLine[]): EditorLine[] {
  // Monday LAST: `fromStoredLines` folds a morning into an evening it has already seen, and
  // Monday's morning is the tail of Sunday's night.
  const stored: StoredLine[] = [1, 2, 3, 4, 5, 6, 0].flatMap((day) =>
    week[day].map(([start, end]) => ({
      weekday: day + 1,
      onDate: null,
      startTime: timeOfMinutes(start),
      endTime: timeOfMinutes(end),
    }))
  );
  const kept = rows.filter((r) => r.kind === 'dated' || lineProblem(r) !== null);
  return [...fromStoredLines(stored), ...kept];
}

/** Whether the part of `day` that starts at grain row `slot` is open (its first minute is covered). */
export function isOpenAt(week: WeekRuns, day: number, slot: number): boolean {
  const minute = slot * GRAIN_MIN;
  return week[day]?.some(([start, end]) => start <= minute && minute < end) ?? false;
}

/** The mode a gesture takes from the cell it is pressed on: closed opens, open closes. */
export function modeFrom(week: WeekRuns, day: number, slot: number): PaintMode {
  return isOpenAt(week, day, slot) ? 'close' : 'open';
}

/**
 * The rows after a rectangle is painted: from day `dayA` to `dayB` and grain row `slotA` to `slotB`,
 * in either direction, both ends included. THE SAME `rows` ARRAY comes back when nothing changed, so
 * a gesture that changes nothing does not mark the editor dirty or reorder its lines.
 */
export function paintRows(
  rows: readonly EditorLine[],
  dayA: number,
  dayB: number,
  slotA: number,
  slotB: number,
  mode: PaintMode
): readonly EditorLine[] {
  const days = [Math.min(dayA, dayB), Math.max(dayA, dayB)];
  const from = Math.max(0, Math.min(slotA, slotB)) * GRAIN_MIN;
  const to = Math.min(DAY_MIN, (Math.max(slotA, slotB) + 1) * GRAIN_MIN);
  const before = weekRunsOf(rows);
  const after = before.map((runs, day) => {
    if (day < days[0] || day > days[1]) return runs;
    return mode === 'open' ? merge([...runs, [from, to]]) : subtract(runs, from, to);
  });
  if (JSON.stringify(before) === JSON.stringify(after)) return rows;
  return rowsOfWeek(after, rows);
}

/** The week a template draws. */
export function templateWeek(key: TemplateKey): WeekRuns {
  const open = (days: number, start: number, end: number): WeekRuns =>
    Array.from({ length: 7 }, (_, day) => (day < days ? [[start, end] as Run] : []));
  switch (key) {
    case 'always':
      return open(7, 0, DAY_MIN);
    case 'weekdays':
      return open(5, 8 * 60, 20 * 60);
    default:
      return open(0, 0, 0);
  }
}

/**
 * The rows after a template: the week is replaced by it, the dated lines stay. `event` leaves the
 * week empty and, when there is no dated line yet, adds one for the organiser to date.
 */
export function applyTemplate(rows: readonly EditorLine[], key: TemplateKey): EditorLine[] {
  const next = rowsOfWeek(templateWeek(key), rows);
  if (key === 'event' && !next.some((r) => r.kind === 'dated')) {
    next.push({ kind: 'dated', date: '', start: '14:00', end: '18:00' });
  }
  return next;
}

/** One day's runs as the reader says them: "08:00 - 23:00, 14:00 - 24:00"; empty when closed. */
export function formatRuns(runs: readonly Run[]): string {
  return runs.map(([start, end]) => `${timeOfMinutes(start)} - ${timeOfMinutes(end)}`).join(', ');
}

/*
 * FIXED SLOTS (decided by the owner on 2026-10-29). In a `slots` space each weekly line IS one slot
 * (WP-B2), so the week is never read as merged runs there: two slots that touch (14:00-14:25,
 * 14:25-14:50) are two slots, and a paint opens or closes WHOLE slots, one by one, never merging
 * them. `weekRunsOf` / `paintRows` stay the rule of a `step` space, where touching hours ARE one
 * window.
 */

/** A valid weekly line's pieces on the week, `[day index, start, end]`, split at midnight. */
function slotPieces(row: EditorLine): [number, number, number][] {
  if (row.kind !== 'weekly' || lineProblem(row) !== null) return [];
  return toStoredLines([row]).map((l) => [
    (l.weekday as number) - 1,
    minutesOf(l.startTime),
    minutesOf(l.endTime),
  ]);
}

/** The fixed slots of the week, each its own run (never merged), each day sorted. */
export function weekSlotsOf(rows: readonly EditorLine[]): WeekRuns {
  const week: Run[][] = Array.from({ length: 7 }, () => []);
  for (const row of rows) {
    for (const [day, start, end] of slotPieces(row)) week[day].push([start, end]);
  }
  return week.map((runs) => runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
}

/**
 * The length a painted slot takes: the most common length of the week's slots (ties to the
 * shorter), so a paint in an alumni column of 25-min slots opens 25-min slots; the painter's grain
 * when the week has none.
 */
export function slotLengthOf(rows: readonly EditorLine[]): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const length = slotPieces(row).reduce((sum, [, start, end]) => sum + end - start, 0);
    if (length > 0) counts.set(length, (counts.get(length) ?? 0) + 1);
  }
  let best = GRAIN_MIN;
  let seen = 0;
  for (const [length, count] of counts) {
    if (count > seen || (count === seen && length < best)) {
      best = length;
      seen = count;
    }
  }
  return best;
}

/** A paint on a fixed-slot space: the rows after it, and what the line cap kept it from opening. */
export interface SlotPaint {
  rows: readonly EditorLine[];
  /** How many slots the rectangle asked for were NOT opened, the availability being at its cap. */
  refused: number;
}

/**
 * The rows after a rectangle is painted on a FIXED-SLOT space. `close` removes every slot the
 * rectangle touches, whole; `open` lays new slots of `slotLengthOf` from the rectangle's first row,
 * one for each start inside it, skipping any that would overlap a slot already there - so a tap
 * opens one whole slot. An open stops at {@link MAX_AVAILABILITY_LINES} stored lines and says so
 * (`refused`), since the server would refuse the whole save past it. Dated lines and lines with a
 * problem are never touched. THE SAME `rows` come back when nothing changed, as `paintRows` does.
 */
export function paintSlotRows(
  rows: readonly EditorLine[],
  dayA: number,
  dayB: number,
  slotA: number,
  slotB: number,
  mode: PaintMode
): SlotPaint {
  const [d0, d1] = [Math.min(dayA, dayB), Math.max(dayA, dayB)];
  const from = Math.max(0, Math.min(slotA, slotB)) * GRAIN_MIN;
  const to = Math.min(DAY_MIN, (Math.max(slotA, slotB) + 1) * GRAIN_MIN);
  const touches = (day: number, start: number, end: number) =>
    day >= d0 && day <= d1 && start < to && end > from;
  if (mode === 'close') {
    const kept = rows.filter((r) => !slotPieces(r).some(([d, s, e]) => touches(d, s, e)));
    return { rows: kept.length === rows.length ? rows : kept, refused: 0 };
  }
  const length = slotLengthOf(rows);
  const taken = weekSlotsOf(rows);
  // A new slot never crosses midnight, so it is ONE stored line.
  let budget = MAX_AVAILABILITY_LINES - toStoredLines(rows).length;
  let refused = 0;
  const added: EditorLine[] = [];
  for (let day = d0; day <= d1; day++) {
    for (let start = from; start < to && start + length <= DAY_MIN; start += length) {
      const end = start + length;
      if (taken[day].some(([s, e]) => s < end && e > start)) continue;
      if (budget <= 0) {
        refused += 1;
        continue;
      }
      budget -= 1;
      added.push({
        kind: 'weekly',
        weekday: (day + 1) as Weekday,
        start: timeOfMinutes(start),
        end: timeOfMinutes(end),
      });
    }
  }
  return { rows: added.length ? [...rows, ...added] : rows, refused };
}
