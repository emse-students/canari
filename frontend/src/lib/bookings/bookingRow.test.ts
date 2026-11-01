import { describe, expect, it } from 'vitest';
import { bookingWhen, reminderTime, resourcesLabel } from './bookingRow';
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

describe('reminderTime', () => {
  it('is the wall time the reminder fires, in the space zone', () => {
    expect(reminderTime(at('2026-11-02T16:00:00Z'), 60, Z)).toBe('16:00');
  });
  it('is null without a reminder', () => {
    expect(reminderTime(at('2026-11-02T16:00:00Z'), null, Z)).toBeNull();
  });
});

describe('resourcesLabel', () => {
  it('says nothing for one column (D44) and counts from two', () => {
    expect(resourcesLabel(1)).toBeNull();
    expect(resourcesLabel(3)).toBe(m.bookings_row_resources({ count: 3 }));
  });
});
