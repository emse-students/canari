/**
 * THE REMINDER DELAY A PERSON PICKS (WP-N, D53, Q-R1): a few presets in the reader's words, "no
 * reminder" included. The server takes any whole number of minutes from 5 to a week
 * (`ReminderDto`); the screens offer the presets the mockups draw (#2579: settings, booking sheet),
 * plus the current value when it is none of them, so a choice made elsewhere is never shown as
 * another. The mockup's "la veille a 18:00" is a wall-clock time and not a delay: 24 h stands in.
 */
import { m } from '$lib/paraglide/messages';

/** The offered delays, in minutes, shortest first. */
export const REMINDER_PRESETS = [15, 60, 1440] as const;

/** A `Select` value for `null` ("no reminder"): a value must be a string, and `''` reads as unset. */
export const NO_REMINDER = 'none';

/** One delay in the reader's words: "15 min avant", "1 h avant", "La veille", "Pas de rappel". */
export function reminderLabel(minutes: number | null): string {
  if (minutes === null) return m.bookings_reminder_none();
  if (minutes === 1440) return m.bookings_reminder_day_before();
  if (minutes % 60 === 0) return m.bookings_reminder_hours({ hours: minutes / 60 });
  return m.bookings_reminder_minutes({ minutes });
}

/** The `Select` options for a field whose value is `current`. */
export function reminderOptions(current: number | null): { value: string; label: string }[] {
  const values: (number | null)[] = [...REMINDER_PRESETS];
  if (current !== null && !values.includes(current)) {
    values.push(current);
    values.sort((a, b) => (a ?? 0) - (b ?? 0));
  }
  values.push(null);
  return values.map((v) => ({ value: reminderValue(v), label: reminderLabel(v) }));
}

/** A delay as a `Select` value. */
export function reminderValue(minutes: number | null): string {
  return minutes === null ? NO_REMINDER : String(minutes);
}

/** A `Select` value back to a delay; anything unreadable is "no reminder", never a guess. */
export function reminderFromValue(value: string): number | null {
  if (value === NO_REMINDER || !/^\d+$/.test(value)) return null;
  return Number(value);
}
