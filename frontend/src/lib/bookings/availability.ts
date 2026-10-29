/**
 * THE AVAILABILITY EDITOR'S MODEL, AND ITS TRANSLATION TO THE STORED LINES (WP-B4).
 *
 * The server stores a line as `startTime < endTime` on ONE weekday or ONE date
 * (`booking_availability_rules_order`), and joins a line ending at 24:00 to the next day's line
 * starting at 00:00 - once, never in a chain (docs/wiki/bookings-chantier.md "WP-B2 as built").
 * An organiser thinks of "Friday 22:00 to 02:00" as ONE line. This module is the only place the
 * two meet: `toStoredLines` writes an editor line crossing midnight as the two stored lines, and
 * `fromStoredLines` reads such a pair back as one. Pure, so every case is a table test.
 */

/**
 * The server's cap on the stored lines one availability carries (`MAX_AVAILABILITY_LINES`,
 * `apps/social-service/src/bookings/dto/space.dto.ts`). A fixed slot is one line, so a week of
 * short slots reaches it: the wizard and the painter stop at it and say so, before the server
 * refuses the save.
 */
export const MAX_AVAILABILITY_LINES = 200;

/** ISO weekday, 1 = Monday .. 7 = Sunday, as the server stores it. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A wall time `HH:MM`, `24:00` allowed as an END only. */
export type WallTime = string;

/**
 * One line as the organiser edits it. An `end` at or before `start` means "the next day": the
 * line crosses midnight. `end === '24:00'` is the end of the same day.
 */
export type EditorLine =
  | { kind: 'weekly'; weekday: Weekday; start: WallTime; end: WallTime }
  | { kind: 'dated'; date: string; start: WallTime; end: WallTime };

/** A line as the API stores it (`PUT bookings/resources/:id/availability`). */
export interface StoredLine {
  weekday: number | null;
  onDate: string | null;
  startTime: string;
  endTime: string;
}

/** A closure over local dates, both included. */
export interface Closure {
  fromDate: string;
  toDate: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `HH:MM[:SS]` to minutes since midnight; `24:00` is 1440. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** The stored `HH:MM:SS` as the editor shows it. */
const short = (time: string) => time.slice(0, 5);

/**
 * Monday..Sunday in `locale` (`fr-FR`, `en-US`), `long` or `short`, as the editors label days;
 * 2024-01-01 was a Monday.
 */
export function weekdayNames(locale: string, style: 'long' | 'short'): string[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) =>
    new Date(Date.UTC(2024, 0, d)).toLocaleDateString(locale, { weekday: style, timeZone: 'UTC' })
  );
}

/** The next ISO weekday. */
export const nextWeekday = (d: number): Weekday => ((d % 7) + 1) as Weekday;

/** The calendar date after `date` (`YYYY-MM-DD`), in plain calendar arithmetic. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Whether an editor line crosses midnight (its end is on the next day). */
export function crossesMidnight(line: EditorLine): boolean {
  return line.end !== '24:00' && minutesOf(line.end) <= minutesOf(line.start);
}

/** Why a line cannot be saved, or null: an unreadable time, or a line of zero length. */
export type LineProblem = 'time' | 'empty' | 'date';

export function lineProblem(line: EditorLine): LineProblem | null {
  if (!TIME.test(line.start) || !(TIME.test(line.end) || line.end === '24:00')) return 'time';
  if (line.kind === 'dated' && !/^\d{4}-\d{2}-\d{2}$/.test(line.date)) return 'date';
  if (line.start === line.end) return 'empty';
  if (line.start === '00:00' && line.end === '00:00') return 'empty';
  return null;
}

/** The stored lines of one editor line: one, or two when it crosses midnight. */
function stored(line: EditorLine): StoredLine[] {
  const day = (next: boolean) =>
    line.kind === 'weekly'
      ? { weekday: next ? nextWeekday(line.weekday) : line.weekday, onDate: null }
      : { weekday: null, onDate: next ? nextDate(line.date) : line.date };
  if (!crossesMidnight(line)) {
    return [{ ...day(false), startTime: line.start, endTime: line.end }];
  }
  const out: StoredLine[] = [{ ...day(false), startTime: line.start, endTime: '24:00' }];
  // An end of exactly 00:00 is the end of the first day: nothing spills into the next one.
  if (line.end !== '00:00') out.push({ ...day(true), startTime: '00:00', endTime: line.end });
  return out;
}

/** Every editor line as the API stores it. */
export function toStoredLines(lines: readonly EditorLine[]): StoredLine[] {
  return lines.flatMap(stored);
}

const keyOf = (l: StoredLine) => (l.weekday !== null ? `w${l.weekday}` : `d${l.onDate}`);
const nextKeyOf = (l: StoredLine) =>
  l.weekday !== null ? `w${nextWeekday(l.weekday)}` : `d${nextDate(l.onDate as string)}`;

/**
 * Stored lines as the editor shows them. A line ending at 24:00 and a line of the NEXT day from
 * 00:00 ending before 24:00 are read as ONE line crossing midnight - the very pair the server joins
 * (a WHOLE next day, 00:00-24:00, is never a tail, so it is never folded in). Each tail is folded
 * once, into the first evening that claims it, as the server joins it once.
 */
export function fromStoredLines(lines: readonly StoredLine[]): EditorLine[] {
  const rows = lines.map((l) => ({
    ...l,
    startTime: short(l.startTime),
    endTime: short(l.endTime),
  }));
  const used = new Set<number>();
  const out: EditorLine[] = [];
  const editorLine = (l: StoredLine, end: string): EditorLine =>
    l.weekday !== null
      ? { kind: 'weekly', weekday: l.weekday as Weekday, start: l.startTime, end }
      : { kind: 'dated', date: l.onDate as string, start: l.startTime, end };

  rows.forEach((l, i) => {
    if (used.has(i)) return;
    if (l.endTime === '24:00' && l.startTime !== '00:00') {
      const tail = rows.findIndex(
        (t, j) =>
          !used.has(j) &&
          j !== i &&
          keyOf(t) === nextKeyOf(l) &&
          t.startTime === '00:00' &&
          t.endTime !== '24:00' &&
          minutesOf(t.endTime) <= minutesOf(l.startTime)
      );
      if (tail >= 0) {
        used.add(i);
        used.add(tail);
        out.push(editorLine(l, rows[tail].endTime));
        return;
      }
    }
    used.add(i);
    out.push(editorLine(l, l.endTime));
  });
  return out;
}

/**
 * THE WARNING THE WP-B2 RULE OWES THE ORGANISER: when a resource is open WHOLE DAYS (00:00-24:00)
 * on two consecutive days, no booking can cross the midnight between them - each whole day is a
 * window of its own (docs/wiki/bookings-chantier.md, "a window crosses at most one midnight"). The
 * days are returned, so the screen can name them; empty when nothing is to say.
 */
export function wholeDaysInARow(lines: readonly EditorLine[]): string[] {
  const whole = lines.filter((l) => l.start === '00:00' && l.end === '24:00');
  const keys = new Set(whole.map((l) => (l.kind === 'weekly' ? `w${l.weekday}` : `d${l.date}`)));
  const hits: string[] = [];
  for (const l of whole) {
    const next = l.kind === 'weekly' ? `w${nextWeekday(l.weekday)}` : `d${nextDate(l.date)}`;
    if (keys.has(next)) hits.push(l.kind === 'weekly' ? `w${l.weekday}` : `d${l.date}`);
  }
  return hits;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * The times a line may start or end at, drawn by the app's own picker: every `step` minutes from
 * 00:00, `24:00` as an END only, and the line's `current` value kept when it is off the step (a
 * line written by an older screen, or by the API) - a choice list must never silently change one.
 */
export function timeChoices(step: number, asEnd: boolean, current: string): string[] {
  const out: string[] = [];
  for (let t = 0; t < 1440; t += step) out.push(`${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`);
  if (asEnd) out.push('24:00');
  if (current && !out.includes(current)) {
    out.push(current);
    out.sort((a, b) => minutesOf(a) - minutesOf(b));
  }
  return out;
}

/** Why a closure cannot be saved, or null. */
export function closureProblem(c: Closure): 'date' | 'order' | null {
  const shape = /^\d{4}-\d{2}-\d{2}$/;
  if (!shape.test(c.fromDate) || !shape.test(c.toDate)) return 'date';
  return c.fromDate > c.toDate ? 'order' : null;
}
