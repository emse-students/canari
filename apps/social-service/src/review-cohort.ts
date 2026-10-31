/**
 * THE REVIEW COHORT: THE STORE REVIEWERS' ACCOUNTS, AND THE ONE RULE THAT KEEPS THEM APART.
 *
 * Google Play and Apple review the app by signing in with accounts the team gives them. Those
 * accounts are a COHORT that shares a world of its own: a review account and a member never see
 * each other. A member never finds a review account (search, directory), never reads what one
 * writes (posts, lives) and never lists what one owns (booking spaces); a review account finds,
 * reads and lists only the cohort's own, whatever profile its identity provider hands it. A global
 * admin finds review accounts in the directory, so the team can reach them; browsing, an admin is a
 * reader like any other. The decision and its surfaces: docs/wiki/profiles-and-access.md.
 *
 * WHERE THE IDS COME FROM. `SERVICE_ACCOUNT_USER_ID`, a GitHub secret rendered into core-service
 * and social-service: a comma-separated list of user ids. The name predates the cohort (it held
 * ONE id until 2026-10-31); a one-id value is a one-member cohort, so the old value stays valid.
 * Empty means no cohort and no restriction.
 *
 * AN ENTRY THAT IS NOT A USER ID IS A CONFIGURATION ERROR, AND IT THROWS. The ids are inlined into
 * SQL, so only lower-case hex is accepted (a user id is the hex digest of the identity provider's
 * subject). Dropping a bad entry would leave that review account visible to every member with no
 * sign of it; refusing to start is the loud answer, and the deploy's health check reports it.
 *
 * BYTE-IDENTICAL in core-service and social-service (`.github/scripts/lib/declared-duplicates.mjs`):
 * there is no shared TS package, and both services must agree on who is in the cohort. The spec
 * beside the core-service copy proves both. It reads the environment on every call, so a test can
 * set it, and imports nothing, so the copies can stay identical.
 */

/** The environment variable holding the cohort, comma-separated. */
export const REVIEW_COHORT_ENV = 'SERVICE_ACCOUNT_USER_ID';

const USER_ID = /^[0-9a-f]{1,128}$/;

/** Thrown when `SERVICE_ACCOUNT_USER_ID` holds something that is not a list of user ids. */
export class ReviewCohortConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewCohortConfigError';
  }
}

/**
 * The cohort a raw `SERVICE_ACCOUNT_USER_ID` value names: distinct ids, in the order given. Blank
 * entries around commas are ignored; any other entry that is not lower-case hex throws, naming its
 * POSITION and never its text (the value is a secret).
 */
export function parseReviewCohort(raw: string | undefined): readonly string[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];
  const ids: string[] = [];
  trimmed.split(',').forEach((entry, index) => {
    const id = entry.trim();
    if (id === '') return;
    if (!USER_ID.test(id)) {
      throw new ReviewCohortConfigError(
        `${REVIEW_COHORT_ENV} entry ${index + 1} is not a lower-case hex user id`
      );
    }
    if (!ids.includes(id)) ids.push(id);
  });
  return ids;
}

/** The cohort this process runs with, read from the environment now. */
export function reviewCohort(): readonly string[] {
  return parseReviewCohort(process.env[REVIEW_COHORT_ENV]);
}

/** Whether `userId` is a review account. An absent id is not. */
export function isInReviewCohort(userId: string | undefined | null): boolean {
  return !!userId && reviewCohort().includes(userId);
}

/**
 * A SQL boolean: the user id the expression `idExpr` yields is a review account. The ids are
 * inlined, which `parseReviewCohort` makes safe (hex only); with no cohort it is the constant
 * `false`, so a query spliced with it reads exactly as it did before the cohort existed.
 */
export function inReviewCohortSql(idExpr: string): string {
  const ids = reviewCohort();
  if (ids.length === 0) return 'false';
  return `(${idExpr} IN (${ids.map((id) => `'${id}'`).join(', ')}))`;
}
