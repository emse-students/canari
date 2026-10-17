import {
  type QuotaSettings,
  type WindowSettings,
  checkBookingWindow,
  checkQuotas,
  participantMayWithdraw,
  quotaPeriodKey,
} from './booking-rules';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-20T10:00:00Z');
const at = (offset: number, minutes = 60) => ({
  startMs: NOW + offset,
  endMs: NOW + offset + minutes * MIN,
});

describe('checkBookingWindow (D26)', () => {
  const none: WindowSettings = { opensAt: null, minNoticeMinutes: null, horizonDays: null };
  it.each<[string, WindowSettings, { startMs: number; endMs: number }, string | null]>([
    ['no setting takes a coming slot', none, at(HOUR), null],
    ['a slot that has begun is history', none, at(-MIN), 'started'],
    ['a slot starting now has begun', none, at(0), 'started'],
    [
      'before the opening date',
      { ...none, opensAt: new Date(NOW + DAY) },
      at(2 * DAY),
      'not-open-yet',
    ],
    ['at the opening date', { ...none, opensAt: new Date(NOW) }, at(HOUR), null],
    ['inside the notice', { ...none, minNoticeMinutes: 120 }, at(HOUR), 'notice'],
    ['exactly at the notice', { ...none, minNoticeMinutes: 60 }, at(HOUR), null],
    ['past the horizon', { ...none, horizonDays: 7 }, at(7 * DAY + MIN), 'beyond-horizon'],
    ['exactly at the horizon', { ...none, horizonDays: 7 }, at(7 * DAY), null],
  ])('%s', (_case, settings, range, refusal) => {
    expect(checkBookingWindow(settings, range, NOW)).toBe(refusal);
  });
});

describe('checkQuotas (D17)', () => {
  const base: QuotaSettings = {
    timeZone: 'Europe/Paris',
    maxActiveBookings: null,
    maxMinutesPerPeriod: null,
    quotaPeriod: null,
  };

  it.each<
    [
      string,
      QuotaSettings,
      { startMs: number; endMs: number }[],
      { startMs: number; endMs: number },
      string | null,
    ]
  >([
    ['no ceiling', base, [at(HOUR), at(2 * HOUR)], at(3 * HOUR), null],
    ['under the active ceiling', { ...base, maxActiveBookings: 2 }, [at(HOUR)], at(3 * HOUR), null],
    [
      'at the active ceiling',
      { ...base, maxActiveBookings: 2 },
      [at(HOUR), at(2 * HOUR)],
      at(3 * HOUR),
      'active-bookings',
    ],
    [
      'an ENDED booking no longer counts',
      { ...base, maxActiveBookings: 1 },
      [at(-2 * HOUR)],
      at(HOUR),
      null,
    ],
    [
      'a booking IN PROGRESS still counts',
      { ...base, maxActiveBookings: 1 },
      [at(-30 * MIN)],
      at(HOUR),
      'active-bookings',
    ],
    [
      'minutes in the same local day',
      { ...base, maxMinutesPerPeriod: 120, quotaPeriod: 'day' },
      [at(HOUR, 90)],
      at(3 * HOUR, 60),
      'minutes-per-period',
    ],
    [
      'exactly at the minutes ceiling',
      { ...base, maxMinutesPerPeriod: 120, quotaPeriod: 'day' },
      [at(HOUR, 60)],
      at(3 * HOUR, 60),
      null,
    ],
    [
      'another day does not count',
      { ...base, maxMinutesPerPeriod: 120, quotaPeriod: 'day' },
      [at(HOUR, 90)],
      at(DAY + HOUR, 60),
      null,
    ],
    [
      'the same ISO week counts',
      { ...base, maxMinutesPerPeriod: 120, quotaPeriod: 'week' },
      [at(HOUR, 90)],
      at(3 * DAY, 60),
      'minutes-per-period',
    ],
  ])('%s', (_case, settings, mine, range, refusal) => {
    expect(checkQuotas(settings, mine, range, NOW)).toBe(refusal);
  });

  it('keys a period by LOCAL date: 23:30Z on a Sunday is Monday in Paris', () => {
    const sundayNightUtc = Date.parse('2026-10-25T23:30:00Z');
    expect(quotaPeriodKey('day', sundayNightUtc, 'Europe/Paris')).toBe('2026-10-26');
    expect(quotaPeriodKey('week', sundayNightUtc, 'Europe/Paris')).toBe('2026-10-26');
    expect(quotaPeriodKey('week', sundayNightUtc, 'UTC')).toBe('2026-10-19');
  });
});

describe('participantMayWithdraw (D5, decided by the user 2026-10-17)', () => {
  it.each([
    ['no delay, before the start', 0, HOUR, true],
    ['no delay, at the start', 0, 0, false],
    ['inside the delay', 120, HOUR, false],
    ['just before the delay', 60, HOUR + MIN, true],
    ['exactly at the delay', 60, HOUR, false],
  ])('%s', (_case, delay, startIn, expected) => {
    expect(participantMayWithdraw(delay, NOW + startIn, NOW)).toBe(expected);
  });
});
