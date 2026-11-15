import { intlLocale } from '$lib/utils/intlLocale';
import { m } from '$lib/paraglide/messages';
import { addDays, localDate, localTime } from '$lib/bookings/zonedTime';

/** The structured facts of a booking notice (`post_notifications.meta`, migration 117). */
export interface BookingNoticeMeta {
  /** The place, as `bookingPlace` names it: the space and the resource (empty on a link-only space, Q-R5). */
  place: string;
  /** The slot's start, an ISO instant. */
  startsAt: string;
  /** The space's IANA zone: the slot is drawn on ITS clock (D25), as the reminder is. */
  timeZone: string;
  /** The organiser's word on a cancellation (Q-R3); empty when none. */
  word: string;
  /** A reminder's chosen delay in minutes (absent on every other notice and on older reminders). */
  reminderMinutes?: number;
}

/**
 * Reads a notice's `meta` as booking facts, or null when it is absent (a row written before the
 * column, every other type) or not of that shape - the caller then draws the row as it always did.
 * Nothing is ever read out of the row's `text` (the word, else the place: what older clients draw).
 */
export function readBookingNoticeMeta(meta: unknown): BookingNoticeMeta | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const { place, startsAt, timeZone, word } = meta as Record<string, unknown>;
  if (typeof place !== 'string' || typeof startsAt !== 'string' || typeof timeZone !== 'string') {
    return null;
  }
  if (typeof word !== 'string') return null;
  if (Number.isNaN(new Date(startsAt).getTime())) return null;
  const delay = (meta as Record<string, unknown>).reminderMinutes;
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0
    ? { place, startsAt, timeZone, word, reminderMinutes: delay }
    : { place, startsAt, timeZone, word };
}

/**
 * The slot's start in the reader's language on the SPACE's clock: "mar. 3 nov., 10:00". Null when
 * the zone is not one the runtime knows, so a wrong day or hour is never shown for a right one.
 */
export function formatNoticeSlot(startsAt: string, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat(intlLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(new Date(startsAt));
  } catch (e) {
    console.warn(`[BOOKINGS] notice slot not drawn, zone "${timeZone}" refused: ${String(e)}`);
    return null;
  }
}

/**
 * THE REMINDER'S SENTENCE, said as of the moment it was SENT (the row's `createdAt`), never as of
 * the moment it is read: "commence dans 15 min" / "dans 1 h" while the start is under an hour away
 * or a whole number of hours inside six, else the space's own day - "aujourd'hui", "demain", or the
 * weekday - and the time. Every branch is true at send time, which is the only instant the delay
 * is known. Pure: both instants are arguments, so no test reads a clock.
 *
 * @returns null when the zone is not one the runtime knows (the caller then draws the old
 *   sentence and logs it), so a wrong hour is never shown for a right one.
 */
export function reminderWhen(
  startsAt: string,
  sentAt: string,
  timeZone: string,
  delayMinutes?: number
): string | null {
  const startMs = Date.parse(startsAt);
  const sentMs = Date.parse(sentAt);
  if (Number.isNaN(startMs) || Number.isNaN(sentMs)) return null;
  try {
    // The chosen delay when the row carries it; else the measured gap snapped to 5 min, because
    // the cron sends 0-60 s late and the raw gap would flip "dans 1 h" to "dans 59 min".
    const measured = Math.max(1, Math.round((startMs - sentMs) / 60_000));
    const minutes = delayMinutes ?? (measured < 5 ? measured : Math.round(measured / 5) * 5);
    if (minutes < 60) return m.notif_booking_reminder_in_minutes({ minutes });
    if (minutes <= 360 && minutes % 60 === 0) {
      return m.notif_booking_reminder_in_hours({ hours: minutes / 60 });
    }
    const time = localTime(startMs, timeZone);
    const day = localDate(startMs, timeZone);
    const today = localDate(sentMs, timeZone);
    if (day === today) return m.notif_booking_reminder_today_at({ time });
    if (day === addDays(today, 1)) return m.notif_booking_reminder_tomorrow_at({ time });
    const [y, mo, d] = day.split('-').map(Number);
    const label = new Intl.DateTimeFormat(intlLocale(), {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(Date.UTC(y, mo - 1, d)));
    return m.notif_booking_reminder_day_at({ day: label, time });
  } catch (e) {
    console.warn(
      `[BOOKINGS] reminder sentence not drawn, zone "${timeZone}" refused: ${String(e)}`
    );
    return null;
  }
}
