/**
 * THE SENTENCE A READER SEES FOR A REFUSED BOOKINGS CALL: the organiser's (WP-B4) and the booker's
 * (WP-B5).
 *
 * Chosen from the refusal's CODE, which the server types at the throw (docs/wiki/bookings-chantier.md,
 * "WP-B4 as built"), then from its status, then a generic line - never from the server's message,
 * which is dev-facing English.
 */
import { m } from '$lib/paraglide/messages';
import { describeApiRefusal, refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { BookingsApiError } from './api';

/** Every code the organiser's routes answer, each with its sentence. */
export const ORGANISER_REFUSAL_CODES = [
  'not-manager',
  'space-not-found',
  'resource-not-found',
  'time-zone',
  'step-shape',
  'slot-shape',
  'quota-pair',
  'export-labels',
  'item-id',
  'audience-invalid',
  'unknown-account',
  'line-kind',
  'line-date',
  'line-order',
  'exception-range',
  'bookings-inside-change',
  'resource-has-bookings',
  'too-many-spaces',
  'too-many-resources',
  'association-not-found',
  'opens-at',
  'poster-not-yours',
] as const;

export type OrganiserRefusalCode = (typeof ORGANISER_REFUSAL_CODES)[number];

/** Every code the booker's routes answer (WP-B3), each with its sentence. */
export const BOOKER_REFUSAL_CODES = [
  'audience',
  'slot-range',
  'range',
  'answer-required',
  'holder-is-participant',
  'space-changed',
  'too-many-people',
  'outside-availability',
  'misaligned',
  'too-many-steps',
  'not-open-yet',
  'started',
  'notice',
  'beyond-horizon',
  'blocked',
  'participant-blocked',
  'active-bookings',
  'minutes-per-period',
  'slot-taken',
  'try-again',
  'booking-not-found',
  'not-yours',
  'already-cancelled',
  'history-frozen',
  'not-a-participant',
  'withdrawal-delay',
  'bookings-inside-block',
  'block-not-found',
  'block-overlap',
  'file-question',
  'file-empty',
  'file-too-large',
  'file-type',
  'files-pending',
  'files-pending-account',
  'file-not-yours',
  'file-answer',
  'file-not-found',
  'file-purged',
] as const;

export type BookerRefusalCode = (typeof BOOKER_REFUSAL_CODES)[number];

function sentenceFor(code: string, count: number): string | null {
  switch (code) {
    case 'not-manager':
      return m.bookings_refusal_not_manager();
    case 'space-not-found':
      return m.bookings_refusal_space_not_found();
    case 'resource-not-found':
      return m.bookings_refusal_resource_not_found();
    case 'time-zone':
      return m.bookings_refusal_time_zone();
    case 'step-shape':
      return m.bookings_refusal_step_shape();
    case 'slot-shape':
      return m.bookings_refusal_slot_shape();
    case 'quota-pair':
      return m.bookings_refusal_quota_pair();
    case 'export-labels':
      return m.bookings_refusal_export();
    case 'item-id':
    case 'audience-invalid':
      return m.bookings_refusal_questions();
    case 'unknown-account':
      return m.bookings_refusal_unknown_account();
    case 'line-kind':
    case 'line-date':
    case 'line-order':
      return m.bookings_refusal_line();
    case 'exception-range':
      return m.bookings_refusal_closure();
    case 'bookings-inside-change':
      return m.bookings_refusal_inside_change({ count });
    case 'resource-has-bookings':
      return m.bookings_refusal_resource_has_bookings();
    case 'too-many-spaces':
      return m.bookings_refusal_too_many_spaces();
    case 'too-many-resources':
      return m.bookings_refusal_too_many_resources();
    case 'association-not-found':
      return m.bookings_refusal_association_not_found();
    case 'opens-at':
      return m.bookings_refusal_opens_at();
    case 'poster-not-yours':
      return m.bookings_refusal_poster_not_yours();
    default:
      return bookerSentenceFor(code, count);
  }
}

function bookerSentenceFor(code: string, count: number): string | null {
  switch (code) {
    case 'audience':
      return m.bookings_refusal_audience();
    case 'slot-range':
      return m.bookings_refusal_slot_range();
    case 'range':
    case 'outside-availability':
    case 'misaligned':
      return m.bookings_refusal_not_offered();
    case 'answer-required':
      return m.bookings_refusal_answer_required();
    case 'holder-is-participant':
      return m.bookings_refusal_holder_is_participant();
    case 'space-changed':
      return m.bookings_refusal_space_changed();
    case 'too-many-people':
      return m.bookings_refusal_too_many_people();
    case 'too-many-steps':
      return m.bookings_refusal_too_many_steps();
    case 'not-open-yet':
      return m.bookings_refusal_not_open_yet();
    case 'started':
      return m.bookings_refusal_started();
    case 'notice':
      return m.bookings_refusal_notice();
    case 'beyond-horizon':
      return m.bookings_refusal_beyond_horizon();
    case 'blocked':
      return m.bookings_refusal_blocked();
    case 'participant-blocked':
      return m.bookings_refusal_participant_blocked();
    case 'active-bookings':
      return m.bookings_refusal_active_bookings();
    case 'minutes-per-period':
      return m.bookings_refusal_minutes_per_period();
    case 'slot-taken':
      return m.bookings_refusal_slot_taken();
    case 'try-again':
      return m.bookings_refusal_try_again();
    case 'booking-not-found':
      return m.bookings_refusal_booking_not_found();
    case 'not-yours':
      return m.bookings_refusal_not_yours();
    case 'already-cancelled':
      return m.bookings_refusal_already_cancelled();
    case 'history-frozen':
      return m.bookings_refusal_history_frozen();
    case 'not-a-participant':
      return m.bookings_refusal_not_a_participant();
    case 'withdrawal-delay':
      return m.bookings_refusal_withdrawal_delay();
    case 'bookings-inside-block':
      return m.bookings_refusal_inside_block({ count });
    case 'block-not-found':
      return m.bookings_refusal_block_not_found();
    case 'block-overlap':
      return m.bookings_refusal_block_overlap();
    default:
      return fileSentenceFor(code);
  }
}

/** A FILE answer's refusals (WP-B6): its upload, its citation in a booking, its download. */
function fileSentenceFor(code: string): string | null {
  switch (code) {
    // The question is no longer a FILE question: the space changed under the open sheet.
    case 'file-question':
      return m.bookings_refusal_space_changed();
    case 'file-empty':
      return m.bookings_refusal_file_empty();
    case 'file-too-large':
      return m.form_file_error_size();
    case 'file-type':
      return m.form_file_error_type();
    case 'files-pending':
      return m.bookings_refusal_files_pending();
    case 'files-pending-account':
      return m.bookings_refusal_files_pending_account();
    // A file id this booking may not cite (not the uploader's, another question's, over a day old)
    // or an answer that is not a file id: either way the file has to be picked again.
    case 'file-not-yours':
    case 'file-answer':
      return m.bookings_refusal_file_not_yours();
    case 'file-not-found':
      return m.bookings_refusal_file_not_found();
    case 'file-purged':
      return m.form_answer_file_deleted();
    default:
      return null;
  }
}

/**
 * Whether a failed WRITE may still have been written: nobody answered (a transport failure, an
 * abort), or a 5xx came back with no code (a gateway timeout, a crash after the commit). A 4xx is
 * a refusal whatever its body - a validation 400 with no code included - so nothing was written.
 */
export function outcomeUnknown(error: unknown): boolean {
  const status = refusalStatus(error);
  return status === null || (status >= 500 && refusalCode(error) === null);
}

/**
 * What a refused bookings call reads as. `action` names the gesture for the status-only
 * sentences ("Enregistrer", "Supprimer"), as `describeApiRefusal` words them.
 */
export function describeBookingRefusal(error: unknown, action: string): string {
  const code = refusalCode(error);
  const count = error instanceof BookingsApiError ? error.bookingIds.length : 0;
  return (
    (code ? sentenceFor(code, count) : null) ??
    describeApiRefusal(refusalStatus(error), action) ??
    m.common_generic_error_label()
  );
}
