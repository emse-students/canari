import { assertOkMlsDeliveryResponse, deliveryKeepalivePost } from './mlsDeliveryHttp';
import { fetchJsonUnderProgressDeadline } from './progressDeadline';
import { ackMessagesWithRetry } from './ackRetry';
import { ADDRESSED_HISTORY_CAPABILITY, DELIVERY, type FrameDelivery } from './frameDelivery';
import type { DeviceMembershipRow, GroupMeta, UserGroupRow } from './IMlsService';
import type { DatedKeyPackage } from './keyPackages';
import type { DeviceKeyPackageAnswer, DeviceSignatureKeys } from './deviceKeyPackage';
import { toBase64, fromBase64 } from '$lib/utils/hex';
import { trackedFetch } from '$lib/utils/trackedFetch';
import { sanitizeForLog } from '$lib/utils/logSanitize';
import { isTransportFailure, TransportFailureError } from '$lib/utils/transportFailure';
import { ApiRefusalError, responseOrigin, type ResponseOrigin } from '$lib/utils/apiRefusal';
import { refusalFromResponse } from '$lib/utils/apiRefusalError';

/**
 * What the server did with a member's Decline of an invitation-link ask
 * (`POST mls/groups/:groupId/join-requests/:userId/decline`):
 *
 * - `withdrawn`: the seat still awaited a member; it is gone, the ask with it.
 * - `already-admitted`: a member's Add came first - the person is in, and nothing was touched (the
 *   generic removal used to delete that admitted person's seat and leave their leaf with none).
 * - `not-awaiting`: the seat never awaited a member and the server holds no trace of an Add of
 *   theirs - not an invitation-link ask at all (a seat older than the rule, a member's invite between
 *   its roster write and its Add, a member whose leaves were removed). Nothing was touched.
 * - `gone`: no seat - answered or expired before.
 */
export const JOIN_DECLINE_OUTCOMES = [
  'withdrawn',
  'already-admitted',
  'not-awaiting',
  'gone',
] as const;
export type JoinDeclineOutcome = (typeof JOIN_DECLINE_OUTCOMES)[number];

/**
 * A device still to be Added into a group this device is a member of
 * (`GET mls/invitations/pending/:userId/:deviceId`).
 */
export type PendingInvitationRow = {
  id: string;
  userId: string;
  deviceId: string;
  groupId: string;
  status: string;
  /**
   * The person's seat is an invitation link's ask no member has answered: the one row a member is
   * asked about ("X asks to join"). Absent from a server older than the field.
   */
  awaitingAdmission?: boolean;
};

/** One user of a group's roster (`GET mls/groups/:groupId/user-members`). */
export type GroupUserMemberRow = {
  userId: string;
  /** As {@link PendingInvitationRow.awaitingAdmission}, for the roster read. */
  awaitingAdmission?: boolean;
};

export type MlsDeliveryFetch = typeof fetch;

/**
 * How long one pending page may stay COMPLETELY SILENT before it is abandoned.
 *
 * Not a budget for the page: {@link fetchJsonUnderProgressDeadline} re-arms it on the response head
 * and on every body chunk, so a slow transfer never trips it and the number does not have to cover
 * "the biggest page on the slowest link" - a product nobody can bound. What it has to exceed is the
 * longest stretch the design permits with nothing on the wire, and there is exactly one: the server
 * assembling a page, which it bounds at `PENDING_PAGE_MAX_BYTES` (1 MB) reading
 * `PENDING_FETCH_CHUNK_ROWS` (50) rows at a time. Ten seconds of total silence against that is
 * already pathological, which is the point - it is a hang-guard and nothing else decides how big a
 * page may be.
 */
export const PENDING_PAGE_STALL_MS = 10_000;

/**
 * The largest number of groups `POST /api/mls/history/batch` will accept in one request.
 *
 * This MIRRORS `HISTORY_BATCH_MAX_GROUPS` in chat-delivery-service's `messaging.service.ts`, whose
 * spec pins the value and names this constant: a client must not learn a limit by being refused,
 * and this one is not negotiated anywhere on the wire. Lowering the server's cap without lowering
 * this one puts every catch-up back to one request per conversation.
 */
export const HISTORY_BATCH_MAX_GROUPS = 50;

/**
 * The largest number of groups `POST /api/mls/group-rosters` answers in one request.
 *
 * MIRRORS `GROUP_ROSTERS_MAX_GROUPS` in chat-delivery-service's `members.controller.ts`, for the
 * reason {@link HISTORY_BATCH_MAX_GROUPS} gives: a client must not learn a limit by being refused.
 */
export const GROUP_ROSTERS_MAX_GROUPS = 200;

/** What one {@link MlsDeliveryApi.fetchGroupRosters} read answered. */
export interface GroupRosterBatch {
  /** Roster user ids by group, for every group the server answered. */
  rosters: Map<string, string[]>;
  /** Groups the server refused because the caller is not in them (the single read's 403). */
  refused: Set<string>;
  /**
   * The `userId:deviceId` of every REVOKED device of an answered group's roster, by group - the
   * allowlist `removeStrayLeaves` collects revoked leaves from. Absent for a group with none, and
   * empty against a server that predates the field: nothing known revoked is nothing removed.
   */
  revoked: Map<string, string[]>;
}

/**
 * What sending one application frame produced: the sealed ciphertext, and the server's receive time
 * for it - the `serverTimestamp` the sender's own copy is stored with, since a sender never receives
 * its frame back. `null` when the server's answer carried none (a server predating the field).
 */
export interface SentFrame extends AuthoredFrame {
  receivedAt: number | null;
}

/**
 * One application frame as the platform engine sealed it: the ciphertext, and the encoded author
 * proof mls-core appended inside it (`$lib/crypto/messageAuthorship`) - which the sender keeps on its
 * own copy, so its history bundles carry the same proof its peers received.
 */
export interface AuthoredFrame {
  sealed: Uint8Array;
  authorProof: Uint8Array;
}

/**
 * One window, in SERVER milliseconds, during which a person was not a member of a group;
 * `until: null` means still out. Mirrors `ExclusionWindow` in chat-delivery-service's
 * `utils/group-membership.ts`.
 */
export interface ExclusionWindow {
  from: number;
  until: number | null;
}

/**
 * What `GET /api/mls/groups/:groupId/exclusions` answered: the windows of every CURRENT member that
 * has one, keyed by LOWER-CASED user id. A member absent from the map has no window.
 */
export type GroupExclusions = ReadonlyMap<string, readonly ExclusionWindow[]>;

/** The answer did not have the shape the exclusions route promises - typed, so no caller reads a message. */
export class MalformedExclusionsError extends Error {
  constructor(detail: string) {
    super(`malformed exclusions answer: ${detail}`);
    this.name = 'MalformedExclusionsError';
  }
}

/**
 * The delivery service answered the windows route WITHOUT a `withheld` field: it predates it
 * (2026-10-22). Typed so the one caller that has an older rule to keep - the receiver - can tell it
 * from a malformed answer, which fails closed everywhere. A store build runs ahead of production
 * for as long as both stores take a version, so this is an ordinary state, not a defect.
 */
export class WithheldUnsupportedError extends Error {
  constructor(readonly groupId: string) {
    super(`the delivery service predates the withheld windows (group ${groupId.slice(0, 8)})`);
    this.name = 'WithheldUnsupportedError';
  }
}

/**
 * The delivery service refused to ADDRESS a history answer on a conversation to the named devices:
 * not every live session of theirs declared that it refuses an addressed frame that is not a
 * solicited history answer (`400 { error: 'addressed_unsupported' }`, step A rule 6). Typed so the
 * answerer answers nobody - an older device is served by an older peer, never by a broadcast here.
 */
export class AddressedUnsupportedError extends Error {
  constructor(
    readonly groupId: string,
    readonly devices: readonly string[]
  ) {
    super(
      `the addressed device(s) cannot receive an addressed answer in ${groupId.slice(0, 8)}: ${devices.join(',')}`
    );
    this.name = 'AddressedUnsupportedError';
  }
}

/**
 * Parses the body of `GET /api/mls/groups/:groupId/exclusions`.
 *
 * Strict on purpose: a window that cannot be read is a window that would not be withheld, so a
 * malformed answer throws rather than being read as "nobody was ever out".
 */
export function parseGroupExclusions(raw: unknown): GroupExclusions {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedExclusionsError('not an object');
  }
  const out = new Map<string, ExclusionWindow[]>();
  for (const [userId, windows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(windows)) throw new MalformedExclusionsError(`windows of ${userId}`);
    out.set(
      userId.toLowerCase(),
      windows.map((w) => {
        const from = (w as { from?: unknown })?.from;
        const until = (w as { until?: unknown })?.until;
        if (typeof from !== 'number' || !Number.isFinite(from)) {
          throw new MalformedExclusionsError(`window start of ${userId}`);
        }
        if (until !== null && (typeof until !== 'number' || !Number.isFinite(until))) {
          throw new MalformedExclusionsError(`window end of ${userId}`);
        }
        return { from, until };
      })
    );
  }
  return out;
}

/**
 * The delivery service refused this device id: it was explicitly deleted, and the denylist is
 * permanent. Typed rather than message-matched, because the only cure is structural - enrol under
 * a fresh device id ({@link BaseMlsService.rotateDeviceIdentity}), never a retry of the same call.
 */
export class DeviceRevokedError extends Error {
  constructor(readonly deviceId: string) {
    super(`Device ${deviceId} is revoked server-side`);
    this.name = 'DeviceRevokedError';
  }
}

/**
 * The account already spends every device slot the server allows, so this device cannot enrol.
 *
 * TERMINAL, AND THAT IS THE WHOLE REASON IT IS A TYPE. Every other failure of a KeyPackage
 * publication is worth retrying on the next connection; this one is not - no reconnection, no backoff
 * and no amount of waiting changes an account's device count. The only cure is a human deleting a
 * device, so a client that retries silently leaves a device holding a session, no KeyPackage, and a
 * sidebar of conversations that can never become ready (`[MEMBERSHIP_ACTIVE] reason=no_key_package`
 * on the server, for every group).
 *
 * Typed rather than message-matched, like {@link DeviceRevokedError}: the discriminator is the
 * `DEVICE_LIMIT_REACHED` code the server puts in the body, never the sentence beside it.
 */
export class DeviceLimitReachedError extends Error {
  constructor(readonly max: number | null) {
    super(
      max === null
        ? 'The account has no free device slot'
        : `The account already uses all ${max} device slots`
    );
    this.name = 'DeviceLimitReachedError';
  }
}

/**
 * The delivery service refused a read of a group's member list because this caller is not in it.
 *
 * `GET /api/mls/groups/:id/members` is members-only by design (audit S5: the device list leaks
 * social graph and device topology), so for the ONE case where the honest answer is "you are not a
 * member" the call is CERTAIN to be refused. That makes the 403 an ANSWER, not a failure - and the
 * distinction has to survive the throw, because the caller that asks this question retires a
 * conversation on "no" and must keep operating on "could not tell".
 *
 * Typed rather than message-matched, for the same reason as {@link DeviceRevokedError}: a
 * distinction carried in prose is one exactly one call site will make.
 */
export class NotAGroupMemberError extends Error {
  constructor(readonly groupId: string) {
    super(`Caller is not a member of group ${groupId}`);
    this.name = 'NotAGroupMemberError';
  }
}

/**
 * The delivery service ANSWERED 409 `awaiting_admission`: this account holds a seat in `groupId`
 * that an invitation link wrote and no member has admitted yet - a pending member who WAITS, never
 * {@link NotAGroupMemberError}'s "not a member", on which a caller retires the conversation.
 *
 * Every membership-gated read refuses such a seat this way (`callerSeatStanding` on the server,
 * review of #2358). Typed at the throw so a caller reads `instanceof` rather than a status beside a
 * body field; an {@link ApiRefusalError} still, so a reader of the status alone keeps working.
 */
export class AwaitingAdmissionError extends ApiRefusalError {
  constructor(readonly groupId: string) {
    super(
      409,
      'awaiting_admission',
      `group ${groupId}: this account's seat awaits a member's admission (409 awaiting_admission)`
    );
    this.name = 'AwaitingAdmissionError';
  }
}

/**
 * {@link AwaitingAdmissionError} when `res` is the server's 409 `awaiting_admission`, else null. The
 * body is read from a CLONE, so a caller that classifies the response further is not starved; a 409
 * with any other body (another conflict) is not this answer.
 */
export async function awaitingAdmissionFrom(
  res: Response,
  groupId: string
): Promise<AwaitingAdmissionError | null> {
  if (res.status !== 409) return null;
  try {
    const body: unknown = await res.clone().json();
    if (
      body &&
      typeof body === 'object' &&
      (body as { error?: unknown }).error === 'awaiting_admission'
    ) {
      return new AwaitingAdmissionError(groupId);
    }
  } catch {
    // Not JSON: an edge page, not the delivery service's answer - the caller's own branch reads it.
    console.debug(
      `[AWAITING_ADMISSION] group ${groupId}: a 409 whose body is not JSON - not this answer`
    );
  }
  return null;
}

/**
 * The delivery service could not be ASKED: `fetch` itself rejected (no route, DNS, a reset
 * connection - on Tauri `plugin-http` rejects with the reqwest sentence, `error sending request
 * for url ...`, as a bare string). A status code is an answer; this is the absence of one, so
 * nothing was decided and the frame most probably never arrived.
 *
 * CLASSIFIED AT THE THROW so a caller reads `instanceof` and never the sentence - the sentence is
 * what reached the log as "unclassified" on the Mi 9T (2026-10-06). The raw rejection is kept in
 * `cause` for the log. A cancelled request (`AbortError`) is NOT this: somebody chose it.
 *
 * A {@link TransportFailureError}, so the one predicate (`isTransportFailure`) reads it without a
 * second `instanceof` beside it at every consumer.
 */
export class DeliveryUnreachableError extends TransportFailureError {
  constructor(cause: unknown) {
    super(cause, `[DELIVERY] the delivery service could not be reached: ${String(cause)}`);
    this.name = 'DeliveryUnreachableError';
  }
}

/**
 * How long one request of this device's key package round may stay unanswered before it is
 * reported as failed: {@link DeliveryDeadlineError}.
 *
 * A DEADLINE THAT TURNS A HANG INTO A TYPED ERROR, AND NOTHING ELSE. Nothing is retried, healed or
 * assumed when it fires: the round fails, tells its caller, and the join that was waiting for the
 * round refuses with a type. Without it, one request that never answers held the round - and every
 * external join queued behind it - for as long as the transport chose to hang. Generous on purpose
 * (a 50-package batch on a poor mobile link is slow, not dead): it bounds a hang, it does not time
 * a transfer.
 */
export const KEY_PACKAGE_REQUEST_DEADLINE_MS = 60_000;

/**
 * How long a WHOLE key package round (mint, checkpoint, native `invoke`, re-enrolment, every
 * request) may run before its caller stops waiting for it: {@link raceDeadline}.
 *
 * The per-request deadline bounds only HTTP. A native `invoke` cannot be aborted and a mint under
 * the MLS lock can hang, and either kept `keyPackageRoundsActive` above zero for ever: every join
 * parked and its group's flight never cleared. This bounds what the caller AWAITS, not the work:
 * see `generateKeyPackage` for what an abandoned round may still do. Above the per-request
 * deadline and above a slow PIN-unlock checkpoint (22 s measured), so it fires on a hang, never on
 * a slow round.
 */
export const KEY_PACKAGE_ROUND_DEADLINE_MS = 180_000;

/**
 * Stops WAITING for `work` after `ms`: rejects with {@link DeliveryDeadlineError} and leaves the
 * work running - it cannot be cancelled (a native `invoke`), only abandoned. No retry, no heal:
 * the caller learns the round failed, typed, and the late outcome of `work` goes to `onLate`.
 */
export function raceDeadline<T>(
  operation: string,
  work: Promise<T>,
  ms: number,
  onLate: (outcome: { ok: true } | { ok: false; error: unknown }) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      console.error(
        `[DELIVERY] ${operation} abandoned after ${ms} ms - the work may still finish in the background`
      );
      reject(new DeliveryDeadlineError(operation, ms));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        if (abandoned) onLate({ ok: true });
        else resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (abandoned) onLate({ ok: false, error });
        else reject(error);
      }
    );
  });
}

/**
 * A request of the key package round was ABANDONED because it exceeded its deadline. Not
 * {@link DeliveryUnreachableError} (the service WAS asked, it never answered) and not a status
 * code: nothing is established about the device, so the caller must not act on it.
 */
export class DeliveryDeadlineError extends Error {
  constructor(
    readonly operation: string,
    readonly deadlineMs: number
  ) {
    super(`[DELIVERY] ${operation} stayed unanswered for ${deadlineMs} ms`);
    this.name = 'DeliveryDeadlineError';
  }
}

/**
 * The delivery service refused an application frame because THIS DEVICE holds no leaf in the group.
 *
 * A membership row that is not `active` means the device is not in the ratchet tree, so whatever it
 * encrypts is undecryptable by construction for every member - the server used to accept such
 * frames and fan them out, which on production 2026-09-02 turned six messages into thirty rows of
 * ciphertext nobody could ever open (DM `7da231f8`).
 *
 * **TERMINAL FOR THE SEND, AND NOT LIFTED BY ANY RETRY**: only a Welcome or an external commit makes
 * this device a member, so re-posting the same frame is the shape that spins for ever. The recovery
 * is the one the ladder already owns, and the frame belongs back in the outbox until it runs.
 *
 * Typed rather than message-matched, for the reason every refusal here is: a distinction carried in
 * prose is one exactly one call site will make.
 */
export class SenderNotActiveError extends Error {
  constructor(
    readonly groupId: string,
    readonly status: string | null
  ) {
    super(
      `This device holds no leaf in group ${groupId}${status ? ` (membership ${status})` : ''}`
    );
    this.name = 'SenderNotActiveError';
  }
}

/**
 * Whom a staged commit removes, as its submission declares it: a whole person (`userId` alone, every
 * leaf of theirs) or one device of theirs.
 */
export type CommitRemoval = { userId: string; deviceId?: string };

/**
 * The delivery service ANSWERED 403 to `GET /groups/:id/exclusions`: this account is not on the
 * group's roster, while this device holds the group locally (it is asking because it is about to
 * answer or send in it).
 *
 * AN ANSWER ABOUT THE ROSTER, NOT ABOUT THIS DEVICE - and deliberately NOT a
 * {@link SenderNotActiveError}. The route refuses on `dm_group_members` alone, the send on this
 * device's membership row: a device `active` but roster-less sends freely. Classified as a send
 * refusal it ran the roster repair, which FORGETS THE TREE, on a device that was not broken (fourth
 * review of #1878) - a destructive repair is gated on proof, and only the send's own refusal is that
 * proof. Typed so its readers act on the answer (the outbox quotes by id only and lets the send
 * decide; an answerer sends nothing) rather than retry a blip, which parked replies for good.
 */
export class ExclusionsRefusedError extends ApiRefusalError {
  constructor(readonly groupId: string) {
    super(
      403,
      'not_on_roster',
      `The server refused the exclusion windows of group ${groupId}: this account is not on its roster`
    );
    this.name = 'ExclusionsRefusedError';
  }
}

/**
 * The delivery service refused an application frame with a 403 that is NOT `sender_not_active`:
 * the AUTHENTICATED caller is not allowed to send what this request claims (the gateway's
 * `AUTHZ FAIL caller != requester`, a token whose `sub` is not the frame's sender).
 *
 * **A STATUS CODE IS AN ANSWER, and this one is not lifted by asking again.** The outbox used to
 * treat it as a blip and re-post the same entries every minute (23 attempts on one bench phone,
 * 2026-10-10). It is an {@link ApiRefusalError} so the outbox reads the status from the TYPE, as it
 * already does for the 413; the dedicated class names WHICH endpoint refused.
 */
export class SendForbiddenError extends ApiRefusalError {
  constructor(readonly groupId: string) {
    super(403, null, `Message send refused with 403 for group ${groupId}`);
    this.name = 'SendForbiddenError';
  }
}

/**
 * The delivery service - or a proxy in front of it - ANSWERED an application frame with a 5xx.
 *
 * Typed at the throw so the outbox counts it by TYPE, never by the sentence: N of them in a row park
 * a text as failed (`MAX_CONSECUTIVE_SERVER_ERRORS` in `outbox.ts`, user 2026-10-18), while a
 * transport failure ({@link DeliveryUnreachableError}: nobody answered) never counts. A 5xx IS an
 * answer, whoever wrote it; `origin` says who, for the log line that has to tell a broken gateway
 * from a relay in front of it.
 */
export class SendServerError extends ApiRefusalError {
  constructor(
    readonly groupId: string,
    status: number,
    readonly origin: ResponseOrigin,
    /** The answer's `Retry-After`, in ms, or null when it sent none the client can read. */
    readonly retryAfterMs: number | null = null
  ) {
    super(status, null, `Message send answered ${status} (${origin}) for group ${groupId}`);
    this.name = 'SendServerError';
  }
}

/**
 * A `Retry-After` header in ms: delta-seconds, or an HTTP date read against `now`. `null` when
 * absent or unreadable - never a default, the caller keeps its own schedule. A date in the past is 0.
 */
export function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^[0-9]+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * A send was answered 403 by something IN FRONT of the gateway (the host's CrowdSec WAF 'Ban' page
 * is HTML): a verdict on the network path, none on the caller. NOT an {@link ApiRefusalError} on
 * purpose, so no reader mistakes it for an identity refusal and parks the entry; the outbox retries
 * it on the ladder and tells the user. Lifted by the ban expiring, never by signing in again.
 */
export class SendEdgeRefusedError extends Error {
  constructor(
    readonly groupId: string,
    readonly status: number
  ) {
    super(`Message send refused with ${status} by the edge (not the gateway) for group ${groupId}`);
    this.name = 'SendEdgeRefusedError';
  }
}

/**
 * The delivery service refused a frame because the GROUP is no longer a destination - tombstoned in
 * `dm_groups`, or gone from it altogether.
 *
 * **TERMINAL, AND FOR EVERYONE**: unlike {@link SenderNotActiveError}, which says this device is not
 * in a group that still exists, this says the group itself ended. No Welcome, no external commit and
 * no retry brings it back, and a frame queued for it could never be decrypted or acknowledged by
 * anybody.
 *
 * IT IS RAISED ON A RACE THE CLIENT CANNOT WIN ALONE. `flushOne` already refuses to send into a
 * group whose `deletedAt` it knows, but that fact is read over a round trip and the deletion can
 * land inside it - measured 2026-09-05, a delete's sweep running between a send's recipient
 * resolution and its enqueue, leaving two rows undeliverable for ever. The server is the only place
 * the liveness and the write are one transaction, so this refusal is the answer it owes.
 */
export class GroupDeletedError extends Error {
  constructor(readonly groupId: string) {
    super(`Group ${groupId} no longer exists on the server`);
    this.name = 'GroupDeletedError';
  }
}

/**
 * The server refused a membership mutation because a BLOCK stands between the two people.
 *
 * Typed rather than message-matched, like every other refusal here: the neutral wording the server
 * sends is meant for a human, and a client that read it to make a decision would break the day it is
 * translated. The discriminator is the `USER_BLOCKED` code the server puts in the body.
 *
 * A caller normally never sees this, because both creation paths ask `isBlockedWith` before they
 * build anything. It is the backstop for the case they cannot cover - a block set between the
 * pre-flight and the commit.
 */
export class UserBlockedError extends Error {
  constructor(readonly userId: string) {
    super(`A block stands between the caller and ${userId}`);
    this.name = 'UserBlockedError';
  }
}

/**
 * The server refused a Welcome because the conversation's roster does not name its target
 * (`403 WELCOME_TARGET_NOT_MEMBER`, `POST /api/mls/welcome`).
 *
 * TERMINAL FOR THAT WELCOME, and typed so a sender can stop on it: the server enrols the person an Add
 * admits in the same transaction that accepts the commit, so a target still off the roster departed
 * after the Add was built, is separated from the sender by a block, or was admitted by a commit the
 * server did not enrol them for (a committer without a seat, a server older than the enrolment). Sending the same bytes again changes none of these; an Add that would is a new
 * commit with a Welcome of its own. Until 2026-10-25 this was an untyped `Error`, and the settlement
 * of a lost-answer Add re-sent its refused Welcome at every connection, for ever.
 */
export class WelcomeTargetNotMemberError extends Error {
  constructor(
    readonly groupId: string,
    readonly targetUserId: string,
    readonly targetDeviceId: string
  ) {
    super(
      `the Welcome of ${groupId.slice(0, 8)}... to ${targetUserId}:${targetDeviceId} was refused - ` +
        'the roster does not name its target'
    );
    this.name = 'WelcomeTargetNotMemberError';
  }
}

/**
 * A group EXIT the server answered with a refusal - the answer being the point.
 *
 * `DELETE /api/mls/groups/:id` and `DELETE /api/mls/groups/:id/members/:user` are the two calls that
 * take this device out of a group, and both are replayed by
 * {@link $lib/utils/chat/pendingGroupExits.drainPendingGroupExits} after a link comes back. That
 * drain has exactly one decision to make - is the exit still owed - and only a STATUS answers it: a
 * 404 or a 403 says the group is gone or this user is already out, which is the end state the exit
 * was asking for, while a 500 says the server is there and unhappy and the call must be kept.
 *
 * Typed, and carrying `status` as a NUMBER, for the reason `NotAGroupMemberError` states: the drain
 * used to have `Delete failed: ${status}` and nothing else, and a distinction carried in prose is a
 * distinction exactly one call site will ever make - by parsing a sentence, which is how the next
 * message edit breaks it silently.
 */
export class GroupExitRefusedError extends Error {
  constructor(
    readonly groupId: string,
    readonly status: number,
    readonly operation: 'delete' | 'leave'
  ) {
    super(`Group ${operation} refused for ${groupId}: ${status}`);
    this.name = 'GroupExitRefusedError';
  }
}

export type MlsDeliveryApiOptions = {
  historyUrl: string;
  getToken: () => Promise<string>;
  /** Defaults to `globalThis.fetch` (browser); Tauri passes `plugin-http` fetch. */
  fetchImpl?: MlsDeliveryFetch;
};

/**
 * All HTTP traffic to chat-delivery (`/api/mls/*`) shared by Web (WASM) and Tauri (native MLS).
 * Platform services keep WebSocket + crypto; they delegate delivery REST here.
 */
export class MlsDeliveryApi {
  readonly historyUrl: string;
  userId = 'unknown';
  deviceId = 'pending';

  private readonly getToken: () => Promise<string>;
  private readonly f: MlsDeliveryFetch;
  /** Key-package 404 reasons this build did not know and has already warned about (once each). */
  private readonly unknownKeyPackageReasonsWarned = new Set<string>();

  constructor(opts: MlsDeliveryApiOptions) {
    this.historyUrl = opts.historyUrl;
    this.getToken = opts.getToken;
    this.f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Runs one request - the call AND the reading of its body - under
   * {@link KEY_PACKAGE_REQUEST_DEADLINE_MS}, aborting it and throwing {@link DeliveryDeadlineError}
   * when the deadline passes. `AbortController` and not `AbortSignal.timeout`, which the oldest
   * WKWebView this ships to lacks (see `ackRetry.ts`).
   */
  private async underDeadline<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const abort = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      abort.abort();
    }, KEY_PACKAGE_REQUEST_DEADLINE_MS);
    try {
      return await run(abort.signal);
    } catch (e) {
      if (expired) {
        console.warn(
          `[DELIVERY] ${operation} abandoned after ${KEY_PACKAGE_REQUEST_DEADLINE_MS} ms - a hang is reported as a failure, never healed`
        );
        throw new DeliveryDeadlineError(operation, KEY_PACKAGE_REQUEST_DEADLINE_MS);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The headers every `/api/mls/*` request carries: the bearer token, and WHICH DEVICE IS ASKING.
   *
   * `X-Canari-Device` is here rather than at a call site because the device id is known in exactly
   * one place and every future log line that wants it would otherwise need its own plumbing. It is
   * self-asserted and DIAGNOSTIC ONLY - nginx authenticates the USER alongside it and no server
   * decision reads it, so the most a client can do by lying is misattribute its own request inside
   * its own account. Nginx forwards it untouched: the `/api/mls/` block only SETS `X-User-Id` and
   * friends from the auth subrequest, and client headers it does not name pass through.
   *
   * `'pending'` travels like any other value. It is the client's own literal for an unresolved
   * identity, the server already knows it as one, and a log line reading `device=pending` names a
   * real condition - a request made before `resolveDeviceId` finished - which is exactly the kind of
   * thing this field exists to surface.
   */
  private async auth(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, 'X-Canari-Device': this.deviceId, ...extra };
  }

  private uint8ToB64(bytes: Uint8Array): string {
    return toBase64(bytes);
  }

  /**
   * Fire-and-forget POST to the delivery service, resolving with the JSON body the server sent, or
   * `null` when it sent none (transport failure, non-2xx, non-JSON) - see `deliveryKeepalivePost`.
   */
  async deliveryPost(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    return deliveryKeepalivePost(
      this.historyUrl,
      path,
      body,
      await this.auth({ 'Content-Type': 'application/json' })
    );
  }

  /** ACKs queue message ids with retry/backoff and sessionStorage persistence. */
  async ackMessages(messageIds: string[]): Promise<void> {
    await ackMessagesWithRetry(
      this.historyUrl,
      await this.auth({ 'Content-Type': 'application/json' }),
      { userId: this.userId, deviceId: this.deviceId, messageIds }
    );
  }

  /**
   * Raw JSON rows from `GET /api/mls/messages/:userId/:deviceId` (pending queue), page by page.
   *
   * The deadline is per PAGE and never spans the whole pull. A backlog is drained across as many
   * requests as it takes, so a budget covering all of them is a budget a device far enough behind
   * can never meet - and because nothing is ingested or ACKed until the pull returns, its queue then
   * only grows and it can never catch up (WP-PENDING-1, measured: 5 526 rows = 12 pages, aborted at
   * 10 s on every reconnect). Each page is therefore handed to `onPage` the moment it lands, so an
   * attempt that dies half-way still made progress the next one keeps.
   *
   * That per-page deadline measures SILENCE, not elapsed time ({@link PENDING_PAGE_STALL_MS}). The
   * deadline and the halving below are a detector and a response, not two answers to one question:
   * the deadline decides when to stop waiting, the ladder decides what to ask next, and neither can
   * do the other's job.
   */
  async pullPendingMessagesJson(opts?: {
    /** The longest SILENCE tolerated on one page. Defaults to {@link PENDING_PAGE_STALL_MS}. */
    stallTimeoutMs?: number;
    /** Receives each page as it lands; when set, pages are not accumulated in memory. */
    onPage?: (rows: unknown[]) => Promise<void> | void;
  }): Promise<unknown[]> {
    if (this.userId === 'unknown') return [];

    const stallTimeoutMs = opts?.stallTimeoutMs ?? PENDING_PAGE_STALL_MS;
    const all: unknown[] = [];
    let pageLimit = 500;
    let afterCreatedAt: string | undefined;

    while (true) {
      const url = new URL(`${this.historyUrl}/api/mls/messages/${this.userId}/${this.deviceId}`);
      url.searchParams.set('limit', String(pageLimit));
      if (afterCreatedAt) url.searchParams.set('after', afterCreatedAt);
      // The same declaration the socket makes: the server hands an ADDRESSED row only to a session
      // that applies rule 5 (history-answer-addressing, rule 6), and withholds it from any other.
      url.searchParams.set('caps', ADDRESSED_HISTORY_CAPABILITY);

      let batch: Array<{ createdAt?: string }>;
      // OUTSIDE the try below: a token that cannot be had is not a page asked for too big. It used to
      // be inside, so the offline cold start's refresh failure walked the whole ladder - eight
      // requests, 250 down to 1, none of which ever left the device (Mi 9T, 2026-10-15).
      const headers = await this.auth();
      try {
        const page = await fetchJsonUnderProgressDeadline<Array<{ createdAt?: string }>>(
          this.f,
          url.toString(),
          { headers },
          stallTimeoutMs
        );
        if (!page.ok) break;
        batch = page.body;
      } catch (e) {
        // A TRANSPORT FAILURE IS NOT A SIZE PROBLEM. Nobody answered, so no smaller question can get
        // a different answer from the same dead link: halving it eight times was eight warn lines and
        // eight requests against a fact (`transportFailure.ts`). A body that STARTED and died is not
        // that: `fetchJsonUnderProgressDeadline` types it `BodyInterruptedError` (never a
        // `TypeError`, on either platform), and it halves like a stall - an answer too big to arrive.
        if (isTransportFailure(e)) throw e;
        // A page that does not arrive is a page ASKED FOR TOO BIG, until proven otherwise. Measured
        // on production: a device whose frames carried media needed 12 MB for 500 rows, timed out on
        // the deadline above having received nothing, ACKed nothing, and met the same 12 MB on every
        // later attempt - a closed loop, and the queue only grew. The server now bounds a page in
        // bytes, but the client must not depend on the server being new: halving is what makes an
        // OLD server survivable too, and what covers a link too slow for any fixed budget.
        //
        // Halving, never waiting: the retry changes the REQUEST, so it terminates on a proof - a
        // page of one row is the smallest question that can be asked, and failing that is a genuine
        // transport failure rather than an oversized answer. Nine steps at most, no clock anywhere.
        //
        // The reason travels with the error, so the line SEPARATES the two failures halving treats
        // alike: a server that never started answering (the size question) from a transfer that
        // started and stopped (the link). Nine identical "did not arrive" lines said neither.
        if (pageLimit > 1) {
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          console.warn(
            `[PENDING] page did not arrive (${String(e)}) - retrying with limit=${pageLimit}`
          );
          continue;
        }
        throw e;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;

      if (opts?.onPage) await opts.onPage(batch);
      else all.push(...batch);

      // TERMINATION IS AN EMPTY PAGE, never a short one. A short page used to mean "the queue is
      // exhausted", which was an INFERENCE from the row limit being the only thing that bounded a
      // page - and it stopped being true the moment the server started capping a page in bytes.
      // Measured on production the day that shipped: the server capped a 500-row request at 53
      // rows / 1 039 524 bytes, the client read 53 < 500 as the end of the queue, and stopped with
      // 870 frames still waiting. It would have taken one reconnection per page. An empty page is
      // the only answer that PROVES there is nothing left, and it costs one extra request.

      const lastCreatedAt = batch[batch.length - 1]?.createdAt;
      if (!lastCreatedAt || lastCreatedAt === afterCreatedAt) break;
      afterCreatedAt = lastCreatedAt;
    }

    return all;
  }

  private decodeKeyPackageBase64(keyPackageB64: string): Uint8Array {
    return fromBase64(keyPackageB64);
  }

  /**
   * Asks the server whether the named device is denylisted.
   *
   * Gates a destructive action on a server fact: the `device_revoked` control frame asks a device
   * to erase itself, and a frame is a message rather than an authority. Answers `false` when the
   * question cannot be reached - **a transport failure is not a verdict**, and erasing a device
   * because the network was down would be the worst possible reading of it.
   *
   * TAKES ITS IDS EXPLICITLY, unlike its neighbours that read `this.userId`, because the answer
   * decides whether a device erases itself and the ambient fields are `'unknown'` / `'pending'`
   * until `init()` has run. Asking about `unknown` would answer "not revoked" for a reason that
   * has nothing to do with revocation - a wrong answer no caller could see was wrong.
   */
  async isDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/revoked`,
        { headers: await this.auth() }
      );
      if (!res.ok) {
        console.warn(`[MLS] revocation check answered ${res.status} - treated as NOT revoked`);
        return false;
      }
      const d = (await res.json()) as { revoked?: boolean };
      return d.revoked === true;
    } catch (e) {
      console.warn(`[MLS] revocation check unreachable - treated as NOT revoked: ${String(e)}`);
      return false;
    }
  }

  /**
   * Every MLS signature key a device has published, oldest first - what a Graine v2 endorsement is
   * checked against once the minter's device has left the key group's tree (channel-encryption
   * section 21.3).
   *
   * An empty list is an ANSWER ("this device endorsed nothing checkable") and `unanswered` is not:
   * an unreachable server says nothing about the device, and the caller must not refuse a seed for
   * ever on it.
   */
  async fetchDeviceSignatureKeys(userId: string, deviceId: string): Promise<DeviceSignatureKeys> {
    let res: Response;
    try {
      res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/signature-keys`,
        { headers: await this.auth() }
      );
    } catch (e) {
      return { kind: 'unanswered', detail: `unreachable: ${String(e).slice(0, 120)}` };
    }
    if (!res.ok) return { kind: 'unanswered', detail: `HTTP ${res.status}` };
    try {
      const d = (await res.json()) as { keys?: unknown; firstSeen?: unknown };
      if (!Array.isArray(d.keys) || !d.keys.every((k) => typeof k === 'string')) {
        return { kind: 'unanswered', detail: 'a 200 with no key list in it' };
      }
      const keys = (d.keys as string[]).map((k) => fromBase64(k));
      if (!Array.isArray(d.firstSeen)) return { kind: 'keys', keys };
      // A malformed entry is dropped, never given a date: an undated key reads as OLD, the side
      // that announces nothing.
      const firstSeen: Array<{ key: Uint8Array; firstSeenAt: number }> = [];
      let dropped = 0;
      for (const entry of d.firstSeen as unknown[]) {
        const e = entry as { signatureKey?: unknown; firstSeenAt?: unknown };
        const at = typeof e?.firstSeenAt === 'string' ? Date.parse(e.firstSeenAt) : NaN;
        if (typeof e?.signatureKey !== 'string' || Number.isNaN(at)) {
          dropped++;
          continue;
        }
        firstSeen.push({ key: fromBase64(e.signatureKey), firstSeenAt: at });
      }
      if (dropped > 0) {
        console.error(
          `[MLS] ${dropped} malformed key age(s) for ${deviceId.slice(0, 12)}... dropped`
        );
      }
      return { kind: 'keys', keys, firstSeen };
    } catch (e) {
      return { kind: 'unanswered', detail: `unreadable body: ${String(e).slice(0, 120)}` };
    }
  }

  /**
   * Fetches a single device's consumable KeyPackage (no 30-day list cutoff).
   * Used when pending invitations reference a device not returned by {@link fetchUserDevices}.
   *
   * ANSWERS IN THREE SHAPES AND NEVER IN `null` - see {@link DeviceKeyPackageAnswer} for the defect
   * that made the distinction load-bearing. A 404 is an ANSWER and carries the server's reason;
   * anything else - a 5xx, a gateway error, an unreachable network, a body that does not parse -
   * is `unanswered`, which establishes nothing about the device and must not be acted on.
   */
  async fetchDeviceKeyPackage(userId: string, deviceId: string): Promise<DeviceKeyPackageAnswer> {
    // UNDER THE DEADLINE, because the wait of an external join reads this to learn whether its own
    // device is published: a hang here must be an `unanswered`, not a join that never ends.
    try {
      return await this.underDeadline('device-key-package', (signal) =>
        this.fetchDeviceKeyPackageOnce(userId, deviceId, signal)
      );
    } catch (e) {
      if (e instanceof DeliveryDeadlineError) return { kind: 'unanswered', detail: e.message };
      throw e;
    }
  }

  private async fetchDeviceKeyPackageOnce(
    userId: string,
    deviceId: string,
    signal: AbortSignal
  ): Promise<DeviceKeyPackageAnswer> {
    let res: Response;
    try {
      res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/key-package`,
        { headers: await this.auth(), signal }
      );
    } catch (e) {
      return { kind: 'unanswered', detail: `unreachable: ${String(e).slice(0, 120)}` };
    }

    if (res.status === 404) {
      // The reason is the server's, classified where it is known, and every delivery service since
      // 2026-09-16 sends one. A 404 WITHOUT one is therefore not the delivery service answering (a
      // proxy, a missing route): it establishes nothing about the device, so it is `unanswered`,
      // and the caller logs its `detail` (once per sweep). A reason this build does not know IS an
      // answer - a newer server refusing for a cause added after this build - so it is
      // `unrecognized`, which retires nothing (`refusalRetiresInvitation`). It is warned about ONCE
      // per reason for this client's life: every sweep meets it again, and the state change is
      // what a reader needs, not the heartbeat.
      const raw = await res
        .json()
        .then((b: { reason?: unknown }) => b?.reason)
        .catch(() => undefined);
      if (typeof raw !== 'string' || raw.length === 0) {
        return { kind: 'unanswered', detail: 'a 404 with no reason in it' };
      }
      if (raw === 'revoked' || raw === 'unregistered' || raw === 'expired') {
        return { kind: 'none', reason: raw };
      }
      const shown = sanitizeForLog(raw.slice(0, 40));
      if (!this.unknownKeyPackageReasonsWarned.has(shown)) {
        this.unknownKeyPackageReasonsWarned.add(shown);
        console.warn(
          `[MLS] key-package 404 names a reason this build does not know: ${shown} - nothing is retired on it`
        );
      }
      return { kind: 'none', reason: 'unrecognized' };
    }

    if (!res.ok) {
      return { kind: 'unanswered', detail: `HTTP ${res.status}` };
    }

    try {
      const d = await res.json();
      if (typeof d.keyPackage !== 'string' || typeof d.deviceId !== 'string') {
        // A 200 whose body is not a key package is the server failing to answer, not the device
        // failing to exist. Reading it as "absent" is what put this whole seam on the wrong side.
        return { kind: 'unanswered', detail: 'a 200 with no key package in it' };
      }
      return {
        kind: 'package',
        device: {
          keyPackage: this.decodeKeyPackageBase64(d.keyPackage),
          deviceId: d.deviceId,
          deviceName: typeof d.deviceName === 'string' ? d.deviceName : undefined,
          deviceOs: typeof d.deviceOs === 'string' ? d.deviceOs : undefined,
          deviceAppVersion: typeof d.deviceAppVersion === 'string' ? d.deviceAppVersion : undefined,
        },
      };
    } catch (e) {
      return { kind: 'unanswered', detail: `unreadable body: ${String(e).slice(0, 120)}` };
    }
  }

  /**
   * Fetches KeyPackages for all active devices of `userId`.
   *
   * THROWS on transport/HTTP failure (network down, non-2xx): a `[]` must NEVER be
   * indistinguishable from a failure (see audit S2). Returns `[]` only for a genuine 200 with no
   * device. Best-effort callers (creation, KeyPackage fallback) opt in explicitly via
   * `.catch(() => [])`; the invitation path lets the error propagate so it never invites a
   * silent subset of members.
   */
  async fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      /** The `userId` asked for, carried so an Add can check each package names this device. */
      userId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  > {
    // SIMULTANEOUS ASKERS SHARE ONE REQUEST (WP-W4): a boot asked for the account's own device list
    // three times - the pending-invitation sweep, the welcome-request answer and the group
    // reconcile each sent theirs. The entry lives as long as the request, so no answer is served
    // older than the request a caller joined (see {@link joinInFlight}).
    return this.joinInFlight(`${userId}:devices`, async () => {
      const res = await this.f(`${this.historyUrl}/api/mls/devices/${userId}`, {
        headers: await this.auth(),
      });
      if (!res.ok) throw await refusalFromResponse(res, 'fetchUserDevices failed');
      // Raw device rows as returned by the server (untyped JSON). Optional metadata fields
      // are re-validated with `typeof` below before being kept.
      const devices = (await res.json()) as Array<{
        keyPackage: string;
        deviceId: string;
        deviceName?: string;
        deviceOs?: string;
        deviceAppVersion?: string;
      }>;

      return devices.map((d) => ({
        keyPackage: this.decodeKeyPackageBase64(d.keyPackage),
        deviceId: d.deviceId,
        userId,
        deviceName: typeof d.deviceName === 'string' ? d.deviceName : undefined,
        deviceOs: typeof d.deviceOs === 'string' ? d.deviceOs : undefined,
        deviceAppVersion: typeof d.deviceAppVersion === 'string' ? d.deviceAppVersion : undefined,
      }));
    });
  }

  /**
   * Adds `userId` to the server-side member list of `groupId` (idempotent).
   *
   * ONE refusal is raised and the rest are logged. A 403 carrying `USER_BLOCKED` is the server
   * stating a fact the caller has to act on - the person may not be added, and a group that
   * pretended otherwise would show a member the server does not have. Every other non-2xx keeps the
   * historical tolerance of this call, which callers up and down the invite path rely on, but it no
   * longer passes in silence: an HTTP failure was swallowed here without so much as a line, since
   * `f` resolves rather than throwing on a bad status and only transport errors reached the catch.
   */
  async registerMember(groupId: string, userId: string): Promise<void> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ userId }),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      if (res.status === 403 && body.includes('USER_BLOCKED')) {
        throw new UserBlockedError(userId);
      }
      console.error(`registerMember refused: group=${groupId} user=${userId} status=${res.status}`);
    } catch (e) {
      if (e instanceof UserBlockedError) throw e;
      console.error('Failed to register member', e);
    }
  }

  /** Registers this device on the delivery service with its initial KeyPackage and metadata. */
  async registerDeviceKeyPackage(params: {
    keyPackageBase64: string;
    /**
     * When this package stops being usable, seconds since the epoch, read off its own MLS
     * `Lifetime` at mint time - see `DatedKeyPackage`. Sent as ISO 8601 because the column is a
     * timestamp and the server must not have to know this unit.
     */
    notAfterSecs: number;
    deviceName?: string;
    deviceOs: string;
    deviceAppVersion?: string;
  }): Promise<void> {
    await this.underDeadline('register-device', async (signal) => {
      const response = await this.f(`${this.historyUrl}/api/mls/register-device`, {
        method: 'POST',
        signal,
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          userId: this.userId,
          deviceId: this.deviceId,
          keyPackage: params.keyPackageBase64,
          notAfter: new Date(params.notAfterSecs * 1000).toISOString(),
          ...(params.deviceName ? { deviceName: params.deviceName } : {}),
          deviceOs: params.deviceOs,
          ...(params.deviceAppVersion ? { deviceAppVersion: params.deviceAppVersion } : {}),
        }),
      });

      if (!response.ok) {
        // TWO REFUSALS NO RETRY CAN FIX, both classified HERE because downstream they are one sentence.
        // 403 + DEVICE_REVOKED: the id itself is banned, and the cure is a fresh id.
        // 400 + DEVICE_LIMIT_REACHED: the ACCOUNT is full, and the cure is a person deleting a device.
        if (response.status === 403 || response.status === 400) {
          const body = await response
            .clone()
            .json()
            .then((b) => b as { code?: string; max?: number })
            .catch(() => undefined);
          if (response.status === 403 && body?.code === 'DEVICE_REVOKED') {
            throw new DeviceRevokedError(this.deviceId);
          }
          if (response.status === 400 && body?.code === 'DEVICE_LIMIT_REACHED') {
            throw new DeviceLimitReachedError(typeof body.max === 'number' ? body.max : null);
          }
        }
        throw await refusalFromResponse(response, 'Failed to publish KeyPackage');
      }
    });
  }

  /**
   * Uploads a batch of one-time prekeys (OTKP) to replenish the server-side prekey pool.
   *
   * **EACH ROW CARRIES ITS OWN EXPIRY, `{ keyPackage, notAfter }`, THE ONLY SHAPE THE SERVER
   * ACCEPTS.** The server cannot parse an MLS KeyPackage, so until 2026-09-16 it stored an opaque
   * string and could not tell an elapsed package from a fresh one - it served expired ones, and a
   * join built on one fails with `LifetimeError(Expired)` for ever.
   */
  async publishKeyPackages(packages: DatedKeyPackage[]): Promise<void> {
    const keyPackages = packages.map((kp) => ({
      keyPackage: this.uint8ToB64(kp.bytes),
      notAfter: new Date(kp.notAfterSecs * 1000).toISOString(),
    }));
    await this.underDeadline('publish-key-packages', async (signal) => {
      const response = await this.f(`${this.historyUrl}/api/mls/register-device/prekeys`, {
        method: 'POST',
        signal,
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          userId: this.userId,
          deviceId: this.deviceId,
          keyPackages,
        }),
      });
      if (!response.ok) {
        throw await refusalFromResponse(response, 'Failed to publish key packages');
      }
    });
  }

  /** Updates display metadata (name, OS, app version) for a device. */
  async updateDeviceMetadata(
    userId: string,
    deviceId: string,
    metadata: { deviceName?: string; deviceOs?: string; deviceAppVersion?: string }
  ): Promise<{
    status: string;
    deviceName: string | null;
    deviceOs: string | null;
    deviceAppVersion: string | null;
  }> {
    const response = await this.f(
      `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/metadata`,
      {
        method: 'PATCH',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(metadata),
      }
    );
    if (!response.ok) {
      throw await refusalFromResponse(response, 'Failed to update device metadata');
    }
    return await response.json();
  }

  /**
   * Delivers an MLS Welcome (and optional ratchet tree) to `targetUserId`.
   * If `targetDeviceId` is omitted, fans out to all active devices for that user.
   */
  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array,
    /** Tauri: when `targetDeviceId` is omitted, deliver only to the first online device (Web sends to all). */
    welcomeOpts?: { firstDeviceOnly?: boolean }
  ): Promise<void> {
    const base64 = this.uint8ToB64(welcomeBytes);
    const ratchetTreeBase64 = ratchetTreeBytes ? this.uint8ToB64(ratchetTreeBytes) : undefined;

    let deviceIds: string[];
    if (targetDeviceId) {
      deviceIds = [targetDeviceId];
    } else {
      const devices = await this.fetchUserDevices(targetUserId);
      deviceIds =
        welcomeOpts?.firstDeviceOnly && devices.length > 0
          ? [devices[0].deviceId]
          : devices.map((d) => d.deviceId);
    }
    if (deviceIds.length === 0) {
      throw new Error(`Cannot send secure invitation to ${targetUserId}: no active device found.`);
    }
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        const response = await this.f(`${this.historyUrl}/api/mls/welcome`, {
          method: 'POST',
          headers: await this.auth({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            targetDeviceId: deviceId,
            targetUserId,
            senderUserId: this.userId,
            welcomePayload: base64,
            ratchetTreePayload: ratchetTreeBase64,
            groupId,
          }),
        });
        // The one refusal a sender must act on, typed at the throw from the server's code.
        if (response.status === 403) {
          const refusal = await refusalFromResponse(response, 'Welcome delivery');
          if (refusal.code === 'WELCOME_TARGET_NOT_MEMBER') {
            throw new WelcomeTargetNotMemberError(groupId, targetUserId, deviceId);
          }
        }
        await assertOkMlsDeliveryResponse(
          response,
          `Welcome delivery to ${targetUserId}:${deviceId} (group ${groupId})`
        );
      })
    );
  }

  /**
   * Submits a staged MLS commit in one atomic server round-trip (`POST /api/mls/commit`): the
   * server validates the epoch (strict `baseEpoch == activeEpoch` under a Redis lock), and on
   * accept records it in the epoch-indexed commit-log (rung-1 replay backbone) AND fans it out to
   * members, skipping `excludeDeviceIds`. Returns the raw validation result so the caller merges
   * locally on accept / rolls back the staged commit on reject. Throws only on transport/HTTP
   * failure (not on a business reject). [[C7]]
   *
   * `groupInfoBase64` carries the external-join base for the epoch this commit CREATES
   * (`baseEpoch + 1`), and the server stores it in the same transaction as the epoch advance. Every
   * caller supplies it: the external join exports it from its applied instance, a staged add/remove
   * takes the GroupInfo OpenMLS built with the commit (COMM-22,
   * `docs/wiki/protocols/mls-protocol.md`). Only a legacy client omits it.
   *
   * `admits` names the devices this commit ADDS to the tree. The server records each `pending` at
   * the epoch the commit creates, in the same transaction as the advance, which makes it a recipient
   * of every frame sealed from then on while its Welcome waits for it (channel-encryption section
   * 20). Only a staged Add has any.
   *
   * `removes` names whom this commit REMOVES - a person, or one device of theirs. Their device rows
   * were deleted by the server's half of the removal, which ran first, so the server queues the
   * commit to the devices it parted for exactly these (`partingKey`, server side): the removed
   * devices receive the commit that removes them. Only a staged Remove has any.
   */
  async submitCommit(
    groupId: string,
    baseEpoch: number,
    protoBase64: string,
    excludeDeviceIds?: string[],
    groupInfoBase64?: string,
    admits?: Array<{ userId: string; deviceId: string }>,
    removes?: CommitRemoval[]
  ): Promise<{
    accepted: boolean;
    reason?: string;
    currentEpoch?: number;
    newEpoch?: number;
    /** True when the gate had ALREADY accepted these exact bytes: a resubmission, answered again. */
    duplicate?: boolean;
  }> {
    // UNDER THE `write` HEAD DEADLINE (`requestDeadline.ts`: 30 s plus the time the body needs to
    // leave), because every caller awaits this INSIDE THE GLOBAL MLS LOCK, which also guards the
    // incoming processing of every group: a POST hung on a half-open connection or a captive portal
    // froze decryption in every conversation for as long as the engine tolerated - and the periodic
    // leaf refresh makes an unasked commit ordinary. The expiry is a `RequestDeadlineError`, a
    // transport failure: NO ANSWER, never a refusal, because the gate may have accepted. The callers
    // already read it that way - `runCommitTransaction` resubmits the same bytes and KEEPS the stage
    // as unknown while no answer comes (`CommitOutcomeUnknownError`), and the next resubmission
    // decides, an accepted commit being answered as a duplicate.
    const res = await trackedFetch(
      this.f,
      `${this.historyUrl}/api/mls/commit`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          groupId,
          deviceId: this.deviceId,
          baseEpoch,
          proto: protoBase64,
          senderId: this.userId,
          ...(excludeDeviceIds?.length ? { excludeDeviceIds } : {}),
          ...(groupInfoBase64 ? { groupInfo: groupInfoBase64 } : {}),
          ...(admits?.length ? { admits } : {}),
          ...(removes?.length ? { removes } : {}),
        }),
      },
      { requestClass: 'write' }
    );
    if (!res.ok) {
      throw await refusalFromResponse(res, 'Commit submission HTTP error');
    }
    return res.json();
  }

  /**
   * Rung-1 replay: fetches the ordered, CONTIGUOUS commits the local client missed
   * (`baseEpoch >= sinceEpoch`) so it can apply them and catch up instead of dropping state
   * (`GET /api/mls/commits/:groupId`). `activeEpoch` is the epoch to reach after replay.
   *
   * Two terminating answers, rung-2 (re-Welcome) owed on either: `belowFloor` when the intermediate
   * commits were pruned, `gapAt` when an epoch inside the range was never recorded - `commits` then
   * carries only the applicable prefix, and nothing past `gapAt` is reachable.
   */
  async fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
    gapAt?: number;
  }> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/commits/${encodeURIComponent(groupId)}?sinceEpoch=${sinceEpoch}`,
      { headers: await this.auth() }
    );
    if (!res.ok) {
      throw await refusalFromResponse(res, 'Commit replay HTTP error');
    }
    return res.json();
  }

  /**
   * External-join base (Phase 4): fetches the latest stored GroupInfo for `groupId` so an authorized
   * member lacking MLS state can build an external commit to (re)join. Membership-gated server-side.
   * Returns null when no GroupInfo has been stored yet (caller falls back to a peer welcome_request).
   *
   * A 403 IS RAISED AS {@link NotAGroupMemberError}, for the reason it is on `getGroupMembers` next
   * door and with a sharper consequence. This endpoint is gated on a `dm_group_members` row, so the
   * status is the server answering the question the recovery seam is actually asking - and until it
   * was typed, that answer was flattened into `null` by the one caller and read as "nothing stored
   * yet", which is the state you retry. A group we had LEFT was therefore chased for as long as it
   * existed: one 403 and one broadcast asking to be re-added, every minute, terminating only if
   * somebody else happened to delete the group (GRP-6, 2026-08-24).
   *
   * Every other non-2xx stays unclassified, because none of them says anything about membership.
   */
  async fetchGroupInfo(
    groupId: string
  ): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/group-info/${encodeURIComponent(groupId)}`,
      { headers: await this.auth() }
    );
    if (res.status === 403) throw new NotAGroupMemberError(groupId);
    const awaiting = await awaitingAdmissionFrom(res, groupId);
    if (awaiting) throw awaiting;
    if (!res.ok) {
      throw await refusalFromResponse(res, 'GroupInfo fetch HTTP error');
    }
    const data = await res.json();
    // The server returns null (no body content) when nothing is stored.
    if (!data || typeof data.groupInfo !== 'string') return null;
    // `activeEpoch` defaults to the base, never to 0: an older server that does not send it must
    // read as "nothing known to be stale", where 0 would call every published base stale.
    return {
      groupInfo: data.groupInfo,
      baseEpoch: data.baseEpoch,
      activeEpoch: typeof data.activeEpoch === 'number' ? data.activeEpoch : data.baseEpoch,
    };
  }

  /**
   * Refreshes the stored GroupInfo for `groupId` (the committer calls this after each accepted commit;
   * a new group's first member-add is itself a commit). Membership-gated and monotonic server-side
   * (a lower baseEpoch is ignored).
   *
   * `stored: false` is the monotonic rule declining a base that is not newer, or an insert lost to
   * a concurrent first publish - both legitimate outcomes, neither a failure. A refresh may ignore
   * it; the caller initialising a group must not.
   */
  async storeGroupInfo(
    groupId: string,
    groupInfoBase64: string,
    baseEpoch: number
  ): Promise<{ stored: boolean }> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/group-info/${encodeURIComponent(groupId)}`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupInfo: groupInfoBase64, baseEpoch }),
      }
    );
    if (!res.ok) {
      throw await refusalFromResponse(res, 'GroupInfo store HTTP error');
    }
    const data = await res.json().catch(() => null);
    return { stored: data?.stored === true };
  }

  /**
   * Acquires a distributed Redis lock to serialise concurrent `addMember` commits on `groupId`.
   * Returns `false` if another device already holds the lock (caller should abort or retry).
   *
   * How long the lock lives is the SERVER's to decide (`ADD_LOCK_TTL_SEC`, sized on this client's
   * own worst case: bulk add + state persist + validated commit + the Welcome loop, H1). This used
   * to send a `ttlMs` no caller ever varied, and the background push door - which has no such
   * field - took the same lock for half as long.
   */
  async acquireAddLock(groupId: string): Promise<boolean> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/add-lock`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.acquired === true;
    } catch {
      // Fail-safe: cannot prove the lock was acquired → assume not acquired.
      // Returning true here would allow concurrent commits if Redis is temporarily
      // unavailable, which would fragment epochs and desync local WASM states.
      return false;
    }
  }

  /** Releases the add-lock previously acquired by {@link acquireAddLock}. Best-effort, non-throwing. */
  async releaseAddLock(groupId: string): Promise<void> {
    try {
      await this.f(`${this.historyUrl}/api/mls/add-lock`, {
        method: 'DELETE',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId }),
      });
    } catch {
      /* non-blocking */
    }
  }

  /** Creates a new group row on the delivery service and returns the assigned `groupId`. */
  async createRemoteGroup(name: string, isGroup: boolean): Promise<string> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/groups`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name,
          createdBy: this.userId,
          isGroup,
          creatorDeviceId: this.deviceId,
        }),
      });
      if (!res.ok) throw new Error('Failed to create remote group');
      const data = await res.json();
      return data.groupId as string;
    } catch (e) {
      console.error('Failed to create remote group', e);
      throw e;
    }
  }

  /**
   * Returns the number of one-time prekeys still available for this device on the server.
   *
   * A request that EXCEEDED ITS DEADLINE IS NOT A ZERO: it throws {@link DeliveryDeadlineError} and
   * fails the round, because reading it as `0` made both platforms mint and publish a full pool of
   * fifty against a server that never answered - the deadline would have become a heal.
   */
  async fetchPrekeyCount(): Promise<number> {
    try {
      return await this.underDeadline('prekey-count', async (signal) => {
        const res = await this.f(
          `${this.historyUrl}/api/mls/devices/${this.userId}/${this.deviceId}/prekeys/count`,
          { headers: await this.auth(), signal }
        );
        if (!res.ok) return 0;
        const data = await res.json();
        return typeof data.count === 'number' ? data.count : 0;
      });
    } catch (e) {
      if (e instanceof DeliveryDeadlineError) throw e;
      console.warn('[MLS] prekey count unreadable - read as 0:', String(e).slice(0, 200));
      return 0;
    }
  }

  /**
   * Purges server-side one-time prekeys for this device, and returns the ones it removed.
   *
   * THE PAYLOADS ARE THE POINT, and the caller cannot derive them. A row this call deletes was
   * still in the pool, which is the same as never having been handed out - so its private bundle
   * is provably dead and may be dropped locally. A row absent for any OTHER reason may be absent
   * because a peer is about to send the Welcome built on it, which is why nothing on the client
   * may reason from "the server does not list it". See `MlsManager::forget_key_packages`.
   *
   * THE FAILURE IS NO LONGER SWALLOWED. This was `.catch(() => {})`, so a purge that never reached
   * the server was indistinguishable from one that emptied the pool - and the caller went straight
   * on to mint fifty more against a pool it had not actually cleared. An empty list is what a
   * failure returns, because there is then nothing the device may safely forget, and the line
   * accuses so the leak coming back has a witness.
   *
   * @returns the base64 KeyPackages the server deleted; empty if the call failed or the pool was
   */
  async deleteAllOneTimePrekeys(): Promise<string[]> {
    try {
      return await this.underDeadline('prekey-purge', async (signal) => {
        const res = await this.f(
          `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys`,
          { method: 'DELETE', headers: await this.auth(), signal }
        );
        if (!res.ok) {
          console.warn(`[MLS] prekey purge refused with ${res.status}; nothing may be forgotten`);
          return [];
        }
        const data = await res.json();
        const list = Array.isArray(data?.keyPackages) ? data.keyPackages : [];
        return list.filter((k: unknown): k is string => typeof k === 'string' && k.length > 0);
      });
    } catch (e) {
      // A DEADLINE IS ACCUSED, not demoted to the warning an unreachable server earns: the caller
      // goes on to mint against a pool this call did not clear, and a hang is the cause to find.
      const log = e instanceof DeliveryDeadlineError ? console.error : console.warn;
      log('[MLS] prekey purge did not reach the server:', String(e).slice(0, 200));
      return [];
    }
  }

  /**
   * Lists the one-time prekeys published by this device (id + decoded payload) so the
   * client can locally validate which ones it still owns a private key for. Returns `[]` on error.
   */
  async listOwnPrekeys(): Promise<Array<{ id: string; keyPackage: Uint8Array }>> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys/list`,
        { headers: await this.auth() }
      );
      if (!res.ok) return [];
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => typeof r?.id === 'string' && typeof r?.keyPackage === 'string')
        .map((r) => ({
          id: r.id as string,
          keyPackage: this.decodeKeyPackageBase64(r.keyPackage),
        }));
    } catch {
      return [];
    }
  }

  /** Deletes targeted one-time prekeys by id (orphaned from their local private key). */
  async pruneOwnPrekeys(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.f(
      `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys/prune`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ids }),
      }
    ).catch(() => {});
  }

  /**
   * POSTs an already-encrypted MLS ciphertext to `/api/mls/send` without epoch validation. Used by
   * Tauri (native MLS handles epoch tracking internally).
   *
   * Both halves of `delivery` travel on the wire because the server holds ciphertext only and can
   * classify nothing itself: `silent` decides whether recipients are notified, `durable` whether
   * the frame is appended to the group's shared log.
   *
   * @returns the server's receive time for the frame (ms), or `null` when the answer carries none.
   */
  async postApplicationMessage(
    groupId: string,
    protoBase64: string,
    delivery: FrameDelivery = DELIVERY.visible
  ): Promise<number | null> {
    const headers = await this.auth({ 'Content-Type': 'application/json' });
    let res: Response;
    try {
      // UNDER A DEADLINE (WP-OFF-5, class `write`): a POST that never answers used to hold the whole
      // outbox lane for as long as the engine tolerated. Expiry is typed (`RequestDeadlineError`)
      // and surfaces below as `DeliveryUnreachableError`, i.e. a transport failure: the frame's
      // fate is unknown, so the outbox retries it as a NEW frame with the same inner messageId and
      // receivers deduplicate - the existing at-least-once rule, unchanged.
      res = await trackedFetch(
        this.f,
        `${this.historyUrl}/api/mls/send`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            senderId: this.userId,
            senderDeviceId: this.deviceId,
            groupId,
            proto: protoBase64,
            silent: delivery.silent,
            durable: delivery.durable,
            // Only when addressed: an absent field is "the whole group", which every older server
            // also reads it as - so a server predating it delivers to everyone, as before.
            ...(delivery.recipients ? { recipientDevices: delivery.recipients } : {}),
          }),
        },
        { requestClass: 'write' }
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      console.warn(`[DELIVERY] send to ${groupId.slice(0, 8)} could not be reached:`, e);
      throw new DeliveryUnreachableError(e);
    }
    if (!res.ok) {
      // CLASSIFIED AT THE THROW, because exactly one thing can be said about a `sender_not_active`
      // that cannot be said about any other failure here: no retry lifts it. See
      // {@link SenderNotActiveError}.
      if (res.status === 403) {
        // ORIGIN FIRST: an HTML/non-JSON 403 is the edge, not an answer about the caller.
        if (responseOrigin(res) === 'edge') {
          throw new SendEdgeRefusedError(groupId, res.status);
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
        };
        if (body.error === 'sender_not_active') {
          throw new SenderNotActiveError(groupId, body.status ?? null);
        }
        // ANY OTHER 403 is the caller refused outright - see {@link SendForbiddenError}.
        throw new SendForbiddenError(groupId);
      }
      // AND THE OTHER REFUSAL NO RETRY LIFTS, for the opposite reason: not "this device is not in
      // the group" but "there is no group". 410 is the delivery service refusing to queue rows for
      // a tombstone - see {@link GroupDeletedError}.
      if (res.status === 410) {
        throw new GroupDeletedError(groupId);
      }
      if (res.status >= 500) {
        throw new SendServerError(
          groupId,
          res.status,
          responseOrigin(res),
          parseRetryAfterMs(res.headers.get('retry-after'), Date.now())
        );
      }
      // STEP A's refusal to address a device that does not apply rule 5 - typed at the throw by the
      // `error` code the server sets, never by its sentence.
      if (res.status === 400 && delivery.recipients) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; devices?: unknown };
        if (body.error === 'addressed_unsupported') {
          throw new AddressedUnsupportedError(
            groupId,
            Array.isArray(body.devices) ? body.devices.map(String) : []
          );
        }
      }
      // ANY OTHER REFUSAL carries its status as a type too: an answer, which the outbox reads as
      // breaking a run of 5xx - a sentence could not be read back.
      throw new ApiRefusalError(res.status, null, `Message send HTTP error: ${res.status}`);
    }
    // The server's receive time for this frame - the `createdAt` every recipient's copy carries, and
    // the only server time the SENDER's own copy can ever get (it never receives its frame back). A
    // server predating the field, or an unreadable body, answers `null`: the frame WAS accepted, so
    // that is not a failure of the send, and the copy is placed by the rule for undated messages.
    const answered = (await res.json().catch((e: unknown) => {
      console.warn(
        `[DELIVERY] send to ${groupId.slice(0, 8)} accepted, its answer unreadable - the copy stays undated:`,
        e
      );
      return null;
    })) as { receivedAt?: unknown } | null;
    const receivedAt = answered?.receivedAt;
    return typeof receivedAt === 'number' && Number.isFinite(receivedAt) && receivedAt > 0
      ? receivedAt
      : null;
  }

  /**
   * Fetches one Redis Stream history page for a group, optionally paginated after `afterStreamId`.
   *
   * `until` is the INCLUSIVE upper bound for the walk - pass back the `head` the first page
   * returned, and the server never reads rows appended since (they belong to the delivery queue).
   * Returns an empty page on error.
   */
  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number,
    until?: string
  ): Promise<import('$lib/mls-client/historyTypes').HistoryPage> {
    try {
      const url = new URL(`${this.historyUrl}/api/mls/history/${groupId}`);
      if (afterStreamId) url.searchParams.set('after', afterStreamId);
      if (until) url.searchParams.set('until', until);
      const effectiveLimit = limit !== undefined ? String(limit) : afterStreamId ? '200' : '1000';
      url.searchParams.set('limit', effectiveLimit);
      const res = await this.f(url.toString(), {
        headers: await this.auth(),
      });
      // A REFUSAL AND AN EMPTY GROUP ARE THE SAME RETURN VALUE, so the refusal has to say so.
      //
      // This branch turned every non-ok status - 403 for a group the server has soft-deleted, 404,
      // a 500, a gateway error - into `{ rows: [] }`, which is exactly what a group with no history
      // returns. The caller then renders an empty conversation and there is nothing, anywhere, to
      // say the server was asked and refused: the sibling branch three lines below already warns
      // about a non-JSON body, and this one was the asymmetry. A status is an ANSWER; an answer
      // nobody records is one the next reader has to reproduce on a live browser.
      //
      // `warn` rather than `error` because it is not, on its own, a defect - the caller may
      // legitimately have raced a deletion. What makes it worth a line is that it is the ONLY
      // trace: `[HISTORY] refused` next to an empty conversation is the difference between a
      // diagnosis and a mystery.
      if (!res.ok) {
        console.warn(`[HISTORY] refused for group ${groupId}: ${res.status}`);
        return { rows: [] };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        console.warn(
          `[History] Non-JSON response for group ${groupId}. Received content-type: ${contentType || 'unknown'}`
        );
        return { rows: [] };
      }
      return {
        rows: await res.json(),
        head: res.headers.get('X-History-Head') ?? undefined,
      };
    } catch (e) {
      // A transport failure is not a defect of this call: it says so in one line, by its class,
      // with the same empty page the caller already handles. Anything else is one, and keeps its stack.
      if (isTransportFailure(e)) {
        console.warn(`[HISTORY] no answer for group ${groupId} - empty page: ${String(e)}`);
      } else {
        console.error('Fetch History Error:', e);
      }
      return { rows: [] };
    }
  }

  /**
   * Fetches the first history page for many groups, in as few round-trips as the server allows.
   *
   * The list is CHUNKED at {@link HISTORY_BATCH_MAX_GROUPS} because the server refuses anything
   * larger. It used to be sent whole, which meant a client with more conversations than the cap
   * sent one request that could only ever be refused - and the sequential re-fetch it then fell
   * back to made the catch-up cost exactly what it cost before the route existed. Measured on
   * production 2026-08-24: 110 conversations, one 400, 110 requests.
   *
   * A chunk the server refuses leaves its groups OUT of the map, and that is the whole handling.
   * There is no second way to fetch a page here: an absent group simply arrives at
   * `replayConversationHistory` unprimed and that replay reads its own first page, which is the
   * ordinary path every group took before any of this existed.
   */
  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryPage>> {
    const out = new Map<string, import('$lib/mls-client/historyTypes').HistoryPage>();
    for (let i = 0; i < groups.length; i += HISTORY_BATCH_MAX_GROUPS) {
      await this.fetchHistoryBatchChunk(groups.slice(i, i + HISTORY_BATCH_MAX_GROUPS), out);
    }
    return out;
  }

  /**
   * One `POST /api/mls/history/batch`, writing what it gets into `out`.
   *
   * Never throws: a chunk that fails is a defect to READ, not a branch for the caller to take, so
   * it is logged with the status AND the server's own words - a status alone cannot tell a refused
   * request from an unreachable one, and it was a bare status that let the cap go unnoticed.
   */
  private async fetchHistoryBatchChunk(
    chunk: Array<{ groupId: string; afterStreamId?: string }>,
    out: Map<string, import('$lib/mls-client/historyTypes').HistoryPage>
  ): Promise<void> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/history/batch`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          groups: chunk.map((g) => ({
            groupId: g.groupId,
            after: g.afterStreamId,
          })),
        }),
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.toLowerCase().includes('application/json')) {
        console.error(
          `[History] batch of ${chunk.length} group(s) refused: ${res.status} ` +
            `content-type=${contentType || 'unknown'} body=${(await res.text()).slice(0, 200)}`
        );
        return;
      }
      const data = (await res.json()) as {
        histories?: Record<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]>;
        heads?: Record<string, string>;
      };
      for (const [groupId, rows] of Object.entries(data.histories ?? {})) {
        out.set(groupId, { rows: rows ?? [], head: data.heads?.[groupId] });
      }
    } catch (e) {
      if (isTransportFailure(e)) {
        console.warn(
          `[History] batch of ${chunk.length} group(s) got no answer - each replays its own page: ${String(e)}`
        );
      } else {
        console.error(`[History] batch of ${chunk.length} group(s) could not be sent:`, e);
      }
    }
  }

  /** Renames a group on the server. Throws on non-2xx. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}`, {
      method: 'PATCH',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await refusalFromResponse(res, 'Rename failed');
  }

  /** Sets or clears (mediaId=null) the group's avatar on the server. Throws on non-2xx. */
  async setGroupImage(groupId: string, mediaId: string | null): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/image`, {
      method: 'PATCH',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ mediaId }),
    });
    if (!res.ok) throw await refusalFromResponse(res, 'setGroupImage failed');
  }

  /** Soft-deletes `groupId` on the server. Returns `false` if already absent (404). */
  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}`, {
      method: 'DELETE',
      headers: await this.auth(),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new GroupExitRefusedError(groupId, res.status, 'delete');
    return true;
  }

  /** Removes `userId` from the server-side member list of `groupId`. */
  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
      headers: await this.auth(),
    });
    // A 404 (no such group) and a 403 (not a member of it) are both the server ANSWERING that this
    // user is already out - which is what a leave asks for - and they reach the caller as a status it
    // can act on rather than as a sentence it would have to read.
    if (!res.ok) throw new GroupExitRefusedError(groupId, res.status, 'leave');
  }

  /**
   * A member's Decline of a person who asked to join by invitation link: the server withdraws their
   * seat ONLY while it still awaits a member's admission, under the group's seat lock. Every outcome
   * is an answer (200) - see {@link JoinDeclineOutcome}; a non-2xx (not an admitted member) throws.
   */
  async declineJoinRequest(groupId: string, userId: string): Promise<JoinDeclineOutcome> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/groups/${groupId}/join-requests/${userId}/decline`,
      { method: 'POST', headers: await this.auth() }
    );
    if (!res.ok) throw await refusalFromResponse(res, 'declineJoinRequest failed');
    const body = (await res.json()) as { outcome?: unknown };
    const outcome = JOIN_DECLINE_OUTCOMES.find((o) => o === body.outcome);
    if (!outcome) {
      throw new Error(`declineJoinRequest: unknown outcome ${JSON.stringify(body.outcome)}`);
    }
    return outcome;
  }

  /**
   * Returns the current device-level member list (dm_device_group_memberships) for `groupId`.
   * THROWS on transport/HTTP failure: a `[]` must not mask a network failure (audit S2).
   * Returns `[]` only for a genuine 200 with no member. Tolerant callers opt in via `.catch`.
   *
   * A 403 is raised as {@link NotAGroupMemberError} and NOT as a generic failure: the endpoint is
   * members-only, so that status is the server stating the very fact the caller asked about. Every
   * other non-2xx stays unclassified, because none of them says anything about membership.
   */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members`, {
      headers: await this.auth(),
    });
    if (res.status === 403) throw new NotAGroupMemberError(groupId);
    const awaiting = await awaitingAdmissionFrom(res, groupId);
    if (awaiting) throw awaiting;
    if (!res.ok) throw await refusalFromResponse(res, 'getGroupMembers failed');
    return await res.json();
  }

  /**
   * Returns user-level members from dm_group_members for `groupId`.
   * THROWS on transport/HTTP failure: a `[]` must not mask a network failure (audit S2).
   * Returns `[]` only for a genuine 200 with no member. Tolerant callers opt in via `.catch`.
   * A seat still awaiting a member's admission is answered {@link AwaitingAdmissionError}.
   */
  getGroupUserMembers(groupId: string): Promise<GroupUserMemberRow[]> {
    // Simultaneous askers share ONE request (membership guards, stray sweeps and peer resolution all
    // ask per conversation). Never held past the answer: callers decide security and repairs on it.
    return this.joinInFlight(`user-members:${groupId}`, async () => {
      const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/user-members`, {
        headers: await this.auth(),
      });
      const awaiting = await awaitingAdmissionFrom(res, groupId);
      if (awaiting) throw awaiting;
      if (!res.ok) throw await refusalFromResponse(res, 'getGroupUserMembers failed');
      return await res.json();
    });
  }

  /**
   * The windows during which each current member of `groupId` was out of it - what a history answer
   * must withhold (user, 2026-10-14: a Remove holds against a later re-add).
   *
   * Throws on any transport or HTTP failure, and on an answer it cannot parse: the caller cannot
   * prove what may be sent without it, so it sends nothing and says so. Simultaneous askers share one
   * request; nothing is kept past the answer.
   *
   * CLASSIFIED AT THE THROW: a gateway 403 is {@link ExclusionsRefusedError} (this account is not on
   * the roster - never on its own a reason to repair this device), an edge 403 a {@link SendEdgeRefusedError} (the
   * network path), a seat still awaiting a member's admission an {@link AwaitingAdmissionError}, any
   * other status an {@link ApiRefusalError} carrying it; a transport failure is
   * whatever `f` raised, untouched.
   */
  async getGroupExclusions(groupId: string, forUserId?: string): Promise<GroupExclusions> {
    return (await this.readGroupWindows(groupId, forUserId)).exclusions;
  }

  /**
   * What this device's user, and `forUserId` when given, may never be handed in `groupId`: their gaps
   * AND, in a group conversation, everything before their first arrival (user, 2026-10-21) - the
   * route's `withheld` field, which names those two people only. A 1:1 answers the gaps only, decided
   * by the server. A counted person always has an entry, so a missing key means "not counted".
   *
   * Read for ONE person at a time - the invitee of a history push, or this device's own user - never
   * as a union: the span before the newest member's arrival would then withhold everything older
   * from everyone. Asked with the same `forUserId` as {@link getGroupExclusions}, both cost one read.
   */
  async getGroupWithheld(groupId: string, forUserId?: string): Promise<GroupExclusions> {
    // PARSED HERE AND NOWHERE ELSE: a server that predates the field answers no `withheld`, and that
    // must fail this read alone. Parsed in the shared read, it failed `getGroupExclusions` too, so
    // every history answer and every received bundle stopped for as long as a store build is ahead
    // of production.
    const { withheld } = await this.readGroupWindows(groupId, forUserId);
    if (withheld === undefined) throw new WithheldUnsupportedError(groupId);
    return parseGroupExclusions(withheld);
  }

  /**
   * Whether this server routes an addressed history answer on a conversation (step A,
   * docs/wiki/protocols/history-answer-addressing.md): `addressedAnswers: true` on the same read.
   * A server that predates it answers without the field, which is `false` here, never a failure.
   */
  async getAddressedAnswersSupported(groupId: string, forUserId?: string): Promise<boolean> {
    return (await this.readGroupWindows(groupId, forUserId)).addressedAnswers;
  }

  /**
   * The one read behind {@link getGroupExclusions}, {@link getGroupWithheld} and
   * {@link getAddressedAnswersSupported}, failures classified at the throw. `withheld` is handed on
   * UNPARSED - see {@link getGroupWithheld}.
   */
  private readGroupWindows(
    groupId: string,
    forUserId?: string
  ): Promise<{ exclusions: GroupExclusions; withheld: unknown; addressedAnswers: boolean }> {
    const forQuery = forUserId ? `?for=${encodeURIComponent(forUserId)}` : '';
    return this.joinInFlight(`exclusions:${groupId}${forQuery}`, async () => {
      const res = await this.f(
        `${this.historyUrl}/api/mls/groups/${groupId}/exclusions${forQuery}`,
        {
          headers: await this.auth(),
        }
      );
      if (res.status === 403) {
        // ORIGIN FIRST, as for a send: an HTML 403 is the edge, and says nothing about the roster.
        if (responseOrigin(res) === 'edge') throw new SendEdgeRefusedError(groupId, res.status);
        throw new ExclusionsRefusedError(groupId);
      }
      const awaiting = await awaitingAdmissionFrom(res, groupId);
      if (awaiting) throw awaiting;
      if (!res.ok) {
        throw new ApiRefusalError(
          res.status,
          null,
          `getGroupExclusions refused with ${res.status} for group ${groupId}`
        );
      }
      const body = (await res.json()) as {
        exclusions?: unknown;
        withheld?: unknown;
        addressedAnswers?: unknown;
      };
      return {
        exclusions: parseGroupExclusions(body?.exclusions),
        withheld: body?.withheld,
        addressedAnswers: body?.addressedAnswers === true,
      };
    });
  }

  /**
   * The user-level rosters of many groups, `GROUP_ROSTERS_MAX_GROUPS` per `POST /api/mls/group-rosters`.
   *
   * Never throws, like {@link fetchHistoryBatch}: a group this read did not answer is simply absent
   * from both sets, and the caller decides nothing for it - it is NOT read another way (see
   * `strayLeaves.ts`). A delivery service that predates the route answers 404, which is warned once
   * per chunk with the server's words; the stray sweep then removes nobody until the server deploys.
   *
   * `refused` is the server ANSWERING that the caller is not in that group - the single read's 403,
   * per group - so the caller knows it without asking again.
   */
  async fetchGroupRosters(groupIds: string[]): Promise<GroupRosterBatch> {
    const out: GroupRosterBatch = { rosters: new Map(), refused: new Set(), revoked: new Map() };
    for (let i = 0; i < groupIds.length; i += GROUP_ROSTERS_MAX_GROUPS) {
      const chunk = groupIds.slice(i, i + GROUP_ROSTERS_MAX_GROUPS);
      try {
        const res = await this.f(`${this.historyUrl}/api/mls/group-rosters`, {
          method: 'POST',
          headers: await this.auth({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ groupIds: chunk }),
        });
        if (!res.ok) {
          console.warn(
            `[ROSTER] batch of ${chunk.length} group(s) not answered: ${res.status} ` +
              `body=${(await res.text()).slice(0, 200)} - nothing is decided for these groups`
          );
          continue;
        }
        const data = (await res.json()) as {
          rosters?: Record<string, string[]>;
          refused?: string[];
          revoked?: Record<string, unknown>;
        };
        for (const [groupId, userIds] of Object.entries(data.rosters ?? {})) {
          // A roster that is not a list is not an empty roster: an empty one names every leaf as a
          // stray, so a malformed entry is left unanswered rather than read as one.
          if (Array.isArray(userIds)) out.rosters.set(groupId, userIds);
        }
        for (const groupId of data.refused ?? []) out.refused.add(groupId);
        // AN ALLOWLIST FOR A DESTRUCTIVE COLLECTOR: only a non-empty string, only for a group whose
        // roster was answered. A malformed entry names nobody - never "everybody".
        for (const [groupId, identities] of Object.entries(data.revoked ?? {})) {
          if (!out.rosters.has(groupId) || !Array.isArray(identities)) continue;
          const named = identities.filter(
            (id): id is string => typeof id === 'string' && id.length > 0
          );
          if (named.length > 0) out.revoked.set(groupId, named);
        }
      } catch (e) {
        console.warn(
          `[ROSTER] batch of ${chunk.length} group(s) could not be sent - nothing is decided for these groups:`,
          e
        );
      }
    }
    return out;
  }

  /** Requests currently on the wire, by key: a second identical ask joins instead of repeating. */
  private readonly inFlightReads = new Map<string, Promise<unknown>>();

  /**
   * Joins an identical read already in flight. THE ENTRY LIVES EXACTLY AS LONG AS THE REQUEST - no
   * clock, no staleness: a caller arriving after the answer asks again, so nothing here can serve a
   * roster or a group row older than the request it joined.
   */
  private joinInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlightReads.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = run().finally(() => this.inFlightReads.delete(key));
    this.inFlightReads.set(key, p);
    return p;
  }

  /**
   * `GET /api/mls/groups/:id` as status + body text, shared by every simultaneous reader. The two
   * public readers ({@link getGroupMeta}, {@link getGroupServerStatus}) parse it differently but ask
   * the same question, and each used to send its own request (14 calls for 7 groups, HAR 2026-10-05).
   */
  private readGroupRow(groupId: string): Promise<{ ok: boolean; status: number; text: string }> {
    return this.joinInFlight(`group:${groupId}`, async () => {
      const res = await this.f(`${this.historyUrl}/api/mls/groups/${encodeURIComponent(groupId)}`, {
        headers: await this.auth(),
      });
      return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
    });
  }

  /** Returns all groups `userId` belongs to, including soft-deleted tombstones (`deletedAt`). */
  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    // ONE REQUEST FOR SIMULTANEOUS ASKERS (WP-W4): the boot reads this list from the conversation
    // load, the sweep and the reconcile, three requests for one answer.
    return this.joinInFlight(`${userId}:user-groups`, async () => {
      const res = await this.f(`${this.historyUrl}/api/mls/users/${userId}/groups`, {
        headers: await this.auth(),
      });
      if (!res.ok) {
        throw await refusalFromResponse(res, 'getUserGroups failed');
      }
      return (await res.json()) as UserGroupRow[];
    });
  }

  /**
   * Server status of a group, distinguishing a CONFIRMED absence from network uncertainty -
   * something `getGroupMeta` (which returns `null` for both) cannot do. `GET /api/mls/groups/:id`
   * queries `dm_groups` WITHOUT a membership check and returns `null` (body) if the row does not
   * exist, hence:
   *  - `'absent'` : the server replied and the `dm_groups` row does not exist -> group really gone
   *    (never created / hard-purged). The only case where discovery may auto-delete the conversation.
   *  - `'error'`  : HTTP/network failure -> status unknown, delete NOTHING.
   *  - `GroupMeta`: the row exists (live group, `deletedAt` tombstone, or exclusion) -> keep the
   *    conversation locally (banner + manual deletion).
   */
  async getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta> {
    let res: { ok: boolean; status: number; text: string };
    try {
      res = await this.readGroupRow(groupId);
    } catch {
      return 'error';
    }
    // 404 = no dm_groups row -> confirmed absent (never created or hard-purged).
    if (res.status === 404) return 'absent';
    // Other non-2xx (401/5xx/…) = real doubt -> never purge on error.
    if (!res.ok) return 'error';
    // The `GET mls/groups/:id` handler returns the group object, or `null` when not found.
    // NestJS serializes that `null` as an EMPTY body (200) -> `res.json()` would throw. An empty
    // or "null" 2xx body from THIS endpoint therefore unambiguously means "group absent" (not a
    // network error). This distinction lets discovery purge a deleted group instead of keeping
    // it indefinitely as "uncertain status". [[lifecycle]]
    const trimmed = res.text.trim();
    if (trimmed === '' || trimmed === 'null') return 'absent';
    let g: unknown;
    try {
      g = JSON.parse(trimmed);
    } catch {
      return 'absent';
    }
    if (!g || typeof g !== 'object') return 'absent';
    const id = (g as { id?: string; groupId?: string }).groupId ?? (g as { id?: string }).id;
    if (typeof id !== 'string' || !id) return 'absent';
    return {
      groupId: id,
      name:
        typeof (g as { name?: string }).name === 'string'
          ? (g as { name: string }).name
          : undefined,
      isGroup:
        typeof (g as { isGroup?: boolean }).isGroup === 'boolean'
          ? (g as { isGroup: boolean }).isGroup
          : undefined,
      deletedAt: (g as { deletedAt?: string | null }).deletedAt ?? null,
      // CARRIED, and they were not. `GroupMeta` has documented these as "the discriminator a
      // destructive sweep needs" since WP-22, `decideAbsentLocalGroupFate` reads them, and this
      // mapper dropped them on the floor - so the only thing that ever kept a distribution group
      // alive was having been registered earlier in the same session. A sweep that ran first
      // forgot it, and the seeds stopped arriving until the next boot re-registered it.
      distributionWorkspaceId:
        (g as { distributionWorkspaceId?: string | null }).distributionWorkspaceId ?? null,
      distributionChannelId:
        (g as { distributionChannelId?: string | null }).distributionChannelId ?? null,
    };
  }

  /**
   * Lists the groups THIS user deliberately dismissed (manual deletion/leave).
   * Discovery purges every local conversation present in this set - across all of the user's
   * devices. Returns `[]` on failure (never purge on a doubt).
   */
  async getDismissedGroups(): Promise<string[]> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/users/${encodeURIComponent(this.userId)}/dismissed-groups`,
        { headers: await this.auth() }
      );
      if (!res.ok) {
        console.warn(`[MLS] dismissed-groups read answered ${res.status} - treated as none`);
        return [];
      }
      const arr = await res.json();
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch (e) {
      console.warn('[MLS] dismissed-groups read did not reach the server - treated as none:', e);
      return [];
    }
  }

  /**
   * Marks a group as dismissed by this user - a manual delete or leave, propagated to their other
   * devices.
   *
   * THROWS on a refusal or a transport failure, and every caller catches and LOGS it. The call is
   * best-effort - the local purge has already happened - but it is the ONLY thing that propagates a
   * manual delete to the user's other devices, so a silent failure meant the group came back on the
   * next new device with nothing anywhere saying why. Best-effort is a reason not to block, never a
   * reason not to say.
   */
  async dismissGroup(groupId: string): Promise<void> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/users/${encodeURIComponent(this.userId)}/dismissed-groups`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId }),
      }
    );
    if (!res.ok) throw await refusalFromResponse(res, 'dismissGroup refused');
  }

  /**
   * Lifts a group's dismiss (re-add via Welcome: the user wants the conversation back).
   * THROWS like {@link dismissGroup}, for the same reason: every caller catches and logs.
   */
  async undismissGroup(groupId: string): Promise<void> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/users/${encodeURIComponent(this.userId)}/dismissed-groups/${encodeURIComponent(groupId)}`,
      { method: 'DELETE', headers: await this.auth() }
    );
    if (!res.ok) throw await refusalFromResponse(res, 'undismissGroup refused');
  }

  /**
   * Fetches group metadata - name, `deletedAt`, and the two epochs. Returns `null` on 404 or error.
   *
   * THE EPOCHS ARE READ AS NUMBERS OR NOT AT ALL. A server too old to send them leaves both
   * `undefined`, and `undefined` is the only honest reading: coercing a missing `activeEpoch` to 0
   * would call every published base stale, and coercing a missing `baseEpoch` to 0 would call an
   * unpublished group stale. Both mistakes are silent and one line, which is why `classifyBase`
   * separates them explicitly too.
   */
  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    try {
      const res = await this.readGroupRow(groupId);
      if (!res.ok) return null;
      const g = JSON.parse(res.text);
      if (!g || typeof g !== 'object') return null;
      const id = (g as { id?: string; groupId?: string }).groupId ?? (g as { id?: string }).id;
      if (typeof id !== 'string' || !id) return null;
      return {
        groupId: id,
        name:
          typeof (g as { name?: string }).name === 'string'
            ? (g as { name: string }).name
            : undefined,
        isGroup:
          typeof (g as { isGroup?: boolean }).isGroup === 'boolean'
            ? (g as { isGroup: boolean }).isGroup
            : undefined,
        deletedAt: (g as { deletedAt?: string | null }).deletedAt ?? null,
        // THE WELCOME HANDLER READS THESE since channel-encryption section 20 made an admitter
        // Welcome a newcomer into a key group: without them it cannot tell a seed carrier from a
        // conversation and builds a sidebar row for it. Same mapping as `getGroupServerStatus`.
        distributionWorkspaceId:
          (g as { distributionWorkspaceId?: string | null }).distributionWorkspaceId ?? null,
        distributionChannelId:
          (g as { distributionChannelId?: string | null }).distributionChannelId ?? null,
        activeEpoch:
          typeof (g as { activeEpoch?: number }).activeEpoch === 'number'
            ? (g as { activeEpoch: number }).activeEpoch
            : undefined,
        baseEpoch:
          typeof (g as { baseEpoch?: number | null }).baseEpoch === 'number'
            ? (g as { baseEpoch: number }).baseEpoch
            : ((g as { baseEpoch?: number | null }).baseEpoch ?? undefined),
      };
    } catch {
      return null;
    }
  }

  /** Returns outstanding Welcome invitations for a device (used by multi-device sync). */
  async getPendingInvitations(userId: string, deviceId: string): Promise<PendingInvitationRow[]> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/invitations/pending/${userId}/${deviceId}`,
        {
          headers: await this.auth(),
        }
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /**
   * Returns this device's per-group membership rows, each with its status (`pending`/`active`).
   *
   * THROWS RATHER THAN ANSWERING `[]`, because the two are different facts and a caller now DECIDES
   * on the difference. `pending` means a member has been told to Add this device and owes it a
   * Welcome; a recovery seam that read a failed call as "no pending row" would serve itself an
   * external-commit join into a tree an Add is already in flight for, and lose the race about half
   * the time (GRP-4, 2026-08-26). An empty array is the server saying it holds no row; an
   * unreachable server says nothing at all, and must not be able to impersonate an answer.
   */
  async getDeviceMemberships(userId: string, deviceId: string): Promise<DeviceMembershipRow[]> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/device-memberships/${userId}/${deviceId}`,
      {
        headers: await this.auth(),
      }
    );
    if (!res.ok) throw await refusalFromResponse(res, 'device-memberships');
    return await res.json();
  }

  /**
   * Marks a device's group invitation as `pending` or `active`. Best-effort, non-throwing.
   *
   * A REFUSAL IS SAID HERE, because no caller reads it. A report of `active` promotes an existing
   * seat only, and the server refuses it (`403 NOT_A_MEMBER`, `reason` `no_seat`, `kicked` or
   * `not_on_roster`) otherwise - a device whose pending row was purged before it processed its
   * Welcome then stays unrouted, and without this line its own log never said so.
   */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/invitations/status`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ deviceId, userId, groupId, status }),
      });
      if (!res.ok) {
        const refusal = await refusalFromResponse(res, 'invitation status report');
        console.warn(
          `[MEMBERSHIP] report of ${status} REFUSED for group ${groupId.slice(0, 8)}... device ${deviceId}: ` +
            `status=${refusal.status} code=${refusal.code ?? 'none'} reason=${refusal.reason ?? 'none'}`
        );
      }
    } catch (e) {
      console.error('Failed to update invitation status', e);
    }
  }

  /** Notifies the server to remove a stale leaf from the MLS tree (device lost its local state). Used alongside `removeMemberDevice` when a `DuplicateSignature` error is detected. */
  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/kick-stale-device`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviceId, userId, groupId }),
    });
    if (!res.ok) throw await refusalFromResponse(res, 'kickStaleDevice failed');
  }

  /** Deletes the membership row for a specific device+group pair. Returns `{ affected: 0 }` on error. */
  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/device-memberships/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/${encodeURIComponent(groupId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
      if (!res.ok) {
        console.error(`deleteDeviceMembership failed: ${res.status}`);
        return { status: 'error', affected: 0 };
      }
      return await res.json();
    } catch (e) {
      console.error('Failed to delete device membership', e);
      return { status: 'error', affected: 0 };
    }
  }

  /** Deletes all group membership rows for a device (used when removing a device from the account). */
  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/device-memberships/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
      if (!res.ok) {
        console.error(`deleteAllDeviceMemberships failed: ${res.status}`);
        return { status: 'error', affected: 0 };
      }
      return await res.json();
    } catch (e) {
      console.error('Failed to delete all device memberships', e);
      return { status: 'error', affected: 0 };
    }
  }

  async deleteDevice(
    userId: string,
    deviceId: string
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
      if (!res.ok) {
        console.error(`deleteDevice failed: ${res.status}`);
        return {
          status: 'error',
          groupsCleaned: 0,
          keyPackagesDeleted: 0,
          oneTimeKeyPackagesDeleted: 0,
        };
      }
      return await res.json();
    } catch (e) {
      console.error('Failed to delete device', e);
      return {
        status: 'error',
        groupsCleaned: 0,
        keyPackagesDeleted: 0,
        oneTimeKeyPackagesDeleted: 0,
      };
    }
  }
}
