import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Every way a correction request can be refused, as a TYPE with a stable `code` in the body - the
 * client branches on the code, never on the sentence (same rule as `profile-edit.errors.ts`).
 */
export const PROFILE_CORRECTION_CODES = {
  invalid: 'PROFILE_CORRECTION_INVALID',
  alreadyPending: 'PROFILE_CORRECTION_PENDING',
  notFound: 'PROFILE_CORRECTION_NOT_FOUND',
  notPending: 'PROFILE_CORRECTION_NOT_PENDING',
} as const;

/** The message is empty or longer than allowed. */
export class ProfileCorrectionInvalidError extends BadRequestException {
  constructor(max: number) {
    super({
      code: PROFILE_CORRECTION_CODES.invalid,
      message: `A correction request needs a message of 1 to ${max} characters.`,
    });
  }
}

/** The person already has an open request: it must be answered before another is filed. */
export class ProfileCorrectionAlreadyPendingError extends ConflictException {
  constructor() {
    super({
      code: PROFILE_CORRECTION_CODES.alreadyPending,
      message: 'You already have a correction request waiting for an admin.',
    });
  }
}

/** No request has this id. */
export class ProfileCorrectionNotFoundError extends NotFoundException {
  constructor() {
    super({ code: PROFILE_CORRECTION_CODES.notFound, message: 'No such correction request.' });
  }
}

/** The request was already applied or refused: answering it twice would notify twice. */
export class ProfileCorrectionNotPendingError extends ConflictException {
  constructor() {
    super({
      code: PROFILE_CORRECTION_CODES.notPending,
      message: 'This correction request has already been answered.',
    });
  }
}
