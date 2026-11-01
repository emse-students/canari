import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  NO_REMINDER,
  reminderFromValue,
  reminderLabel,
  reminderOptions,
  reminderValue,
} from './reminder';

describe('the reminder delay (WP-N, Q-R1)', () => {
  it('offers the presets and "no reminder", last', () => {
    expect(reminderOptions(60).map((o) => o.value)).toEqual(['15', '60', '1440', NO_REMINDER]);
  });

  it('keeps a value set elsewhere among the options, in order', () => {
    expect(reminderOptions(120).map((o) => o.value)).toEqual([
      '15',
      '60',
      '120',
      '1440',
      NO_REMINDER,
    ]);
  });

  it('words each delay', () => {
    expect(reminderLabel(null)).toBe(m.bookings_reminder_none());
    expect(reminderLabel(1440)).toBe(m.bookings_reminder_day_before());
    expect(reminderLabel(60)).toBe(m.bookings_reminder_hours({ hours: 1 }));
    expect(reminderLabel(15)).toBe(m.bookings_reminder_minutes({ minutes: 15 }));
  });

  it('round-trips a value, and reads anything else as no reminder', () => {
    for (const v of [15, 60, null]) expect(reminderFromValue(reminderValue(v))).toBe(v);
    expect(reminderFromValue('x')).toBeNull();
  });
});
