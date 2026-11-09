import {
  calendarDay,
  dayLabeler,
  formatDayLabel,
  formatTime24,
  isToday,
  readStoredTimestampMs,
  toValidDate,
} from './dates';

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

describe('calendarDay', () => {
  /**
   * The getters path is only exercised away from UTC, which is what CI runs in: this case moves the
   * process to Paris (Node re-reads `TZ` on assignment, on Linux and Windows alike), PROVES the move
   * took, and compares the getters with `Intl` asked for Paris explicitly - plus the day each instant
   * must land on, written out.
   */
  it("answers the browser's own zone from the Date getters, in a zone that is not UTC", () => {
    const before = process.env.TZ;
    process.env.TZ = 'Europe/Paris';
    try {
      expect(new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset()).toBe(-60);
      const day = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 86_400_000;
      const cases: [number, number][] = [
        // 00:30 on 1 January 2026 in Paris, still 2025 in UTC: the year edge.
        [Date.UTC(2025, 11, 31, 23, 30), day(2026, 0, 1)],
        // 23:30 on 31 December 2025 in Paris.
        [Date.UTC(2025, 11, 31, 22, 30), day(2025, 11, 31)],
        // 00:30 on 29 March 2026, the night the clocks skip 02:00 -> 03:00.
        [Date.UTC(2026, 2, 28, 23, 30), day(2026, 2, 29)],
        // 03:30 CEST on 29 March, just after the gap.
        [Date.UTC(2026, 2, 29, 1, 30), day(2026, 2, 29)],
        // 23:30 CEST on 29 March: a day of 23 hours still ends on the 29th.
        [Date.UTC(2026, 2, 29, 21, 30), day(2026, 2, 29)],
        // 00:30 CEST on 25 October, the night 03:00 -> 02:00 repeats an hour.
        [Date.UTC(2026, 9, 24, 22, 30), day(2026, 9, 25)],
        // 23:30 CET on 25 October: a day of 25 hours.
        [Date.UTC(2026, 9, 25, 22, 30), day(2026, 9, 25)],
      ];
      for (const [instant, expected] of cases) {
        const d = new Date(instant);
        expect(calendarDay(d)).toBe(expected);
        expect(calendarDay(d)).toBe(calendarDay(d, 'Europe/Paris'));
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('dayLabeler', () => {
  const now = new Date(2026, 8, 30, 15, 0);
  const labels = { today: "Aujourd'hui", yesterday: 'Hier' };

  it('names every day of a long pass as a fresh labeler names it alone (no shape leaks)', () => {
    for (const locale of ['fr', 'en']) {
      const label = dayLabeler(locale, labels, now);
      // Weekdays, then day-month, then a previous year, then the future: every shape, interleaved.
      for (let back = -3; back < 400; back += 1) {
        const d = new Date(2026, 8, 30 - back, 9, 0);
        expect(label(d)).toBe(dayLabeler(locale, labels, now)(d));
      }
    }
    expect(dayLabeler('fr', labels, now)(new Date(2025, 4, 5, 9, 0))).toBe('5 mai 2025');
    expect(dayLabeler('fr', labels, now)(new Date(2026, 8, 23, 9, 0))).toBe('23 septembre');
  });
});
