import { describe, expect, it } from 'vitest';
import {
  closureProblem,
  crossesMidnight,
  fromStoredLines,
  lineProblem,
  nextDate,
  timeChoices,
  toStoredLines,
  type EditorLine,
} from './availability';

const weekly = (weekday: number, start: string, end: string): EditorLine =>
  ({ kind: 'weekly', weekday, start, end }) as EditorLine;

describe('toStoredLines', () => {
  it('writes an ordinary line as one line', () => {
    expect(toStoredLines([weekly(1, '14:00', '18:45')])).toEqual([
      { weekday: 1, onDate: null, startTime: '14:00', endTime: '18:45' },
    ]);
  });

  it('writes a line crossing midnight as two, Sunday wrapping to Monday', () => {
    expect(toStoredLines([weekly(7, '22:00', '02:00')])).toEqual([
      { weekday: 7, onDate: null, startTime: '22:00', endTime: '24:00' },
      { weekday: 1, onDate: null, startTime: '00:00', endTime: '02:00' },
    ]);
  });

  it('writes a dated line crossing midnight onto the next date, across a month', () => {
    expect(
      toStoredLines([{ kind: 'dated', date: '2026-10-31', start: '23:00', end: '01:00' }])
    ).toEqual([
      { weekday: null, onDate: '2026-10-31', startTime: '23:00', endTime: '24:00' },
      { weekday: null, onDate: '2026-11-01', startTime: '00:00', endTime: '01:00' },
    ]);
  });

  it('reads an end of 00:00 as the end of the same day, and 24:00 likewise', () => {
    expect(toStoredLines([weekly(1, '20:00', '00:00'), weekly(2, '00:00', '24:00')])).toEqual([
      { weekday: 1, onDate: null, startTime: '20:00', endTime: '24:00' },
      { weekday: 2, onDate: null, startTime: '00:00', endTime: '24:00' },
    ]);
  });
});

describe('fromStoredLines', () => {
  it('reads back what it wrote, the stored seconds dropped', () => {
    const lines = [weekly(5, '22:00', '02:00'), weekly(1, '09:00', '12:00')];
    const stored = toStoredLines(lines).map((l) => ({
      ...l,
      startTime: `${l.startTime}:00`,
      endTime: `${l.endTime}:00`,
    }));
    expect(fromStoredLines(stored)).toEqual([
      weekly(5, '22:00', '02:00'),
      weekly(1, '09:00', '12:00'),
    ]);
  });

  it('never folds a WHOLE day in as a tail: a 24/7 week stays seven lines', () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((d) => weekly(d, '00:00', '24:00'));
    expect(fromStoredLines(toStoredLines(week))).toEqual(week);
  });

  it('folds a tail once, as the server joins it once', () => {
    const stored = [
      { weekday: 1, onDate: null, startTime: '23:00', endTime: '24:00' },
      { weekday: 2, onDate: null, startTime: '00:00', endTime: '01:00' },
      { weekday: 2, onDate: null, startTime: '23:00', endTime: '24:00' },
    ];
    expect(fromStoredLines(stored)).toEqual([
      weekly(1, '23:00', '01:00'),
      weekly(2, '23:00', '24:00'),
    ]);
  });
});

describe('problems', () => {
  it.each([
    [weekly(1, '9:00', '10:00'), 'time'],
    [weekly(1, '10:00', '10:00'), 'empty'],
    [weekly(1, '24:00', '10:00'), 'time'],
    [weekly(1, '10:00', '24:00'), null],
    [weekly(1, '22:00', '02:00'), null],
  ])('%j -> %s', (line, problem) => {
    expect(lineProblem(line)).toBe(problem);
  });

  it('marks a line crossing midnight', () => {
    expect(crossesMidnight(weekly(1, '22:00', '02:00'))).toBe(true);
    expect(crossesMidnight(weekly(1, '22:00', '24:00'))).toBe(false);
  });

  it('refuses a closure out of order', () => {
    expect(closureProblem({ fromDate: '2026-12-31', toDate: '2026-12-24' })).toBe('order');
    expect(closureProblem({ fromDate: '2026-12-24', toDate: '2026-12-24' })).toBeNull();
  });

  it('counts dates across a leap day', () => {
    expect(nextDate('2028-02-28')).toBe('2028-02-29');
  });
});

describe('timeChoices', () => {
  it('offers every step from 00:00, and 24:00 as an end only', () => {
    expect(timeChoices(360, false, '')).toEqual(['00:00', '06:00', '12:00', '18:00']);
    expect(timeChoices(360, true, '')).toEqual(['00:00', '06:00', '12:00', '18:00', '24:00']);
  });

  it('keeps a value off the step, in its place', () => {
    expect(timeChoices(360, false, '07:10')).toEqual(['00:00', '06:00', '07:10', '12:00', '18:00']);
  });
});
