import { CAMPUSES, FORMATIONS, type Campus } from '../users/miconnect-profile';
import { isInReviewCohort } from '../review-cohort';

/**
 * WHO IS OFFERED THE PROFILE-PHOTO PROMPT - TEMPORARY (owner, 2026-11-10): for now only the accounts
 * whose space is ICM at Saint-Etienne. The set is the runtime variable `PROFILE_PHOTO_PROMPT_SPACES`,
 * read here and handed to the client as a boolean in the `help-seen` answer, so widening it is an
 * environment change and not a release. Delete this module, its variable and its manifest row the
 * day the prompt opens to everyone (docs/wiki/frontend/guided-help.md).
 *
 * THE VOCABULARY IS THE SPACES' OWN: a space is a `formation x campus` pair, the formation spelled
 * as `users.cursus` and `spaces.formation` spell it (`FORMATIONS`) and the campus as `users.campus`
 * does (`CAMPUSES`, a lower-case slug). The variable is a comma-separated list of `FORMATION:campus`,
 * for example `ICM:saint-etienne`. An account is in a space by the same rule `readerSpaces`
 * (social-service) states: its campus is the pair's and one of its cursus formations is the pair's;
 * a review-cohort account has no space.
 *
 * UNSET OR EMPTY IS NOBODY. A VALUE THAT DOES NOT PARSE IS NOBODY TOO, AND LOUDLY: a typo must never
 * widen the prompt, so the parse reports the entry it refused and the boot logs it as an error.
 */

/** The environment variable holding the eligible spaces. */
export const PROFILE_PHOTO_PROMPT_SPACES_ENV = 'PROFILE_PHOTO_PROMPT_SPACES';

/** One eligible space. */
export interface PromptSpace {
  formation: string;
  campus: Campus;
}

/** What the variable resolved to: the spaces, and the entries that were refused. */
export interface PromptSpaces {
  spaces: PromptSpace[];
  /** Empty when the value parsed whole. A non-empty list means `spaces` is empty: nobody. */
  invalid: string[];
}

/** Parses the variable. Any refused entry voids the whole value: a half-read list is a guess. */
export function parsePromptSpaces(raw: string | undefined): PromptSpaces {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const spaces: PromptSpace[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const parts = entry.split(':');
    const formation = FORMATIONS.find((f) => f === parts[0]);
    const campus = CAMPUSES.find((c) => c === parts[1]);
    if (parts.length === 2 && formation && campus) spaces.push({ formation, campus });
    else invalid.push(entry);
  }
  return invalid.length > 0 ? { spaces: [], invalid } : { spaces, invalid };
}

/** The profile facts eligibility reads, as `users` stores them. */
export interface PromptProfile {
  id: string;
  campus?: string | null;
  cursus?: unknown;
}

/** Whether the account is in one of `spaces`. No campus, no cursus or a review account: no. */
export function isPromptEligible(
  profile: PromptProfile | null,
  spaces: readonly PromptSpace[]
): boolean {
  if (!profile || spaces.length === 0 || isInReviewCohort(profile.id)) return false;
  if (!profile.campus || !Array.isArray(profile.cursus)) return false;
  const formations = new Set(
    (profile.cursus as unknown[])
      .map((e) => (e && typeof e === 'object' ? (e as { formation?: unknown }).formation : null))
      .filter((f): f is string => typeof f === 'string')
  );
  return spaces.some((s) => s.campus === profile.campus && formations.has(s.formation));
}
