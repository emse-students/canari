import { intlLocale } from '$lib/bookings/grid';

/** What a booking notice's bell row says, once split (the server's `noticeRowText` layout). */
export interface BookingNoticeText {
  /** The space's name (empty on a space reached by its link only, Q-R5). */
  place: string;
  /** The organiser's word on a cancellation (Q-R3); empty when none. */
  word: string;
  /** The slot's start, an ISO instant. */
  startsAt: string;
}

/**
 * Splits a booking notice's `text`: three lines - place, word, slot start (UTC instant). A row
 * written before the slot was carried holds ONE line (a place or a word, which cannot be told
 * apart), so anything that is not three lines ending in a valid instant returns null and the caller
 * draws the text as it always did.
 */
export function parseBookingNoticeText(text: string): BookingNoticeText | null {
  const lines = text.split('\n');
  if (lines.length !== 3) return null;
  const [place, word, startsAt] = lines;
  if (Number.isNaN(new Date(startsAt).getTime())) return null;
  return { place, word, startsAt };
}

/** The slot's start in the reader's locale and clock: "mar. 3 nov., 10:00". */
export function formatNoticeSlot(startsAt: string): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(startsAt));
}
