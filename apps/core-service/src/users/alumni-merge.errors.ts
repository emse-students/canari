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
} as const;

/** The duplicate is not (or no longer) a MiConnect account, and no merge of it is pending. */
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
