/**
 * WHO ANSWERED A FORM, FOR A GROUP MADE OF THEM (owner, 2026-11-19, wiki forms.md "A group made
 * from a form's respondents").
 *
 * The button on the responses screen only FILLS the member picker; it grants no power a manual add
 * does not. What it refuses is decided HERE, on the server, so a client that draws the button
 * anyway gets nothing: an anonymous form would reveal who answered (charter, principle 1), and a
 * public form's guest has no account to add.
 */

/** The form is anonymous: a group of its respondents would name who answered. */
export const FORM_RESPONDENTS_ANONYMOUS = 'FORM_RESPONDENTS_ANONYMOUS';
/** The form is public: a guest has no account, so the people it names are not all addable. */
export const FORM_RESPONDENTS_PUBLIC = 'FORM_RESPONDENTS_PUBLIC';

/** The payment statuses of an answer that was never kept: its author is not a respondent. */
const NOT_ANSWERED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'expired']);

/** The refusal code of a form whose respondents may not be listed, or null when they may. */
export function respondentGroupRefusal(form: {
  anonymous: boolean;
  isPublic: boolean;
}): typeof FORM_RESPONDENTS_ANONYMOUS | typeof FORM_RESPONDENTS_PUBLIC | null {
  if (form.anonymous) return FORM_RESPONDENTS_ANONYMOUS;
  if (form.isPublic) return FORM_RESPONDENTS_PUBLIC;
  return null;
}

/**
 * The distinct accounts that answered, in first-answer order: an abandoned or expired answer is not
 * one, a guest row (no account) names nobody, and one person who answered twice counts once.
 */
export function respondentIds(
  rows: readonly { userId: string | null; paymentStatus: string }[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.userId || NOT_ANSWERED_STATUSES.has(row.paymentStatus)) continue;
    ids.add(row.userId);
  }
  return [...ids];
}
