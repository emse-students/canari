/**
 * THE BOOKER'S THREE DESTRUCTIVE GESTURES, ONE IMPLEMENTATION EACH (WP-B5): cancel a booking, leave
 * one, lift a block. The page of a space and the Reservations page both offer them; each asks first,
 * calls, and says the outcome - a refusal worded from its CODE (`describeBookingRefusal`).
 */
import type { AgendaExportEvent } from '$lib/calendar/agendaExport';
import { m } from '$lib/paraglide/messages';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { socialUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { downloadDecryptedFile } from '$lib/utils/fileDownload';
import {
  bookingExportLabels,
  calendarLink,
  cancelBooking,
  exportBookings,
  removeBlock,
  withdrawBooking,
} from './api';
import { describeBookingRefusal } from './refusals';

/** Asks, then runs `act`; `true` once it is done, `false` when declined or refused (said). */
async function confirmed(
  what: string,
  question: string,
  confirmLabel: string,
  act: () => Promise<unknown>,
  done: string
): Promise<boolean> {
  if (!(await showConfirm(question, { danger: true, confirmLabel }))) return false;
  try {
    await act();
    Log.i('BOOKINGS', `${what} done`);
    showToast(done, 'info');
    return true;
  } catch (e) {
    Log.i('BOOKINGS', `${what} failed: ${String(e)}`);
    showToast(describeBookingRefusal(e, confirmLabel), 'error');
    return false;
  }
}

/**
 * The holder or the organiser cancels a coming booking (D5). `byOrganiser` says the cost D13
 * names: the holder is not told, they find out by coming back.
 */
export function cancelWithConfirm(bookingId: string, byOrganiser: boolean): Promise<boolean> {
  return confirmed(
    'cancel',
    byOrganiser ? m.bookings_cancel_confirm_organiser() : m.bookings_cancel_confirm(),
    m.bookings_cancel_action(),
    () => cancelBooking(bookingId),
    m.bookings_cancel_done()
  );
}

/** A participant leaves a booking, which stays the holder's (D4, D5). */
export function withdrawWithConfirm(bookingId: string): Promise<boolean> {
  return confirmed(
    'withdraw',
    m.bookings_withdraw_confirm(),
    m.bookings_withdraw_action(),
    () => withdrawBooking(bookingId),
    m.bookings_withdraw_done()
  );
}

/** Lifts an "Indisponible" that has not ended (D20). */
export function liftBlockWithConfirm(blockId: string): Promise<boolean> {
  return confirmed(
    'removeBlock',
    m.bookings_block_lift_confirm(),
    m.bookings_block_lift_action(),
    () => removeBlock(blockId),
    m.bookings_block_lift_done()
  );
}

/** A booking as "Add to my calendar" reads it (D13); its hosted file comes from {@link bookingIcsUrl}. */
export function bookingCalendarEvent(
  booking: { id: string; startsAt: string; endsAt: string },
  title: string
): AgendaExportEvent {
  return { id: `booking-${booking.id}`, title, startsAt: booking.startsAt, endsAt: booking.endsAt };
}

/**
 * The hosted `.ics` of a booking, signed for the reader (`calendarLink`), asked for on the tap that
 * needs it - never once per card on screen - and handed by a phone to its calendar app.
 */
export async function bookingIcsUrl(bookingId: string): Promise<string> {
  Log.d('BOOKINGS', `calendar link asked booking=${bookingId.slice(0, 8)}`);
  const { path } = await calendarLink(bookingId);
  return `${socialUrl()}${path}`;
}

/**
 * The space's bookings as an .xlsx (D24), its columns in this client's words, saved under the
 * space's name. One implementation for the editor and the dashboard (WP-R5); a refusal is thrown
 * for the caller to word.
 */
export async function downloadSpaceExport(space: { id: string; name: string }): Promise<void> {
  const blob = await exportBookings(space.id, bookingExportLabels());
  await downloadDecryptedFile(blob, `${space.name.replace(/[\\/:*?"<>|]+/g, '_')}.xlsx`);
  Log.i('BOOKINGS', `export downloaded space=${space.id.slice(0, 8)}`);
}
