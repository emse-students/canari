import { ForbiddenException } from '@nestjs/common';

/**
 * THE REVIEW COHORT: THE STORE REVIEWERS' ACCOUNTS, AND THE ONE RULE THAT KEEPS THEM APART.
 *
 * Google Play and Apple review the app by signing in with accounts the team gives them. Those
 * accounts are a COHORT that shares a world of its own: a review account and a member never meet.
 * A member never finds a review account, never opens its profile, never reads what it writes and
 * never follows, messages, adds, calls or mentions it - and a review account reaches only the
 * cohort in the same ways, whatever profile its identity provider hands it. The decision and every
 * surface it holds on: docs/wiki/profiles-and-access.md, "The review cohort".
 *
 * WHERE THE IDS COME FROM. `SERVICE_ACCOUNT_USER_ID`, a GitHub secret rendered into core-service,
 * social-service and chat-delivery-service: a comma-separated list of user ids. The name predates
 * the cohort (it held ONE id until 2026-10-31); a one-id value is a one-member cohort. Empty means
 * no cohort and no restriction.
 *
 * AN ENTRY THAT IS NOT A USER ID IS A CONFIGURATION ERROR, AND THE SERVICE REFUSES TO START. An
 * entry follows the grammar every user id is minted under (`users/user-id.ts` in core-service:
 * visible ASCII, no ':'), and no ',' since that separates entries. Dropping a bad entry would leave
 * that review account visible with no sign of it; each service reads the cohort at boot
 * (`assertReviewCohortConfigured`) and stops there.
 *
 * SQL. An id is visible ASCII, quotes included, so it is never written into SQL as text: the
 * query-builder sites bind it as a parameter, and `inReviewCohortSql` - for the fragments spliced
 * into hand-written SQL, where no parameter slot exists - writes the list HEX-ENCODED and decodes it
 * in PostgreSQL, so nothing an id contains can end a literal.
 *
 * BYTE-IDENTICAL in the three services (`.github/scripts/lib/declared-duplicates.mjs`): there is no
 * shared TS package, and the three must agree on who is in the cohort. The spec beside the
 * core-service copy proves all of them. It reads the environment on every call, so a test can set
 * it.
 */

/** The environment variable holding the cohort, comma-separated. */
export const REVIEW_COHORT_ENV = 'SERVICE_ACCOUNT_USER_ID';

/** The `code` of every refusal that would carry something across the cohort's boundary. */
export const REVIEW_COHORT_BOUNDARY = 'REVIEW_COHORT_BOUNDARY';

/** A user id's grammar (`users/user-id.ts`), minus ',' - the separator of the list. */
const ENTRY = /^[\x21-\x2b\x2d-\x39\x3b-\x7e]+$/;

/** Thrown when `SERVICE_ACCOUNT_USER_ID` holds something that is not a list of user ids. */
export class ReviewCohortConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewCohortConfigError';
  }
}

/**
 * A 403 for an act that would cross the cohort's boundary: following, messaging, adding, calling,
 * opening a profile or buying across it. Neutral, like a block's: it says the act is not possible,
 * never that the other account is a review account.
 */
export class ReviewCohortBoundaryException extends ForbiddenException {
  constructor(message = 'This is not possible with this account.') {
    super({ code: REVIEW_COHORT_BOUNDARY, message });
  }
}

/**
 * The cohort a raw `SERVICE_ACCOUNT_USER_ID` value names: distinct ids, in the order given,
 * LOWER-CASED - every service compares a user id lower-cased (the header, the roster rows), so an
 * entry pasted in upper case must still name its account. Blank entries around commas are ignored;
 * any other entry outside the grammar throws, naming its POSITION and never its text (the value is
 * a secret).
 */
export function parseReviewCohort(raw: string | undefined): readonly string[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];
  const ids: string[] = [];
  trimmed.split(',').forEach((entry, index) => {
    const id = entry.trim().toLowerCase();
    if (id === '') return;
    if (!ENTRY.test(id)) {
      throw new ReviewCohortConfigError(
        `${REVIEW_COHORT_ENV} entry ${index + 1} is not a user id (visible ASCII, no ':' or ',')`
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

/**
 * Reads the cohort once at boot, so a bad entry stops the service before it serves anything.
 * Returns the cohort's size, for the boot log.
 */
export function assertReviewCohortConfigured(): number {
  return reviewCohort().length;
}

/** Whether `userId` is a review account, compared lower-cased. An absent id is not. */
export function isInReviewCohort(userId: string | undefined | null): boolean {
  return !!userId && reviewCohort().includes(userId.trim().toLowerCase());
}

/**
 * Whether `a` and `b` stand on the same side of the cohort's boundary - both review accounts, or
 * neither. With no cohort configured, everybody does.
 */
export function sameSideOfReviewCohort(a: string, b: string): boolean {
  return isInReviewCohort(a) === isInReviewCohort(b);
}

/**
 * Whether what a profile shows of `targetId` (its memberships, its roles) may be served to
 * `viewerId`: on the same side of the boundary; with no session (`viewerId` absent - a public
 * read), whenever the target is not a review account, which has no public identity.
 */
export function profileOpenAcrossCohort(viewerId: string | undefined, targetId: string): boolean {
  if (viewerId) return sameSideOfReviewCohort(viewerId, targetId);
  return !isInReviewCohort(targetId);
}

/**
 * Refuses (403 {@link REVIEW_COHORT_BOUNDARY}) when `a` and `b` stand on either side of the
 * cohort's boundary.
 */
export function assertSameSideOfReviewCohort(a: string, b: string, message?: string): void {
  if (!sameSideOfReviewCohort(a, b)) throw new ReviewCohortBoundaryException(message);
}

/**
 * A SQL boolean: the user id the expression `idExpr` yields is a review account. The list is
 * written hex-encoded and decoded by PostgreSQL (see the module note); with no cohort it is the
 * constant `false`, so a query spliced with it reads exactly as it did before the cohort existed.
 */
export function inReviewCohortSql(idExpr: string): string {
  const ids = reviewCohort();
  if (ids.length === 0) return 'false';
  const hex = Buffer.from(ids.join(','), 'utf8').toString('hex');
  return `(${idExpr} = ANY (string_to_array(convert_from(decode('${hex}', 'hex'), 'UTF8'), ',')))`;
}
