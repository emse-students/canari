/**
 * THE SENTENCE AN ORGANISER READS FOR A REFUSED BOOKINGS CALL (WP-B4).
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
  'quota-pair',
  'file-question-not-yet',
  'item-id',
  'audience-invalid',
  'unknown-account',
  'line-kind',
  'line-date',
  'line-order',
  'exception-range',
  'bookings-inside-change',
] as const;

export type OrganiserRefusalCode = (typeof ORGANISER_REFUSAL_CODES)[number];

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
    case 'quota-pair':
      return m.bookings_refusal_quota_pair();
    case 'file-question-not-yet':
      return m.bookings_refusal_file_question();
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
    default:
      return null;
  }
}

/**
 * What a refused organiser call reads as. `action` names the gesture for the status-only
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
