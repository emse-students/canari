import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { describeApiRefusal } from '$lib/utils/apiRefusal';
import {
  CO_ORGANISER_CAP_CODE,
  MAX_CO_ORGANISERS,
  MAX_ORGANISING_ASSOCIATIONS,
} from '$lib/calendar/coOrganiserCap';
import {
  INSTITUTION_REACH_INVALID,
  INSTITUTION_REACH_NOT_OFFERED,
  INSTITUTION_REACH_OUTSIDE_AUDIENCE,
  INSTITUTION_REACH_REQUIRED,
} from '$lib/posts/institutionReach';

/**
 * The sentence a calendar write's refusal reads as, chosen from the server's CODE.
 *
 * `endsAt must be after startsAt` reached a French reader verbatim: the global agenda's deposit
 * modal did `e instanceof Error ? e.message : <fallback>`, and `request()` throws with the server's
 * text, so the English won every time and the localized half was dead code. The association page's
 * own modal had the opposite failure - it showed "Impossible d'enregistrer" for all three date
 * refusals, so the reader was told something went wrong and never which rule they broke.
 *
 * One implementation for both, because they call the SAME two endpoints and a second copy is how
 * one of them comes to translate a code the other does not.
 *
 * **A code nobody has translated yet reads as the generic line, never as the server's English.**
 * That is the half that closes the defect rather than the three sentences: translating the known
 * codes fixes three messages, refusing to print `.message` is what stops the fourth.
 */
const BY_CODE: Record<string, () => string> = {
  CALENDAR_INVALID_START: m.calendar_error_invalid_start,
  CALENDAR_INVALID_END: m.calendar_error_invalid_end,
  CALENDAR_END_BEFORE_START: m.calendar_error_end_before_start,
  CALENDAR_PARTNER_ORGANISER_ONLY: m.calendar_error_partner_organiser_only,
  CALENDAR_NEUTRAL_NOT_A_BDE: m.calendar_error_neutral_not_a_bde,
  CALENDAR_NEUTRAL_NO_PARTNERS: m.calendar_error_neutral_no_partners,
  CALENDAR_NEUTRAL_NO_FORM: m.calendar_error_neutral_no_form,
  CALENDAR_NEUTRAL_LINKED_POST: m.calendar_error_neutral_linked_post,
  // An institution's reach (owner, 2026-11-13): the posts' four codes, an event's sentences.
  [INSTITUTION_REACH_REQUIRED]: m.event_reach_required,
  [INSTITUTION_REACH_NOT_OFFERED]: m.event_reach_not_offered,
  [INSTITUTION_REACH_INVALID]: m.event_reach_invalid,
  [INSTITUTION_REACH_OUTSIDE_AUDIENCE]: m.event_reach_outside_audience,
  [CO_ORGANISER_CAP_CODE]: () =>
    m.calendar_error_coorganiser_cap({
      total: MAX_ORGANISING_ASSOCIATIONS,
      others: MAX_CO_ORGANISERS,
    }),
};

/**
 * Maps a thrown calendar-write error to a localized sentence.
 *
 * THREE STEPS, MOST PRECISE FIRST. A CODE beats a STATUS beats the caller's generic line, because
 * each says strictly less than the one before it: `CALENDAR_END_BEFORE_START` names the rule the
 * reader broke, a 403 names only that they may not do this at all, and the fallback names nothing.
 *
 * The middle step is new (2026-09-15) and it is the one the defect was about. Depositing an event
 * without the right grant answers 403 from `global-admin-or-association-role.guard.ts`, whose bare
 * `ForbiddenException` carries NO code - so this mapper fell straight through to "Erreur lors de la
 * sauvegarde", and a refusal the reader could have acted on was indistinguishable from a server
 * fault they could not. The status was in the response all along and `request()` was discarding it.
 */
export function calendarErrorMessage(e: unknown, fallback: () => string): string {
  const refusal = e instanceof SocialApiError ? e : null;
  const known = refusal?.code == null ? undefined : BY_CODE[refusal.code];
  if (known) return known();
  return describeApiRefusal(refusal?.status, m.calendar_action_deposit()) ?? fallback();
}
