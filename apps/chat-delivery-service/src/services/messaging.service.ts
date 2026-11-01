import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  In,
  MoreThanOrEqual,
  LessThan,
  LessThanOrEqual,
  EntityManager,
  IsNull,
} from 'typeorm';
import * as crypto from 'crypto';
import { RefusalCode, refusalBody } from '../utils/refusal-codes';
import Redis from 'ioredis';
import {
  ADDRESSED_HISTORY_CAPABILITY,
  declaresAddressedHistory,
  devicePresenceKey,
  publishIfAddressable,
} from './addressing';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember, isGroupUuid } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { categoryOfDataPush } from './push-category';
import { readDisabledCategories, readGroupNotificationLevel } from './notification-preferences';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { resolveUserDisplayName, resolveUserDisplayNamesBatch } from '../utils/display-name';
import { activeRevocationWhere } from '../utils/revocation';
import {
  MLS_MAX_PAST_EPOCHS,
  isBeyondPastEpochWindow,
  mlsFrameEpoch,
  isPublicMlsFrame,
  readCommitFrame,
} from '../utils/mls-frame-epoch';
import { groupInfoLeafIdentity } from '../utils/mls-group-info';
import {
  askDepartureOutcome,
  type DepartureOutcome,
  type DistributionScope,
  distributionScopeOf,
  isEntitledToDistributionGroup,
} from '../internal/distribution-entitlement';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import {
  ADMITTED_SEAT,
  awaitingAdmissionRefusal,
  callerSeatStandings,
  endDeviceMemberships,
  ensureGroupMember,
  refuseAwaitingSeat,
  standingOnGroupOfKind,
  assertCallerActsOnGroup,
  dateArrivalAtAdmission,
  exclusionWindows,
  openMissingIntervals,
  partingKey,
  withheldWindows,
  withholdExcludedHistoryRows,
  withholdsArrivalSpan,
  type ExclusionWindow,
} from '../utils/group-membership';
import { RepeatCounter, cutDeviceId, cutUserId } from '../utils/log-repeat';
import { type AnsweredAsk, announceJoinAskSettled } from '../utils/join-ask-announce';
import { addInFlightOf, readPendingMembershipFacts } from '../utils/pending-membership-facts';
import {
  FURTHER_DEVICE_SELF_JOIN_OPEN,
  readDeviceSeat,
  type DeviceSeat,
  type NoHolderFacts,
} from '../utils/device-seat';
import { isBlockedBetween } from '../utils/user-blocks';
import { sameSideOfReviewCohort } from '../review-cohort';
import {
  SHARED_PAYLOAD_WRITES_ENV,
  type PayloadGroupFacts,
  materializeDeliveries,
  readSharedPayloadWrites,
  saveWithSharedPayload,
  sharesPayload,
} from '../utils/queued-payload';
import {
  bumpSeatGeneration,
  claimSeat,
  heldKeyPackages,
  readSeatEviction,
  readSeatGeneration,
  recordSeatEviction,
  seatClaimHolds,
  settleSeatDeparture,
  takeSeatLock,
  takeSharedSeatLock,
  withSeatLock,
  type SeatClaim,
} from '../utils/seat-eviction';
import {
  deleteGroupOwnedRows,
  deleteGroupRedisKeys,
  totalGroupOwnedRows,
} from '../utils/group-purge';
import {
  buildPushDataFields,
  buildApnsRequest,
  LONGEST_FALLBACK_LOCALE,
  buildInternalAndroidHalf,
  buildInternalApnsHalf,
  decideProtoCarriage,
  measureDataFields,
  measureApnsPayload,
  FCM_DATA_LIMIT,
  PushMessageInput,
} from './push-payload';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  sanitizeLogValue,
  sanitizeLeafLogValue,
  sanitizeDevicePairLogValue,
  sanitizeStringIdList,
  assertCallerOwnsUserId,
  isUnresolvedIdentity,
  canonicalDeviceKey,
  canonicalLeafIdentity,
} from '../utils/sanitize';
import {
  HISTORY_STREAM_MAXLEN,
  PENDING_FETCH_CHUNK_ROWS,
  PENDING_PAGE_MAX_BYTES,
  RETENTION_WINDOW_MS,
} from '../retention.constants';

export interface SendMessageBody {
  proto?: string;
  /**
   * LEGACY CONTENT PATH ONLY, and unset there too by every client shipped since MLS.
   *
   * The proto path ignores it entirely and resolves recipients from `dm_device_group_memberships`
   * - which is what `libs/proto/canari.proto` has always specified ("leave empty = derive from
   * group members"). It used to be read first there, with the DB resolve behind an
   * `ops.length === 0` guard labelled a Redis cache miss; since nothing has ever filled this
   * field, that guard was true on every send and the "fallback" was the design.
   */
  recipients?: { userId: string; deviceId?: string }[];
  senderId?: string;
  senderDeviceId?: string;
  groupId?: string;
  isWelcome?: boolean;
  isCommit?: boolean;
  /** userId:deviceId pairs to skip (e.g. invitee already receiving a Welcome) */
  excludeDeviceIds?: string[];
  /** When true, FCM is sent (for MLS state sync) but no notification is displayed (read receipts, own-device copies). */
  silent?: boolean;
  /**
   * When true, the frame is appended to the group's shared history stream so a device that was
   * absent can still obtain it.
   *
   * Independent of {@link silent}. Until 2026-08-12 the two were the same boolean, and because
   * every control frame is silent by construction, no reaction, edit, deletion or read receipt
   * ever had a shared copy. See `docs/wiki/protocols/history-reconciliation.md`.
   *
   * The server holds ciphertext only, so it cannot classify a frame: the sender declares this.
   * Absent means "fall back to the old meaning of `silent`" - the only thing a client predating
   * the split can be interpreted as.
   */
  durable?: boolean;
  /**
   * `userId:deviceId` keys this frame is ADDRESSED to, when it is meant for them and nobody else
   * in the group - a Graine answer to one device's seed request (channel-encryption section 23).
   *
   * It can only NARROW the recipient set, never widen it: the set is still resolved from the
   * membership table, and a key naming a device that is not a live member of the group addresses
   * nobody. An addressed frame is never appended to the group's shared history stream, because
   * that stream is read by every member. Refused on a commit or a Welcome, which every member must
   * receive. Absent (every client before 1.2.5, and every other send) means the whole group.
   */
  recipientDevices?: string[];
  // legacy fields (frontend fallback / group fan-out)
  content?: string;
  type?: string;
}

export interface SendMessageResult {
  status: string;
  queued: number;
  sent: number;
  /**
   * The instant this server received the frame, in milliseconds - the SAME value written as
   * `createdAt` on every queued copy, so the sender can date its own copy with the time every
   * recipient's copy carries. A sender never receives its own frame back, and without this its
   * copy had no server time at all (a Remove holds against a later re-add, user 2026-10-14: an
   * undated message cannot be placed against an exclusion window).
   */
  receivedAt: number;
}

/**
 * An application frame's clear epoch and who sealed it, carried from the send path to the locked
 * group read, where it is compared with the group's `activeEpoch` (see `isBeyondPastEpochWindow`).
 */
interface SealedFrame {
  epoch: number;
  /** `userId:deviceId` as the body declared it. */
  sender: string;
  /** The sender device's build from its KeyPackage row, or `unknown` when it has none. */
  appVersion: string;
}

export interface ValidateCommitBody {
  groupId: string;
  deviceId: string;
  baseEpoch: number;
  /**
   * Base64 serialised MLS Commit. REQUIRED: an accepted commit is recorded in the epoch-indexed
   * commit-log (rung-1 replay) and fanned out to members in the SAME call - a single atomic
   * validate -> store -> broadcast round-trip.
   *
   * Kept optional in the TYPE because it arrives over HTTP and is validated in {@link
   * validateCommit}, which refuses the call outright when it is absent: a commit nothing can
   * replay may not advance the epoch, the epoch it would skip being unrefillable for ever.
   */
  proto?: string;
  /** Sender user id, for the fan-out envelope (required when `proto` is present). */
  senderId?: string;
  /** userId:deviceId pairs to skip in the commit fan-out (inviter self, freshly-welcomed invitee). */
  excludeDeviceIds?: string[];
  /**
   * Base64 GroupInfo for the epoch this commit CREATES (`baseEpoch + 1`), exported by the
   * committing device before it submitted. Stored in the same transaction as the epoch advance, so
   * the published external-join base can never trail the group. See {@link validateCommit}.
   */
  groupInfo?: string;
  /**
   * The devices this commit ADDS to the tree, as the committing device staged them - never the
   * ones its staging skipped for an invalid KeyPackage, which no Welcome will ever reach.
   *
   * Each is recorded `pending` with `admittedAtEpoch = baseEpoch + 1` in the SAME transaction as
   * the epoch advance (see `DeviceGroupMembership.admittedAtEpoch`). That is what makes the rule
   * exact: no member can seal a frame at the new epoch before it has this commit, and the commit is
   * fanned out only after the row is written - so there is no instant at which a frame the newcomer
   * can open is sent without it being a recipient. Recording it later, when the Welcome is queued,
   * left that instant open and could name the wrong epoch if a second commit landed in between.
   *
   * Absent from a client predating the field: its newcomers are routed once they activate, as
   * before, with nothing replayed.
   */
  admits?: { userId: string; deviceId: string }[];
  /**
   * For the Add of a MEMBER'S INVITATION: the group's seat generation the invitation read with its
   * roster baseline (`GET .../user-members?withSeatGeneration=1`), before the Add was built - WHEN
   * the member decided, as a counter. The gate orders every departure of a person this commit admits
   * against it instead of against the base epoch's generation ({@link enrolAdmittedPeople}): a
   * Decline or a removal recorded at a later generation came after the decision and holds; one
   * recorded at or before it was seen, so the Add is a fresh invite and admits - which an unchanged
   * base epoch could not tell apart. Never greater than the group's current generation (refused,
   * `400`, if it is: the number is read from the server and only grows). Absent from every other
   * commit and from a client older than the field: the base epoch's generation decides, as before.
   */
  invitationSeatGeneration?: number;
  /**
   * Whom this commit REMOVES from the tree, as the committing device staged it: a whole person
   * (`userId` alone, every leaf of theirs) or one device (`userId` + `deviceId`).
   *
   * The removal was recorded by the server first (`removeGroupMember`), which deleted the device rows
   * the fan-out resolves from - so the removed devices are found in the parting hint (`partingKey`)
   * and the commit is queued to the ones this list names, and only those. Keyed to what the commit
   * declares rather than to who sent it, so two removals in flight each reach their own person, and
   * whoever commits a removal - the remover, or a holder collecting a stray leaf - delivers it.
   * Absent from a client predating the field: its removals reach the removed devices as they did
   * before, which is not at all.
   *
   * DECLARED, NOT PROVEN - the server cannot read the commit, so any member can forge it. Bounded by
   * the hint: a forgery can only consume an entry (suppress a delivery), never route a frame to a
   * device the server did not itself part from this group.
   */
  removes?: { userId: string; deviceId?: string }[];
  /**
   * The Welcome of the device this commit adds, when the committer hands it over WITH the commit
   * (the background re-add, `POST mls/push/send-welcome-and-commit`).
   *
   * Its target is held to {@link sendWelcome}'s bar BEFORE the epoch moves, and its row is written
   * in the advance's own transaction, so an accepted commit always has its Welcome stored. Queued
   * in a second call after the advance, a failure there left the newcomer in the tree with no
   * Welcome, and every holder then answered it `already-member`: nothing durable recovered it.
   */
  welcome?: { userId: string; deviceId: string; payload: string; ratchetTree?: string };
}

/** Why a Welcome's target is refused: no device registered under it, or not in the group. */
export type WelcomeTargetRefusal = 'welcome_target_unknown' | 'welcome_target_not_member';

/**
 * What {@link MessagingService.readKeyGroupBaseForPush} answers a shut phone: the key group's scope,
 * and either its base (null when none is published yet) or `welcomeOwed` when a Welcome is on its
 * way and the device must not serve itself.
 */
export interface KeyGroupBaseForPush {
  scope: DistributionScope;
  welcomeOwed: boolean;
  base: { groupInfo: string; baseEpoch: number; activeEpoch: number } | null;
}

export interface ValidateCommitResult {
  accepted: boolean;
  newEpoch?: number;
  /** True when this exact commit had already been accepted: a resubmission, answered again. */
  duplicate?: boolean;
  currentEpoch?: number;
  reason?: string;
  /**
   * The devices this commit DECLARED admitting (`admits`) that the gate did not record, each with
   * why - on an ACCEPT only, and only when there is one. The leaf is in the tree all the same (the
   * stray sweep collects a leaf with no seat); what the committer owes is to not act on an admission
   * that did not happen. `no_key_package` in particular means its Welcome WILL be refused
   * (`WELCOME_TARGET_UNKNOWN`), so the client sends none rather than learning it by failing. A
   * `duplicate` answer carries none: the refusals were decided by the first acceptance and are not
   * recorded, and that client meets the Welcome's own typed refusal instead.
   */
  refusedAdmits?: RefusedAdmit[];
  /**
   * On a refusal `admit_refused` only: the people the commit would have admitted and the gate may
   * not ({@link MessagingService.enrolAdmittedPeople}). Nothing advanced; rebuild without them.
   */
  userIds?: string[];
}

/**
 * Why a declared admit was not recorded - the `reason=` of its `ADMIT_REFUSED` (or `NOT_ENROLLED`)
 * line, as a value. `committer` and `unresolved_identity` are not admits at all; `no_key_package`
 * is a device with no KeyPackage row (revoked, erased, never registered); `already_active` is
 * routed already; `not_entitled` / `departure_in_progress` are a key group's seat claim refusing it;
 * `not_enrolled` is no longer answered: a person the roster refuses
 * ({@link MessagingService.enrolAdmittedPeople}) refuses the whole commit instead.
 */
export type AdmitRefusalReason =
  | 'committer'
  | 'unresolved_identity'
  | 'no_key_package'
  | 'already_active'
  | 'not_entitled'
  | 'departure_in_progress'
  | 'not_enrolled';

/** One declared admit the commit gate did not record - see {@link ValidateCommitResult.refusedAdmits}. */
export interface RefusedAdmit {
  userId: string;
  deviceId: string;
  reason: AdmitRefusalReason;
}

/** One replayable commit returned by the `sinceEpoch` endpoint. */
export interface CommitLogEntry {
  baseEpoch: number;
  proto: string;
}

export interface CommitsSinceResult {
  /** Ordered commits with `baseEpoch >= sinceEpoch`, ascending. */
  commits: CommitLogEntry[];
  /** Server `activeEpoch` at read time (the epoch the caller should reach after replay). */
  activeEpoch: number;
  /**
   * True when the caller's `sinceEpoch` is below the retained floor (older commits were pruned):
   * rung-1 replay cannot fully catch them up, so the caller must fall back to rung-2 (re-Welcome).
   */
  belowFloor: boolean;
  /**
   * The first epoch the log cannot supply, when one exists at or above `sinceEpoch` and below
   * `activeEpoch`. `commits` is then the applicable PREFIX - everything up to the hole - and no
   * replay can pass it, so the caller escalates to rung-2 instead of discovering it by failing.
   *
   * `belowFloor` is the same question asked about the START of the range and cannot answer this
   * one: a hole in the MIDDLE leaves the floor perfectly fine. Group `7da231f8` ran 0..129 with 121
   * absent for two days and every check passed (`docs/wiki/backlog.md`).
   */
  gapAt?: number;
}

/** Commit-log retention: keep ~1 year so rung-1 replay covers almost every gap (commits are tiny). */
/**
 * Thrown inside `validateCommit`'s transaction when the Welcome's target lost its seat after the
 * target check: rolls the commit back and is answered `welcome_target_not_member`. A type, so the
 * catch never reads a message.
 */
class WelcomeSeatGone extends Error {
  constructor() {
    super('welcome target seat gone');
    this.name = 'WelcomeSeatGone';
  }
}

/**
 * Thrown inside `validateCommit`'s transaction when a commit from a door that is no member's gesture
 * (`mayAnswerAsk: false`, the background Welcome) would admit a person whose seat still awaits a
 * member's admission: rolls the commit back and is answered `awaiting_admission`. A type, so the
 * catch never reads a message.
 */
class AskNotAnswerable extends Error {
  constructor() {
    super('an ask is answered only by a member');
    this.name = 'AskNotAnswerable';
  }
}

/**
 * Thrown inside the advance's transaction when the epoch it would move is no longer the base the
 * gate read - another commit at the same base landed first - or when the commit log already holds
 * a commit for that base. The transaction rolls back and the commit is refused `epoch_mismatch`; a
 * type, so the catch never reads a message.
 */
class EpochAdvanceLost extends Error {
  constructor(readonly lost: 'epoch_moved' | 'log_row_exists') {
    super(`epoch advance lost: ${lost}`);
    this.name = 'EpochAdvanceLost';
  }
}

/**
 * Thrown inside the advance's transaction when a seat this commit would write - its committer's, or
 * an admit's - stands on a claim an eviction in the group overtook (`utils/seat-eviction.ts`). The
 * generation is the group's, so the eviction may be of someone else: the whole commit rolls back
 * and is answered `409 SEAT_CLAIM_OVERTAKEN`, which the client rebuilds and submits again. Dropping
 * only the seat would accept a commit whose leaf has no seat and nothing retrying it. A type, so the
 * catch never reads a message.
 */
class SeatClaimOvertaken extends Error {
  constructor(readonly seat: 'committer' | 'admit') {
    super(`seat claim overtaken: ${seat}`);
    this.name = 'SeatClaimOvertaken';
  }
}

/**
 * Thrown inside the advance's transaction when the commit would give a leaf to a person
 * {@link MessagingService.enrolAdmittedPeople} refuses. Accepting it with that person's admits
 * dropped - what the gate did before - merged a leaf no seat holds into every member's tree, which
 * only a later Remove could take back: so the whole commit rolls back. It is ANSWERED, not thrown to
 * the client: `200 {accepted: false, reason: 'admit_refused', userIds}`, the shape every client
 * already rolls its stage back on (a client older than this change keeps its stage on a thrown 4xx,
 * which stops its commits in the group), and the client rebuilds the commit without the people
 * named. When the COMMITTER holds no admitted seat, the reason is `committer_not_on_roster` and
 * names nobody: the refusal is about the committer, and dropping the people would not lift it. A
 * type, so the catch never reads a message.
 */
class AdmitRefused extends Error {
  constructor(
    readonly userIds: string[],
    readonly committerNotOnRoster: boolean
  ) {
    super(`admit refused: ${userIds.length} person(s)`);
    this.name = 'AdmitRefused';
  }
}

/**
 * The seat a Welcome is stored for, as {@link MessagingService.lockWelcomeSeat} re-reads it. In a
 * key group, `claim` is the target's seat claim, taken before social-service was asked whether the
 * target is entitled (`utils/seat-eviction.ts`); a conversation's seat is its roster row, so null.
 */
interface WelcomeSeat {
  userId: string;
  deviceId: string;
  keyGroup: boolean;
  claim: SeatClaim | null;
}

const COMMIT_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** Per-group safety cap: never keep more than this many commits for one group (bounds runaway growth). */
const COMMIT_LOG_MAX_PER_GROUP = 20_000;

export interface SendWelcomeBody {
  targetDeviceId: string;
  targetUserId?: string;
  senderUserId?: string;
  welcomePayload: string;
  ratchetTreePayload?: string;
  groupId: string;
}

export interface NotifyWelcomeRequestBody {
  groupId: string;
  requesterUserId: string;
  requesterDeviceId: string;
  /**
   * A FURTHER DEVICE'S ASK CARRIES ITS INTENT (D1, review of #2832): when no member device is online
   * it will join by itself, so a stored ask, its queued frames and a background wake would only open
   * a second door - an Android member's background Add - racing its own commit. With this set (and
   * the door open, {@link FURTHER_DEVICE_SELF_JOIN_OPEN}) a `no_peer_online` answer stores, queues
   * and wakes NOTHING, and withdraws an ask stored by an earlier pass. One door per answer.
   */
  selfJoinIfNobody?: boolean;
}

/**
 * The most members one history election may be asked to skip.
 *
 * A chase excludes exactly one member per step, so this bounds nothing a real conversation does -
 * it bounds what a malformed or hostile client can make the server hold and compare per request.
 */
const MAX_HISTORY_EXCLUSIONS = 128;

/**
 * The longest member key an election will consider skipping, and it is measured rather than picked.
 *
 * A member key is `userId:deviceId`. A user id is a 64-character hex digest, and a device id is
 * `<platform>-<that same 64-character digest>-<mint>-<suffix>` - so a real one on this platform is
 * **147 characters for a browser and 149 for the phone**, both measured on 2026-09-05.
 *
 * IT USED TO BE 128, WHICH IS SHORTER THAN EVERY KEY THIS SERVER HAS EVER ISSUED. The filter
 * dropped them all, silently, and the exclusion list has therefore never excluded anybody: the
 * coverage chase - whose entire termination argument is *"the next election EXCLUDES every member
 * that has stated one, so each step of the walk removes exactly one member"* - could not remove one,
 * and the client's own guard against a server that ignores an exclusion fired instead, stopping the
 * walk. Found by HEAL-REVOKE-7, which asked the server nine times to skip a sleeping phone and was
 * handed it back every time. The number came from `MAX_HISTORY_EXCLUSIONS` beside it - two limits
 * that look alike and count different things, one of them never checked against a real key.
 *
 * 256 leaves room for a longer platform prefix or mint without being an invitation: the guard is
 * against a hostile client making this server hold and compare something large, and 128 keys of 256
 * characters is 32 kB at worst.
 */
const MAX_MEMBER_KEY_LENGTH = 256;

/**
 * How many devices one addressed frame may name. A Graine answer names ONE (the device that asked);
 * the bound is what a hostile client can make the server hold and compare per send.
 */
const MAX_ADDRESSED_DEVICES = 16;

/**
 * Reads `SendMessageBody.recipientDevices` into lower-cased `userId:deviceId` keys, or `null` when
 * the frame is addressed to the whole group (field absent).
 *
 * Refused outright, never trimmed into something else: an empty list, a malformed key, too many
 * keys, or an addressed commit or Welcome. Each would otherwise be read as a DIFFERENT instruction -
 * an empty list as "the whole group" would undo the one thing the sender asked for, and an addressed
 * commit would split the group's epoch between the devices that got it and the ones that did not.
 */
export function readAddressedDevices(body: SendMessageBody): Set<string> | null {
  const raw: unknown = body.recipientDevices;
  if (raw === undefined || raw === null) return null;
  if (body.isCommit || body.isWelcome) {
    throw new BadRequestException('recipientDevices is refused on a commit or a Welcome');
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ADDRESSED_DEVICES) {
    throw new BadRequestException(
      `recipientDevices must name 1 to ${MAX_ADDRESSED_DEVICES} userId:deviceId keys`
    );
  }
  const keys = new Set<string>();
  for (const key of raw) {
    const at = typeof key === 'string' ? key.indexOf(':') : -1;
    if (
      typeof key !== 'string' ||
      key.length > MAX_MEMBER_KEY_LENGTH ||
      at <= 0 ||
      at === key.length - 1
    ) {
      throw new BadRequestException('recipientDevices contains a key that is not userId:deviceId');
    }
    keys.add(canonicalDeviceKey(key.slice(0, at), key.slice(at + 1)));
  }
  return keys;
}

/**
 * The fields a CLIENT may set on `POST /mls/send` - an allowlist, not a denylist.
 *
 * Everything else on {@link SendMessageBody} is set by this service's own callers (the commit
 * fan-out, the background Welcome), which call {@link MessagingService.sendMessage} directly and never
 * cross this route. `recipientDevices` is here because {@link readAddressedDevices} validates it.
 */
const CLIENT_SEND_FIELDS: ReadonlySet<string> = new Set([
  'proto',
  'groupId',
  'senderId',
  'senderDeviceId',
  'silent',
  'durable',
  'recipientDevices',
]);

/**
 * The devices a commit's fan-out may skip: the ones THIS commit admits (they join by Welcome and
 * cannot process it) and the committing device itself - nobody else. A declared exclusion naming
 * any other member would keep the commit from a device that must apply it, splitting the group's
 * epoch; such entries are dropped (the device receives the commit) and reported through `onDropped`.
 * A device staged out for an invalid KeyPackage is also dropped: it is in no tree, so receiving
 * the commit costs it one unreadable frame.
 */
export function commitExclusions(
  body: Pick<ValidateCommitBody, 'excludeDeviceIds' | 'senderId'>,
  admitted: ReadonlyArray<{ userId: string; deviceId: string }>,
  committerDeviceId: string,
  onDropped: (dropped: string[]) => void
): string[] {
  const declared = Array.isArray(body.excludeDeviceIds) ? body.excludeDeviceIds : [];
  const allowed = new Set(admitted.map((a) => `${a.userId}:${a.deviceId}`));
  if (body.senderId) allowed.add(`${body.senderId}:${committerDeviceId}`);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of declared) {
    if (typeof entry === 'string' && allowed.has(entry)) kept.push(entry);
    else dropped.push(typeof entry === 'string' ? entry.slice(0, 128) : 'invalid');
  }
  if (dropped.length > 0) onDropped(dropped);
  return kept;
}

/** Why a client send was refused before anything was read: the `error` of its 400/403 body. */
export type ClientSendRefusal =
  | { error: 'send_body_invalid'; status: 400; detail: string }
  | { error: 'send_field_refused'; status: 400; detail: string }
  | { error: 'proto_required'; status: 400; detail: string }
  | { error: 'public_frame_refused'; status: 400; detail: string }
  | { error: 'sender_mismatch'; status: 403; detail: string };

/**
 * Whether a client send is one this route accepts, or why not - decided before anything is read.
 *
 * - Only {@link CLIENT_SEND_FIELDS}: who receives a frame, and whether it is a handshake, are decided
 *   here (the recipient set from the membership table, a commit by `POST /mls/commit`).
 * - A `proto`: the pre-MLS content path is retired (measured unused 2026-10-22,
 *   `docs/wiki/legacy-compatibility.md`).
 * - A PRIVATE frame: the send route relays only private (application) frames; a public handshake
 *   frame goes through the commit route, whose gate reads it ({@link isPublicMlsFrame}).
 * - The caller as sender, with a device: a frame is attributed to its sender by every reader of the
 *   group's log, and the membership gate below is keyed on that device.
 *
 * `detail` is for the server's log only, already sanitised and bounded: a refused field's NAME is
 * the caller's text, and it never reaches the response body.
 */
export function clientSendRefusal(body: unknown, caller: string): ClientSendRefusal | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'send_body_invalid', status: 400, detail: 'not an object' };
  }
  const refused = Object.keys(body).filter((field) => !CLIENT_SEND_FIELDS.has(field));
  if (refused.length > 0) {
    const names = refused.slice(0, 8).map((f) => sanitizeLogValue(f.slice(0, 64)));
    return { error: 'send_field_refused', status: 400, detail: `fields=${names.join(',')}` };
  }
  const { proto, senderId, senderDeviceId } = body as SendMessageBody;
  if (typeof proto !== 'string' || proto.length === 0) {
    return { error: 'proto_required', status: 400, detail: 'no proto' };
  }
  if (isPublicMlsFrame(proto)) {
    return { error: 'public_frame_refused', status: 400, detail: 'wire_format=public_message' };
  }
  if (
    typeof senderId !== 'string' ||
    typeof senderDeviceId !== 'string' ||
    senderDeviceId.length === 0 ||
    senderId.toLowerCase() !== caller.toLowerCase()
  ) {
    return {
      error: 'sender_mismatch',
      status: 403,
      detail: `sender=${sanitizeLogValue(senderId)}:${sanitizeLogValue(senderDeviceId)}`,
    };
  }
  return null;
}

export interface NotifyHistoryRequestBody extends NotifyWelcomeRequestBody {
  /**
   * Member keys (`userId:deviceId`) this requester has already heard from, and does not want elected
   * again.
   *
   * It exists so a requester chasing a gap can walk its members instead of re-drawing the same one:
   * a device whose window is narrower than the range asked for says so, and the next election skips
   * it. **The set only ever grows within one chase, which is what bounds it** - see
   * `historyReconcile.ts`.
   *
   * The server reads it as an opaque set of keys. It never learns why a member was excluded, and it
   * is not an authorisation boundary: excluding a member only removes it from THIS election.
   */
  exclude?: string[];
}

/**
 * Why a device may not be given an `active` routing membership.
 *
 * The first two are the conditions `getPendingInvitations` refuses an invitation on, because a
 * device good enough to be MESSAGED must be at least as valid as one good enough to be INVITED
 * (WP-GHOST-1). The third is not about the device at all: it is the value failing to name one, and
 * it lives here rather than at each door because two of the four doors did not check it.
 */
export type ActivationRefusal =
  | 'revoked'
  | 'no_key_package'
  | 'unresolved_identity'
  | SeatRefusal
  /** An eviction overtook the claim the seat was to be written against (`utils/seat-eviction.ts`). */
  | 'departed';

/**
 * Why a REPORT of `active` was refused: the device holds no seat it may promote - or its owner's
 * seat still awaits a member's admission (`awaiting_admission`: no member's Add or Welcome admitted
 * them, so a device of theirs cannot be in the tree) - or, in a key-distribution group, social-service
 * answered that its owner is not entitled to it (`not_entitled`).
 */
export type SeatRefusal =
  | 'no_seat'
  | 'kicked'
  | 'not_on_roster'
  | 'awaiting_admission'
  | 'not_entitled';

/**
 * By what right a device becomes `active` - REQUIRED of every caller, so none can skip the seat.
 *
 * - `report`: the device, or a member for it, REPORTS a seat already written by the commit or
 *   Welcome that admitted it. It promotes that seat and never creates one (see
 *   {@link MessagingService.activateDeviceMembership}).
 * - `accepted_commit`: the committer of an external commit the gate just accepted.
 * - `group_creator`: the device that created the group, in the request that creates it.
 * - `distribution_publisher`: the publisher of a key group's GroupInfo, on the internal route
 *   social-service calls only after its own membership check.
 */
export type ActivationAuthority =
  | 'report'
  | 'accepted_commit'
  | 'group_creator'
  | 'distribution_publisher';

/**
 * The HTTP refusal a reporting door answers with: a missing seat is the caller not being a member
 * (403), anything else the device not being addressable (400).
 */
export function activationRefusalException(
  reason: ActivationRefusal | undefined
): ForbiddenException | BadRequestException | ConflictException {
  // A pending member who waits, never "not a member": a 403 retires the conversation on a client.
  if (reason === 'awaiting_admission') {
    return awaitingAdmissionRefusal();
  }
  return reason === 'no_seat' ||
    reason === 'kicked' ||
    reason === 'not_on_roster' ||
    reason === 'not_entitled' ||
    reason === 'departed'
    ? new ForbiddenException(
        refusalBody(RefusalCode.NOT_A_MEMBER, 'This device holds no seat in this group', { reason })
      )
    : new BadRequestException(`Device is not addressable: ${reason}`);
}

/**
 * The result of {@link MessagingService.activateDeviceMembership}.
 *
 * Carried out rather than thrown because the callers owe their client different things, and what
 * each owes was NOT what each did until 2026-09-14 - two of the five simply dropped it:
 *
 * | Caller | What it owes its client | What it does |
 * | --- | --- | --- |
 * | `POST mls/invitations/status` | a user is waiting | 400 naming the reason |
 * | `POST mls/groups` (create) | the group it just made is memberless | 400 naming the reason |
 * | `POST mls/push/membership-active` | a native handler that logs the code | 400 naming the reason |
 * | `POST .../group-info` (publisher) | the GroupInfo IS stored; only this half failed | `publisherActive: false` in the answer |
 * | the commit fan-out | nobody to tell; the sender's own send succeeds | carries on, warn logged |
 *
 * The log line is written inside the method either way, so a caller that ignores this still leaves
 * the refusal on the record. The third row used to answer `{ status: 'active' }` on a refusal,
 * which is not an ignored outcome but a false one.
 *
 * A discriminated union would say this better, but this package compiles with
 * `strictNullChecks: false`, under which `if (!outcome.ok)` does not narrow one - so the shape that
 * types correctly here is one object with an optional reason.
 */
export interface ActivationOutcome {
  /** Whether the membership is now `active`. */
  ok: boolean;
  /** Set only when `ok` is false. Already logged by the method; carried for the caller's answer. */
  reason?: ActivationRefusal;
}

/** One group cursor for batch history fetch. */
export interface HistoryBatchRequestItem {
  groupId: string;
  after?: string;
  limit?: number;
  /** Inclusive upper bound - see {@link HistoryBatchResponse.heads}. */
  until?: string;
}

export interface HistoryBatchResponse {
  histories: Record<string, Record<string, unknown>[]>;
  /**
   * Per group, the stream's last entry id AT THE MOMENT THIS PAGE WAS READ - the caller's upper
   * bound for the rest of its walk, passed back as `until`.
   *
   * It exists so a replay and the live delivery queue can never both hand MLS the same frame. The
   * archive holds every frame, including the ones still queued for delivery, so a walk whose upper
   * bound is "the tail whenever I get there" necessarily covers rows written while it was walking -
   * precisely the ones the queue is about to deliver. Pinning the bound at the start makes the two
   * sets disjoint: everything above the head is the queue's, by construction.
   *
   * Absent for a group that holds no history at all (nothing to bound).
   */
  heads: Record<string, string>;
}

/** Redis stream MAXLEN (~1000) — upper bound for a full catch-up page. */
const HISTORY_FULL_PAGE_LIMIT = 1000;
/** Smaller default when `after` is set (incremental catch-up). */
const HISTORY_INCREMENTAL_DEFAULT_LIMIT = 200;
/**
 * Max groups per batch request (guards payload size and Redis fan-out).
 *
 * MIRRORED BY `HISTORY_BATCH_MAX_GROUPS` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, which
 * is the size the client chunks its catch-up at. Nothing on the wire negotiates it, so changing
 * this number without changing that one puts every client past the cap back to one request per
 * conversation - which is what it did until 2026-08-24. `messaging.history-bound.spec.ts` pins it.
 */
const HISTORY_BATCH_MAX_GROUPS = 50;

export interface AckMessagesBody {
  userId: string;
  deviceId: string;
  messageIds: string[];
}

/** Offline device ids a TRANSPORT_SKIPPED_OFFLINE line names before it says "+N more". */
const SKIPPED_DEVICES_LOGGED = 5;

/**
 * The ids a log line names for a list that can hold ~100 entries: the first
 * {@link SKIPPED_DEVICES_LOGGED}, then `+N more`. The line carries the exact count separately.
 */
export function capLoggedDevices(ids: readonly string[]): string[] {
  if (ids.length <= SKIPPED_DEVICES_LOGGED) return [...ids];
  return [...ids.slice(0, SKIPPED_DEVICES_LOGGED), `+${ids.length - SKIPPED_DEVICES_LOGGED} more`];
}

/**
 * What one fan-out (every recipient of one frame) accumulates so it prints ONE summary instead of
 * a line per device: `pushed` counts FCM sends accepted, `pushes` holds the in-flight ones.
 */
interface FanOutTally {
  pushed: number;
  pushes: Promise<unknown>[];
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  /**
   * {@link FURTHER_DEVICE_SELF_JOIN_OPEN}, read through the instance so a spec can exercise the open
   * door without a second build of the module.
   */
  protected readonly furtherDeviceSelfJoinOpen: boolean = FURTHER_DEVICE_SELF_JOIN_OPEN;
  /** Per-device count of sends that found no push token - see `sendFcmForQueued`. */
  private readonly noPushTokenRepeats = new RepeatCounter();
  /**
   * An invitation link's ask repeats by design: the waiting device asks a member on every recovery
   * cadence until one answers or the ask expires (14 days), and an older client also meets the
   * withheld base each time. Said once per (group, device), then at each power of ten.
   */
  private readonly awaitingAskRepeats = new RepeatCounter();
  /**
   * Whether a key-group fan-out is written as ONE shared payload. Read once at boot; OFF until a
   * release after the one that ships the readers turns it on - see `readSharedPayloadWrites`.
   */
  private readonly sharedPayloadWrites = readSharedPayloadWrites(
    process.env[SHARED_PAYLOAD_WRITES_ENV],
    this.logger
  );

  constructor(
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private oneTimeKeyPackageRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @InjectRepository(MlsCommitLog)
    private commitLogRepo: Repository<MlsCommitLog>,
    @InjectRepository(MlsGroupInfo)
    private groupInfoRepo: Repository<MlsGroupInfo>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {}

  /**
   * Whether `userId:deviceId` is on the revocation denylist under the one active-revocation rule -
   * read by the PAIR, on the `(userId, deviceId)` unique index. Shared by every gate that must
   * refuse a revoked device (routing, the commit gate), so they cannot disagree on what "revoked" is.
   */
  private async isDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
    const revoked = await this.revokedDeviceRepo.findOne({
      where: activeRevocationWhere({ userId, deviceId }),
      select: { id: true },
    });
    return Boolean(revoked);
  }

  /**
   * Whether a device may be given - or keep - an `active` routing membership.
   *
   * A device good enough to be MESSAGED must be at least as valid as one good enough to be
   * INVITED. `getPendingInvitations` already refuses to serve an invitation for a device that is
   * on the revocation denylist or has no static KeyPackage, and `sendWelcome` hard-fails without
   * one; the paths that mark a membership `active` checked neither. That asymmetry is WP-GHOST-1:
   * a device deleted through the product (footprint purged, denylisted) was resurrected as an
   * `active` membership by a PEER whose local MLS tree still carried its leaf, after which
   *
   *   - the fan-out kept queueing every message to it (`status = 'active'`),
   *   - `getUserDevices` could not list it (it filters on KeyPackage), so its owner could not
   *     delete it a second time,
   *   - `cleanupStaleDevices` enumerates candidates FROM `key_package`, so it never saw it,
   *   - `detectStaleDevices` pre-filtered on `updatedAt`, which peers keep bumping.
   *
   * Measured on production 2026-08-06: nine such devices held 97 353 of the 98 210 queued rows.
   * One of them, `tauri-...-ms8xyqkk-2rwh`, was revoked on 2026-07-31 and its membership rows were
   * still being written on 2026-08-04.
   *
   * Returns a reason rather than throwing: callers differ in what they owe the client (a 403, a
   * skip, or a log), and every one of them must be able to say WHY in its own log line.
   */
  async deviceAddressability(
    userId: string,
    deviceId: string
  ): Promise<{ ok: boolean; reason?: 'revoked' | 'no_key_package' }> {
    if (await this.isDeviceRevoked(userId, deviceId)) return { ok: false, reason: 'revoked' };
    const keyPackage = await this.keyPackageRepo.findOne({
      where: { userId, deviceId },
      select: { id: true },
    });
    if (!keyPackage) return { ok: false, reason: 'no_key_package' };
    return { ok: true };
  }

  /**
   * Deletes the entire server footprint of a device (per-device state):
   * device<->group memberships, static KeyPackage, one-time prekeys, push tokens,
   * undelivered queued messages, and Redis routing set membership.
   *
   * Does NOT touch `dm_group_members` (user-level membership shared across the user's
   * devices) nor the `RevokedDevice` denylist (specific to explicit deletion, outside GC).
   * Shared between manual device deletion and the stale-device GC to avoid duplicated
   * purge logic.
   *
   * **A REVOCATION RECORDS THE KEY GROUPS THE DEVICE HELD** (`recordKeyGroupsHeld`, passed by the
   * device deletion alone): in a key group the device rows deleted here are the only thing binding
   * the user to the group, and the revoked-leaves question answers a leaf only when it is bound. So
   * one `dm_revoked_device_groups` row per key group is written IN THE SAME TRANSACTION, from the
   * rows this deletes - a crash between the two cannot lose the binding. Conversations need none:
   * their seat stays. The GC and the PIN reset do not revoke, so they record nothing.
   */
  async purgeDeviceFootprint(
    userId: string,
    deviceId: string,
    options: { recordKeyGroupsHeld?: boolean } = {}
  ): Promise<{
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
    queuedMessagesDeleted: number;
    keyGroupsRecorded: number;
  }> {
    const memberships = await this.deviceGroupRepo.find({
      where: { userId, deviceId },
      select: { groupId: true },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    // The device rows and everything queued for the device - Welcomes included - go in ONE
    // transaction ({@link endDeviceMemberships}), after the key groups they bind are recorded.
    let keyGroupsRecorded = 0;
    const ended = await this.deviceGroupRepo.manager.transaction(async (manager) => {
      if (options.recordKeyGroupsHeld) {
        const recorded: unknown[] = await manager.query(
          `INSERT INTO dm_revoked_device_groups ("groupId", "userId", "deviceId")
           SELECT DISTINCT m."groupId", m."userId", m."deviceId"
             FROM dm_device_group_memberships m
             JOIN dm_groups g ON g.id = m."groupId"
            WHERE m."userId" = $1 AND m."deviceId" = $2
              AND (g."distributionWorkspaceId" IS NOT NULL OR g."distributionChannelId" IS NOT NULL)
           ON CONFLICT DO NOTHING
           RETURNING "groupId"`,
          [userId, deviceId]
        );
        keyGroupsRecorded = recorded.length;
      }
      return endDeviceMemberships(manager, { userId, deviceId }, 'all');
    });
    if (options.recordKeyGroupsHeld) {
      this.logger.log(
        `[PURGE_DEVICE] revoked device=${cutUserId(userId)}:${cutDeviceId(deviceId)} key groups recorded=${keyGroupsRecorded} of ${groupIds.length} group(s) held`
      );
    }

    const memberKey = `${userId}:${deviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    const [kpResult, otkpResult] = await Promise.all([
      this.keyPackageRepo.delete({ userId, deviceId }),
      this.oneTimeKeyPackageRepo.delete({ userId, deviceId }),
      this.pushTokenRepo.delete({ userId, deviceId }),
    ]);

    return {
      groupsCleaned: groupIds.length,
      keyPackagesDeleted: kpResult.affected ?? 0,
      oneTimeKeyPackagesDeleted: otkpResult.affected ?? 0,
      queuedMessagesDeleted: ended.queued,
      keyGroupsRecorded,
    };
  }

  private makeTraceId(scope: string): string {
    const { randomUUID } = crypto;
    return `${scope}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Binds a client-supplied `requesterUserId` to the authenticated caller.
   *
   * The welcome/history-request fan-out relays a control frame naming the requester so that peers
   * re-invite (or re-deliver history to) that identity. Because the requester device is typically
   * NOT yet a group member, membership cannot be checked here - the only meaningful gate is that a
   * caller may solicit re-invites/history for THEIR OWN identity only. Without this, a session
   * holder could forge `requesterUserId` to spoof another user across the fan-out.
   *
   * `authUserIdRaw` is the `x-user-id` header injected by nginx after auth. When it is absent
   * (legacy no-op, matching the rest of the authz campaign) the check is skipped; when present it
   * must equal the body's requester, otherwise a ForbiddenException is thrown.
   */
  private assertRequesterMatchesCaller(
    authUserIdRaw: string | undefined,
    requesterUserId: string,
    traceId: string,
    scope: string
  ): void {
    const authUserId = sanitizeOptionalQueryValue(authUserIdRaw, 'x-user-id');
    if (authUserId && authUserId.toLowerCase() !== requesterUserId.toLowerCase()) {
      this.logger.warn(
        `[${scope}][${traceId}] AUTHZ FAIL caller=${authUserId} != requester=${requesterUserId}`
      );
      throw new ForbiddenException('requesterUserId does not match the authenticated caller');
    }
  }

  private isTerminalPushTokenError(error: unknown): boolean {
    const rawCode =
      typeof error === 'object' && error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code = typeof rawCode === 'string' ? rawCode : '';

    return (
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    );
  }

  /**
   * Whether FCM refused a message for SIZE rather than for the token or the network.
   *
   * Classified on the error CODE, never on its prose: `messaging/payload-size-limit-exceeded` is
   * the documented code, and `invalid-argument` is what the v1 endpoint returns for the same
   * condition. The message ("Message is too large. The maximum is 4K (4096 bytes).") is only used
   * to narrow the second, because `invalid-argument` covers other faults too - and a distinction
   * carried in prose is one exactly this call site may make.
   *
   * @param error - Whatever `getMessaging().send()` threw.
   */
  private isPayloadTooLargeError(error: unknown): boolean {
    const asRecord = typeof error === 'object' && error ? (error as Record<string, unknown>) : {};
    const code = typeof asRecord.code === 'string' ? asRecord.code : '';
    if (code === 'messaging/payload-size-limit-exceeded') return true;
    const message = typeof asRecord.message === 'string' ? asRecord.message : '';
    return code === 'messaging/invalid-argument' && /too large/i.test(message);
  }

  /**
   * Send a data-only FCM push to every token registered for a given queued
   * message's recipient.  Data-only means onMessageReceived() fires even when
   * the app is in the background, letting the Android service decrypt and
   * display the notification locally.
   */
  private async sendFcmForQueued(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false,
    batch?: FanOutTally
  ): Promise<void> {
    if (getApps().length === 0) return;

    const pushTokens = await this.pushTokenRepo.find({
      where: { userId: queued.recipientId, deviceId: queued.deviceId },
    });

    if (pushTokens.length === 0) {
      // A RATE, NOT AN EVENT: every desktop and web device has no token for ever, so this fired
      // once per addressee per send. Said once per device, then at its 10th, 100th... send; the
      // population is `tools/cross-client-harness/devices.mjs --unpushable`, not this line.
      const nth = this.noPushTokenRepeats.hit(`${queued.recipientId}:${queued.deviceId}`);
      if (nth !== null) {
        this.logger.log(
          `[PUSH_SEND][${traceId}] No push token for user=${cutUserId(queued.recipientId)} device=${cutDeviceId(queued.deviceId)}` +
            (nth === 1 ? ' (repeats are counted, printed at 10, 100...)' : ` - send #${nth} to it`)
        );
      }
      return;
    }

    // THE RECIPIENT'S "MESSAGES" SWITCH. The frame must still REACH the device - an MLS ciphertext is
    // state the account needs to stay decryptable, so it cannot be dropped like a social push - but it
    // may be told to draw nothing: the same `silent` the own-device copies and receipts already use,
    // which both native clients honour. Decided here, once, so no client has to filter.
    let drawNothing = silent || queued.recipientId === senderId;
    // THE RECIPIENT'S LEVEL FOR THIS ONE CONVERSATION, read only for a frame that would draw. `none`
    // is the server's to apply, exactly like the switch above: the frame is sent silent. `mentions`
    // is NOT - the server cannot see who a ciphertext mentions - so it travels in the push and the
    // device decides after decrypting (`PushMessageInput.mentionsOnly`).
    let mentionsOnly = false;
    if (!drawNothing) {
      const disabled = await readDisabledCategories(this.groupRepo.manager, queued.recipientId);
      if (disabled.has('messages')) {
        drawNothing = true;
        this.logger.log(
          `[PUSH_SEND][${traceId}] category=messages disabled by user=${cutUserId(queued.recipientId)} - sent silent`
        );
      } else if (!isGroupUuid(groupId)) {
        // Every MLS conversation is a uuid row; a queued frame naming anything else is a defect
        // upstream, and the level it cannot have is not invented here.
        this.logger.warn(
          `[PUSH_SEND][${traceId}] group=${groupId} is not a uuid - no conversation level applies`
        );
      } else {
        const level = await readGroupNotificationLevel(
          this.groupRepo.manager,
          groupId,
          queued.recipientId
        );
        if (level === 'none') {
          drawNothing = true;
          this.logger.log(
            `[PUSH_SEND][${traceId}] level=none for user=${cutUserId(queued.recipientId)} group=${groupId} - sent silent`
          );
        } else if (level === 'mentions') {
          mentionsOnly = true;
          this.logger.log(
            `[PUSH_SEND][${traceId}] level=mentions for user=${cutUserId(queued.recipientId)} group=${groupId} - the device decides`
          );
        }
      }
    }

    // Resolve group name for a meaningful fallback when the Android service
    // cannot decrypt (app killed, JNI state unavailable).
    //
    // THE NAME AND THE KIND ARE TWO ANSWERS AND TRAVEL AS TWO FIELDS. The single `groupName`
    // that used to carry both read `''` for a DM, for a group nobody named, and for a row this
    // query could not fetch - three states the client then had to guess between, and 33% of
    // production's groups are the second one. See `PushMessageInput.isGroup`.
    let groupName = '';
    let isGroup: boolean | undefined;
    let isKeyDistribution: boolean | undefined;
    try {
      const group = await this.groupRepo.findOne({
        where: { id: groupId },
        // The two `distribution*` columns cost this query nothing and answer WHAT THE FRAME IS.
        // See `PushMessageInput.isKeyDistribution` for why the answer has to travel.
        select: {
          name: true,
          isGroup: true,
          distributionWorkspaceId: true,
          distributionChannelId: true,
        },
      });
      if (group) {
        isGroup = group.isGroup;
        groupName = group.isGroup ? (group.name ?? '') : '';
        isKeyDistribution = !!(group.distributionWorkspaceId || group.distributionChannelId);
      } else {
        // The queued message names a group that is not there. Nothing here can recover it, and the
        // push still goes out - but a reader must not be told this is a DM.
        this.logger.warn(
          `[PUSH_SEND][${traceId}] group=${groupId} has no row; the push carries neither conversation kind nor frame kind`
        );
      }
    } catch (error) {
      // A swallowed branch is invisible unless it says so, and this one silently decided the
      // shape of every notification for the message.
      this.logger.warn(
        `[PUSH_SEND][${traceId}] could not read group=${groupId}: ${String(error)}; ` +
          `the push carries neither conversation kind nor frame kind`
      );
    }

    // Resolve sender display name so the notification title is human-readable
    // when decryption fails in the background (SQLite lock / MLS state absent).
    const senderName = await resolveUserDisplayName(this.groupRepo.manager, senderId);

    // Inline ciphertext eliminates the extra HTTP round-trip in the Kotlin
    // service and avoids auth issues when the app is cold-started. FCM caps the
    // DATA MAP at 4 KB, keys included - so what the ciphertext may occupy is
    // whatever the other nine fields leave, computed from the fields themselves
    // (`inlineProtoBudget`). A constant chosen ahead of them bounded the wrong
    // quantity and let a long sender or group name push the map past the limit.
    const protoB64 = queued.proto ?? queued.content ?? '';

    // Shared, transport-agnostic description consumed by both the FCM data
    // payload and the APNs custom keys (see push-payload.ts).
    const messageInput: PushMessageInput = {
      groupId,
      queuedMessageId: queued.id,
      senderId,
      senderName,
      groupName,
      isGroup,
      isKeyDistribution,
      // Filled in below once the budget the other fields leave is known.
      proto: '',
      // Own-device copies, read receipts and welcome packets are not shown.
      silent: drawNothing,
      mentionsOnly,
      isWelcome: !!queued.isWelcome,
      createdAt: queued.createdAt.toISOString(),
    };

    const carriage = decideProtoCarriage(messageInput, protoB64);
    const inlineProto = carriage.proto;
    messageInput.proto = inlineProto;
    if (carriage.kind === 'over-budget') {
      // A MESSAGE that did not fit is the fixed fields growing (`senderName` and `groupName` are
      // unbounded user text) and nothing else watches them: accuse. The device still fetches it.
      this.logger.warn(
        `[PUSH_SEND][${traceId}] over-budget proto not inlined: ${carriage.bytes}B over a ${carriage.budget}B budget ` +
          `(senderName=${Buffer.byteLength(senderName, 'utf8')}B groupName=${Buffer.byteLength(groupName, 'utf8')}B)`
      );
    } else if (carriage.kind === 'long-frame') {
      // A long text: its own size, not the names, is what overflows. Expected - fetched by
      // `queuedMessageId` like a Welcome.
      this.logger.debug(
        `[PUSH_SEND][${traceId}] long frame carried by reference: ${carriage.bytes}B, budget ${carriage.budget}B`
      );
    } else if (carriage.kind === 'by-reference') {
      // A Welcome (ciphertext + ratchet tree) or a key-distribution frame over the budget (a seed
      // bundle, up to a 255 KiB page) is fetched by `queuedMessageId` through fetch-proto: expected,
      // so debug, not a line per frame.
      this.logger.debug(
        `[PUSH_SEND][${traceId}] ${carriage.reason} carried by reference: ${carriage.bytes}B, budget ${carriage.budget}B`
      );
    }

    const dataFields = buildPushDataFields(messageInput);
    const dataBytes = measureDataFields(dataFields);

    // Single transport for every device: FCM. Android receives the data-only
    // message (onMessageReceived fires foreground + background); iOS pushes are
    // relayed by FCM to APNs via the apns block (the .p8 APNs auth key is
    // configured in the Firebase console, so no direct APNs provider is needed).
    // Sized on the longest fallback body, which is what `inlineProtoBudget` admitted the ciphertext
    // against: the per-device substitution below can only make a payload SHORTER than this.
    const sizingRequest = buildApnsRequest(messageInput, dataFields, LONGEST_FALLBACK_LOCALE);
    const apnsBytes = measureApnsPayload(sizingRequest.payload);
    // Neither depends on the language, so both are decided once for every device.
    const { pushType: apnsPushType, priority: apnsPriority } = sizingRequest;

    // ONE BLOCK PER TOKEN, BECAUSE THE PLATFORM IS KNOWN HERE. Every message used to carry BOTH
    // the `data` map and an `apns` payload that `buildApnsRequest` spreads the same fields into -
    // so the ciphertext travelled twice in one message, and FCM sizes the message, not the half
    // the device will read. Measured on the shape that failed: data 3 789 B + apns 4 005 B =
    // 7 794 B against a 4 096 B limit, for a proto the old guard had passed. That is what refused
    // ten pushes in one run, twice over (2026-08-29 and 2026-08-30). FCM ignores the apns block
    // for an Android token and the data map is redundant for an iOS one - the APNs payload is
    // self-contained by design - so each token now carries exactly the half it reads.
    for (const pt of pushTokens) {
      try {
        await getMessaging().send(
          pt.platform === 'ios'
            ? {
                token: pt.token,
                apns: {
                  // Built HERE and not once above: the fallback body is the one sentence this
                  // server still composes, and only the token says which language to compose it
                  // in. Everything else in the payload is identical across devices.
                  payload: buildApnsRequest(messageInput, dataFields, pt.locale).payload,
                  headers: {
                    'apns-push-type': apnsPushType,
                    'apns-priority': String(apnsPriority),
                  },
                },
              }
            : {
                token: pt.token,
                data: dataFields,
                android: {
                  priority: 'high',
                  ttl: 86_400_000,
                },
              }
        );
        if (batch) {
          // ONE LINE PER FAN-OUT, NOT PER DEVICE: a frame queued to ~100 offline seats wrote ~100
          // of these and rolled the production log over in ~20 minutes. The caller prints the sum.
          batch.pushed++;
        } else {
          this.logger.log(
            `[PUSH_SEND][${traceId}] FCM sent user=${queued.recipientId} device=${pt.deviceId} platform=${pt.platform} inlineProto=${!!inlineProto} bytes=${pt.platform === 'ios' ? apnsBytes : dataBytes}`
          );
        }
      } catch (e) {
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pt.id });
          this.logger.warn(
            `[PUSH_SEND][${traceId}] Deleted invalid push token user=${queued.recipientId} device=${pt.deviceId}`
          );
        }
        this.logger.warn(
          `[PUSH_SEND][${traceId}] FCM failed user=${queued.recipientId} device=${pt.deviceId} err=${String(e)}`
        );
        // A size refusal is the one failure whose cause is entirely in our hands, and the error
        // FCM returns names no quantity at all - ten of them in one run said only "too large".
        // The payload is right here, so report what was actually sent: the data map as FCM counts
        // it, the APNs payload it is ALSO spread into (whether that duplication counts towards the
        // same 4096 is the open question), and the largest single field.
        if (this.isPayloadTooLargeError(e)) {
          const [largestKey, largestValue] = Object.entries(dataFields).reduce((a, b) =>
            Buffer.byteLength(b[1], 'utf8') > Buffer.byteLength(a[1], 'utf8') ? b : a
          );
          this.logger.warn(
            `[PUSH_SIZE][${traceId}] refused over size on ${pt.platform}: ` +
              `sent=${pt.platform === 'ios' ? apnsBytes : dataBytes}B (limit ${FCM_DATA_LIMIT}) ` +
              `data=${dataBytes}B apnsPayload=${apnsBytes}B ` +
              `largest=${largestKey}:${Buffer.byteLength(largestValue, 'utf8')}B inlineProto=${!!inlineProto}`
          );
        }
      }
    }
  }

  /**
   * Schedule a deferred FCM fallback for an "online" device.
   *
   * Android keeps the WebSocket TCP connection alive even when the app is
   * backgrounded/frozen, making `redis.exists(presence_key)` return true.
   * We send via WebSocket first, then check after DELAY_MS whether the client
   * ACKed the message.  If it has not (app could not process the WS frame),
   * we fire an FCM push so the user still gets a notification.
   */
  private scheduleDeferredPush(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false
  ): void {
    const DELAY_MS = 10_000;
    // setTimeout expects () => void; extract the async work into a separate
    // method to satisfy @typescript-eslint/no-misused-promises.
    const timer = setTimeout(() => {
      void this.runDeferredPush(queued, traceId, groupId, senderId, silent).catch((e) =>
        this.logger.warn(`[PUSH_DEFERRED][${traceId}] deferred push error: ${e}`)
      );
    }, DELAY_MS);
    // UNREFERENCED, because this timer must never be the reason a process stays alive. In the
    // service the HTTP server holds the loop open, so the delay elapses exactly as before; at
    // shutdown the pending fallback is simply dropped, which is the guarantee this path already
    // makes - the row is durable and the device's next pull redelivers it. Referenced, it kept a
    // test runner alive for ten seconds after every online delivery.
    timer.unref();
  }

  private async runDeferredPush(
    queued: QueuedMessage,
    traceId: string,
    groupId: string,
    senderId: string,
    silent = false
  ): Promise<void> {
    const stillQueued = await this.queuedMessageRepo.findOne({
      where: { id: queued.id },
    });
    if (!stillQueued) {
      // Client ACKed via WebSocket - nothing to do.
      return;
    }
    this.logger.log(
      `[PUSH_DEFERRED][${traceId}] queuedId=${queued.id} still unACKed after 10 s → FCM fallback`
    );
    await this.sendFcmForQueued(queued, `${traceId}-def`, groupId, senderId, silent);
  }

  /**
   * Refuses an addressed CONVERSATION frame unless every device it reaches applies rule 5 of
   * docs/wiki/protocols/history-answer-addressing.md - refuse any addressed frame that is not a
   * solicited, bounded history answer.
   *
   * THE EVIDENCE IS DECLARED BY THE CODE THAT WILL DECRYPT THE FRAME, not by a version, and it is
   * read ACROSS GATEWAY PROCESSES: every session of the device, on whichever gateway holds it, owns
   * one field of {@link addressingSessionsKey}, and ONE field that is not the capability makes the
   * device unaddressable - a tab left open on an older build, wherever it is connected. A session on
   * an OLDER gateway records no field; its only trace is the presence value `true`, which a current
   * gateway never overwrites, so anything but {@link PRESENCE_SESSIONS} is refused too. The frame is
   * transport-only (checked by the caller), so its addressee is online by construction and the live
   * sessions are exactly the readers. An offline addressee answers no capability and is refused too:
   * a transport frame would not have been queued for it anyway.
   *
   * @throws BadRequestException `{ error: 'addressed_unsupported', devices }` naming the devices that
   *   did not declare it - the answerer then answers nobody, and never by broadcast.
   */
  private async assertConversationAddressable(
    groupId: string,
    targets: ReadonlyArray<{ userId: string; deviceId: string }>,
    traceId: string
  ): Promise<void> {
    const incapable: string[] = [];
    for (const t of targets) {
      if (!(await publishIfAddressable(this.redis, t.userId, t.deviceId))) {
        incapable.push(`${t.userId}:${t.deviceId}`);
      }
    }
    if (incapable.length === 0) {
      this.logger.log(
        `[SEND][${traceId}] ADDRESSED_CONVERSATION group=${groupId} to=${targets
          .map((t) => t.deviceId)
          .join(',')} - every addressee declared ${ADDRESSED_HISTORY_CAPABILITY}`
      );
      return;
    }
    // EXPECTED while older builds are online, so not an error here: the answerer is told and answers
    // nobody, and the older device is served by an older peer as before.
    this.logger.log(
      `[SEND][${traceId}] REJECT addressed_unsupported group=${groupId} devices=${incapable.join(',')}` +
        ` - not every live session declared ${ADDRESSED_HISTORY_CAPABILITY}`
    );
    throw new BadRequestException({
      error: 'addressed_unsupported',
      message: `the addressed device(s) did not declare ${ADDRESSED_HISTORY_CAPABILITY}`,
      devices: incapable,
    });
  }

  /**
   * HANDS ONE QUEUED ROW TO ONE DEVICE, AND IT IS THE ONLY WAY A FRAME LEAVES THIS SERVICE.
   *
   * Online: publish the envelope on `chat:messages` for the gateway to route, then arm the deferred
   * FCM fallback. Offline: push straight away. Both branches are best-effort - the row is already
   * durable, and its next pull redelivers it - so neither is awaited by the caller's caller.
   *
   * THE ENVELOPE IS BUILT FROM THE ROW, not from the request that produced it, because the row is
   * the thing being delivered. The two send routes each built their own from their own body and
   * diverged exactly where a body differs from a row: the Welcome's envelope carried no `isCommit`,
   * no `createdAt` and an empty `senderDeviceId` written as a literal.
   *
   * **AND ONE OF THEM NEVER ARMED THE FALLBACK.** The deferred push exists because `online` can be
   * TRUE for an Android app that is frozen: the kernel keeps the TCP connection, the presence key
   * stays fresh, and the WebSocket frame is delivered to a process that cannot act on it. For an
   * ordinary message that costs one notification. For a WELCOME it costs the join - the device never
   * processes it, stays outside the group, and the next message push fails to decrypt with "Groupe
   * introuvable" - and `sendWelcome` published and stopped there. The fallback is not a policy of
   * the send route; it is a property of delivering anything to a device this server believes is
   * reachable.
   *
   * @param queued the persisted row, which carries every field the envelope needs
   * @param online whether the target device is reachable NOW; asked once by the caller, which can
   *   batch that question across a fan-out
   * @param silent no visible notification - true for every handshake frame
   * @param pushable false only for a TRANSPORT frame, whose rendezvous expires in 60 s: waking a
   *   device to hand it an expired exchange is worse than not waking it
   * @returns true when the frame went out in realtime
   */
  private async deliverQueuedFrame(
    queued: QueuedMessage,
    {
      tag,
      traceId,
      online,
      silent,
      pushable,
      batch,
    }: {
      tag: string;
      traceId: string;
      online: boolean;
      silent: boolean;
      pushable: boolean;
      batch?: FanOutTally;
    }
  ): Promise<boolean> {
    const groupId = queued.groupId ?? '';
    const senderId = queued.senderId ?? '';
    // A FAN-OUT PASSES ITS TALLY AND PRINTS ONE SUMMARY; a lone delivery (a Welcome) keeps its two
    // lines, which name the one device and are what a reader follows by trace id.
    if (!batch) {
      this.logger.log(
        `[${tag}][${traceId}] recipient=${queued.recipientId}:${queued.deviceId} ` +
          `online=${online} queuedId=${queued.id}`
      );
    }

    if (!online) {
      // Fire-and-forget: the row is persisted, and blocking on FCM (2-5 s per device) would stall
      // the sender's request. Every swallowed branch logs - that is all a lost push leaves behind.
      if (pushable) {
        const push = this.sendFcmForQueued(queued, traceId, groupId, senderId, silent, batch).catch(
          (e) =>
            this.logger.warn(`[PUSH_SEND][${traceId}] async FCM error queuedId=${queued.id}: ${e}`)
        );
        batch?.pushes.push(push);
      }
      return false;
    }

    const frame = JSON.stringify({
      recipientId: queued.recipientId,
      deviceId: queued.deviceId,
      senderId,
      senderDeviceId: queued.senderDeviceId ?? '',
      groupId,
      isWelcome: queued.isWelcome ?? false,
      isCommit: queued.isCommit ?? false,
      // Only a Welcome carries one; `JSON.stringify` drops the key when it is undefined, which is
      // what every other frame published before this was one function.
      ratchetTree: queued.ratchetTree,
      proto: queued.proto ?? queued.content ?? '',
      // Without this id a frame processed in realtime cannot be ACKed, so the durable row
      // survives and the next pull redelivers it - destructively, for a Welcome.
      queuedMessageId: queued.id,
      createdAt: queued.createdAt.toISOString(),
      // Only when true, like `ratchetTree`: the receiver refuses an addressed conversation frame
      // that is not a solicited history answer (history-answer-addressing, rule 5).
      ...(queued.addressed ? { addressed: true } : {}),
    });
    if (queued.addressed) {
      // THE CHECK AND THE PUBLISH ARE ONE SCRIPT (history-answer-addressing, rule 6): the sender's
      // check ran before the rows were written, and a session that registered since - an older tab -
      // would otherwise receive the frame. Refused here, the row stays queued for the declared
      // session's pull, which withholds it from any session that did not declare.
      const published = await publishIfAddressable(
        this.redis,
        queued.recipientId,
        queued.deviceId,
        { channel: 'chat:messages', payload: frame }
      );
      if (!published) {
        this.logger.error(
          `[${tag}][${traceId}] ADDRESSED row NOT published recipient=${queued.recipientId}:${queued.deviceId} ` +
            `queuedId=${queued.id} - a session that did not declare ${ADDRESSED_HISTORY_CAPABILITY} ` +
            `registered after the check; the row stays queued for a declared session to pull`
        );
        return false;
      }
    } else {
      await this.redis.publish('chat:messages', frame);
    }
    if (!batch) {
      this.logger.log(
        `[${tag}][${traceId}] PUBLISHED recipient=${queued.recipientId}:${queued.deviceId} ` +
          `queuedId=${queued.id}`
      );
    }

    if (pushable) {
      this.scheduleDeferredPush(queued, traceId, groupId, senderId, silent);
    }
    return true;
  }

  /**
   * Persists and delivers an MLS application message to all group members.
   * Handles the proto path - every live client, plus the two PushSecret routes and the commit
   * fan-out - and a legacy plaintext-`content` path no shipped client has taken since MLS.
   * For online recipients, publishes via Redis pub/sub and schedules a deferred FCM fallback.
   * For offline recipients, schedules an immediate FCM push (non-blocking).
   */
  /**
   * @param parting INTERNAL ONLY, never read from a request body: the removed devices a commit is
   *   also queued to, resolved by {@link validateCommit} from what the commit declares it removes.
   */
  async sendMessage(
    body: SendMessageBody,
    authUserIdRaw?: string,
    parting: ReadonlyArray<{ userId: string; deviceId: string }> = []
  ): Promise<SendMessageResult> {
    const traceId = this.makeTraceId('send');

    // `senderId` is what the shared log records as the author of the frame, and what a device
    // replaying the log attributes the message - and every mutation in it - to. It was taken from
    // the body and never compared to the authenticated caller, so a member could write frames into
    // a group's log under another member's name. Absent header = an internal caller (the gateway),
    // which never crosses nginx and therefore has none; same rule as every other route here.
    if (body.senderId) {
      this.assertRequesterMatchesCaller(authUserIdRaw, body.senderId, traceId, 'SEND');
    }

    const ops: QueuedMessage[] = [];
    let sentCount = 0;
    const addressed = readAddressedDevices(body);
    // ONE receive instant for the whole frame: every queued copy, the history stream row and the
    // answer to the sender carry it, so every device that holds this message holds the same server
    // time for it - the time an exclusion window is compared against (`historyEntitlement.ts`).
    const receivedAt = new Date();
    /** `userId:deviceId` of the parting devices this commit was queued to - consumed once queued. */
    let partingConsumed: string[] = [];
    /** An application frame's clear epoch and its author, compared with the group's under the lock. */
    let sealed: SealedFrame | undefined;

    this.logger.log(
      `[SEND][${traceId}] START group=${body.groupId ?? 'none'} sender=${body.senderId ?? 'unknown'}:${body.senderDeviceId ?? 'unknown'} hasProto=${!!body.proto} isWelcome=${!!body.isWelcome} isCommit=${!!body.isCommit}` +
        (addressed ? ` addressed=${[...addressed].join(',')}` : '')
    );

    if (body.proto) {
      // ── Proto path: proto = base64(raw MLS ciphertext) ────────────────────
      //
      // The recipient set is RESOLVED HERE, from the membership table. It is the path, not a
      // repair of one. It used to sit behind `if (ops.length === 0)`, after a loop over
      // `body.recipients`, under a comment reading "Fallback: recipients not provided (Redis
      // cache miss)" - and NO caller has ever populated that field: not the client
      // (`postApplicationMessage` posts six keys and none is `recipients`), not the gateway (the
      // word does not occur anywhere in its source), not either PushSecret route, not the commit
      // fan-out. `libs/proto/canari.proto` says so outright: "leave empty = derive from group
      // members". So the guard was true on every send, the "fallback" was the only path, and it
      // announced a cache miss on 100 % of traffic for a cache it never read. A fallback is a
      // signal, never a path: named one, it went unexamined for as long as it existed.
      const { proto } = body;
      if (body.groupId) {
        const groupId = body.groupId;

        // A SEND FROM A DEVICE THAT HOLDS NO LEAF IS UNDECRYPTABLE FOR EVERY RECIPIENT, and the
        // server holds the fact that says so before it queues a single row. A membership that is
        // not `active` means no Welcome was ever honoured, so the device is not in the MLS tree:
        // whatever it encrypts is ciphertext nobody in the group can open, fanned out to every
        // active device, while its author watches it leave. Measured on prod 2026-09-02:
        // `web-...-mtbep8vs-5oxb` sat `pending` in group `7da231f8` and sent six messages in 24
        // seconds - 30 rows of guaranteed garbage (`docs/wiki/backlog.md`).
        //
        // Refusing is not a policy preference. Accepting it is the shape the durable rules name
        // outright: handing an operation to a layer certain to refuse it, in order to classify the
        // refusal, when the discriminator was already known here.
        //
        // HANDSHAKE FRAMES ARE EXEMPT, and that is the whole subtlety. An external-commit join is
        // performed BY a device that is legitimately not active yet - `validateCommit` promotes it
        // precisely because such a device never receives a Welcome - so gating commits and Welcomes
        // here would wall up the one door out of `pending`.
        // AN ADDRESSED FRAME ON A CONVERSATION IS A HISTORY ANSWER, AND IS HELD TO WHAT MAKES THAT SAFE.
        // On a key-distribution group its one sender is a Graine answer (channel-encryption section
        // 23) and nothing changes. On a conversation the same field lets a member show one device a
        // frame the rest of the group never sees - an equivocation the ordinary fan-out (one
        // ciphertext, every member) makes impossible. It is accepted there since step A
        // (docs/wiki/protocols/history-answer-addressing.md, rules 3 and 6) only as a TRANSPORT
        // frame, and only to devices whose every live session declared that it refuses an addressed
        // frame that is not a solicited history answer - checked below, once the targets are known.
        const addressedConversation = addressed
          ? !(await this.isKeyDistributionGroup(groupId))
          : false;
        if (addressedConversation && (body.durable ?? !body.silent)) {
          this.logger.warn(
            `[SEND][${traceId}] REJECT addressed_durable group=${groupId} - an addressed frame on a ` +
              `conversation must be transport-only`
          );
          throw new BadRequestException({
            error: 'addressed_durable',
            message: 'an addressed frame on a conversation must be transport-only (durable: false)',
          });
        }

        const isHandshake = !!body.isCommit || !!body.isWelcome;
        if (!isHandshake && body.senderId && body.senderDeviceId) {
          // KEYED ON THE SENDER AS WELL AS ITS DEVICE: a row is a (person, device) pair, and a device
          // id alone would let one person send as another member's device. The authenticated caller
          // when there is one - the id its own rows were written under.
          const senderUserId =
            sanitizeOptionalQueryValue(authUserIdRaw, 'x-user-id') ?? body.senderId;
          const senderMembership = await this.deviceGroupRepo.findOne({
            where: { groupId, userId: senderUserId, deviceId: body.senderDeviceId },
          });
          if (!senderMembership) {
            // REFUSED (2026-10-22): a device with no row in this group is no member of it, and
            // queueing its frame would let any signed-in device write into any group. Measured
            // before the refusal: 0 such sends in the live production log.
            //
            // A DELETED GROUP IS ASKED FIRST: its deletion swept every row, so its members land here
            // too, and the client's outbox reads `group_deleted` (410) to drop the conversation -
            // a 403 would leave it retrying a group that no longer exists.
            await this.enqueueForLiveGroup([], groupId, 'SEND', traceId, undefined);
            this.logger.error(
              `[SEND][${traceId}] REJECT sender_not_member group=${groupId} device=${body.senderDeviceId}`
            );
            throw new ForbiddenException({
              error: 'sender_not_member',
              groupId,
              deviceId: body.senderDeviceId,
            });
          } else if (senderMembership.status !== 'active') {
            this.logger.error(
              `[SEND][${traceId}] REJECT sender_not_active group=${groupId} ` +
                `device=${body.senderDeviceId} status=${senderMembership.status} - the device holds ` +
                `no leaf, so nothing it encrypts can be opened by anyone in the group`
            );
            throw new ForbiddenException({
              error: 'sender_not_active',
              groupId,
              deviceId: body.senderDeviceId,
              status: senderMembership.status,
            });
          }
        }

        const memberships = await this.deviceGroupRepo.find({
          where: {
            groupId,
            status: 'active' as const,
          },
        });
        // A PENDING DEVICE A COMMIT ADMITS IS A RECIPIENT OF WHAT IT CAN OPEN (user, 2026-09-28).
        // A device added while its phone was dead is `pending` until its own join reports it, and
        // this path used to skip it for every frame sent in between - a replay at activation (DF2)
        // then re-sent what a five-minute window over the history stream still held, and nothing
        // else. It is queued here instead, at send time, like any member and so pushed like one -
        // but only frames sealed at or after the epoch its admitting commit recorded
        // (`ValidateCommitBody.admits`). A member lagging a commit behind can still seal at the
        // older epoch, which the newcomer can never open, and the frame's clear header is what says
        // which (`mlsFrameEpoch`). A Welcome is excluded: it carries no clear epoch and has its own
        // addressee.
        const frameEpoch = body.isWelcome ? null : mlsFrameEpoch(proto);
        const admitted =
          frameEpoch === null
            ? []
            : (
                await this.deviceGroupRepo.find({
                  where: {
                    groupId,
                    status: 'pending' as const,
                    admittedAtEpoch: LessThanOrEqual(frameEpoch),
                  },
                })
              ).filter((m) => m.admittedAtEpoch !== null);
        if (admitted.length > 0) {
          this.logger.log(
            `[SEND][${traceId}] PENDING_ADMITTED group=${groupId} frameEpoch=${frameEpoch} ` +
              `devices=${admitted.map((m) => `${m.deviceId}@${m.admittedAtEpoch}`).join(',')}`
          );
        }
        const recipients = [...memberships, ...admitted];
        const excludeSet = new Set<string>(body.excludeDeviceIds ?? []);
        const isSender = (m: { userId: string; deviceId: string }) =>
          m.userId === body.senderId && m.deviceId === body.senderDeviceId;
        // A device with no static KeyPackage does not exist server-side: it cannot be invited, it
        // cannot be Welcomed, and it is not even listed to its own owner - so queueing for it is
        // storage that nothing will ever collect or read (WP-GHOST-1). Deliberately narrow: an
        // `active` membership whose device merely went quiet still has its KeyPackage for the
        // whole 90-day window, so a legitimately offline device is never dropped.
        const recipientKeyPackages = recipients.length
          ? await this.keyPackageRepo.find({
              where: {
                deviceId: In([...new Set(recipients.map((m) => m.deviceId))]),
              },
              select: { userId: true, deviceId: true, deviceAppVersion: true },
            })
          : [];
        const liveDeviceIds = new Set(
          recipientKeyPackages.map((kp) => `${kp.userId}:${kp.deviceId}`)
        );
        if (!isHandshake && frameEpoch !== null) {
          // The sender's own row is in that read whenever its membership is active, which an
          // application frame needs to get this far - so naming its build costs no query.
          const senderVersion = recipientKeyPackages.find(
            (kp) => kp.userId === body.senderId && kp.deviceId === body.senderDeviceId
          )?.deviceAppVersion;
          sealed = {
            epoch: frameEpoch,
            sender: `${body.senderId ?? 'unknown'}:${body.senderDeviceId ?? 'unknown'}`,
            appVersion: senderVersion ?? 'unknown',
          };
        }
        const members = recipients.filter(
          (m) =>
            !isSender(m) &&
            !excludeSet.has(`${m.userId}:${m.deviceId}`) &&
            liveDeviceIds.has(`${m.userId}:${m.deviceId}`)
        );
        // AN ADDRESSED FRAME NARROWS THE SET RESOLVED ABOVE AND NEVER ADDS TO IT: a key that names no
        // live member of this group addresses nobody, so a client cannot use it to reach a device
        // outside the group. Measured on production 2026-10-12, an answer to one seed request was
        // queued for every seat of a 112-seat key group (`prod-queue-and-epoch-audit-2026-10-12`).
        const targets = addressed
          ? members.filter((m) => addressed.has(canonicalDeviceKey(m.userId, m.deviceId)))
          : members;
        if (addressed) {
          this.logger.log(
            `[SEND][${traceId}] ADDRESSED group=${groupId} matched=${targets.length} of ` +
              `${addressed.size} addressed, ${members.length} member device(s) not addressed: ` +
              `${members.length - targets.length}`
          );
          if (targets.length === 0) {
            // NOT refused: the addressee may have left the group or been revoked between its request
            // and this answer, which is an ordinary race and leaves nobody to deliver to. Said at
            // warn because it is also the shape of a client addressing the wrong key.
            this.logger.warn(
              `[SEND][${traceId}] ADDRESSED_NOBODY group=${groupId} - no live member device matches ` +
                `${[...addressed].join(',')}`
            );
          }
        }
        if (addressedConversation) {
          await this.assertConversationAddressable(groupId, targets, traceId);
        }
        const ghosts = recipients.filter(
          (m) =>
            !isSender(m) &&
            !excludeSet.has(`${m.userId}:${m.deviceId}`) &&
            !liveDeviceIds.has(`${m.userId}:${m.deviceId}`)
        );
        if (ghosts.length > 0) {
          // The outbox is best-effort at every step, so every swallowed branch logs - that is all
          // a dropped recipient leaves behind.
          this.logger.warn(
            `[SEND][${traceId}] SKIPPED_NO_KEY_PACKAGE group=${groupId} ` +
              `devices=${ghosts.map((m) => `${m.userId}:${m.deviceId}`).join(',')}`
          );
        }
        // A COMMIT ALSO REACHES WHOEVER IT REMOVES. A removal is recorded before its commit and
        // deletes the removed person's device rows, so the set above no longer names them - the
        // commit that removes them would never reach them (`partingKey` says why). The devices the
        // commit declared are queued like members' rows, minus any `targets` already names (a person
        // re-added in between is reached as a member), and their entries are consumed once queued.
        const already = new Set(targets.map((t) => `${t.userId}:${t.deviceId}`));
        const removed =
          body.isCommit && !addressed
            ? parting.filter((p) => !already.has(`${p.userId}:${p.deviceId}`))
            : [];
        partingConsumed = removed.map((p) => `${p.userId}:${p.deviceId}`);
        for (const m of [...targets, ...removed]) {
          ops.push(
            this.queuedMessageRepo.create({
              recipientId: m.userId,
              deviceId: m.deviceId,
              senderId: body.senderId,
              senderDeviceId: body.senderDeviceId,
              groupId,
              isWelcome: body.isWelcome,
              isCommit: body.isCommit,
              proto,
              createdAt: receivedAt,
              // The ROUTING fact the receiver needs: MLS encrypts for the whole group, so only the
              // server can say this copy went to this device alone (history-answer-addressing, 4).
              // Conversation frames only: it is what the receiver's rule 5 and the gateway's edge
              // filter act on, and a key-group seed answer is held to neither.
              addressed: addressedConversation,
            })
          );
        }

        // The gateway's routing set is OWNED by `activateDeviceMembership`, which writes it at
        // the pending->active transition - the moment membership is decided. What remains here is
        // a RECONCILIATION.
        //
        // **THAT OWNERSHIP WAS AN ASSERTION UNTIL 2026-09-13, AND THIS COMMENT RESTED ON IT.** It
        // named one historical cause - Redis ran without a volume until 2026-08-12, so the sets
        // that died with the container had no other writer - and a measurement taken on prod
        // 2026-08-15: of the 23 groups holding active memberships, the 15 that HAVE a set were
        // complete to the row, 0 missing and 0 stale. What the measurement could not see is that
        // the foreground status endpoint was ALSO promoting devices to `active` and writing no set
        // at all, so some of what this repaired was not a dead container but a live writer that
        // never wrote. A cause that had been fixed was covering one that had not. Both promotion
        // paths are fused onto the owner now, so what reaches here really is only the volume-less
        // era's residue.
        //
        // It therefore reports only when it CHANGES something, and it accuses when it does: an
        // active device absent from this set is one the gateway silently fails to reach
        // (`broadcast_to_group_members` proceeds with an empty member list and sends to nobody)
        // and one that can never be elected to answer a `welcome_request` or a `history_request`.
        // Firing at all means an owner did not write, and the fix belongs there.
        //
        // Reconciled against every LIVE member, not against `targets`: the sender is excluded from
        // its own delivery and an `excludeDeviceIds` entry from this one send, but both are
        // routable members like any other, and leaving them out made the repair incomplete by
        // construction - a member missing from the set is unelectable for ever.
        //
        // WRITTEN UNDER THE SEAT LOCK, AGAINST A RE-READ: `memberships` was read with no lock, so an
        // eviction may have deleted a seat and its route since. The missing entries are found first
        // (one round trip, no lock on the ordinary send), and only those still active when re-read
        // under the lock are added (`restoreRoutes`).
        const routable = memberships.filter((m) => liveDeviceIds.has(`${m.userId}:${m.deviceId}`));
        if (routable.length > 0) {
          const present = await this.redis.smismember(
            `group:members:${groupId}`,
            ...routable.map((m) => `${m.userId}:${m.deviceId}`)
          );
          const missing = routable.filter((_, i) => present[i] !== 1);
          if (missing.length > 0) {
            const { restored, gone } = await this.restoreRoutes(groupId, missing);
            if (restored.length > 0) {
              this.logger.warn(
                `[SEND][${traceId}] MEMBERS_CACHE_REPAIRED group=${groupId} added=${restored.length} of=${routable.length}` +
                  ` - these active devices were absent from the gateway routing set and unreachable by it`
              );
            }
            if (gone.length > 0) {
              this.logger.log(
                `[SEND][${traceId}] ROUTE_NOT_RESTORED group=${groupId} devices=${capLoggedDevices(gone).join(',')}` +
                  ` - their seat was gone when re-read under the seat lock`
              );
            }
          }
        }
      }
    } else {
      // THE PRE-MLS CONTENT PATH IS GONE (2026-10-22): measured unused - 0 rows in two months of the
      // queue, 0 sends in the live log - and a client route already refuses a send with no proto.
      // An internal caller reaching here is a defect in that caller.
      this.logger.error(
        `[SEND][${traceId}] REJECT proto_required group=${body.groupId ?? 'none'} - the content path is retired`
      );
      throw new BadRequestException({ error: 'proto_required', message: 'proto is required' });
    }

    // The sender declares durability (`body.durable`); the server sees ciphertext and can classify
    // nothing. It is needed BEFORE the persist below, because it decides who is even a recipient.
    const durable = body.durable ?? !body.silent;

    // Who is reachable right now. Asked once and reused by both the filter below and the delivery
    // loop, which used to ask Redis the same question a second time per recipient.
    const online = new Map<string, boolean>();
    for (const queued of ops) {
      const k = `${queued.recipientId}:${queued.deviceId}`;
      if (!online.has(k)) {
        online.set(
          k,
          !!(await this.redis.exists(devicePresenceKey(queued.recipientId, queued.deviceId)))
        );
      }
    }

    // A TRANSPORT frame is addressed to whoever is online NOW, and to nobody else.
    //
    // It is the same argument that keeps these frames out of the history stream one block below, and
    // it is stronger here. A transport frame is one half of a rendezvous that expires in 60 s
    // (`DIGEST_TTL_MS`), so a row drained by a device that reconnects later is answered by nothing
    // at all - and the reconciliation probe is elected only among devices Redis reports ONLINE, so
    // an offline device could not have been the responder even if it had the frame. Queueing it
    // wrote a row per member device and woke each of them with a silent FCM push, for an exchange
    // they were structurally unable to join. A device that comes back probes on its own connection.
    const toDeliver = durable
      ? ops
      : ops.filter((q) => online.get(`${q.recipientId}:${q.deviceId}`) === true);
    if (!durable && toDeliver.length < ops.length) {
      // NAMING THE DEVICES IT DROPPED, because the count alone cannot say which cause this was.
      // "the device really was offline" and "the group named a device that is not the live one" both
      // arrive here as `count=1`, they want opposite fixes, and telling them apart meant reading
      // Redis by hand against a group the run had already deleted. Measured on 2026-08-25 (COMM-18):
      // a phone's seed request was dropped for one offline recipient while the only device it could
      // have meant was answering pings throughout, and this line could not settle which. The ids are
      // exactly what the presence lookup was keyed on, so they are the evidence it owed.
      const skippedAll = ops
        .filter((q) => online.get(`${q.recipientId}:${q.deviceId}`) !== true)
        .map((q) => q.deviceId);
      // CAPPED: a key group names ~100 offline seats per frame, and the full list was most of the
      // bytes of this line (18 628 devices in 37 minutes). The count above is always exact.
      const skipped = capLoggedDevices(skippedAll);
      this.logger.log(
        `[SEND][${traceId}] TRANSPORT_SKIPPED_OFFLINE count=${ops.length - toDeliver.length} ` +
          `group=${body.groupId ?? ''} devices=${skipped.join(',')} ` +
          `- no row, no push: the rendezvous would expire first`
      );
    }

    // 1. Persist ALL messages first (survives crashes / timing races). What is delivered below is
    // what was queued: a seat evicted after the recipients were read is neither (`enqueueForLiveGroup`).
    let queuedRows: QueuedMessage[] = [];
    if (toDeliver.length > 0) {
      queuedRows = await this.enqueueForLiveGroup(
        toDeliver,
        body.groupId,
        'SEND',
        traceId,
        sealed,
        { seats: { exempt: new Set(partingConsumed) } }
      );
      this.logger.log(`[SEND][${traceId}] QUEUED count=${queuedRows.length}`);
      if (partingConsumed.length > 0 && body.groupId) {
        await this.redis
          .hdel(partingKey(body.groupId), ...partingConsumed)
          .catch((e: unknown) =>
            this.logger.warn(
              `[SEND][${traceId}] parting entries NOT cleared group=${body.groupId?.slice(0, 8)} - a later commit naming them reaches them again: ${String(e)}`
            )
          );
      }
    } else {
      // A GROUP DELETED BEFORE THIS SEND HAS NO ROSTER LEFT, SO IT LANDS HERE AND NOT ABOVE.
      // `tombstoneGroups` sweeps the device memberships with everything else, so the recipient set
      // resolves EMPTY and the liveness check inside `enqueueForLiveGroup` was never reached: the
      // send answered 200, appended to the dead group's history stream below, and the client marked
      // its message sent. The client's outbox no longer asks `GET /groups/:id` before a text send
      // and relies on this refusal, so it is owed on the empty roster too. Handshake frames are
      // left alone: their own paths decide what a dead group means for them.
      if (body.proto && body.groupId && !body.isCommit && !body.isWelcome) {
        await this.enqueueForLiveGroup([], body.groupId, 'SEND', traceId, sealed);
      }
      // TWO CAUSES, AND THE SENTENCE USED TO NAME NEITHER. `toDeliver` empties for one of exactly
      // two reasons and they want opposite readings: a group that named no other device has nobody
      // to queue for and nothing is wrong, while a TRANSPORT frame whose every recipient went offline
      // is a rendezvous that will now expire unanswered. A warning that cannot say which is a warning
      // its reader learns to skip - and this one fires on the ordinary path, during an invite into a
      // group whose other members have not joined yet.
      this.logger.warn(
        `[SEND][${traceId}] No message queued after validation - recipients=${ops.length} durable=${durable}` +
          (ops.length === 0
            ? ' - the group named no other device, so there was nobody to queue for'
            : ' - every recipient device is offline and this frame is transport-only')
      );
    }

    // 1b. Append to the group's shared history stream, so a device that was absent can obtain the
    // frame without a peer being online.
    //
    // `durable` is computed above, where it also decides the recipient set. Two things are still
    // excluded here rather than by the client:
    //  - Welcome / Commit: MLS epoch-transition frames that cannot be replayed out of order.
    //  - anything without a group or a sender: there is no stream to write to.
    //
    // This condition used to read `!body.silent`. Since every control frame is silent by
    // construction, that excluded every reaction, edit, deletion and read receipt from the only
    // shared copy that exists - the defect this rework removes
    // (`docs/wiki/protocols/history-reconciliation.md`).
    //  - an ADDRESSED frame: the stream is read by every member, and the frame is for some of them.
    if (
      body.proto &&
      !body.isWelcome &&
      !body.isCommit &&
      durable &&
      !addressed &&
      body.groupId &&
      body.senderId
    ) {
      try {
        const historyKey = `history:${body.groupId}`;
        // ONE ROUND TRIP FOR THE THREE COMMANDS. They are a single statement about the stream -
        // append it, bound it, keep the key alive - and issuing them one await at a time paid a
        // round trip each on the hot send path for no added guarantee.
        const written = await this.redis
          .pipeline()
          .xadd(
            historyKey,
            'MAXLEN',
            '~',
            String(HISTORY_STREAM_MAXLEN),
            '*',
            'sender_id',
            body.senderId,
            // THE DEVICE, NOT ONLY THE USER - and it is written here because here is the only place
            // it is still known. `history:{gid}` is ONE stream per group and must hold this device's
            // own frames, because every other member reads it; MLS then refuses them by construction
            // (`CannotDecryptOwnMessage`). `sender_id` cannot filter them: a user's OTHER device's
            // frames are both decryptable and wanted. So without this field a replay learns which
            // rows are its own only by handing each one to MLS to be refused - measured at 5 certain
            // failures per capture, every capture, and thousands per full replay of a 4 282-message
            // DM. Never learn by failing what a fact could have told you.
            'sender_device_id',
            body.senderDeviceId ?? '',
            'content',
            body.proto,
            'timestamp',
            receivedAt.toISOString()
          )
          // THE AGE BOUND - the one the rest of the system already claims and this stream alone did
          // not honour. `MAXLEN` bounds the stream by COUNT, which says nothing about how far back
          // it reaches: a group under the cap kept every frame it ever held, because the cap was
          // never met and the TTL above is refreshed on every write. Measured on production
          // 2026-08-17: four of five streams still carried rows from before 2026-08-15, at 1 to 11
          // entries each. Four compatibility shims are retired on "no row older than the retention
          // window can still exist" (`docs/wiki/legacy-compatibility.md`), and that sentence was
          // simply not true of an active group.
          //
          // EXACT, NOT `~`: an approximate trim stops at node boundaries and keeps up to a node's
          // worth of older entries, and a date that nothing may be older than cannot be
          // approximate. The cost is bounded - each entry is deleted once, ever, and the stream is
          // capped at `HISTORY_STREAM_MAXLEN`.
          .xtrim(historyKey, 'MINID', String(Date.now() - RETENTION_WINDOW_MS))
          // Refresh TTL on every write so abandoned groups are evicted after the offline-recovery
          // window of inactivity. Same window as every other staleness threshold, by construction.
          .expire(historyKey, Math.floor(RETENTION_WINDOW_MS / 1000))
          .exec();

        // A pipeline reports per-command failures in its RESULTS, not by throwing, so the `catch`
        // below never sees them. Left unread, a stream that stopped being trimmed or expired would
        // look exactly like one that was.
        if (!written) {
          this.logger.warn(`[HISTORY][${traceId}] pipeline aborted group=${body.groupId}`);
        } else {
          written.forEach(([err], i) => {
            if (err) {
              const name = ['XADD', 'XTRIM', 'EXPIRE'][i] ?? `command ${i}`;
              this.logger.warn(
                `[HISTORY][${traceId}] ${name} failed group=${body.groupId}: ${String(err)}`
              );
            }
          });
        }
        this.logger.log(`[HISTORY][${traceId}] XADD group=${body.groupId}`);
      } catch (e) {
        this.logger.warn(`[HISTORY][${traceId}] XADD failed group=${body.groupId}: ${String(e)}`);
      }
    }

    // 2. Best-effort real-time delivery for online recipients, through the one delivery.
    //
    // A handshake frame is always silent: the app processes it without telling anybody. `pushable`
    // is `durable`, which is false only for a TRANSPORT frame - and the offline branch is then
    // unreachable anyway, because the filter above kept only online recipients. Passing it rather
    // than relying on that keeps the two facts independent.
    const silent = body.isCommit || body.isWelcome ? true : (body.silent ?? false);
    const tally: FanOutTally = { pushed: 0, pushes: [] };
    for (const queued of queuedRows) {
      // Reuses the presence answer taken above rather than asking Redis a second time. A device
      // that went offline in between is covered the same way it always was: the row survives and
      // its next pull redelivers it.
      const delivered = await this.deliverQueuedFrame(queued, {
        tag: 'SEND',
        traceId,
        online: online.get(`${queued.recipientId}:${queued.deviceId}`) === true,
        silent,
        pushable: durable,
        batch: tally,
      });
      if (delivered) sentCount++;
    }
    if (tally.pushes.length > 0) {
      // The pushes are fire-and-forget (FCM takes 2-5 s per device), so their sum is printed when
      // the last one settles. Failures and missing tokens already logged themselves per device.
      const attempted = tally.pushes.length;
      void Promise.all(tally.pushes).then(() =>
        this.logger.log(
          `[PUSH_SEND][${traceId}] FCM sent batch pushed=${tally.pushed} of ${attempted} offline device(s)`
        )
      );
    }

    // The count REPORTED is the count actually written, not the count considered - a transport frame
    // drops its offline recipients above, and a log that still said `ops.length` would describe rows
    // that do not exist.
    this.logger.log(
      `[SEND][${traceId}] DONE queued=${queuedRows.length} realtime=${sentCount} offline=${tally.pushes.length}`
    );

    return {
      status: 'processed',
      queued: queuedRows.length,
      sent: sentCount,
      receivedAt: receivedAt.getTime(),
    };
  }

  /**
   * Epoch-gated commit: validates that the sender's baseEpoch matches the
   * group's activeEpoch before allowing the commit through.
   * Prevents MLS epoch forks caused by concurrent commits from multiple devices.
   *
   * Returns accepted=true with newEpoch on success, or accepted=false with
   * currentEpoch and a reason string when the commit is rejected.
   *
   * @param opts.mayAnswerAsk `false` from a door that is never a member's gesture - the background
   *   Welcome a push answers: a seat still awaiting a member's admission (an invitation link's ask)
   *   is then refused UNDER THE SEAT LOCK, answered `awaiting_admission`, never lifted
   *   ({@link enrolAdmittedPeople}). Not a body field, so no client can set it. Default `true`.
   */
  async validateCommit(
    body: ValidateCommitBody,
    authUserIdRaw: string,
    opts: { mayAnswerAsk?: boolean } = {}
  ): Promise<ValidateCommitResult> {
    const mayAnswerAsk = opts.mayAnswerAsk ?? true;
    const traceId = this.makeTraceId('commit');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    // THE COMMITTER IS THE CALLER, ON BOTH ROUTES THAT REACH HERE. `senderId` names the author of the
    // fan-out and the member whose device this commit activates, so it must be the authenticated
    // caller: the `x-user-id` of `POST /mls/commit`, or the device a PushSecret authenticated on the
    // background Welcome. There is no unauthenticated caller to exempt.
    const committer = sanitizeQueryValue(authUserIdRaw, 'committer');
    if (typeof body.senderId !== 'string' || body.senderId.length === 0) {
      this.logger.warn(`[COMMIT][${traceId}] REJECT no_sender group=${groupId}`);
      throw new BadRequestException({
        error: 'sender_required',
        message: 'senderId is required',
      });
    }
    this.assertRequesterMatchesCaller(authUserIdRaw, body.senderId, traceId, 'COMMIT');
    // THE DEVICE IS NOT REVOKED - asked FIRST, so a revoked device is told the reason that is true.
    // A revocation purges the static KeyPackage, so the ownership check below would refuse it as
    // `device_not_owned`, a coincidence of the purge and not a rule, and the answer its client acts
    // on. A revoked device is exactly the one whose leaf members are removing, and a commit from it
    // would move the epoch of every group it still holds, its Remove of THEIR leaves included.
    // Refused before the lock and before the duplicate answer: a resubmission is a commit too, and a
    // revoked device is told so rather than told it landed. Read by the pair, on the
    // `(userId, deviceId)` unique index the denylist already carries - no migration.
    if (await this.isDeviceRevoked(committer, deviceId)) {
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT device_revoked group=${groupId} device=${deviceId} ` +
          `sender=${sanitizeLogValue(committer)}`
      );
      throw new ForbiddenException(
        refusalBody(RefusalCode.DEVICE_REVOKED, 'this device was revoked', {
          error: 'device_revoked',
        })
      );
    }
    // AND THE DEVICE IS THE CALLER'S: the commit activates `senderId:deviceId`, so a device
    // registered to anyone else is refused. The static KeyPackage row is the registry, and it is
    // unique on the PAIR - read by the pair, never by the device id alone.
    const registered = await this.keyPackageRepo.findOne({
      where: { userId: committer, deviceId },
      select: { id: true },
    });
    if (!registered) {
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT device_not_owned group=${groupId} device=${deviceId} ` +
          `sender=${sanitizeLogValue(committer)}`
      );
      throw new ForbiddenException({
        error: 'device_not_owned',
        message: 'this device is not registered to the committer',
      });
    }
    const baseEpoch =
      typeof body.baseEpoch === 'number' && Number.isFinite(body.baseEpoch)
        ? Math.floor(body.baseEpoch)
        : -1;

    if (baseEpoch < 0) {
      this.logger.warn(
        `[COMMIT][${traceId}] Invalid baseEpoch=${body.baseEpoch} group=${groupId} device=${deviceId}`
      );
      throw new BadRequestException('baseEpoch must be a non-negative integer');
    }
    const invitationSeatGeneration = await this.readInvitationSeatGeneration(
      body.invitationSeatGeneration,
      groupId,
      traceId
    );

    // A COMMIT THAT CANNOT BE REPLAYED MAY NOT ADVANCE THE EPOCH.
    //
    // Without `proto` there is nothing to record, so the counter moves and the log gains no row -
    // a hole by construction, and a permanent one: `IDX_mls_commit_log_group_epoch` is UNIQUE on
    // `(groupId, baseEpoch)`, so no later call can ever refill the epoch this one skipped, and
    // every device that stops there needs a destructive re-Welcome to move again. The old code
    // took this path in silence, under `if (body.proto)`, without even the warning that the
    // failure branch below it had.
    //
    // `proto` was documented optional for backward compatibility, and nothing needs that. There are
    // TWO callers and both carry the commit: `submitCommit` in
    // `frontend/src/lib/mls-client/mlsDeliveryApi.ts`, which has always taken `protoBase64` as a
    // REQUIRED argument, and `sendWelcomeAndCommitPush` in `push.controller.ts`, the background
    // re-add. **This comment named only the first for a month, and the second was passing no
    // `proto` the whole time** - so every FCM-woken re-add threw the 400 below, before its Welcome.
    // A seam is audited by enumerating the call sites that REACH it, never the ones that mention
    // it. Held as a const so the epoch-advance transaction below reads a value the compiler knows
    // is present.
    const commitProto = body.proto;
    if (!commitProto) {
      this.logger.error(
        `[COMMIT][${traceId}] REJECT no_proto group=${groupId} device=${deviceId} baseEpoch=${baseEpoch}`
      );
      throw new BadRequestException(
        'proto is required: a commit that cannot be replayed may not advance the epoch'
      );
    }
    // THE COMMIT MUST SAY WHAT THE REQUEST SAYS: its clear header names this group and this base
    // epoch, and it has the shape of a member or an external commit (`readCommitFrame`). The gate
    // below decides who may commit on the header's word, so the header is not left free.
    const frame = readCommitFrame(commitProto);
    if (!frame || frame.groupId !== groupId || frame.epoch !== baseEpoch) {
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT commit_malformed group=${groupId} device=${deviceId} ` +
          `baseEpoch=${baseEpoch} framed=${!!frame} groupMatch=${frame?.groupId === groupId} ` +
          `epochMatch=${frame?.epoch === baseEpoch}`
      );
      throw new BadRequestException({
        error: 'commit_malformed',
        message: 'this commit is not accepted',
      });
    }
    // AN EXTERNAL COMMIT JOINS AS THE CALLER'S OWN DEVICE: the leaf it adds names
    // `committer:deviceId`, the identity every KeyPackage of this device was refused without
    // (`DeviceSignatureKeysService.record`) - one binding for every route a leaf enters a tree by.
    if (frame.external && frame.leafIdentity !== `${committer}:${deviceId}`) {
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT external_leaf_foreign group=${groupId} ` +
          `sender=${sanitizeDevicePairLogValue(committer, deviceId)} ` +
          `leaf=${sanitizeLeafLogValue(frame.leafIdentity)}`
      );
      throw new ForbiddenException({
        error: 'commit_identity_mismatch',
        message: 'this commit is not accepted',
      });
    }
    if (frame.external && frame.removedLeaves.length > 0) {
      await this.assertExternalRemoveIsOwnPriorLeaf(groupId, frame, traceId);
    }
    const committerClaim = await this.assertCommitterMayCommit(
      groupId,
      committer,
      deviceId,
      frame.external,
      traceId
    );
    const admitAnswer = await this.claimKeyGroupAdmits(groupId, body.admits, baseEpoch, traceId);
    if (admitAnswer && !(admitAnswer instanceof Map)) {
      return (
        (await this.answerIfAlreadyAccepted(
          groupId,
          baseEpoch,
          commitProto,
          deviceId,
          traceId
        )) ?? {
          accepted: false,
          currentEpoch: admitAnswer.epochMismatch,
          reason: 'epoch_mismatch',
        }
      );
    }
    const admitClaims = admitAnswer instanceof Map ? admitAnswer : null;

    // A CARRIED WELCOME'S TARGET IS DECIDED BEFORE THE EPOCH MOVES, and outside the lock: a key
    // group asks social-service, a network call the 5 s lock must not wait on. A refusal here
    // records, fans out and sends nothing, so the committer discards what it staged.
    let welcome: (NonNullable<ValidateCommitBody['welcome']> & WelcomeSeat) | null = null;
    if (body.welcome) {
      const targetDeviceId = sanitizeQueryValue(body.welcome.deviceId ?? '', 'welcome.deviceId');
      const targetUserId = sanitizeQueryValue(body.welcome.userId ?? '', 'welcome.userId');
      if (typeof body.welcome.payload !== 'string' || !body.welcome.payload) {
        throw new BadRequestException('welcome.payload required');
      }
      const targetGroup = await this.groupRepo.findOne({ where: { id: groupId } });
      const target = await this.resolveWelcomeTarget(
        targetGroup,
        groupId,
        targetUserId,
        targetDeviceId,
        traceId,
        'COMMIT'
      );
      if ('refused' in target) {
        return {
          accepted: false,
          currentEpoch: targetGroup?.activeEpoch ?? 0,
          reason: target.refused,
        };
      }
      welcome = {
        userId: target.userId,
        deviceId: targetDeviceId,
        payload: body.welcome.payload,
        ratchetTree:
          typeof body.welcome.ratchetTree === 'string' ? body.welcome.ratchetTree : undefined,
        keyGroup: distributionScopeOf(targetGroup) !== null,
        claim: target.claim,
      };
    }

    this.logger.log(
      `[COMMIT][${traceId}] START group=${groupId} device=${deviceId} baseEpoch=${baseEpoch}`
    );

    // Serialize via Redis lock to prevent TOCTOU races.
    // Two devices sending commits at the same epoch would both read the same
    // activeEpoch - the lock ensures only one gets through.
    const lockKey = `mls:commitlock:${groupId}`;
    const lockAcquired = await this.redis.set(lockKey, deviceId, 'EX', 5, 'NX');
    if (lockAcquired !== 'OK') {
      // Another commit is being validated right now - reject to retry.
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT concurrent_commit group=${groupId} currentEpoch=${group?.activeEpoch ?? 0}`
      );
      return {
        accepted: false,
        currentEpoch: group?.activeEpoch ?? 0,
        reason: 'concurrent_commit',
      };
    }

    /** The asks this commit answered, set only once it is accepted - announced after the release. */
    let acceptedAsks: AnsweredAsk[] = [];
    try {
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      if (!group) {
        this.logger.error(`[COMMIT][${traceId}] Group not found: ${groupId}`);
        throw new BadRequestException(`Group ${groupId} not found`);
      }

      // Strict epoch gate: the submitted baseEpoch must match the server's activeEpoch exactly.
      // A genuinely uninitialized group (just created) always has its first commit at
      // baseEpoch 0: activeEpoch==0 therefore legitimately only
      // accepts baseEpoch==0. The old bypass (accepting any baseEpoch when activeEpoch==0)
      // let an inconsistent device fast-forward the counter (e.g. baseEpoch=5 -> activeEpoch=6)
      // and desynchronize everyone (H4).
      // A RESUBMISSION OF A COMMIT THIS GATE ALREADY ACCEPTED IS ANSWERED AS ACCEPTED
      // (`answerIfAlreadyAccepted`) - here, and at every other place that refuses on the epoch.
      if (baseEpoch < group.activeEpoch) {
        const duplicate = await this.answerIfAlreadyAccepted(
          groupId,
          baseEpoch,
          commitProto,
          deviceId,
          traceId
        );
        if (duplicate) return duplicate;
      }
      if (baseEpoch !== group.activeEpoch) {
        this.logger.warn(
          `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} activeEpoch=${group.activeEpoch}`
        );
        return {
          accepted: false,
          currentEpoch: group.activeEpoch,
          reason: 'epoch_mismatch',
        };
      }

      // ADVANCE THE EPOCH AND PUBLISH ITS BASE IN ONE TRANSACTION.
      //
      // The base an external joiner builds on is the ONE thing the strict gate above cannot be
      // lenient about, and until 2026-08-26 it was minted by a SECOND client round-trip made after
      // this one returned. Nothing else ever mints one, so losing that call - a tab reload is
      // enough, and an external joiner reloads by construction - separated the two numbers for
      // good: every later external commit was refused, and a distribution group has no
      // peer-Welcome fallback to take instead. COMM-22 is that row (`docs/wiki/backlog.md`).
      //
      // THE WINDOW IS DELETED RATHER THAN NARROWED. The base travels inside the submission, and the
      // epoch it describes is written with it or neither is: the committing device is the only one
      // that can export a base for `baseEpoch + 1`, and it holds the tree exactly here. Its
      // authority is the commit the gate just accepted - a stronger proof of membership than any
      // roster row, which is why no separate check is owed. `putGroupInfo` stays monotonic, so a
      // late refresh from an older epoch still cannot walk the base backwards.
      //
      // Legacy clients send no `groupInfo`; for them this is the plain advance it always was, and
      // `republishStaleBase` on a holder remains their repair.
      const newBase = typeof body.groupInfo === 'string' && body.groupInfo ? body.groupInfo : null;
      // EVERY DECLARED ADMIT THE GATE DROPS IS ANSWERED, not only logged (`refusedAdmits`): the
      // committer sends each admitted device a Welcome next, and one to a device it was told nothing
      // about is learned by failing (DEV-3, 2026-10-25). Those dropped before the transaction here;
      // those dropped inside it in `admitRefusalsInTx`, reset per attempt.
      const admitRefusals: RefusedAdmit[] = [];
      let admitRefusalsInTx: RefusedAdmit[] = [];
      const declaredAdmits = await this.resolveAdmittedDevices(
        groupId,
        deviceId,
        body.admits,
        traceId,
        admitRefusals
      );
      let admitted = declaredAdmits;
      // An external-commit join is the ONE path where the committing device may not be a member
      // yet: it never receives a Welcome, so nothing ever promotes its
      // `dm_device_group_memberships` row (the foreground `updateInvitationStatus` and the
      // background FCM Welcome both do). Recipient resolution filters on `status='active'`, so
      // without this promotion the freshly rejoined device stays invisible to routing: it receives
      // neither the history bundle it is about to solicit nor any subsequent live message, while
      // its own sends work - a silent one-way group. Read first so the seat write (and its log
      // line) stays an event rather than a no-op on every ordinary commit.
      //
      // Every identity downstream of the gate is the CALLER's (`committer`), never the body's
      // spelling of it, and every row is read by the pair, never by the device id alone.
      const committerRow = await this.deviceGroupRepo.findOne({
        where: { userId: committer, deviceId, groupId },
      });
      const committerNeedsSeat =
        committerRow?.status !== 'active' &&
        !isUnresolvedIdentity(committer) &&
        !isUnresolvedIdentity(deviceId);
      /** Whether this commit writes its committer's seat - decided, then done, in the transaction. */
      let committerSeat = false;
      // THE ADVANCE, THE BASE AND THE REPLAYABLE COMMIT LAND TOGETHER OR NOT AT ALL.
      //
      // The log row used to be written AFTER this transaction, best-effort, on the reasoning that
      // "a failure must not undo the accepted epoch advance" - while the comment above it claimed
      // it was stored "UNDER THE LOCK (atomic with the advance)". It was under the lock and outside
      // the transaction, and the two are not the same thing.
      //
      // That inversion cost group `7da231f8` its epoch 121 (measured on prod 2026-09-02, see
      // `docs/wiki/backlog.md`): the counter moved, no replayable commit was recorded, and the
      // UNIQUE `(groupId, baseEpoch)` index means NOTHING CAN EVER REFILL IT. The log stops being a
      // log the moment one row is optional, because a reader cannot tell a hole from an end.
      //
      // So the priority is reversed: the row that makes this advance survivable for every OTHER
      // device is not optional, and failing to write it fails the commit. The cost is one retry by
      // the committer, which `submitCommit` is already built for - it rolls the staged commit back
      // on a reject - against a loss that no later call can repair.
      let queuedWelcome: QueuedMessage | null = null;
      /** The invitation-link asks this commit answered, announced once it has committed. */
      let admittedAsks: AnsweredAsk[] = [];
      try {
        await this.groupRepo.manager.transaction(async (m) => {
          admittedAsks = [];
          admitRefusalsInTx = [];
          // THE ADMITS WRITE SEATS, SO THEY TAKE THE SEAT LOCK - first, before any row, so this
          // transaction and an eviction always take their locks in the same order. In a key group
          // each admitted person was asked of social-service before any lock, against a claim
          // (`claimKeyGroupAdmits`); here the claim is re-read, a database read only, and a person
          // not entitled, evicted since, or departing is not admitted.
          await takeSeatLock(m, groupId);
          // THE COMMITTER'S SEAT IS WRITTEN IN THIS TRANSACTION, against its claim re-read here. An
          // external commit's leaf enters the tree with this advance, and so does a pending device's
          // first commit: written later, in a transaction of its own, the seat would meet any
          // eviction of the group since - the generation is the group's - and leave a leaf with no
          // seat after an accepted commit. So the claim decides here, before the epoch moves:
          // overtaken by an eviction, the whole commit is refused and retried
          // ({@link SeatClaimOvertaken}); a departure of the committer's own refuses an external join,
          // and leaves a member's commit standing with no seat, as it always has.
          if (frame.external || committerNeedsSeat) {
            const refusal = await seatClaimHolds(m, committerClaim);
            if (refusal === 'evicted_since_claim') {
              this.logger.warn(
                `[COMMIT][${traceId}] REJECT seat_claim_overtaken group=${groupId} ` +
                  `device=${sanitizeLogValue(committer)}:${deviceId} seat=committer ` +
                  `claimedAt=${committerClaim.generation} - an eviction in the group overtook it`
              );
              throw new SeatClaimOvertaken('committer');
            }
            if (refusal !== null && frame.external) {
              this.logger.warn(
                `[COMMIT][${traceId}] REJECT committer_not_member group=${groupId} ` +
                  `device=${sanitizeLogValue(committer)}:${deviceId} kind=external reason=${refusal}`
              );
              throw new ForbiddenException(
                refusalBody(RefusalCode.NOT_A_MEMBER, 'this commit is not accepted', {
                  error: 'committer_not_member',
                })
              );
            }
            if (refusal !== null) {
              this.logger.warn(
                `[COMMIT][${traceId}] committer seat NOT written group=${groupId} ` +
                  `device=${sanitizeLogValue(committer)}:${deviceId} reason=${refusal}`
              );
            } else {
              committerSeat = committerNeedsSeat;
            }
          }
          if (admitClaims) {
            const kept: typeof declaredAdmits = [];
            for (const a of declaredAdmits) {
              const claim = admitClaims.get(a.userId);
              const refusal = claim ? await seatClaimHolds(m, claim) : 'not_entitled';
              if (refusal === null) {
                kept.push(a);
                continue;
              }
              // An eviction overtook an ENTITLED person's claim - possibly someone else's eviction.
              // Dropping the admit would accept a commit that puts their leaf in the tree with no
              // seat and nothing retrying it, so the whole commit is refused instead.
              if (refusal === 'evicted_since_claim') {
                this.logger.warn(
                  `[COMMIT][${traceId}] REJECT seat_claim_overtaken group=${groupId} ` +
                    `device=${a.userId}:${a.deviceId} seat=admit - an eviction in the group overtook it`
                );
                throw new SeatClaimOvertaken('admit');
              }
              this.logger.warn(
                `[COMMIT][${traceId}] ADMIT_REFUSED group=${groupId} device=${a.userId}:${a.deviceId} reason=${refusal}`
              );
              admitRefusalsInTx.push({ userId: a.userId, deviceId: a.deviceId, reason: refusal });
            }
            admitted = kept;
          }
          // EVERY ADMIT INSERTS A ROW, SO EACH IS WRITTEN ONLY BESIDE ITS KEY PACKAGE, read `FOR
          // SHARE` here, in any kind of group ({@link heldKeyPackages}): a device whose account is
          // being erased gets no row, which the erasure could no longer find. The admit is DROPPED
          // and the commit still accepted, unlike an overtaken claim above: the leaf it adds belongs
          // to an account that is going, or to a device its owner revoked while the Add was in flight
          // (DEV-3), so no one is owed a seat or a retry, and refusing the commit would stall every
          // other change it carries for the group. The committer is told (`refusedAdmits`).
          const keyed = await heldKeyPackages(m, admitted);
          admitted = admitted.filter((a) => {
            if (keyed.has(`${a.userId}:${a.deviceId}`)) return true;
            this.logger.warn(
              `[COMMIT][${traceId}] ADMIT_REFUSED group=${groupId} device=${a.userId}:${a.deviceId} ` +
                `reason=no_key_package (read under the seat lock - the device was revoked or its account is being erased)`
            );
            admitRefusalsInTx.push({
              userId: a.userId,
              deviceId: a.deviceId,
              reason: 'no_key_package',
            });
            return false;
          });
          // A WELCOME IS NEVER STORED FOR A GROUP THAT ENDED while this commit was in flight - the
          // device handed one asks for a group nobody can serve, on every reconnection. Read under a
          // row lock so the deletion and this write cannot interleave (the guard of
          // `enqueueForLiveGroup`, held here because this row is written in the advance).
          if (welcome) {
            const [live] = await m.getRepository(Group).find({
              where: { id: groupId },
              select: { id: true, deletedAt: true },
              lock: { mode: 'pessimistic_write' },
            });
            if (!live || live.deletedAt) {
              this.logger.warn(
                `[COMMIT][${traceId}] REJECT group_deleted group=${groupId} - the Welcome it carries ` +
                  `would be undeliverable for ever, so the commit is not recorded`
              );
              throw new GoneException({ error: 'group_deleted', groupId });
            }
            // ...AND THE TARGET STILL HOLDS ITS SEAT, re-read under the locks this transaction holds
            // before anything is written, so a removal or an eviction racing this commit serialises
            // with it ({@link lockWelcomeSeat}).
            if (!(await this.lockWelcomeSeat(m, welcome, groupId, traceId, 'COMMIT'))) {
              throw new WelcomeSeatGone();
            }
          }
          // THE ADVANCE IS CONDITIONAL ON THE BASE THE GATE READ. The gate reads the epoch outside
          // this transaction and the advance may wait on the seat lock above, longer than the
          // Redis lock's 5 s: two commits at one base can both pass the read. Only one can move the
          // epoch from it - the second waits on the row, then matches nothing - so the epoch never
          // forks, whatever a timer did.
          // THE SEAT GENERATION THE NEW EPOCH BEGINS AT, read under the seat lock every removal moves
          // it under - so it is stable here. The base's own (`epochSeatGeneration` before this
          // write) orders every departure since against this commit ({@link enrolAdmittedPeople}).
          const seatGenerations = await this.readSeatGenerations(m, groupId);
          const advance = await m
            .getRepository(Group)
            .update(
              { id: groupId, activeEpoch: baseEpoch },
              { activeEpoch: baseEpoch + 1, epochSeatGeneration: seatGenerations.current }
            );
          if ((advance.affected ?? 0) !== 1) throw new EpochAdvanceLost('epoch_moved');
          if (newBase) {
            await this.putGroupInfo(groupId, newBase, baseEpoch + 1, m);
          }
          // Keyed by baseEpoch: only one commit can advance from a given epoch (the update above). A
          // row already there is another commit's for this base, and replaying it in place of this
          // one forks every device that catches up - so the advance is refused with it, never
          // accepted beside it.
          const logged = await m
            .getRepository(MlsCommitLog)
            .createQueryBuilder()
            .insert()
            .values({
              groupId,
              baseEpoch,
              commit: commitProto,
              senderDeviceId: deviceId,
            })
            .orIgnore()
            .returning(['baseEpoch'])
            .execute();
          if (!Array.isArray(logged.raw) || logged.raw.length !== 1) {
            throw new EpochAdvanceLost('log_row_exists');
          }
          // THE PEOPLE THIS COMMIT ADMITS ARE ENROLLED WITH THE ADVANCE ({@link enrolAdmittedPeople}),
          // so an accepted Add and its roster row commit together or not at all - whichever request
          // of the commit lands, and a resubmission answered `duplicate` finds both. A person it
          // refuses refuses the WHOLE commit ({@link AdmitRefused}): no leaf is accepted that no seat
          // holds, and the client rebuilds without them. BEFORE ANY DEVICE ROW,
          // the one order of `utils/seat-eviction.ts` (the roster row, then the device rows), so this
          // and the route writing the same person wait on the roster row, never in a cycle.
          // ORDERED AGAINST WHEN THE ADD WAS DECIDED: the generation a member's invitation read with
          // its roster, when it carries one, else the base epoch's (`invitationSeatGeneration`).
          // The inline Welcome's target is a person this commit admits too, held to the same bar.
          if (!distributionScopeOf(group)) {
            const { refused, committerNotOnRoster, awaitingAsk } = await this.enrolAdmittedPeople(
              m,
              groupId,
              committer,
              welcome
                ? [...admitted, { userId: welcome.userId, deviceId: welcome.deviceId }]
                : admitted,
              invitationSeatGeneration ?? seatGenerations.base,
              invitationSeatGeneration === undefined ? 'base_epoch' : 'invitation',
              traceId,
              mayAnswerAsk
            );
            // A DOOR THAT IS NO MEMBER'S GESTURE NEVER ANSWERS AN ASK, typed apart from every other
            // admission refusal so the push that tried is told why, and records the target.
            if (awaitingAsk) throw new AskNotAnswerable();
            // A Welcome stored with this advance would hand a refused person the epoch's secrets:
            // refused as for a Welcome whose seat went, the answer that commit's sender reads.
            if (welcome && refused.has(welcome.userId)) {
              this.logger.warn(
                `[COMMIT][${traceId}] REJECT welcome_target_not_admitted group=${groupId} ` +
                  `target=${sanitizeLogValue(welcome.userId)}:${sanitizeLogValue(welcome.deviceId)} - ` +
                  `the Welcome it carries is for a person this commit may not admit`
              );
              throw new WelcomeSeatGone();
            }
            if (refused.size > 0) {
              this.logger.warn(
                `[COMMIT][${traceId}] REJECT ${committerNotOnRoster ? 'committer_not_on_roster' : 'admit_refused'} ` +
                  `group=${groupId} baseEpoch=${baseEpoch} users=${[...refused].map(cutUserId).join(',')} - ` +
                  `the commit would give them a leaf no seat holds; nothing advanced`
              );
              throw new AdmitRefused([...refused], committerNotOnRoster);
            }
          }
          // THE ADMISSION A LINK'S SEAT WAITED FOR (`GroupMember.awaitingAdmission`): this commit
          // is a member's Add - the gate above refuses every commit from a seat still awaiting one -
          // and it admits a device of the person, declared (`admits`) or as the target of the
          // Welcome it carries, so the person is a member from this epoch on. Written with the
          // advance, so the flag never outlives the leaf nor goes before it; a roster write, so
          // before any device row like the enrolment. A key group has no roster rows: nothing matches.
          admittedAsks = await this.liftAwaitingAdmission(
            m,
            groupId,
            [...admitted.map((a) => a.userId), ...(welcome ? [welcome.userId] : [])],
            traceId,
            'COMMIT'
          );
          // THE COMMITTER'S SEAT, whose claim held above (`committerSeat`): written here, with the
          // advance, through the one writer of an active seat - its key package read
          // first, before any device row, the order an account erasure deletes in.
          //
          // AN EXTERNAL JOIN WHOSE SEAT CANNOT BE WRITTEN IS REFUSED WHOLE: its leaf enters the tree
          // with this advance, so accepting it would leave a leaf no seat holds. A pending member's
          // commit adds no leaf - its Add did - and stands, its seat left `pending`, as above.
          if (committerSeat) {
            const unwritten = await this.writeClaimedSeat(
              m,
              committer,
              deviceId,
              groupId,
              'MEMBERSHIP_ACTIVE'
            );
            if (unwritten !== null && frame.external) {
              this.logger.warn(
                `[COMMIT][${traceId}] REJECT committer_not_member group=${groupId} ` +
                  `device=${sanitizeLogValue(committer)}:${deviceId} kind=external reason=${unwritten} ` +
                  `- its seat cannot be written, so its leaf is not accepted; nothing advanced`
              );
              throw new ForbiddenException(
                refusalBody(RefusalCode.NOT_A_MEMBER, 'this commit is not accepted', {
                  error: 'committer_not_member',
                })
              );
            }
            committerSeat = unwritten === null;
          }
          // THE NEWCOMERS THIS COMMIT ADMITS, written before the fan-out below makes the new epoch
          // reachable by anyone (see `ValidateCommitBody.admits`). The insert only guarantees the
          // row; the update is guarded on `pending` so an `active` device - already routed by its
          // status - is never touched.
          //
          // `kickedAt: null` HERE, AND NOWHERE ELSE BUT ACTIVATION. A kick records a removed leaf that
          // a member owes an Add; this accepted commit IS that Add, made by a member through the gate
          // above. A Welcome used to clear it instead, and a Welcome is bytes anyone in the group can
          // address to any device - so it could undo a kick that no commit had answered.
          for (const a of admitted) {
            await m
              .getRepository(DeviceGroupMembership)
              .createQueryBuilder()
              .insert()
              .values({
                userId: a.userId,
                deviceId: a.deviceId,
                groupId,
                status: 'pending' as const,
              })
              .orIgnore()
              .execute();
            await m
              .getRepository(DeviceGroupMembership)
              .update(
                { userId: a.userId, deviceId: a.deviceId, groupId, status: 'pending' as const },
                { admittedAtEpoch: baseEpoch + 1, kickedAt: null }
              );
          }
          // THE WELCOME LANDS WITH THE ADVANCE OR NEITHER DOES (`ValidateCommitBody.welcome`). Its
          // seat is guaranteed as `sendWelcome` guarantees it - inserted, never overwriting a row -
          // when the admits above did not already write it.
          if (welcome) {
            const target = welcome;
            if (
              !admitted.some((a) => a.userId === target.userId && a.deviceId === target.deviceId)
            ) {
              await m
                .getRepository(DeviceGroupMembership)
                .createQueryBuilder()
                .insert()
                .values({
                  userId: target.userId,
                  deviceId: target.deviceId,
                  groupId,
                  status: 'pending' as const,
                })
                .orIgnore()
                .execute();
            }
            const repo = m.getRepository(QueuedMessage);
            queuedWelcome = await repo.save(
              repo.create(this.welcomeRow(groupId, committer, target))
            );
          }
        });
      } catch (e) {
        // EVERY REFUSAL BELOW FIRST ASKS WHETHER THESE BYTES ALREADY LANDED. This transaction may
        // have waited on the seat lock past the Redis lock's 5 s, behind an EARLIER request of the
        // same commit from the same device that has since committed: its row is then in the log,
        // and what failed here is only this copy of an accepted commit. NOT asked on
        // `log_row_exists`: that advance found the epoch still on the base, so no request of ours
        // advanced from it, and the row it collided with is a defect the error line below reports.
        if (
          e instanceof SeatClaimOvertaken ||
          e instanceof AdmitRefused ||
          e instanceof WelcomeSeatGone ||
          e instanceof AskNotAnswerable ||
          (e instanceof EpochAdvanceLost && e.lost === 'epoch_moved')
        ) {
          const duplicate = await this.answerIfAlreadyAccepted(
            groupId,
            baseEpoch,
            commitProto,
            deviceId,
            traceId
          );
          if (duplicate) return duplicate;
        }
        // A seat this commit writes stood on a claim an eviction overtook: nothing was written, and
        // the client rebuilds the commit and submits it again (`RefusalCode.SEAT_CLAIM_OVERTAKEN`).
        if (e instanceof SeatClaimOvertaken) {
          throw new ConflictException(
            refusalBody(RefusalCode.SEAT_CLAIM_OVERTAKEN, 'this commit is not accepted', {
              error: 'seat_claim_overtaken',
              seat: e.seat,
            })
          );
        }
        // A person it admits may not be admitted: nothing was written. ANSWERED, never thrown, so
        // every client rolls its stage back ({@link AdmitRefused}); the client rebuilds without the
        // people named - or, the committer itself holding no seat, stops.
        if (e instanceof AdmitRefused) {
          return e.committerNotOnRoster
            ? {
                accepted: false,
                currentEpoch: group.activeEpoch,
                reason: 'committer_not_on_roster',
              }
            : {
                accepted: false,
                currentEpoch: group.activeEpoch,
                reason: 'admit_refused',
                userIds: e.userIds,
              };
        }
        // A push tried to answer an invitation link's ask: nothing was written.
        if (e instanceof AskNotAnswerable) {
          return {
            accepted: false,
            currentEpoch: group.activeEpoch,
            reason: 'awaiting_admission',
          };
        }
        // The seat went between the target check and this transaction: nothing was written.
        if (e instanceof WelcomeSeatGone) {
          return {
            accepted: false,
            currentEpoch: group.activeEpoch,
            reason: 'welcome_target_not_member',
          };
        }
        // Another commit at this base got there first: nothing of this one was written.
        if (e instanceof EpochAdvanceLost) {
          const now = await this.groupRepo.findOne({ where: { id: groupId } });
          const currentEpoch = now?.activeEpoch ?? group.activeEpoch;
          if (e.lost === 'log_row_exists') {
            this.logger.error(
              `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} ` +
                `activeEpoch=${currentEpoch} reason=log_row_exists - the log already holds a commit ` +
                `for this base while the epoch still stood on it`
            );
          } else {
            this.logger.warn(
              `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} ` +
                `activeEpoch=${currentEpoch} reason=epoch_moved - another commit at this base landed first`
            );
          }
          return { accepted: false, currentEpoch, reason: 'epoch_mismatch' };
        }
        throw e;
      }
      group.activeEpoch = baseEpoch + 1;
      // The transaction committed: the asks it answered ARE answered, whatever the steps below do.
      // Taken now, so a throw in the fan-out cannot lose the announcement; sent once the lock below
      // is released, never while it is held.
      acceptedAsks = admittedAsks;
      if (admitted.length > 0) {
        this.logger.log(
          `[COMMIT][${traceId}] ADMITS group=${groupId} atEpoch=${group.activeEpoch} ` +
            `devices=${admitted.map((a) => `${a.userId}:${a.deviceId}`).join(',')}`
        );
      }
      if (newBase) {
        this.logger.log(
          `[COMMIT][${traceId}] base published with the commit group=${groupId} epoch=${group.activeEpoch}`
        );
      }

      // The committer's seat committed with the advance; its route follows, under the lock again
      // and only if the seat is still active ({@link routeActiveSeat}).
      if (committerSeat) {
        await this.routeActiveSeat(committer, deviceId, groupId, 'MEMBERSHIP_ACTIVE').catch((e) =>
          this.logger.warn(
            `[COMMIT][${traceId}] committer route NOT written group=${groupId} device=${deviceId}: ${String(e)}`
          )
        );
      }

      // Fan out the commit to members. Kept inside the locked section so validate + store +
      // broadcast is a single atomic unit; delivery is fast (queued rows + Redis publish, FCM is
      // deferred). Best-effort: the commit-log is already the durable source of truth, so a device
      // that misses the realtime fan-out replays it via GET /mls/commits. [[C7]]
      // A device back in the tree - admitted by this commit, or committing itself (an external
      // rejoin) - is no longer parting: an entry left for it would hand a LATER removal's commit to
      // nobody who needs it, so it ends here, on that state.
      await this.clearParting(groupId, [...admitted, { userId: committer, deviceId }], traceId);
      const parting = await this.declaredPartingDevices(groupId, body.removes, traceId);
      await this.sendMessage(
        {
          groupId,
          senderId: committer,
          senderDeviceId: deviceId,
          proto: commitProto,
          isCommit: true,
          excludeDeviceIds: commitExclusions(body, admitted, deviceId, (dropped) =>
            this.logger.warn(
              `[COMMIT][${traceId}] EXCLUSION_DROPPED group=${groupId} count=${dropped.length} ` +
                `devices=${dropped
                  .slice(0, 8)
                  .map((d) => sanitizeLogValue(d))
                  .join(',')} - ` +
                `not admitted by this commit, so they receive it`
            )
          ),
        },
        undefined,
        parting
      ).catch((e) =>
        this.logger.warn(
          `[COMMIT][${traceId}] commit fan-out failed group=${groupId}: ${String(e)}`
        )
      );

      // The Welcome goes out FROM ITS STORED ROW, after the members have the commit. Best-effort
      // like the fan-out: the row is durable, so a device this misses gets it on its next pull.
      if (queuedWelcome) {
        const stored: QueuedMessage = queuedWelcome;
        await this.deliverWelcome(stored, traceId).catch((e: unknown) =>
          this.logger.warn(
            `[COMMIT][${traceId}] Welcome STORED id=${stored.id} and its realtime delivery failed ` +
              `group=${groupId} target=${stored.recipientId}:${stored.deviceId} - the device takes ` +
              `it on its next pull: ${String(e)}`
          )
        );
      }

      const refusedAdmits = [...admitRefusals, ...admitRefusalsInTx];
      this.logger.log(
        `[COMMIT][${traceId}] ACCEPT group=${groupId} newEpoch=${group.activeEpoch}` +
          (refusedAdmits.length > 0 ? ` refusedAdmits=${refusedAdmits.length}` : '')
      );

      return {
        accepted: true,
        newEpoch: group.activeEpoch,
        ...(refusedAdmits.length > 0 ? { refusedAdmits } : {}),
      };
    } finally {
      try {
        // Atomic release via Lua: avoids the GET->DEL race.
        const released = await this.redis.eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          1,
          lockKey,
          deviceId
        );
        if (released === 1) {
          this.logger.log(`[COMMIT][${traceId}] Lock released for group=${groupId}`);
        } else {
          this.logger.warn(
            `[COMMIT][${traceId}] Lock already expired or stolen for group=${groupId}`
          );
        }
      } finally {
        // The lock is released (or its release failed, and it expires): the asks a COMMITTED
        // transaction answered go out now - even when a later step threw - started and not awaited,
        // so neither the next commit nor this answer waits on them.
        this.announceAdmitted(groupId, acceptedAsks, committer);
      }
    }
  }

  /**
   * The parted devices of `groupId` (see `partingKey`) that a commit's declared `removes` names: every
   * device of a person named alone, the one device of a person named with it. Nothing for a commit
   * that declares nothing - an ordinary commit, or one from a build predating the field.
   *
   * Only an entry the server itself wrote can be named, so a commit cannot route itself to a device
   * that was never parted from this group. A failed read reaches nobody extra and says so.
   */
  private async declaredPartingDevices(
    groupId: string,
    removes: ValidateCommitBody['removes'],
    traceId: string
  ): Promise<Array<{ userId: string; deviceId: string }>> {
    const declared = (Array.isArray(removes) ? removes : []).filter(
      (r): r is { userId: string; deviceId?: string } =>
        typeof r?.userId === 'string' &&
        r.userId.length > 0 &&
        (r.deviceId === undefined || typeof r.deviceId === 'string')
    );
    if (declared.length === 0) return [];
    let entries: Record<string, string>;
    try {
      entries = await this.redis.hgetall(partingKey(groupId));
    } catch (e) {
      this.logger.warn(
        `[COMMIT][${traceId}] parting devices unreadable group=${groupId.slice(0, 8)} - the removed device(s) miss their removal commit: ${String(e)}`
      );
      return [];
    }
    const parting = Object.keys(entries ?? {})
      .map((key) => {
        const at = key.lastIndexOf(':');
        return { userId: key.slice(0, at), deviceId: key.slice(at + 1) };
      })
      .filter((p) =>
        declared.some(
          (r) => r.userId === p.userId && (r.deviceId === undefined || r.deviceId === p.deviceId)
        )
      );
    this.logger.log(
      `[COMMIT][${traceId}] PARTING group=${groupId.slice(0, 8)} removes=${declared.length} - commit also queued to ${parting.length} removed device(s)${parting.length > 0 ? `: ${parting.map((p) => `${cutUserId(p.userId)}:${cutDeviceId(p.deviceId)}`).join(',')}` : ''}`
    );
    return parting;
  }

  /**
   * Ends the parting entries of devices that are in the tree again (see `partingKey`). Best-effort:
   * a failure leaves an entry only a commit declaring that device's removal could ever name.
   */
  private async clearParting(
    groupId: string,
    devices: ReadonlyArray<{ userId: string; deviceId: string }>,
    traceId: string
  ): Promise<void> {
    if (devices.length === 0) return;
    await this.redis
      .hdel(partingKey(groupId), ...devices.map((d) => `${d.userId}:${d.deviceId}`))
      .catch((e: unknown) =>
        this.logger.warn(
          `[COMMIT][${traceId}] parting entries of re-admitted device(s) NOT cleared group=${groupId.slice(0, 8)}: ${String(e)}`
        )
      );
  }

  /**
   * Whether `userId` belongs to `groupId`, asked of the table that records membership for the
   * group's KIND.
   *
   * A key-distribution group (a community's, or a private salon's: `distributionWorkspaceId` or
   * `distributionChannelId` set) is recorded per DEVICE in `dm_device_group_memberships` and never
   * in `dm_group_members` - by construction, see section 16 of the channel-encryption protocol - so
   * it answers from an ACTIVE device row. Every other group answers from `dm_group_members`.
   *
   * ONE IMPLEMENTATION FOR EVERY GATE THAT ASKS IT, because the replay and the Welcome asked the
   * user table on their own and each was found refusing a key group separately. `isKeyDistribution`
   * travels back so the caller's refusal line can say which table refused.
   *
   * @param group the `dm_groups` row when the caller already read it, `null` when it is absent.
   */
  private async memberOfGroupKind(
    group: Pick<Group, 'distributionWorkspaceId' | 'distributionChannelId'> | null,
    groupId: string,
    userId: string
  ): Promise<{ isMember: boolean; isKeyDistribution: boolean }> {
    const isKeyDistribution = !!(group?.distributionWorkspaceId || group?.distributionChannelId);
    // A seat still AWAITING a member's admission (an invitation link's ask) is no membership: its
    // holder may not Welcome anyone - a Welcome lifts the flag - nor read the log or report. The
    // kind-aware read is the one the group routes authorize with (`assertCallerActsOnGroup`).
    const standing = await standingOnGroupOfKind(
      { seats: this.groupMemberRepo, devices: this.deviceGroupRepo },
      group,
      groupId,
      userId
    );
    return { isMember: standing === 'admitted', isKeyDistribution };
  }

  /**
   * Returns the ordered, CONTIGUOUS, replayable commits for `groupId` starting at `sinceEpoch`
   * (rung-1). Membership-gated by the caller.
   *
   * Two ways a replay cannot finish, and each is reported rather than left to be discovered:
   * `belowFloor` when `sinceEpoch` sits under the retained floor (older commits pruned), and
   * `gapAt` when an epoch inside the range was never recorded. In both cases the caller owes
   * rung-2 (re-Welcome); with `gapAt`, `commits` still carries the applicable prefix.
   */
  async getCommitsSince(
    groupId: string,
    sinceEpoch: number,
    requesterUserId: string
  ): Promise<CommitsSinceResult> {
    // Serve the commit-log ONLY to members of the group (the commits are ciphertext, but ordering
    // metadata still gates on membership). x-user-id is injected by the proxy after JWT validation.
    //
    // MEMBERSHIP IS ASKED OF THE TABLE THAT RECORDS IT FOR THIS KIND OF GROUP. A key-distribution
    // group (a community's, or a private salon's) is entered by each DEVICE's external commit and is
    // recorded in `dm_device_group_memberships` alone; `dm_group_members` never names anyone for it.
    // Asking the user table refused every one of them: on production 2026-09-27 all eight
    // distribution groups held ZERO user rows, and `POST mls/push/commits` answered 403 173 times in
    // eight hours - so a shut phone one commit behind (any newcomer to the community advances the
    // epoch) could never catch up, refused every seed that followed, and showed "Nouveau message dans
    // #general" for every salon message until the app was next opened. `putGroupInfo` records the
    // same absence for the WRITE of a group info. For a replay the device table is the right roster
    // rather than community membership: whoever holds an active leaf already reads these commits, and
    // a member cut from the community loses that row with their leaf.
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    const { isMember, isKeyDistribution } = await this.memberOfGroupKind(
      group,
      groupId,
      requesterUserId
    );
    if (!isMember) {
      this.logger.warn(
        `[COMMITS_SINCE] refused group=${groupId} user=${requesterUserId.slice(0, 8)} keyDistribution=${isKeyDistribution}`
      );
      throw new ForbiddenException(`User ${requesterUserId} is not a member of group ${groupId}`);
    }

    const activeEpoch = group?.activeEpoch ?? 0;

    const rows = await this.commitLogRepo.find({
      where: { groupId, baseEpoch: MoreThanOrEqual(sinceEpoch) },
      order: { baseEpoch: 'ASC' },
    });

    // Below floor: the caller needs commits from `sinceEpoch`, but the oldest retained commit
    // starts LATER, so the intermediate ones were pruned and replay cannot fully catch up.
    const oldest = await this.commitLogRepo.findOne({
      where: { groupId },
      order: { baseEpoch: 'ASC' },
    });
    const belowFloor = sinceEpoch < activeEpoch && !!oldest && oldest.baseEpoch > sinceEpoch;

    // CONTIGUITY IS THE PROPERTY A REPLAY ACTUALLY NEEDS, and `belowFloor` only ever described the
    // START of the range. Commits apply in order, so everything past a missing epoch is unreachable:
    // walk up from `sinceEpoch`, keep the applicable prefix, and NAME the first epoch the log cannot
    // supply. Handing back the unreachable tail instead invites the caller to fail its way to the
    // same conclusion - it applies one commit, breaks on the next, reports `healed=false`, freezes
    // its outbox and waits out `STUCK_EPOCH_GAP_MS` before the watchdog escalates. The server knows
    // now, in the response it is already writing. Measured on prod 2026-09-02: group `7da231f8` ran
    // 0..129 with 121 absent for two days and every check passed (`docs/wiki/backlog.md`).
    const applicable: CommitLogEntry[] = [];
    let gapAt: number | undefined;
    let expected = sinceEpoch;
    for (const r of rows) {
      // `rows` is ascending and the UNIQUE `(groupId, baseEpoch)` index makes it distinct, so the
      // only way to miss `expected` is that nothing ever wrote it.
      if (r.baseEpoch > expected) {
        gapAt = expected;
        break;
      }
      applicable.push({ baseEpoch: r.baseEpoch, proto: r.commit });
      expected = r.baseEpoch + 1;
    }
    // The same hole seen from the other end: the log stops before the group does, so the last epochs
    // were never recorded rather than sitting behind a gap.
    if (gapAt === undefined && expected < activeEpoch) {
      gapAt = expected;
    }

    // PRUNING AND A HOLE ARE NOT THE SAME DEFECT, and only one of them accuses anybody: a log that
    // starts late was TRIMMED on purpose, one missing an epoch inside its own span was NEVER
    // WRITTEN. Both terminate rung 1 identically, so when `belowFloor` already carries the answer
    // the gap is dropped rather than reported - an `ERROR` naming a defect that does not exist is
    // precisely the line its reader learns to skip, and then misses the real one.
    if (belowFloor) {
      gapAt = undefined;
    }

    if (gapAt !== undefined) {
      // Not a warning about a slow path - an accusation. An unrefillable epoch is a defect in the
      // commit path that wrote it, and this is the only place that can see it.
      this.logger.error(
        `[COMMITS] group=${groupId} COMMIT LOG HOLE at epoch=${gapAt} ` +
          `(sinceEpoch=${sinceEpoch} activeEpoch=${activeEpoch} applicable=${applicable.length}) - ` +
          `replay cannot pass it, rung-2 owed`
      );
    }

    return {
      commits: applicable,
      activeEpoch,
      belowFloor,
      ...(gapAt !== undefined ? { gapAt } : {}),
    };
  }

  /**
   * Stores the latest GroupInfo for `groupId` (Phase 4 external-join base). Membership-gated. The
   * committer refreshes it after every accepted commit (a new group's first member-add is itself a
   * commit), so an authorized member lacking MLS state can self-join. STRICTLY monotonic: a write
   * whose `baseEpoch` is not above the stored one is ignored and reported as `stored: false` - a
   * late refresh must never regress the served base epoch (mirroring the write-if-newer discipline
   * of the commit-log and persistence layers), and an EQUAL epoch is a second creator claiming a
   * base that is already owned, which is the race {@link putGroupInfo} exists to settle.
   */
  async storeGroupInfo(
    groupId: string,
    requesterUserId: string,
    groupInfo: string,
    baseEpoch: number
  ): Promise<{ stored: boolean }> {
    // Who may write the base is who may read it: a person still awaiting a member's admission holds
    // no tree, so a base from them is one nobody minted.
    await this.assertMayReadExternalBase(groupId, requesterUserId);
    return this.putGroupInfo(groupId, groupInfo, baseEpoch);
  }

  /**
   * The monotonic GroupInfo upsert with NO authorization of its own: whoever calls has already
   * decided who may write.
   *
   * TWO CALLERS DECIDE IT DIFFERENTLY, and neither can be expressed in the other's terms.
   * {@link storeGroupInfo} gates on a `dm_group_members` row - the roster of an ordinary
   * conversation. A community's Graine distribution group holds no such row by construction (it is
   * joined by external commit), and the roster that governs it is community membership, which lives
   * in social-service and nowhere here. So social-service authorizes and calls the internal route,
   * which lands here. Splitting the gate from the write is what keeps ONE monotonic rule for both.
   */
  async putGroupInfo(
    groupId: string,
    groupInfo: string,
    baseEpoch: number,
    manager?: EntityManager
  ): Promise<{ stored: boolean }> {
    // `manager` is passed by {@link validateCommit} ONLY, to write the base inside the very
    // transaction that advances the epoch it describes. Absent, this runs on its own connection,
    // which is what every other caller wants.
    const repo = manager ? manager.getRepository(MlsGroupInfo) : this.groupInfoRepo;
    // STRICTLY monotonic: an epoch already published is OWNED, and a second base for it loses.
    // `orIgnore` guards the concurrent-insert race; the WHERE guards the concurrent-update race.
    //
    // THE ELECTION BELOW USED TO DECIDE ONLY THE COLLIDING HALF OF THE RACE, and the other half is
    // the commoner one. Two devices that both find a scope uninitialised both create a tree under
    // the server's group id and both publish at epoch 0; only if their INSERTs collide does
    // `orIgnore` separate them. Serialized - the first insert committed before the second device
    // read - the second fell through to the UPDATE below, whose `<=` let epoch 0 REPLACE epoch 0,
    // and it was told `stored: true`. Both creators then believed they owned the group.
    //
    // Measured on production 2026-08-27, COMM-8, salon 0a47eb27 / group 19d12785, one second apart:
    //
    //   09:49:41  group-info epoch=0 stored=true   publisher=d82cd226:web-d82cd226
    //   09:49:41  group-info epoch=0 stored=true   publisher=d82cd226:web-d82cd226
    //
    // The creator whose base was replaced never learned it, never advanced past epoch 0 (`msg_epoch=0
    // group_epoch=0 err=ValidationError(InvalidSignature)` on the group's own first commit, then
    // `epoch gap [msg_epoch=4, group_epoch=0]` for the rest of the run), and minted the salon's only
    // Graine session against that orphan - sealing the seed into a tree no other member holds. The
    // repair did everything right and could do nothing: every roster device answered `absorbed 0/0`
    // and the asker concluded `has no reachable holder`. The salon's first message is unreadable for
    // good. Story in `CHANGELOG.md`.
    //
    // AN EQUAL EPOCH IS NEVER A LEGITIMATE REFRESH, which is what makes `>=` safe. Every republisher
    // carries a strictly newer epoch by construction: `validateCommit` writes the base for
    // `baseEpoch + 1` inside the transaction that advances to it, and `republishStaleBase` fires only
    // when the stored base is BEHIND the group and publishes from a tree at or past `activeEpoch`. So
    // equal means a second creator, and the only thing it needs is to be told.
    const existing = await repo.findOne({ where: { groupId } });
    if (existing && existing.baseEpoch >= baseEpoch) {
      return { stored: false };
    }
    if (!existing) {
      const inserted = await repo
        .createQueryBuilder()
        .insert()
        .values({ groupId, groupInfo, baseEpoch })
        .orIgnore()
        .execute();
      // REPORTED, NOT ASSUMED. `orIgnore` makes a lost race silent, and this branch used to answer
      // `stored: true` regardless - which is fine for a refresh and wrong for the one caller that
      // acts on it. Two clients finding a community's distribution group uninitialised BOTH create
      // an MLS group at epoch 0, and epoch 0 does not beat epoch 0, so the monotonic rule cannot
      // separate them: what separates them is who won the insert. The loser discards its group and
      // joins the winner's, which needs no election - but only if it is told it lost.
      // `ON CONFLICT DO NOTHING` returns no row on conflict, which is the signal.
      const won = Array.isArray(inserted.raw) && inserted.raw.length > 0;
      return { stored: won };
    }
    // `<`, MATCHING THE READ ABOVE. The read cannot be trusted on its own - another writer can land
    // between it and this - so the guard that actually decides has to carry the same rule, and a
    // `<=` here would reopen the hole under concurrency exactly as it was open under serialization.
    const advanced = await repo
      .createQueryBuilder()
      .update()
      .set({ groupInfo, baseEpoch, updatedAt: () => 'now()' })
      .where('"groupId" = :groupId AND "baseEpoch" < :baseEpoch', {
        groupId,
        baseEpoch,
      })
      .execute();
    // REPORTED, NOT ASSUMED - the same rule the insert branch already obeys. This used to answer
    // `stored: true` whatever the WHERE matched, so a write the guard had refused was indistinguishable
    // from one it accepted, and the one caller that acts on the answer would have kept a tree the
    // group had moved past.
    return { stored: (advanced.affected ?? 0) > 0 };
  }

  /**
   * Returns the latest stored GroupInfo for `groupId` so an authorized member can build an external
   * commit to (re)join. Membership-gated (the ratchet tree it carries is public group state, but we
   * still restrict it to roster members, and to those a member admitted -
   * {@link assertMayReadExternalBase}). Returns null when no GroupInfo has been stored yet (the
   * caller then falls back to a peer welcome_request).
   */
  async getGroupInfo(
    groupId: string,
    requesterUserId: string,
    requesterDeviceId?: string
  ): Promise<{
    groupInfo: string;
    baseEpoch: number;
    activeEpoch: number;
    seat?: DeviceSeat;
  } | null> {
    await this.assertMayReadExternalBase(groupId, requesterUserId);
    const base = await this.readGroupInfo(groupId);
    // THE ASKING DEVICE'S SEAT, READ AFTER THE BASE (`readDeviceSeat`): a further device of a member
    // that lets itself in when no member device can answer (`requestReAdd`, D1 of
    // docs/wiki/protocols/mls-availability-no-holder.md) reads from this one answer whether an Add
    // already carries it, and waits for that Welcome instead of joining over it.
    // NOT SERVED WHILE THE DOOR IS SHUT ({@link FURTHER_DEVICE_SELF_JOIN_OPEN}): the client reads a
    // base with no seat as `seat_unreadable` and does not join by itself.
    if (!base || !requesterDeviceId || !this.furtherDeviceSelfJoinOpen) return base;
    const seat = await this.seatOf(groupId, requesterUserId, requesterDeviceId);
    return { ...base, seat };
  }

  /** {@link readDeviceSeat} with this service's repositories. */
  private seatOf(groupId: string, userId: string, deviceId: string): Promise<DeviceSeat> {
    return readDeviceSeat(
      {
        deviceGroupRepo: this.deviceGroupRepo,
        queuedMessageRepo: this.queuedMessageRepo,
        redis: this.redis,
        logger: this.logger,
      },
      groupId,
      userId.trim().toLowerCase(),
      deviceId
    );
  }

  /**
   * WHAT A REQUESTER NEEDS TO KNOW THAT NOBODY CAN LET IT IN, read in the same answer as the verdict
   * that no member device is online (`no_peer_online`): the stored base's two epochs (`null` when no
   * base was ever published) and the requester's own seat, read after the base. The client shows its
   * no-holder banner only on this whole set (D5 of docs/wiki/protocols/mls-availability-no-holder.md)
   * - never on elapsed time, a missing message or a pending state. A read that fails answers
   * nothing (`undefined`), and the client then keeps its ordinary waiting text.
   */
  private async noHolderFacts(
    groupId: string,
    userId: string,
    deviceId: string,
    traceId: string,
    wakeSent: boolean
  ): Promise<NoHolderFacts | undefined> {
    try {
      // THE SAME DOOR AS THE BASE ITSELF: only a seated user not awaiting a member's admission is
      // told anything about the group (`assertMayReadExternalBase`). A link ask waits for a member
      // (D4), and is never a no-holder case.
      const roster = await this.rosterSeat(groupId, userId);
      if (!roster || roster.awaitingAdmission === true) return undefined;
      const base = await this.readGroupInfo(groupId);
      const seat = await this.seatOf(groupId, userId, deviceId);
      const liveHolderDevices = await this.liveHolderDevices(groupId, userId);
      return {
        base: base ? { baseEpoch: base.baseEpoch, activeEpoch: base.activeEpoch } : null,
        seat,
        holders: { liveHolderDevices, wakeSent },
      };
    } catch (e) {
      this.logger.warn(
        `[NO_HOLDER][${traceId}] facts unread group=${groupId} - the requester keeps waiting: ${String(e)}`
      );
      return undefined;
    }
  }

  /**
   * How many devices of OTHER users still hold `groupId` and are alive: an `active` row in the group,
   * and a KeyPackage published within {@link RETENTION_WINDOW_MS} - the window this service already
   * treats as "a device is gone" (`detectStaleDevices`), so a device is never alive for one rule and
   * dead for this one. A member who did not open the app tonight is counted; one gone for months is
   * not ({@link HolderLiveness}).
   */
  private async liveHolderDevices(groupId: string, requesterUserId: string): Promise<number> {
    const requester = requesterUserId.trim().toLowerCase();
    const rows = await this.deviceGroupRepo.find({
      where: { groupId, status: 'active' },
      select: { userId: true, deviceId: true },
    });
    const others = rows.filter((r) => r.userId.trim().toLowerCase() !== requester);
    if (others.length === 0) return 0;
    const live = await this.keyPackageRepo.find({
      where: {
        deviceId: In(others.map((r) => r.deviceId)),
        createdAt: MoreThanOrEqual(new Date(Date.now() - RETENTION_WINDOW_MS)),
      },
      select: { userId: true, deviceId: true },
    });
    const liveKeys = new Set(live.map((k) => `${k.userId.trim().toLowerCase()}:${k.deviceId}`));
    return others.filter((r) => liveKeys.has(`${r.userId.trim().toLowerCase()}:${r.deviceId}`))
      .length;
  }

  /**
   * The stored GroupInfo with NO authorization of its own - the read half of the split described on
   * {@link putGroupInfo}. Null when nothing has been published yet.
   *
   * `activeEpoch` IS SERVED BESIDE IT BECAUSE THE TWO CAN DISAGREE FOR EVER, AND ONLY THIS SIDE
   * KNOWS BOTH. The base is published by a follow-up call from the device whose commit was just
   * accepted; that call can be lost (offline, killed tab, refused refresh) and nothing else ever
   * mints one, so `dm_groups.activeEpoch` advances while `mls_group_info.baseEpoch` stays behind.
   * A joiner handed the stale base builds an external commit the strict gate is GUARANTEED to
   * refuse, learning by failing what this row could have told it - and for a distribution group,
   * which has no peer-Welcome fallback, that is a member permanently locked out of a salon they
   * are entitled to. Serving both numbers lets a joiner skip the doomed attempt and lets a HOLDER
   * (the only party able to export a fresh base) repair it on its next ordinary read.
   */
  async readGroupInfo(
    groupId: string
  ): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null> {
    const row = await this.groupInfoRepo.findOne({ where: { groupId } });
    if (!row) return null;
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      select: { id: true, activeEpoch: true },
    });
    const activeEpoch = group?.activeEpoch ?? row.baseEpoch;
    if (row.baseEpoch < activeEpoch) {
      // ACCUSING, NOT INFORMATIVE: every read of a stale base is a joiner that cannot get in until
      // a member republishes. Silent, this cost a private salon its second member on 2026-08-25.
      this.logger.warn(
        `[GROUP_INFO] STALE base group=${groupId} baseEpoch=${row.baseEpoch} activeEpoch=${activeEpoch}` +
          ` - the published external-join base is unusable and only a member holding the tree can refresh it`
      );
    }
    return { groupInfo: row.groupInfo, baseEpoch: row.baseEpoch, activeEpoch };
  }

  /**
   * Prunes the commit-log (hourly cron). Two bounds: an age window (~1 year - commits are tiny, a
   * long window keeps rung-1 replay covering almost every gap and minimises destructive rung-2
   * re-Welcomes) and a per-group size cap (safety against runaway growth on very active groups:
   * keep only the last {@link COMMIT_LOG_MAX_PER_GROUP} epochs behind each group's activeEpoch).
   */
  async pruneExpiredCommitLog(): Promise<number> {
    const cutoff = new Date(Date.now() - COMMIT_LOG_RETENTION_MS);
    const byAge = await this.commitLogRepo.delete({
      createdAt: LessThan(cutoff),
    });
    await this.commitLogRepo.query(
      `DELETE FROM mls_commit_log c USING dm_groups g
       WHERE c."groupId" = g.id AND c."baseEpoch" < g."activeEpoch" - $1`,
      [COMMIT_LOG_MAX_PER_GROUP]
    );
    const deleted = byAge.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(`[CRON] pruneExpiredCommitLog: deleted ${deleted} aged commit(s)`);
    }
    return deleted;
  }

  /**
   * The subset of a commit's declared `admits` this server will record, each dropped entry logged
   * and pushed onto `refusals` - what the accept answers the committer (`refusedAdmits`).
   *
   * The bar is the one `sendWelcome` holds a Welcome's target to - a device with a KeyPackage row,
   * which is what exists server-side - plus two refusals: the committing device itself (it is
   * already in the tree it is changing) and the client's unresolved-identity placeholders. The
   * committer's authority to name them is the commit the epoch gate just accepted.
   */
  private async resolveAdmittedDevices(
    groupId: string,
    committerDeviceId: string,
    declared: ValidateCommitBody['admits'],
    traceId: string,
    refusals: RefusedAdmit[]
  ): Promise<{ userId: string; deviceId: string }[]> {
    if (!Array.isArray(declared) || declared.length === 0) return [];
    const candidates: { userId: string; deviceId: string }[] = [];
    for (const d of declared) {
      const userId = sanitizeQueryValue(d?.userId ?? '', 'admits.userId');
      const deviceId = sanitizeQueryValue(d?.deviceId ?? '', 'admits.deviceId');
      if (
        deviceId === committerDeviceId ||
        isUnresolvedIdentity(userId) ||
        isUnresolvedIdentity(deviceId)
      ) {
        const reason = deviceId === committerDeviceId ? 'committer' : 'unresolved_identity';
        this.logger.warn(
          `[COMMIT][${traceId}] ADMIT_REFUSED group=${groupId} device=${userId}:${deviceId} reason=${reason}`
        );
        refusals.push({ userId, deviceId, reason });
        continue;
      }
      candidates.push({ userId, deviceId });
    }
    if (candidates.length === 0) return [];
    const pairs = candidates.map((c) => ({ userId: c.userId, deviceId: c.deviceId }));
    const known = new Set(
      (
        await this.keyPackageRepo.find({
          where: pairs,
          select: { userId: true, deviceId: true },
        })
      ).map((kp) => `${kp.userId}:${kp.deviceId}`)
    );
    // A DEVICE ALREADY ROUTED IS NOT ADMITTED. An admit is what lets the commit's fan-out skip a
    // device, and an `active` row is one that receives every frame of the group - admitting it would
    // let a committer take a member's device out of the fan-out of a commit it must process.
    const routed = new Set(
      (
        await this.deviceGroupRepo.find({
          where: pairs.map((p) => ({ ...p, groupId, status: 'active' as const })),
          select: { userId: true, deviceId: true },
        })
      ).map((m) => `${m.userId}:${m.deviceId}`)
    );
    return candidates.filter((c) => {
      const key = `${c.userId}:${c.deviceId}`;
      const reason = !known.has(key) ? 'no_key_package' : routed.has(key) ? 'already_active' : null;
      if (reason === null) return true;
      this.logger.warn(
        `[COMMIT][${traceId}] ADMIT_REFUSED group=${groupId} device=${key} reason=${reason}`
      );
      refusals.push({ userId: c.userId, deviceId: c.deviceId, reason });
      return false;
    });
  }

  /**
   * Refuses an external commit whose Remove proposals reach beyond the joiner's own prior leaf -
   * RFC 9420 section 12.4.3.2, enforced by every receiver in `mls-core`
   * (`refuse_foreign_external_remove`) and checked here too, before the epoch moves.
   *
   * At most one Remove, and the leaf it names must carry the joiner's own identity - the identity
   * the gate has already held to `committer:deviceId`, compared in {@link canonicalDeviceKey} form
   * as `mls-core`'s `same_identity` does. The commit names the leaf by INDEX, so its identity is
   * read from the tree of the stored base ({@link groupInfoLeafIdentity}): the GroupInfo this server
   * served the joiner. Bases are strictly monotonic, one per epoch ({@link putGroupInfo}): with no
   * base at or past the commit's epoch the leaf cannot be named and the commit is refused; a base
   * PAST it means the commit lost a race, and the epoch gate answers it (see the body).
   */
  private async assertExternalRemoveIsOwnPriorLeaf(
    groupId: string,
    frame: { epoch: number; leafIdentity: string; removedLeaves: number[] },
    traceId: string
  ): Promise<void> {
    const refuse: (why: string) => never = (why) => {
      this.logger.error(
        `[COMMIT][${traceId}] REJECT external_remove_foreign group=${groupId} ` +
          `joiner=${sanitizeLeafLogValue(frame.leafIdentity)} removes=[${frame.removedLeaves.join(',')}] ${why}`
      );
      throw new ForbiddenException({
        error: 'commit_identity_mismatch',
        message: 'this commit is not accepted',
      });
    };
    if (frame.removedLeaves.length > 1) refuse('more than one Remove');
    const base = await this.groupInfoRepo.findOne({ where: { groupId } });
    if (!base || base.baseEpoch < frame.epoch) {
      refuse(`no base at epoch ${frame.epoch} (stored=${base?.baseEpoch ?? 'none'})`);
    }
    if (base.baseEpoch > frame.epoch) {
      // A COMMIT BUILT ON A BASE THE GROUP HAS ALREADY LEFT IS THE EPOCH GATE'S TO ANSWER, not this
      // one's: a legitimate resync that lost a race reads `epoch_mismatch` (or its own earlier
      // acceptance) and rebuilds, where a 403 here would end its retry. That holds only while the
      // GROUP is past the commit's epoch too - `activeEpoch` never moves back, so the strict gate is
      // then certain to refuse it. A base ahead of a group still at the commit's epoch proves
      // nothing about the tree the commit names, so that case is refused.
      const group = await this.groupRepo.findOne({
        where: { id: groupId },
        select: { id: true, activeEpoch: true },
      });
      if ((group?.activeEpoch ?? -1) > frame.epoch) {
        this.logger.log(
          `[COMMIT][${traceId}] external Remove on a superseded base group=${groupId} ` +
            `epoch=${frame.epoch} base=${base.baseEpoch} - left to the epoch gate`
        );
        return;
      }
      refuse(`base ${base.baseEpoch} is ahead of the group at ${group?.activeEpoch ?? 'none'}`);
    }
    const removed = groupInfoLeafIdentity(base.groupInfo, frame.removedLeaves[0]);
    const removedKey = canonicalLeafIdentity(removed);
    if (removedKey === null || removedKey !== canonicalLeafIdentity(frame.leafIdentity)) {
      refuse(`removed=${sanitizeLeafLogValue(removed, 'unreadable')}`);
    }
  }

  /**
   * Whether the caller may commit to `groupId` at all, decided before the epoch gate.
   *
   * - A MEMBER COMMIT comes from a device of the caller's that the group holds: `active`, or
   *   `pending` and never kicked - a device that has processed its Welcome reports itself `active`
   *   without waiting (`updateInvitationStatus` is not awaited), so a commit can precede that report.
   *   A removal deletes the removed member's rows and a kick stamps `kickedAt`: both are refused.
   * - AN EXTERNAL COMMIT is the one commit made from outside the tree (an external join or rejoin),
   *   recognised by its own clear header ({@link readCommitFrame}), never by a client flag. It is
   *   accepted from whoever may read the base it is built on - {@link assertMayReadExternalBase},
   *   the predicate of {@link getGroupInfo} - so the gate and the door it guards answer the same
   *   question.
   * - A SEAT AWAITING A MEMBER'S ADMISSION (`GroupMember.awaitingAdmission`, an invitation link's)
   *   commits nothing, external or member: no member has admitted the person, so they hold no leaf,
   *   and the one way in is a member's Add (docs/wiki/protocols/mls-protocol.md, "Who admits a new
   *   person").
   * - A KEY-DISTRIBUTION GROUP'S external commit is asked of social-service, which owns its roster
   *   and serves its base by the same predicate ({@link isEntitledToDistributionGroup}). Unanswered,
   *   it is a retryable 503 and never an acceptance (WP-KEYGROUP-JOIN-GATE).
   *
   * Every caller runs this before the epoch moves, so a refusal also stops the activation an
   * accepted commit grants its committer.
   *
   * THE SEAT CLAIM IS READ FIRST, BEFORE THE CHECK ({@link claimSeat}). The activation that follows
   * an accepted commit is written under the seat lock against it, so an eviction that lands after
   * this check - including one social-service makes while its entitlement still answered `true` -
   * leaves no seat behind, and the check itself is never repeated under a lock.
   *
   * @returns the claim the committer's activation is written against.
   */
  private async assertCommitterMayCommit(
    groupId: string,
    userId: string,
    deviceId: string,
    external: boolean,
    traceId: string
  ): Promise<SeatClaim> {
    const claim = await claimSeat(this.groupRepo.manager, groupId, userId);
    const scope = external ? await this.keyDistributionScope(groupId) : null;
    // The conversation roster seat, read once: an external commit needs one, and a seat awaiting a
    // member's admission refuses every commit. A key group has no roster rows - social-service owns
    // its membership - so it is not read there.
    const seat = scope ? null : await this.rosterSeat(groupId, userId);
    const awaiting = seat ? await this.seatAwaitsAdmission(groupId, userId, seat) : false;
    // A DEPARTURE IN PROGRESS IS REFUSED HERE, before the epoch moves - not at the activation that
    // follows, which would leave the committer in the tree with no seat. Read from the claim, so no
    // second query, and the activation's re-read under the lock still catches one that begins later.
    const allowed =
      !claim.owed &&
      !awaiting &&
      (scope
        ? await isEntitledToDistributionGroup(scope, userId, traceId)
        : external
          ? seat !== null
          : await this.memberCommitterHoldsSeat(groupId, userId, deviceId, traceId));
    if (allowed) return claim;
    this.logger.warn(
      `[COMMIT][${traceId}] REJECT committer_not_member group=${groupId} ` +
        `device=${sanitizeLogValue(userId)}:${deviceId} ` +
        `kind=${scope ? `key-group-external ${scope.kind}=${scope.id}` : external ? 'external' : 'member'}` +
        (claim.owed ? ' reason=departure_in_progress' : '') +
        (awaiting ? ' reason=awaiting_admission' : '')
    );
    // `code` is what a client's typed refusal reads; `error` is kept for the clients that read it.
    throw new ForbiddenException(
      refusalBody(RefusalCode.NOT_A_MEMBER, 'this commit is not accepted', {
        error: 'committer_not_member',
      })
    );
  }

  /**
   * Whether a MEMBER commit's committer holds a seat it may commit from: an `active` row, or a
   * `pending` one no kick holds - the row its admission wrote, whose first commit then writes it
   * `active` ({@link validateCommit}, `committerNeedsSeat`).
   *
   * THAT FIRST COMMIT CREATES AN ACTIVE SEAT, so in a key-distribution group it is held to the
   * question every other key-group seat writer asks: is this person entitled, asked of social-service
   * ({@link isEntitledToDistributionGroup}) - once, on a `pending` row; an `active` row asks nobody. A
   * `no` is logged here and refuses the commit; an unanswered question is the retryable 503. A
   * conversation's pending row needs no question: the roster gate in the caller already decided.
   */
  private async memberCommitterHoldsSeat(
    groupId: string,
    userId: string,
    deviceId: string,
    traceId: string
  ): Promise<boolean> {
    const row = await this.deviceGroupRepo.findOne({
      where: [
        { groupId, userId, deviceId, status: 'active' as const },
        { groupId, userId, deviceId, status: 'pending' as const, kickedAt: IsNull() },
      ],
      select: { deviceId: true, status: true },
    });
    if (!row) return false;
    if (row.status === 'active') return true;
    const scope = await this.keyDistributionScope(groupId);
    if (!scope) return true;
    if (await isEntitledToDistributionGroup(scope, userId, traceId)) return true;
    this.logger.warn(
      `[COMMIT][${traceId}] REJECT committer_not_member group=${groupId} ` +
        `device=${sanitizeLogValue(userId)}:${deviceId} kind=key-group-member-first-commit ` +
        `${scope.kind}=${scope.id} reason=not_entitled - a pending key-group seat commits only for a member`
    );
    return false;
  }

  /**
   * The answer to a commit this gate ALREADY ACCEPTED from this device at `baseEpoch` - accepted,
   * `duplicate` - or `null` when it did not.
   *
   * A committer whose first submission got no answer cannot tell "not landed yet" from "never
   * landed", and resending the SAME bytes is how it learns which - only if EVERY refusal on the epoch
   * recognises them. The log row is the proof: keyed by base epoch, written in the transaction that
   * moves the epoch, holding the bytes verbatim, so it exists exactly when that advance committed.
   * Nothing is advanced or fanned out again; the first acceptance did both. Called by each place that
   * would otherwise refuse on the epoch or on a seat - the admits pre-check, the strict gate, and the
   * advance's lost or rolled-back transaction - because a client reads any of those as a refusal and
   * clears a commit the group holds.
   */
  private async answerIfAlreadyAccepted(
    groupId: string,
    baseEpoch: number,
    commitProto: string,
    deviceId: string,
    traceId: string
  ): Promise<ValidateCommitResult | null> {
    const prior = await this.commitLogRepo.findOne({ where: { groupId, baseEpoch } });
    if (!prior || prior.commit !== commitProto || prior.senderDeviceId !== deviceId) return null;
    this.logger.log(
      `[COMMIT][${traceId}] DUPLICATE group=${groupId} device=${deviceId} baseEpoch=${baseEpoch} ` +
        '- already accepted, answered again'
    );
    return { accepted: true, newEpoch: baseEpoch + 1, duplicate: true };
  }

  /**
   * The claims a key group's commit writes its admits against, taken BEFORE any lock - or `null` for
   * a conversation, whose admits the roster already governs, and for a commit that admits nobody.
   *
   * An admit writes a `pending` seat its device later promotes by reporting itself, so it is a door
   * into the group like an external join, and in a key group it is held to the same question: is
   * this person entitled, asked of social-service per distinct person. Each claim is read before
   * that question ({@link claimSeat}) and re-read under the seat lock, so a departure that lands in
   * between refuses the admit there, and the HTTP call is never made under a lock.
   *
   * An unanswered question is a retryable 503 for the whole commit, before the epoch moves - the
   * gate's rule, never an acceptance.
   *
   * ASKED ONLY OF A COMMIT THAT CAN STILL LAND, AND ALL AT ONCE. The group's epoch is read first: a
   * commit built on another epoch is refused by the strict gate anyway, so it is answered
   * `epoch_mismatch` here without asking anyone (the gate re-checks under its lock). The distinct
   * people are then asked in parallel, so a commit's wait is one round trip, not one per person.
   *
   * @returns per admitted person, the claim when entitled and `null` when not; or the group's epoch
   *   when the commit's base is not it.
   */
  private async claimKeyGroupAdmits(
    groupId: string,
    declared: ValidateCommitBody['admits'],
    baseEpoch: number,
    traceId: string
  ): Promise<Map<string, SeatClaim | null> | { epochMismatch: number } | null> {
    if (!Array.isArray(declared) || declared.length === 0) return null;
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      select: {
        id: true,
        activeEpoch: true,
        distributionWorkspaceId: true,
        distributionChannelId: true,
      },
    });
    const scope = distributionScopeOf(group);
    if (!scope || !group) return null;
    if (group.activeEpoch !== baseEpoch) {
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} ` +
          `activeEpoch=${group.activeEpoch} - before asking about its admits`
      );
      return { epochMismatch: group.activeEpoch };
    }
    const people = new Set<string>();
    for (const d of declared) {
      const userId = sanitizeQueryValue(d?.userId ?? '', 'admits.userId');
      if (!isUnresolvedIdentity(userId)) people.add(userId);
    }
    const answered = await Promise.all(
      [...people].map(async (userId) => {
        const claim = await claimSeat(this.groupRepo.manager, groupId, userId);
        const entitled = await isEntitledToDistributionGroup(scope, userId, traceId);
        return [userId, entitled ? claim : null] as const;
      })
    );
    const claims = new Map<string, SeatClaim | null>(answered);
    this.logger.log(
      `[COMMIT][${traceId}] ADMITS_ASKED group=${groupId} ${scope.kind}=${scope.id} people=${people.size} ` +
        `entitled=${[...claims.values()].filter(Boolean).length}`
    );
    return claims;
  }

  /**
   * Takes a claim on a seat of `userId` in `groupId` - read BEFORE the check that decides an
   * activation ({@link claimSeat}). For the doors outside this service that create a seat.
   */
  async claimSeat(groupId: string, userId: string): Promise<SeatClaim> {
    return claimSeat(this.groupRepo.manager, groupId, userId);
  }

  /**
   * Cuts `userId` off every seat of `groupId`, under the seat lock, and RECORDS it: the group's seat
   * generation moves so no claim taken before this is honoured after it ({@link bumpSeatGeneration}),
   * then the membership rows, the frames queued to them, the Redis routes, and the person's eviction
   * row, which names a key group's departure ({@link recordSeatEviction}).
   *
   * Idempotent: every step is a delete keyed on the pair, and the generations only move.
   *
   * @param departure `'begin'` for a key group's eviction made BEFORE social-service's roster write:
   *   it begins a departure, named by the generation returned. `{ settles }` for the eviction made
   *   after it, which settles THAT departure (a later one that began meanwhile stays owed).
   */
  async evictSeats(
    groupId: string,
    userId: string,
    departure: 'begin' | { settles: number }
  ): Promise<{
    memberships: number;
    queued: number;
    toRemove: number;
    generation: number;
    settled: boolean;
  }> {
    return withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      // The group's generation, the deletes, then the record: the one order (`utils/seat-eviction.ts`).
      await bumpSeatGeneration(m, groupId);
      const cut = await this.deleteSeats(m, groupId, userId);
      const generation = await recordSeatEviction(m, groupId, userId, departure === 'begin');
      const settled =
        departure !== 'begin' && (await settleSeatDeparture(m, groupId, userId, departure.settles));
      return { ...cut, generation, settled };
    });
  }

  /**
   * An account erasure's cut of every seat `userId` holds in `groupId`, under the seat lock: the
   * GROUP's seat generation moves ({@link bumpSeatGeneration}), so a claim or a route read the
   * account took before the erasure never writes after it, then the queue, the device rows and the
   * Redis routes go ({@link deleteSeats}). Nothing naming the account is written: what refuses the
   * old claim is the group's, and the account's eviction rows are deleted by the erasure.
   *
   * Idempotent: a retry deletes nothing more and moves the generation again, which only refuses more.
   */
  async eraseSeats(
    groupId: string,
    userId: string
  ): Promise<{ memberships: number; queued: number; toRemove: number }> {
    return withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      await bumpSeatGeneration(m, groupId);
      const cut = await this.deleteSeats(m, groupId, userId);
      this.logger.log(
        `[INTERNAL_DELETE] seats erased group=${groupId} user=${userId.slice(0, 8)} ` +
          `memberships=${cut.memberships} queued=${cut.queued} routes=${cut.toRemove}`
      );
      return cut;
    });
  }

  /**
   * An account erasure's removal of the routes `routes` of `userId` in `groupId` that NO ACTIVE SEAT
   * of the account stands behind, re-read under the group's seat lock - the routes left by a row
   * that is gone, a 1:1 DM's tombstone above all.
   *
   * A route WITH its active row is left whole, row and route, for the erasure's final pass to cut
   * together ({@link eraseSeats}). Removing it alone would contradict the row: the next send's
   * reconciliation finds an active, keyed device missing from the set, writes its route back
   * (`restoreRoutes`) and accuses a writer that did nothing wrong (`MEMBERS_CACHE_REPAIRED`).
   *
   * @returns how many routes went, and how many were kept beside their seat.
   */
  async removeUnseatedRoutes(
    groupId: string,
    userId: string,
    routes: readonly string[]
  ): Promise<{ removed: number; kept: number }> {
    return withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      const seats = await m.getRepository(DeviceGroupMembership).find({
        where: { groupId, userId, status: 'active' as const },
        select: { deviceId: true },
      });
      const seated = new Set(seats.map((s) => `${userId}:${s.deviceId}`));
      const unseated = routes.filter((r) => !seated.has(r));
      if (unseated.length > 0) {
        await this.redis.srem(`group:members:${groupId}`, ...unseated);
      }
      this.logger.log(
        `[INTERNAL_DELETE] routes of user=${userId.slice(0, 8)} group=${groupId} ` +
          `removed=${unseated.length} kept=${routes.length - unseated.length} (kept beside an active seat, for the final pass)`
      );
      return { removed: unseated.length, kept: routes.length - unseated.length };
    });
  }

  /**
   * Deletes every seat of `userId` in `groupId` - the membership rows, the frames queued to them and
   * the Redis routes - in the transaction `m` (which holds the seat lock). The rows and the queue go
   * through the one departure ({@link endDeviceMemberships}), Welcomes included.
   */
  private async deleteSeats(
    m: EntityManager,
    groupId: string,
    userId: string
  ): Promise<{ memberships: number; queued: number; toRemove: number }> {
    const { memberships, queued } = await endDeviceMemberships(m, { userId, groupId }, 'all');
    const toRemove = await this.removeRoutesOf(groupId, userId);
    return { memberships, queued, toRemove };
  }

  /** Removes every route of `userId` in `groupId`'s routing set, by prefix; how many went. */
  private async removeRoutesOf(groupId: string, userId: string): Promise<number> {
    const routed = await this.redis.smembers(`group:members:${groupId}`);
    const routes = routed.filter((r) => r.startsWith(`${userId}:`));
    if (routes.length > 0) {
      await this.redis.srem(`group:members:${groupId}`, ...routes);
    }
    return routes.length;
  }

  /**
   * SETTLES THE KEY-GROUP DEPARTURES WHOSE SECOND EVICTION NEVER ARRIVED (hourly, beside the stale
   * device detection).
   *
   * A row with an `owedDeparture` is a departure social-service began - it evicted before its roster
   * write - and did not finish telling: the eviction after the roster write failed, or the roster
   * write itself did. Each is asked of social-service BY ITS NAME, OUTSIDE any lock
   * ({@link askDepartureOutcome}). The entitlement is not asked: it answers `true` both while the
   * roster write has not committed and after a rejoin, and settling on the first lets a seat be
   * written for a person whose departure then commits. The outcome is final - asking decides an
   * undecided departure as `cancelled`, and its roster write can then no longer commit under that
   * name - and is applied under the seat lock only if that departure is still the one owed:
   *
   * - `departed`: the seats are cut again (anything written since the first eviction goes) and the
   *   departure is settled.
   * - `cancelled`: the departure never committed and now never will; the person is still on the
   *   roster. The departure is settled and they may hold a seat again.
   * - unanswered: left as it is, for the next pass, and logged.
   *
   * A row whose group is gone, or is not a key group, is settled as it stands. Each row is caught on
   * its own, so one failure never stops the batch.
   *
   * @returns how many rows were settled, for the caller's log line.
   */
  async drainOwedSeatEvictions(): Promise<number> {
    const owed = (await this.groupRepo.manager.query(
      `SELECT "groupId", "userId", "owedDeparture" FROM dm_seat_evictions
       WHERE "owedDeparture" IS NOT NULL LIMIT 500`
    )) as Array<{ groupId: string; userId: string; owedDeparture: number | string }>;
    let settled = 0;
    for (const row of owed) {
      const traceId = this.makeTraceId('seat-drain');
      const departure = Number(row.owedDeparture);
      try {
        // RE-READ RIGHT BEFORE ASKING: a row an account erasure or a settlement removed since the
        // batch was read is not asked about - asking would have social-service record a decision
        // for a departure nothing owes any more.
        const current = await readSeatEviction(this.groupRepo.manager, row.groupId, row.userId);
        if (current.owedDeparture !== departure) {
          this.logger.log(
            `[SEAT_DRAIN][${traceId}] group=${row.groupId} user=${cutUserId(row.userId)} departure=${departure} outcome=moved (before asking)`
          );
          continue;
        }
        const scope = await this.keyDistributionScope(row.groupId);
        let decided: DepartureOutcome | null = null;
        if (scope) {
          try {
            decided = await askDepartureOutcome(row.groupId, row.userId, departure, traceId);
          } catch (e) {
            this.logger.warn(
              `[SEAT_DRAIN][${traceId}] group=${row.groupId} user=${cutUserId(row.userId)} departure=${departure} left owed - outcome unanswered: ${String(e)}`
            );
            continue;
          }
        }
        const outcome = await withSeatLock(this.groupRepo.manager, row.groupId, async (m) => {
          const now = await readSeatEviction(m, row.groupId, row.userId);
          if (now.owedDeparture !== departure) return 'moved';
          if (decided === 'departed') {
            // The one order: the group's generation, the deletes, the person's record.
            await bumpSeatGeneration(m, row.groupId);
            await this.deleteSeats(m, row.groupId, row.userId);
            await recordSeatEviction(m, row.groupId, row.userId, false);
          }
          await settleSeatDeparture(m, row.groupId, row.userId, departure);
          return decided ?? 'not_a_key_group';
        });
        if (outcome !== 'moved') settled++;
        this.logger.log(
          `[SEAT_DRAIN][${traceId}] group=${row.groupId} user=${cutUserId(row.userId)} departure=${departure} outcome=${outcome}`
        );
      } catch (e) {
        this.logger.error(
          `[SEAT_DRAIN][${traceId}] group=${row.groupId} user=${cutUserId(row.userId)} FAILED: ${String(e)}`
        );
      }
    }
    if (owed.length > 0) {
      this.logger.log(`[SEAT_DRAIN] owed=${owed.length} settled=${settled}`);
    }
    return settled;
  }

  /**
   * Settles a key-group departure social-service ABANDONED before its roster write committed - the
   * departure was recorded `cancelled` there, so its roster write can never commit under that name.
   * Nothing is evicted: the person is still on the roster, and no seat was written for them while
   * the departure was in progress. A later departure that began meanwhile is left owed.
   *
   * The hourly drain reaches the same end by asking; this is social-service telling it at once.
   *
   * @returns whether that departure was the one in progress and is now settled
   */
  async settleCancelledDeparture(
    groupId: string,
    userId: string,
    departure: number
  ): Promise<boolean> {
    const settled = await withSeatLock(this.groupRepo.manager, groupId, (m) =>
      settleSeatDeparture(m, groupId, userId, departure)
    );
    this.logger.log(
      `[DISTRIBUTION_GROUP] departure cancelled group=${groupId} user=${cutUserId(userId)} ` +
        `departure=${departure} settled=${settled}`
    );
    return settled;
  }

  /** Whether `groupId` is a Graine key-distribution group (a community's or a private salon's). */
  private async isKeyDistributionGroup(groupId: string): Promise<boolean> {
    return (await this.keyDistributionScope(groupId)) !== null;
  }

  /** The scope owning `groupId` if it is a key-distribution group, `null` for a conversation. */
  private async keyDistributionScope(groupId: string): Promise<DistributionScope | null> {
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      select: { id: true, distributionWorkspaceId: true, distributionChannelId: true },
    });
    return distributionScopeOf(group);
  }

  /**
   * Refuses unless `userId` is an admitted member of `groupId`: {@link assertCallerActsOnGroup} over
   * this service's repositories, for the doors that hold none of their own (the add-lock's two).
   */
  async assertCallerActsOnGroup(route: string, groupId: string, userId: string): Promise<void> {
    await assertCallerActsOnGroup(
      { groups: this.groupRepo, seats: this.groupMemberRepo, devices: this.deviceGroupRepo },
      this.logger,
      route,
      groupId,
      userId
    );
  }

  /**
   * Whether `userId` is a member of `groupId`, asked of the table that records membership for that
   * kind of group (see `memberOfGroupKind`). An unknown group has no members.
   */
  async isGroupMember(groupId: string, userId: string): Promise<boolean> {
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      select: { id: true, distributionWorkspaceId: true, distributionChannelId: true },
    });
    if (!group) return false;
    return (await this.memberOfGroupKind(group, groupId, userId)).isMember;
  }

  /** Whether `userId` is on the user roster of `groupId`, admitted or still awaiting a member. */
  private async isOnRoster(groupId: string, userId: string): Promise<boolean> {
    return (await this.rosterSeat(groupId, userId)) !== null;
  }

  /**
   * Whether `seat` still awaits a member's admission: its flag is set AND no device of the person
   * is `active` in the group. An active device is in the tree - a Welcome admitted it - so the person
   * is a member whatever the flag says. By construction the two never meet (the flag is lifted where
   * a member's Add or Welcome is stored, {@link liftAwaitingAdmission}, and a report of `active` is
   * refused while it stands, {@link promoteReportedSeat}); this read is what keeps a member who
   * nevertheless holds both from being refused every commit for good.
   */
  private async seatAwaitsAdmission(
    groupId: string,
    userId: string,
    seat: Pick<GroupMember, 'awaitingAdmission'>
  ): Promise<boolean> {
    if (!seat.awaitingAdmission) return false;
    const active = await this.deviceGroupRepo.count({
      where: { groupId, userId, status: 'active' as const },
    });
    if (active === 0) return true;
    this.logger.error(
      `[ADMISSION] group=${groupId} user=${sanitizeLogValue(userId)} holds ${active} active device(s) ` +
        `under a seat still flagged awaitingAdmission - a Welcome reached them past the lift; read as admitted`
    );
    return false;
  }

  /**
   * `groupId`'s seat generation now, and the one its current epoch began at - read in `m`, which
   * holds the seat lock every removal moves the generation under (`utils/seat-eviction.ts`). A
   * group with no row reads 0 for both.
   */
  private async readSeatGenerations(
    m: EntityManager,
    groupId: string
  ): Promise<{ current: number; base: number }> {
    const [row] = (await m.query(
      `SELECT "seatGeneration", "epochSeatGeneration" FROM dm_groups WHERE id = $1`,
      [groupId]
    )) as Array<{ seatGeneration: number | string; epochSeatGeneration: number | string }>;
    return {
      current: Number(row?.seatGeneration ?? 0),
      base: Number(row?.epochSeatGeneration ?? 0),
    };
  }

  /**
   * ENROLS, in the advance's transaction `m`, every person a conversation commit admits a device of
   * and the roster does not name yet - the `dm_group_members` row `POST mls/groups/:id/members`
   * writes, through the same {@link ensureGroupMember}.
   *
   * WHY HERE AND NOT IN A LATER CLIENT CALL (2026-10-25, the DUP/OFF rows of the 1.4.1 campaign).
   * The enrolment used to be the committer's `registerMember`, made after it READ the accept. An Add
   * whose answer was lost - settled later by a resubmission answered `duplicate`, or held offline and
   * sent from the outbox on return - is merged by `mergeSettled`, which sends the Welcome and never
   * enrols: the invitee held a leaf, every Welcome was refused `welcome_target_not_member`, it
   * retired itself, and the inviter's stray sweep removed the leaf. Written here, the roster row is
   * part of the accepted commit: a duplicate answer finds it already there, and no path to the gate
   * can skip it.
   *
   * THE ONE WRITER OF A NEW PERSON (ADM-3, 2026-10-25). `POST mls/groups/:id/members` enrols nobody
   * any more but the caller, into an empty roster: it answers `409 MEMBER_NOT_ADMITTED` for anyone this did not
   * admit. It used to enrol whoever it was named, after the accept and with no departure read, so a
   * Decline this gate had just honoured was undone in the same second by the adding member's call.
   *
   * WHO IT ADMITS: everyone the commit admits a device of who is NOT YET ON THE ROSTER, and everyone
   * whose seat still AWAITS a member's admission (an invitation-link ask, lifted after this by
   * {@link liftAwaitingAdmission}). Refused - not enrolled, not lifted, logged `NOT_ENROLLED`:
   * - all of them, when the committer holds no admitted seat itself (the route's
   *   `assertCallerMayMutateMembership`; the gate already refuses a seat awaiting admission);
   * - a person a block stands between and the committer;
   * - A PERSON WHO DEPARTED AFTER THE ADD WAS DECIDED (`departed_since_decision`): a stretch of
   *   theirs closed, or a member's Decline of their ask was recorded, at a seat generation later than
   *   `decidedAt` (`leftAtSeatGeneration` / `declinedAtSeatGeneration`, migration 039). A removal
   *   holds against an Add built before it (owner's rule of 2026-10-14), and so does a Decline: an
   *   Add held in an outbox, a removal whose Remove commit was lost, or a Decline (which makes no
   *   commit) can leave the epoch unchanged, and enrolling then would undo the departure. `decidedAt`
   *   is the generation a member's invitation read with its roster (`invitationSeatGeneration`): a
   *   re-invite built after a Decline or a self-leave at an unchanged epoch read the departure's own
   *   generation, so it admits, while the stale Add read an earlier one. A commit that carries none
   *   (an automatic Add, an older client) is ordered against its BASE epoch's generation
   *   (`epochSeatGeneration`): such a re-invite at an unchanged epoch is then refused, and needs a new
   *   Add. Ordered by a COUNTER every removal and Decline moves under the seat lock, never by a clock.
   *   An AWAITING seat is asked the same question: a person declined who asked AGAIN holds a new
   *   awaiting seat, and an Add built before the Decline must not lift that second ask either;
   * - ANY AWAITING SEAT, from a door that is no member's gesture (`mayAnswerAsk: false`, the
   *   background Welcome): answered `awaiting_admission` by the caller ({@link AskNotAnswerable});
   * - AN AWAITING SEAT WHOSE PERSON EVER DEPARTED OR WAS EVER DECLINED, when the commit carries no
   *   invitation generation (`departed_and_undated`): the base epoch alone cannot order it against
   *   that departure.
   * ANY REFUSAL REFUSES THE WHOLE COMMIT (the caller throws `AdmitRefused`, answered
   * `{accepted: false, reason: 'admit_refused', userIds}`): accepting it with their admits dropped
   * merged a leaf no seat holds into every member's tree. The client rebuilds the commit without
   * them. EVERY CANDIDATE IS DECIDED BEFORE ANYTHING IS WRITTEN OR LOGGED AS ADMITTED: a refusal
   * rolls the advance back, so nobody is enrolled and no `ENROLLED` / `ADMITTED_UNDATED` line is
   * written for an admission that did not happen. An awaiting seat admitted on the base epoch's
   * order alone is logged at WARN (`ADMITTED_UNDATED`), so its rate is measured. A person already ADMITTED is left as they are. A key group's roster is
   * social-service's entitlement, not a row here, and never reaches this.
   *
   * IDEMPOTENT BY CONSTRUCTION: it runs once per accepted commit, inside the transaction that writes
   * its log row (a duplicate is answered before any transaction), and `ensureGroupMember` ignores a
   * row that exists - so the route call a client still makes afterwards changes nothing.
   *
   * @param decidedAt the seat generation the Add was decided at: the invitation's, else the base
   *   epoch's (`decidedBy` says which, for the log line).
   * @returns the people refused (the caller then refuses the commit), and whether the refusal is the
   *   committer's own missing seat.
   */
  private async enrolAdmittedPeople(
    m: EntityManager,
    groupId: string,
    committer: string,
    admitted: ReadonlyArray<{ userId: string; deviceId: string }>,
    decidedAt: number,
    decidedBy: 'invitation' | 'base_epoch',
    traceId: string,
    mayAnswerAsk = true
  ): Promise<{ refused: Set<string>; committerNotOnRoster: boolean; awaitingAsk: boolean }> {
    const refused = new Set<string>();
    const none = { refused, committerNotOnRoster: false, awaitingAsk: false };
    const people = [...new Set(admitted.map((a) => a.userId))].filter((u) => u !== committer);
    if (people.length === 0) return none;
    const seats = m.getRepository(GroupMember);
    const held = new Map(
      (
        await seats.find({
          where: { groupId, userId: In(people) },
          select: { userId: true, awaitingAdmission: true },
        })
      ).map((s) => [s.userId, s.awaitingAdmission === true])
    );
    // Not on the roster (enrolled below), or on it but still awaiting a member (lifted after this):
    // the people this commit would ADMIT. Someone already admitted is left as they are.
    const candidates = people.filter((u) => !held.has(u) || held.get(u) === true);
    if (candidates.length === 0) return none;
    const refuse = (userId: string, reason: string) => {
      refused.add(userId);
      this.logger.warn(
        `[ADD_MEMBER][${traceId}] NOT_ENROLLED group=${groupId} user=${cutUserId(userId)} ` +
          `reason=${reason} committer=${cutUserId(committer)} - the commit is refused whole`
      );
    };
    const committerSeat = await seats.findOne({
      where: { groupId, userId: committer, ...ADMITTED_SEAT },
      select: { id: true },
    });
    if (!committerSeat) {
      for (const userId of candidates) refuse(userId, 'committer_not_on_roster');
      return { refused, committerNotOnRoster: true, awaitingAsk: false };
    }
    // A DOOR THAT IS NO MEMBER'S GESTURE (`mayAnswerAsk: false`, the background Welcome a push
    // answers) NEVER ANSWERS AN ASK: the seat's flag was read above in this transaction, under the
    // seat lock a Decline takes, so no route check before it can be overtaken. The phone's verdict
    // reads only its tree, where a removed member's leaf can outlive the removal.
    const asks = mayAnswerAsk ? [] : candidates.filter((u) => held.get(u) === true);
    if (asks.length > 0) {
      for (const userId of asks) refuse(userId, 'awaiting_admission door=push');
      return { refused, committerNotOnRoster: false, awaitingAsk: true };
    }
    // A removal or a self-leave closes a stretch; a Decline deletes the ask's stretch and records
    // its generation on the person's eviction row instead (`withdrawAwaitingSeat`).
    const departed = new Set(
      (
        (await m.query(
          `SELECT "userId" FROM dm_group_membership_intervals
            WHERE "groupId" = $1 AND "userId" = ANY($2::varchar[]) AND "leftAtSeatGeneration" > $3
           UNION
           SELECT "userId" FROM dm_seat_evictions
            WHERE "groupId" = $1 AND "userId" = ANY($2::varchar[]) AND "declinedAtSeatGeneration" > $3`,
          [groupId, candidates, decidedAt]
        )) as Array<{ userId: string }>
      ).map((r) => r.userId)
    );
    // AN AWAITING SEAT WHOSE PERSON EVER DEPARTED - removed, left, or declined by a member - is
    // admitted only by an Add that says WHEN it was decided (`invitationSeatGeneration`, at or after
    // that departure - the order above). One that does not - an automatic Add, an older client - is
    // ordered only by its base epoch, which cannot tell an Add decided before the departure from one
    // decided after it once another commit moved the epoch, so it is refused here. A stretch closed
    // before migration 039 has no generation and counts too.
    const awaiting = candidates.filter((u) => held.get(u) === true);
    const everDeparted =
      decidedBy === 'base_epoch' && awaiting.length > 0
        ? new Set(
            (
              (await m.query(
                `SELECT "userId" FROM dm_seat_evictions
                  WHERE "groupId" = $1 AND "userId" = ANY($2::varchar[])
                    AND "declinedAtSeatGeneration" IS NOT NULL
                 UNION
                 SELECT "userId" FROM dm_group_membership_intervals
                  WHERE "groupId" = $1 AND "userId" = ANY($2::varchar[]) AND "leftAt" IS NOT NULL`,
                [groupId, awaiting]
              )) as Array<{ userId: string }>
            ).map((r) => r.userId)
          )
        : new Set<string>();
    // DECIDED FIRST, WRITTEN AFTER: a single refusal rolls the whole advance back, so nobody is
    // enrolled or said admitted until every candidate is decided.
    const toEnrol: string[] = [];
    const undated: string[] = [];
    for (const userId of candidates) {
      if (departed.has(userId)) {
        refuse(
          userId,
          `departed_since_decision decidedAtSeatGeneration=${decidedAt} decidedBy=${decidedBy} ` +
            `seat=${held.get(userId) === true ? 'awaiting' : 'none'}`
        );
        continue;
      }
      if (everDeparted.has(userId)) {
        refuse(userId, 'departed_and_undated decidedBy=base_epoch seat=awaiting');
        continue;
      }
      if (await isBlockedBetween(m, committer, userId)) {
        refuse(userId, 'blocked');
        continue;
      }
      if (!sameSideOfReviewCohort(committer, userId)) {
        refuse(userId, 'review_cohort_boundary');
        continue;
      }
      // An awaiting seat is lifted by the caller, never re-enrolled.
      if (held.has(userId)) {
        if (decidedBy === 'base_epoch') undated.push(userId);
        continue;
      }
      toEnrol.push(userId);
    }
    if (refused.size > 0) return { refused, committerNotOnRoster: false, awaitingAsk: false };
    // Admitted on the base epoch's order alone, an awaiting seat is said at WARN, so how often an
    // undated Add answers an ask is counted.
    for (const userId of undated) {
      this.logger.warn(
        `[ADD_MEMBER][${traceId}] ADMITTED_UNDATED group=${groupId} user=${cutUserId(userId)} ` +
          `committer=${cutUserId(committer)} decidedBy=base_epoch decidedAtSeatGeneration=${decidedAt} ` +
          `seat=awaiting - an Add with no invitation generation answered an ask`
      );
    }
    for (const userId of toEnrol) {
      await ensureGroupMember(m, groupId, userId);
      this.logger.log(
        `[ADD_MEMBER][${traceId}] ENROLLED by commit group=${groupId} user=${cutUserId(userId)} ` +
          `committer=${cutUserId(committer)} decidedBy=${decidedBy}`
      );
    }
    return none;
  }

  /**
   * The `invitationSeatGeneration` a commit carries, validated: absent stays absent; anything but a
   * non-negative integer, or a number greater than the group's current seat generation, is refused
   * `400` - the client read it from this server, and the generation only grows
   * ({@link readSeatGeneration}), so a greater one was never read here. Read outside the advance's
   * transaction for the same reason: a number no greater than the generation now is no greater than
   * it later.
   */
  private async readInvitationSeatGeneration(
    raw: unknown,
    groupId: string,
    traceId: string
  ): Promise<number | undefined> {
    if (raw === undefined || raw === null) return undefined;
    const current = await readSeatGeneration(this.groupRepo.manager, groupId);
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > current) {
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT invitation_seat_generation_invalid group=${groupId} ` +
          `declared=${sanitizeLogValue(String(raw))} current=${current}`
      );
      throw new BadRequestException({
        error: 'invitation_seat_generation_invalid',
        message: 'invitationSeatGeneration must be a seat generation this group has reached',
      });
    }
    return raw;
  }

  /**
   * LIFTS `awaitingAdmission` FOR `userIds` in `groupId`, in the transaction `m` that stores what
   * admits them - the ONE writer of that lift, and ONE door reaches it: an accepted commit (the gate
   * refuses one from a seat still awaiting), for the people {@link enrolAdmittedPeople} did not
   * refuse among its declared `admits` and the target of the Welcome it carries.
   *
   * A WELCOME SENT APART NO LONGER LIFTS (ADM-3, 2026-10-25). It used to, for a member client older
   * than `admits` (#1151, `v0.18.28`), below every floor since: the Welcome carries no word of when
   * its Add was decided, so a stale Add's Welcome lifted a person's NEW ask after a Decline of the
   * first. `enqueueForLiveGroup` now refuses a Welcome to a seat still awaiting a member.
   *
   * @returns the asks this lift answered - the person and the seat's id, the ask's identity - for
   *   the caller to announce once its transaction has committed ({@link announceJoinAskSettled}),
   *   never from inside it. Who still awaited is read first, in this same transaction, which holds
   *   the seat lock a Decline takes - so the read and the guarded update see the same flags.
   */
  private async liftAwaitingAdmission(
    m: EntityManager,
    groupId: string,
    userIds: readonly string[],
    traceId: string,
    tag: string
  ): Promise<AnsweredAsk[]> {
    if (userIds.length === 0) return [];
    const people = [...new Set(userIds)];
    const repo = m.getRepository(GroupMember);
    const flagged = await repo.find({
      where: { groupId, userId: In(people), awaitingAdmission: true },
      select: { id: true, userId: true },
    });
    if (flagged.length === 0) return [];
    await repo.update(
      { groupId, id: In(flagged.map((s) => s.id)), awaitingAdmission: true },
      { awaitingAdmission: false }
    );
    // THE ARRIVAL IS THIS ADD, NOT THE ASK (user, 2026-10-21: "added = arrived"): the link dated the
    // person's interval and device rows when they asked, and every history answer and the stream
    // would hand them what was sent while they waited outside.
    const dated = await dateArrivalAtAdmission(
      m,
      groupId,
      flagged.map((s) => s.userId)
    );
    this.logger.log(
      `[${tag}][${traceId}] ADMITTED group=${groupId} users=${flagged.length} door=admits - a member's Add answered their invitation-link ask; arrival dated at this Add (intervals=${dated.intervals} devices=${dated.devices})`
    );
    return flagged.map((s) => ({ userId: s.userId, askId: s.id }));
  }

  /**
   * Announces, AFTER the transaction that lifted them committed, the asks a member's Add answered -
   * so every other member's screen settles on `admitted` live. Started, never awaited, never thrown
   * ({@link announceJoinAskSettled}).
   */
  private announceAdmitted(groupId: string, admitted: readonly AnsweredAsk[], actor: string): void {
    announceJoinAskSettled(
      this.groupRepo.manager,
      this.redis,
      groupId,
      admitted,
      'admitted',
      actor
    );
  }

  /** `userId`'s roster seat in `groupId`, or `null` - the one read of `dm_group_members` here. */
  private async rosterSeat(
    groupId: string,
    userId: string
  ): Promise<Pick<GroupMember, 'id' | 'awaitingAdmission'> | null> {
    return this.groupMemberRepo.findOne({
      where: { groupId, userId },
      select: { id: true, awaitingAdmission: true },
    });
  }

  /**
   * Refuses `userId` the external-join base of `groupId` unless they hold a roster seat that does
   * NOT await a member's admission - the question the commit gate ({@link assertCommitterMayCommit})
   * asks of an external commit, so the base and the gate agree.
   *
   * A seat an invitation link wrote is an ask until a member's Add admits the person
   * (`GroupMember.awaitingAdmission`); serving it the base let the person enter around that member.
   * Its refusal is a 409 `awaiting_admission`, NEVER the 403 of no seat at all: a client reads a 403
   * here as "I am not a member" and retires the conversation (`NotAGroupMemberError`), while this
   * person is a pending member who waits. A current client is told before it asks
   * (`GET mls/device-memberships`, `awaitingAdmission`); this answer is what an older one meets, and
   * it falls back to asking a member, which is the right next move.
   */
  private async assertMayReadExternalBase(groupId: string, userId: string): Promise<void> {
    const seat = await this.rosterSeat(groupId, userId);
    if (!seat) {
      throw new ForbiddenException(`User ${userId} is not a member of group ${groupId}`);
    }
    if (await this.seatAwaitsAdmission(groupId, userId, seat)) {
      // An older client asks for the base on every cadence of its wait: said at 1, 10, 100...
      const nth = this.awaitingAskRepeats.hit(`base|${groupId}|${userId}`);
      if (nth !== null) {
        this.logger.log(
          `[GROUP_INFO] group=${groupId} user=${sanitizeLogValue(userId)} awaits a member's admission - base withheld (repeat=${nth}, said at 1, 10, 100...)`
        );
      }
      throw awaitingAdmissionRefusal();
    }
  }

  /**
   * Re-reads, under a row lock and inside the caller's transaction, the seat a Welcome is about to
   * be stored for - so a Welcome store and a removal of its target serialise.
   *
   * A conversation's seat is the target's `dm_group_members` row. The removal deletes that row
   * first ({@link MembersController.removeGroupMember}), so: a removal that committed before this
   * read leaves no row, and the store writes nothing; a removal that comes after waits on this lock,
   * then deletes the stored Welcome with the membership ({@link endDeviceMemberships}). Read after
   * the group row and before any write - the order every membership writer takes.
   *
   * A KEY-DISTRIBUTION GROUP HAS NO ROSTER ROW HERE: its roster is social-service's, asked in
   * {@link resolveWelcomeTarget} against a claim read before the question. The caller holds the
   * group's seat lock, the one an eviction takes, and the claim is re-read under it
   * ({@link seatClaimHolds}): an eviction that committed after the answer, or a departure still in
   * progress, refuses the store; one that comes after waits for this transaction, then deletes
   * the stored Welcome with the seats.
   *
   * The target's key package is read `FOR SHARE` after it ({@link heldKeyPackages}): both callers
   * insert the target's pending row, and a device being erased gets none.
   *
   * `requireAdmitted` refuses a conversation seat that still awaits a member's admission too - the
   * Welcome sent apart, which never admits anyone. A commit carrying its Welcome passes false: its
   * own acceptance is what admits the target, later in the same transaction.
   *
   * @returns false when the seat is gone (or not admitted, when required), logged; the caller rolls
   *   its transaction back.
   */
  private async lockWelcomeSeat(
    m: EntityManager,
    target: WelcomeSeat,
    groupId: string,
    traceId: string,
    tag: string,
    opts: { requireAdmitted?: boolean } = {}
  ): Promise<boolean> {
    if (!(await this.seatStandsFor(m, target, groupId, traceId, tag, opts))) return false;
    // ...AND THE TARGET'S KEY PACKAGE, read `FOR SHARE` last: both stores insert the target's
    // pending row in this transaction, and a row inserted after an account erasure took the key
    // packages would outlive it ({@link heldKeyPackages}).
    if ((await heldKeyPackages(m, [target])).has(`${target.userId}:${target.deviceId}`))
      return true;
    this.logger.warn(
      `[${tag}][${traceId}] REJECT welcome_target_not_member group=${groupId} ` +
        `target=${sanitizeLogValue(target.userId)}:${sanitizeLogValue(target.deviceId)} ` +
        `reason=no_key_package (read under the seat lock - the account or device is being erased)`
    );
    return false;
  }

  /**
   * The Welcome row already queued for `target` in `groupId` with exactly `payload`, or `null` -
   * read under a lock that serialises every store of a Welcome for that device in that group, so two
   * copies of the same bytes cannot both find none. `m` MUST be transactional.
   *
   * WHY: a client sends the Welcome an accepted Add owes, and sends it AGAIN when no answer came
   * back (the obligation is durable client state, cleared only by an answer). The first request may
   * have been stored and only its answer lost; the copy is then the same bytes, and storing it again
   * would hand the joiner a second Welcome. Only a row still queued is found: one the joiner already
   * consumed is gone, and a later copy reaches a device that holds the group, which takes it as a
   * redelivery (`setupMessageHandler`).
   */
  private async findQueuedWelcome(
    m: EntityManager,
    groupId: string,
    target: WelcomeSeat,
    payload: string | undefined
  ): Promise<QueuedMessage | null> {
    if (!payload) return null;
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `welcome-store:${groupId}:${target.userId}:${target.deviceId}`,
    ]);
    return m.getRepository(QueuedMessage).findOne({
      where: {
        groupId,
        recipientId: target.userId,
        deviceId: target.deviceId,
        isWelcome: true,
        proto: payload,
      },
    });
  }

  /** {@link lockWelcomeSeat}'s first half: whether the target still holds its seat, logged when not. */
  private async seatStandsFor(
    m: EntityManager,
    target: WelcomeSeat,
    groupId: string,
    traceId: string,
    tag: string,
    opts: { requireAdmitted?: boolean } = {}
  ): Promise<boolean> {
    if (target.keyGroup) {
      if (!target.claim) {
        this.logger.error(
          `[${tag}][${traceId}] REJECT welcome_target_not_member group=${groupId} ` +
            `target=${sanitizeLogValue(target.userId)} - a key-group Welcome reached the store with no seat claim`
        );
        return false;
      }
      const refusal = await seatClaimHolds(m, target.claim);
      if (refusal === null) return true;
      this.logger.warn(
        `[${tag}][${traceId}] REJECT welcome_target_not_member group=${groupId} ` +
          `target=${sanitizeLogValue(target.userId)} reason=${refusal} - evicted after the entitlement answer`
      );
      return false;
    }
    // `FOR UPDATE`, not `FOR SHARE`: a commit carrying its Welcome then lifts this row's
    // `awaitingAdmission` ({@link liftAwaitingAdmission}) in the same transaction, and a share lock
    // held by a concurrent store would deadlock that upgrade. Taken exclusive here, one waits.
    const seat = await m.getRepository(GroupMember).findOne({
      where: { groupId, userId: target.userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (seat && opts.requireAdmitted === true && seat.awaitingAdmission === true) {
      this.logger.warn(
        `[${tag}][${traceId}] REJECT welcome_target_not_member group=${groupId} ` +
          `target=${sanitizeLogValue(target.userId)}:${sanitizeLogValue(target.deviceId)} ` +
          `reason=awaiting_admission - no accepted commit admitted them`
      );
      return false;
    }
    if (seat) return true;
    this.logger.warn(
      `[${tag}][${traceId}] REJECT welcome_target_not_member group=${groupId} ` +
        `target=${sanitizeLogValue(target.userId)} - the seat went before the Welcome was stored`
    );
    return false;
  }

  /**
   * Whether a Welcome may be addressed to `targetUserId:targetDeviceId` in `groupId`, and whose
   * device it is. The ONE bar for both doors that store a Welcome: {@link sendWelcome}, and a
   * commit carrying its Welcome ({@link validateCommit}).
   *
   * The device must be registered (its KeyPackage row; the user narrows the lookup when given, so
   * two accounts sharing a raw device id stay apart). THE TARGET OF A CONVERSATION'S WELCOME IS ON
   * ITS ROSTER: a Welcome sent apart follows an Add whose acceptance enrolled the person
   * ({@link enrolAdmittedPeople}), and one carried INSIDE a commit is resolved here before that
   * commit's transaction, so its target must already be enrolled (the background re-add Welcomes
   * existing members). This refuses only a device whose owner the group does not name - the row a Welcome
   * writes would otherwise make it a device of the group. A key-distribution group has no user
   * roster here, so its target is asked of social-service, exactly as its external joins are
   * (WP-KEYGROUP-JOIN-GATE); a grant is written there before the granting device Welcomes anyone.
   */
  private async resolveWelcomeTarget(
    group: Group | null,
    groupId: string,
    targetUserId: string | undefined,
    targetDeviceId: string,
    traceId: string,
    tag: string
  ): Promise<{ userId: string; claim: SeatClaim | null } | { refused: WelcomeTargetRefusal }> {
    const query: Record<string, string> = { deviceId: targetDeviceId };
    if (targetUserId) {
      query.userId = targetUserId;
    }
    const deviceInfo = await this.keyPackageRepo.findOne({ where: query });
    if (!deviceInfo) {
      // A REFUSAL, NOT A FAULT: a device its owner revoked is purged, and a sender that built its Add
      // before the revocation still Welcomes it. One decision line, at the level of a refusal.
      this.logger.warn(
        `[${tag}][${traceId}] REJECT welcome_target_unknown group=${groupId} ` +
          `target=${targetUserId ?? 'unknown'}:${targetDeviceId} - no device registered under it`
      );
      return { refused: 'welcome_target_unknown' };
    }
    const scope = distributionScopeOf(group);
    // A key group's answer is taken against a CLAIM read before the question, so the store can tell
    // whether an eviction committed after it ({@link lockWelcomeSeat}).
    const claim = scope
      ? await claimSeat(this.groupRepo.manager, groupId, deviceInfo.userId)
      : null;
    const admissible = scope
      ? await isEntitledToDistributionGroup(scope, deviceInfo.userId, traceId)
      : await this.isOnRoster(groupId, deviceInfo.userId);
    if (!admissible) {
      this.logger.warn(
        `[${tag}][${traceId}] REJECT welcome_target_not_member group=${groupId} ` +
          `target=${sanitizeLogValue(deviceInfo.userId)}:${targetDeviceId}`
      );
      return { refused: 'welcome_target_not_member' };
    }
    return { userId: deviceInfo.userId, claim };
  }

  /** The queued row of a Welcome, as both doors that store one write it. */
  private welcomeRow(
    groupId: string,
    senderId: string,
    w: { userId: string; deviceId: string; payload: string; ratchetTree?: string }
  ): Partial<QueuedMessage> {
    return {
      recipientId: w.userId,
      deviceId: w.deviceId,
      senderId,
      groupId,
      proto: w.payload,
      isWelcome: true,
      ratchetTree: w.ratchetTree,
      createdAt: new Date(),
    };
  }

  /**
   * Delivers a STORED Welcome row through the one delivery, exactly like an application frame.
   *
   * A Welcome is always SILENT - it is routed by `data.isWelcome=true` to the Android background
   * receiver, which joins the group without telling the user - and always PUSHABLE: a device that is
   * never woken for it stays outside the group, and the next message push then fails to decrypt
   * with "Groupe introuvable" and shows a generic "Nouveau message de X".
   *
   * `pushable` also arms the deferred fallback. A frozen Android app reads as online, so a Welcome
   * published into a socket nobody was reading was followed by nothing: the device stayed unjoined
   * until its next foreground pull.
   */
  private async deliverWelcome(queued: QueuedMessage, traceId: string): Promise<void> {
    const isOnline = await this.redis.exists(
      devicePresenceKey(queued.recipientId, queued.deviceId)
    );
    await this.deliverQueuedFrame(queued, {
      tag: 'WELCOME',
      traceId,
      online: !!isOnline,
      silent: true,
      pushable: true,
    });
  }

  /**
   * The external-join base of a KEY GROUP, for a shut phone that received a salon push sealed on a
   * key group it holds no seat in (channel-encryption section 26, decided by the user 2026-10-22).
   *
   * THE SAME GATE AS THE APP'S OWN JOIN, NEVER A SECOND ONE. The app reads this base through
   * social-service with a session; a killed app has none, so it authenticates with its PushSecret
   * and this asks social-service the SAME question (`isEntitledToDistributionGroup`, the predicate
   * that serves the base and gates the commit). Unanswered is the 503 that helper throws, never an
   * acceptance.
   *
   * - A conversation is refused (`not_a_key_group`): its base is gated by its own roster on the
   *   JWT route, and this door must not become a second way to read it.
   * - A device whose seat is `pending` with a Welcome queued or an add in flight is told
   *   `welcomeOwed` and given NO base: somebody is writing its leaf, and a second writer is the
   *   duplicate-leaf race (one door at a time, section 20).
   */
  async readKeyGroupBaseForPush(
    groupId: string,
    userId: string,
    deviceId: string
  ): Promise<KeyGroupBaseForPush> {
    const traceId = this.makeTraceId('kg-base-push');
    const scope = await this.keyDistributionScope(groupId);
    if (!scope) {
      this.logger.warn(
        `[KEY_GROUP_PUSH_JOIN][${traceId}] REFUSED base group=${groupId} device=${cutUserId(userId)}:${deviceId} reason=not_a_key_group`
      );
      throw new ForbiddenException({
        error: 'not_a_key_group',
        message: 'only a key-distribution group is joined from a push',
      });
    }
    if (!(await isEntitledToDistributionGroup(scope, userId, traceId))) {
      this.logger.warn(
        `[KEY_GROUP_PUSH_JOIN][${traceId}] REFUSED base group=${groupId} ${scope.kind}=${scope.id} device=${cutUserId(userId)}:${deviceId} reason=not_entitled`
      );
      throw new ForbiddenException(
        refusalBody(RefusalCode.NOT_A_MEMBER, 'this device may not join this key group', {
          error: 'not_entitled',
        })
      );
    }
    const seat = await this.deviceGroupRepo.findOne({
      where: { userId, deviceId, groupId },
      select: { status: true },
    });
    if (seat?.status === 'pending') {
      const facts = await readPendingMembershipFacts(
        this.queuedMessageRepo,
        this.redis,
        deviceId,
        [groupId],
        this.logger
      );
      const addInFlight = addInFlightOf(facts, groupId);
      // An UNREAD add lock is not "no Add": no base is served on it, as on an owed Welcome.
      if (facts.welcomed.has(groupId) || addInFlight !== false) {
        this.logger.log(
          `[KEY_GROUP_PUSH_JOIN][${traceId}] WELCOME OWED group=${groupId} device=${cutUserId(userId)}:${deviceId} ` +
            `welcomeQueued=${facts.welcomed.has(groupId)} addInFlight=${addInFlight ?? 'unknown'} - no base served`
        );
        return { scope, welcomeOwed: true, base: null };
      }
    }
    const base = await this.readGroupInfo(groupId);
    this.logger.log(
      `[KEY_GROUP_PUSH_JOIN][${traceId}] base served group=${groupId} ${scope.kind}=${scope.id} ` +
        `device=${cutUserId(userId)}:${deviceId} baseEpoch=${base?.baseEpoch ?? 'none'} activeEpoch=${base?.activeEpoch ?? 'none'}`
    );
    return { scope, welcomeOwed: false, base };
  }

  /**
   * Submits a shut phone's EXTERNAL commit into a KEY GROUP - the commit half of
   * {@link readKeyGroupBaseForPush}.
   *
   * NARROWER THAN `POST /mls/commit` ON PURPOSE. A PushSecret is a weaker credential than a session
   * (it lives on the device to serve a killed app), so this door takes the one commit a push can
   * legitimately produce - an external commit into a key-distribution group - and refuses every
   * other: a member commit (a Remove, an Add) or any commit into a conversation. What it accepts then
   * goes through {@link validateCommit} unchanged, so the entitlement, the epoch gate, the base
   * stored with the advance and the committer's activation are the app's own.
   */
  async submitKeyGroupJoinForPush(
    body: ValidateCommitBody,
    userId: string
  ): Promise<ValidateCommitResult> {
    const traceId = this.makeTraceId('kg-join-push');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const frame = typeof body.proto === 'string' ? readCommitFrame(body.proto) : null;
    if (!frame?.external) {
      this.logger.warn(
        `[KEY_GROUP_PUSH_JOIN][${traceId}] REFUSED commit group=${groupId} device=${cutUserId(userId)}:${body.deviceId} reason=not_an_external_commit framed=${!!frame}`
      );
      throw new BadRequestException({
        error: 'not_an_external_commit',
        message: 'only an external commit is accepted from a push',
      });
    }
    if (!(await this.isKeyDistributionGroup(groupId))) {
      this.logger.warn(
        `[KEY_GROUP_PUSH_JOIN][${traceId}] REFUSED commit group=${groupId} device=${cutUserId(userId)}:${body.deviceId} reason=not_a_key_group`
      );
      throw new ForbiddenException({
        error: 'not_a_key_group',
        message: 'only a key-distribution group is joined from a push',
      });
    }
    // Nothing from the body but the commit, its base and the base it creates: a push join admits
    // nobody, removes nobody and excludes nobody but itself.
    const result = await this.validateCommit(
      {
        groupId,
        deviceId: body.deviceId,
        senderId: body.senderId,
        baseEpoch: body.baseEpoch,
        proto: body.proto,
        groupInfo: body.groupInfo,
      },
      userId
    );
    this.logger.log(
      `[KEY_GROUP_PUSH_JOIN][${traceId}] commit ${result.accepted ? `ACCEPTED newEpoch=${result.newEpoch}` : `refused reason=${result.reason} currentEpoch=${result.currentEpoch}`} ` +
        `group=${groupId} device=${cutUserId(userId)}:${body.deviceId} baseEpoch=${body.baseEpoch}`
    );
    return result;
  }

  /**
   * Delivers an MLS Welcome message and optional ratchet tree to a target device.
   * Verifies the sender is a member of the group, queues the welcome, performs
   * real-time delivery if the target is online, and updates DeviceGroupMembership status.
   */
  async sendWelcome(
    authUserIdRaw: string | undefined,
    body: SendWelcomeBody
  ): Promise<{ status: string }> {
    const traceId = this.makeTraceId('welcome-send');
    const targetDeviceId = sanitizeQueryValue(body.targetDeviceId, 'targetDeviceId');
    const targetUserId = sanitizeOptionalQueryValue(body.targetUserId, 'targetUserId');
    const senderUserId = sanitizeOptionalQueryValue(body.senderUserId, 'senderUserId') || 'system';
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    // Verify that the authenticated sender is a member of the group.
    // authUserIdRaw comes from the x-user-id header injected by the proxy after JWT validation.
    //
    // THE SAME TABLE-PER-KIND QUESTION AS THE REPLAY (`getCommitsSince`). Until 2026-09-27 nobody
    // Welcomed anyone into a key-distribution group - they were entered by external commit alone -
    // so this gate only ever read `dm_group_members`, which names nobody for such a group. Section
    // 20 of the channel-encryption protocol makes the client that adds a community newcomer
    // Welcome their devices; asked of the user table, every one of those Welcomes would be refused.
    // A sender holding an ACTIVE leaf row may Welcome: it already reads every seed on the group.
    const authUserId = sanitizeOptionalQueryValue(authUserIdRaw, 'x-user-id');
    const group = await this.groupRepo.findOne({ where: { id: safeGroupId } });
    if (authUserId) {
      const { isMember, isKeyDistribution } = await this.memberOfGroupKind(
        group,
        safeGroupId,
        authUserId
      );
      if (!isMember) {
        this.logger.warn(
          `[WELCOME][${traceId}] AUTHZ FAIL sender=${authUserId} not member of group=${safeGroupId} keyDistribution=${isKeyDistribution}`
        );
        throw new ForbiddenException(`User ${authUserId} is not a member of group ${safeGroupId}`);
      }
    }

    this.logger.log(
      `[WELCOME][${traceId}] START group=${safeGroupId} sender=${senderUserId} target=${targetUserId ?? 'unknown'}:${targetDeviceId} payloadLen=${body.welcomePayload?.length ?? 0} ratchetTreeLen=${body.ratchetTreePayload?.length ?? 0}`
    );

    const target = await this.resolveWelcomeTarget(
      group,
      safeGroupId,
      targetUserId,
      targetDeviceId,
      traceId,
      'WELCOME'
    );
    if ('refused' in target) {
      // TYPED AT THE THROW (DEV-3, 2026-10-25): this was a bare `Error`, so a KNOWN refusal - a
      // Welcome to a device its owner had just revoked - reached the client as a 500 with a stack in
      // this log. The decision line above is the whole record of it.
      if (target.refused === 'welcome_target_unknown') {
        throw new NotFoundException(
          refusalBody(RefusalCode.WELCOME_TARGET_UNKNOWN, 'this Welcome has no target device', {
            error: 'welcome_target_unknown',
          })
        );
      }
      // `code` is what a client types the refusal by (`WelcomeTargetNotMemberError`); `error` and the
      // message stay for the clients that predate it.
      throw new ForbiddenException(
        refusalBody(RefusalCode.WELCOME_TARGET_NOT_MEMBER, 'this Welcome is not accepted', {
          error: 'welcome_target_not_member',
        })
      );
    }
    const deviceInfo = target;

    const queuedWelcome = this.queuedMessageRepo.create(
      this.welcomeRow(safeGroupId, senderUserId, {
        userId: deviceInfo.userId,
        deviceId: targetDeviceId,
        payload: body.welcomePayload,
        ratchetTree: body.ratchetTreePayload,
      })
    );
    // Same seam as the send: a Welcome for a group that ended between the target lookup and this
    // write is worse than an undeliverable message - the device that receives it asks for a group
    // nobody can hand it, on every reconnection. See {@link enqueueForLiveGroup}.
    const [stored] = await this.enqueueForLiveGroup(
      [queuedWelcome],
      safeGroupId,
      'WELCOME',
      traceId,
      undefined,
      {
        welcome: {
          userId: deviceInfo.userId,
          deviceId: targetDeviceId,
          keyGroup: distributionScopeOf(group) !== null,
          claim: deviceInfo.claim,
        },
      }
    );
    if (stored && stored !== queuedWelcome) {
      // A RE-SEND OF THE SAME BYTES, already queued: nothing is stored a second time. The queued
      // row is handed to the delivery again - the same row, so nothing new is queued, and a device
      // that already joined from it takes the copy as a redelivery (`setupMessageHandler`) - because
      // the first request may have died between its store and its delivery, and a re-send is the
      // only thing left to arm the live publish and the push.
      this.logger.log(
        `[WELCOME][${traceId}] DUPLICATE id=${stored.id} recipient=${deviceInfo.userId}:${targetDeviceId} ` +
          `group=${safeGroupId} - the same Welcome is already queued, nothing stored again; its row is delivered again`
      );
      await this.deliverWelcome(stored, traceId);
      return { status: 'queued' };
    }
    this.logger.log(
      `[WELCOME][${traceId}] QUEUED id=${queuedWelcome.id} recipient=${deviceInfo.userId}:${targetDeviceId} group=${safeGroupId}`
    );
    await this.deliverWelcome(queuedWelcome, traceId);

    // THE ROUTING SET IS NOT WRITTEN HERE, AND THE `sadd` THAT USED TO BE ON THIS LINE IS THE
    // REASON THIS FUNCTION COULD LEAVE SQL AND REDIS DISAGREEING.
    //
    // `group:members:{groupId}` is OWNED by `activateDeviceMembership`, which writes it at the
    // pending->active transition - the moment membership is decided, and the invariant the
    // reconciliation in `sendMessage` accuses a violation of. This function ran one line after
    // writing `pending`, so it announced a device as routable in the same breath as recording that
    // it had not joined yet: the SQL fan-out skipped it while the gateway, which broadcasts from
    // this very set, did not. The gateway also ELECTS an answerer for `welcome_request` and
    // `history_request` from it, so a device that holds no group state could be picked to serve
    // one.
    //
    // Nothing replaces it. A device the Welcome has not reached cannot decrypt a broadcast anyway;
    // what it can open is QUEUED for it from the epoch its admitting commit recorded
    // (`ValidateCommitBody.admits`), and `activateDeviceMembership` adds it here once it has joined.

    this.logger.log(
      `[WELCOME][${traceId}] DONE group=${safeGroupId} target=${deviceInfo.userId}:${targetDeviceId}`
    );

    return { status: 'queued' };
  }

  /**
   * A REPORT of `active`: promotes the seat in ONE conditional UPDATE, and never inserts.
   *
   * Every legitimate report follows a write that made the seat: the admitting commit or the
   * Welcome (`pending`), or the accepted external commit that activated its committer (`active`, so
   * the report is idempotent). So the statement matches only the `(user, device, group)` row; a
   * `pending` one only without a kick no commit has answered - the admitting commit clears it, and
   * until then the device is refused at the commit gate too; and, in a conversation, only while its
   * owner is on the roster.
   *
   * A KEY-DISTRIBUTION GROUP HAS NO USER ROSTER HERE, so its membership is asked of social-service,
   * like every other writer of a key-group seat ({@link isEntitledToDistributionGroup}): a `pending`
   * seat is promoted only if its owner is entitled, against a claim read before the question and
   * re-read under the seat lock ({@link seatClaimHolds}), so a departure that lands meanwhile refuses
   * it. An `active` seat reported again asks nobody - the report changes nothing it holds. An
   * unanswered question is the retryable 503 every such question is, and promotes nothing.
   *
   * ONE STATEMENT, BECAUSE A READ THEN A WRITE IS A RACE. A removal deletes the rows and a kick
   * stamps `kickedAt`; a report checked by a read and then upserted could land between them and
   * re-create an active row, or clear the kick. The UPDATE re-checks its own WHERE on the row it
   * locks, so a row deleted first is simply not matched, and nothing is ever inserted. The routing
   * set is written only when the statement promoted exactly that row.
   */
  private async promoteReportedSeat(
    userId: string,
    deviceId: string,
    groupId: string,
    tag: string
  ): Promise<ActivationOutcome> {
    const scope = await this.keyDistributionScope(groupId);
    const entitledClaim = scope
      ? await this.claimEntitledReport(scope, userId, deviceId, groupId, tag)
      : null;
    if (entitledClaim === 'not_entitled' || entitledClaim === 'departed') {
      return { ok: false, reason: entitledClaim };
    }
    // Which rows the statement may promote. A conversation: an unkicked seat whose owner is an
    // admitted member of the roster. A key group: the seat already active, or - only with an
    // entitlement whose claim still holds - an unkicked pending one.
    const promotable = scope
      ? entitledClaim
        ? `(status = 'active' OR "kickedAt" IS NULL)`
        : `status = 'active'`
      : `(status = 'active' OR "kickedAt" IS NULL)
          AND EXISTS (SELECT 1 FROM dm_group_members m
            WHERE m."groupId" = :groupId AND m."userId" = :userId
              AND m."awaitingAdmission" = false)`;
    // UNDER THE SEAT LOCK, like every other seat write, so an eviction is wholly before (the row is
    // gone and nothing matches) or wholly after (it deletes what this promoted).
    const result = await withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      // ONLY THIS PERSON'S DEPARTURE REFUSES HERE. The generation is the GROUP's, so anybody's
      // eviction while social-service was asked moves it - and a report has no retry to absorb that
      // refusal. It needs none: this statement is an UPDATE under the seat lock, and every eviction
      // of this person deletes their rows, so one that ran since the question leaves nothing to
      // match. A departure begun but not yet written to the roster is the one thing the rows do not
      // say, and the claim's `owed` does.
      if (entitledClaim && (await seatClaimHolds(m, entitledClaim)) === 'departure_in_progress') {
        this.logger.warn(
          `[${tag}] REFUSED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
            `reason=departed (departure_in_progress since the entitlement was asked)`
        );
        return 'departed' as const;
      }
      return m
        .getRepository(DeviceGroupMembership)
        .createQueryBuilder()
        .update(DeviceGroupMembership)
        .set({ status: 'active' as const, kickedAt: null, admittedAtEpoch: null })
        .where('"userId" = :userId AND "deviceId" = :deviceId AND "groupId" = :groupId', {
          userId,
          deviceId,
          groupId,
        })
        .andWhere(promotable)
        .execute();
    });
    if (result === 'departed') return { ok: false, reason: 'departed' };
    if (result.affected === 1) {
      this.logger.log(`[${tag}] group=${groupId} device=${userId}:${deviceId}`);
      await this.routeActiveSeat(userId, deviceId, groupId, tag);
      return { ok: true };
    }
    // The statement decided; this read only NAMES why, for the log and the answer. If the row moved
    // in between, the name may be stale but the refusal is not.
    const reason = (await this.seatRefusal(userId, deviceId, groupId)) ?? 'no_seat';
    this.logger.warn(
      `[${tag}] REFUSED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
        `reason=${reason} affected=${result.affected ?? 0} - a report promotes a seat and never creates one`
    );
    return { ok: false, reason };
  }

  /**
   * For a report in a key-distribution group: the claim a `pending` seat is promoted against, once
   * social-service answered that its owner is entitled - or `'not_entitled'` / `'departed'` (logged
   * here, the decision), or `null` when the seat is not an unkicked `pending` one and nothing is
   * asked: an `active` seat is only reported again, and an absent or kicked one is refused by the
   * statement.
   *
   * The claim is read BEFORE the question ({@link claimSeat}), never under a lock, as every
   * key-group seat writer does; the statement re-reads its departure under the seat lock. A
   * departure already in progress is refused without asking.
   */
  private async claimEntitledReport(
    scope: DistributionScope,
    userId: string,
    deviceId: string,
    groupId: string,
    tag: string
  ): Promise<SeatClaim | 'not_entitled' | 'departed' | null> {
    const seat = await this.deviceGroupRepo.findOne({
      where: { userId, deviceId, groupId },
      select: { status: true, kickedAt: true },
    });
    if (seat?.status !== 'pending' || seat.kickedAt) return null;
    const claim = await claimSeat(this.groupRepo.manager, groupId, userId);
    if (claim.owed) {
      this.logger.warn(
        `[${tag}] REFUSED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
          `reason=departed (departure_in_progress) - not asked of social-service`
      );
      return 'departed';
    }
    const traceId = this.makeTraceId('seat-report');
    if (await isEntitledToDistributionGroup(scope, userId, traceId)) return claim;
    this.logger.warn(
      `[${tag}][${traceId}] REFUSED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
        `reason=not_entitled ${scope.kind}=${scope.id} - a key-group seat is promoted only for a member of its ${scope.kind}`
    );
    return 'not_entitled';
  }

  /**
   * Why a report found no seat to promote - the NAME of the refusal {@link promoteReportedSeat}
   * already made, read after it. Never the decision itself.
   */
  private async seatRefusal(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<SeatRefusal | null> {
    const seat = await this.deviceGroupRepo.findOne({
      where: { userId, deviceId, groupId },
      select: { status: true, kickedAt: true },
    });
    if (!seat) return 'no_seat';
    if (seat.status === 'pending' && seat.kickedAt) return 'kicked';
    if (await this.isKeyDistributionGroup(groupId)) return null;
    const roster = await this.rosterSeat(groupId, userId);
    if (!roster) return 'not_on_roster';
    return roster.awaitingAdmission ? 'awaiting_admission' : null;
  }

  /**
   * THE ONE WRITER OF `active`, AND THE ONE WRITER OF THE REDIS ROUTING SET.
   *
   * That sentence is in this table's entity docblock and it was NOT true until 2026-09-13. Three
   * paths performed the `pending -> active` transition and they agreed on nothing:
   *
   * | Path | Addressability gate | Redis routing set | `kickedAt` |
   * | --- | --- | --- | --- |
   * | this method | warn and return | written | cleared |
   * | `updateInvitationStatus` | THROW | **never written** | cleared |
   * | `createGroup` | **none at all** | written | left unset |
   *
   * The middle row is the one that bit. A device that processed its Welcome in the FOREGROUND got
   * a truthful `active` row and was never added to `group:members:{groupId}`, so the gateway could
   * not reach it and could not elect it to answer a `welcome_request` or a `history_request` -
   * silently, because a routing set that is merely INCOMPLETE is not empty, and the reload at each
   * election door only fires on an EMPTY set. The SEND path's reconciliation repaired it on the
   * next message to that group, which is a witness and never a fix: until then the device was
   * unreachable, and the reconciliation's own comment justified itself by a Redis that ran without
   * a volume until 2026-08-12 - a cause that had been fixed, over a live writer that had not.
   *
   * The third row is WP-GHOST-1 with no gate: a revoked or key-package-less device creating a
   * group enrolled itself `active` in it, which is the exact shape the other two refuse.
   *
   * So the three are fused here. What differs legitimately between callers is what a REFUSAL owes
   * the client, and that is why this returns the reason rather than throwing: a foreground HTTP
   * caller turns it into a 400, a best-effort seam logs it and carries on. The log line is written
   * HERE, under the caller's own `tag`, so no caller can swallow it.
   *
   * NOTHING IS REPLAYED HERE ANY MORE (user, 2026-09-28). A replay at this transition (DF2) re-sent
   * what a five-minute window over the history stream still held, capped at 50 - a clock deciding
   * what a device was owed. A device a commit admits is a recipient from that commit's epoch on
   * instead, at SEND time (`ValidateCommitBody.admits`), so by the time it activates everything it
   * can open is already in its queue.
   *
   * A REPORT PROMOTES A SEAT; IT NEVER CREATES ONE (2026-10-22). Every caller names its
   * {@link ActivationAuthority}, and a `report` - the two doors a device may call about itself - is
   * refused unless its seat exists, in one conditional UPDATE that never inserts
   * ({@link promoteReportedSeat}). The other authorities create the seat
   * under a gate of their own, which is why they may: the accepted commit, the group's creation, the
   * publisher social-service vouched for.
   *
   * Idempotent: upsert on the unique constraint (deviceId, groupId).
   */
  async activateDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string,
    {
      tag = 'MEMBERSHIP_ACTIVE',
      authority,
      claim,
    }: {
      tag?: string;
      authority: ActivationAuthority;
      /**
       * The claim this seat is written against ({@link claimSeat}), taken by the caller BEFORE the
       * check that decided the activation. REQUIRED of the two authorities whose check is made
       * outside this service's lock - `accepted_commit` and `distribution_publisher` - and the seat
       * is then written under the group's seat lock only if no eviction overtook the claim.
       */
      claim?: SeatClaim;
    }
  ): Promise<ActivationOutcome> {
    // A NON-IDENTITY IS REFUSED HERE, BECAUSE THE GATE BELOW CANNOT SEE IT AND TWO DOORS DID NOT
    // LOOK. `deviceAddressability` asks whether this pair is reachable; a placeholder that
    // registered a KeyPackage answers yes, which is exactly how `userId='unknown'`,
    // `deviceId='pending'` became an ACTIVE member of a real conversation on 2026-08-27. Two of the
    // four doors sanitized the identity and two did not, so the check belongs where there is one of
    // it. A refusal, not a throw: this method answers its callers with an outcome.
    for (const [field, value] of [
      ['userId', userId],
      ['deviceId', deviceId],
    ] as const) {
      if (isUnresolvedIdentity(value)) {
        this.logger.warn(
          `[${tag}] REFUSED group=${groupId} device=${userId}:${deviceId} ` +
            `reason=unresolved_identity field=${field} value=${value}`
        );
        return { ok: false, reason: 'unresolved_identity' };
      }
    }

    // A revoked or key-package-less device must never be routed to (WP-GHOST-1). This path is
    // reached by the commit fan-out - where the device activating itself is the COMMIT SENDER, so
    // without this a device its owner explicitly deleted would re-enrol itself in every group it
    // still holds MLS state for - by the background push path, by the foreground status endpoint
    // and by group creation.
    const addressable = await this.deviceAddressability(userId, deviceId);
    if (!addressable.ok) {
      this.logger.warn(
        `[${tag}] REFUSED group=${groupId} device=${userId}:${deviceId} reason=${addressable.reason}`
      );
      return { ok: false, reason: addressable.reason };
    }

    if (authority === 'report') return this.promoteReportedSeat(userId, deviceId, groupId, tag);

    // The group's creation needs no claim - nobody can evict from a group nobody else knows yet -
    // but its seat is an INSERT like any other, so it is written under the seat lock beside its key
    // package ({@link writeClaimedSeat}): created while its account is erased, it gets no seat.
    if (authority === 'group_creator') {
      const refused = await withSeatLock(this.groupRepo.manager, groupId, (m) =>
        this.writeClaimedSeat(m, userId, deviceId, groupId, tag)
      );
      if (refused !== null) return { ok: false, reason: refused };
      await this.routeActiveSeat(userId, deviceId, groupId, tag);
      return { ok: true };
    }

    // A CLAIMED AUTHORITY WITH NO CLAIM IS A CALLER BUG, refused loudly rather than written: the
    // seat would stand against no eviction at all.
    if (!claim || claim.groupId !== groupId || claim.userId !== userId) {
      this.logger.error(
        `[${tag}] REFUSED group=${groupId} device=${userId}:${deviceId} reason=unclaimed authority=${authority}`
      );
      return { ok: false, reason: 'departed' };
    }
    const outcome = await withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      const overtaken = await seatClaimHolds(m, claim);
      if (overtaken) {
        this.logger.warn(
          `[${tag}] REFUSED group=${groupId} device=${userId}:${deviceId} reason=departed ` +
            `(${overtaken}, claimed at generation ${claim.generation})`
        );
        return { ok: false, reason: 'departed' } as const;
      }
      const refused = await this.writeClaimedSeat(m, userId, deviceId, groupId, tag);
      return refused === null ? ({ ok: true } as const) : ({ ok: false, reason: refused } as const);
    });
    if (outcome.ok) await this.routeActiveSeat(userId, deviceId, groupId, tag);
    return outcome;
  }

  /**
   * Writes the active seat of a claim that held, in the transaction `m` holding the group's seat
   * lock - IF the device still has its KeyPackage row, read `FOR SHARE` here ({@link heldKeyPackages},
   * which says why). Read before the lock ({@link deviceAddressability}) it could not decide that: a
   * device with no trace in the group yet, whose seat the erasure has nothing to cut, would get one
   * after it.
   *
   * The revocation denylist is read here too (WP-GHOST-1): a commit writes its committer's seat
   * through this alone, with no {@link deviceAddressability} before it.
   *
   * @returns null when the seat was written; otherwise why not (logged).
   */
  private async writeClaimedSeat(
    m: EntityManager,
    userId: string,
    deviceId: string,
    groupId: string,
    tag: string
  ): Promise<null | 'revoked' | 'no_key_package'> {
    const revoked = await m.getRepository(RevokedDevice).findOne({
      where: activeRevocationWhere({ userId, deviceId }),
    });
    if (revoked) {
      this.logger.warn(
        `[${tag}] REFUSED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} reason=revoked`
      );
      return 'revoked';
    }
    if (!(await heldKeyPackages(m, [{ userId, deviceId }])).has(`${userId}:${deviceId}`)) {
      this.logger.warn(
        `[${tag}] REFUSED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
          `reason=no_key_package (read under the seat lock - the account or device is being erased)`
      );
      return 'no_key_package';
    }
    await this.writeActiveSeat(
      m.getRepository(DeviceGroupMembership),
      userId,
      deviceId,
      groupId,
      tag
    );
    return null;
  }

  /**
   * Adds a seat's Redis route - AFTER the seat's own write committed, and only if the seat is still
   * `active`, re-read under the seat lock.
   *
   * WHY NOT WITH THE WRITE. The route written inside the seat's transaction would survive that
   * transaction failing to commit; written after the commit with no lock, it could land after an
   * eviction deleted the seat and removed its route. The gateway reads this set alone - its live
   * broadcast and its election of a peer to answer a request re-check nothing in the database - so
   * a route left for a seat that is gone is a device still reached. Under the lock, an eviction is
   * wholly before this (the seat is gone, no route) or wholly after (it removes the route).
   */
  private async routeActiveSeat(
    userId: string,
    deviceId: string,
    groupId: string,
    tag: string
  ): Promise<void> {
    await withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      const seat = await m.getRepository(DeviceGroupMembership).findOne({
        where: { userId, deviceId, groupId, status: 'active' as const },
        select: { deviceId: true },
      });
      if (!seat) {
        this.logger.warn(
          `[${tag}] route NOT written group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} - the seat was evicted after its write`
        );
        return;
      }
      await this.redis
        .sadd(`group:members:${groupId}`, `${userId}:${deviceId}`)
        .catch((e) =>
          this.logger.error(
            `[${tag}] route write FAILED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)}: ${String(e)} - the send path's reconciliation repairs it`
          )
        );
    });
  }

  /**
   * Writes the `active` seat - the write itself, for {@link activateDeviceMembership} only, which
   * decides whether it may happen. Its Redis route follows the commit ({@link routeActiveSeat}).
   */
  private async writeActiveSeat(
    seats: Repository<DeviceGroupMembership>,
    userId: string,
    deviceId: string,
    groupId: string,
    tag: string
  ): Promise<void> {
    // `kickedAt: null`: the device is IN, so nothing is owed to it and no kick is outstanding.
    // `admittedAtEpoch: null`: its status routes it from here on, so its admission has done its job.
    await seats.upsert(
      {
        userId,
        deviceId,
        groupId,
        status: 'active' as const,
        kickedAt: null,
        admittedAtEpoch: null,
      },
      { conflictPaths: ['deviceId', 'groupId'] }
    );
    this.logger.log(`[${tag}] group=${groupId} device=${userId}:${deviceId}`);
  }

  /**
   * THE ONE WRITER OF `pending`, AND THE ONE THING THAT REMOVES FROM THE REDIS ROUTING SET.
   *
   * The mirror of {@link activateDeviceMembership}, and it was NOT one until 2026-09-13. Four paths
   * performed the `-> pending` transition and they split on the one thing that has a consequence:
   *
   * | Path | Redis SREM | `kickedAt` | Inserts if absent |
   * | --- | --- | --- | --- |
   * | `kickStaleDevice` | written | set | no |
   * | `kickStaleUser` | **never written** | set | no |
   * | `detectStaleDevices` (cron) | written | left as is | no |
   * | `updateInvitationStatus` demotion | **never written** | left as is | yes |
   *
   * THE TWO MISSING SREMS ARE NOT A RACE THAT HEALS. Nothing in this service ever removes an extra
   * entry from `group:members:{groupId}`: the SEND reconciliation only `sadd`s the rows it finds
   * active, so an entry naming a device that is no longer active survives every message the group
   * sends. The gateway ELECTS the answerer of a `welcome_request` and a `history_request` from that
   * set, so `kickStaleUser` - whose whole purpose is that a member just removed those leaves from
   * the tree - left every one of them electable to serve a Welcome for a group they can no longer
   * open. It is silent, because a routing set that is merely TOO LARGE is not empty and no election
   * door reloads it, and it lasts until `cleanupStalePendingInvitations` deletes the row: up to
   * `STALE_PENDING_INVITATION_MS` (`retention.constants.ts`), fourteen days.
   *
   * `kickedAt` IS NOT PART OF THAT DIVERGENCE, and the audit was wrong to list it. The column
   * answers one question - *is this row waiting on a re-add that a kick promised?* - and each of the
   * four writes it the way that question requires: the kicks set it because a member removed the
   * leaf and owes an Add, the cron and the self-reported demotion leave it because nobody removed
   * anything and nothing is owed. So it is not fused away, it is made EXPLICIT: `removedFromTreeAt`
   * is required, every caller answers it, and no caller can be silent by omission the way
   * `kickStaleUser` was silent about the SREM.
   *
   * `removedFromTreeAt` is the instant a member removed this device's leaf, or `null` when none
   * did. `null` LEAVES THE COLUMN AS IT STANDS - it never clears it, because a demotion promises no
   * Add and a row demoted after a kick is still a row a kick left behind. Clearing is the
   * promotion's job and {@link activateDeviceMembership} is where it happens. Callers demoting a
   * batch of devices reset by ONE Remove commit pass ONE instant for the whole batch, which is why
   * this takes a `Date` rather than reading the clock itself.
   *
   * NOTHING PRESENT IS REFUSED HERE, and the asymmetry with the promotion is deliberate: a demotion
   * of a seat must always remain possible. It grants no reachability, promises no Add, and moves the
   * row towards cleanup rather than away from it.
   *
   * BUT A DEMOTION NEVER CREATES A SEAT (2026-10-25): seats are created only by the writers that
   * check membership (docs/wiki/protocols/mls-graine-state-machine.md, "Seat writes check
   * membership"). Every caller demotes a row it read (the kicks, the stale-device cron) or its own
   * device's seat (the status route), so an absent row was deleted in between - a departure, a
   * removal or an erasure - and stays deleted. One conditional UPDATE: a row deleted first is not
   * matched, and nothing is written.
   *
   * A CALLER THAT READ THE ROW NAMES IT (`seatId`), and only that row is demoted: a seat deleted
   * and written again since the read is another seat - a new admission, whose `admittedAtEpoch`
   * this must not clear nor stamp a kick on that no commit answered.
   *
   * @returns whether a seat was demoted; `false` when there is no such row (logged here, under the
   *   caller's tag), which the status route answers as the `no_seat` refusal.
   */
  async deactivateDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string,
    {
      removedFromTreeAt,
      seatId,
      tag = 'MEMBERSHIP_PENDING',
    }: {
      removedFromTreeAt: Date | null;
      /** The `id` of the row the caller read, when it read one. */
      seatId?: string;
      tag?: string;
    }
  ): Promise<boolean> {
    // A placeholder names no device, so it names no seat: demoting it grants nothing and costs
    // nothing, which is why this is a refusal and not a throw - no caller of this best-effort path
    // has a user to tell.
    for (const [field, value] of [
      ['userId', userId],
      ['deviceId', deviceId],
    ] as const) {
      if (isUnresolvedIdentity(value)) {
        this.logger.warn(
          `[${tag}] REFUSED group=${groupId} device=${userId}:${deviceId} ` +
            `reason=${field} is the client's unresolved-identity placeholder ('${value}')`
        );
        return false;
      }
    }

    // `kickedAt` is in the written columns ONLY when a kick is being recorded: omitting it is what
    // leaves an existing value alone. Spelling `kickedAt: null` here would erase the evidence of a
    // kick on every cron demotion, which is the opposite of what the column is for.
    //
    // `pendingSince` IS ALWAYS WRITTEN. It is the instant this row entered `pending`, which is
    // exactly now - a demotion restarts the wait, so it restarts the clock the purge and the hourly
    // report read. That is the fresh grace window `cleanupStalePendingInvitations` always meant a
    // demoted device to have, and could not give it: it was reading `updatedAt`, which somebody
    // else's write moves.
    const demoted = await this.deviceGroupRepo.update(
      seatId ? { id: seatId, userId, deviceId, groupId } : { userId, deviceId, groupId },
      {
        status: 'pending' as const,
        pendingSince: new Date(),
        // A demoted device needs a NEW Welcome before it can read anything, so no earlier
        // admission may keep it a recipient (see `DeviceGroupMembership.admittedAtEpoch`).
        admittedAtEpoch: null,
        ...(removedFromTreeAt ? { kickedAt: removedFromTreeAt } : {}),
      }
    );

    // UNCONDITIONAL, and that is the whole fusion: the row now says the device cannot decrypt this
    // group - or there is no row - so the gateway must stop routing to it and stop electing it.
    // A failure is logged, never swallowed: the route it leaves keeps the device routable and
    // electable, and an account erasure later meets it as a route no seat stands behind.
    await this.redis
      .srem(`group:members:${groupId}`, `${userId}:${deviceId}`)
      .catch((e: unknown) =>
        this.logger.warn(
          `[${tag}] route NOT removed group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
            `- the device stays routable until a later removal: ${String(e)}`
        )
      );

    if ((demoted.affected ?? 0) === 0) {
      this.logger.warn(
        `[${tag}] NOT DEMOTED group=${groupId} device=${cutUserId(userId)}:${cutDeviceId(deviceId)} ` +
          `reason=no_seat - no row${seatId ? ` (the row read, id=${seatId.slice(0, 8)})` : ''}; a demotion never creates a seat`
      );
      return false;
    }
    this.logger.log(
      `[${tag}] group=${groupId} device=${userId}:${deviceId}` +
        `${removedFromTreeAt ? ' kicked' : ''}`
    );
    return true;
  }

  /**
   * Asks one online member to resend the history bundle to a device that self-joined `groupId` via
   * an external commit (Phase 4). Unlike a welcome_request the requester is already a healthy member,
   * so the responder only resends history (no re-add). Online-only and best-effort: if no member is
   * online the joiner simply retries later - missing pre-join history is not urgent, so there is no
   * durable FCM wake.
   */
  /**
   * The devices this group can route to, reading the CACHE and reloading it from the TRUTH.
   *
   * `group:members:<id>` is a Redis set the gateway routes on; `device_group_memberships` is what
   * actually says who is in the group. The set is empty after a restart or a flush while the group
   * is full of people, and an election run off it reports `no_peer_online` about a conversation
   * nobody has left - so an empty set is re-read from the rows and written back.
   *
   * THREE DOORS NEEDED THIS AND EACH CARRIED ITS OWN COPY - history, base refresh and welcome, the
   * same eleven lines three times, differing only in whether they said anything. Two were silent,
   * which is how a Redis losing every routing set could repopulate itself twice with no line
   * anywhere. A cache miss costing a table scan and rewriting shared routing state is the visible
   * end of something upstream, so it ACCUSES, under the caller's own tag so the line says which
   * door paid for it.
   *
   * An empty TABLE is not a miss and writes nothing: there is no evidence the cache is wrong, and
   * `sadd` with no members is an error rather than a no-op.
   *
   * The `SEND` path's repair is deliberately NOT this: it reconciles a populated set against the
   * LIVE members and adds what is missing, which answers a different question.
   */
  private async routableMembers(groupId: string, traceId: string, tag: string): Promise<string[]> {
    const cached = await this.redis.smembers(`group:members:${groupId}`);
    if (cached.length > 0) return cached;

    const rows = await this.deviceGroupRepo.find({
      where: { groupId, status: 'active' as const },
    });
    if (rows.length === 0) return cached;

    // Written under the seat lock against a re-read, like every route: a seat evicted since the
    // read above is not routed again (`restoreRoutes`).
    const { restored, gone } = await this.restoreRoutes(groupId, rows);
    this.logger.warn(
      `[${tag}][${traceId}] MEMBERS_CACHE_RELOADED group=${groupId} members=${restored.length}` +
        (gone.length > 0 ? ` evictedSinceRead=${gone.length}` : '') +
        ` - the gateway routing set was empty for a group with active devices, so it was rebuilt` +
        ` from the rows; anything routed on it before this point reached nobody`
    );
    return restored;
  }

  /**
   * Adds to `groupId`'s routing set those of `candidates` whose seat is still ACTIVE when re-read
   * under the seat lock.
   *
   * The routing set is what the gateway delivers on, and an eviction deletes a seat and its route
   * under that lock. A route written from a read taken BEFORE the lock could put back the route of a
   * seat evicted in between, and nothing would ever take it out again: the gateway reads the set
   * alone. So the re-read and the write happen while no eviction can run.
   *
   * @returns the entries written, and the candidates whose seat was gone
   */
  private async restoreRoutes(
    groupId: string,
    candidates: ReadonlyArray<{ userId: string; deviceId: string }>
  ): Promise<{ restored: string[]; gone: string[] }> {
    const wanted = candidates.map((c) => `${c.userId}:${c.deviceId}`);
    return withSeatLock(this.groupRepo.manager, groupId, async (m) => {
      const rows = await m.getRepository(DeviceGroupMembership).find({
        where: {
          groupId,
          status: 'active' as const,
          deviceId: In([...new Set(candidates.map((c) => c.deviceId))]),
        },
      });
      const active = new Set(rows.map((r) => `${r.userId}:${r.deviceId}`));
      const restored = wanted.filter((k) => active.has(k));
      const gone = wanted.filter((k) => !active.has(k));
      if (restored.length > 0) {
        await this.redis.sadd(`group:members:${groupId}`, ...restored);
      }
      return { restored, gone };
    });
  }

  async notifyHistoryRequest(
    authUserIdRaw: string | undefined,
    body: NotifyHistoryRequestBody
  ): Promise<{ status: string; target?: string; excludedOnline?: number }> {
    const traceId = this.makeTraceId('history-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(body.requesterUserId, 'requesterUserId');
    const requesterDeviceId = sanitizeQueryValue(body.requesterDeviceId, 'requesterDeviceId');
    this.assertRequesterMatchesCaller(authUserIdRaw, requesterUserId, traceId, 'HISTORY_REQ');

    // Members this requester has already heard from. Compared case-insensitively because the client
    // builds the key from its MLS identity (`digestIdentity`, which lower-cases the user) while the
    // membership set is stored as it was written - two spellings of one fact, and a mismatch here
    // would silently re-elect the member the requester just excluded.
    const rawExclude = (Array.isArray(body.exclude) ? body.exclude : []).filter(
      (k): k is string =>
        typeof k === 'string' && k.includes(':') && k.length <= MAX_MEMBER_KEY_LENGTH
    );
    // A KEY DROPPED HERE IS AN EXCLUSION THE CALLER BELIEVES IT MADE, so it is said rather than
    // filtered in silence - that silence is what let a 128-character cap discard every real member
    // key for months without one line anywhere saying so.
    const rawGiven = Array.isArray(body.exclude) ? body.exclude.length : 0;
    if (rawGiven > rawExclude.length) {
      this.logger.warn(
        `[HISTORY_REQ][${traceId}] ${rawGiven - rawExclude.length} exclusion(s) were unusable and dropped group=${groupId} requester=${requesterUserId}:${requesterDeviceId}`
      );
    }
    if (rawExclude.length > MAX_HISTORY_EXCLUSIONS) {
      // A chase excludes at most one member per step, so a list longer than any group's membership
      // is a client fault rather than a big conversation. Truncating silently would turn it into a
      // member elected twice and a chase that looks like it terminated on a proof it never had.
      this.logger.warn(
        `[HISTORY_REQ][${traceId}] exclude list truncated ${rawExclude.length} -> ${MAX_HISTORY_EXCLUSIONS} group=${groupId} requester=${requesterUserId}:${requesterDeviceId}`
      );
    }
    const excluded = new Set(
      rawExclude.slice(0, MAX_HISTORY_EXCLUSIONS).map((k) => k.toLowerCase())
    );

    const members = await this.routableMembers(groupId, traceId, 'HISTORY_REQ');
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;

    // The election and nothing else. WHAT the requester wants - a state key, a digest, a range of
    // older messages - travels inside MLS, where this service cannot read it, and the responder
    // waits for that frame rather than being told anything about it here. A `withDigest` boolean
    // used to ride along, to tell the responder whether waiting was pointless; every client states
    // its ask now, so waiting is always warranted and the flag said nothing.
    const notification = JSON.stringify({
      type: 'history_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    // Forward to a RANDOM online member rather than always the first. A backgrounded Android holds
    // its WebSocket TCP open, so `user:online` can be true while the app cannot process the frame
    // (frozen-online). The requester re-solicits on a bounded backoff; randomizing the responder
    // each call lets those retries rotate past a frozen peer to a genuinely reachable one.
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    // How many members were ONLINE and skipped only because the requester had already heard from
    // them. It is the whole point of the exclusion list: `no_peer_online` with a positive count
    // means *every reachable member has answered you*, which is the requester's termination proof,
    // and `no_peer_online` with zero means *nobody was there*, which is a different fact answered by
    // a different edge. A count rather than a second status, so the two are told apart by evidence
    // and not by prose.
    let excludedOnline = 0;

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) continue;
      const isOnline = await this.redis.exists(devicePresenceKey(memberUserId, memberDeviceId));
      if (isOnline && excluded.has(member.toLowerCase())) {
        excludedOnline++;
        continue;
      }
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            // isWelcomeRequest is the gateway's generic "relay this base64 JSON control frame to the
            // device" flag; the inner `type` (history_request) drives the client behaviour.
            proto: Buffer.from(notification).toString('base64'),
            isWelcomeRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          })
        );
        this.logger.log(
          `[HISTORY_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`
        );
        return { status: 'forwarded', target: member };
      }
    }
    this.logger.log(
      `[HISTORY_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} excludedOnline=${excludedOnline}`
    );
    return { status: 'no_peer_online', excludedOnline };
  }

  /**
   * Tells a device, right now, that it has been revoked - so it wipes itself and signs out instead
   * of staying live until its next authentication.
   *
   * Deleting a device denylists it and purges its server-side footprint, but a device that is
   * ALREADY connected notices none of that: its socket stays open, its session stays valid, and
   * everything it still holds locally stays on it. For a device its owner has declared lost or
   * stolen, "it will find out next time it logs in" is the wrong answer to the question they asked.
   *
   * Sent over the gateway's generic control-frame path (`isWelcomeRequest` is that flag's name, and
   * the inner `type` is what drives the client), so this needs no change in the gateway at all.
   *
   * BEST-EFFORT, and deliberately not awaited into the delete's own result: the durable half of a
   * revocation is the denylist row, which is already written. This only makes it immediate. It is
   * still logged either way, because a signal nobody sees and nobody reports is indistinguishable
   * from one that was never sent.
   */
  async notifyDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
    const notification = JSON.stringify({
      type: 'device_revoked',
      userId,
      deviceId,
    });
    try {
      const receivers = await this.redis.publish(
        'chat:messages',
        JSON.stringify({
          recipientId: userId,
          deviceId,
          proto: Buffer.from(notification).toString('base64'),
          isWelcomeRequest: true,
          senderId: userId,
          senderDeviceId: deviceId,
        })
      );
      this.logger.log(
        `[DEVICE_REVOKED] signalled user=${userId} device=${deviceId} gatewaySubscribers=${receivers}`
      );
      return true;
    } catch (e) {
      this.logger.error(
        `[DEVICE_REVOKED] could not signal user=${userId} device=${deviceId} - it will find out at its next login`,
        e
      );
      return false;
    }
  }

  /**
   * Asks one online member to REPUBLISH this group's external-join base, and asks for nothing else.
   *
   * WHY A SIGNAL OF ITS OWN, AND NOT THE WELCOME REQUEST NEXT DOOR. A device that cannot join a
   * group by external commit has two very different problems, and until 2026-09-04 both were
   * answered with `welcome_request`:
   *
   *  - **no base is published** - only a member can mint one, and a Welcome is a fine way to be let
   *    in;
   *  - **the published base is STALE** - it names an epoch the group has left, so `join_by_external_commit`
   *    refuses it and NO retry can ever change that. Asking for a Welcome here is asking for the
   *    wrong favour: a Welcome MUTATES the tree, takes the group's add lock, and replays the
   *    duplicate-leaf race, when what is needed is a read-only publish that changes no epoch and
   *    takes no lock.
   *
   * **THE POPULATION IS REAL AND IT DOES NOT DRAIN ITSELF.** Measured on production 2026-09-04:
   * four of the forty-three groups holding a base were stale, every one of them by exactly ONE
   * epoch, two of them since 2026-08-30 - and three devices sat `pending` on those two, unable to
   * join for five days. A stale base is not a transient: only a member's next commit republishes
   * one, so a quiet conversation stays shut for ever.
   *
   * The election is the history request's, for the history request's reason: a backgrounded Android
   * holds its socket open, so `user:online` can be true for a device that will not process the
   * frame. Randomising lets the requester's retries rotate past it.
   *
   * **NOTHING IS STORED FOR AN OFFLINE MEMBER**, deliberately - unlike `welcome_request`, which
   * queues in `pending_welcome:` so a newly-online peer drains it. A base refresh is idempotent and
   * cheap, the requester re-asks on its own cadence as long as it still cannot join, and a queue of
   * requests to republish something that may already have been republished is a queue that says
   * nothing. `no_peer_online` is the honest answer, and it is the one this returns.
   */
  async notifyBaseRefreshRequest(
    authUserIdRaw: string | undefined,
    body: NotifyWelcomeRequestBody
  ): Promise<{ status: string; target?: string; facts?: NoHolderFacts }> {
    const traceId = this.makeTraceId('base-refresh');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(body.requesterUserId, 'requesterUserId');
    const requesterDeviceId = sanitizeQueryValue(body.requesterDeviceId, 'requesterDeviceId');
    this.assertRequesterMatchesCaller(authUserIdRaw, requesterUserId, traceId, 'BASE_REFRESH');

    const members = await this.routableMembers(groupId, traceId, 'BASE_REFRESH');
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;

    const notification = JSON.stringify({
      type: 'base_refresh_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) continue;
      if (!(await this.redis.exists(devicePresenceKey(memberUserId, memberDeviceId)))) continue;
      await this.redis.publish(
        'chat:messages',
        JSON.stringify({
          recipientId: memberUserId,
          deviceId: memberDeviceId,
          // `isWelcomeRequest` is the gateway's generic "relay this base64 JSON control frame"
          // flag; the inner `type` is what drives the client.
          proto: Buffer.from(notification).toString('base64'),
          isWelcomeRequest: true,
          groupId,
          senderId: requesterUserId,
          senderDeviceId: requesterDeviceId,
        })
      );
      this.logger.log(
        `[BASE_REFRESH][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`
      );
      return { status: 'forwarded', target: member };
    }

    // AT A LEVEL THAT ACCUSES, because this is a group nobody can enter right now. Its rate is what
    // says whether a stale base is a moment or a state.
    this.logger.warn(
      `[BASE_REFRESH][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} members=${members.length}` +
        ` - the published base stays stale and no device can external-join until a member returns`
    );
    // A base refresh never stores, queues or wakes anything (above): `wakeSent` is false by
    // construction.
    const facts = await this.noHolderFacts(
      groupId,
      requesterUserId,
      requesterDeviceId,
      traceId,
      false
    );
    return { status: 'no_peer_online', ...(facts ? { facts } : {}) };
  }

  /**
   * Broadcasts a welcome_request signal to one online group member to trigger
   * a re-invite for the requesting device.  Falls back to the DB to repopulate
   * the Redis routing cache when the set is empty after a service restart.
   */
  async notifyWelcomeRequest(
    authUserIdRaw: string | undefined,
    body: NotifyWelcomeRequestBody
  ): Promise<{ status: string; target?: string; facts?: NoHolderFacts }> {
    const traceId = this.makeTraceId('welcome-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(body.requesterUserId, 'requesterUserId');
    const requesterDeviceId = sanitizeQueryValue(body.requesterDeviceId, 'requesterDeviceId');
    this.assertRequesterMatchesCaller(authUserIdRaw, requesterUserId, traceId, 'WELCOME_REQ');

    // Atomically pick one online group member that is not the requester.
    // Using a single server-side selection avoids the multi-connection race that
    // occurs when the gateway forwards the WS frame: each concurrent connection
    // from the requester's device would call forward_to_one_peer independently,
    // and since SMEMBERS returns an unordered set each call can pick a different
    // peer, causing multiple devices to concurrently commit an add for the same
    // invitation.
    const members = await this.routableMembers(groupId, traceId, 'WELCOME_REQ');
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;
    // AN ASK OF A SEAT AWAITING A MEMBER is relayed exactly as before, and said only at its 1st,
    // 10th, 100th... repeat for this device ({@link awaitingAskRepeats}): every line below is the
    // same sentence on every cadence of a wait that may last the 14 days of the ask.
    const awaitingAsk =
      (await this.rosterSeat(groupId, requesterUserId))?.awaitingAdmission === true;
    const nth = awaitingAsk ? this.awaitingAskRepeats.hit(`ask|${groupId}|${senderKey}`) : 1;
    const say = (line: string) => {
      if (nth !== null) this.logger.log(line);
    };

    say(
      `[WELCOME_REQ][${traceId}] START group=${groupId} requester=${senderKey} members=${members.length}` +
        (awaitingAsk ? ` ask=awaiting-member repeat=${nth} (said at 1, 10, 100...)` : '')
    );

    const notification = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) {
        this.logger.warn(
          `[WELCOME_REQ][${traceId}] Malformed group member entry='${member}' group=${groupId}`
        );
        continue;
      }
      const onlineKey = devicePresenceKey(memberUserId, memberDeviceId);
      const isOnline = await this.redis.exists(onlineKey);
      say(`[WELCOME_REQ][${traceId}] Candidate=${member} online=${!!isOnline}`);
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            // Re-use the proto field as a JSON-encoded control payload so the
            // gateway can relay it as a plain text WS frame without extra decoding.
            proto: Buffer.from(notification).toString('base64'),
            isWelcomeRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          })
        );
        say(
          `[WELCOME_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`
        );

        // Drain any welcome_requests that were stored while no peer was online,
        // so this newly-online peer handles all pending invitees in one pass.
        const pendingSetKey = `pending_welcome:${groupId}`;
        const stored: string[] = await this.redis.smembers(pendingSetKey);
        let drained = 0;
        for (const storedKey of stored) {
          if (storedKey === senderKey) continue; // already forwarded above
          const [storedUserId, storedDeviceId] = storedKey.split(':');
          if (!storedUserId || !storedDeviceId) continue;
          await this.redis.publish(
            'chat:messages',
            JSON.stringify({
              recipientId: memberUserId,
              deviceId: memberDeviceId,
              proto: Buffer.from(
                JSON.stringify({
                  type: 'welcome_request',
                  groupId,
                  requesterUserId: storedUserId,
                  requesterDeviceId: storedDeviceId,
                })
              ).toString('base64'),
              isWelcomeRequest: true,
              groupId,
              senderId: storedUserId,
              senderDeviceId: storedDeviceId,
            })
          );
          drained++;
        }
        if (stored.length > 0) {
          await this.redis.del(pendingSetKey);
          say(
            `[WELCOME_REQ][${traceId}] Drained ${drained} stored welcome_request(s) for group=${groupId}`
          );
        }

        return { status: 'forwarded', target: member };
      }
    }

    // A FURTHER DEVICE THAT WILL JOIN BY ITSELF (`selfJoinIfNobody`, D1): nothing is stored, queued
    // or woken - an Android member's background Add answering the wake would be a second door racing
    // the device's own commit - and an ask an EARLIER pass stored is withdrawn, so no member's next
    // connection replays it either. One door per answer. Not for an ask awaiting a member (D4), and
    // ONLY ON A CURRENT BASE: on a stale or absent one the device cannot let itself in, so the member's
    // Add stays its one door and the ask is stored and woken as any other.
    if (
      body.selfJoinIfNobody === true &&
      this.furtherDeviceSelfJoinOpen &&
      !awaitingAsk &&
      (await this.baseIsCurrent(groupId, traceId))
    ) {
      await this.withdrawStoredWelcomeRequest(groupId, senderKey, members, traceId);
      say(
        `[WELCOME_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} - a further device that joins by itself: nothing stored, nothing woken`
      );
      const facts = await this.noHolderFacts(
        groupId,
        requesterUserId,
        requesterDeviceId,
        traceId,
        false
      );
      return { status: 'no_peer_online', ...(facts ? { facts } : {}) };
    }

    // No peer online - persist so the request is replayed when a peer connects.
    const pendingSetKey = `pending_welcome:${groupId}`;
    const pipeline = this.redis.pipeline();
    pipeline.sadd(pendingSetKey, senderKey);
    pipeline.expire(pendingSetKey, 86400); // 24 h TTL
    await pipeline.exec();

    // Also store per-member in pending_welcome_notify:{userId} so the Gateway can drain
    // signals as soon as a member reconnects, without waiting for the next welcome_request.
    // The format is the JSON that the Gateway will send directly to the WebSocket client.
    const notificationFrame = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });
    const uniqueMemberUserIds = [
      ...new Set(
        members
          .filter((m) => m !== senderKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean)
      ),
    ];
    if (uniqueMemberUserIds.length > 0) {
      const notifyPipeline = this.redis.pipeline();
      for (const memberUserId of uniqueMemberUserIds) {
        const notifyKey = `pending_welcome_notify:${memberUserId}`;
        notifyPipeline.rpush(notifyKey, notificationFrame);
        notifyPipeline.expire(notifyKey, 86400); // same 24 h TTL
      }
      await notifyPipeline.exec();
    }

    // Wake up offline peers via FCM so they reconnect and drain the pending request
    // without waiting for an organic reconnection.
    //
    // NOT FOR AN ASK OF A SEAT AWAITING A MEMBER (2026-10-31): the only thing that wake does is let
    // a shut Android phone answer the request by itself (`welcome_request_pending`, the background
    // Welcome), and a push never answers an ask - the route and the gate refuse it
    // (`awaiting_admission`). Sending it would only spend a lock, a key package and a refusal per
    // member's phone on every re-ask, to learn by failing what this seat already says. The stored
    // frames above still reach every member's app when it opens, where the ask is a member's gesture.
    if (awaitingAsk) {
      say(
        `[WELCOME_REQ][${traceId}] no background wake for group=${groupId} requester=${senderKey} - an ask is answered only by a member's app`
      );
    } else {
      await this.sendFcmWelcomeRequestPending(groupId, members, senderKey, traceId);
    }

    say(
      `[WELCOME_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} - stored in Redis` +
        (awaitingAsk ? ', no FCM wake (an ask awaits a member)' : ', FCM sent to peers')
    );
    const facts = await this.noHolderFacts(
      groupId,
      requesterUserId,
      requesterDeviceId,
      traceId,
      !awaitingAsk
    );
    return { status: 'no_peer_online', ...(facts ? { facts } : {}) };
  }

  /**
   * Whether `groupId`'s stored base is at the group's epoch - the base a further device lets itself in
   * on (D1). An unreadable base is not current: the stored ask stays the door.
   */
  private async baseIsCurrent(groupId: string, traceId: string): Promise<boolean> {
    try {
      const base = await this.readGroupInfo(groupId);
      return base !== null && base.baseEpoch >= base.activeEpoch;
    } catch (e) {
      this.logger.warn(
        `[WELCOME_REQ][${traceId}] base of group=${groupId} unreadable - a further device's ask is stored as any other: ${String(e)}`
      );
      return false;
    }
  }

  /**
   * Withdraws a `welcome_request` an earlier pass stored for `senderKey`: its entry in
   * `pending_welcome:{groupId}` and the frame queued for each member in
   * `pending_welcome_notify:{userId}` (the frame is the same deterministic JSON, so `LREM` finds it).
   * Best-effort and logged: what it misses is a stale ask a member's device answers with an Add the
   * gate refuses for a seat already active.
   */
  private async withdrawStoredWelcomeRequest(
    groupId: string,
    senderKey: string,
    members: string[],
    traceId: string
  ): Promise<void> {
    const [requesterUserId, requesterDeviceId] = senderKey.split(':');
    const frame = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });
    try {
      const pipeline = this.redis.pipeline();
      pipeline.srem(`pending_welcome:${groupId}`, senderKey);
      for (const memberUserId of new Set(
        members
          .filter((m) => m !== senderKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean)
      )) {
        pipeline.lrem(`pending_welcome_notify:${memberUserId}`, 0, frame);
      }
      await pipeline.exec();
    } catch (e) {
      this.logger.warn(
        `[WELCOME_REQ][${traceId}] a stored ask of ${senderKey} for group=${groupId} could not be withdrawn: ${String(e)}`
      );
    }
  }

  /**
   * Writes the queue rows for one send, refusing if the group stopped being a destination while the
   * send was in flight.
   *
   * THIS IS THE OVERLAP DELETED, NOT A REPAIR OF IT. `sendMessage` resolves its recipients from the
   * membership table and then saves, and `deleteGroup` writes the tombstone and sweeps everything
   * the group owns - including its queue - in one transaction. Nothing ordered the two, so a send
   * that read its recipients BEFORE the sweep and saved AFTER it wrote rows into a queue that had
   * just been emptied, for a group that no longer exists. Measured on the local estate 2026-09-05:
   *
   *     [SEND][send-bc9c9815] START group=7e931024...
   *     [DELETE_GROUP] 7e931024... soft-deleted, 14 row(s) purged: {"queuedMessages":4,...}
   *     [SEND][send-bc9c9815] QUEUED count=2
   *
   * Nine milliseconds, and the two rows are permanent: no device can decrypt or ACK a frame for a
   * tombstoned group, so `fetchMessages` drops them on every connection and nothing consumes them
   * before the 90-day reaper. Twenty `dropped 1 undeliverable message(s)` warnings in one
   * thirty-minute window came from those two rows. A race that heals cleanly is still a defect, and
   * this one does not heal - the drop filter is the witness, never the fix.
   *
   * THE SHARED ROW LOCK IS WHAT ORDERS THEM, and it orders them in both directions:
   *
   *   - The delete got there first: it holds the row exclusively (its own `UPDATE`), so this read
   *     BLOCKS until it commits and then sees `deletedAt` - the send is refused and writes nothing.
   *   - This send got there first: it holds the row shared, so the delete's `UPDATE` waits for this
   *     transaction to commit, and its sweep - which runs after that `UPDATE`, in the same
   *     transaction - then sees these rows and takes them with the group.
   *
   * There is no third interleaving, and no window in between: the liveness and the write are one
   * transaction, so no fact this reads can go stale before it is acted on. Both parties take
   * `dm_groups` first and in the same order, so the pair cannot deadlock, and `FOR SHARE` is
   * compatible with itself, so concurrent sends into the same group do not serialise.
   *
   * THE CLIENT ALREADY ASKS, AND THAT IS EXACTLY WHY THIS IS OWED HERE. `flushOne` reads
   * `getGroupMeta().deletedAt` and refuses before it sends - the trace above even carries its
   * `[GET_GROUP] found=true` one line before the START. A fact checked over a round trip is a fact
   * that can go stale inside it; only the writer can make the check and the write atomic.
   *
   * Refused rather than silently skipped: the sender is told its message is never going out, which
   * the outbox turns into a permanent failure rather than a ladder that spins. A send with no
   * `groupId` addresses no group and has nothing to check.
   */
  private async enqueueForLiveGroup(
    rows: QueuedMessage[],
    groupId: string | undefined,
    tag: string,
    traceId: string,
    sealed?: SealedFrame,
    opts: { seats?: { exempt: ReadonlySet<string> }; welcome?: WelcomeSeat } = {}
  ): Promise<QueuedMessage[]> {
    const { seats, welcome } = opts;
    if (!groupId) return this.queuedMessageRepo.save(rows);
    const stored = await this.queuedMessageRepo.manager.transaction(async (manager) => {
      // THE SEAT LOCK, SHARED, BEFORE THE GROUP ROW - the order every seat writer takes them in. The
      // recipients were read with no lock, so an eviction may have deleted a seat and its queued
      // frames since; holding the lock shared, no eviction runs until these rows are written, and the
      // re-read below drops a seat already gone. Sends into one group never wait for each other.
      // The Welcome store and the key-group eviction take the same seat lock: the target's seat is
      // re-read under it, and the pending row is written under it.
      if ((seats && rows.length > 0) || welcome) await takeSharedSeatLock(manager, groupId);
      const [group] = await manager.getRepository(Group).find({
        where: { id: groupId },
        select: {
          id: true,
          deletedAt: true,
          activeEpoch: true,
          distributionWorkspaceId: true,
          distributionChannelId: true,
        },
        lock: { mode: 'pessimistic_read' },
      });
      if (!group || group.deletedAt) {
        this.logger.warn(
          `[${tag}][${traceId}] REJECT group_deleted group=${groupId} - ` +
            (group ? `tombstoned at ${group.deletedAt?.toISOString()}` : 'absent from dm_groups') +
            ` while this send was in flight, so its ${rows.length} row(s) would be undeliverable ` +
            `for ever - nothing queued`
        );
        throw new GoneException({ error: 'group_deleted', groupId });
      }
      // A FRAME SEALED BEYOND THE PAST-EPOCH WINDOW IS REPORTED, NOT REFUSED (backlog, 2026-10-12:
      // seed requests sealed at 135-138 reached a key group at 141). Read under the same lock as the
      // write, so the epoch compared is the one these rows are queued against. Refusing would change
      // what every shipped client sees on a send, and which builds lag is not yet measured - this
      // line is that measurement: the sender's device and build, and how far behind it sealed.
      if (sealed && isBeyondPastEpochWindow(sealed.epoch, group.activeEpoch)) {
        const keyGroup = !!(group.distributionWorkspaceId || group.distributionChannelId);
        this.logger.warn(
          `[${tag}][${traceId}] STALE_EPOCH_FRAME group=${groupId} keyGroup=${keyGroup} ` +
            `frameEpoch=${sealed.epoch} activeEpoch=${group.activeEpoch} ` +
            `behind=${group.activeEpoch - sealed.epoch} sender=${sealed.sender} ` +
            `app=${sealed.appVersion} rows=${rows.length} - sealed more than ` +
            `${MLS_MAX_PAST_EPOCHS} epochs behind the group, so no member at the current epoch can open it`
        );
      }
      // A Welcome is stored only while its target still holds its seat, read under this same
      // transaction so a removal racing it serialises with it ({@link lockWelcomeSeat}) - AND ONLY
      // AN ADMITTED ONE (ADM-3): a seat still awaiting a member's admission is one no accepted
      // commit admitted (the commit that does lifts it in the transaction that accepts it), so its
      // Welcome is an Add the gate refused, or one that never landed.
      if (
        welcome &&
        !(await this.lockWelcomeSeat(manager, welcome, groupId, traceId, tag, {
          requireAdmitted: true,
        }))
      ) {
        throw new ForbiddenException(
          refusalBody(RefusalCode.WELCOME_TARGET_NOT_MEMBER, 'this Welcome is not accepted', {
            error: 'welcome_target_not_member',
          })
        );
      }
      // THE SAME WELCOME STORED TWICE IS STORED ONCE ({@link findQueuedWelcome}): a client re-sends
      // an owed Welcome whose first answer it never read, and the copy already queued is the answer.
      if (welcome && rows.length === 1) {
        const queued = await this.findQueuedWelcome(manager, groupId, welcome, rows[0].proto);
        if (queued) return [queued];
      }
      // An empty batch is a liveness check alone (an emptied roster, see `sendMessage`).
      if (rows.length === 0) return [];
      const kept = seats ? await this.keepSeatedRows(manager, rows, groupId, seats.exempt) : rows;
      if (kept.length < rows.length) {
        const dropped = rows
          .filter((r) => !kept.includes(r))
          .map((r) => `${r.recipientId}:${r.deviceId}`);
        this.logger.log(
          `[${tag}][${traceId}] SEAT_GONE_NOT_QUEUED group=${groupId} count=${dropped.length} ` +
            `devices=${capLoggedDevices(dropped).join(',')} - evicted after this send read its recipients`
        );
      }
      if (kept.length === 0) return [];
      const saved = await this.saveQueuedRows(manager, group, kept, groupId, tag, traceId);
      // The Welcome admits nobody: its target's seat was admitted by the accepted commit, checked
      // above ({@link liftAwaitingAdmission}).
      if (welcome) await this.ensurePendingSeat(manager, groupId, welcome);
      return saved;
    });
    return stored;
  }

  /**
   * Stores the rows a send keeps, in the transaction `m` that holds the seat lock and the group row.
   *
   * A KEY-GROUP FAN-OUT STORES ITS CIPHERTEXT ONCE, under the same lock and in the same transaction
   * as its records, so the group cannot end between the two and the collector never sees a payload
   * without them (`utils/queued-payload.ts`). ONLY WHILE THE WRITER'S SWITCH IS ON: off, every
   * fan-out is the inline per-seat write, the shape an image older than the readers can still serve
   * (`readSharedPayloadWrites`).
   */
  private async saveQueuedRows(
    m: EntityManager,
    group: PayloadGroupFacts,
    rows: QueuedMessage[],
    groupId: string,
    tag: string,
    traceId: string
  ): Promise<QueuedMessage[]> {
    if (this.sharedPayloadWrites && sharesPayload(group, rows)) {
      // Expected on every key-group fan-out, so debug: `QUEUED count=` already reports the send.
      this.logger.debug(
        `[${tag}][${traceId}] SHARED_PAYLOAD group=${groupId} records=${rows.length} ` +
          `bytes=${rows[0].proto?.length ?? 0} - one stored copy instead of ${rows.length}`
      );
      return saveWithSharedPayload(m, groupId, rows);
    }
    return m.getRepository(QueuedMessage).save(rows);
  }

  /**
   * Ensures the Welcome's target device has a membership row, in the transaction `m` that stores
   * the Welcome and holds the seat lock - so an eviction cannot run between the two and leave a
   * pending row behind for a person it just cut off.
   *
   * INSERT ... ON CONFLICT guarantees record creation even when no prior invitation existed
   * (bootstrap case: brand-new group, no pending record). A plain UPDATE WHERE status='pending'
   * would touch 0 rows in that case, leaving the device without a record ->
   * processPendingInvitations would incorrectly kick it.
   *
   * **AN EXISTING ROW IS NEVER TOUCHED.** The conflict clause used to overwrite `status` with the
   * literal `'pending'` - and `skipUpdateIfNoValuesChanged` does not protect a row whose value
   * CHANGES - so a Welcome to an `active` device DEMOTED it out of the fan-out. Then it overwrote
   * `kickedAt` with null, which let a Welcome undo a kick no commit had answered: a kicked device
   * is refused at the commit gate, and a Welcome is bytes, not an Add. The Add that answers a
   * kick is the admitting commit, which clears `kickedAt` itself (`validateCommit`), and
   * `activateDeviceMembership` clears it on activation.
   */
  private async ensurePendingSeat(
    m: EntityManager,
    groupId: string,
    target: WelcomeSeat
  ): Promise<void> {
    await m
      .getRepository(DeviceGroupMembership)
      .createQueryBuilder()
      .insert()
      .into(DeviceGroupMembership)
      .values({
        deviceId: target.deviceId,
        groupId,
        userId: target.userId,
        status: 'pending' as const,
        kickedAt: null,
      })
      .orIgnore()
      .execute();
  }

  /**
   * The rows of `rows` whose recipient still holds a seat (a membership row, any status) in
   * `groupId`, read in the transaction `m`, which holds the seat lock. A key in `exempt` is kept
   * without one: a commit reaches the devices it removes, whose seats were deleted on purpose.
   */
  private async keepSeatedRows(
    m: EntityManager,
    rows: QueuedMessage[],
    groupId: string,
    exempt: ReadonlySet<string>
  ): Promise<QueuedMessage[]> {
    const seated = await m.getRepository(DeviceGroupMembership).find({
      where: { groupId, deviceId: In([...new Set(rows.map((r) => r.deviceId))]) },
      select: { userId: true, deviceId: true },
    });
    const held = new Set(seated.map((s) => `${s.userId}:${s.deviceId}`));
    return rows.filter((r) => {
      const k = `${r.recipientId}:${r.deviceId}`;
      return held.has(k) || exempt.has(k);
    });
  }

  /**
   * Among `groupIds`, identifies those with no remaining row in `dm_groups`
   * (neither active nor soft-delete tombstone) and purges their entire server residue through
   * {@link deleteGroupOwnedRows} - the one allowlist of what a group owns - plus the Redis keys.
   *
   * These groups result from an incomplete deletion: the row is gone but surviving data
   * causes a client-side recovery loop (welcome_request with no target) and an undecipherable
   * ghost history. Soft-deleted groups keep their tombstone row and are therefore never purged
   * here (the 90-day cron reclaims them, through that same function).
   *
   * THIS IS THE ONLY PLACE THAT REPAIRS AN ORPHAN. Three callers reach it - a frame fetch, a
   * history read, and the 6 h sweep - and none of them removes anything itself. The sweep used to:
   * its Redis half deleted `group:members:` by hand, which left the `history:` stream behind and
   * took away the only key through which that group could still be found.
   *
   * No transaction here, and that is not an oversight: the group row is ALREADY gone, so there is
   * no window this could open. The reaper, which still has one to delete, does use one.
   *
   * PRESENCE AND DELIVERABILITY ARE TWO QUESTIONS, and this used to answer the first while its own
   * doc named the second - "still present in `dm_groups` (deliverable)". They differ by exactly the
   * tombstones, and a tombstone is not a destination: its members, keys and history are gone, so a
   * frame addressed to it can never be decrypted and never be ACKed, and a client handed one asks
   * for a Welcome no peer will answer - on every reconnection, for ever, because nothing in that
   * loop consumes the frame. `deletedAt` is a plain column rather than a `@DeleteDateColumn`, so
   * `find` returns tombstones and only naming them excludes them. Measured on prod 2026-08-21:
   * seven `queued_message` rows for W1's own device, addressed to a community distribution group
   * tombstoned five hours earlier, redelivered on every connection since.
   *
   * Both sets are returned, named, because the caller that filters frames has to tell the two
   * causes apart: an absent group is one this call has just repaired, a tombstoned one is residue a
   * delete path left behind and a defect at THAT path. A single set would make them one number.
   *
   * @returns `deliverable` - present in `dm_groups` AND not tombstoned, the only ids a frame may be
   *   handed to; `tombstoned` - present but soft-deleted, undeliverable and awaiting the reaper.
   */
  /**
   * Tombstoned groups already accused of holding queued rows, so the accusation is made once per
   * group per process rather than once per fetch - see the log line in {@link fetchMessages}.
   *
   * IN-PROCESS AND NOT DURABLE, on purpose. It answers "have I already said this here", which is a
   * different question from "is this still broken" and differs from it only in lifetime: a restart
   * re-announces whatever residue is still there, so using durable state here would silence the
   * trigger the day somebody wanted it again.
   */
  private readonly accusedTombstones = new Set<string>();

  /**
   * The count of addressed rows last reported as withheld from each device, by `user:device`, so a
   * device's older session is told about once per change of that count and not once per pull - see
   * the line in {@link fetchMessages}. IN-PROCESS and not durable for the same reason as
   * {@link accusedTombstones}: it answers "have I already said this here", and a restart re-announces
   * what is still waiting. An entry is dropped as soon as nothing waits, so it holds one number per
   * device that has a row waiting right now.
   */
  private readonly withheldReported = new Map<string, number>();

  async purgeOrphanGroups(
    groupIds: string[]
  ): Promise<{ deliverable: Set<string>; tombstoned: Set<string> }> {
    if (groupIds.length === 0) return { deliverable: new Set(), tombstoned: new Set() };

    const existing = await this.groupRepo.find({
      where: { id: In(groupIds) },
      select: { id: true, deletedAt: true },
    });
    const present = new Set(existing.map((g) => g.id));
    const deliverable = new Set(existing.filter((g) => !g.deletedAt).map((g) => g.id));
    const tombstoned = new Set(existing.filter((g) => g.deletedAt).map((g) => g.id));

    const orphaned = groupIds.filter((id) => !present.has(id));
    if (orphaned.length === 0) return { deliverable, tombstoned };

    const counts = await deleteGroupOwnedRows(this.groupRepo.manager, orphaned);
    await deleteGroupRedisKeys(this.redis, orphaned);

    this.logger.warn(
      `[ORPHAN_PURGE] purged ${orphaned.length} group(s) absent from dm_groups ` +
        `(${totalGroupOwnedRows(counts)} row(s): ${JSON.stringify(counts)}): ${orphaned.join(', ')}`
    );
    return { deliverable, tombstoned };
  }

  /**
   * Clamps history page size: full catch-up may read up to the stream MAXLEN;
   * incremental (`after` set) defaults to a smaller page.
   */
  private resolveHistoryLimit(after: string | undefined, limitRaw?: number): number {
    if (limitRaw !== undefined && Number.isFinite(limitRaw)) {
      return Math.min(Math.max(Math.trunc(limitRaw), 1), HISTORY_FULL_PAGE_LIMIT);
    }
    return after ? HISTORY_INCREMENTAL_DEFAULT_LIMIT : HISTORY_FULL_PAGE_LIMIT;
  }

  /** Maps Redis stream entries to the JSON shape expected by clients. */
  private mapHistoryEntries(entries: [string, string[]][]): Record<string, unknown>[] {
    return entries.map(([id, fields]) => {
      const msg: Record<string, unknown> = { id };
      for (let i = 0; i < fields.length; i += 2) {
        msg[fields[i]] = fields[i + 1];
      }
      return msg;
    });
  }

  /**
   * Enriches history entries with `sender_display_name` resolved from the `users` table.
   * Collects all unique `sender_id` values, batch-resolves their display names, and adds
   * `sender_display_name: string | null` to each entry. Best-effort: entries keep their
   * current shape on failure.
   */
  private async enrichHistoryWithDisplayNames(
    entries: Record<string, unknown>[]
  ): Promise<Record<string, unknown>[]> {
    if (entries.length === 0) return entries;
    const senderIds = [
      ...new Set(
        entries
          .map((e) => e['sender_id'])
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      ),
    ];
    if (senderIds.length === 0) return entries;
    try {
      const nameMap = await resolveUserDisplayNamesBatch(this.groupRepo.manager, senderIds);
      for (const entry of entries) {
        const sid = typeof entry['sender_id'] === 'string' ? entry['sender_id'] : '';
        entry['sender_display_name'] = nameMap.get(sid) ?? null;
      }
    } catch (e) {
      this.logger.warn(`[HISTORY] display name resolution failed: ${String(e)}`);
      for (const entry of entries) {
        entry['sender_display_name'] = null;
      }
    }
    return entries;
  }

  /**
   * Keeps only a well-formed Redis stream id (`<ms>-<seq>`). Anything else is dropped rather than
   * rejected: a bad cursor is a client that has lost its place, and the honest answer is the
   * unbounded read it would have got with no cursor at all - not a 500 it cannot act on.
   */
  private sanitizeStreamId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && /^\d+-\d+$/.test(trimmed) ? trimmed : undefined;
  }

  /**
   * WHO ASKED, as one field every history log line carries.
   *
   * A `[HISTORY]` line named the group, the cursor and the row count and NOT the caller, so a burst
   * of walks over one group could not be attributed to anything: thirteen full `after=start` walks
   * in ten minutes on production 2026-09-16 were unattributable to a device, an account, or even a
   * count of distinct callers. **A rate is only a defect once it is measured against the population
   * that produced it**, and that measurement needs this field before it needs anything else.
   *
   * THE TWO HALVES ARE NOT WORTH THE SAME AND THE LINE SAYS SO. `user` is what nginx put on the
   * request after `/internal/auth/verify` answered - a fact this service did not have to trust the
   * caller for. `device` is the client's own `X-Canari-Device`, self-asserted, and it is accepted
   * anyway for the same reason `probeSender` accepts the device half of an MLS identity: the user
   * is authenticated alongside it, so the only thing a liar can misreport is which of its OWN
   * devices walked the archive. That costs a misattributed walk inside one account and nothing else,
   * which is worth far less than having no device at all when two of them walk the same group.
   *
   * Neither half can refuse the request - see {@link sanitizeLogValue}.
   */
  private historyRequester(
    headerUserId: string | undefined,
    headerDeviceId: string | undefined
  ): string {
    return `user=${sanitizeLogValue(headerUserId)} device=${sanitizeLogValue(headerDeviceId)}`;
  }

  /**
   * Reads one page from `history:{groupId}` (no auth — caller must gate access).
   *
   * `after` is an exclusive Redis stream ID (`(${after}` in XRANGE); `until` is an INCLUSIVE upper
   * bound, so a caller that passes back the `head` it was given walks exactly the rows that existed
   * when it started and never the ones appended since (see {@link HistoryBatchResponse.heads}).
   *
   * The head is read only when the caller has no bound yet - one `XREVRANGE ... COUNT 1` on the
   * first page of a walk, and nothing at all on the pages after it.
   *
   * THE LINE PRINTS WHAT WAS ASKED, NOT WHAT WAS FOUND. It used to print the head it had just read
   * as `until=`, so a device whose cursor already WAS the head logged `after=X until=X entries=0` -
   * read on 2026-10-13 as a client asking for a window empty by construction (210 of 258 batch lines
   * over three launches of one store phone). The client sends no `until` on a batch: it asked "what
   * is after my cursor", and the answer was "nothing". `until=` is now the caller's bound and `head=`
   * the stream's.
   *
   * @param quietWhenCaughtUp the batch route's: a group whose cursor IS the head writes no line, and
   *   is counted in `[HISTORY_BATCH]` instead - 83 of 85 lines per launch said only that.
   *
   * **WITH `windows`, THE READER'S OWN EXCLUSION WINDOWS, A ROW INSIDE ONE IS DROPPED AND THE PAGE
   * STILL FILLS** (a Remove holds against a later re-add, user 2026-10-14). Every build ends its walk
   * on an empty page and continues from the LAST row it was handed, so a page that dropped its rows
   * and returned short would end the walk with real rows still behind the dropped ones. The read
   * goes on until `limit` rows are kept or the bound is reached, in chunks of at least
   * `HISTORY_FULL_PAGE_LIMIT` whatever the caller's `limit` - the caller sets how much it is HANDED,
   * never how many reads it costs: a `limit` of 1 would otherwise buy one `XRANGE` per row, up to
   * `HISTORY_STREAM_MAXLEN` of them (fourth review of #1878). Rows dropped past the last kept one
   * are read again by the next page and dropped again - nothing is skipped that a later page would
   * not reach.
   *
   * **A DROPPED TAIL IS RESCANNED, ON PURPOSE.** A reader whose only unread rows lie in its own window
   * reads them again on every launch, because every build advances only over rows it was handed. The
   * rescan is bounded by the stream's `MAXLEN` and costs whole chunks. Naming the tail so the cursor
   * could jump it (`skipTo`) was built and DELETED (fifth review of #1878): a window read wrongly
   * open - a roster row with no open interval - moved the cursor past rows the later repair made
   * entitled again, hiding them for good. A bounded rescan is the cost of never hiding a row
   * (history-reconciliation, backlog P3). A cursor followed only by dropped rows up to the head is
   * still counted as caught up rather than logged on every launch.
   */
  private async readHistoryStreamPage(
    groupId: string,
    after: string | undefined,
    limit: number,
    until: string | undefined,
    requester: string,
    quietWhenCaughtUp = false,
    windows?: readonly ExclusionWindow[]
  ): Promise<{
    rows: Record<string, unknown>[];
    head?: string;
    caughtUp: boolean;
  }> {
    const streamKey = `history:${groupId}`;
    const endId = until ?? '+';
    const filtering = windows !== undefined && windows.length > 0;
    // Without windows nothing is dropped, so this is the single read of `limit` it always was.
    const chunk = filtering ? Math.max(limit, HISTORY_FULL_PAGE_LIMIT) : limit;
    const kept: Record<string, unknown>[] = [];
    let withheld = 0;
    let read = 0;
    let lastRead = after;
    while (kept.length < limit) {
      const startId = lastRead ? `(${lastRead}` : '-';
      const entries = await this.redis.xrange(streamKey, startId, endId, 'COUNT', chunk);
      read += entries.length;
      if (entries.length > 0) lastRead = entries[entries.length - 1][0];
      const page = withholdExcludedHistoryRows(this.mapHistoryEntries(entries), windows ?? []);
      withheld += page.withheld;
      kept.push(...page.rows.slice(0, limit - kept.length));
      if (entries.length < chunk || !filtering) break;
    }
    const head = until
      ? until
      : ((await this.redis.xrevrange(streamKey, '+', '-', 'COUNT', 1))[0]?.[0] ?? undefined);
    const caughtUp =
      kept.length === 0 &&
      after !== undefined &&
      (head === after || (read > 0 && lastRead === head));
    if (!(quietWhenCaughtUp && caughtUp)) {
      this.logger.log(
        `[HISTORY] ${requester} group=${groupId} after=${after ?? 'start'} ` +
          `until=${until ?? 'none'} head=${head ?? 'empty'} limit=${limit} entries=${kept.length}` +
          (withheld > 0 ? ` withheld=${withheld} (sent while the reader was out of the group)` : '')
      );
    }
    return { rows: kept, head, caughtUp };
  }

  /**
   * Returns group IDs the caller may read. Orphans are purged once per batch;
   * non-members are omitted (batch) or rejected (single-group).
   */
  private async authorizeHistoryGroups(
    groupIds: string[],
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    rejectForbidden: boolean
  ): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();

    // A DELETED GROUP HAS NO HISTORY TO SERVE: `deleteGroupOwnedRows` drops its `history:` stream
    // with the rest of what it owns, so a tombstone can only ever answer an empty page. Excluding
    // it here says so once instead of reading an absent stream per request. A client still holding
    // the conversation locally and asking for it is ORDINARY - hence no log line: the request is
    // not evidence of anything, unlike a queued frame (see fetchMessages).
    const { deliverable: deliverableIds } = await this.purgeOrphanGroups(groupIds);
    const deliverable = groupIds.filter((id) => deliverableIds.has(id));

    if (headerGlobalAdmin === 'true') {
      return new Set(deliverable);
    }

    const authUserId = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!authUserId) {
      throw new ForbiddenException('History requires authenticated user context');
    }

    if (deliverable.length === 0) {
      if (rejectForbidden && groupIds.length === 1) {
        return new Set();
      }
      return new Set();
    }

    // A SEAT STILL AWAITING A MEMBER'S ADMISSION READS NO HISTORY (review of #2358, F1): the person
    // is not in the group yet. The single read answers it the 409 `awaiting_admission` (a pending
    // member who waits, never the 403 its client would retire the conversation on); the batch omits
    // the group like any other it may not read.
    const standings = await callerSeatStandings(this.groupMemberRepo, deliverable, authUserId);
    const memberIds = new Set(
      [...standings].filter(([, standing]) => standing === 'admitted').map(([gid]) => gid)
    );

    if (rejectForbidden && groupIds.length === 1) {
      const gid = groupIds[0];
      if (!deliverableIds.has(gid)) {
        return new Set();
      }
      if (standings.get(gid) === 'awaiting') {
        throw refuseAwaitingSeat(this.logger, 'HISTORY', gid, authUserId);
      }
      if (!memberIds.has(gid)) {
        throw new ForbiddenException('Not a member of this group');
      }
    }

    return memberIds;
  }

  /**
   * Returns the Redis stream history for a group, with optional cursor-based
   * pagination via an afterStreamId parameter.
   * Enforces group membership for non-admin callers.
   */
  async getHistory(
    groupIdRaw: string,
    afterRaw: string | undefined,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    limitRaw?: number,
    untilRaw?: string,
    headerDeviceId?: string
  ): Promise<{ rows: Record<string, unknown>[]; head?: string }> {
    const requester = this.historyRequester(headerUserId, headerDeviceId);
    const groupId = sanitizeQueryValue(groupIdRaw, 'groupId');
    const after = this.sanitizeStreamId(afterRaw);
    const until = this.sanitizeStreamId(untilRaw);
    const limit = this.resolveHistoryLimit(after, limitRaw);

    const authorized = await this.authorizeHistoryGroups(
      [groupId],
      headerUserId,
      headerGlobalAdmin,
      true
    );
    if (!authorized.has(groupId)) {
      // NOT A WARNING, AND NOT "ORPHANED" EITHER, which is what this used to say. Two different
      // things land here and only one of them is a defect: a group with no row (already purged and
      // already WARNed about, with its evidence, by `purgeOrphanGroups`) and a group deleted whose
      // history went with it - which is a client still holding the conversation locally and asking
      // for it, the most ordinary request there is. Naming the first cause for both made a line
      // whose reader learns to skip it.
      this.logger.log(
        `[HISTORY] ${requester} group=${groupId} not deliverable (absent or deleted) - empty`
      );
      return { rows: [] };
    }

    try {
      const windows = await this.ownWithheldWindows(
        headerUserId,
        groupId,
        headerGlobalAdmin === 'true'
      );
      const page = await this.readHistoryStreamPage(
        groupId,
        after,
        limit,
        until,
        requester,
        false,
        windows
      );
      return {
        rows: await this.enrichHistoryWithDisplayNames(page.rows),
        head: page.head,
      };
    } catch (e) {
      this.logger.error(`[HISTORY] ${requester} group=${groupId} error=${String(e)}`);
      throw new ServiceUnavailableException('History stream unavailable');
    }
  }

  /**
   * Everything the CALLER may not be handed from `groupId`'s history stream: the spans they were out
   * of the group (user, 2026-10-14: a Remove holds against a later re-add) and, in a GROUP
   * conversation, everything before their first arrival (user, 2026-10-21: a newcomer reads nothing
   * from before they were added). The same {@link withheldWindows} the exclusions route answers the
   * caller with, which every history answer is filtered on - so the server's own stream never hands
   * a newcomer the ciphertexts an answering member withholds, whatever the reader's build does with
   * them. Empty for an internal caller with no user header, which reads on nobody's behalf.
   *
   * A 1:1 and a key group withhold no arrival span ({@link withholdsArrivalSpan}), so for them this is
   * the gaps alone, as it always was. A member's NEW device reads everything since its PERSON's
   * arrival: intervals are per user, never per device.
   *
   * ONE GROUP PER READ, so the batch route isolates a failure to the group it was read for: one
   * Postgres hiccup answers that group empty, never the whole batch.
   *
   * **A ROSTER MEMBER WITH NO OPEN INTERVAL IS REPAIRED BEFORE ITS WINDOWS ARE READ** (fifth review
   * of #1878). Read as it stands, their last closed interval is a window open to now, and every row
   * since their removal would be dropped although they are a member again. The repair is the one
   * `GET .../exclusions` runs (`openMissingIntervals`), with the same ERROR line; it costs a roster
   * read only when no interval is open, so a consistent member pays nothing extra.
   *
   * **A GLOBAL ADMIN IS NAMED BY ITS HEADER, NEVER INFERRED FROM A MISSING INTERVAL** (review of
   * #2800). An admin holding no interval reads a group it is not in, and this filter has never
   * narrowed that read. Anyone else reached here through the roster (`authorizeHistoryGroups`), so a
   * caller holding NO interval at all is a member the enrolment failed to record - repaired like the
   * one with no open interval, above. Should the repair open nothing (the roster row went
   * meanwhile), the read FAILS CLOSED: one window over everything, said at ERROR - an absent record
   * never reads as "withhold nothing".
   *
   * @param globalAdmin the caller's `x-global-admin` header said `true`.
   */
  private async ownWithheldWindows(
    headerUserId: string | undefined,
    groupId: string,
    globalAdmin: boolean
  ): Promise<ExclusionWindow[]> {
    const userId = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!userId) return [];
    const read = () =>
      this.groupRepo.manager.find(GroupMembershipInterval, {
        where: { userId, groupId },
        select: { groupId: true, joinedAt: true, leftAt: true, admittedAt: true },
      });
    let intervals = await read();
    // An admin's read of a group it never joined has nothing to repair; every other caller is on the
    // roster, and a member outside every open interval - none at all included - is a record to repair.
    const unrecorded = intervals.length === 0 && !globalAdmin;
    if ((intervals.length > 0 || unrecorded) && !intervals.some((r) => r.leftAt === null)) {
      // The roster is read under a lock inside the helper - a person removed meanwhile gets nothing.
      const opened = await openMissingIntervals(this.groupRepo.manager, groupId, [userId]);
      if (opened.length > 0) {
        this.logger.error(
          `[HISTORY] group=${groupId.slice(0, 8)} user=${userId.slice(0, 8)} opened a missing interval - a member with no open interval (pre-030 enrolment or an interrupted one) would have read as out of the group`
        );
      }
      // Re-read rather than patch the list: a concurrent repair may have opened it instead, and a
      // removal may have closed it since - the table is the only answer to both.
      intervals = await read();
    }
    if (intervals.length === 0) {
      if (globalAdmin) return [];
      this.logger.error(
        `[HISTORY] group=${groupId.slice(0, 8)} user=${userId.slice(0, 8)} holds no membership interval and none could be opened - the stream is withheld whole rather than served unfiltered`
      );
      return [{ from: 0, until: null }];
    }
    const group = await this.groupRepo.findOne({
      where: { id: groupId },
      select: {
        id: true,
        isGroup: true,
        distributionWorkspaceId: true,
        distributionChannelId: true,
        createdAt: true,
      },
    });
    if (!withholdsArrivalSpan(group)) return exclusionWindows(intervals);
    // The person's earliest device row in the group, the second record of their arrival - read as
    // the exclusions route reads it, so the two answers are one.
    const earliest = await this.deviceGroupRepo
      .createQueryBuilder('d')
      .select('MIN(d.createdAt)', 'firstDeviceAt')
      .where('d.groupId = :groupId', { groupId })
      .andWhere('d.userId = :userId', { userId })
      .getRawOne<{ firstDeviceAt: Date | string | null }>();
    return withheldWindows(
      intervals,
      true,
      earliest?.firstDeviceAt ? new Date(earliest.firstDeviceAt) : null,
      group?.createdAt ?? null
    );
  }

  /**
   * Fetches the first page of history for multiple groups in one round-trip.
   * Unauthorized or orphaned groups return an empty array (no error).
   */
  async getHistoryBatch(
    items: HistoryBatchRequestItem[],
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    headerDeviceId?: string
  ): Promise<HistoryBatchResponse> {
    const requester = this.historyRequester(headerUserId, headerDeviceId);
    if (!Array.isArray(items)) {
      throw new BadRequestException('groups must be an array');
    }
    if (items.length > HISTORY_BATCH_MAX_GROUPS) {
      throw new BadRequestException(`At most ${HISTORY_BATCH_MAX_GROUPS} groups per batch`);
    }

    const normalized = items.map((item) => {
      // The limit is resolved from the SANITISED cursor: a dropped one means the read restarts from
      // the beginning, which is a full catch-up page, not the smaller incremental one.
      const after = this.sanitizeStreamId(item.after);
      return {
        groupId: sanitizeQueryValue(item.groupId, 'groupId'),
        after,
        until: this.sanitizeStreamId(item.until),
        limit: this.resolveHistoryLimit(after, item.limit),
      };
    });

    const groupIds = [...new Set(normalized.map((i) => i.groupId))];
    const authorized = await this.authorizeHistoryGroups(
      groupIds,
      headerUserId,
      headerGlobalAdmin,
      false
    );

    const histories: Record<string, Record<string, unknown>[]> = {};
    const heads: Record<string, string> = {};
    let caughtUp = 0;
    await Promise.all(
      normalized.map(async ({ groupId, after, until, limit }) => {
        if (!authorized.has(groupId)) {
          histories[groupId] = [];
          return;
        }
        try {
          // Read per group and inside its `try`: a failed read answers THIS group empty - never its
          // stream unfiltered, which is what this read exists to prevent - and the rest of the batch
          // is served.
          const windows = await this.ownWithheldWindows(
            headerUserId,
            groupId,
            headerGlobalAdmin === 'true'
          );
          const page = await this.readHistoryStreamPage(
            groupId,
            after,
            limit,
            until,
            requester,
            true,
            windows
          );
          histories[groupId] = page.rows;
          if (page.head) heads[groupId] = page.head;
          if (page.caughtUp) caughtUp++;
        } catch (e) {
          this.logger.error(`[HISTORY_BATCH] ${requester} group=${groupId} error=${String(e)}`);
          histories[groupId] = [];
        }
      })
    );

    // Batch-resolve sender display names across all groups in a single SQL round-trip.
    const allEntries = Object.values(histories).flat();
    await this.enrichHistoryWithDisplayNames(allEntries);

    this.logger.log(
      `[HISTORY_BATCH] ${requester} groups=${normalized.length} authorized=${authorized.size} ` +
        `caughtUp=${caughtUp}`
    );
    return { histories, heads };
  }

  /**
   * Fetches all queued (undelivered) messages for a specific device from the DB queue,
   * ordered by creation time ascending.  Enforces that the caller owns the userId.
   */
  async fetchMessages(
    userId: string,
    deviceId: string,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined,
    limit = 500,
    after?: string,
    caps?: string
  ): Promise<QueuedMessage[]> {
    const traceId = this.makeTraceId('fetch-msg');
    // AN ADDRESSED ROW REACHES ONLY A SESSION THAT DECLARED IT APPLIES RULE 5
    // (history-answer-addressing, rule 6): the same `caps` its socket declares, sent on the fetch.
    // Withheld IN THE QUERY, so the page and the client's cursor are untouched and the row stays
    // queued for the session that can read it.
    const readsAddressed = declaresAddressedHistory(caps);
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot fetch messages for another user'
    );

    const safeLimit = Math.min(Math.max(limit, 1), 1000);

    this.logger.log(
      `[MSG_FETCH][${traceId}] START user=${safeUserId} device=${safeDeviceId} limit=${safeLimit} after=${after ?? 'none'}`
    );

    // Fill the page up to a BYTE budget, reading the table in small chunks.
    //
    // The row limit alone cannot bound a transfer: for a device whose frames carry media, 500 rows
    // meant 12 MB, and the client abandoned the request on its own per-page deadline having received
    // nothing - so nothing was ACKed, the queue never shrank, and every later attempt met the same
    // 12 MB. The chunked read is what keeps the SERVICE bounded too; see PENDING_PAGE_MAX_BYTES and
    // PENDING_FETCH_CHUNK_ROWS for why each number is what it is.
    const messages: QueuedMessage[] = [];
    let pageBytes = 0;
    let offset = 0;
    let cappedBy: 'bytes' | 'rows' | null = null;
    let done = false;

    while (!done) {
      const qb = this.queuedMessageRepo
        .createQueryBuilder('q')
        // The payload in the SAME statement as the record - see `PAYLOAD_RELATION`.
        .leftJoinAndSelect('q.payload', 'payload')
        .where('q.recipientId = :userId', { userId: safeUserId })
        .andWhere('q.deviceId = :deviceId', { deviceId: safeDeviceId })
        .orderBy('q.createdAt', 'ASC')
        // Two records of one device can share a `createdAt` (one transaction, one `now()`): the id
        // makes the order total, or OFFSET paging could hand one row twice and skip another.
        .addOrderBy('q.id', 'ASC')
        // SQL `OFFSET`/`LIMIT`, not `skip`/`take`: with a join TypeORM turns `skip`/`take` into a
        // DISTINCT-ids query plus a second read, and a many-to-one join cannot multiply rows.
        .offset(offset)
        .limit(PENDING_FETCH_CHUNK_ROWS);

      if (after?.trim()) {
        qb.andWhere('q.createdAt > :after', { after: new Date(after) });
      }
      if (!readsAddressed) qb.andWhere('q.addressed = false');

      const chunk = await qb.getMany();
      if (chunk.length === 0) break;
      offset += chunk.length;
      // Materialised BEFORE the byte budget is measured: a record pointing at a shared payload
      // stores no `proto`, and a page sized on the stored bytes alone would hand over megabytes it
      // believed were nothing - the 2026-08-13 failure this budget exists to prevent. A record whose
      // payload is missing is withheld there, never served empty; `offset` above counts it anyway,
      // because it is still a row of the table this pages over.
      const served = materializeDeliveries(chunk, this.logger, traceId);

      for (const row of served) {
        const size = row.proto?.length ?? 0;
        const last = messages[messages.length - 1];
        const sameInstant = last !== undefined && +row.createdAt === +last.createdAt;

        // ALWAYS at least one row: a frame bigger than the whole budget must still be deliverable,
        // or it blocks its device's queue permanently - which is the failure being fixed, not a
        // smaller version of it. Hence `messages.length > 0` on both caps.
        if (cappedBy === null && messages.length > 0) {
          if (pageBytes + size > PENDING_PAGE_MAX_BYTES) cappedBy = 'bytes';
          else if (messages.length >= safeLimit) cappedBy = 'rows';
        }

        // A PAGE NEVER ENDS INSIDE A GROUP OF ROWS SHARING ONE `createdAt`. The client resumes with
        // `createdAt > <last row seen>`, which is strict - so splitting such a group drops the rest
        // of it from every later page, permanently, and the frame is never delivered at all.
        // `@CreateDateColumn` writes millisecond precision from the application, so collisions are
        // real rather than theoretical: one pair was present in the live queue when this was
        // written. Rows sharing the boundary instant are therefore taken even past the cap, which
        // is why a page can exceed its budget by one group and never by more.
        if (cappedBy !== null && !sameInstant) {
          done = true;
          break;
        }

        messages.push(row);
        pageBytes += size;
      }

      // A short chunk is the end of the queue; there is nothing left to read.
      if (chunk.length < PENDING_FETCH_CHUNK_ROWS) break;
    }

    if (cappedBy !== null) {
      this.logger.log(
        `[MSG_FETCH][${traceId}] page capped by ${cappedBy} at ${messages.length} row(s), ${pageBytes} byte(s) - the client pages again from the last createdAt`
      );
    }

    // Drop messages addressed to a group that can no longer receive them - absent from `dm_groups`
    // or tombstoned in it. Either way the client can neither decrypt nor ACK such a frame, so
    // handing it over starts a recovery loop (welcome_request with no target) that nothing
    // terminates: the frame stays queued and comes back on the next connection. purgeOrphanGroups
    // also purges the residue of the absent ones - see its doc.
    const groupIds = [
      ...new Set(messages.map((m) => m.groupId).filter((id): id is string => !!id)),
    ];
    const { deliverable: deliverableIds, tombstoned } = await this.purgeOrphanGroups(groupIds);
    const deliverable = messages.filter((m) => !m.groupId || deliverableIds.has(m.groupId));
    if (deliverable.length !== messages.length) {
      // THE TWO CAUSES ARE NAMED APART, because they accuse different code. An absent group is one
      // this fetch has just repaired. A QUEUED FRAME FOR A TOMBSTONED GROUP IS RESIDUE A DELETE PATH
      // LEFT: every path that ends a group sweeps `deleteGroupOwnedRows`, which takes the queue with
      // it, so this line is the visible end of one that did not - and it is not swept from here,
      // because a second collector would hide the first one's absence.
      //
      // ONCE PER GROUP PER PROCESS, because the residue is a STANDING FACT and not an event. Written
      // per fetch it was the loudest line on the server within minutes of shipping - 134 warnings in
      // one three-minute window, the same four group ids over and over, because every client asks on
      // every reconnection and the rows do not go away when they are read. A line its reader learns
      // to skip is the one that hides the next defect. Once is enough to be FOUND, which is the
      // line's whole job, and a restart re-announces whatever is still there, so nothing is lost.
      const leaked = groupIds.filter((id) => tombstoned.has(id) && !this.accusedTombstones.has(id));
      for (const id of leaked) this.accusedTombstones.add(id);
      this.logger.warn(
        `[MSG_FETCH][${traceId}] dropped ${messages.length - deliverable.length} undeliverable ` +
          `message(s)` +
          (leaked.length > 0
            ? ` - ${leaked.length} group(s) tombstoned in dm_groups and still holding queued rows, ` +
              `so the path that deleted them left residue: ${leaked.join(', ')}`
            : '')
      );
    }

    const withheldKey = `${safeUserId}:${safeDeviceId}`;
    if (!readsAddressed) {
      const withheld = await this.queuedMessageRepo.count({
        where: { recipientId: safeUserId, deviceId: safeDeviceId, addressed: true },
      });
      if (withheld === 0) {
        this.withheldReported.delete(withheldKey);
      } else if (this.withheldReported.get(withheldKey) !== withheld) {
        // An older session pulling while an addressed answer waits for a declared one - the
        // expected consequence of an old client, and the row is not lost, it waits. ONCE per change
        // of the count for this device: every pull of that session would otherwise repeat the same
        // line until the row's retention ends.
        this.withheldReported.set(withheldKey, withheld);
        this.logger.log(
          `[MSG_FETCH][${traceId}] WITHHELD ${withheld} addressed row(s) from user=${safeUserId} ` +
            `device=${safeDeviceId} - this fetch did not declare ${ADDRESSED_HISTORY_CAPABILITY}`
        );
      }
    } else {
      this.withheldReported.delete(withheldKey);
    }

    this.logger.log(
      `[MSG_FETCH][${traceId}] DONE user=${safeUserId} device=${safeDeviceId} count=${deliverable.length}`
    );
    return deliverable;
  }

  /**
   * Acknowledges (deletes) processed messages from the delivery queue by ID.
   * Enforces that the caller owns the userId and only deletes messages addressed
   * to the specified device.
   */
  async acknowledgeMessages(
    body: AckMessagesBody,
    headerUserId: string | undefined,
    headerGlobalAdmin: string | undefined
  ): Promise<{ status: string; count: number }> {
    const traceId = this.makeTraceId('ack');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeMessageIds = sanitizeStringIdList(body.messageIds);
    assertCallerOwnsUserId(
      headerUserId,
      headerGlobalAdmin,
      safeUserId,
      'Cannot acknowledge messages for another user'
    );

    this.logger.log(
      `[ACK][${traceId}] START user=${safeUserId} device=${safeDeviceId} requested=${safeMessageIds.length}`
    );

    if (safeMessageIds.length === 0) {
      this.logger.warn(
        `[ACK][${traceId}] IGNORE empty messageIds user=${safeUserId} device=${safeDeviceId}`
      );
      return { status: 'ignored', count: 0 };
    }

    // Delete only the messages the client has confirmed.
    const result = await this.queuedMessageRepo.delete({
      id: In(safeMessageIds),
      recipientId: safeUserId,
      deviceId: safeDeviceId, // Security: prevents a device from deleting another device's messages.
    });

    this.logger.log(
      `[ACK][${traceId}] DONE deleted=${result.affected || 0} user=${safeUserId} device=${safeDeviceId}`
    );

    return { status: 'deleted', count: result.affected || 0 };
  }

  /**
   * Sends a silent FCM data push to every registered device of each group member
   * (except the requester) to wake them up when a welcome_request is pending and
   * no peer was online to handle it.
   *
   * On reception, the Kotlin service reconnects the WebSocket; the normal
   * welcome-drain flow then forwards the pending welcome_request automatically.
   */
  private async sendFcmWelcomeRequestPending(
    groupId: string,
    members: string[],
    requesterKey: string,
    traceId: string
  ): Promise<void> {
    if (getApps().length === 0) return;

    const [requesterUserId, requesterDeviceId] = requesterKey.split(':');

    const uniqueUserIds = [
      ...new Set(
        members
          .filter((m) => m !== requesterKey)
          .map((m) => m.split(':')[0])
          .filter(Boolean)
      ),
    ];

    // Batch-load all tokens in a single query instead of one per user.
    if (uniqueUserIds.length === 0) return;
    const allTokens = await this.pushTokenRepo.find({
      where: { userId: In(uniqueUserIds) },
    });

    await Promise.all(
      allTokens.map(async (pt) => {
        try {
          await getMessaging().send({
            token: pt.token,
            data: {
              type: 'welcome_request_pending',
              groupId,
              requesterUserId: requesterUserId ?? '',
              requesterDeviceId: requesterDeviceId ?? '',
            },
            android: { priority: 'high', ttl: 3_600_000 }, // 1 h < 24 h Redis TTL
            apns: {
              payload: { aps: { contentAvailable: true } },
              headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
            },
          });
          this.logger.log(
            `[WELCOME_REQ][${traceId}] FCM welcome_request_pending user=${pt.userId} device=${pt.deviceId}`
          );
        } catch (e) {
          if (this.isTerminalPushTokenError(e)) {
            await this.pushTokenRepo.delete({ id: pt.id });
            this.logger.warn(
              `[WELCOME_REQ][${traceId}] Deleted invalid push token user=${pt.userId} device=${pt.deviceId}`
            );
          }
          this.logger.warn(
            `[WELCOME_REQ][${traceId}] FCM failed user=${pt.userId} device=${pt.deviceId} err=${String(e)}`
          );
        }
      })
    );
  }

  /**
   * Sends a non-MLS push to every registered device of a user - the side-channel signals where the
   * server never sees the MLS plaintext: reactions, community channel messages and their silent
   * `channel_read` frames, posts, form reminders.
   *
   * THE ONLY IMPLEMENTATION. `InternalController.notifyUser` used to carry a second copy of this
   * loop without the `apns` block below, which cost every iPhone every community notification -
   * see that method's docstring. Anything that needs to push to a user calls this.
   *
   * `inline` is a group of fields that ride together or not at all - a salon message's ciphertext
   * and the seed frame that opens it - decided per token by what that token's platform is sent
   * (`withInlineGroup`). Empty for every push that has none.
   *
   * Returns { sent, failed } - failure is non-fatal for the caller.
   */
  async sendPushToUser(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string>,
    inline: Record<string, string> = {}
  ): Promise<{ sent: number; failed: number }> {
    if (getApps().length === 0) {
      // Not a quiet no-op: with Firebase uninitialised NOTHING notifies, on any platform, and the
      // caller's own log would still read as a success.
      this.logger.warn('[SOCIAL_PUSH] Firebase not initialized - nothing sent');
      return { sent: 0, failed: 0 };
    }

    const traceId = this.makeTraceId('social-push');

    // THE ACCOUNT'S CATEGORY SWITCHES, decided before a single token is read: a muted category is
    // not sent at all, on any platform, so no client has to filter and nothing reaches Google or
    // Apple for it. Pushes belonging to no category (read frames, call rings) are never refused.
    const category = categoryOfDataPush(data);
    if (category) {
      const disabled = await readDisabledCategories(this.pushTokenRepo.manager, userId);
      if (disabled.has(category)) {
        this.logger.log(
          `[SOCIAL_PUSH][${traceId}] category=${category} disabled by user=${userId} - not sent`
        );
        return { sent: 0, failed: 0 };
      }
    }

    // A REACTION IN A PRIVATE CONVERSATION OBEYS THAT CONVERSATION'S LEVEL. A reaction is never a
    // mention, so both `mentions` and `none` refuse it - decided here, where the level is known,
    // rather than drawn and left for a device to withdraw. A SALON reaction carries
    // `groupId = channel_<id>`, which names no private conversation: the uuid guard is the fact that
    // says so, before any query (a uuid column refuses the string with 22P02).
    if (data.reaction === 'true' && isGroupUuid(data.groupId)) {
      const level = await readGroupNotificationLevel(
        this.pushTokenRepo.manager,
        data.groupId,
        userId
      );
      if (level !== 'all') {
        this.logger.log(
          `[SOCIAL_PUSH][${traceId}] reaction in group=${data.groupId} at level=${level} for user=${cutUserId(userId)} - not sent`
        );
        return { sent: 0, failed: 0 };
      }
    }

    const pushTokens = await this.pushTokenRepo.find({ where: { userId } });

    if (pushTokens.length === 0) {
      this.logger.log(`[SOCIAL_PUSH][${traceId}] No token for user=${userId}`);
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    for (const pt of pushTokens) {
      // ONE HALF PER TOKEN, BECAUSE THE PLATFORM IS KNOWN HERE - the duplication `sendFcmForQueued`
      // stopped for its own pushes. Every token used to receive the data map AND an APNs payload the
      // same fields are spread into, so an inlined ciphertext travelled twice in one message and
      // FCM sized the pair. iOS needs the APNs block (a data-only push never wakes the extension);
      // Android reads the data map (onMessageReceived fires in the background) and nothing else.
      try {
        let half: { inlined: boolean; bytes: number };
        if (pt.platform === 'ios') {
          const ios = buildInternalApnsHalf(title, body, data, inline, pt.locale);
          half = ios;
          await getMessaging().send({
            token: pt.token,
            apns: {
              payload: ios.payload.payload,
              headers: {
                'apns-push-type': ios.payload.pushType,
                'apns-priority': String(ios.payload.priority),
              },
            },
          });
        } else {
          const android = buildInternalAndroidHalf(title, body, data, inline);
          half = android;
          await getMessaging().send({
            token: pt.token,
            data: android.payload,
            android: { priority: 'high' },
          });
        }
        sent++;
        this.logger.log(
          `[SOCIAL_PUSH][${traceId}] sent user=${userId} device=${pt.deviceId} platform=${pt.platform} ` +
            `inline=${Object.keys(inline).length === 0 ? 'none' : half.inlined} bytes=${half.bytes}`
        );
        if (Object.keys(inline).length > 0 && !half.inlined) {
          // Not a failure - the device fetches the message and draws the fallback - but a budget
          // that is routinely too small is the fixed fields growing, and nothing else watches them.
          this.logger.log(
            `[PUSH_SIZE][${traceId}] inline group not inlined on ${pt.platform}: ${half.bytes}B without it, ` +
              Object.entries(inline)
                .map(([k, v]) => `${k}=${Buffer.byteLength(v, 'utf8')}B`)
                .join(' ')
          );
        }
      } catch (e) {
        failed++;
        if (this.isTerminalPushTokenError(e)) {
          await this.pushTokenRepo.delete({ id: pt.id });
          this.logger.warn(
            `[SOCIAL_PUSH][${traceId}] deleted invalid token user=${userId} device=${pt.deviceId}`
          );
        }
        this.logger.warn(
          `[SOCIAL_PUSH][${traceId}] FCM failed user=${userId} device=${pt.deviceId} err=${String(e)}`
        );
      }
    }
    return { sent, failed };
  }
}
