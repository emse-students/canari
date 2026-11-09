import { failedCriterion, type AudienceCondition, type PricingFacts } from '../pricing/audience';

/**
 * The `code` of the 403 a submission (or a file upload) gets when the form's `submitCondition`
 * excludes the person, for any criterion but the one below. Also what `GET /forms/:id/check`
 * reports as `refusalCode`, so the page and the refusal are one fact.
 */
export const FORM_NOT_OPEN_TO_YOU = 'FORM_NOT_OPEN_TO_YOU';

/**
 * The `code` of the same 403 when what excludes the person is a `notCotisation` criterion: they
 * already hold the cotisation the form is reserved to people WITHOUT (owner, 2026-10-30 - nobody
 * pays a cotisation twice). Typed apart because it is the one refusal the page words as an answer
 * ("you already hold it") rather than a wall. The client words it through Paraglide.
 */
export const FORM_COTISATION_HELD = 'FORM_COTISATION_HELD';

export type SubmitRefusalCode = typeof FORM_NOT_OPEN_TO_YOU | typeof FORM_COTISATION_HELD;

/**
 * Why `submitCondition` refuses this person, as a typed code, or null when it admits them (or
 * there is none). Classified HERE, from the criterion that failed, so neither the 403 nor the page
 * ever reads a reason back out of a sentence.
 */
export function submitRefusalCode(
  condition: AudienceCondition | null | undefined,
  facts: PricingFacts
): SubmitRefusalCode | null {
  if (!condition) return null;
  const failed = failedCriterion(condition, facts);
  if (failed === null) return null;
  return failed === 'notCotisation' ? FORM_COTISATION_HELD : FORM_NOT_OPEN_TO_YOU;
}
