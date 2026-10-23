import { m } from '$lib/paraglide/messages';

/**
 * THE SENTENCE OF EVERY STABLE SERVER REFUSAL CODE A MEMBER CAN ACT ON.
 *
 * The mirror of `apps/chat-delivery-service/src/utils/refusal-codes.ts` and
 * `apps/core-service/src/common/refusal-codes.ts`: the server names a refusal with a `code`, the
 * client words it here through Paraglide, and nothing ever shows the server's own English
 * `message` or branches on it. `refusalCodes.test.ts` fails when a server registry gains a code
 * that is neither worded here nor declared in {@link TYPED_ELSEWHERE_CODES}.
 *
 * Read the code with `refusalCode(error)` (`apiRefusal.ts`) and word it with
 * {@link describeRefusalCode}; a code this table does not know answers `null`, which leaves the
 * caller's own generic line in place rather than inventing a reason.
 */
const REFUSAL_WORDING: Readonly<Record<string, () => string>> = {
  NOT_A_MEMBER: m.refusal_not_a_member,
  MEMBERSHIP_NOT_ALLOWED: m.refusal_membership_not_allowed,
  USER_BLOCKED: m.refusal_user_blocked,
  INVITE_INVALID: m.invite_not_found,
  INVITE_NOT_A_GROUP: m.refusal_invite_not_a_group,
  NO_ACTIVE_DEVICE: m.refusal_no_active_device,
  PIN_INCORRECT: m.auth_pin_change_current_incorrect,
  PIN_NOT_SET: m.refusal_pin_not_set,
  BLOCK_SELF: m.refusal_block_self,
  BLOCK_TARGET_NOT_FOUND: m.refusal_block_target_not_found,
  BLOCK_LIMIT_REACHED: m.refusal_block_limit_reached,
  NOT_BLOCKED: m.refusal_not_blocked,
  ADMIN_SELF_DEMOTE: m.refusal_admin_self_demote,
  USER_SEARCH_FILTER_REQUIRED: m.refusal_user_search_filter_required,
  USER_SEARCH_TOO_LONG: m.refusal_user_search_too_long,
  CALLS_DISABLED: m.call_calls_disabled,
  CALLS_VIDEO_DISABLED: m.call_video_disabled,
};

/**
 * Codes a server registry carries that are NEVER shown to a member as a sentence, because a typed
 * flow answers them: a revoked id is re-enrolled under a fresh one, a full device list is a typed
 * `DeviceLimitReachedError`, a key package the client minted wrong is a bug of ours, a
 * key-distribution group is never joined by a screen, and a rate-limited commit pauses a sweep. Declared so the drift test can tell "not
 * worded on purpose" from "forgotten".
 */
export const TYPED_ELSEWHERE_CODES: readonly string[] = [
  'DEVICE_REVOKED',
  'DEVICE_LIMIT_REACHED',
  'KEY_PACKAGE_IDENTITY_INVALID',
  'KEY_DISTRIBUTION_GROUP',
  // A commit refused by the per-user rate limit is a typed `CommitRefusedError('rate_limited')`
  // carrying the wait, and the recovery sweeps pause on it; no screen words it.
  'RATE_LIMITED',
  // A key-group commit whose seat claim an unrelated eviction overtook is a typed
  // `CommitRefusedError('seat_claim_overtaken')`, and the committer retries it at once.
  'SEAT_CLAIM_OVERTAKEN',
];

/** Every code {@link describeRefusalCode} words. */
export const WORDED_REFUSAL_CODES: readonly string[] = Object.keys(REFUSAL_WORDING);

/**
 * The localized sentence for a refusal code, or `null` when the code is absent or unknown.
 *
 * @param code What `refusalCode(error)` read off the refusal.
 */
export function describeRefusalCode(code: string | null | undefined): string | null {
  if (!code || !Object.hasOwn(REFUSAL_WORDING, code)) return null;
  return REFUSAL_WORDING[code]();
}
