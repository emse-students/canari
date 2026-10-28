import { describe, expect, it } from 'vitest';
import { toStoredLines, wholeDaysInARow, type EditorLine } from './availability';
import {
  applyTemplate,
  formatRuns,
  isOpenAt,
  modeFrom,
  paintRows,
  rowsOfWeek,
  templateWeek,
  weekRunsOf,
} from './availabilityPaint';

const weekly = (weekday: number, start: string, end: string): EditorLine => ({
  kind: 'weekly',
  weekday: weekday as 1,
  start,
  end,
});
const dated = (date: string, start: string, end: string): EditorLine => ({
  kind: 'dated',
  date,
  start,
  end,
});

/** The stored lines of rows, sorted, so two orders of the same hours compare equal. */
const stored = (rows: readonly EditorLine[]) =>
  toStoredLines(rows)
    .map((l) => `${l.weekday ?? l.onDate} ${l.startTime}-${l.endTime}`)
    .sort();

describe('the week as runs (WP-R4, D49)', () => {
  it('reads weekly lines per weekday, merged, and leaves dated lines out', () => {
    const week = weekRunsOf([
      weekly(1, '08:00', '12:00'),
      weekly(1, '12:00', '18:00'),
      weekly(2, '09:00', '10:00'),
      dated('2026-11-12', '14:00', '18:45'),
    ]);
    expect(week[0]).toEqual([[480, 1080]]);
    expect(week[1]).toEqual([[540, 600]]);
    expect(week[2]).toEqual([]);
  });

  it('reads a line crossing midnight as its two halves, on two days', () => {
    const week = weekRunsOf([weekly(5, '22:00', '02:00')]);
    expect(week[4]).toEqual([[1320, 1440]]);
    expect(week[5]).toEqual([[0, 120]]);
  });

  it('writes a night back as ONE line, and a Sunday night wraps onto Monday', () => {
    const rows = rowsOfWeek(weekRunsOf([weekly(7, '22:00', '02:00')]), []);
    expect(rows).toEqual([weekly(7, '22:00', '02:00')]);
  });

  it('round-trips a typical set of lines to the same stored lines', () => {
    const rows = [
      weekly(1, '08:00', '23:00'),
      weekly(2, '08:00', '23:00'),
      weekly(5, '22:00', '02:00'),
      weekly(6, '10:00', '18:45'),
      dated('2026-11-12', '14:00', '18:45'),
    ];
    const again = rowsOfWeek(weekRunsOf(rows), rows);
    expect(stored(again)).toEqual(stored(rows));
    expect(again.filter((r) => r.kind === 'dated')).toEqual([rows[4]]);
  });

  it('keeps a whole day whole, never folding it into a night', () => {
    const rows = [weekly(1, '00:00', '24:00'), weekly(2, '00:00', '24:00')];
    expect(stored(rowsOfWeek(weekRunsOf(rows), []))).toEqual(stored(rows));
    expect(wholeDaysInARow(rowsOfWeek(weekRunsOf(rows), []))).toHaveLength(1);
  });
});

describe('painting a rectangle', () => {
  const base = [weekly(1, '08:00', '12:00')];

  it('opens what is closed and merges with what touches it', () => {
    // Monday, rows 24..27 = 12:00..14:00.
    const next = paintRows(base, 0, 0, 24, 27, 'open');
    expect(next).toEqual([weekly(1, '08:00', '14:00')]);
  });

  it('paints several days at once, in either direction', () => {
    const next = paintRows([], 2, 0, 18, 17, 'open');
    expect(stored(next)).toEqual(['1 08:30-09:30', '2 08:30-09:30', '3 08:30-09:30'].sort());
  });

  it('closes what is open and splits a run it cuts in the middle', () => {
    const next = paintRows(base, 0, 0, 18, 19, 'close');
    expect(stored(next)).toEqual(['1 08:00-09:00', '1 10:00-12:00'].sort());
  });

  it('takes its mode from where it starts: a closed cell opens, an open one closes', () => {
    const week = weekRunsOf(base);
    expect(isOpenAt(week, 0, 16)).toBe(true);
    expect(isOpenAt(week, 0, 24)).toBe(false);
    expect(modeFrom(week, 0, 16)).toBe('close');
    expect(modeFrom(week, 0, 24)).toBe('open');
  });

  it('returns the very same rows when a gesture changes nothing', () => {
    expect(paintRows(base, 0, 0, 16, 17, 'open')).toBe(base);
    expect(paintRows(base, 1, 1, 16, 17, 'close')).toBe(base);
  });

  it('never rounds an edge it does not cover: an 18:45 end survives a paint elsewhere', () => {
    const rows = [weekly(4, '14:00', '18:45')];
    const next = paintRows(rows, 4, 4, 20, 21, 'open');
    expect(stored(next)).toEqual(['4 14:00-18:45', '5 10:00-11:00'].sort().map((s) => s));
  });

  it('closing over an off-grain edge cuts at the grain and keeps the rest', () => {
    const rows = [weekly(4, '14:00', '18:45')];
    // Rows 36..37 = 18:00..19:00 close: the run keeps 14:00-18:00.
    expect(stored(paintRows(rows, 3, 3, 36, 37, 'close'))).toEqual(['4 14:00-18:00']);
  });

  it('paints to the end of the day as 24:00, and a night joins across the day line', () => {
    const next = paintRows([], 4, 4, 44, 47, 'open');
    expect(next).toEqual([weekly(5, '22:00', '24:00')]);
    const night = paintRows(next, 5, 5, 0, 3, 'open');
    expect(night).toEqual([weekly(5, '22:00', '02:00')]);
  });

  it('leaves dated lines alone', () => {
    const rows = [dated('2026-11-12', '14:00', '18:45')];
    expect(paintRows(rows, 0, 0, 0, 1, 'open')).toEqual([
      weekly(1, '00:00', '01:00'),
      dated('2026-11-12', '14:00', '18:45'),
    ]);
  });
});

describe('the templates', () => {
  it('draws the four of D49', () => {
    expect(templateWeek('always').every((d) => d.length === 1 && d[0][1] - d[0][0] === 1440)).toBe(
      true
    );
    expect(stored(applyTemplate([], 'weekdays'))).toEqual(
      [1, 2, 3, 4, 5].map((d) => `${d} 08:00-20:00`)
    );
    expect(applyTemplate([weekly(1, '08:00', '09:00')], 'empty')).toEqual([]);
  });

  it('replaces the week and keeps the dated lines', () => {
    const rows = [weekly(1, '08:00', '09:00'), dated('2026-11-12', '14:00', '18:45')];
    expect(applyTemplate(rows, 'weekdays').filter((r) => r.kind === 'dated')).toEqual([rows[1]]);
    expect(applyTemplate(rows, 'empty')).toEqual([rows[1]]);
  });

  it('"always" is a 24/7 week, which the existing warning names; the others are not', () => {
    expect(wholeDaysInARow(applyTemplate([], 'always')).length).toBe(7);
    expect(wholeDaysInARow(applyTemplate([], 'weekdays'))).toEqual([]);
  });

  it('"event" empties the week and offers one dated line to fill, once', () => {
    const once = applyTemplate([weekly(1, '08:00', '09:00')], 'event');
    expect(once).toEqual([dated('', '14:00', '18:00')]);
    expect(applyTemplate(once, 'event')).toEqual(once);
  });
});

describe('the reading of a day', () => {
  it('says its runs, and nothing when closed', () => {
    expect(formatRuns([[480, 1380]])).toBe('08:00 - 23:00');
    expect(
      formatRuns([
        [0, 120],
        [1320, 1440],
      ])
    ).toBe('00:00 - 02:00, 22:00 - 24:00');
    expect(formatRuns([])).toBe('');
  });
});
