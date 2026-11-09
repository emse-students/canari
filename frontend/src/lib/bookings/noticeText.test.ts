import { describe, it, expect, vi } from 'vitest';
import { formatNoticeSlot, readBookingNoticeMeta } from './noticeText';

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
