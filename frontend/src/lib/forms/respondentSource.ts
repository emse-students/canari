/**
 * WHERE AN ANSWER'S CURSUS CAME FROM - ONE RULE, READ BY THE EXPORT AND BY THE LIST (owner review,
 * 2026-11-21).
 *
 * An ANONYMOUS form may read a member's promo and formation from the account instead of asking them
 * (`respondent-identity.ts`); a guest still declares theirs. Certified and declared values are never
 * mixed silently in one column: once any answer carries a certified cursus, each row says which it is.
 *
 * THIS FILE IS COPIED, BYTE FOR BYTE, between the frontend and social-service, and the copy is
 * declared in `.github/scripts/lib/declared-duplicates.mjs` so a gate refuses the two drifting apart
 * (the arrangement of `formOptionRules.ts`: there is no TS library between `frontend/` and `apps/`).
 * It imports nothing: the two sides' `RespondentIdentity` types satisfy {@link SourcedIdentity}.
 */

/** The part of a stored `respondentIdentity` this rule reads. */
export interface SourcedIdentity {
  source: 'account' | 'declared';
  cursus?: readonly unknown[];
  /** The keys read from the account in a snapshot that also holds declared ones. */
  fromAccount?: readonly string[];
  /** The declared fields a build older than the questions could not send. */
  notDeclared?: readonly string[];
}

/** Where an answer's cursus came from: the account (certified), the respondent (declared), or none. */
export function cursusSourceOf(
  identity: SourcedIdentity | null | undefined
): 'account' | 'declared' | null {
  if (!identity) return null;
  if (identity.fromAccount?.includes('cursus')) return 'account';
  if (identity.cursus === undefined && !identity.notDeclared?.includes('cursus')) return null;
  return identity.source;
}

/**
 * Whether the list and the export say where the cursus came from: on an anonymous form, once any
 * answer carries one read from the account. A named form keeps its columns as they were.
 */
export function showsCursusSource(
  form: { anonymous?: boolean | null },
  rows: readonly { respondentIdentity?: SourcedIdentity | null }[]
): boolean {
  return (
    form.anonymous === true && rows.some((r) => cursusSourceOf(r.respondentIdentity) === 'account')
  );
}
