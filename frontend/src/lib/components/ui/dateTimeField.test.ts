import {
  clampToMin,
  dayBeforeMin,
  formatLocalDateTime,
  minuteChoices,
  parseLocalDateTime,
  shiftMonth,
} from './dateTimeField';

describe('dateTimeField', () => {
  it('reads and writes the native datetime-local format, both ways', () => {
    const dt = parseLocalDateTime('2026-09-29T20:05');
    expect(dt).toEqual({ year: 2026, month: 8, day: 29, hour: 20, minute: 5 });
    expect(formatLocalDateTime(dt!)).toBe('2026-09-29T20:05');
  });

  it('reads an empty or malformed value as no date', () => {
    expect(parseLocalDateTime('')).toBeNull();
    expect(parseLocalDateTime('29/09/2026')).toBeNull();
  });

  it('keeps a minute off the step instead of rounding a stored date', () => {
    expect(minuteChoices(15, 17)).toEqual([0, 15, 17, 30, 45]);
    expect(minuteChoices(15, 30)).toEqual([0, 15, 30, 45]);
  });

  it('greys out a day wholly before min, and keeps the day that contains it', () => {
    expect(dayBeforeMin(2026, 8, 28, '2026-09-29T20:05')).toBe(true);
    expect(dayBeforeMin(2026, 8, 29, '2026-09-29T20:05')).toBe(false);
    expect(dayBeforeMin(2026, 8, 28, '')).toBe(false);
  });

  it('clamps an earlier time on the min day to min, and leaves a later one', () => {
    const early = parseLocalDateTime('2026-09-29T08:00')!;
    const late = parseLocalDateTime('2026-09-29T22:00')!;
    expect(formatLocalDateTime(clampToMin(early, '2026-09-29T20:05'))).toBe('2026-09-29T20:05');
    expect(clampToMin(late, '2026-09-29T20:05')).toBe(late);
  });

  it('wraps the year when the month moves', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});
