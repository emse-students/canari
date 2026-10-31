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
/**
 * The code of an act across the review cohort's boundary (the store reviewers' accounts and the
 * members never meet): worded neutrally, like a block, and typed like one where a flow answers it
 * (`ReviewCohortBoundaryError`, `describeCallFailure`).
 */
export const REVIEW_COHORT_BOUNDARY_CODE = 'REVIEW_COHORT_BOUNDARY';

const REFUSAL_WORDING: Readonly<Record<string, () => string>> = {
  NOT_A_MEMBER: m.refusal_not_a_member,
  MEMBERSHIP_NOT_ALLOWED: m.refusal_membership_not_allowed,
  USER_BLOCKED: m.refusal_user_blocked,
  [REVIEW_COHORT_BOUNDARY_CODE]: m.refusal_review_cohort_boundary,
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
  ADMIN_SELF_CHANGE: m.refusal_admin_self_change,
  USER_SEARCH_FILTER_REQUIRED: m.refusal_user_search_filter_required,
  USER_SEARCH_TOO_LONG: m.refusal_user_search_too_long,
  CALLS_DISABLED: m.call_calls_disabled,
  CALLS_VIDEO_DISABLED: m.call_video_disabled,
};

/**
 * The code BOTH services give a refusal caused by the owner's revocation of the calling device: the
 * delivery service on a device-creating call, core-service on a refresh whose session the revocation
 * ended. ONE name for the fact, read from here by every client reader.
 */
export const DEVICE_REVOKED_BY_OWNER = 'DEVICE_REVOKED_BY_OWNER';

/** The device and account an owner's revocation names (`userId`, `deviceId` of the refusal body). */
export interface RevokedDeviceIdentity {
  userId: string;
  deviceId: string;
}

/**
 * The revoked device a refresh refusal names, or `null` when the body is not that refusal or does
 * not name both - read as an ordinary dead session then, never as a revocation of THIS device.
 *
 * @param body The parsed refusal body (`unknown`: anything an answer can carry).
 */
export function revokedDeviceOfRefusal(body: unknown): RevokedDeviceIdentity | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.code !== DEVICE_REVOKED_BY_OWNER) return null;
  if (typeof b.userId !== 'string' || !b.userId) return null;
  if (typeof b.deviceId !== 'string' || !b.deviceId) return null;
  return { userId: b.userId, deviceId: b.deviceId };
}

/**
 * Codes a server registry carries that are NEVER shown to a member as a sentence, because a typed
 * flow answers them: a revoked id is re-enrolled under a fresh one, a full device list is a typed
 * `DeviceLimitReachedError`, a key package the client minted wrong is a bug of ours, a
 * key-distribution group is never joined by a screen, and a rate-limited commit pauses a sweep. Declared so the drift test can tell "not
 * worded on purpose" from "forgotten".
 */
export const TYPED_ELSEWHERE_CODES: readonly string[] = [
  'DEVICE_REVOKED',
  // An owner's revocation is a typed `DeviceRevokedByOwnerError` (delivery service) or
  // `SessionEndedByDeviceRevocationError` (a refused refresh), answered by signing out and wiping.
  DEVICE_REVOKED_BY_OWNER,
  'DEVICE_LIMIT_REACHED',
  'KEY_PACKAGE_IDENTITY_INVALID',
  'KEY_DISTRIBUTION_GROUP',
  // A commit refused by the per-user rate limit is a typed `CommitRefusedError('rate_limited')`
  // carrying the wait, and the recovery sweeps pause on it; no screen words it.
  'RATE_LIMITED',
  // A key-group commit whose seat claim an unrelated eviction overtook is a typed
  // `CommitRefusedError('seat_claim_overtaken')`, and the committer retries it at once.
  'SEAT_CLAIM_OVERTAKEN',
  // A Welcome whose target the roster does not name is a typed `WelcomeTargetNotMemberError`, and
  // the settlement that sent it stops owing it; no screen words it.
  'WELCOME_TARGET_NOT_MEMBER',
  // A member-add call naming a person no accepted commit admitted is a typed
  // `MemberNotAdmittedError`: the invite withholds the Welcome and reports the person not added.
  'MEMBER_NOT_ADMITTED',
  // A Welcome to a device no key package names (revoked, or never registered) is terminal for that
  // Welcome; the sender's own commit answer already said the device was not admitted.
  'WELCOME_TARGET_UNKNOWN',
];

/** Every code {@link describeRefusalCode} words. */
export const WORDED_REFUSAL_CODES: readonly string[] = Object.keys(REFUSAL_WORDING);

/** Every code of the shared contract: worded here, or answered by a typed flow. */
const CONTRACT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  ...WORDED_REFUSAL_CODES,
  ...TYPED_ELSEWHERE_CODES,
]);

/**
 * Whether `code` is a refusal code of the shared server contract (worded or typed elsewhere). The
 * drift test keeps this set equal to the server registries, so a body carrying one of these was
 * written by our own services (`refusalBody`), never by an edge, a CDN or a portal - which is what
 * `refusalOrigin` (`apiJson.ts`) needs to believe a coded refusal that lacks Nest's envelope.
 *
 * @param code Any value read off a refusal body.
 */
export function isContractRefusalCode(code: unknown): boolean {
  return typeof code === 'string' && CONTRACT_REFUSAL_CODES.has(code);
}

/**
 * The localized sentence for a refusal code, or `null` when the code is absent or unknown.
 *
 * @param code What `refusalCode(error)` read off the refusal.
 */
export function describeRefusalCode(code: string | null | undefined): string | null {
  if (!code || !Object.hasOwn(REFUSAL_WORDING, code)) return null;
  return REFUSAL_WORDING[code]();
}
