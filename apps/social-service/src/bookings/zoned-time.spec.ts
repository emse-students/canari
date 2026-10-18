import {
  addDays,
  datesBetween,
  dayCount,
  isCalendarDate,
  isValidTimeZone,
  isoWeekday,
  isoWeekMonday,
  localDate,
  localTime,
  offsetMs,
  timeToSeconds,
  zonedToUtcMs,
} from './zoned-time';

const iso = (ms: number) => new Date(ms).toISOString();

describe('zonedToUtcMs: a local wall time in a zone, as a UTC instant (D25)', () => {
  // Paris in 2026: spring forward on 29 March 02:00 -> 03:00, fall back on 25 October 03:00 -> 02:00.
  it.each([
    ['winter', '2026-01-15', '18:00', 'Europe/Paris', '2026-01-15T17:00:00.000Z'],
    ['summer', '2026-07-15', '18:00', 'Europe/Paris', '2026-07-15T16:00:00.000Z'],
    [
      'the evening before spring forward',
      '2026-03-28',
      '18:00',
      'Europe/Paris',
      '2026-03-28T17:00:00.000Z',
    ],
    [
      'the evening after spring forward',
      '2026-03-29',
      '18:00',
      'Europe/Paris',
      '2026-03-29T16:00:00.000Z',
    ],
    [
      'inside the spring gap: moved FORWARD by it',
      '2026-03-29',
      '02:30',
      'Europe/Paris',
      '2026-03-29T01:30:00.000Z',
    ],
    ['the gap start itself', '2026-03-29', '02:00', 'Europe/Paris', '2026-03-29T01:00:00.000Z'],
    [
      'twice on the fall-back night: the EARLIER',
      '2026-10-25',
      '02:30',
      'Europe/Paris',
      '2026-10-25T00:30:00.000Z',
    ],
    [
      'just after the fall-back hour',
      '2026-10-25',
      '03:00',
      'Europe/Paris',
      '2026-10-25T02:00:00.000Z',
    ],
    [
      '24:00 is the next day 00:00',
      '2026-01-15',
      '24:00',
      'Europe/Paris',
      '2026-01-15T23:00:00.000Z',
    ],
    [
      'seconds as PostgreSQL returns them',
      '2026-01-15',
      '18:00:30',
      'Europe/Paris',
      '2026-01-15T17:00:30.000Z',
    ],
    ['New York spring gap', '2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:30:00.000Z'],
    ['UTC itself', '2026-03-29', '02:30', 'UTC', '2026-03-29T02:30:00.000Z'],
  ])('%s: %s %s %s', (_case, date, time, zone, expected) => {
    expect(iso(zonedToUtcMs(date, time, zone))).toBe(expected);
  });

  it('round-trips through the local date on both sides of each change', () => {
    for (const date of [
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]) {
      for (const time of ['00:00', '12:00', '23:59']) {
        expect(localDate(zonedToUtcMs(date, time, 'Europe/Paris'), 'Europe/Paris')).toBe(date);
      }
    }
  });

  it('refuses a malformed date or time rather than guessing', () => {
    expect(() => zonedToUtcMs('2026-1-5', '10:00', 'Europe/Paris')).toThrow(RangeError);
    expect(() => timeToSeconds('25:00')).toThrow(RangeError);
    expect(() => timeToSeconds('10:60')).toThrow(RangeError);
  });
});

describe('the calendar helpers', () => {
  it('reads offsets', () => {
    expect(offsetMs(Date.parse('2026-01-15T12:00:00Z'), 'Europe/Paris')).toBe(3_600_000);
    expect(offsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Europe/Paris')).toBe(7_200_000);
  });

  it('reads a local date past UTC midnight', () => {
    expect(localDate(Date.parse('2026-01-15T23:30:00Z'), 'Europe/Paris')).toBe('2026-01-16');
  });

  it('reads a local wall time, midnight as 00:00 and both hours of a fall-back night', () => {
    expect(localTime(Date.parse('2026-01-15T23:00:00Z'), 'Europe/Paris')).toBe('00:00');
    expect(localTime(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Paris')).toBe('02:30');
    expect(localTime(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Paris')).toBe('02:30');
  });

  it('counts days, weekdays and ISO weeks', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(isoWeekday('2026-10-17')).toBe(6);
    expect(isoWeekday('2026-10-18')).toBe(7);
    expect(isoWeekMonday('2026-10-18')).toBe('2026-10-12');
    expect(isoWeekMonday('2026-10-12')).toBe('2026-10-12');
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(datesBetween('2026-11-02', '2026-11-01')).toEqual([]);
  });

  it('knows a calendar date, and counts a range without building it', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('z')).toBe(false);
    expect(dayCount('2026-10-25', '2026-10-25')).toBe(1);
    expect(dayCount('2026-03-01', '2026-03-31')).toBe(31);
    expect(dayCount('2026-11-02', '2026-11-01')).toBe(0);
    expect(dayCount('2026-01-01', '9999-12-31')).toBeGreaterThan(2_900_000);
    // A malformed end is refused at once, never walked towards.
    expect(() => datesBetween('2026-01-01', 'z')).toThrow(RangeError);
  });

  it('knows a zone from a typo', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Europe/Pariss')).toBe(false);
  });
});
