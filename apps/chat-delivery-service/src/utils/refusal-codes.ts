/**
 * THE STABLE `code` OF EVERY REFUSAL A USER CAN ACT ON, one name each.
 *
 * A server exception's `message` is dev-facing English: a client never shows it and never branches
 * on it. What a client keys on is the `code` below, and it words the refusal itself through
 * Paraglide (`frontend/src/lib/utils/refusalCodes.ts`, the mirror of this table - its test fails
 * when the two drift). A code is a CONTRACT: renaming one strands every client that already knows
 * it, so a rename is a new code plus the old one kept for as long as `minClientVersion` admits a
 * client that reads it.
 *
 * Model: `DEVICE_REVOKED`. Codes are additive - the old `message` text is kept verbatim, so a
 * client that predates a code still reads the status and the prose it always read.
 */
export const RefusalCode = {
  /** 403 - the device id is banned; the cure is a fresh id. */
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  /** 400 - the account already holds its maximum of live devices. */
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED',
  /** 400 - a key package that does not parse or names another device. Never retryable. */
  KEY_PACKAGE_IDENTITY_INVALID: 'KEY_PACKAGE_IDENTITY_INVALID',
  /** 403 - a key-distribution group is joined through its community, not by this route. */
  KEY_DISTRIBUTION_GROUP: 'KEY_DISTRIBUTION_GROUP',
  /** 403 - a block stands between two people. Neutral: never who blocked whom. */
  USER_BLOCKED: 'USER_BLOCKED',
  /** 403 - the caller is not a member of the conversation it addressed. */
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  /** 403 - the caller may not change this group's roster. */
  MEMBERSHIP_NOT_ALLOWED: 'MEMBERSHIP_NOT_ALLOWED',
  /** 404 - an invitation link that never existed, expired or was revoked. */
  INVITE_INVALID: 'INVITE_INVALID',
  /** 400 - an invitation can only be minted for a group chat, not a 1-to-1. */
  INVITE_NOT_A_GROUP: 'INVITE_NOT_A_GROUP',
  /** 400 - the joiner has no usable device to receive the Welcome on. */
  NO_ACTIVE_DEVICE: 'NO_ACTIVE_DEVICE',
  /** 403 - the current PIN typed for a PIN change does not match. */
  PIN_INCORRECT: 'PIN_INCORRECT',
  /** 400 - a PIN change for an account that never registered one. */
  PIN_NOT_SET: 'PIN_NOT_SET',
  /** 403 - calls are closed on this estate (`platform_config.calls_mode = off`, the kill switch). */
  CALLS_DISABLED: 'CALLS_DISABLED',
  /** 403 - this estate allows audio calls only (`calls_mode = audio`) and the ring asked for video. */
  CALLS_VIDEO_DISABLED: 'CALLS_VIDEO_DISABLED',
  /** 429 - a per-user rate limit (`UserThrottlerGuard`); `retryAfterMs` says how long to wait. */
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * 409 - a commit that writes a seat was refused whole because an eviction in the group overtook
   * the seat claim it was checked against (`utils/seat-eviction.ts`). Nothing advanced; rebuild the
   * commit and submit it again now.
   */
  SEAT_CLAIM_OVERTAKEN: 'SEAT_CLAIM_OVERTAKEN',
  /**
   * 403 - a Welcome addressed to a person the conversation's roster does not name (`POST mls/welcome`).
   * Terminal for that Welcome: re-sending it changes nothing, and the Add that could make its target
   * a member is a new commit with a Welcome of its own.
   */
  WELCOME_TARGET_NOT_MEMBER: 'WELCOME_TARGET_NOT_MEMBER',
} as const;

/** A stable refusal code of this service. */
export type RefusalCodeName = (typeof RefusalCode)[keyof typeof RefusalCode];

/**
 * The body of a coded refusal: `{ code, message, ...extra }`, which Nest serialises as the response
 * body itself. `message` stays the dev-facing English a pre-code client already read.
 */
export function refusalBody(
  code: RefusalCodeName,
  message: string,
  extra: Record<string, unknown> = {}
): { code: RefusalCodeName; message: string } & Record<string, unknown> {
  return { code, message, ...extra };
}
