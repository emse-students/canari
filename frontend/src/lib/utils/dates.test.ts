import { formatDayLabel, formatTime24, isToday, readStoredTimestampMs, toValidDate } from './dates';

describe('readStoredTimestampMs', () => {
  it('parses numeric and string epoch ms from SQLite', () => {
    expect(readStoredTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(readStoredTimestampMs('1700000000000')).toBe(1_700_000_000_000);
  });

  it('returns undefined for invalid values', () => {
    expect(readStoredTimestampMs(null)).toBeUndefined();
    expect(readStoredTimestampMs('')).toBeUndefined();
  });
});

describe('toValidDate', () => {
  it('returns fallback for invalid Date', () => {
    const fallback = new Date('2020-06-15T12:00:00Z');
    expect(toValidDate(new Date('not-a-date'), fallback)).toEqual(fallback);
  });

  it('parses unix milliseconds', () => {
    const d = toValidDate(1_700_000_000_000);
    expect(d.getTime()).toBe(1_700_000_000_000);
  });
});

describe('formatTime24', () => {
  it('does not throw on invalid input', () => {
    expect(() => formatTime24(undefined)).not.toThrow();
  });

  it('formats hours and minutes with zero padding', () => {
    const d = new Date(2024, 2, 1, 9, 5);
    expect(formatTime24(d)).toBe('09:05');
  });
});

describe('isToday', () => {
  it('detects today', () => {
    expect(isToday(new Date())).toBe(true);
  });
});

describe('formatDayLabel', () => {
  // Wednesday 30 September 2026, mid-afternoon local time: every expectation below is relative to
  // this injected clock, never to the machine's.
  const now = new Date(2026, 8, 30, 15, 0);
  const labels = { today: "Aujourd'hui", yesterday: 'Hier' };
  const fr = (d: Date) => formatDayLabel(d, 'fr', labels, now);

  it('says today and yesterday by calendar day, not by 24-hour distance', () => {
    expect(fr(new Date(2026, 8, 30, 0, 5))).toBe("Aujourd'hui");
    expect(fr(new Date(2026, 8, 29, 23, 55))).toBe('Hier');
  });

  it('names the weekday alone within the last six days', () => {
    expect(fr(new Date(2026, 8, 28, 12, 0))).toBe('Lundi');
    expect(fr(new Date(2026, 8, 24, 12, 0))).toBe('Jeudi');
  });

  it('switches to day and month from seven days back, without the current year', () => {
    expect(fr(new Date(2026, 8, 23, 12, 0))).toBe('23 septembre');
    expect(fr(new Date(2026, 0, 2, 12, 0))).toBe('2 janvier');
  });

  it('adds the year only when it is not the current one', () => {
    expect(fr(new Date(2025, 11, 31, 12, 0))).toBe('31 décembre 2025');
  });

  it('never calls a future day by its weekday', () => {
    expect(fr(new Date(2026, 9, 2, 12, 0))).toBe('2 octobre');
  });

  it('honours the locale it is given', () => {
    const en = (d: Date) =>
      formatDayLabel(d, 'en', { today: 'Today', yesterday: 'Yesterday' }, now);
    expect(en(new Date(2026, 8, 29, 9, 0))).toBe('Yesterday');
    expect(en(new Date(2026, 8, 28, 9, 0))).toBe('Monday');
    expect(en(new Date(2026, 8, 23, 9, 0))).toBe('September 23');
    expect(en(new Date(2025, 4, 5, 9, 0))).toBe('May 5, 2025');
  });
});
