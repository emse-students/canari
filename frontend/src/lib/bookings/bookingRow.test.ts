import { describe, expect, it } from 'vitest';
import { bookingWhen, reminderChip, resourcesLabel } from './bookingRow';
import { m } from '$lib/paraglide/messages';

const Z = 'Europe/Paris';
/** 2026-11-02 12:00 in Paris (UTC+1), the clock every case reads. */
const NOW = Date.parse('2026-11-02T11:00:00Z');
const at = (iso: string) => Date.parse(iso);

describe('bookingWhen', () => {
  it('says today, with the hours on the same line', () => {
    const s = at('2026-11-02T16:00:00Z');
    expect(bookingWhen(s, s + 3_600_000, Z, NOW)).toBe(
      `${m.bookings_week_today()} · 17:00 - 18:00`
    );
  });

  it('says tomorrow', () => {
    const s = at('2026-11-03T09:00:00Z');
    expect(bookingWhen(s, s + 3_600_000, Z, NOW)).toMatch(
      new RegExp(`^${m.bookings_upcoming_tomorrow()} · 10:00 - 11:00$`)
    );
  });

  it('writes the short date further away, never a long weekday', () => {
    const s = at('2026-11-12T13:25:00Z');
    const text = bookingWhen(s, s + 1_500_000, Z, NOW);
    expect(text).toContain('14:25 - 14:50');
    expect(text).not.toContain(m.bookings_week_today());
    expect(text).toMatch(/12/);
  });

  it('reads the day in the SPACE zone, not the device one', () => {
    // 23:30 UTC on the 2nd is 00:30 on the 3rd in Paris: tomorrow there.
    const s = at('2026-11-02T23:30:00Z');
    expect(bookingWhen(s, s + 1_800_000, Z, NOW).startsWith(m.bookings_upcoming_tomorrow())).toBe(
      true
    );
  });
});

describe('reminderChip', () => {
  const start = at('2026-11-02T16:00:00Z'); // 17:00 Paris, today at NOW
  it('is the time alone when it fires on the booking day', () => {
    expect(reminderChip(start, 60, Z, NOW, null)).toBe('16:00');
  });
  it('is null without a reminder', () => {
    expect(reminderChip(start, null, Z, NOW, null)).toBeNull();
  });
  it('says Tomorrow for a day-before reminder of a booking in two days', () => {
    const s = at('2026-11-04T13:00:00Z'); // 14:00 on the 4th
    expect(reminderChip(s, 1440, Z, NOW, null)).toBe(
      m.bookings_row_reminder_tomorrow({ time: '14:00' })
    );
  });
  it('says Today for a day-before reminder still to fire today', () => {
    const s = at('2026-11-03T13:00:00Z'); // 14:00 tomorrow, reminder 14:00 today
    expect(reminderChip(s, 1440, Z, NOW, null)).toBe(
      m.bookings_row_reminder_today({ time: '14:00' })
    );
  });
  it('names the weekday when the reminder is further away', () => {
    const s = at('2026-11-12T13:00:00Z');
    const chip = reminderChip(s, 1440, Z, NOW, null);
    expect(chip).toMatch(/14:00$/);
    expect(chip).not.toBe('14:00');
    expect(chip).toContain(' ');
  });
  it('is hidden once the reminder was sent, or its instant has passed', () => {
    const s = at('2026-11-03T13:00:00Z');
    expect(reminderChip(s, 1440, Z, NOW, at('2026-11-02T13:00:00Z'))).toBeNull();
    expect(reminderChip(start, 60, Z, at('2026-11-02T15:30:00Z'), null)).toBeNull();
  });
});

describe('resourcesLabel', () => {
  it('says nothing for one column (D44) and counts from two', () => {
    expect(resourcesLabel(1)).toBeNull();
    expect(resourcesLabel(3)).toBe(m.bookings_row_resources({ count: 3 }));
  });
});
