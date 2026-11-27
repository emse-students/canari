import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every way an Alumni merge (D48) can be refused, as a TYPE with a stable `code` in the body - the
 * client branches on `code`, never on the message. The estate, the token and MiConnect's own
 * failures are the profile editor's refusals (`profile-edit.errors.ts`): the merge goes through the
 * same account and the same client, so they are thrown there and not restated here.
 */
export const ALUMNI_MERGE_CODES = {
  notFound: 'ALUMNI_MERGE_NOT_FOUND',
  notDuplicate: 'ALUMNI_MERGE_NOT_DUPLICATE',
  noMatch: 'ALUMNI_MERGE_NO_MATCH',
  holdingsUnavailable: 'ALUMNI_MERGE_HOLDINGS_UNAVAILABLE',
  inProgress: 'ALUMNI_MERGE_IN_PROGRESS',
  alreadyMerged: 'ALUMNI_MERGE_ALREADY_MERGED',
  reasonRequired: 'ALUMNI_MERGE_REASON_REQUIRED',
  targetBusy: 'ALUMNI_MERGE_TARGET_BUSY',
  notMerged: 'ALUMNI_MERGE_NOT_MERGED',
} as const;

/**
 * The bounds of a merge's written reason, in CODE POINTS after trimming (D55) - never UTF-16 units, so
 * an emoji counts once. Asserted equal to `libs/contracts/alumni-merge-reason.json`, which the admin
 * page asserts too, so the two counts cannot drift apart.
 */
export const ALUMNI_MERGE_REASON_MIN = 20;
export const ALUMNI_MERGE_REASON_MAX = 1000;

/** No such duplicate at MiConnect with no merge of it open, or (a cancel) no open merge of it. */
export class AlumniMergeNotFoundError extends HttpException {
  constructor() {
    super(
      { code: ALUMNI_MERGE_CODES.notFound, message: 'No such MiConnect account to merge.' },
      HttpStatus.NOT_FOUND
    );
  }
}

/**
 * The account named as the duplicate is not one the merge may delete: its username does not start
 * with `alumni-` (it was not created by an Alumni sign-in, D46), or it holds a link to a source other
 * than the Alumni one. The ALLOWLIST of the destructive control - anything else is refused.
 */
export class AlumniMergeNotDuplicateError extends HttpException {
  constructor(readonly reason: string) {
    super(
      { code: ALUMNI_MERGE_CODES.notDuplicate, message: `Not an Alumni duplicate: ${reason}.` },
      HttpStatus.CONFLICT
    );
  }
}

/** The target is not an account the duplicate matches (name and promo, D47), or is itself one. */
export class AlumniMergeNoMatchError extends HttpException {
  constructor(readonly reason: string) {
    super(
      { code: ALUMNI_MERGE_CODES.noMatch, message: `The target does not match: ${reason}.` },
      HttpStatus.CONFLICT
    );
  }
}

/**
 * What the duplicate holds in Canari could not be counted. The admin confirms a deletion KNOWING
 * what it takes (D48), so an unknown count refuses the merge rather than showing a guess.
 */
export class AlumniMergeHoldingsUnavailableError extends HttpException {
  constructor(readonly service: string) {
    super(
      {
        code: ALUMNI_MERGE_CODES.holdingsUnavailable,
        message: `What the duplicate holds could not be read (${service}).`,
      },
      HttpStatus.BAD_GATEWAY
    );
  }
}

/**
 * Another "Rattacher" of the same duplicate wrote its trace row first (the partial unique index on
 * the open rows). Nothing was marked by this call; the list shows the other one.
 */
export class AlumniMergeInProgressError extends HttpException {
  constructor() {
    super(
      { code: ALUMNI_MERGE_CODES.inProgress, message: 'A merge of this account is already open.' },
      HttpStatus.CONFLICT
    );
  }
}

/**
 * A cancel came too late: the duplicate already signed in through Alumni, and MiConnect merged it
 * into the marked account (30-sources.yaml). The trace is completed; there is nothing to cancel.
 */
export class AlumniMergeAlreadyMergedError extends HttpException {
  constructor() {
    super(
      { code: ALUMNI_MERGE_CODES.alreadyMerged, message: 'MiConnect already merged this account.' },
      HttpStatus.CONFLICT
    );
  }
}

/**
 * A MANUAL merge (the target is not the unique name-and-promo match, D55) came without a written
 * reason of {@link ALUMNI_MERGE_REASON_MIN}-{@link ALUMNI_MERGE_REASON_MAX} code points, or a reason
 * given is out of those bounds. The admin decides identity, and says why.
 */
export class AlumniMergeReasonRequiredError extends HttpException {
  constructor(readonly reason: 'missing' | 'too_short' | 'too_long') {
    super(
      {
        code: ALUMNI_MERGE_CODES.reasonRequired,
        message: `A manual merge needs a written reason of ${ALUMNI_MERGE_REASON_MIN} to ${ALUMNI_MERGE_REASON_MAX} characters (${reason}).`,
      },
      HttpStatus.BAD_REQUEST
    );
  }
}

/**
 * Another open merge already names this target (D55, both modes): two duplicates never race into
 * one account. The other one is completed or cancelled first.
 */
export class AlumniMergeTargetBusyError extends HttpException {
  constructor() {
    super(
      {
        code: ALUMNI_MERGE_CODES.targetBusy,
        message: 'Another open merge already names this account.',
      },
      HttpStatus.CONFLICT
    );
  }
}

/**
 * MiConnect's push named a merge MiConnect has not made (D54): the duplicate still exists, or the
 * target does not hold its Alumni link. Nothing was written; the push is only a hint.
 */
export class AlumniMergeNotMergedError extends HttpException {
  constructor(readonly reason: string) {
    super(
      { code: ALUMNI_MERGE_CODES.notMerged, message: `MiConnect has not merged it: ${reason}.` },
      HttpStatus.CONFLICT
    );
  }
}
