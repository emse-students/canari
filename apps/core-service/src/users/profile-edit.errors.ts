import { BadRequestException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import type { ProfileEditProblem } from './miconnect-profile';

/**
 * Every way an admin's profile edit can be refused, as a TYPE with a stable `code` in the body.
 *
 * A distinction carried in prose is a distinction exactly one call site will make, so the client
 * branches on `code` and never on the message. Each class is thrown where the fact is KNOWN - the
 * estate and the token at the entry, the missing link at the user lookup, the transport at the
 * authentik call - and nothing downstream has to guess which one it holds.
 */
export const PROFILE_EDIT_CODES = {
  invalid: 'PROFILE_EDIT_INVALID',
  devEstate: 'PROFILE_EDIT_DEV_ESTATE',
  notConfigured: 'PROFILE_EDIT_NOT_CONFIGURED',
  notLinked: 'PROFILE_EDIT_NOT_LINKED',
  upstream: 'PROFILE_EDIT_UPSTREAM',
} as const;

/** The edit names something that is not a profile (an unknown formation, a missing name...). */
export class ProfileEditInvalidError extends BadRequestException {
  constructor(readonly problems: ProfileEditProblem[]) {
    super({ code: PROFILE_EDIT_CODES.invalid, problems });
  }
}

/**
 * This is the dev estate. Dev and production share ONE MiConnect, so an edit made from dev would
 * change a real person: the refusal is absolute, whatever token the process might hold.
 */
export class ProfileEditUnavailableOnDevError extends HttpException {
  constructor() {
    super(
      {
        code: PROFILE_EDIT_CODES.devEstate,
        message: 'Profile edits are refused on the dev estate: it shares production MiConnect.',
      },
      HttpStatus.FORBIDDEN
    );
  }
}

/** Production without its authentik token or base URL: a deployment fault, not the admin's. */
export class ProfileEditNotConfiguredError extends HttpException {
  constructor(readonly missing: string) {
    super(
      {
        code: PROFILE_EDIT_CODES.notConfigured,
        message: `Profile edits are not configured on this estate (${missing} is unset).`,
      },
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }
}

/**
 * The person has no `miconnectUuid` yet, so authentik cannot be addressed. They get one at their
 * next sign-in or from the backfill; until then there is nothing to write to.
 */
export class ProfileEditNotLinkedError extends ConflictException {
  constructor() {
    super({
      code: PROFILE_EDIT_CODES.notLinked,
      message:
        'This account has no MiConnect uuid yet - it has not signed in since the profile reform.',
    });
  }
}

/** authentik did not answer, or answered something other than success. Nothing was written. */
export class ProfileEditUpstreamError extends HttpException {
  constructor(
    readonly upstreamStatus: number | null,
    detail: string
  ) {
    super(
      {
        code: PROFILE_EDIT_CODES.upstream,
        message: `MiConnect refused or did not answer: ${detail}`,
      },
      HttpStatus.BAD_GATEWAY
    );
  }
}
