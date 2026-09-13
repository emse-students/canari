import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';

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
};

/** Maps a thrown calendar-write error to a localized sentence. */
export function calendarErrorMessage(e: unknown, fallback: () => string): string {
  const code = e instanceof SocialApiError ? e.code : null;
  const known = code === null ? undefined : BY_CODE[code];
  return (known ?? fallback)();
}
