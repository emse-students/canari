import { describe, it, expect, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { formatNoticeSlot, readBookingNoticeMeta, reminderWhen } from './noticeText';

describe('readBookingNoticeMeta', () => {
  it('reads place, slot start and zone', () => {
    const meta = {
      place: 'Salle',
      startsAt: '2026-11-03T09:00:00.000Z',
      timeZone: 'Europe/Paris',
      word: 'desole',
    };
    expect(readBookingNoticeMeta(meta)).toEqual(meta);
  });

  it('accepts an empty place (link-only space)', () => {
    const meta = {
      place: '',
      startsAt: '2026-11-03T09:00:00.000Z',
      timeZone: 'Europe/Paris',
      word: '',
    };
    expect(readBookingNoticeMeta(meta)).toEqual(meta);
  });

  it('returns null for a legacy row (no meta) and for anything not of that shape', () => {
    expect(readBookingNoticeMeta(null)).toBeNull();
    expect(readBookingNoticeMeta(undefined)).toBeNull();
    expect(readBookingNoticeMeta('Salle')).toBeNull();
    expect(readBookingNoticeMeta({ place: 'x' })).toBeNull();
    expect(
      readBookingNoticeMeta({
        place: 'x',
        startsAt: 'not a date',
        timeZone: 'Europe/Paris',
        word: '',
      })
    ).toBeNull();
  });
});

describe('formatNoticeSlot', () => {
  const instant = '2026-11-03T09:00:00.000Z';

  it('draws the day and the time on the SPACE clock, whatever the device zone is', () => {
    // 09:00 UTC is 10:00 in Paris (CET) and 04:00 in New York (EST): the zone argument decides.
    expect(formatNoticeSlot(instant, 'Europe/Paris')).toMatch(/^mar\.? 3 nov\.?,? 10:00$/);
    expect(formatNoticeSlot(instant, 'America/New_York')).toMatch(/^mar\.? 3 nov\.?,? 04:00$/);
  });

  it('moves the DAY with the zone when the instant crosses midnight there', () => {
    expect(formatNoticeSlot('2026-11-03T23:30:00.000Z', 'Europe/Paris')).toMatch(
      /^mer\.? 4 nov\.?,? 00:30$/
    );
  });

  it('follows the DST transition of the space (spring forward, Paris 2026-03-29)', () => {
    // 00:30Z is 01:30 CET; one hour later the clock has jumped: 01:30Z is 03:30 CEST (no 02:xx).
    expect(formatNoticeSlot('2026-03-29T00:30:00.000Z', 'Europe/Paris')).toMatch(
      /dim\.? 29 mars,? 01:30$/
    );
    expect(formatNoticeSlot('2026-03-29T01:30:00.000Z', 'Europe/Paris')).toMatch(
      /dim\.? 29 mars,? 03:30$/
    );
  });

  it('is null, and says so, for a zone the runtime refuses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(formatNoticeSlot(instant, 'Mars/Olympus')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('reminderWhen (said as of the sending, 2026-11-15)', () => {
  const Z = 'Europe/Paris';
  const start = '2026-11-16T13:00:00Z'; // 14:00 Paris

  it('says the minutes while under an hour away', () => {
    expect(reminderWhen(start, '2026-11-16T12:45:10Z', Z)).toBe(
      m.notif_booking_reminder_in_minutes({ minutes: 15 })
    );
  });

  it('says whole hours inside six', () => {
    expect(reminderWhen(start, '2026-11-16T12:00:00Z', Z)).toBe(
      m.notif_booking_reminder_in_hours({ hours: 1 })
    );
  });

  it('says today at the time when it is later the same day and not a whole hour', () => {
    expect(reminderWhen(start, '2026-11-16T08:30:00Z', Z)).toBe(
      m.notif_booking_reminder_today_at({ time: '14:00' })
    );
  });

  it('says tomorrow at the time for a 24 h reminder', () => {
    expect(reminderWhen(start, '2026-11-15T13:00:00Z', Z)).toBe(
      m.notif_booking_reminder_tomorrow_at({ time: '14:00' })
    );
  });

  it('names the day when the start is further than tomorrow', () => {
    const text = reminderWhen('2026-11-20T13:00:00Z', '2026-11-15T13:00:00Z', Z);
    expect(text).toContain('14:00');
    expect(text).not.toBe(m.notif_booking_reminder_tomorrow_at({ time: '14:00' }));
  });

  it('judges days on the space clock', () => {
    // 23:30 UTC the 15th is already the 16th in Paris: a 14:00 slot is today.
    expect(reminderWhen(start, '2026-11-15T23:30:00Z', Z)).toBe(
      m.notif_booking_reminder_today_at({ time: '14:00' })
    );
  });

  it('is null for an unparseable instant or an unknown zone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(reminderWhen('x', start, Z)).toBeNull();
    expect(reminderWhen(start, '2026-11-15T13:00:00Z', 'Nowhere/Land')).toBeNull();
  });
});
