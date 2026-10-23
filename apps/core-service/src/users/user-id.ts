import { BadRequestException, type Logger } from '@nestjs/common';

/**
 * THE ONE RULE A USER ID IS MINTED UNDER: non-empty, visible ASCII (U+0021 to U+007E - no
 * whitespace at all), no ':'.
 *
 * WHY: `users.id` is the identity provider's `sub`, and it travels everywhere - the JWT `sub`, every
 * service's `X-User-Id`, the MLS credential `userId:deviceId`. Every comparison of it lowercases
 * ASCII letters only (`canonical_identity` in `mls-core/src/device_trust.rs`, `canonicalUserId` in
 * `frontend/src/lib/mls-client/leafIdentity.ts`), while rows stored earlier were lowercased with
 * full Unicode: on ASCII the two agree, on anything else they do not. And the device identity is
 * split on its ONE colon, so a colon in the user half names no device; and the client stores a
 * sender trimmed (`db/messagePayload.ts`), so whitespace would make two ids one. In practice the subject is a
 * 64-hex hash; this rule makes the property hold by construction, at the two places an id is made
 * (the sign-in callback and the administrator's create), without requiring that exact shape - a
 * plain ASCII id made earlier keeps signing in. Wiki: docs/wiki/profiles-and-access.md.
 */
export const USER_ID_INVALID = 'USER_ID_INVALID';

/** Which part of the rule an id breaks. */
export type UserIdRule = 'empty' | 'not-visible-ascii' | 'colon';

/** The rule `id` breaks, or `null` when it may be minted. */
export function userIdRuleBroken(id: unknown): UserIdRule | null {
  if (typeof id !== 'string' || id.length === 0) return 'empty';
  if (!/^[\x21-\x7e]+$/.test(id)) return 'not-visible-ascii';
  if (id.includes(':')) return 'colon';
  return null;
}

/** A user id refused at a mint point: a 400 with a stable `code` and the rule it broke. */
export class InvalidUserIdError extends BadRequestException {
  constructor(readonly rule: UserIdRule) {
    super({
      code: USER_ID_INVALID,
      rule,
      message: `A user id must be non-empty visible ASCII (no whitespace) with no ':' (broke: ${rule}).`,
    });
  }
}

/**
 * Refuses an id that breaks the rule, logged at ERROR naming the rule and the mint point - never
 * the id itself, which is a person's identifier.
 *
 * @param where The mint point, for the log line (`oidc-callback`, `admin-create`).
 */
export function assertMintableUserId(id: unknown, logger: Logger, where: string): void {
  const rule = userIdRuleBroken(id);
  if (rule === null) return;
  logger.error(
    `[USER_ID] refused at ${where}: rule=${rule} length=${typeof id === 'string' ? id.length : 0}`
  );
  throw new InvalidUserIdError(rule);
}
