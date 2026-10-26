/**
 * THE STABLE `code` OF EVERY REFUSAL A USER CAN ACT ON, one name each (core-service half; the
 * delivery service keeps its own table in `chat-delivery-service/src/utils/refusal-codes.ts`).
 *
 * A server exception's `message` is dev-facing and never shown: the client words a refusal from its
 * `code` through Paraglide (`frontend/src/lib/utils/refusalCodes.ts`, the mirror of both tables -
 * its test fails when one drifts). A code is a CONTRACT: renaming one strands every client that
 * knows it. Codes are additive - the old `message` text stays beside the code, so a client that
 * predates it reads what it always read.
 *
 * `MAINTENANCE`, `ACCOUNT_ERASURE_PENDING` and `ACCOUNT_ERASURE_BLOCKED` are coded in
 * `auth.controller.ts`, and `USER_ID_INVALID` in `users/user-id.ts`; the sign-in flow words them
 * (`frontend/src/lib/stores/auth.ts`), so they are not repeated here.
 */
export const RefusalCode = {
  /** 400 - a block aimed at oneself. */
  BLOCK_SELF: 'BLOCK_SELF',
  /** 404 - the person to block does not exist. */
  BLOCK_TARGET_NOT_FOUND: 'BLOCK_TARGET_NOT_FOUND',
  /** 422 - the block list is full (`max` carries the cap). */
  BLOCK_LIMIT_REACHED: 'BLOCK_LIMIT_REACHED',
  /** 404 - an unblock of somebody who was not blocked. */
  NOT_BLOCKED: 'NOT_BLOCKED',
  /** 403 - an administrator may not remove their own administrator right. */
  ADMIN_SELF_DEMOTE: 'ADMIN_SELF_DEMOTE',
  /** 403 - an administrator may not change their own administrator right, granting included. */
  ADMIN_SELF_CHANGE: 'ADMIN_SELF_CHANGE',
  /** 400 - a people search with no filter at all. */
  USER_SEARCH_FILTER_REQUIRED: 'USER_SEARCH_FILTER_REQUIRED',
  /** 400 - a people search longer than the cap (`max` carries it). */
  USER_SEARCH_TOO_LONG: 'USER_SEARCH_TOO_LONG',
  /**
   * 401 - a refresh whose session the owner's revocation of its device ended; `userId` and
   * `deviceId` name that device. The same name the delivery service gives a device-creating call
   * from such a device, so the client has ONE name for the fact.
   */
  DEVICE_REVOKED_BY_OWNER: 'DEVICE_REVOKED_BY_OWNER',
} as const;

/** A stable refusal code of this service. */
export type RefusalCodeName = (typeof RefusalCode)[keyof typeof RefusalCode];

/**
 * The body of a coded refusal: `{ code, message, ...extra }`, which Nest serialises as the response
 * body itself. `message` stays the dev-facing text a pre-code client already read.
 */
export function refusalBody(
  code: RefusalCodeName,
  message: string,
  extra: Record<string, unknown> = {}
): { code: RefusalCodeName; message: string } & Record<string, unknown> {
  return { code, message, ...extra };
}
