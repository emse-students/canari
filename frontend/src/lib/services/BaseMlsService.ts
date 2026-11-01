import type { GraineSignatureEngine } from '$lib/crypto/graineV2';
import { reportMlsSessionLost } from '$lib/mls-client/mlsSessionLoss';
import type {
  IMlsService,
  GroupMeta,
  UserGroupRow,
  MlsInitOptions,
  BulkIngestHandle,
  BulkIngestPhase,
  BulkIngestObserver,
  LocalStateOpenResult,
  StateLoadFailure,
} from '$lib/mls-client';
import {
  GroupDrainAbandonedError,
  LocalStateNotReadyError,
  MlsDeliveryApi,
  isKeystoreKeyUnavailable,
  isMlsManagerAbsent,
  resolveMlsPublicUrls,
} from '$lib/mls-client';
import {
  type MlsDecryptSession,
  createSequentialDecryptSession,
} from '$lib/mls-client/mlsDecryptSession';
import {
  DeliveryDeadlineError,
  DeviceRevokedError,
  DeviceRevokedByOwnerError,
  KEY_PACKAGE_ROUND_DEADLINE_MS,
  raceDeadline,
  NotAGroupMemberError,
  type GroupExclusions,
  type SentFrame,
  type AuthoredFrame,
  type GroupRosterBatch,
  type MlsDeliveryFetch,
  type CommitRemoval,
  type JoinDeclineOutcome,
  type GroupUserMemberRow,
  type GroupRosterAtGeneration,
  type PendingInvitationRow,
  WelcomeTargetUnknownError,
  isTerminalWelcomeRefusal,
  whyWelcomeUndeliverable,
  type RefusedAdmit,
  ADD_LOCK_WAIT_BOUND_MS,
  boundAddLockWait,
} from '$lib/mls-client/mlsDeliveryApi';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import {
  persistMlsStructuralCheckpoint,
  scheduleOutboundMlsPersist,
  noteInboundMlsFrame,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import {
  MAX_BURN_GENERATIONS,
  OwedSendBurnFailedError,
  commitPersisted,
  forgetSendRatchetEntries,
  noteFrameEmitted,
  resetSendRatchetLedger,
  sendRatchetDebt,
  sendRatchetEntries,
  sendRatchetKey,
  snapshotEmitted,
} from '$lib/mls-client/sendRatchetLedger';
import { sealedFrameEpoch } from '$lib/mls-client/sealedFrameEpoch';
import { fingerprintKeyPackage, type DatedKeyPackage } from '$lib/mls-client/keyPackages';
import { noteOwnLeafRefreshed, refreshLeafIfDue } from '$lib/mls-client/leafRefresh';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
import {
  MlsStateUnreadableNowError,
  MlsStateVerdictError,
  type MlsStateVerdictCode,
} from '$lib/mls-client/mlsStateSeal';
import { MlsStateLoadUntypedError } from '$lib/mls-client/mlsStateLoadError';
import type {
  DeviceMembershipRow,
  HistoryRequestOutcome,
  BaseRefreshOutcome,
  DecryptedApplication,
  IncomingDeliveryMeta,
  OneDeviceAddResult,
} from '$lib/mls-client/IMlsService';
import type { SkippedDevice, SkippedKeyPackage } from '$lib/mls-client/skippedKeyPackage';
import {
  DeviceTrustRefusedError,
  isDeviceTrustRefusal,
  verdictAdmits,
  type DeviceEvent,
  type DevicePin,
  type KeyPackageVerdict,
} from '$lib/mls-client/deviceTrust';
import {
  SenderMismatchError,
  setSenderMismatchReporter,
  type EnvelopeSender,
} from '$lib/mls-client/verifiedSender';
import { setUninvitedEntryReporter } from '$lib/mls-client/uninvitedEntry';
import { setIntegrityFindingReporter, type ForkFinding } from '$lib/mls-client/integrityFindings';
import {
  keyPackagePublication,
  type DeviceKeyPackageAnswer,
  type DeviceSignatureKeys,
} from '$lib/mls-client/deviceKeyPackage';
import { MlsPerGroupScheduler, type MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
  logMlsMetric,
} from '$lib/mls-client';
import {
  beginQueueDrainBench,
  recordQueueDrainMessage,
  finishQueueDrainBench,
  recordPendingMessagesFetched,
} from '$lib/mls-client/catchupBenchmark';
import { attemptCommitReplay, replayAndRecord } from '$lib/utils/chat/commitReplay';
import { markEpochGap, clearEpochGap, isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { runAsEpochAdvance, runAsEpochSend } from '$lib/utils/chat/epochSendBarrier';
import {
  parseServerTimestampMs,
  type DeliveryChannel,
  deliveryMetaOf,
  type DeliveryRepeatShape,
} from '$lib/mls-client/incomingDelivery';
import { classifyIncomingDecryptError } from '$lib/mls-client/mlsDecryptError';
import { noteKeyGroupFrameLost } from '$lib/mls-client/keyGroupFrameLosses';
import {
  channelScope,
  sameScope,
  scopeKey,
  scopeLabel,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';
import {
  dischargeRefusedBacklog,
  noteUnackedFrame,
  refusedBacklogMark,
  rearmRefusedBacklog,
  reportUnackedFrames,
  takeGroupAwaiting,
  takeGroupsAwaiting,
  type UnackedReason,
} from '$lib/mls-client/messagePipeline/unackedFrames';
import { getToken, SessionEndedByDeviceRevocationError } from '$lib/stores/auth';
import { productionDeliveryApi } from '$lib/mls-client/productionDeliveryApi';
import {
  GatewayOpenAbandonedError,
  type GatewaySocketOpen,
} from '$lib/mls-client/gatewaySocketOpen';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import {
  checkpointWroteNothing,
  fromBase64,
  MlsStateWriteRefusedError,
  sameBytes,
  toBase64,
  type MlsStateWriteLatch,
} from '$lib/utils/hex';
import { m } from '$lib/paraglide/messages';
import { showPinnedToast } from '$lib/stores/toast.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';
import {
  MAX_REFUSED_ROTATION_RELOADS,
  REFUSED_ROTATION_RELOADS_KEY,
  forgetRefusedRotationReloads,
} from '$lib/mls-client/refusedRotationReloads';
import { isTransportFailure, TransportFailureError } from '$lib/utils/transportFailure';
import type {
  DistributionFrameHandler,
  DistributionGroupInfoTransport,
  WelcomeRequestAnswer,
  DistributionSeat,
  DistributionGapListener,
  DistributionGapVerdict,
  DistributionGroupStore,
  ExternalJoinOutcome,
  GraineRunReading,
} from '$lib/mls-client/IMlsService';
import { dropGroupState } from '$lib/utils/chat/dropGroupState';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';
import {
  commitPendingHistoryMarks,
  noteFrameConsumed,
  snapshotPendingHistoryMarks,
} from '$lib/utils/chat/history';
import { sanitizeForLog } from '$lib/utils/logSanitize';
import { recordAbandonedDevice, retireAbandonedDevices } from '$lib/mls-client/abandonedDevices';
import { forgetRefusedDevicesOf } from '$lib/mls-client/refusedDevices';
import { recordWelcomeSent } from '$lib/utils/chat/welcomeSent';
import { isWelcomeOwed, readWelcomeOwedFromSeat } from '$lib/utils/chat/welcomeOwed';
import { commitRemovals, parseDeviceIdentity } from '$lib/mls-client/commitAdmits';
import {
  CommitRefusedError,
  SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS,
  SEAT_CLAIM_OVERTAKEN_REASON,
  COMMIT_LOCK_BUDGET_SPENT_REASON,
  ADMIT_REFUSED_REASON,
} from '$lib/mls-client/CommitRefusedError';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { commitRateLimitRemainingMs, noteCommitRateLimited } from '$lib/mls-client/commitRateLimit';
import {
  CommitOutcomeUnknownError,
  AcceptedCommitNotMergedError,
  CommitStageNotSavedError,
  FollowerTabCommitError,
  PreviousCommitUnresolvedError,
  StagedCommitPendingError,
  composeSubmission,
  encodeIntent,
  invitationOf,
  isDefinitiveCommitRefusal,
  refusesOnlyThisRequest,
  resubmissionVerdict,
  COMMIT_LOCK_HOLD_BUDGET_MS,
  commitLockHoldEndsAt,
  mayStartCommitRequest,
  type CommitIntent,
  type CommitInvitation,
  type CommitSubmission,
  type OwedWelcome,
  type PendingSubmissionRead,
  type ResubmissionVerdict,
  type StagedRecord,
} from '$lib/mls-client/commitSubmission';
import {
  listOwedInvitations,
  OwedInvitationNotRecordedError,
  owesInvitationIn,
  RACE_REFUSAL_REASON,
  recordOwedInvitation,
  settleOwedInvitation,
  type LostInvitationCause,
  type OwedInvitationReplanner,
  type ReplanVerdict,
  type UnrecordedInvitationTeller,
} from '$lib/mls-client/owedInvitations';
import {
  claimAddLockMarker,
  clearAddLockMarker,
  markAddLock,
} from '$lib/mls-client/addLockMarkers';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * How many times {@link BaseMlsService.externalJoin} may re-read the base and resubmit.
 *
 * A BOUND, NOT THE TERMINATION CONDITION. The only refusal it exists for is `concurrent_commit`,
 * where the commit lock was busy and the base may legitimately have moved by the next read; a base
 * that is behind the group's epoch ends the loop on that fact, whatever this number is.
 */
const EXTERNAL_JOIN_MAX_ATTEMPTS = 3;

/**
 * Whether a failed commit submission is the server's 409 `SEAT_CLAIM_OVERTAKEN`: a whole-commit
 * refusal that advanced nothing, read off the typed status and code, never off the message.
 */
function isSeatClaimOvertaken(e: unknown): boolean {
  return e instanceof ApiRefusalError && e.status === 409 && e.code === 'SEAT_CLAIM_OVERTAKEN';
}

/**
 * Answers a definitive refusal `e` of `groupId`'s commit staged on `baseEpoch`: `true` when it was a
 * `409 SEAT_CLAIM_OVERTAKEN` the commit transaction may rebuild from (the stage is cleared through
 * `clear`, and `attempt` is below the bound), `false` for any other refusal, left to the caller. On
 * the last attempt, or when the stage could not be cleared (a rebuild would fail on it), it throws
 * the typed refusal.
 */
async function rebuildOnOvertakenClaim(
  clear: () => Promise<void>,
  groupId: string,
  baseEpoch: number,
  attempt: number,
  e: unknown
): Promise<boolean> {
  if (!isSeatClaimOvertaken(e)) return false;
  const last = attempt >= SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS;
  console.warn(
    `[COMMIT] ${groupId.slice(0, 8)}... refused at epoch ${baseEpoch}: an unrelated eviction overtook its seat claim - staged commit rolled back, ` +
      (last
        ? `attempt ${attempt}/${SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS}, giving up`
        : `rebuilding (attempt ${attempt}/${SEAT_CLAIM_OVERTAKEN_MAX_ATTEMPTS})`)
  );
  // Not rebuilt on a commit that is still staged: the next stage would fail on it.
  const cleared = await clear().then(
    () => true,
    (clearErr: unknown) => {
      console.error(
        `[COMMIT] ${groupId.slice(0, 8)}... could not roll back the overtaken commit:`,
        String(clearErr).slice(0, 120)
      );
      return false;
    }
  );
  if (!last && cleared) return true;
  throw new CommitRefusedError(SEAT_CLAIM_OVERTAKEN_REASON, baseEpoch, baseEpoch);
}

/**
 * How many times one join may read the device's published-KeyPackage fact while rounds keep
 * settling and it stays absent or revoked. A counter per attempt, not a clock: it is what ends the
 * loop when every pass is woken by a round that did not make the fact true.
 */
const EXTERNAL_JOIN_FACT_PASSES = 6;

/**
 * External joins running now, per service instance then per group. A WeakMap so the state is the
 * instance's own and vanishes with it; entries live only for the span of one call.
 */
const externalJoinFlights = new WeakMap<object, Map<string, Promise<ExternalJoinOutcome>>>();

/**
 * Abstract base class shared by WebMlsService (WASM) and TauriMlsService (Rust native).
 *
 * Contains every field and method that is identical between the two platforms:
 * - All `/api/mls/*` delivery REST wrappers (delegated to {@link MlsDeliveryApi})
 * - WebSocket callback registrations (onMessage, onDisconnect, etc.)
 * - Queue plumbing (enqueueMessage, waitForMessageQueueIdle, processQueue, fetchPendingMessages)
 * - Event-driven re-fetch of frames the handler left unacknowledged (refetchFramesLeftBehind)
 * - Lifecycle boilerplate (init promise dedup, destroy base listeners)
 *
 * Platform-specific code lives exclusively in the subclasses:
 * - WebMlsService: WASM client, key-package worker, browser WebSocket
 * - TauriMlsService: invoke() calls, native WebSocket, epoch/group caches
 */
/**
 * The value {@link BaseMlsService.userId} holds before a session has resolved one.
 *
 * It is a NON-IDENTITY, not a user, and it is exported because the difference has to be checkable
 * from outside this file: the server was once sent this literal and stored it as a group member.
 */
export const UNRESOLVED_USER_ID = 'unknown';

/**
 * The value {@link BaseMlsService.deviceId} holds before {@link BaseMlsService.resolveDeviceId}
 * has run. Same contract as {@link UNRESOLVED_USER_ID}, and the same reason for being named.
 */
export const UNRESOLVED_DEVICE_ID = 'pending';

/**
 * Thrown when a seam that publishes an identity is reached before that identity exists.
 *
 * Typed rather than a message, because the ONE call site that must tell this apart from a network
 * failure is the one deciding whether to retry: an unresolved identity resolves on its own and the
 * next cycle succeeds, where a 500 does not.
 */
export class UnresolvedIdentityError extends Error {
  constructor(
    readonly seam: string,
    readonly field: 'userId' | 'deviceId'
  ) {
    super(`${seam} refused: ${field} is still the unresolved placeholder`);
    this.name = 'UnresolvedIdentityError';
  }
}

/**
 * Refuses to publish an identity that does not exist yet.
 *
 * WHY IT IS A THROW AND NOT A SKIP: on 2026-08-27 a client reached `updateInvitationStatus` with
 * `userId = 'unknown'` and `deviceId = 'pending'` and the server stored the pair as an ACTIVE
 * member of a real conversation - one second before the two real members joined. For 134 minutes
 * the placeholder held the peer's place while both of the peer's own devices sat `pending`, and
 * every message between them was lost. The class already knew both values were non-identities and
 * guarded on them in four other places; these seams did not.
 *
 * The caller may swallow it - most of these calls are fire-and-forget and are re-driven on the
 * next cycle, by which time the identity exists. What must NOT happen is the value reaching the
 * server, because a roster cannot tell a placeholder from a member.
 */
function assertResolvedIdentity(seam: string, userId: string, deviceId: string): void {
  if (userId === UNRESOLVED_USER_ID || !userId) {
    console.error(`[IDENTITY] ${seam} called before the userId resolved - refused`);
    throw new UnresolvedIdentityError(seam, 'userId');
  }
  if (deviceId === UNRESOLVED_DEVICE_ID || !deviceId) {
    console.error(`[IDENTITY] ${seam} called before the deviceId resolved - refused`);
    throw new UnresolvedIdentityError(seam, 'deviceId');
  }
}

/**
 * The recovery each verdict about a saved state's bytes maps to - one table for every source of
 * {@link MlsStateVerdictError}: the web's v2 opener, `mls-core`'s deterministic reader, and
 * `mls-core` through the WASM constructor or the Tauri `initialiser_mls` (typed at the boundary).
 */
const STATE_LOAD_FAILURE_OF_VERDICT: Record<MlsStateVerdictCode, StateLoadFailure> = {
  STATE_ALTERED: 'altered',
  STATE_KEY_MISMATCH: 'rotated',
  STATE_UNDECRYPTABLE: 'undecryptable',
  IDENTITY_MISMATCH: 'mismatch',
};

/**
 * The admits an ACCEPTED commit's answer says the gate did not record (`refusedAdmits`) - each said
 * once, at debug unless it bars the Welcome - and of them the ones no Welcome can reach ({@link whyWelcomeUndeliverable}) -
 * returned, so the merge owes them nothing and the caller sends them nothing.
 *
 * NEVER LEARNED BY FAILING (DEV-3, 2026-10-25): a device its owner revoked while a member's Add was
 * in flight is dropped by the gate (`no_key_package`), and the member still sent it a Welcome,
 * which came back a 500 and stayed owed for every later connection. The answer had said it first.
 * The same held for a person a key group's gate refused (`not_entitled`, RM-5 2026-10-26): the
 * Welcome went out and came back `403 WELCOME_TARGET_NOT_MEMBER`, logged as an error.
 * The leaf stays in the tree with no seat, and the stray sweep removes it.
 */
function undeliverableAdmits(groupId: string, refused: RefusedAdmit[] | undefined): RefusedAdmit[] {
  if (!refused?.length) return [];
  const short = groupId.slice(0, 8);
  const undeliverable: RefusedAdmit[] = [];
  for (const r of refused) {
    const who = `${sanitizeForLog(r.userId).slice(0, 8)}:${sanitizeForLog(r.deviceId)}`;
    const why = whyWelcomeUndeliverable(r.reason);
    if (why !== null) {
      undeliverable.push(r);
      console.log(
        `[COMMIT] ${short}... ${who} NOT admitted by the gate (${r.reason}: ${why}) - no Welcome ` +
          'is owed or sent; its leaf has no seat and the stray sweep removes it'
      );
    } else {
      // At debug: `already_active` is an ordinary answer to a re-Add, not news on every commit.
      console.debug(
        `[COMMIT] ${short}... the gate did not record the admit of ${who} ` +
          `(${sanitizeForLog(r.reason)}) - its Welcome is sent and answered as before`
      );
    }
  }
  return undeliverable;
}

/**
 * A one-device Add's answer, from its commit transaction: the Welcome, unless the gate did not admit
 * `device` for a reason no Welcome gets past - then `notAdmitted` says why and no Welcome is handed
 * out, since the merge owed it none ({@link undeliverableAdmits}).
 */
function oneDeviceAddResult(
  result: { welcome?: Uint8Array; ratchetTree?: Uint8Array; notAdmitted: RefusedAdmit[] },
  device: { userId: string; deviceId: string }
): OneDeviceAddResult {
  const refusal = result.notAdmitted.find(
    (r) => r.userId === device.userId && r.deviceId === device.deviceId
  );
  return refusal
    ? { ratchetTree: result.ratchetTree, notAdmitted: refusal.reason }
    : { welcome: result.welcome, ratchetTree: result.ratchetTree };
}

export abstract class BaseMlsService implements IMlsService {
  // ── Platform identity ─────────────────────────────────────────────────────
  protected readonly platform: 'web' | 'tauri';

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onChannelEvent?: (event: { type: string; data: unknown }) => void;

  protected messageCallback:
    | ((
        senderId: string,
        content: Uint8Array,
        groupId?: string,
        isWelcome?: boolean,
        ratchetTreeBytes?: Uint8Array,
        isCommit?: boolean,
        deliveryMeta?: IncomingDeliveryMeta
      ) => Promise<boolean>)
    | null = null;

  protected disconnectCallback: (() => void) | null = null;

  protected welcomeRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;

  /**
   * Installed by the session so this device can republish a group's external-join base when another
   * device asks. Read-only for the tree: no lock, no epoch change, nothing to merge.
   */
  protected baseRefreshRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | undefined;
  protected historyRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;

  protected welcomeProcessedCallback: ((groupId?: string) => void) | null = null;

  /**
   * Raised when the server says THIS device has been revoked, while it is still connected.
   *
   * Distinct from the revocation the key-package path already handles: that one is discovered by
   * asking, on the next enrolment, and answered by rotating to a fresh identity. This one arrives
   * unprompted at the moment its owner deletes the device, and the answer is the opposite - there
   * is no identity to continue under, so the session ends and the device is returned to a fresh
   * install.
   */
  protected deviceRevokedCallback: (() => void) | null = null;

  // ── URLs & identity ───────────────────────────────────────────────────────
  protected baseUrl: string;
  protected historyUrl: string;
  protected userId: string = UNRESOLVED_USER_ID;
  protected deviceId: string = UNRESOLVED_DEVICE_ID;

  /**
   * The key this device's state is sealed with RIGHT NOW - session state, not a call parameter.
   *
   * It used to be neither: every persistence call site carried its own copy, taken from whatever
   * scope it was written in, and one of those copies outlives the value it copied. The state
   * persister is the clearest case - `setupMessageHandler` builds it once per login, from
   * `ctx.getDeviceKey()` read at that moment, and nothing rebuilds it. Change the PIN mid-session
   * and `performPinChange` re-seals the state under the new key, updates the vault and the
   * keystore, and leaves that persister holding the OLD one; the next checkpoint - any commit, any
   * bulk-ingest end - overwrites the correctly sealed blob with one sealed under a key this device
   * has stopped using. On the next launch the state will not open, and the account is told its PIN
   * was changed on another device: on the very device that changed it.
   *
   * So there is ONE owner, and it is the object whose state is being sealed. {@link init} sets it,
   * {@link changeDeviceKey} moves it, and {@link persistCheckpoint} takes no key at all - a caller
   * cannot pass a stale one if it cannot pass one. {@link openLocalStateWithKey} sets it to the key
   * that opened the state, and the recovery's `changeDeviceKey` moves it before the login that
   * follows, so that login finds the field already right and its early return costs nothing.
   *
   * **AN EMPTY STRING IS A VALUE HERE, NOT A MISSING ONE - do not add a guard that refuses it.**
   * The Tauri biometric path calls {@link init} with an empty key on purpose and lets the native
   * side resolve the real one from the platform keystore (see `resolveSessionDeviceKey`), so
   * refusing to checkpoint without a key would break unlock-by-biometrics on both mobile platforms.
   * Every caller passed that same empty string before this field existed; carrying it changes
   * nothing, and rejecting it would.
   */
  private currentDeviceKeyB64 = '';

  // ── Delivery REST client ──────────────────────────────────────────────────
  protected readonly delivery: MlsDeliveryApi;

  // ── Graine key-distribution groups ────────────────────────────────────────
  /**
   * Group id -> the roster it carries: a community, or ONE private salon of it.
   *
   * It exists because a distribution group's external-join base does not live where every other
   * group's does. Chat-delivery gates `group-info` on a `dm_group_members` row, and this group has
   * none by construction - it is entered by external commit and authorized by membership of the
   * scope, a fact only social-service holds. So the base is fetched and published through
   * social-service, and this map is how the MLS layer knows which of the two it is looking at
   * without asking.
   *
   * The value is the whole scope and not a workspace id: since 2026-08-19 a private salon has its
   * own group, and a map that could only name a community would have had to guess which of the two
   * a group was - the guess being exactly the sharing the salon scope removes.
   */
  private readonly distributionScopeByGroup = new Map<string, DistributionScope>();

  /**
   * Groups the SERVER has said are distribution groups, whose scope this session cannot yet name.
   *
   * TWO QUESTIONS, AND ONLY ONE OF THEM NEEDS THE SCOPE. "Is this a distribution group" is
   * answerable from the `dm_groups` row alone; "which roster is it" is not, because a salon's scope
   * carries its community and the row cannot - chat-delivery does not own `channels`. Holding both
   * answers in the map above made the easy question inherit the hard one's precondition: a salon's
   * group whose community this session had not loaded answered `isDistributionGroup() === false`,
   * although the server had just said otherwise and the sweep had just kept it on that basis.
   *
   * That is a discriminator dropped in transit, and it is not harmless: every consumer of the
   * predicate - the sweep, the frame router, the history reconciliation - was then wrong about that
   * group for the rest of the session. Recorded here instead, so the cheap answer stops waiting on
   * the expensive one.
   */
  private readonly knownDistributionGroups = new Set<string>();

  /**
   * Groups this device CREATED whose base is not arbitrated yet - held locally, not usable yet.
   *
   * A THIRD STATE THE CODE USED TO SPELL AS THE SECOND. `distributionEpochFor` asks "is the group
   * held locally" and reads the answer as "may seeds ride it". Between {@link createGroup} and the
   * server's verdict on the first publish those two differ: the group is in `getLocalGroups()`, so
   * it answers epoch 0, while it may still be thrown away for having lost the race.
   *
   * A send landing in that window mints an outbound Graine session against the doomed group and
   * distributes the seed into it. `forgetGroup` then takes the session with the group, and whatever
   * it sealed is unreadable for ever - by its own author included, which is how it is noticed.
   *
   * Measured 2026-08-27 on the COMM rung: two devices of one account both found a salon
   * uninitialised, the loser recovered exactly as designed, and its already-minted session did not.
   * The comment on {@link ensureDistributionGroup} asserted the window was empty - "this runs
   * before any seed is sent" - and nothing enforced it. This set is that enforcement, and it lives
   * exactly as long as the window: see the `finally` that clears it.
   */
  private readonly unsettledDistributionGroups = new Set<string>();

  /** Set once at wiring time; see {@link setDistributionGroupInfoTransport}. */
  private distributionGroupInfo: DistributionGroupInfoTransport | null = null;

  /** Set once at wiring time; see {@link onDistributionFrame}. */
  private distributionFrameHandler: DistributionFrameHandler | null = null;

  /** Set once per session; see {@link setDistributionGroupStore}. */
  private distributionGroupStore: DistributionGroupStore | null = null;

  /**
   * The groups this device held when {@link hydrateDistributionGroups} ran - the population the
   * stored registry was supposed to name before the first drain.
   *
   * It exists for ONE judgement: whether a key group identified later was one this start-up should
   * already have known. If it was, its refused frames are the boot race coming back, and the line
   * that re-fetches them says so at a level that accuses (see {@link collectFramesLeftForKeyGroup});
   * a group first joined in this session is the ordinary case and says so quietly.
   */
  private readonly heldAtHydration = new Set<string>();

  /** Resolves {@link initialDrain}; null once it has. */
  private resolveInitialDrain: (() => void) | null = null;

  /** See {@link whenInitialDrainSettled}. Created with the service, so one per session. */
  private readonly initialDrain = new Promise<void>((resolve) => {
    this.resolveInitialDrain = resolve;
  });

  /** The {@link verifyDistributionEpoch} checks still answering, by group. Deleted as each settles. */
  private readonly distributionEpochChecks = new Map<
    string,
    Promise<'current' | DistributionGapVerdict>
  >();

  /**
   * Per key group in a gap, the epoch that CLOSES it.
   *
   * A commit that applies used to clear the gap on its own, which is right for one missing commit
   * and wrong for eight: the first of them lifted the mark with seven still to come, and a seed
   * sealed then went out at an epoch every current member had left. Absent means "no target
   * known", and then the old rule stands.
   */
  private readonly distributionGapTarget = new Map<string, number>();
  /** Key groups whose eviction the listener was told of - see {@link tellEvictedOnce}. */
  private readonly evictionTold = new Set<string>();

  /** Set once at wiring time; see {@link onDistributionGapVerdict}. */
  private distributionGapListener: DistributionGapListener | null = null;

  // ── Init dedup ────────────────────────────────────────────────────────────
  protected initPromise: Promise<void> | null = null;
  /** True when MLS is initialized without an existing state blob (fresh device). */
  protected freshStart = false;

  /**
   * Fingerprints of every key package THIS process has published, so
   * {@link reconcilePublishedKeyPackages} can never purge one of them.
   *
   * Per-process and deliberately not durable: the claim it supports is "this process minted these
   * bytes and therefore holds their private key", which is only true of this process. A durable
   * version would assert something it cannot know after a restart, which is precisely the mistake
   * the guard exists to catch.
   */
  private readonly publishedThisSession = new Set<string>();
  /** Epoch ms of the last {@link republishKeyMaterial} run, used to debounce it. */
  private lastKeyMaterialRepublish = 0;
  /**
   * The key package round that is running RIGHT NOW (mint, checkpoint, publish), or `null`.
   *
   * It exists so an external join can wait for the one thing the commit gate demands of a device
   * before it will activate a membership: a static KeyPackage on the server. See
   * {@link externalJoin} for the production measurement. Per-process, and held only for the span of
   * one {@link generateKeyPackage} call, so it is a fact about NOW and never a "done" flag.
   */
  private keyPackageRoundInFlight: Promise<unknown> | null = null;

  /**
   * How many key package rounds are running RIGHT NOW. A count, not the field above: rounds overlap
   * (boot, `republishKeyMaterial`, a join starting one) and the older one settling must not make
   * the newer one invisible.
   */
  private keyPackageRoundsActive = 0;

  /**
   * Monotonic count of rounds that have SETTLED, success or failure. A reader captures it BEFORE
   * asking the server and compares it before parking: a round that settled during the read is
   * the wake-up the reader would otherwise have missed (the answer in hand predates it).
   */
  private keyPackageRoundsSettled = 0;

  /** The most recent failed round and the settle count it ended at, for the joins it concerns. */
  private lastKeyPackageRoundFailure: { settled: number; error: unknown } | null = null;

  /**
   * Joins parked until a key package round settles (see {@link awaitOwnKeyPackagePublished}). An
   * EVENT, not a clock. Woken with `true` when the client is torn down, so none outlives it.
   */
  private ownKeyPackageUnverifiedReported: string | null = null;

  private keyPackageRoundWaiters: Array<(tornDown: boolean) => void> = [];

  // ── Timers & event handlers ───────────────────────────────────────────────
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected _visibilityHandler: (() => void) | null = null;
  protected _onlineHandler: (() => void) | null = null;
  /** Unsubscribes the native foreground listener (`onAppForegroundChange`); null when none. */
  protected _foregroundUnsubscribe: (() => void) | null = null;

  // ── Message queue ─────────────────────────────────────────────────────────
  /** Per-conversation queues with round-robin scheduling and a global MLS mutex. */
  protected readonly messageScheduler: MlsPerGroupScheduler;

  /**
   * Deliveries taken in, by the server's queue id, and whether this device is finished with them.
   *
   * TWO CHANNELS CARRY THE SAME ROW AND ONE OF THEM IS ALWAYS LATE. A frame is pushed live over the
   * socket and it is also listed by the pull, and the acknowledgement that removes it server-side
   * cannot land before the pull that was already in flight. Measured on production during COMM-4 on
   * 2026-08-25, at boot, one second apart: `qId=d4ecf0fe` drained from the socket and absorbed, then
   * `[PENDING] Fetched 1 pending messages` handed the identical row back and the second decrypt
   * reported `SecretReuseError` on generation 0 of an epoch already read - which is the ratchet
   * refusing to spend a secret twice, and correct.
   *
   * SO THE DELIVERY IS IDENTIFIED, AND ENTERS ONCE. The queue id is the row's identity, given by the
   * server, and this map is the state that makes taking it in idempotent - not a flag saying a frame
   * "was handled", which would answer a different question and lag the ratchet. Deduplicating here
   * rather than at either caller is deliberate: both channels are legitimate, neither can know what
   * the other received, and the overlap is deleted at the ONE seam they share.
   *
   * `queued` AND `done` ARE DIFFERENT ANSWERS TO A REPEAT. A row this device has acknowledged is
   * acknowledged AGAIN and not decrypted, because the only way it can be offered after an ack is
   * that the ack never arrived, and dropping it silently would leave it pending for ever. A row still
   * in the queue needs nothing: the copy already there will ack it.
   *
   * A ROW LEFT DELIBERATELY UNACKNOWLEDGED IS FORGOTTEN, which is the case this must not break. A
   * frame for an unknown group is processed, not acked, and re-fetched when its Welcome lands - so
   * remembering it would make that re-fetch a no-op. The entry is dropped exactly where the ack
   * decision says no.
   */
  private readonly deliveries = new Map<string, 'queued' | 'done'>();

  /** Persistence-only window: no UI buffering, no overlay (default for {@link withMlsBulkIngest}). */
  /** How many delivery ids {@link rememberDelivery} keeps. See its doc for why it is bounded. */
  private static readonly DELIVERY_MEMORY = 512;

  private static readonly PERSIST_ONLY_PHASE: BulkIngestPhase = {
    bufferUi: false,
    showOverlay: false,
  };

  /** Lifecycle observers of bulk-ingest windows (MLS state persister, UI render buffer). */
  private readonly bulkIngestObservers: BulkIngestObserver[] = [];

  /**
   * Open windows by handle, so {@link endBulkIngest} replays the exact phase ITS open used. A map
   * and not a stack: windows overlap without nesting (see `IMlsService.endBulkIngest`).
   */
  private readonly openBulkIngests = new Map<BulkIngestHandle, BulkIngestPhase>();
  private nextBulkIngestHandle: BulkIngestHandle = 1;

  constructor(platform: 'web' | 'tauri', fetchImpl?: MlsDeliveryFetch) {
    this.platform = platform;
    // Device ID is resolved per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    const urls = resolveMlsPublicUrls();
    this.baseUrl = urls.baseUrl;
    this.historyUrl = urls.historyUrl;
    this.messageScheduler = new MlsPerGroupScheduler(platform);
    this.delivery = productionDeliveryApi(this.historyUrl, fetchImpl);
    // Where a disagreement between a frame's envelope and its verified sender is READ: the console
    // of a client is collected nowhere, so the measurement is only a measurement once the server
    // logs it (`[SENDER_MISMATCH]`, channel-encryption section 21).
    setSenderMismatchReporter((report) =>
      this.delivery.deliveryPost('sender-mismatch', { ...report })
    );
    // The same for an entry no member made (`uninvitedEntry.ts`): the server's `[UNINVITED_ENTRY]`
    // line is the count the refusal of such an entry waits on.
    setUninvitedEntryReporter((report) =>
      this.delivery.deliveryPost('uninvited-entry', { ...report })
    );
    // The same for a fork or forged history (`[INTEGRITY]`): seen on a device, read on the server.
    setIntegrityFindingReporter((finding) =>
      this.delivery.deliveryPost('integrity-finding', { ...finding })
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialises the MLS identity, deduplicating concurrent calls via a shared promise.
   * Delegates actual init to the platform-specific {@link _initImpl}.
   */
  async init(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    if (this.initPromise) return this.initPromise;
    // BEFORE the impl, not after: `_initImpl` itself checkpoints on several of its recovery paths
    // (fresh start, identity rotation), and those writes need the key too.
    this.currentDeviceKeyB64 = deviceKeyB64;
    const p = this._initImpl(userId, deviceKeyB64, state, opts).then(() =>
      // BEFORE ANYTHING CAN SEND, and inside the promise every caller already awaits: a send racing
      // the repair would be encrypted at the very generation the repair exists to move past.
      this.reconcileSendRatchets()
    );
    this.initPromise = p;
    try {
      await p;
    } catch (e) {
      // Clear the cached promise so a failed init (e.g. undecryptable state pending
      // recovery) can be retried instead of returning the same rejection forever.
      this.initPromise = null;
      throw e;
    }
  }

  /**
   * Classifies why {@link loadStateWithKey} rejected, so `_initImpl` can pick a recovery that
   * actually addresses the cause.
   *
   * The distinction is not cosmetic. `undecryptable` means the blob would not OPEN; `mismatch`
   * means it opened and carries another device's identity, which no PIN can repair - so pausing
   * for a recovery the user cannot complete just strands them. Treating the two alike is what
   * surfaced a false "your PIN was changed on another device" to users who had never changed it.
   *
   * **IT READS A CODE, NOT A SENTENCE - AND UNTIL 2026-09-08 IT READ THE SENTENCE.** Both throws
   * are `mls-core`'s own, so there was never a dependency's prose to match; what there was, was a
   * default arm. `errStr.includes('identity mismatch') ? 'mismatch' : 'sealed'` gave every failure
   * the two needles did not recognise - a flipped byte, a truncated write, an error from a layer
   * nobody had thought about - the diagnosis "your PIN was changed on another device", together
   * with a recovery that cannot possibly work. Measured on CORRUPT-1 and CORRUPT-2: one byte XORed
   * in an 18.4 MB state, and the correct PIN was then refused five times over.
   *
   * **AND SINCE 2026-10-27 IT READS A TYPE, NOT EVEN A CODE IN A SENTENCE.** The codes were still
   * found by `includes` in the message, so any text naming one - a log line wrapped in an error, a
   * code quoted by an unrelated failure - acquired its recovery, `altered`'s irreversible rotation
   * included. Every boundary now carries the code as a FIELD and types it where it crosses
   * (`mlsStateLoadErrorOf`: `initialiser_mls`, the WASM constructor; the web's v2 opener throws the
   * type itself), and this reads `instanceof` alone.
   *
   * **AND `sealed` WAS RENAMED, BECAUSE THE NAME WAS THE CLAIM.** An AEAD tag that does not verify
   * has two explanations the blob alone cannot separate - sealed under a different device key, or
   * altered - and nothing stored beside it says which (`mls_autosave_ver` orders concurrent
   * flushes; it is not a key id). `undecryptable` is what is actually known. Separating the two
   * needs a key fingerprint in the envelope's own framing, which is a write-format change and
   * therefore a two-release sequence; see `docs/wiki/backlog.md`.
   *
   * **`rotated` AND `altered` ARE THE TWO HALVES OF `undecryptable` THAT A KEY FINGERPRINT
   * SEPARATES**, and since step 2 framed every save (2026-10-17) both fire. `mls-core` (the web's v2
   * opener for `STATE_KEY_MISMATCH` only - a WebCrypto refusal is `unreadable_now` unless `mls-core`
   * confirms the tag, `loadAndInitWasm`) throws `STATE_KEY_MISMATCH` when a FRAMED state's header names a key other than the
   * one in hand - the old PIN opens it - and `STATE_ALTERED` when the header names THE KEY IN HAND
   * and the tag still fails: the bytes were altered and no PIN ever will (CORRUPT-1, CORRUPT-2). No
   * guess, no failed decrypt to interpret - the blob says so. A LEGACY blob, written before the flip
   * and not yet rewritten, still answers `undecryptable`. `rotated` pauses for the old PIN; `altered`
   * rotates the device identity like a `mismatch` ({@link noPinOpensState}); the pre-v0.11.0
   * Argon2id retry keys off `undecryptable` alone and must NOT fire for a framed blob.
   *
   * `unknown` is the fourth answer and it is deliberately not folded into any of the others: it means the
   * failure came from somewhere this classifier has never been taught about. The caller treats it
   * as conservatively as `undecryptable` - nothing is destroyed - but it is LOGGED as unrecognised
   * rather than silently wearing a diagnosis, which is the whole of what went wrong here.
   *
   * `keystore_unavailable` is not a verdict on the state at all - biometric mode found no key to
   * open it with (a cancelled or refused sheet, a wiped entry). It is recognised here only so it
   * is not accused as unrecognised on every refused fingerprint; the caller destroys nothing for it
   * and hands the user to the PIN modal ({@link isKeystoreKeyUnavailable}).
   */
  protected classifyStateLoadFailure(error: unknown): StateLoadFailure {
    // A TYPE, read before any code: the web's WebCrypto refusal is not a verdict on the bytes, and
    // its message must never be able to reach a needle below.
    if (error instanceof MlsStateUnreadableNowError) return 'unreadable_now';
    // A TYPE too, from every source: the web's v2 opener, `mls-core`'s deterministic reader, and
    // `mls-core` through the WASM constructor or `initialiser_mls` - each verdict crossed its
    // boundary as a CODE field and was typed there (`mlsStateLoadErrorOf`), never read from prose.
    if (error instanceof MlsStateVerdictError) return STATE_LOAD_FAILURE_OF_VERDICT[error.code];
    if (isKeystoreKeyUnavailable(error)) return 'keystore_unavailable';
    // Untyped AT A BOUNDARY, which already accused it (`mlsStateLoadErrorOf` logs every untyped
    // answer once, because not every caller of a boundary classifies). A second line here would be
    // the same failure logged twice.
    if (error instanceof MlsStateLoadUntypedError) return 'unknown';
    // NOTHING BELOW READS TEXT. An error outside the closed set - `MlsStateLoadUntypedError`, or
    // anything thrown before a boundary typed it - is `unknown` whatever its message names: a
    // sentence containing `STATE_ALTERED` is not a verdict, and treating it as one would rotate an
    // identity on the strength of a word.
    //
    // ACCUSING, AND HERE RATHER THAN AT THE CALL SITES so that no future caller can forget it.
    // Reaching this arm means the state load failed for a reason `mls-core` does not type, and
    // the whole defect this classifier was rewritten for is an unrecognised failure passing
    // quietly as a diagnosis.
    console.warn(
      `[MLS] Unrecognised state-load failure - not typed by mls-core, so its cause is unknown ` +
        `and nothing will be destroyed on account of it: ${String(error).slice(0, 200)}`
    );
    return 'unknown';
  }

  /** Platform-specific init body (WASM load vs Tauri invoke). */
  protected abstract _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void>;

  /**
   * Platform-specific decrypt + client init for a given device key and (optional) saved state.
   * Throws on a wrong key / unusable state - and unlike {@link _initImpl} performs NO
   * fresh-start fallback, so callers can probe a candidate key non-destructively.
   * `this.userId` and `this.deviceId` must already be resolved.
   */
  protected abstract loadStateWithKey(
    deviceKeyB64: string,
    state?: Uint8Array,
    /** Tauri only: the state exists and the native side is to read it - {@link MlsInitOptions}. */
    stateOnDisk?: boolean
  ): Promise<void>;

  /**
   * Forgot-PIN-elsewhere recovery, first half: the account PIN was changed on another device, so
   * this device's local state is still sealed under the OLD key. Opens it with `deviceKeyB64`
   * (non-destructively - no fresh start, device id untouched, nothing written) and marks the client
   * initialised so a following {@link init}/login reuses it. The re-seal is {@link changeDeviceKey},
   * called by `performPinChange` only AFTER the local stores have moved - see there for why.
   *
   * A refusal carries WHY ({@link classifyStateLoadFailure}), because only one kind of refusal is
   * the old PIN's fault: `undecryptable` / `rotated` (the key does not open it). A state carrying
   * another device's identity, or a failure nothing here recognises, would refuse EVERY PIN - read as
   * "old PIN incorrect" it sent the user round the same keypad for ever. The decision is made here
   * and not from the message store, whose rows may sit under an even older key.
   */
  async openLocalStateWithKey(
    userId: string,
    deviceKeyB64: string,
    state: Uint8Array
  ): Promise<LocalStateOpenResult> {
    this.userId = userId;
    this.delivery.userId = userId;
    await this.resolveDeviceId(userId);
    try {
      await this.loadStateWithKey(deviceKeyB64, state);
    } catch (e) {
      const cause = this.classifyStateLoadFailure(e);
      console.warn(
        `[MLS] openLocalStateWithKey: the local state did not open (${cause}):`,
        String(e).slice(0, 160)
      );
      return { opened: false, cause };
    }
    // The state in memory is the one sealed under this key, so this key is what a checkpoint
    // taken before the re-seal must use.
    this.currentDeviceKeyB64 = deviceKeyB64;
    // A state opened is not a fresh start, whatever an earlier attempt on this client decided.
    this.freshStart = false;
    // THE SAME TWO STEPS `init` RUNS AFTER ITS LOAD, in the promise a concurrent `init` returns: set
    // BEFORE they are awaited, so no second `initialiser_mls` can start while they run, and the
    // ratchet burn happens before anything can send - a recovery opens a snapshot that may sit
    // behind sends the app made but never checkpointed (killed after them, PIN changed elsewhere),
    // and without the burn the next send re-used a spent generation.
    const ready = this.afterStateOpened().then(() => this.reconcileSendRatchets());
    this.initPromise = ready;
    try {
      await ready;
    } catch (e) {
      this.initPromise = null;
      console.error('[MLS] openLocalStateWithKey: the opened state could not be made ready:', e);
      throw e instanceof LocalStateNotReadyError ? e : new LocalStateNotReadyError(e);
    }
    return { opened: true };
  }

  /**
   * What a platform owes once a state has been opened OUTSIDE {@link init} - the recovery's
   * {@link openLocalStateWithKey}, which marks the client initialised so the login that follows
   * skips `_initImpl`. Anything `_initImpl` derives from the opened state must be derived here too,
   * or that login runs on caches describing no state at all. No-op where nothing is cached. A
   * failure THROWS: the open is refused rather than run on a cache known to be wrong.
   */
  protected async afterStateOpened(): Promise<void> {}

  /**
   * Whether {@link getLocalGroups} is known to describe the loaded state. A destructive repair that
   * reads it as "this group is not held" (a key-group row deleted, a conversation demoted) must ask
   * this first: an empty cache that was never filled says nothing about what the state holds.
   * True here; Tauri, whose cache is filled by a listing that can fail, answers from that listing.
   */
  heldGroupsKnown(): boolean {
    return true;
  }

  /**
   * Points every UNATTENDED unlock of this device at `newDeviceKeyB64` - the platform keystore
   * entry that biometric unlock and the background push read. Concrete and a no-op here: the web
   * has no keystore (its vault is `applyNewDeviceKeyLocally`'s). Tauri overrides it.
   *
   * Exists so a PIN change can move the unattended unlock BEFORE it moves any data: an unlock that
   * skips the server PIN check and still held the old key would open an MLS state not yet re-sealed
   * and run a session over stores already half moved - silently, with no recovery ever offered.
   *
   * Answers whether anything was written: `false` here, so a change interrupted before its vault step
   * knows nothing on this device moved.
   */
  async pointUnattendedUnlockAt(_newDeviceKeyB64: string): Promise<boolean> {
    return false;
  }

  /**
   * Releases the gateway socket for good (fenced: an open in flight assigns nothing, and no
   * {@link connect} opens one afterwards), removes shared event listeners and clears the heartbeat
   * timer. Calls {@link destroyPlatformResources} for subclass-specific teardown.
   */
  destroy(): void {
    // THE SOCKET GOES WITH THE CLIENT, AND NO OPEN LANDS AFTER IT. A failed login destroys the
    // client it built (`resetMls`) while the handshake it started beside the state load may still be
    // in its token fetch or its native connect. Without the fence that open landed on the destroyed
    // client, started its heartbeat, and held a socket nobody could reach any more: the next sign-out
    // pauses the CURRENT client only, and the plugin (or the browser) kept answering the gateway's
    // pings, so the device stayed online as the signed-out account. Certain from the code; that it is
    // what a TestFlight iPhone showed on 2026-10-25 (two sockets at the PIN gate, both alive after the
    // sign-out) is owed the app's own log. The pause sends `disconnect`: the presence goes at once.
    this.socketRetired = true;
    console.log('[WS] MLS client destroyed - its socket is released and no open may follow');
    this.pauseSocket();
    // NOTHING PARKED OUTLIVES THE CLIENT: a join waiting on a round that will never settle here
    // would hold its group's flight for ever and hand every later caller the same hung promise.
    this.wakeKeyPackageRoundWaiters(true);
    externalJoinFlights.get(this)?.clear();
    // Nor a wait for a drain this client will never see (the admission gate's parked asks).
    this.abandonGroupDrainedWaiters();
    // Nor a wake at the end of a lock the server refused: it would re-plan through a dead client.
    this.cancelAddLockExpiryWakes();
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // The work list of unacknowledged frames belongs to the session, not to this client: it is
    // dropped by `resetUnackedFrames` at logout, never here - the next client of the same session
    // still has to re-fetch what this one never acknowledged. (The socket itself went at the top.)
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    this._foregroundUnsubscribe?.();
    this._foregroundUnsubscribe = null;
    // A HELD FRAME BELONGS TO THE CLIENT THAT WAS GOING TO READ IT, and this destroy is that
    // client ending. Unlike the unacked work list above, nothing else can drain these: the gate
    // reopens on the next login against a different MLS state, and the server re-delivers any
    // payload frame that was never acknowledged. Counted rather than dropped in silence, because a
    // non-zero number here means a login gave up between opening its socket and being ready.
    if (this.heldFrames.length > 0) {
      console.warn(
        `[WS RCV] destroy with ${this.heldFrames.length} frame(s) still held - this session never became ready`
      );
      this.heldFrames = [];
    }
    this.destroyPlatformResources();
  }

  /** Override to release platform-specific resources (e.g. Worker, native WebSocket). */
  protected destroyPlatformResources(): void {}

  // ── WebSocket (platform-specific) ─────────────────────────────────────────

  /**
   * The device id the gateway socket of this document was LAST opened under, or `null` before the
   * first open. Written synchronously when an open starts ({@link openSocketUnderCurrentId}), so it
   * names the socket being opened as well as the one that is open; `isWsOpen()` says which.
   */
  private socketDeviceId: string | null = null;

  /** The latest queued socket step ({@link enqueueSocketStep}); may reject, and is never awaited bare. */
  private socketFlight: Promise<void> = Promise.resolve();

  /** How many queued socket steps have not settled. Zero means the next step runs synchronously. */
  private socketStepsPending = 0;

  /**
   * THE FENCE. Advanced by every {@link pauseSocket}; a step or an open that captured an older value
   * neither assigns a socket nor starts one. Without it a pause landing while a reopen awaited its
   * token or its native connect was followed by a live socket in a backgrounded or signed-out app.
   */
  private socketGeneration = 0;

  /** Set by {@link pauseSocket}, cleared when an explicit {@link connect} starts - the resume. */
  private socketPaused = false;

  /**
   * Set once, by {@link destroy}, and never cleared: a destroyed client opens no socket again. A
   * pause is lifted by the next {@link connect}; this is not, because nothing will ever pause a client
   * the holder has let go of - a socket it opened would outlive every sign-out.
   */
  private socketRetired = false;

  /** Settles the open in flight as abandoned; kept so a pause never leaves the queue to a deadline. */
  private abandonPendingOpen: ((reason: string) => void) | null = null;

  /**
   * Opens the gateway socket under the device id this document holds WHEN THE OPEN STARTS.
   *
   * ONE SOCKET STEP AT A TIME. Every open, and the reopen a rotation asks for
   * ({@link reopenGatewaySocketAfterRotation}), goes through one queue, because a platform open first
   * closes the socket it finds with its handlers detached: two opens in flight together left the
   * first one's promise to its own 15 s deadline, which then closed the SECOND socket. Queued, an
   * open that starts reads the outcome of the one before it. With nothing pending the open runs
   * synchronously, exactly as it did before the queue existed.
   *
   * THE FENCE IS TAKEN BY THE CALLER, BEFORE ITS TOKEN FETCH ({@link socketFence}): that await is
   * where a backgrounded phone parks a reconnect, and a pause landing in it must not be followed by
   * a socket. A `connect` whose fence a pause has passed - before the call or while it was queued -
   * settles as {@link GatewayOpenAbandonedError} without opening anything.
   */
  connect(token: string, fence: number): Promise<void> {
    if (fence !== this.socketGeneration) {
      console.log(
        '[WS] a connect whose token was fetched across a pause is dropped - the resume opens the socket'
      );
      return Promise.reject(new GatewayOpenAbandonedError('paused during its token fetch'));
    }
    // The destroy moved the fence, so a fence that still matches was taken AFTER it: the caller is
    // holding a client the holder let go of, which is a defect upstream, not a race.
    if (this.socketRetired) {
      console.error(
        '[WS] connect on a DESTROYED MLS client - its caller holds a client that was let go of; nothing opened'
      );
      return Promise.reject(new GatewayOpenAbandonedError('client destroyed'));
    }
    return this.enqueueSocketStep(() => {
      if (this.socketGeneration !== fence) {
        console.log('[WS] a connect queued before a pause is dropped - the pause owns the socket');
        return Promise.reject(new GatewayOpenAbandonedError('paused before it started'));
      }
      this.socketPaused = false;
      return this.openSocketUnderCurrentId(token, fence);
    });
  }

  /**
   * The fence a caller of {@link connect} takes BEFORE fetching its token, and hands back with it.
   * Every {@link pauseSocket} moves it, so a token fetched across a pause opens nothing.
   */
  socketFence(): number {
    return this.socketGeneration;
  }

  /**
   * Resolves once every socket step queued so far has run, and REJECTS with the last one's own
   * failure - a reopen fetches its own token, so a `SessionExpiredError` surfaces here as one.
   *
   * WHY IT EXISTS: the login starts its handshake beside the MLS state load (`startGatewayHandshake`),
   * and that load can ROTATE the device identity (a lost state re-enrolled, a credential that names
   * someone else). The rotation queues a reopen of the socket under the new id; the post-connect half
   * of the login waits here, so it runs on the socket that will carry this device, never on one that
   * carries the id this document has just abandoned.
   */
  async gatewaySocketSettled(): Promise<void> {
    if (this.socketStepsPending > 0) await this.socketFlight;
  }

  /**
   * Releases the socket until the next {@link connect}, and FENCES the queue: the generation moves,
   * so no step or open started before this assigns a socket afterwards, and an open still in flight
   * is settled as abandoned at once through its kept handle rather than by its deadline. See
   * {@link IMlsService.pauseSocket} for what the platform half does.
   */
  pauseSocket(): void {
    this.socketGeneration++;
    this.socketPaused = true;
    const abandon = this.abandonPendingOpen;
    this.abandonPendingOpen = null;
    if (abandon) {
      console.log('[WS] pause landed on a socket open still in flight - that open is abandoned');
      abandon('paused');
    }
    this.pausePlatformSocket();
  }

  private enqueueSocketStep(step: () => Promise<void>): Promise<void> {
    // A step that throws synchronously still settles THROUGH the queue, as a rejection.
    const runNow = (): Promise<void> => {
      try {
        return step();
      } catch (e) {
        return Promise.reject(e);
      }
    };
    const run = this.socketStepsPending === 0 ? runNow() : this.socketFlight.then(runNow, runNow);
    this.socketStepsPending++;
    const settled = (): void => {
      this.socketStepsPending--;
    };
    // Handling `run` here also keeps the stored copy from reporting an unhandled rejection: every
    // caller of `connect` still receives `run` itself, with its failure.
    run.then(settled, settled);
    this.socketFlight = run;
    return run;
  }

  /**
   * Starts ONE platform open under the current id, fenced by `generation`, and returns it raced
   * against its abandonment - so a pause settles it at once, whatever the platform is awaiting.
   */
  private openSocketUnderCurrentId(token: string, generation: number): Promise<void> {
    const deviceId = this.deviceId;
    this.socketDeviceId = deviceId;
    const cleanups: Array<() => void> = [];
    let abandon!: (reason: string) => void;
    const abandoned = new Promise<never>((_, reject) => {
      abandon = (reason) => {
        for (const cleanup of cleanups) cleanup();
        reject(new GatewayOpenAbandonedError(reason));
      };
    });
    this.abandonPendingOpen = abandon;
    let open: Promise<void>;
    try {
      open = this.openGatewaySocket({
        deviceId,
        token,
        isCurrent: () => this.socketGeneration === generation,
        onAbandon: (cleanup) => cleanups.push(cleanup),
      });
    } catch (e) {
      // A platform open that throws before returning its promise leaves no handle behind.
      this.abandonPendingOpen = null;
      return Promise.reject(e);
    }
    return Promise.race([open, abandoned]).finally(() => {
      if (this.abandonPendingOpen === abandon) this.abandonPendingOpen = null;
    });
  }

  /**
   * Re-opens the gateway socket under the id a rotation has just minted, when an open one still
   * carries the abandoned id. Queued behind any open in flight, so an open that STARTED under the
   * old id is replaced once it lands, whatever its timing against the rotation.
   *
   * The gateway routes by the id in the socket URL, so without this the live tab kept the abandoned
   * id until its next reconnect: every frame addressed to the new id went by queue and push only,
   * and the retirement of the old id was signalled (`device_revoked`) to this very socket.
   *
   * FENCED: a pause that lands after the rotation - before the step, during its token fetch or during
   * the open - leaves no socket; the resume opens under the current id. The token is fetched HERE,
   * so a refused refresh fails the step as itself (`SessionExpiredError`) rather than becoming an
   * unauthenticated open. A failed reopen leaves no socket - the old one was closed first - and is
   * reported on the disconnect seam when one is registered; a connection still being established
   * has none yet, and fails on {@link gatewaySocketSettled} instead (`openGatewayConnection`).
   */
  private reopenGatewaySocketAfterRotation(abandoned: string): void {
    const generation = this.socketGeneration;
    const fenced = (): boolean => this.socketGeneration !== generation || this.socketPaused;
    void this.enqueueSocketStep(async () => {
      const current = this.deviceId;
      if (fenced()) {
        console.log(
          `[WS] identity rotated -> ${sanitizeForLog(current)}: the socket is paused, no reopen - the resume opens under the new id`
        );
        return;
      }
      if (!this.isWsOpen()) {
        console.log(
          `[WS] identity rotated ${sanitizeForLog(abandoned)} -> ${sanitizeForLog(current)}: no gateway socket is open, the next open carries the new id`
        );
        return;
      }
      if (this.socketDeviceId === current) {
        console.log(
          `[WS] identity rotated -> ${sanitizeForLog(current)}: the gateway socket already carries it`
        );
        return;
      }
      const token = await getToken();
      if (fenced()) {
        console.log(
          `[WS] identity rotated -> ${sanitizeForLog(current)}: a pause landed during the token fetch, no reopen`
        );
        return;
      }
      // The socket may have closed, or been reopened, while the token was fetched.
      if (!this.isWsOpen() || this.socketDeviceId === this.deviceId) {
        console.log(
          `[WS] identity rotated -> ${sanitizeForLog(this.deviceId)}: the socket changed during the token fetch (open=${String(this.isWsOpen())}) - no reopen, the next open carries the new id`
        );
        return;
      }
      console.warn(
        `[WS] identity rotated: the gateway socket carries the abandoned id ${sanitizeForLog(
          this.socketDeviceId ?? '-'
        )} - reopening it under ${sanitizeForLog(current)}`
      );
      // The departure signal goes first, as on a pause, so the gateway drops the old id's presence
      // now rather than when it notices the close.
      this.sendDisconnect();
      await this.openSocketUnderCurrentId(token, generation);
    }).catch((e: unknown) => {
      if (e instanceof GatewayOpenAbandonedError) {
        console.log(`[WS] the reopen under the rotated id was abandoned (${e.reason})`);
        return;
      }
      if (this.disconnectCallback) {
        console.error(
          `[WS] reopening the gateway socket under the rotated id FAILED - reported as a lost socket: ${sanitizeForLog(String(e))}`
        );
        this.disconnectCallback();
        return;
      }
      // Not a second error line: the connection waiting on it (`openGatewayConnection`) reports it.
      console.debug(
        `[WS] reopen under the rotated id failed before any disconnect handler was registered - reported by the connection that waits on it: ${sanitizeForLog(String(e))}`
      );
    });
  }

  /**
   * The delete an abandoned id's retirement uses (`abandonedDevices.ts`): never while a socket of this
   * document still carries that id. The delivery service signals `device_revoked` to every socket of
   * the deleted id, and the live tab would receive a revocation addressed to itself. Waits for the
   * queued socket steps first - the rotation queued its reopen before it asked for the retirement -
   * and refuses otherwise, which keeps the id recorded for the next published round. The refusal is
   * a throw carrying its reason, so the retirement says it in its one line.
   */
  private async deleteAbandonedDevice(
    userId: string,
    deviceId: string
  ): Promise<{ status: string } | undefined> {
    try {
      await this.gatewaySocketSettled();
    } catch (e) {
      // Reported where the step ran; here only the socket it left behind matters.
      console.debug(
        `[MLS] retiring ${sanitizeForLog(deviceId)}: the last socket step failed (${sanitizeForLog(String(e))}) - reading the socket it left`
      );
    }
    if (this.isWsOpen() && this.socketDeviceId === deviceId) {
      throw new Error(
        'a gateway socket of this document still carries it - its revocation would be signalled to that socket'
      );
    }
    // RETIRED, NOT REVOKED: this install abandoned the id itself. Said explicitly, because the
    // server reads a delete without a reason as the OWNER's revocation - which would make a later
    // holder of the id (a reinstall restoring it) wipe itself instead of enrolling again.
    return this.deleteDevice(userId, deviceId, 'retired');
  }

  /** Retires every abandoned id of this account, through {@link deleteAbandonedDevice}. */
  private retireAbandonedIds(): void {
    void retireAbandonedDevices({
      userId: this.userId,
      liveDeviceId: this.deviceId,
      deleteDevice: (u, d) => this.deleteAbandonedDevice(u, d),
    });
  }

  /**
   * The platform half of {@link connect}: open the socket carrying `open.deviceId`. It re-checks
   * `open.isCurrent()` after every await and assigns nothing once it is false, and registers its
   * deadline and half-open socket with `open.onAbandon`.
   */
  protected abstract openGatewaySocket(open: GatewaySocketOpen): Promise<void>;
  abstract isWsOpen(): boolean;
  abstract sendDisconnect(): void;
  /** The platform half of {@link pauseSocket}: send `disconnect` and release the socket silently. */
  protected abstract pausePlatformSocket(): void;

  abstract sendTyping(groupId: string, isTyping: boolean): void;

  /**
   * What the `KeyPackage` label in the load-time composition line is made of, once per session.
   *
   * ABSTRACT rather than a default no-op: the two implementations read the same state through two
   * different bridges (a wasm call taking the caller's clock, a Tauri command reading the native
   * one), and a base-class no-op is how native came to have no census here at all - it had one
   * inside the awaited load instead, which is where the cost this removed was hiding.
   */
  abstract logKeyPackageCensus(): void;

  // ── The inbound gate ──────────────────────────────────────────────────────

  /**
   * FRAMES THAT ARRIVED BEFORE THE CLIENT THAT CAN READ THEM, HELD IN ARRIVAL ORDER.
   *
   * The socket handshake and the MLS state load have no data dependency in either direction -
   * `connect` sends a device id and a token, both of which exist before a byte of MLS state is
   * decrypted - so the login runs them concurrently and the socket comes up at about the instant
   * MLS becomes ready. Measured on production 2026-09-16: the handshake was 182 ms of a 1308 ms
   * cold start, spent entirely waiting behind a state it never reads.
   *
   * WHAT THAT CONCURRENCY OWES IS THIS QUEUE, AND IT IS THE WHOLE COST OF THE CHANGE. A socket open
   * before the MLS client exists can be handed a payload frame with nowhere to go, and the
   * gateway's delivery accounting does not distinguish "handed to a client" from "handled by one" -
   * so a dropped frame is a dropped message the server believes it delivered. The rule is the one
   * the revocation fix states: what must be preserved is not "both finish" but **nothing is
   * PROCESSED before the thing that can process it exists**.
   *
   * EVERY frame waits, not only the payload ones. A typing signal, a channel event and a
   * `welcome_request` alike reach callbacks that the same login registers, and an unregistered
   * callback drops its frame just as silently - so a rule per frame type would be several chances
   * to get one wrong, for no gain over a queue whose whole lifetime is the 182 ms it recovers.
   * Heartbeats are the single exception and they never reach here: both sockets answer
   * {@link resetHeartbeatCounter} and test `isHeartbeatFrame` in front of this gate.
   */
  private heldFrames: { msg: any; frameType: string }[] = [];

  /**
   * Whether {@link routeFrame} may run. False until {@link markInboundReady}.
   *
   * A BOOLEAN SET BY AN EVENT, NOT A CLOCK: there is no value here that could be wrong. It never
   * returns to false - a reconnect opens a socket for a client that already exists, and a session
   * that ends takes the whole service with it ({@link destroy} empties the queue).
   */
  private inboundReady = false;

  /**
   * Hands ONE parsed gateway frame to the handler its type names. Implemented per platform because
   * each socket parses its own transport; everything in front of it is shared.
   *
   * @param msg the parsed frame.
   * @param frameType `msg.type` when it is a string, `''` for a payload frame, which carries none.
   */
  protected abstract routeFrame(msg: any, frameType: string): Promise<void>;

  /**
   * The gate every non-heartbeat frame passes, on both platforms: route it, or hold it.
   *
   * @param msg the parsed frame.
   * @param frameType `msg.type` when it is a string, `''` for a payload frame.
   */
  protected async deliverFrame(msg: any, frameType: string): Promise<void> {
    if (this.inboundReady) {
      await this.routeFrame(msg, frameType);
      return;
    }
    this.heldFrames.push({ msg, frameType });
    console.log(
      `[WS RCV] holding ${sanitizeForLog(frameType || 'payload')} frame until MLS is ready ` +
        `(${this.heldFrames.length} held)`
    );
  }

  /**
   * Opens the inbound gate and replays everything the socket collected in front of it.
   *
   * CALLED ONCE PER LOGIN, by the only caller that can honestly say both preconditions hold: the
   * MLS client is initialised AND the inbound pipeline is registered. Both are needed - a client
   * with no `messageCallback` drains a payload frame into a `DROPPED` warning, which is the same
   * loss by a different route.
   *
   * THE DRAIN IS SEQUENTIAL AND ITS CALLER AWAITS IT, for one reason: arrival order is the only
   * order a Welcome and the Commit behind it may be processed in. Starting every replay at once
   * would leave the MLS mutex to serialise them in whatever order the microtask queue happened to
   * hold - which is arrival order today and need not be tomorrow.
   *
   * Idempotent, and silent when nothing was held, so a caller need not know whether a socket was
   * ever open.
   */
  async markInboundReady(): Promise<void> {
    if (this.inboundReady) return;
    this.inboundReady = true;
    const held = this.heldFrames;
    this.heldFrames = [];
    if (held.length === 0) return;
    console.log(`[WS RCV] MLS ready - draining ${held.length} held frame(s) in arrival order`);
    for (const { msg, frameType } of held) {
      try {
        await this.routeFrame(msg, frameType);
      } catch (e) {
        // PER FRAME, because the alternative is that one unroutable frame discards every frame
        // behind it - and these are precisely the frames that arrived while this client could not
        // answer for itself, which is the worst possible batch to lose as a group.
        console.error('[WS RCV] Failed to process a held WebSocket message:', e);
      }
    }
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  onMessage(
    callback: (
      senderId: string,
      content: Uint8Array,
      groupId?: string,
      isWelcome?: boolean,
      ratchetTreeBytes?: Uint8Array,
      isCommit?: boolean,
      deliveryMeta?: IncomingDeliveryMeta
    ) => Promise<boolean>
  ): void {
    this.messageCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
  }

  onWelcomeRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.welcomeRequestCallback = callback;
  }

  onBaseRefreshRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.baseRefreshRequestCallback = callback;
  }

  onHistoryRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.historyRequestCallback = callback;
  }

  onWelcomeProcessed(callback: (groupId?: string) => void): void {
    this.welcomeProcessedCallback = callback;
  }

  /** @see deviceRevokedCallback */
  onDeviceRevoked(callback: () => void): void {
    this.deviceRevokedCallback = callback;
  }

  /** Asks the server whether the named device is denylisted. `false` when the question cannot be reached. */
  isDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
    return this.delivery.isDeviceRevoked(userId, deviceId);
  }

  addBulkIngestObserver(observer: BulkIngestObserver): void {
    this.bulkIngestObservers.push(observer);
  }

  beginBulkIngest(phase: BulkIngestPhase = BaseMlsService.PERSIST_ONLY_PHASE): BulkIngestHandle {
    const handle = this.nextBulkIngestHandle++;
    this.openBulkIngests.set(handle, phase);
    for (const observer of this.bulkIngestObservers) {
      // Isolated for the same reason as the close below: one observer refusing to OPEN its window
      // must not stop the next from opening one it will be asked to close.
      try {
        observer.onBulkIngestStart(phase);
      } catch (e) {
        console.error('[QUEUE] bulk-ingest observer failed to start:', e);
      }
    }
    return handle;
  }

  async endBulkIngest(handle: BulkIngestHandle): Promise<void> {
    const phase = this.openBulkIngests.get(handle);
    if (!phase) {
      console.warn(
        `[QUEUE] endBulkIngest for window ${handle}, which is not open - ignored (closed twice?)`
      );
      return;
    }
    this.openBulkIngests.delete(handle);
    // Replay the exact phase the matching open used: start and end can never disagree.
    //
    // PER OBSERVER, and that is the whole point. These are independent subscribers - the encrypted
    // state persister and the UI render buffer - and they were being awaited in one bare loop, so
    // the FIRST to reject cancelled every one after it. The persister is registered first and
    // rethrows when a checkpoint fails, which would have left the UI observer's window open
    // forever: `messageCatchupDepth` never comes back down (the sync banner stays up for the rest
    // of the session) and `bulkIngestActive` stays raised, so every later inbound message is
    // buffered instead of rendered and is then discarded by the next drain. A failed disk write
    // must cost a checkpoint, never the message pipeline.
    for (const observer of this.bulkIngestObservers) {
      try {
        await observer.onBulkIngestEnd(phase);
      } catch (e) {
        console.error('[QUEUE] bulk-ingest observer failed to end (window closed anyway):', e);
      }
    }
  }

  // ── Message queue ─────────────────────────────────────────────────────────

  /**
   * Settles when the offline backlog is being pulled from the server, or immediately when it is not.
   *
   * Covers the FETCH only, never the drain that follows it: {@link fetchPendingMessages} ends by
   * awaiting the barrier below, so a flag held across that tail would make the pull wait on itself.
   */
  private pendingPullInFlight: Promise<void> | null = null;

  /**
   * Settles when every acknowledgement this device has issued has actually reached the server.
   *
   * THE MIRROR OF {@link pendingPullInFlight}, closing the same overlap from the other side.
   * WP-DUPDELIVERY-1 deleted the one where a PULL raced the archive replay; this is the one where a
   * pull races THIS DEVICE'S OWN ACK, and it had no barrier at all because every ack site is
   * deliberately fire-and-forget - a drain must not wait on an HTTP round trip to finish.
   *
   * FIRE-AND-FORGET IS RIGHT; UNANNOUNCED IS NOT. The two are separable, and separating them is the
   * whole fix: the ack still returns immediately to its caller, and now says so here, so the one
   * path that must not overtake it can wait.
   *
   * THE RACE IS NOT INCIDENTAL - IT IS SCHEDULED. `onDrainEnd` acks the rows it just drained and,
   * in the SAME TICK, `refetchFramesLeftBehind` starts a pull (`void this.fetchPendingMessages()`)
   * whenever a Welcome landed. The server has not recorded the ack yet, so it lists those rows
   * again and the device meets its own frames a second time - `[QUEUE] delivery ... arrived twice -
   * the pull listed a row this device had already acknowledged`. Measured on four campaign rows
   * before it was fixed, and the population is what named it: it appears on TAB-3b, HEAL-REVOKE-2,
   * -3, -9 and HEAL-NEW-3, all of them a client with an EMPTY store draining a backlog - the state
   * with the most rows in flight to race - and NOT on HEAL-NEW-1, whose store is equally empty and
   * which has nobody online to deliver anything.
   *
   * CHAINED, NOT REPLACED. Acks are serialised behind one another so a second never overtakes a
   * first, which is what makes awaiting this a statement about ALL of them rather than the latest.
   *
   * AND CHAINING RATHER THAN `allSettled` CLOSES A SECOND, LATENT LOSS in the persisted-ack store.
   * `ackMessagesWithRetry` READS the ids a failed attempt left in sessionStorage, merges them into
   * its own payload, and CLEARS the store on success - a read-modify-write with no lock. Two acks in
   * flight together can interleave it: A exhausts its retries and persists `{x, a}`, B succeeds a
   * moment later and clears the store, and `a` - which only ever travelled in the request that
   * failed - is now acknowledged nowhere and remembered nowhere. Serialising the requests serialises
   * that read-modify-write with them, so the cheaper `allSettled` would have kept the ordering and
   * kept the bug.
   * It never rejects: a caller wanting the ORDERING must not be handed a transport failure to
   * swallow, and a FAILED ack is not a defect here - the server really does still hold those rows,
   * so a pull that lists them again is telling the truth and the log line is honest.
   */
  private ackInFlight: Promise<void> | null = null;

  /**
   * Acknowledges message ids and announces the request, so a pull can refuse to overtake it.
   *
   * Every ack in this class goes through here. Callers keep `void`-ing it - the drain must not wait
   * on a round trip - and the ordering is recovered by {@link fetchPendingMessages} awaiting
   * {@link ackInFlight} instead.
   *
   * @param messageIds the ids to acknowledge; EMPTY is meaningful - `ackMessagesWithRetry` merges
   *   the ids persisted by a failed earlier attempt, so an empty call is the flush of those.
   */
  private announceAck(messageIds: string[]): Promise<void> {
    const previous = this.ackInFlight;
    // WHOSE IDS THESE ARE, CAPTURED WHEN THEY ARE HANDED OVER RATHER THAN WHEN THEY ARE SENT.
    // `MlsDeliveryApi.ackMessages` reads `userId`/`deviceId` and mints its auth header at CALL time,
    // which is now inside a continuation that may run several seconds later - and acknowledging one
    // account's message ids under another's identity is precisely what `clearPersistedPendingAcks`
    // exists to prevent on logout. Chaining must not widen that window, so the chain checks.
    const issuedFor = this.userId;
    const sent = (async () => {
      await previous?.catch(() => {});
      if (this.userId !== issuedFor) {
        // NOT SILENT. Nothing is lost here - the server still holds these rows and the next pull
        // for the account that owns them lists them again - but a queue drained under one identity
        // and acknowledged under none is worth a line, and its RATE is the reading that matters.
        console.warn(
          `[ACK] ${messageIds.length} id(s) dropped: they were queued for ${issuedFor} and this` +
            ` service is now ${this.userId}. The rows stay on the server for that account's next pull`
        );
        // AND THEY ARE UNACKNOWLEDGED, which is the same fact a thrown ack records. Without this the
        // repeat these rows will provoke would be ACCUSED - the shape reserved for a pull that
        // overtook a landed ack - when the honest reading is that nothing ever acknowledged them.
        for (const id of messageIds) this.unacknowledged.add(id);
        return;
      }
      try {
        await this.delivery.ackMessages(messageIds);
        // One success covers every id a failed attempt had persisted, because the retry merged them
        // into this payload - so the whole set goes, not just the ids named here.
        this.unacknowledged.clear();
      } catch (e) {
        for (const id of messageIds) this.unacknowledged.add(id);
        throw e;
      }
    })();
    const settled = sent.catch(() => {});
    this.ackInFlight = settled;
    // Cleared only if nothing has chained behind it, so the chain cannot grow without end and a
    // later pull does not await an ack that landed minutes ago.
    void settled.then(() => {
      if (this.ackInFlight === settled) this.ackInFlight = null;
    });
    return sent;
  }

  /**
   * True while the LAST pull ran to completion - every page fetched, no transport failure.
   *
   * It is what lets {@link waitForMessageQueueIdle} state emptiness instead of idleness. Read
   * together with `isWsOpen()`, never alone: a socket that has since dropped means frames may have
   * been queued while this device was unreachable, and the pull that covers them is the reconnect's
   * (`initializeConnection` runs one immediately after every `connect`). Cleared at the start of
   * each pull, so a pull that failed half-way leaves it false and the next barrier pulls again -
   * unless the link is known down, when the pull is the reconnect's ({@link settleBarrier}).
   */
  private mailboxEmptiedByAPull = false;

  /**
   * The catch-up sessions currently open, in the order they opened.
   *
   * A LIST RATHER THAN A DEPTH, and the difference is what {@link waitForMessageQueueIdle} BRANCHES
   * on. A count says "somebody has one open", which is true of two situations whose handling is
   * opposite: a caller that opened one ITSELF and then waited for its own mailbox (a deadlock -
   * refuse it and name it), and a caller that merely ran BESIDE somebody else's session (not a
   * deadlock at all - wait, which is all the caller ever asked for). The guard used to refuse both,
   * so a routine connection edge lost the ordering guarantee it had taken the barrier to get.
   *
   * The group id is the discriminator, and it is already known at both openers - so it is carried
   * from there rather than re-derived: a barrier whose caller names the same group as an open
   * session is nested, a different group is concurrent. `openedAt` is diagnostic only; nothing
   * branches on it.
   */
  private openCatchUps: Array<{ groupId: string; openedAt: number }> = [];

  /** Open catch-up sessions. A depth rather than a flag: nothing guarantees only one at a time. */
  private catchUpDepth = 0;

  /** Pending while a catch-up is open; `null` when none is. */
  private catchUpGate: Promise<void> | null = null;

  /** Opens {@link catchUpGate}. Held only while `catchUpDepth > 0`. */
  private releaseCatchUpGate: (() => void) | null = null;

  /**
   * How many times the LIVE MLS client has been mutated by something other than a catch-up.
   *
   * Read at the snapshot and again at the swap: if it moved, the state about to be installed
   * predates a mutation the live client already made, and installing it would undo that mutation.
   * A COUNT rather than a flag because the swap has to compare two instants, not ask "recently?".
   */
  protected liveMutations = 0;

  /**
   * Records a mutation of the live MLS client made outside a catch-up.
   *
   * Called by the send path today, which is the only mutation that runs unserialised against a
   * catch-up: everything else goes through the drain, and the drain and the catch-up take the same
   * mutex, so they cannot overlap by construction.
   */
  protected noteLiveMutation(): void {
    this.liveMutations++;
  }

  /**
   * Marks a catch-up session as open, closing the gate every send waits on.
   *
   * THE THIRD ACTOR. Sequencing "drain, then history exchange" orders the two paths that READ this
   * device's store, and leaves the one that WRITES to it - a send - free to land anywhere. On web a
   * send during the window is then overwritten by the swap: measured 2026-08-14 across three runs of
   * MSG-1b, `sendsDuringWindow=1` produced a `LOST frame` twice and `sendsDuringWindow=0` produced
   * none, with the frame named on the LOST line being, byte for byte, the send that followed the
   * rewind. The victim is always the next send after the swap - usually the focused tab's read
   * watermark, which is why the loss looked for days like a property of silent frames.
   */
  protected beginCatchUp(groupId: string): void {
    this.openCatchUps.push({ groupId, openedAt: Date.now() });
    this.catchUpDepth++;
    if (this.catchUpDepth === 1) {
      this.catchUpGate = new Promise<void>((resolve) => {
        this.releaseCatchUpGate = resolve;
      });
    }
  }

  /**
   * Marks a catch-up session as closed, releasing every send waiting behind it.
   *
   * Removes the LAST entry for that group: sessions on one group nest LIFO, and an id that is not
   * there closes nothing rather than silently closing somebody else's.
   */
  protected endCatchUp(groupId: string): void {
    for (let i = this.openCatchUps.length - 1; i >= 0; i--) {
      if (this.openCatchUps[i].groupId === groupId) {
        this.openCatchUps.splice(i, 1);
        break;
      }
    }
    this.catchUpDepth = Math.max(0, this.catchUpDepth - 1);
    if (this.catchUpDepth === 0) {
      this.releaseCatchUpGate?.();
      this.releaseCatchUpGate = null;
      this.catchUpGate = null;
    }
  }

  /**
   * Resolves when no catch-up session is open.
   *
   * Awaited by the send path, and safe to await from anywhere a send happens today. The drain holds
   * the MLS mutex for each message and a catch-up holds it for its whole life, so no catch-up can be
   * open while a handler runs - a send raised from inside the pipeline therefore never waits here.
   * The one send raised from inside a replay (`reconcileGroup`, on an unreadable frame) is
   * fire-and-forget, so it settles after `finish` rather than blocking it.
   */
  async waitForCatchUpIdle(): Promise<void> {
    await this.catchUpGate;
  }

  /**
   * Resolves when this device's mailbox is EMPTY - nothing left to fetch, and nothing left to apply.
   *
   * BOTH HALVES, because either one alone answers a different question. `waitUntilIdle` says "I have
   * applied everything I received"; it says nothing about what is still sitting on the server, and
   * the backlog is pulled ONE PAGE AT A TIME (`fetchPendingMessages`). Between a drained page and the
   * next one landing, the scheduler is genuinely idle while the mailbox is genuinely full - measured
   * on A1 at 976 rows / 36 MB, which is many pages with real network gaps between them.
   *
   * Every caller of this barrier - the ask, the answer, the archive replay, the outbox flusher -
   * wants the second, stronger fact: a device that has not emptied its mailbox is not a reliable
   * source about its own history, and must neither ask for one nor describe what it holds.
   *
   * Sequential rather than a loop, and that is what makes it terminate: the pull is edge-driven (a
   * connection), so nothing starts a new one while the queue it filled is draining. A pull that DOES
   * begin later is a new edge, which re-triggers the reconciliation by itself.
   *
   * AND IT PULLS IF NOBODY ELSE HAS, which is the half this was missing and the docblock was already
   * claiming (WP-DUPDELIVERY-1). Waiting on `pendingPullInFlight` answers "has the pull that is
   * RUNNING finished" - so with no pull running and a full mailbox on the server, both halves
   * resolved instantly and the caller went on to read the archive with its own frames still queued.
   * Measured on prod 2026-08-15: an archive replay finished at 11:43:10, a pull started at
   * 11:43:12.889 on a connection edge, and the single row it returned was a frame the replay had
   * already read - `Duplicate delivery ... already read by the archive replay`. Every such line in
   * every capture says the archive won, and not one says live delivery, so this arm had never once
   * been the one that fired. The heal was the witness; the overlap is what had to go.
   *
   * The evidence for "empty" is a COMPLETED pull plus a socket still open (see
   * {@link mailboxEmptiedByAPull}), never a duration.
   */
  async waitForMessageQueueIdle(caller: string, catchUpGroupId: string | null): Promise<void> {
    /**
     * FROM INSIDE A CATCH-UP THIS BARRIER CANNOT RESOLVE, SO IT ACCUSES INSTEAD OF HANGING.
     *
     * A catch-up session holds the global MLS mutex for its whole life (`createDecryptSession` ->
     * {@link beginCatchUp}) and the drain needs that same non-reentrant mutex for every message. A
     * caller that opens one and then waits for its mailbox waits for a drain that cannot start:
     * both sides stop for good, and nothing in the client recovers without a reload.
     *
     * It is a deadlock in theory before it is one in practice, and it shipped once - 2026-08-15, the
     * archive replay took this barrier after opening its session. W2 opened a bulk ingest at
     * 14:58:44.612, the frame arrived 389 ms later, its drain nested to depth 2, and neither ever
     * finished; the server saw the other side of the same event as two frames unACKed and a
     * `PUSH_DEFERRED -> FCM fallback` on a browser with no push token.
     *
     * There is no legitimate caller here - the barrier's whole purpose is to be taken BEFORE the
     * session - so this is a defect report, not a degradation to absorb quietly. The responder legs
     * solve the same problem the other way, by DEFERRING past the drain rather than awaiting it
     * (`answerAfterMailboxDrained`), which is the shape to copy when a call site cannot know whether
     * it runs inside one.
     *
     * ONLY THE SESSION THIS STACK IS INSIDE IS A DEADLOCK, AND `catchUpGroupId` IS WHAT SAYS SO. A
     * session open elsewhere takes the same global mutex, so the drain is blocked there too - but it
     * is blocked by a stack that will release it on its own, and this barrier then merely waits
     * longer. Waiting is what the caller asked for; refusing is not.
     *
     * That distinction was carried in PROSE for a day and carried nothing: the caller string was
     * matched against the open group ids by substring, and not one of the seven call sites spells a
     * group id, so `NESTED` could not be printed in the field at all. Every real occurrence read
     * `CONCURRENT` - including the nesting this guard exists for - and the first one measured said
     * so on prod (MUT-2, 2026-08-16: "connection sync" and "outbox flush", 98 ms after a replay
     * opened a session on a group neither of them was about). The discriminator is a PARAMETER now,
     * passed from the call sites that already know it.
     *
     * `null` means the call site cannot be inside a session at all ("connection sync", "outbox
     * flush", "media send", and the legs deferred past the drain): each is raised by a connection
     * edge, a visibility change, a click or a microtask that owns nothing, so none can be the nested
     * case. A future call site that passes `null` from inside one would hang here rather than be
     * told - which is why the parameter is required rather than optional, and why this sentence
     * exists.
     *
     * A caller that names a group it does NOT own a session on is refused too, and that is the one
     * deliberate imprecision: the group is a proxy for "inside", not a proof of it. Refusing costs a
     * guarantee the ledger can still catch afterwards; waiting on a session that will never close
     * costs the client until it is reloaded, and that one shipped (W2, 2026-08-15).
     *
     * AS OF 2026-08-23 NO CALL SITE PASSES A GROUP, AND THAT IS THE CORRECT STATE RATHER THAN A
     * REGRESSION. The two that did read the parameter as "the group I am working on": `history.ts`
     * named the group whose session it was about to open on the NEXT statement, and
     * `historyReconcile.ts` named the group it was reconciling, reached from a `finally` that had
     * already awaited `session.finish()`. Neither can be inside a session, so neither ever
     * described a nesting - they described a CONCURRENT replay of the same group, which the arm
     * above then reported as an unresolvable deadlock and skipped. Found by GRP-7 on 2026-08-23,
     * where the skipped barrier is visible in the same report as the `[HISTORY_STATE] holds
     * something different` it caused.
     *
     * So the guard stands unfired, which is what a guard against a shape the code no longer has
     * should do - `createDecryptSession` is the only opener of a session, `history.ts` is its only
     * caller, and nothing reaches a barrier from inside it. A FUTURE caller that does, and passes
     * `null`, hangs here instead of being told: the last line it prints is the `debug` below,
     * naming it and the session it is waiting behind, which is what makes that hang diagnosable
     * rather than silent. Anything awaiting this barrier from inside a session must pass its group.
     */
    const nestedSession =
      catchUpGroupId !== null
        ? this.openCatchUps.find((s) => s.groupId === catchUpGroupId)
        : undefined;
    if (nestedSession) {
      const now = Date.now();
      const open = this.openCatchUps
        .map((s) => `${s.groupId} (${now - s.openedAt}ms ago)`)
        .join(', ');
      console.error(
        `[QUEUE] mailbox barrier awaited by "${caller}" for group ${catchUpGroupId} while a catch-up session` +
          ` on that same group has been open for ${now - nestedSession.openedAt}ms [${open}] - this can` +
          ' never resolve: the drain needs the MLS mutex that session holds for its whole life. Take the' +
          ' barrier BEFORE opening the session, or defer past the drain instead of awaiting it' +
          ' (`answerAfterMailboxDrained`). It was SKIPPED and the caller is proceeding against a mailbox' +
          ' that may not be empty.'
      );
      return;
    }
    /**
     * AND IT CANNOT RESOLVE BEFORE THERE IS ANYTHING TO DRAIN IT, EITHER.
     *
     * `processQueue` returns immediately while {@link messageCallback} is unset, so nothing empties
     * the buckets and `waitUntilIdle` has no way to fire - and this barrier PULLS, so awaiting it
     * without a consumer is what fills the queue it is then waiting on. The device stops mid-boot
     * with no socket, for ever, and the only visible trace is a `console.warn` about a callback.
     *
     * Measured on prod 2026-08-15: W2 held 2 frames queued since the deadlock earlier that day, and
     * every boot afterwards pulled them, hung inside the startup archive replay before
     * `setupMessageHandler`, and never reached tab leadership - no `[TAB] Leadership acquired`, no
     * `Connecting to Gateway...`, silence from 1 s onwards. W1, same bundle and same code with an
     * EMPTY server-side mailbox, booted normally: the backlog alone decided it.
     *
     * The order is fixed at the call site - the inbound pipeline is registered before anything can
     * replay an archive - so reaching this is a defect report, not a state to absorb. Skipping is
     * still strictly better than hanging: the caller reads an archive whose mailbox may not be
     * settled, which the shared-fingerprint ledger catches, and a duplicate is recoverable where a
     * client that never connects again is not.
     */
    if (!this.messageCallback) {
      console.error(
        `[QUEUE] mailbox barrier awaited by "${caller}" before the inbound pipeline was registered -` +
          ' nothing can drain the queue this barrier pulls into, so it can never resolve and it was' +
          ' SKIPPED. Register the message handler before any caller can take this barrier.'
      );
      return;
    }
    /**
     * A WAIT NOBODY CAN SEE CANNOT BE VERIFIED, and this one replaced a refusal that was loud.
     *
     * Every other session is now waited out rather than refused, which is correct and completely
     * silent - so the only evidence the fix works would have been the ABSENCE of the old line, and
     * an absence proves nothing about a branch that fires on 2 runs in 5. This states the wait
     * instead: which caller, how long, and whose session it was behind.
     *
     * It is `debug`, not `error`, because it is not a defect - it is the barrier doing its job while
     * something legitimately holds the mutex. It is rare by construction (only while a catch-up
     * overlaps a barrier, twice on a busy boot at most) and it explains a latency that would
     * otherwise have no account at all, which is the whole bar for keeping a line.
     */
    const behind = this.openCatchUps.map((s) => s.groupId);
    if (behind.length > 0) {
      /**
       * SAID BEFORE THE WAIT, NOT ONLY AFTER IT - because the one case this report is most needed
       * for is the wait that never ends, and a line printed on the far side of an `await` cannot
       * describe it. This used to be a single line after `settleBarrier()`: it accounted for the
       * latency perfectly and went completely silent on a hang, which is the state the guard above
       * exists to keep a caller out of and the state a FUTURE caller reaches by passing `null` from
       * inside a session. The last thing such a client now prints names it and names the session it
       * is stuck behind, which is the difference between a diagnosable hang and a dead tab.
       */
      console.debug(
        `[QUEUE] mailbox barrier for "${caller}" is waiting behind ${behind.length} catch-up` +
          ` session(s) on [${behind.join(', ')}] - not this caller's, so it is waited out rather` +
          ' than refused. If this is the last line from this client, the caller was inside one of' +
          ' those sessions and must pass its group id rather than null.'
      );
      const waitedFrom = Date.now();
      /**
       * THE WAIT THE THREE COMMENTS ABOVE ALREADY PROMISE, AND IT WAS NEVER TAKEN.
       *
       * `settleBarrier` waits for the pull and for the scheduler's buckets. Neither is evidence
       * about a catch-up session: a session dispatches `decryptPage` straight at the engine, so
       * while its batch is in flight the pull is done and every bucket is empty. The barrier
       * therefore printed the sessions it was "waiting out" and returned in **0 ms** - measured on
       * the Mi 9T, 2026-09-08, twice in a row, with the numbers in `docs/wiki/backlog.md` under
       * "one frame is decrypted by three engines against one receive ratchet". The archive replay
       * went on to hand the engine two frames the catch-up had spent 83 ms earlier, and openmls
       * refused both at `error` level (`SecretReuseError`, generations 43 and 44 of epoch 196).
       *
       * A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER: `isIdle` answers "is
       * my queue empty", and it was being read as "is the group quiet". The gate below is the one
       * that answers the second, and it already exists - every send has waited on it since
       * 2026-08-14 for the same reason, that a catch-up must not be raced.
       *
       * BOUNDED BY CONSTRUCTION, not by a clock: `createDecryptSession` is the only opener, and it
       * closes the session from a `catch` and from `finish()`'s `finally` on both platforms, while
       * its only caller finishes from a `finally` of its own. A caller that reaches this from
       * INSIDE a session and passes `null` still hangs - exactly as it did before this line, on
       * `settleBarrier`, since the drain it waits for needs the mutex that session holds - and the
       * `debug` above is still the line that names it.
       *
       * ORDER IS LOAD-BEARING: the sessions first, the mailbox second. A catch-up can queue work,
       * so settling before it closed would settle a queue it had not finished filling.
       */
      await this.waitForCatchUpIdle();
      await this.settleBarrier();
      console.debug(
        `[QUEUE] mailbox barrier for "${caller}" waited ${Date.now() - waitedFrom}ms behind` +
          ` ${behind.length} catch-up session(s) on [${behind.join(', ')}] - not this caller's, so it` +
          ' was waited out rather than refused.'
      );
      return;
    }
    return this.settleBarrier();
  }

  /**
   * The barrier proper: pull if nobody has, then wait for the queue to be applied.
   *
   * Split out so the guards above can time it without repeating it - the two call sites must not be
   * able to drift apart, since one of them is what the other claims to have measured.
   */
  private settleBarrier(): Promise<void> {
    // A FOLLOWER TAB HAS NO MAILBOX OF ITS OWN TO PULL. Its socket is never open, so the clause below
    // read "the socket has dropped, pull again" on EVERY barrier: measured on production 2026-09-28,
    // one follower pulled the same 64 rows 37 times in ten seconds - one pull per conversation the
    // history catch-up settled - and DECRYPTED them, in a second tab, against the ratchet the leader
    // owns (WP-MULTITAB-1). The leader drains the queue; a follower only waits for its own scheduler.
    if (getTabLeadership() === 'follower') return this.settleMailbox();
    if (
      !this.pendingPullInFlight &&
      !(this.mailboxEmptiedByAPull && this.isWsOpen()) &&
      this.userId !== UNRESOLVED_USER_ID
    ) {
      // A LINK KNOWN DOWN OWES ITS PULL TO THE RECONNECT, NOT TO EVERY BARRIER. With the socket
      // closed and the server known unreachable (a request - this device's last pull included - got
      // no answer, or the browser reports no network), a pull here can only fail, and every barrier
      // took one: measured on production (`1.5.1`, a phone at a cold start with no network), 327
      // `[PENDING] ... got no answer` lines, one per conversation the catch-up settled. The pull the
      // mailbox is owed is the reconnect's (`initializeConnection` pulls after every connect), and
      // the first answered request clears `isOffline` - an event, not a clock - so a barrier taken
      // after it pulls again. Said once per spell, not once per barrier.
      if (!this.isWsOpen() && connectivity.isOffline) {
        if (!this.barrierPullHeldSaid) {
          this.barrierPullHeldSaid = true;
          console.info(
            "[PENDING] mailbox barrier: no pull while the link is down (socket closed, server unreachable) - the reconnect's pull covers the mailbox"
          );
        }
        return this.settleMailbox();
      }
      // Ends by awaiting `settleMailbox` itself, so this is the whole barrier and not a step of it.
      return this.fetchPendingMessages().catch(() => {});
    }
    return this.settleMailbox();
  }

  /** Whether {@link settleBarrier} already said, this spell, that it holds its pull for the reconnect. */
  private barrierPullHeldSaid = false;

  /**
   * The wait alone: whatever pull is in flight has landed, and the scheduler has applied it.
   *
   * Split out of {@link waitForMessageQueueIdle} because {@link fetchPendingMessages} ends on it -
   * calling the full barrier there would have the pull wait on itself.
   */
  /** @inheritdoc */
  async waitForGroupQueueIdle(caller: string, groupId: string): Promise<void> {
    // THE PULL FIRST, exactly as the whole-mailbox barrier does it: a bucket that is empty because
    // nothing has been FETCHED yet is not a bucket that has nothing left. What this skips is the
    // other twenty-eight conversations' frames, not the round trip that lists our own.
    await this.pendingPullInFlight?.catch(() => {});
    // SILENT. A leg waiting for its own group's frames is the routine path and finishes in
    // milliseconds; a line announcing the wait, with nothing announcing its end, is half a story
    // printed once per conversation per answer. What a reader needs is the OUTCOME, and
    // `[HISTORY_REQ] ... diff with <them>` is it.
    await this.messageScheduler.waitUntilGroupIdle(groupId);
  }

  /** @inheritdoc */
  isGroupDrained(groupId: string): boolean {
    const drained = this.groupDrainedNow(groupId);
    if (!drained) {
      console.debug(
        `[QUEUE] group ${groupId.slice(0, 8)} not known drained: pulled=${this.mailboxEmptiedByAPull} pulling=${Boolean(this.pendingPullInFlight)} socket=${this.isWsOpen()} idle=${this.messageScheduler.isGroupIdle(groupId)}`
      );
    }
    return drained;
  }

  /** {@link isGroupDrained}'s evidence, read silently - the waiters re-read it on every event. */
  private groupDrainedNow(groupId: string): boolean {
    return (
      this.mailboxEmptiedByAPull &&
      !this.pendingPullInFlight &&
      this.isWsOpen() &&
      this.messageScheduler.isGroupIdle(groupId)
    );
  }

  /** Waiters of {@link whenGroupDrained}, by group. */
  private readonly groupDrainedWaiters = new Map<
    string,
    Array<{ resolve: () => void; reject: (e: Error) => void }>
  >();

  /** Groups whose scheduler idleness is already being waited for, so it is armed once per group. */
  private readonly groupDrainedArmed = new Set<string>();

  /** @inheritdoc */
  whenGroupDrained(groupId: string): Promise<void> {
    if (this.groupDrainedNow(groupId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.groupDrainedWaiters.get(groupId) ?? [];
      waiters.push({ resolve, reject });
      this.groupDrainedWaiters.set(groupId, waiters);
      this.armGroupDrained(groupId);
    });
  }

  /**
   * Waits for the scheduler to finish `groupId`'s frames, then re-reads the evidence. Armed ONLY
   * while the group still has frames: an idle group waiting on the pull or the socket is woken by
   * the pull's end instead, and re-arming on an idle group would resolve at once, for ever.
   */
  private armGroupDrained(groupId: string): void {
    if (this.groupDrainedArmed.has(groupId) || this.messageScheduler.isGroupIdle(groupId)) return;
    this.groupDrainedArmed.add(groupId);
    void this.messageScheduler.waitUntilGroupIdle(groupId).then(() => {
      this.groupDrainedArmed.delete(groupId);
      this.wakeGroupDrainedWaiters('group idle');
    });
  }

  /**
   * Resolves every {@link whenGroupDrained} waiter whose group now reads drained, and re-arms the
   * others whose group has frames again. Called where the evidence can change: a group's frames
   * done, a pull ended.
   */
  private wakeGroupDrainedWaiters(cause: string): void {
    for (const [groupId, waiters] of this.groupDrainedWaiters) {
      if (!this.groupDrainedNow(groupId)) {
        this.armGroupDrained(groupId);
        continue;
      }
      this.groupDrainedWaiters.delete(groupId);
      console.debug(
        `[QUEUE] group ${groupId.slice(0, 8)} drained (${cause}) - waking ${waiters.length} waiter(s)`
      );
      for (const { resolve } of waiters) resolve();
    }
  }

  /** How many {@link whenGroupDrained} waiters are pending, across groups. */
  private pendingGroupDrainWaiters(): number {
    let n = 0;
    for (const waiters of this.groupDrainedWaiters.values()) n += waiters.length;
    return n;
  }

  /**
   * Rejects every pending {@link whenGroupDrained} waiter with {@link GroupDrainAbandonedError}: this
   * client is ending and will drain nothing more. Called by {@link destroy}.
   */
  private abandonGroupDrainedWaiters(): void {
    const pending = this.pendingGroupDrainWaiters();
    if (pending > 0) {
      console.info(`[QUEUE] destroy - ${pending} drain waiter(s) abandoned`);
    }
    for (const [groupId, waiters] of this.groupDrainedWaiters) {
      for (const { reject } of waiters) reject(new GroupDrainAbandonedError(groupId));
    }
    this.groupDrainedWaiters.clear();
    this.groupDrainedArmed.clear();
  }

  private async settleMailbox(): Promise<void> {
    await this.pendingPullInFlight?.catch(() => {});
    return this.messageScheduler.waitUntilIdle();
  }

  /** @inheritdoc */
  notifyConversationsRestored(): void {
    this.refetchFramesLeftBehind('absent-conversation', 'conversations restored');
  }

  /** @inheritdoc */
  notifyConversationRowsSeeded(): void {
    this.refetchFramesLeftBehind('absent-conversation', 'conversation rows seeded');
  }

  /** @inheritdoc */
  notifyConversationAvailable(groupId: string): void {
    // BOTH REASONS, ONE PULL: a frame held `behind-refused-backlog` waits for the same frames the
    // `absent-conversation` ones are, and the row existing is what makes all of them readable.
    this.refetchFramesLeftBehind(
      ['absent-conversation', 'behind-refused-backlog'],
      `conversation ${groupId.slice(0, 8)}… now exists`,
      groupId
    );
    // A lost invitation that waited for this conversation to exist can be re-planned now.
    this.replanOwedInvitationsIn(groupId, 'conversation available');
  }

  /** @inheritdoc */
  notifyCommitsApplied(groupId: string): void {
    this.replanOwedInvitationsIn(groupId, 'commit applied');
  }

  /** Runs `fn` under the global MLS client mutex (shared with the drain and catch-up sessions). */
  runUnderMlsLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.messageScheduler.runUnderMlsLock(fn);
  }

  /**
   * Runs ONE commit of `groupId` under the MLS mutex (`MlsPerGroupScheduler.runCommitUnderMlsLock`):
   * exclusive of every other holder, and able to lend the mutex across its network round trip
   * ({@link lendMlsLockDuring}). While it holds, the drain holds back that group's frames (and the
   * other kinds it could not apply without waiting), so they are resumed here when it ends.
   */
  protected async runCommitUnderMlsLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.messageScheduler.runCommitUnderMlsLock(groupId, fn);
    } finally {
      this.resumeFramesHeldByCommit(groupId);
    }
  }

  /** Lends the MLS mutex to the drain while `work` - a commit request of `groupId` - is pending. */
  protected lendMlsLockDuring<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    return this.messageScheduler.lendMlsLockWhile(groupId, work);
  }

  /**
   * Starts a drain for the frames a commit held back, once it has released the mutex. Nothing else
   * would: they were enqueued (their drain found nothing it could pick, and ended), and no new frame
   * need arrive. A drain still running picks them up itself, and its restart guard covers the drain
   * that is closing.
   */
  private resumeFramesHeldByCommit(groupId: string): void {
    if (this.messageScheduler.draining || !this.messageScheduler.hasRunnableWork()) return;
    console.log(
      `[QUEUE] the commit of ${groupId.slice(0, 8)}... released the MLS lock - draining the ${this.messageScheduler.getPendingCount()} frame(s) it held back`
    );
    void this.processQueue();
  }

  /**
   * WHAT A REPEATED DELIVERY MEANS, by the channel that offered the second copy and by what this
   * device already knew about the row. Four cells, four different findings, and only three of them
   * are explained by a crossing.
   *
   * Three are the SAME event seen from either side, and neither side is at fault: an acknowledgement
   * cannot land before a pull already in flight, so a row can be listed by the pull after the socket
   * delivered it, or delivered by the socket after the pull listed it. Both are ordinary at a
   * reconnect and both are healed here by not decrypting twice.
   *
   * THE FOURTH IS NOT A CROSSING AND IS THEREFORE LOUD. The socket publishes a frame ONCE, when the
   * delivery service accepts the message - it does not replay the queue on connect - so a live frame
   * for a row this device has already ACKNOWLEDGED is not this client losing a race with itself. It
   * is the same row published twice, and nothing here can fix that; the ack is repeated so the row
   * cannot be left pending, and the line accuses so the next occurrence is investigated rather than
   * absorbed. It has never been observed, which is exactly why it must not be printed at the same
   * level as the three that are routine.
   */
  private static readonly REPEAT_MEANS: Record<
    DeliveryChannel,
    Record<'queued' | 'done', { say: string; accuse: boolean }>
  > = {
    pull: {
      queued: {
        say:
          'the pull listed a row the socket had already handed in and this device has not drained' +
          ' yet - the ordinary crossing, and nothing is wrong',
        accuse: false,
      },
      done: {
        say:
          'the pull listed a row this device had already acknowledged, AND that acknowledgement had' +
          ' landed before the pull was issued - `fetchPendingMessages` awaits `ackInFlight`, so' +
          ' nothing routine explains this: either a pull was started outside that barrier, or the' +
          ' server answered without recording an ack it had accepted',
        accuse: true,
      },
    },
    live: {
      queued: {
        say:
          'the socket delivered a row the pull had already listed and this device has not drained' +
          ' yet - the ordinary crossing, seen from the other side',
        accuse: false,
      },
      done: {
        say:
          'THE SERVER PUBLISHED THE SAME ROW TWICE: a live frame arrived for a delivery this device' +
          ' had already acknowledged, and no crossing explains that - the socket publishes once, at' +
          ' send, and never replays the queue on connect',
        accuse: true,
      },
    },
  };

  /**
   * WHAT `pull:done` MEANS WHEN THE ACK NEVER GOT THROUGH, which is the only routine reading it has
   * left and the reason the entry above is allowed to accuse.
   *
   * A repeat has two possible causes and this device knows which one it is looking at, so it must
   * not classify by guessing: an ack that LANDED and a row that came back anyway is a defect, while
   * an ack that could not be delivered leaves the row genuinely owed, and the server listing it
   * again is correct behaviour. The discriminator is carried from {@link announceAck}, where it is
   * already known, rather than inferred from the repeat - and the finding in that case is the
   * `[ACK]` failure upstream, which already accuses. This line is its visible end, not a second
   * report of it.
   */
  private static readonly PULL_DONE_AFTER_A_FAILED_ACK = {
    say:
      'the pull listed a row whose acknowledgement never reached the server - it really is still' +
      ' owed, so this is the [ACK] failure above showing its consequence, not a delivery defect',
    accuse: false,
  };

  /**
   * The ids whose acknowledgement is known to have FAILED, so a repeat of one can be explained.
   *
   * Only ever holds the payload of the most recent unsuccessful ack: `ackMessagesWithRetry` merges
   * everything a failed attempt persisted into the next one, so one success covers all of them and
   * clears this. That is what bounds it without a cap.
   */
  private readonly unacknowledged = new Set<string>();

  /**
   * HOW OFTEN EACH REPEAT SHAPE HAPPENS, which is the reading the shape's SENTENCE cannot give.
   *
   * Two of the four are crossings nothing can prevent - two channels carry the same row and one is
   * always late - so their per-occurrence lines said the same true thing over and over, and what
   * decides anything is the rate.
   *
   * `pull:done` USED TO BE A THIRD, at one per send: the ordinary cost of a send under load,
   * measured 23/25 by FWD-2 on 2026-09-05. That measurement described a race that no longer exists
   * - the ack and the pull it was crossing are now ordered - so the shape has been re-read against
   * the population it will actually run on rather than kept on the reading that named the last
   * incident. What is left of it accuses, unless the ack is known to have failed.
   *
   * In the instance and not the module because two services can exist at once in a test.
   */
  private readonly repeats: Record<DeliveryRepeatShape, number> = {
    'pull:queued': 0,
    'pull:done': 0,
    'live:queued': 0,
    'live:done': 0,
  };

  /** The counters as a sentence, for the accusing line. Only shapes that happened are named. */
  private repeatSummary(): string {
    const seen = Object.entries(this.repeats).filter(([, n]) => n > 0);
    return seen.length ? seen.map(([k, n]) => `${k}=${n}`).join(' ') : 'none';
  }

  /**
   * What the repeat counters say right now.
   *
   * Exported through the instance rather than read off module state, so a test and a debug surface
   * ask the same question in the same way - the shape {@link displayNameLookupStats} established.
   */
  deliveryRepeatStats(): Record<DeliveryRepeatShape, number> {
    return { ...this.repeats };
  }

  /** Enqueues a message and starts the per-group fair drain loop if idle. */
  /**
   * True when this delivery has never been taken in, so it may enter the queue.
   *
   * A frame with NO queue id is always admitted: it is a live socket frame the server never
   * persisted, there is nothing to acknowledge and nothing can re-offer it, so there is no second
   * copy to recognise. See {@link deliveries} for the race this closes and for why a repeat of an
   * acknowledged row is acknowledged again instead of dropped.
   *
   * @param channel which side offered this copy - see {@link REPEAT_MEANS} for what each of the
   *   four combinations of channel and prior state actually says.
   */
  private admitDelivery(queuedMessageId: string | undefined, channel: DeliveryChannel): boolean {
    if (!queuedMessageId) return true;
    const known = this.deliveries.get(queuedMessageId);
    if (!known) {
      this.rememberDelivery(queuedMessageId, 'queued');
      return true;
    }
    // NOT A FALLBACK AND NOT SILENT, and no longer a guess: this used to report "the live frame and
    // the pull crossed" whichever way round it had happened, which is why a repeat could never be
    // triaged from a log. Its RATE is still the reading that matters - many of these for one group
    // is a pull firing on something other than an event - but the SHAPE is what says whose defect
    // it would be, and the shape is now named.
    // THE DISCRIMINATOR IS CARRIED, NOT GUESSED. Only this instance knows whether the ack for this
    // row got through, and that is exactly what separates a defect from a consequence.
    const meaning =
      channel === 'pull' && known === 'done' && this.unacknowledged.has(queuedMessageId)
        ? BaseMlsService.PULL_DONE_AFTER_A_FAILED_ACK
        : BaseMlsService.REPEAT_MEANS[channel][known];
    const shape = `${channel}:${known}` as DeliveryRepeatShape;
    this.repeats[shape] += 1;
    // `queuedMessageId` is the SERVER's, and a truncation is not a sanitiser - eight
    // characters are enough to hold a newline and start a line of the sender's choosing.
    const line =
      `[QUEUE] delivery ${sanitizeForLog(queuedMessageId).slice(0, 8)}... arrived twice - ${meaning.say};` +
      ` not decrypting it again` +
      (known === 'done' ? ', acknowledging it once more' : '');
    // A RATE IS NOT READ ONE LINE AT A TIME, and this comment used to say so while the code printed
    // one line at a time anyway. FWD-2 measured it on 2026-09-05: twenty-five forwards back to back,
    // and `pull:done` - the ack still in flight when the pull was answered - fired in TWENTY-THREE
    // of them. That is not a race, it is what a send costs under load; a reader learns to skip it,
    // and the line it hides next is the one that mattered.
    //
    // SO THE ROUTINE SHAPES EXPLAIN THEMSELVES ONCE AND ARE COUNTED AFTERWARDS. Not demoted - a
    // `debug` line is still a line, and the first occurrence still says the whole sentence. The
    // count is what answers the question the sentence cannot ("is this every send, or one in
    // three hundred"), it rides on the accusation below where a reader is already looking, and
    // {@link deliveryRepeatStats} hands it to a test and a debug surface without either reaching
    // into module state.
    if (meaning.accuse) {
      console.warn(`${line} [repeats so far: ${this.repeatSummary()}]`);
    } else if (this.repeats[shape] === 1) {
      console.log(`${line}. Further ones of this shape are counted, not printed`);
    }
    if (known === 'done') {
      void this.announceAck([queuedMessageId]).catch((e) =>
        console.warn('[ACK] re-ack of a repeated delivery failed:', e)
      );
    }
    return false;
  }

  /**
   * Records what the drain decided about a delivery: acknowledged, or owed a re-delivery.
   *
   * @param acked whether this drain acknowledged the row. False FORGETS it, because an unacked row
   *   is one the server must be able to hand back - see {@link deliveries}.
   */
  private settleDelivery(queuedMessageId: string | undefined, acked: boolean): void {
    if (!queuedMessageId) return;
    if (acked) this.rememberDelivery(queuedMessageId, 'done');
    else this.deliveries.delete(queuedMessageId);
  }

  /**
   * Remembers one delivery, evicting the oldest entry past {@link DELIVERY_MEMORY}.
   *
   * BOUNDED BECAUSE A SESSION IS NOT. The window a repeat can arrive in is one boot - a pull already
   * in flight against an ack already sent - so a few hundred entries covers it many times over, and
   * the cost of an eviction is that a repeat of a very old row is decrypted twice and acknowledged,
   * which is exactly what happened before this map existed. Insertion order is the eviction order:
   * a `Map`'s first key is its oldest, and a re-`set` of a known id is a state change, not a
   * refresh, so nothing here can keep an entry alive by touching it.
   */
  private rememberDelivery(queuedMessageId: string, state: 'queued' | 'done'): void {
    this.deliveries.set(queuedMessageId, state);
    while (this.deliveries.size > BaseMlsService.DELIVERY_MEMORY) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }
  }

  /**
   * @param channel which side handed this delivery in. REQUIRED, and required here rather than on
   *   {@link MlsQueuedMessage}: it is a fact about the ARRIVAL, not about the message, and the same
   *   row can arrive twice by two different routes - which is the only thing {@link admitDelivery}
   *   cannot work out for itself.
   */
  protected enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void {
    if (!this.admitDelivery(msg.queuedMessageId, channel)) return;
    // Stamped HERE, after the dedup: the copy that was admitted is the one whose route is a fact.
    this.messageScheduler.enqueue({ ...msg, channel });
    if (!this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Re-fetches the delivery queue because the thing that was blocking `reason` has just happened.
   *
   * THIS REPLACED A 15-SECOND TIMER, and the difference is the whole point. The handler leaves a
   * frame unacknowledged for exactly two reasons, and neither of them is discharged by waiting: an
   * unknown group needs its Welcome, an absent conversation needs the local store restore. A clock
   * asking again every fifteen seconds re-fetched the same rows, failed them the same way, and
   * re-opened the catch-up overlay on every cycle - for the whole session, on a device whose group
   * never came back. So the ask is now driven by the EVENT that changes the answer, and there is no
   * cycle to bound: no event, no ask.
   *
   * Silent and free when nothing is waiting, so callers may fire it on any occurrence of the event.
   *
   * @returns whether anything was waiting and has been taken - true also when the socket is closed
   *   and the reconnect pull is left to cover it. A caller that must ACCUSE a wait it should never
   *   have had (see `collectFramesLeftForKeyGroup`) reads this, not the log.
   */
  protected refetchFramesLeftBehind(
    /**
     * The reason(s) the event discharges. SEVERAL IN ONE CALL, NOT ONE CALL EACH: every call that
     * takes something starts a pull, and nothing coalesces two pulls - so an event discharging two
     * reasons for one group would pay for the same mailbox twice.
     */
    reasons: UnackedReason | readonly UnackedReason[],
    trigger: string,
    /**
     * One group, when the event that discharges the wait is per-group rather than global.
     *
     * ONE IMPLEMENTATION, because the two callers differ only in WHICH entries they take: everything
     * after that - the socket check, the line, the pull - is identical, and a second copy is how the
     * two would drift into disagreeing about whether a closed socket still owes a re-fetch.
     */
    groupId?: string
  ): boolean {
    const taken = new Set<string>();
    const tookFor: UnackedReason[] = [];
    for (const reason of typeof reasons === 'string' ? [reasons] : reasons) {
      const groups = groupId
        ? takeGroupAwaiting(reason, groupId)
          ? [groupId]
          : []
        : takeGroupsAwaiting(reason);
      if (groups.length === 0) continue;
      tookFor.push(reason);
      for (const g of groups) taken.add(g);
    }
    if (taken.size === 0) return false;
    if (!this.isWsOpen()) {
      // Nothing to re-fetch over: the reconnect runs a pull of its own, and the handler will note
      // whatever still fails. Dropping the note here is safe for the same reason `take` is.
      console.log(`[QUEUE] ${trigger}: socket closed, the reconnect pull covers it`);
      return true;
    }
    console.log(
      `[QUEUE] ${trigger}: re-fetching for ${taken.size} group(s) left behind as ${tookFor.join(
        ' + '
      )} [${[...taken].map((g) => g.slice(0, 8)).join(', ')}]`
    );
    void this.fetchPendingMessages();
    return true;
  }

  /** Drains per-group queues with round-robin scheduling and a global MLS mutex. */
  protected async processQueue(): Promise<void> {
    if (!this.messageCallback) {
      // A frame reached the queue before the pipeline that consumes it existed. Nothing here can
      // drain it, and anything already waiting on `waitUntilIdle` is waiting for good - so this is
      // an error, not a notice: the inbound pipeline is registered during boot BEFORE any path that
      // can pull or receive, and a line here means that order was broken.
      console.error(
        `[QUEUE] messageCallback not set - ${this.messageScheduler.getPendingCount()} queued message(s)` +
          ' cannot be processed and every mailbox barrier now open will never resolve'
      );
      return;
    }

    const ackIds: string[] = [];
    /** Groups whose Welcome landed in this drain: the one event that unblocks an unknown group. */
    const welcomedGroups: string[] = [];
    /** This drain's own window, closed by handle so an overlapping window cannot be closed instead. */
    let drainIngest: BulkIngestHandle | null = null;

    await this.messageScheduler.drain(
      async (msg) => {
        const groupId = msg.groupId;
        recordQueueDrainMessage(groupId);

        // group_reset control messages: ACK and ignore on both platforms.
        // The WebSocket reconnect is sufficient to re-sync state.
        if (msg.type === 'group_reset') {
          console.log(
            `[QUEUE] group_reset (control) ignored - group=${sanitizeForLog(groupId ?? 'unknown')}`
          );
          const ackedReset = shouldAckGroupResetControl({
            hasQueuedId: Boolean(msg.queuedMessageId),
          });
          if (ackedReset) ackIds.push(msg.queuedMessageId!);
          this.settleDelivery(msg.queuedMessageId, ackedReset);
          return;
        }

        try {
          console.log(
            `[QUEUE] Processing ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'message'} group=${groupId ?? 'unknown'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const deliveryMeta = deliveryMetaOf(msg);

          // The stuck-callback watchdog that used to sit here is gone, and it is not lost: it
          // covered ONE of the four awaits that can freeze the drain, and `MlsPerGroupScheduler`
          // now guards every one of them - including this callback, which it invokes as
          // `processMessage`. Two watchdogs for one await would have reported the same freeze
          // twice and still said nothing about the other three.
          const cbResult = await this.messageCallback!(
            msg.senderId,
            msg.ciphertext,
            msg.groupId,
            msg.isWelcome,
            msg.ratchetTreeBytes,
            msg.isCommit,
            deliveryMeta
          );

          console.log(
            `[QUEUE] messageCallback → ${cbResult} (group=${groupId ?? 'unknown'})${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const flags = {
            isWelcome: msg.isWelcome,
            isCommit: msg.isCommit,
            hasQueuedId: Boolean(msg.queuedMessageId),
          };
          const acked = shouldAckAfterSuccess(cbResult, flags) && !!msg.queuedMessageId;
          this.settleDelivery(msg.queuedMessageId, acked);
          if (acked) {
            ackIds.push(msg.queuedMessageId!);
          } else if (flags.hasQueuedId && cbResult === false) {
            // The handler already recorded WHY, against the group, in `unackedFrames`. Nothing to
            // note here: what discharges it is an event, not this drain ending.
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'callback_retry',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }

          if (msg.isWelcome && groupId) {
            this.messageScheduler.releaseWelcomeBuffer(groupId, 'Welcome complete');
            // A KEY GROUP'S WELCOME IS NOT A CONVERSATION'S, and the listener below is the
            // conversation layer: it writes a sidebar row for any group it does not hold one for,
            // then restores, reconciles and loads history for it. A key group is in the set this
            // reads either because the session already named it, or because `handleWelcome` read
            // its server row and registered it BEFORE the install; announcing it anyway persisted
            // an `active` row for a community's key group, which the next boot's discovery purged.
            // A key group whose row was unreadable AND that the session did not name is not in the
            // set and is still announced - it is in the backlog.
            if (this.isDistributionGroup(groupId)) {
              console.log(
                `[QUEUE] Welcome for key group ${groupId.slice(0, 8)}... - not announced to the conversation layer`
              );
            } else {
              this.welcomeProcessedCallback?.(groupId);
              // A re-admission's Welcome is what makes a `pending` conversation active again: a
              // lost invitation that waited for it can be re-planned now.
              this.replanOwedInvitationsIn(groupId, 'Welcome processed');
            }
            welcomedGroups.push(groupId);
          }
          // A COMMIT APPLIED is how an Add holding the group's lock ENDS - another device's, whose
          // lock refused a re-plan here - and how a tree that could not be confirmed catches up: a
          // lost invitation that waited on either is re-planned now.
          if (msg.isCommit && groupId && cbResult !== false) this.notifyCommitsApplied(groupId);
        } catch (e) {
          console.error(`[QUEUE] Error processing message:`, e);

          if (msg.isWelcome) {
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'welcome_error',
            });
            console.error(
              `[QUEUE] Welcome failed for group=${groupId} - NOT ACKed, retry on reconnect`
            );
            // FORGOTTEN, so "retry on reconnect" stays true. The row was not acknowledged, so the
            // server will offer it again, and an id still remembered here would make the pull that
            // re-offers it drop the frame instead of retrying it.
            this.settleDelivery(msg.queuedMessageId, false);
            // The window closes either way, and what it held is RE-QUEUED rather than dropped.
            // Dropping assumed the server would re-deliver, which is true only of a frame carrying
            // a `queuedMessageId`; a live WebSocket frame need not carry one. Re-queued, the group
            // is still unknown, so the handler records it against that group and the Welcome that
            // eventually lands re-fetches it - the seam that exists for exactly this.
            if (groupId) this.messageScheduler.releaseWelcomeBuffer(groupId, 'Welcome failed');
          } else {
            const exFlags = {
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
              hasQueuedId: Boolean(msg.queuedMessageId),
            };
            const ackedAfterThrow = shouldAckAfterException(exFlags) && !!msg.queuedMessageId;
            this.settleDelivery(msg.queuedMessageId, ackedAfterThrow);
            if (ackedAfterThrow) {
              ackIds.push(msg.queuedMessageId!);
            } else if (exFlags.hasQueuedId) {
              logMlsMetric({
                kind: 'queue_skip_ack',
                platform: this.platform,
                reason: 'exception_non_commit',
                isWelcome: msg.isWelcome,
                isCommit: msg.isCommit,
              });
            }
            // A throwing NON-Welcome used to close the group's Welcome window here, which is the
            // one path that could close a window its Welcome had not opened and would not close.
            // It is gone: the window now belongs to the Welcome from end to end, which is what
            // makes `releaseStrandedWelcomeBuffers` an invariant rather than one case among
            // several. Nothing is left open by dropping it - this branch could only be reached
            // while the Welcome was still queued, so that Welcome closes the window itself.
          }
        }
      },
      {
        onDrainStart: (pendingCount) => {
          beginQueueDrainBench(pendingCount);
          // Live drain: buffer decrypted messages for one grouped UI flush; show the overlay
          // only for a multi-message catch-up. endBulkIngest replays this exact phase.
          drainIngest = this.beginBulkIngest({ bufferUi: true, showOverlay: pendingCount > 1 });
        },
        onDrainEnd: async () => {
          if (ackIds.length > 0) {
            logMlsMetric({ kind: 'queue_ack', platform: this.platform, count: ackIds.length });
            // ANNOUNCED, still not awaited: the drain must not block on a round trip, and the
            // pull `refetchFramesLeftBehind` starts a few lines below must not overtake it.
            void this.announceAck(ackIds).catch((e) => console.warn('[ACK] drain ack failed:', e));
          }

          // A Welcome landing is the proof that frames buffered for an unknown group can now be
          // read. `releaseWelcomeBuffer` replays the ones this session buffered in memory; this
          // asks the server for the ones it left unacknowledged in earlier drains.
          if (welcomedGroups.length > 0) {
            this.refetchFramesLeftBehind('unknown-group', 'welcome processed');
          }

          finishQueueDrainBench(ackIds.length);
          if (drainIngest === null) {
            // AT A LEVEL THAT ACCUSES: the scheduler pairs the two callbacks, so an end without its
            // start is a scheduler that broke that contract - and there is no window to close.
            console.error('[QUEUE] drain ended without having opened its bulk-ingest window');
            return;
          }
          const closing = drainIngest;
          drainIngest = null;
          await this.endBulkIngest(closing);
          // AFTER the window closes: a contact line is a row like any other, and the rows of the
          // drain are flushed first. Not awaited - a notice must never hold the next drain.
          void this.handOverDeviceEvents('drain end');
        },
      }
    );

    // Messages that arrived via WebSocket while onDrainEnd was awaiting (draining=true)
    // were enqueued but could not start a new drain. Restart here so they are not stuck.
    // RUNNABLE, NOT MERELY PENDING: a frame held back by a commit stays pending for the whole commit,
    // and restarting on it would spin; the commit's end resumes it (`resumeFramesHeldByCommit`).
    if (this.messageScheduler.hasRunnableWork() && !this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Fetches offline-queued messages from the delivery service and routes each through the priority
   * queue, ONE PAGE AT A TIME: a page is enqueued (and so, later, ACKed) as soon as it lands, so a
   * pull that dies half-way still shrinks the backlog. Draining the whole queue behind a single
   * deadline was WP-PENDING-1 - a device far enough behind aborted on every reconnect, ACKed
   * nothing, and its backlog grew forever.
   */
  async fetchPendingMessages(): Promise<void> {
    if (this.userId === UNRESOLVED_USER_ID) return;
    if (getTabLeadership() === 'follower') {
      // AT A LEVEL THAT ACCUSES: every path that pulls is gated on leadership, so reaching this is a
      // caller that forgot - and letting it through decrypts in a tab that does not own the ratchet.
      console.error(
        '[PENDING] pull refused on a follower tab - only the leader drains the queue (a caller is not gated on leadership)'
      );
      return;
    }

    // Cleared here rather than on failure: what the barrier may trust is a pull that finished, and
    // this one has not started. A pull that dies half-way therefore leaves it false.
    this.mailboxEmptiedByAPull = false;
    // A pull is being made, so the barrier's "held for the reconnect" spell is over: the next one
    // that holds says so again.
    this.barrierPullHeldSaid = false;
    /** The refusals this pull is certain to list: every one marked before it started. */
    const refusalsCovered = refusedBacklogMark();

    let fetched = 0;
    /** Whether THIS pull listed the whole mailbox - the only kind that may settle the initial drain. */
    let emptied = false;

    /**
     * ANNOUNCED WHILE IT RUNS, so the barrier can state a fact about the whole mailbox rather than
     * about whichever pages happen to have landed. Never rejects - every failure is handled below -
     * so nothing waiting on it can be left hanging by a transport error.
     *
     * ANNOUNCED IN THE SAME TICK AS THE CALL, which is why the ack ordering below sits INSIDE it. It
     * used to be awaited before this assignment, so for one ack round trip a pull had been asked for
     * and the barrier could not see it: an archive replay reaching `waitForGroupQueueIdle` in that
     * window passed straight through, decrypted the frame, and the pull then delivered it a second
     * time. The restore now asks for its pull while phase 2 is still to run
     * (`notifyConversationRowsSeeded`), so that window is one every boot would cross.
     */
    const pull = (async () => {
      // A PULL MUST NOT RACE THIS DEVICE'S OWN ACKNOWLEDGEMENT, and this line used to start one that
      // did: `void`, so the flush of any persisted ack was still in the air when the server answered,
      // and so was the drain's ack when `refetchFramesLeftBehind` called straight back in here.
      // Awaiting it is an ORDERING, not a timeout - it resolves the moment the acks land, or once
      // their retries are exhausted, and in that second case the rows really are still owed.
      await this.announceAck([]).catch(() => {});
      try {
        // The per-page silence deadline is the delivery API's own (`PENDING_PAGE_STALL_MS`): it is a
        // property of that request, and a second copy here is a second number to keep true.
        await this.delivery.pullPendingMessagesJson({
          onPage: (rows) => {
            fetched += rows.length;
            recordPendingMessagesFetched(rows.length);
            console.log(`[PENDING] Fetched ${rows.length} pending messages (${fetched} so far)`);
            this.enqueuePendingRows(rows as Record<string, unknown>[]);
          },
        });
        // Every page fetched and enqueued: the server holds nothing more for this device, which is
        // the fact the barrier is allowed to stand on.
        this.mailboxEmptiedByAPull = true;
        emptied = true;
        if (fetched === 0) {
          console.log(
            `[PENDING] No pending MLS messages for ${sanitizeForLog(this.userId)}:${sanitizeForLog(
              this.deviceId
            )}`
          );
        }
      } catch (e) {
        // Partial progress is still progress, and saying so is the difference between "the pull
        // failed" and "the pull failed after draining 4 pages" - the second is what proves the
        // backlog is shrinking across attempts.
        //
        // NAME THE CONSEQUENCE, not just the failure. A transport failure is not an answer: reaching
        // here means this device's offline backlog is still on the server and nothing here will go
        // back for it - the next reconnect's pull is what covers it. Read as "fetch failed", the line
        // sat in production logs beside a queue that had not shrunk in weeks and nobody connected the
        // two. `pullPendingMessagesJson` halves its page only against a page that did not ARRIVE, and
        // gives up at once on a transport failure (nobody answered: no smaller page can help), which
        // is the expected end of an offline start - one line, by its class, no stack.
        const where = `the backlog for ${this.userId}:${this.deviceId} is UNDRAINED and stays queued until the next reconnect`;
        const revokedHere =
          e instanceof SessionEndedByDeviceRevocationError && e.names(this.userId, this.deviceId);
        if (revokedHere) {
          // A DESIGNED END, NOT A FAULT: the owner revoked THIS device, the server deleted its
          // backlog, and the wipe that follows erases the device. Nothing is left to drain and no
          // reconnect would drain it, so neither an error line nor "stays queued" is true.
          console.info(
            `[PENDING] Pending fetch ended after ${fetched} message(s): this device was revoked by its owner, nothing remains to drain`
          );
        } else if (isTransportFailure(e)) {
          console.warn(
            `[PENDING] Pending fetch got no answer after ${fetched} message(s) - ${where}: ${String(e)}`
          );
          // THE CONNECTIVITY STORE IS TOLD: this route reads the raw fetch (it applies the 401 rule
          // itself), so nothing else records that it got no answer. It is the fact the barrier reads
          // to hold its pull for the reconnect, and the store's probe announces the link's return.
          // NOT for a deadline (`RequestDeadlineError`, e.g. the token refresh's): `trackedFetch`
          // already counts that one towards `STALLS_BEFORE_UNREACHABLE`, and one expiry is a slow
          // moment, not a dead link. The page itself answering clears it (`pullPendingMessagesJson`).
          if (e instanceof TransportFailureError) connectivity.notifyServerUnreachable();
        } else {
          console.error(
            `[PENDING] Pending fetch failed after ${fetched} message(s) - ${where}:`,
            e
          );
        }
        // WHAT THIS FAILURE HOLDS UP, made visible: a drain waiter (a parked seed ask, an admission
        // observation) is woken only by a pull that ENDS whole, so it waits for the next one.
        // Not on a revoked device: no pull will ever complete there, so the line would promise one.
        const waiting = revokedHere ? 0 : this.pendingGroupDrainWaiters();
        if (waiting > 0) {
          console.info(
            `[PENDING] ${waiting} drain waiter(s) (parked seed asks, admission observations) wait for a pull that completes`
          );
        }
      }
    })();
    // CHAINED, NEVER OVERWRITTEN. Two pulls can overlap (a reconnect and the restore's seeded-rows
    // pull), and the barrier must stand until EVERY one of them has landed. Assigning `pull` alone let
    // the first to finish null the slot while the other was still fetching, so a
    // `waitForGroupQueueIdle` passed and decrypted a frame that pull then delivered a second time.
    const previous = this.pendingPullInFlight;
    const announced = previous ? Promise.all([previous, pull]).then(() => {}) : pull;
    if (previous) {
      console.log('[PENDING] A pull is already in flight - the barrier now waits for both');
    }
    this.pendingPullInFlight = announced;
    try {
      await pull;
    } finally {
      // CLEARED BEFORE THE BARRIER, deliberately: the line below is that barrier, and a pull still
      // announcing itself here would be waiting on its own completion. ONLY WHEN IT IS STILL OURS: a
      // later pull chained onto it, and clearing would blind the barrier to that one.
      if (this.pendingPullInFlight === announced) this.pendingPullInFlight = null;
    }
    await this.settleMailbox();
    // THE PULL'S END IS AN EVENT FOR `whenGroupDrained`: a group that went idle before the mailbox
    // was listed whole reads drained only now (the start-up sync runs before the first full pull).
    this.wakeGroupDrainedWaiters('pull ended');
    // Every frame refused for lack of a conversation row before this pull started has now been
    // listed AND handled - read, or refused again under a later mark - so the gap healer stops
    // holding live frames behind it (`refusedBacklogIsQueued`). A pull that died half-way proves
    // nothing about the pages it did not list.
    if (emptied) dischargeRefusedBacklog(refusalsCovered);
    // ...and it leaves the backlog OWED A PULL, which its start took off the work list: re-armed, so
    // the next event asking for that backlog (`notifyConversationAvailable`) pulls again.
    else rearmRefusedBacklog(refusalsCovered);
    // Only now is the answer complete: the rows were enqueued, not handled, so what the handler
    // refused to acknowledge is known only once the queue has drained. Without this, a device that
    // re-fetches the same backlog on every reconnect reports a perfectly healthy pull each time.
    reportUnackedFrames((msg) => console.warn(msg));
    if (emptied && this.resolveInitialDrain) {
      this.resolveInitialDrain();
      this.resolveInitialDrain = null;
    }
  }

  /**
   * Routes one page of raw pending rows through the serialized queue, so they never race with live
   * WebSocket messages calling messageCallback.
   *
   * **A ROW THIS DROPS IS NEVER ACKED, SO IT IS DRAINED AGAIN FOR EVER.** Only what reaches
   * `enqueueMessage` can ever be acknowledged: anything the loop passes over stays in
   * `queued_message` until the 90-day retention, is re-fetched on every reconnect, and makes the
   * backlog a number that only ever grows. That is invisible from the outside - a pull that returns
   * 500 rows and acknowledges none looks exactly like a pull that had nothing to do - so the rows
   * are COUNTED and NAMED here, with their two causes kept apart because they call for opposite
   * fixes: a payload that is absent or empty is a producer writing a row it never filled, while one
   * that fails to decode is a corrupt or truncated write.
   */
  private enqueuePendingRows(rows: Record<string, unknown>[]): void {
    /** Rows this page will not acknowledge, by cause. Bounded by the page size, so keeping ids is cheap. */
    const undeliverable: { empty: string[]; malformed: string[] } = { empty: [], malformed: [] };

    for (const msg of rows) {
      const msgId = (msg.id || msg._id) as string | undefined;
      const queuedCreatedAt = parseServerTimestampMs(msg.createdAt);
      const proto: string | undefined = typeof msg.proto === 'string' ? msg.proto : undefined;

      // ── Control messages (group_reset persisted for offline devices) ──
      // These have no MLS payload (empty proto). Both platforms ACK and ignore:
      // WebSocket reconnect is sufficient to re-sync state.
      if (msg.type === 'group_reset') {
        this.enqueueMessage(
          {
            senderId: (msg.senderId as string) || 'unknown',
            ciphertext: new Uint8Array(0),
            groupId: (msg.groupId as string) || undefined,
            isWelcome: false,
            isCommit: false,
            queuedMessageId: msgId,
            type: 'group_reset',
            queuedCreatedAt,
          },
          'pull'
        );
        continue;
      }

      if (proto) {
        try {
          const ciphertext = fromBase64(proto);
          if (ciphertext.length > 0) {
            this.enqueueMessage(
              {
                senderId: (msg.senderId as string) || 'unknown',
                senderDeviceId: (msg.senderDeviceId as string) || undefined,
                ciphertext,
                groupId: (msg.groupId as string) || undefined,
                isWelcome: msg.isWelcome === true,
                isCommit: msg.isCommit === true,
                ratchetTreeBytes:
                  typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                    ? fromBase64(msg.ratchetTree as string)
                    : undefined,
                queuedMessageId: msgId,
                queuedCreatedAt,
                // The row's column (migration 033): the server routed it to this device alone.
                addressed: msg.addressed === true,
              },
              'pull'
            );
            continue;
          }
        } catch (e) {
          console.error('[PENDING] Failed to enqueue proto message:', e);
          undeliverable.malformed.push(msgId ?? '(no id)');
          continue;
        }
      }
      // Reached only by a row carrying no usable payload: no `proto` at all, or one that decoded to
      // zero bytes. Nothing was enqueued, so nothing will ACK it.
      undeliverable.empty.push(msgId ?? '(no id)');
    }

    const stuck = undeliverable.empty.length + undeliverable.malformed.length;
    if (stuck > 0) {
      const sample = (ids: string[]) =>
        ids.slice(0, 5).join(', ') + (ids.length > 5 ? ', ...' : '');
      console.warn(
        `[PENDING] ${stuck}/${rows.length} row(s) of this page cannot be delivered and will NOT be acknowledged - they will be re-fetched on every reconnect until the retention window expires. ` +
          `empty payload: ${undeliverable.empty.length}${undeliverable.empty.length ? ` [${sample(undeliverable.empty)}]` : ''}; ` +
          `undecodable payload: ${undeliverable.malformed.length}${undeliverable.malformed.length ? ` [${sample(undeliverable.malformed)}]` : ''}`
      );
    }
  }

  // ── Delivery wrappers ─────────────────────────────────────────────────────
  // All methods below are pure pass-throughs to this.delivery. Both Web and Tauri
  // implementations were 100% identical, so they live here once.

  /**
   * Asks a member to Welcome this device, and reads what the server did with the ask
   * ({@link WelcomeRequestAnswer}): `forwarded` to one online member, `stored` for every member's
   * next connection, or `null` when no answer said either - said here, since no answer is not a
   * statement that the ask was put.
   */
  async sendWelcomeRequest(groupId: string): Promise<WelcomeRequestAnswer> {
    const answer = await this.delivery.deliveryPost('welcome-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
    if (answer?.status === 'forwarded' && typeof answer.target === 'string') {
      return { status: 'forwarded', target: answer.target };
    }
    if (answer?.status === 'no_peer_online') return { status: 'stored' };
    console.warn(
      `[MLS] welcome_request for ${groupId.slice(0, 8)}... got no answer naming what was done with it (status ${answer === null ? 'none' : String(answer.status)})`
    );
    return null;
  }

  /**
   * Asks one online member to REPUBLISH this group's external-join base, and asks for nothing else.
   *
   * THE FAVOUR THAT MATCHES THE REFUSAL. `externalJoin` answers `stale_base` when the published
   * GroupInfo names an epoch the group has left: no retry can ever satisfy it, because only a member
   * holding the tree can mint a new one. Until 2026-09-04 that refusal fell into the shared
   * `sendWelcomeRequest` fallback, which asks for something far more expensive and entirely
   * different - a Welcome MUTATES the tree, takes the group's add lock and replays the
   * duplicate-leaf race, where a refresh is a read-only publish that changes no epoch and takes no
   * lock. Measured on production the same day: four of the forty-three groups holding a base were
   * stale, all by exactly one epoch, two of them since 2026-08-30 with three devices sitting
   * `pending` on them - a stale base does not drain itself, because only a member's next commit
   * republishes one and a quiet conversation has none.
   *
   * Nothing is retried here and nothing is stored for an offline member, so THE ANSWER IS THE ONLY
   * THING THAT SAYS WHETHER ASKING AGAIN CAN HELP - and it used to be discarded. `no_peer_online`
   * means the server read the roster and found no member to publish to; until some member's state
   * moves, the next ask returns the same word. Measured on production 2026-09-12: one locked-out
   * device asked for group `4f87267a` every sixty seconds for at least twenty-seven consecutive
   * minutes, and the server answered `NO_PEER_ONLINE members=1` every single time, about a group
   * whose only other member had not connected since 2026-08-03.
   *
   * `noPeerOnline` is true ONLY on an explicit `no_peer_online`, never on a throw or an
   * unparseable body - see {@link BaseRefreshOutcome}.
   */
  async sendBaseRefreshRequest(groupId: string): Promise<BaseRefreshOutcome> {
    const answer = await this.delivery.deliveryPost('base-refresh-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
    return {
      noPeerOnline: answer?.status === 'no_peer_online',
      target: typeof answer?.target === 'string' ? answer.target : undefined,
    };
  }

  /**
   * Asks the server to elect ONE online member to reconcile `groupId` with us. What we want is
   * stated separately, inside MLS, so this frame carries nothing about the conversation's contents.
   *
   * The server elects the responder, so it alone knows whether there was one, and it says so:
   * `noPeerOnline` reports that answer. It is true ONLY on an explicit `no_peer_online` - a request
   * that failed to reach the server, or answered something unparseable, proves nothing about who is
   * reachable, and concluding "nobody" from it would abandon a reconciliation on a dropped packet.
   *
   * `exclude` names the members we have already heard from, so a requester chasing a coverage gap
   * walks its members instead of re-drawing the one that already told us it cannot help.
   */
  async sendHistoryRequest(
    groupId: string,
    opts: { exclude?: string[] } = {}
  ): Promise<HistoryRequestOutcome> {
    const answer = await this.delivery.deliveryPost('history-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
      ...(opts.exclude?.length ? { exclude: opts.exclude } : {}),
    });
    const excludedOnline = Number(answer?.excludedOnline);
    return {
      noPeerOnline: answer?.status === 'no_peer_online',
      target: typeof answer?.target === 'string' ? answer.target : undefined,
      // A server too old to count says nothing, and 0 is what "nothing was skipped" means - which is
      // also the reading that makes a chase keep looking rather than claim a proof it was not given.
      excludedOnline: Number.isFinite(excludedOnline) && excludedOnline > 0 ? excludedOnline : 0,
    };
  }

  /**
   * Delivers a Welcome message to the target user/device, and records it once delivered: every
   * path that welcomes a device goes through here, so `welcomeSentAt` is true for all of them.
   *
   * **AND IT IS WHERE AN OWED WELCOME IS CONSUMED.** Every accepted Add is merged owing its Welcome
   * (`mergeAccepted`); the server's answer to this send - stored, or refused for good - is what ends
   * the obligation ({@link consumeOwedWelcome}), whoever sent it: the Add's caller, or the connection
   * drain ({@link deliverOwedWelcomes}).
   *
   * ONE REQUEST AT A TIME PER WELCOME: a send of the same bytes to the same device already in flight
   * (the caller's, met by the drain) is awaited, never repeated.
   */
  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    await this.sendWelcomeConsuming(
      welcomeBytes,
      targetUserId,
      groupId,
      targetDeviceId,
      ratchetTreeBytes,
      true
    );
  }

  /**
   * {@link sendWelcome}, with the checkpoint of what it consumed left to the caller when
   * `persistEach` is false: the connection drain clears many recipients in one pass and schedules
   * ONE persist after it ({@link deliverOwedWelcomes}), since a checkpoint costs seconds on a phone.
   */
  private async sendWelcomeConsuming(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId: string | undefined,
    ratchetTreeBytes: Uint8Array | undefined,
    persistEach: boolean
  ): Promise<void> {
    const recipient = targetDeviceId ? `${targetUserId}:${targetDeviceId}` : null;
    if (!recipient) {
      await this.delivery.sendWelcome(
        welcomeBytes,
        targetUserId,
        groupId,
        undefined,
        ratchetTreeBytes
      );
      return;
    }
    const key = `${groupId}|${recipient}`;
    const inFlight = this.welcomeSendsInFlight.get(key);
    if (inFlight && sameBytes(inFlight.welcome, welcomeBytes)) {
      console.log(
        `[WELCOME] ${groupId.slice(0, 8)}... the Welcome to ${targetDeviceId} is already being sent - awaiting that request`
      );
      return inFlight.done;
    }
    const done = (async () => {
      try {
        await this.delivery.sendWelcome(
          welcomeBytes,
          targetUserId,
          groupId,
          targetDeviceId,
          ratchetTreeBytes
        );
      } catch (e) {
        if (isTerminalWelcomeRefusal(e)) {
          await this.consumeOwedWelcome(
            groupId,
            recipient,
            welcomeBytes,
            e instanceof WelcomeTargetUnknownError ? 'unknown-target' : 'refused',
            persistEach
          );
        }
        throw e;
      }
      recordWelcomeSent(groupId, targetDeviceId!);
      await this.consumeOwedWelcome(groupId, recipient, welcomeBytes, 'delivered', persistEach);
    })();
    const entry = { welcome: welcomeBytes, done };
    this.welcomeSendsInFlight.set(key, entry);
    try {
      await done;
    } finally {
      if (this.welcomeSendsInFlight.get(key) === entry) this.welcomeSendsInFlight.delete(key);
    }
  }

  /** The Welcome sends in flight, by `groupId|userId:deviceId` - see {@link sendWelcome}. */
  private welcomeSendsInFlight = new Map<string, { welcome: Uint8Array; done: Promise<void> }>();

  /**
   * The server ANSWERED a Welcome to `recipient` in `groupId`: whatever the state owed it there is
   * owed no longer for `welcome` (a no-op when nothing was), and - with `persist` - the change is
   * handed to the next checkpoint. `refused` is the terminal `WELCOME_TARGET_NOT_MEMBER`:
   * the server enrols an Add's people with the commit it accepts, or refuses them for good, so
   * resending the same bytes cannot change the answer - said at the level that accuses, since an
   * accepted Add whose person is off the roster is the visible end of something upstream.
   * `unknown-target` is the terminal `WELCOME_TARGET_UNKNOWN`: no device is registered under the
   * target any more (revoked, or its account erased) - a race with a revocation, said at WARN, since
   * the commit's own answer normally says it first and no Welcome is owed at all
   * ({@link undeliverableAdmits}). A clear that fails leaves the recipient owed: the next connection
   * sends the same bytes again, which the server stores once.
   */
  private async consumeOwedWelcome(
    groupId: string,
    recipient: string,
    welcome: Uint8Array,
    answer: 'delivered' | 'refused' | 'unknown-target',
    persist: boolean
  ): Promise<void> {
    const short = groupId.slice(0, 8);
    if (answer === 'refused') {
      console.error(
        `[WELCOME] ${short}... Welcome REFUSED for ${recipient.slice(0, 8)}...: the roster does not ` +
          'name its owner - terminal, no longer owed; the leaf it admitted has no seat and the stray ' +
          'sweep collects it'
      );
    }
    if (answer === 'unknown-target') {
      console.warn(
        `[WELCOME] ${short}... Welcome REFUSED for ${recipient.slice(0, 8)}...: no device is ` +
          'registered under it any more (revoked, or its account erased) - terminal, no longer owed; ' +
          'the leaf it admitted has no seat and the stray sweep collects it'
      );
    }
    try {
      // The entry carrying THESE bytes only: an older Welcome answered late never clears a newer one.
      await this.welcomeDelivered(groupId, recipient, welcome);
      // To disk with the next checkpoint, like any state change outside a commit.
      if (persist) scheduleOutboundMlsPersist();
    } catch (e) {
      console.error(
        `[WELCOME] ${short}... the owed Welcome to ${recipient.slice(0, 8)}... could not be cleared ` +
          `(${answer}) - it stays owed and the next connection sends it again: ${String(e).slice(0, 120)}`
      );
    }
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Whether this device's id pre-existed this boot, and so whether an MLS state SHOULD be found
   * beside it.
   *
   * Read by the WASM-backed implementation and handed to the client constructor, which otherwise
   * cannot tell a first enrolment from a device that lost its snapshot - both reach it as a device
   * key with no state. `false` is the safe default: it is what a service that has not resolved an
   * id is entitled to claim, and it accuses nothing.
   *
   * Set by {@link resolveDeviceId} (found an id / minted one) and cleared by
   * {@link rotateDeviceIdentity}, which mints a new identity deliberately.
   */
  protected stateWasExpected = false;

  /**
   * Set when a rotation's checkpoint was REFUSED ({@link rotateDeviceIdentity}): from then on this
   * document writes no MLS state, ever, and {@link persistCheckpoint} and {@link changeDeviceKey}
   * refuse typed (`MlsStateWriteRefusedError('ended')`).
   *
   * THE VERSION GUARD IS NOT A SUBSTITUTE. It orders by counter alone and does not know whose blob
   * it holds: a rotation refused as a `collision` (same version) has its very next capture tagged
   * one above the stored one, and that capture is WRITTEN - the fresh, groupless client over the
   * other document's good state, next to the old stored id. A reload does not stop the page either:
   * it runs until the next response commits, and a persister flight, the session watchdog or a burn
   * checkpoint can land in between. A latch on the one write path is what makes that window inert.
   * Never cleared: a document that set it is ended, and the next one is a new instance.
   *
   * READ AT THE PUT, NOT ONLY AT THE START. A checkpoint captures, encrypts off-thread and waits
   * for the database; a flight that passed the start check before the rotation's refusal would
   * otherwise land after it. So the web write reads it inside its own transaction, and the
   * rotation's refusal SETS it there, synchronously (`MlsStateWriteLatch` in `utils/hex.ts`).
   * SILENT at every refused write: the rotation's line said it once, where it was decided.
   */
  private stateWritesEnded = false;

  /**
   * Resolves (or generates and persists) this device's stable per-user id WITHOUT
   * touching the encrypted MLS state. Safe to call before {@link init}, so the PIN
   * can be verified against the real deviceId before any state decryption /
   * fresh-start can run - a wrong PIN must never delete/revoke the device.
   *
   * Resolution order: in-memory (already resolved) → localStorage → native restore
   * (Tauri push context) → freshly generated. The result is cached on the instance
   * and mirrored to the delivery client, so the subsequent {@link init} reuses it.
   */
  async resolveDeviceId(userId: string): Promise<string> {
    if (this.deviceId && this.deviceId !== UNRESOLVED_DEVICE_ID) return this.deviceId;
    const deviceKey = ACCOUNT_KEY.deviceId(userId);
    const stored = localStorage.getItem(deviceKey);
    let resolved = stored;
    if (!resolved) {
      const restored = await this.restoreDeviceIdFromNative(userId);
      // A NATIVE RESTORE COUNTS AS PRE-EXISTING, which is the whole point of that path: it hands
      // back the id of a device that was already enrolled and whose WebView stores were evicted
      // from under it, so a state missing THERE is a state that was lost. A factory wipe does not
      // reach this branch - it clears the native app data too, so the id below is minted instead.
      this.stateWasExpected = restored !== null;
      resolved = restored ?? this.generateDeviceId(userId);
      localStorage.setItem(deviceKey, resolved);
    } else {
      this.stateWasExpected = true;
    }
    this.deviceId = resolved;
    this.delivery.deviceId = resolved;

    // Unconditionally, on EVERY resolution and not only on a mint: a device whose id sits in
    // localStorage but whose native mirror was never written is one eviction away from becoming a
    // second device, and its next sign-in is the only chance to repair it. Best-effort, because
    // availability comes first - but it ACCUSES, since a silent loss here is what let the estate
    // drift unnoticed.
    try {
      await this.persistDeviceIdNatively(userId, resolved);
    } catch (e) {
      console.error(
        `[IDENTITY] Durable copy of deviceId ${sanitizeForLog(resolved)} FAILED - a localStorage` +
          ` eviction will now mint a NEW device and orphan this one's leaf in every group:`,
        e
      );
    }
    return resolved;
  }

  /**
   * Generates and publishes this device's key packages, re-enrolling under a fresh id when the
   * server answers that THIS INSTALL RETIRED the id ({@link DeviceRevokedError}), and never when it
   * answers that the OWNER revoked the device ({@link DeviceRevokedByOwnerError}).
   *
   * A retired id is denylisted for good and `resolveDeviceId` deliberately hands the same id back
   * after a reinstall, so retrying it is futile: the only way forward is to become a new device.
   * Retried exactly once - a second refusal is a server bug, not a state to keep rotating through.
   *
   * AN OWNER'S REVOCATION IS THE OPPOSITE ANSWER, whichever of the two ways the device learns it
   * first - the `device_revoked` frame or this refusal. The refusal says who banned the id, and an
   * owner's revocation goes to the one revocation consequence there is - the `onDeviceRevoked`
   * handler, which confirms with the server and runs `wipeRevokedDevice` - and the round fails.
   * Nothing here mints an id.
   */
  async generateKeyPackage(deviceKeyB64: string): Promise<DatedKeyPackage> {
    // NAMED FOR ITS SPAN, so an external join issued while it runs can wait for the publication it
    // depends on ({@link externalJoin}). The identity check keeps a later round from clearing its
    // successor, and `finally` means a throw leaves nothing for a join to wait on.
    // SET WHEN THE CALLER GAVE UP ON THIS ROUND (the deadline below). A stale round that late hits a
    // revocation must not rotate the identity: it would change `deviceId`, localStorage, the
    // delivery client and delete a device while a later round or a join runs on the id it is
    // abandoning - a later round could publish under an id rotated away, a join could exclude a
    // stale id. The rotation is a logged no-op and the late round just ends.
    // A property of a shared object, not a bare `let`: the deadline handler below flips it while the
    // round is suspended at an `await`, a write control-flow analysis (CodeQL 2552) cannot see.
    const roundState = { stale: false };
    const round = (async (): Promise<DatedKeyPackage> => {
      try {
        const published = await this.generateKeyPackageImpl(deviceKeyB64);
        // A published round proves this page's identity is accepted: any refused-rotation run ended.
        forgetRefusedRotationReloads();
        // And the server is reachable: an abandoned id a rotation could not delete is retried here.
        this.retireAbandonedIds();
        return published;
      } catch (e) {
        if (e instanceof DeviceRevokedByOwnerError) {
          this.reportRevokedByOwner(e);
          throw e;
        }
        if (!(e instanceof DeviceRevokedError)) throw e;
        if (roundState.stale) {
          console.error(
            `[MLS] an ABANDONED key package round met a revocation late - NOT rotating the identity (a later round owns it now); device ${sanitizeForLog(this.deviceId)}`
          );
          throw e;
        }
        let abandoned: string;
        try {
          abandoned = await this.rotateDeviceIdentity(deviceKeyB64, 'revoked server-side');
        } catch (refused) {
          // The caller of this round logs and carries on (`syncConnectionAfterWsOpen`), so ending
          // the document is HERE or nowhere: the client in memory is the fresh, unrecorded one.
          if (refused instanceof MlsStateWriteRefusedError) {
            this.endDocumentAfterRefusedRotation();
          } else {
            // ANY OTHER FAILURE ENDS THE LIVE SESSION ON THIS DEVICE TOO, into the PIN gate. The
            // rotation moved this client's device id before its load, while the id on disk is still
            // the old one (it is recorded only after the rotation's checkpoint): the client in memory
            // describes an identity nothing recorded. Restoring the old one in place would re-open a
            // state behind the session's back; the unlock reopens it as the disk holds it. The cause
            // is named for what it is - a native slot found EMPTY is said so only when the native
            // side answered that (on Tauri; web has no native slot), never assumed from a failure.
            reportMlsSessionLost(
              isMlsManagerAbsent(refused)
                ? 'identity rotation found no native session'
                : 'identity rotation failed'
            );
          }
          throw refused;
        }
        console.warn(
          `[MLS] Device ${sanitizeForLog(abandoned)} was revoked - re-enrolled as ${sanitizeForLog(
            this.deviceId
          )}`
        );
        // THE SOCKET CARRIES THE NEW ID BEFORE ANYBODY CAN ADDRESS IT. The rotation queued a reopen;
        // the package published below is what makes the new id addressable, so it waits for that
        // reopen. Then the server's queue for the new id is read once, so nothing addressed to it
        // while no socket carried it waits for a reconnect. Not awaited: the drain takes the MLS
        // lock, which a round may be holding.
        try {
          await this.gatewaySocketSettled();
          void this.fetchPendingMessages().catch((e: unknown) =>
            console.warn(
              `[MLS] re-enrolled: the pending queue of ${sanitizeForLog(this.deviceId)} could not be read: ${sanitizeForLog(String(e))}`
            )
          );
        } catch (e) {
          console.warn(
            `[MLS] re-enrolled: the gateway socket did not reopen under ${sanitizeForLog(this.deviceId)} (${sanitizeForLog(String(e))}) - publishing anyway; the reconnect owns the socket and reads the queue`
          );
        }
        if (roundState.stale) {
          console.error(
            '[MLS] an ABANDONED key package round was abandoned during its re-enrolment - not publishing under the new id from this stale round'
          );
          throw new Error('key package round abandoned during re-enrolment');
        }
        const republished = await this.generateKeyPackageImpl(deviceKeyB64);
        forgetRefusedRotationReloads();
        return republished;
      }
    })();
    // THE CALLER STOPS WAITING AFTER A DEADLINE, THE WORK IS NOT CANCELLED (a native `invoke` and a
    // mint under the MLS lock cannot be aborted). Without this a hang anywhere in the round kept
    // the active count above zero for ever, so every join parked and its flight never cleared.
    // WHAT AN ABANDONED ROUND MAY STILL DO: finish its mint, persist up to 50 bundles, publish. The
    // next round reads the server's pool count: if the late publish landed it mints nothing, and if
    // the round stopped between persist and publish it mints a second batch whose first batch is
    // orphaned locally until `prune_expired_key_packages` - the same cost any failed publish after
    // a mint already has. It is logged when it ends.
    //
    // TWO COSTS OF ABANDONING, stated: (1) the native promise stays pending, so a device whose
    // native call hangs for good leaks ONE pending promise per deadline cycle (each later round
    // that hangs adds one); (2) the abandoned round may still reach a late revocation, which would
    // rotate the identity under a successor - `stale` turns that rotation into a logged no-op, and
    // an abandoned round that is mid-rotation when the deadline fires refuses to publish afterwards.
    // The persist and publish steps inside `generateKeyPackageImpl` are platform code and are NOT
    // gated: a late publish under the CURRENT id is harmless (it is what the next round would do),
    // and the id cannot have changed because only a non-stale round rotates.
    const bounded = raceDeadline(
      'key-package-round',
      round,
      KEY_PACKAGE_ROUND_DEADLINE_MS,
      (late) =>
        console.warn(
          late.ok
            ? '[MLS] an abandoned key package round FINISHED late (its bundles are persisted and published)'
            : `[MLS] an abandoned key package round FAILED late: ${sanitizeForLog(String(late.error))}`
        )
    );
    this.keyPackageRoundInFlight = bounded;
    this.keyPackageRoundsActive++;
    try {
      const keyPackage = await bounded;
      this.noteKeyPackageRoundSettled();
      return keyPackage;
    } catch (e) {
      if (e instanceof DeliveryDeadlineError && e.operation === 'key-package-round') {
        roundState.stale = true;
      }
      this.noteKeyPackageRoundSettled(e ?? new Error('key package round failed'));
      throw e;
    } finally {
      if (this.keyPackageRoundInFlight === bounded) this.keyPackageRoundInFlight = null;
    }
  }

  /**
   * Hands an owner's revocation met by a key-package round to the ONE revocation consequence
   * (`onDeviceRevoked`, the handler the `device_revoked` frame also calls): it confirms with the
   * server and wipes the device. Never a rotation. With no handler wired - no live session yet - the
   * login's own revocation gate is what wipes, and the line says so.
   */
  private reportRevokedByOwner(e: DeviceRevokedByOwnerError): void {
    console.error(
      `[MLS] device ${sanitizeForLog(e.deviceId)} was REVOKED BY ITS OWNER (${e.reasonStated ? 'stated by the server' : 'cause not stated - read as the owner'}) - NOT re-enrolling; ${this.deviceRevokedCallback ? 'handing it to the revocation handler (sign out and wipe)' : 'no revocation handler is wired yet, so the login revocation gate is what wipes it'}`
    );
    this.deviceRevokedCallback?.();
  }

  /** Records a settled round and wakes every parked join, which re-reads the fact itself. */
  private noteKeyPackageRoundSettled(error?: unknown): void {
    this.keyPackageRoundsActive--;
    this.keyPackageRoundsSettled++;
    if (error !== undefined) {
      this.lastKeyPackageRoundFailure = { settled: this.keyPackageRoundsSettled, error };
    }
    this.wakeKeyPackageRoundWaiters(false);
  }

  private wakeKeyPackageRoundWaiters(tornDown: boolean): void {
    const waiters = this.keyPackageRoundWaiters;
    this.keyPackageRoundWaiters = [];
    for (const wake of waiters) wake(tornDown);
  }

  /**
   * Waits until THE SERVER HAS STATED that this device holds a static KeyPackage - the fact the
   * commit gate reads before it activates a membership - and answers why it could not be proven
   * otherwise.
   *
   * THE FACT IS THE CONDITION, THE ROUND IS ONLY WHAT MAKES IT TRUE, and nothing here is a clock.
   * Each pass: capture the settle count, READ the fact, then decide.
   * - published: join.
   * - a round settled while the read was in flight: the answer predates it, so read again (the lost
   *   wake-up of parking on a stale answer for a round that already came and went). If that round
   *   failed and nothing else is running, the failure is the answer.
   * - a round is running: park until one settles, then read again. A round failing while an
   *   overlapping one still runs refuses nobody - the survivor may yet publish.
   * - no round is running and the fact is absent (or the id banned, which a round re-enrols only when this install retired it):
   *   START one, the only thing that can make it true, and wait for it. If it succeeded and the
   *   server STILL does not hold the package, that is unverified, never a second round.
   * - the read got no answer and no round is running: unverified; nothing is claimed.
   *
   * WHAT IS BOUNDED: the join's WAIT. Each HTTP call of a round has its own typed deadline, and the
   * whole round is raced against `KEY_PACKAGE_ROUND_DEADLINE_MS` (the native `invoke`, the mint and a
   * re-enrolment cannot be aborted, only abandoned), so a hang fails the round typed and wakes this
   * with a refusal. WHAT IS NOT: the abandoned work itself - see `generateKeyPackage`.
   */
  private async awaitOwnKeyPackagePublished(
    short: string
  ): Promise<'published' | 'round_failed' | 'unverified'> {
    let startedOwnRound = false;
    for (let pass = 1; ; pass++) {
      // A PASS COUNT IS THE PROOF OF TERMINATION when rounds keep settling while the fact stays
      // absent or revoked: each pass is one read, and the count is per join attempt, not a clock.
      if (pass > EXTERNAL_JOIN_FACT_PASSES) {
        this.reportOwnKeyPackageUnverified(
          short,
          `the fact stayed unpublished across ${EXTERNAL_JOIN_FACT_PASSES} reads`
        );
        return 'unverified';
      }
      const settledBefore = this.keyPackageRoundsSettled;
      // NEVER LEARN BY A 404 WHAT THE CLIENT ALREADY KNOWS: this device's id was MINTED in this
      // process (`stateWasExpected` false - no id was stored before this boot, read from durable
      // state by `resolveDeviceId`), so its whole life is this process, no round of it has settled
      // yet and one is running: its FIRST publication is in flight and the server cannot hold a
      // package of it. A RETURNING device (an id stored before this boot) is never skipped - its
      // package may well be published already, and waiting on its boot round would make a failed
      // round fail a join that a read would have let through. The read is made when the round settles.
      const firstPublicationRunning =
        pass === 1 &&
        !this.stateWasExpected &&
        this.keyPackageRoundsActive > 0 &&
        this.keyPackageRoundsSettled === 0;
      const answer = firstPublicationRunning
        ? null
        : await this.delivery.fetchDeviceKeyPackage(this.userId, this.deviceId);
      const publication = answer ? keyPackagePublication(answer) : 'absent';
      if (publication === 'published') {
        this.ownKeyPackageUnverifiedReported = null;
        return 'published';
      }
      if (answer?.kind === 'unanswered') {
        console.warn(
          `[MLS] externalJoin ${short}... could not read this device's KeyPackage publication: ${sanitizeForLog(answer.detail)}`
        );
      }
      const failedSince = (): boolean =>
        this.lastKeyPackageRoundFailure !== null &&
        this.lastKeyPackageRoundFailure.settled > settledBefore &&
        this.keyPackageRoundsActive === 0;
      if (this.keyPackageRoundsSettled !== settledBefore) {
        if (failedSince()) return this.roundFailedForJoin(short);
        console.log(
          `[MLS] externalJoin ${short}... a key package round settled during the read (${publication}) - reading the fact again`
        );
        continue;
      }
      if (this.keyPackageRoundsActive > 0) {
        console.log(
          `[MLS] externalJoin ${short}... waits for the server to hold this device's KeyPackage (${answer ? publication : 'first publication running, not read'}, a round is running): the commit gate refuses an activation without one`
        );
        const tornDown = await new Promise<boolean>((resolve) => {
          this.keyPackageRoundWaiters.push(resolve);
        });
        if (tornDown) {
          console.warn(
            `[MLS] externalJoin ${short}... released: the client was torn down while it waited for a key package round`
          );
          return 'unverified';
        }
        if (failedSince()) return this.roundFailedForJoin(short);
        console.log(
          `[MLS] externalJoin ${short}... woken by a settled key package round - reading the fact again`
        );
        continue;
      }
      if (publication === 'unknown' || startedOwnRound) {
        this.reportOwnKeyPackageUnverified(
          short,
          publication === 'unknown'
            ? 'the server did not answer the read and no round is running'
            : `our own round succeeded and the server still does not hold the package (${publication})`
        );
        return 'unverified';
      }
      console.warn(
        `[MLS] externalJoin ${short}... finds NO KeyPackage published for this device (${publication}) and no round running - starting the round, the only thing that can make it true`
      );
      startedOwnRound = true;
      try {
        // THE KEY IS WHATEVER BOOT PASSED, INCLUDING '' IN BIOMETRIC MODE (the native layer resolves
        // it from the keystore): an empty string is not "no key", so there is no guard on it.
        await this.generateKeyPackage(this.currentDeviceKeyB64);
      } catch (e) {
        console.warn(
          `[MLS] externalJoin ${short}... not attempted - the key package round FAILED:`,
          sanitizeForLog(String(e))
        );
        return 'round_failed';
      }
    }
  }

  /**
   * Says ONCE per distinct reason that a join could not be attempted for want of a published
   * KeyPackage, and what would change it. The recovery cadence (about once a minute) asks again with
   * no repair in between, so repeating the warning would be noise: a reader needs the state change,
   * not the heartbeat. Cleared when the fact is next seen published.
   */
  private reportOwnKeyPackageUnverified(short: string, why: string): void {
    if (this.ownKeyPackageUnverifiedReported === why) {
      console.debug(`[MLS] externalJoin ${short}... still not attempted: ${why}`);
      return;
    }
    this.ownKeyPackageUnverifiedReported = why;
    console.warn(
      `[MLS] externalJoin ${short}... not attempted: ${why}. Not repeated at this level until it changes - what changes it is a round publishing this device's KeyPackage or the server answering the read`
    );
  }

  private roundFailedForJoin(short: string): 'round_failed' {
    console.warn(
      `[MLS] externalJoin ${short}... not attempted - the key package round FAILED, so the gate would answer no_key_package:`,
      sanitizeForLog(String(this.lastKeyPackageRoundFailure?.error))
    );
    return 'round_failed';
  }

  /**
   * Abandons this device's identity and starts over under a freshly generated id: the MLS
   * credential is `userId:deviceId`, so a new id IS a new device and the old state can only be
   * discarded. Used for a credential mismatch (the state names someone else) and for a server-side
   * revocation (the id is denylisted and no retry can lift it).
   *
   * Order matters: the fresh state is persisted under the new id BEFORE anything else may fail.
   * Leaving a new id in localStorage next to the old blob is what made the churn self-sustaining -
   * every launch mismatched again and minted yet another device.
   *
   * PERSIST FIRST, THEN THE DURABLE SIDE EFFECTS (2026-10-21). A web checkpoint now REJECTS when the
   * version guard refuses it, which means another document - another tab of this account - wrote the
   * stored state after this one loaded. The id in `localStorage`, the send ledger and the server's
   * device row are shared with that document, so they move only once the fresh state is on disk. On
   * a refusal NONE of them moves - the old device is not deleted, the other document may be serving
   * it - and the refusal propagates typed.
   *
   * WHAT IS LEFT IN MEMORY IS NOT RESTORED, IT IS ENDED. The old client is gone (the fresh load
   * replaced it), so rolling the ids back would leave a fresh, groupless client under the old id - a
   * session that publishes nothing, rotates again on every round, and once its counter passes the
   * other document's writes the fresh state next to the old id. So the refusal first LATCHES this
   * document's writes ({@link stateWritesEnded}): nothing it captures afterwards reaches the disk,
   * whatever the version guard would have said. The ids stay the fresh ones, which at
   * least agree with the client, and each caller ends what holds them: init fails and the login
   * releases its client (`savedStateFailure`), and the revocation path reloads the document
   * ({@link endDocumentAfterRefusedRotation}) so it starts again from what the disk now holds.
   *
   * @returns the id that was abandoned, for the caller to log.
   */
  protected async rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string> {
    const oldDeviceId = this.deviceId;
    console.warn(`[MLS] Rotating device identity (${reason}), abandoning ${oldDeviceId}`);
    this.deviceId = this.generateDeviceId(this.userId);
    this.delivery.deviceId = this.deviceId;
    // A brand new identity has never held a state, and the load below deliberately passes none.
    // Left true, the abandonment of a device would report itself as a loss.
    this.stateWasExpected = false;
    await this.loadStateWithKey(deviceKeyB64, undefined);
    try {
      // ENDS THE DOCUMENT ON REFUSAL, inside the transaction that refuses it: a flight of this
      // document already past its start check must find the latch set at its own put.
      await this.persistCheckpoint({ endsDocumentOnRefusal: true });
    } catch (e) {
      if (!(e instanceof MlsStateWriteRefusedError)) throw e;
      // Already set by the web write; set here too for a writer that refuses outside a transaction.
      this.stateWritesEnded = true;
      console.error(
        `[MLS] Device identity rotation ABORTED: another document wrote this account's state (${e.outcome}), so ${this.deviceId} is on no disk - ${oldDeviceId} stays the stored id and keeps its server row, every later MLS state write of this document is refused, and this document must end`
      );
      throw e;
    }
    localStorage.setItem(ACCOUNT_KEY.deviceId(this.userId), this.deviceId);
    // THE SOCKET FOLLOWS THE IDENTITY, AT THE ONE MOMENT THE IDENTITY CHANGES. The login opens its
    // socket beside the state load that rotates here, so a socket opened (or opening) under the old
    // id is reopened under the new one - queued BEFORE the retirement below, which waits for it.
    this.reopenGatewaySocketAfterRotation(oldDeviceId);
    // The counters describe the ratchets of the device being abandoned, whose state was discarded
    // for a fresh one starting at generation zero. Carried over, they would burn against sends
    // that, from the peers' side, this device has never made.
    resetSendRatchetLedger(this.userId);
    this.owedSendBurns.clear();
    this.unprovenSendRatchets.clear();
    // Deregister the abandoned device so other members stop generating Welcomes for a key package
    // our fresh state no longer holds (NoMatchingKeyPackage). RECORDED BEFORE IT IS ASKED, so a
    // failed delete is retried at the next published round rather than forgotten; never awaited, so
    // a rotation does not block on the network.
    recordAbandonedDevice(this.userId, oldDeviceId);
    // The refusals the abandoned id remembered were judged by pins its discarded state held.
    forgetRefusedDevicesOf({ userId: this.userId, deviceId: oldDeviceId });
    // Never while a socket of this document still carries the old id (`deleteAbandonedDevice`).
    this.retireAbandonedIds();
    return oldDeviceId;
  }

  /**
   * Whether this device's saved MLS state is PROVABLY absent - no file / no record, or an empty one.
   * `false` on anything the store could not answer: an error is not an absence.
   *
   * Gates {@link reenrolLostState}, the one rotation that starts from a MISSING state rather than an
   * unusable one, so it must never fire on a state that is merely unread (a locked keystore, a
   * failing disk, a PIN problem - those reach `_initImpl` with a state, or throw).
   */
  protected abstract savedStateProvenAbsent(): Promise<boolean>;

  /**
   * A DEVICE THAT KEPT ITS ID BUT LOST ITS STATE IS A NEW DEVICE (lead decision, 2026-10-22). Its old
   * signature key went with the state, so peers that pinned it refuse a re-add under the old name
   * (`docs/wiki/protocols/mls-protocol.md#device-binding`); a new id is a first sight for them, and
   * the owner's devices announce it as a new device. The old id is retired through the ordinary
   * device deletion, for that id only (`abandonedDevices.ts`).
   *
   * Taken only when ALL of these hold: an id pre-existed this boot (`stateWasExpected`), the caller
   * did not claim a state exists (`noFreshStart`), and the store PROVES there is none.
   *
   * @returns whether the identity was rotated (the fresh client is then loaded and persisted).
   */
  protected async reenrolLostState(
    deviceKeyB64: string,
    opts?: { noFreshStart?: boolean }
  ): Promise<boolean> {
    if (!this.stateWasExpected || opts?.noFreshStart) return false;
    let absent = false;
    try {
      absent = await this.savedStateProvenAbsent();
    } catch (e) {
      console.warn(`[MLS] could not prove the saved state absent - not rotating: ${String(e)}`);
      return false;
    }
    if (!absent) {
      console.warn(
        `[MLS] ${sanitizeForLog(this.deviceId)} expected a saved state, none was passed, and the store did not prove it absent - not rotating`
      );
      return false;
    }
    await this.rotateDeviceIdentity(
      deviceKeyB64,
      'saved state lost - the device re-enrols as a new device'
    );
    return true;
  }

  /**
   * Ends this document after a rotation whose checkpoint another document refused
   * ({@link rotateDeviceIdentity}): a reload is the one thing that provably replaces the live client
   * with the state as the disk now holds it - the same answer the tab-leader promotion gives
   * (`useChatSession`). Only web refuses a checkpoint, so only web reaches it. The write latch
   * ({@link stateWritesEnded}) is already set, so nothing this page does before it unloads is
   * written.
   *
   * BOUNDED, BY A COUNT AND NO CLOCK. The page it starts logs in again, and every login path asks the
   * server whether the stored id is revoked and wipes it if so, so a reload normally ends the story.
   * That question answers `false` when the server is unreachable, though, and a page that then
   * reaches the server and meets another document still writing would rotate, be refused and reload
   * again, for as long as the other one writes. So at most {@link MAX_REFUSED_ROTATION_RELOADS}
   * reloads per tab (`sessionStorage`, which a reload keeps) with no key package round PUBLISHED in
   * between: a round that publishes resets the count, and every healthy page publishes one per
   * connection. Not a successful init: in the loop above every init succeeds - it is the round after
   * it that meets the revocation - so an init reset would never let the count reach the bound. Past
   * it the page is NOT reloaded: it stays latched - it writes nothing - says so at `error`, and tells
   * the member in a toast it cannot close: close the other tabs, then reload. The session's end
   * clears the count too (`tearDownLiveSession`), so the next account in this tab starts at zero.
   */
  protected endDocumentAfterRefusedRotation(): void {
    if (typeof window === 'undefined') return;
    const key = REFUSED_ROTATION_RELOADS_KEY;
    let done: number;
    try {
      done = Number(sessionStorage.getItem(key) ?? '0') || 0;
      if (done < MAX_REFUSED_ROTATION_RELOADS) {
        sessionStorage.setItem(key, String(done + 1));
      }
    } catch (e) {
      // Uncounted, a reload could be the loop this bound exists to stop: the page stays latched.
      console.error(
        `[MLS] refused rotation: the reload count is unreadable, so this page is NOT reloaded and writes no state - close the other tabs of this account:`,
        e
      );
      this.tellMemberThisPageEnded();
      return;
    }
    if (done >= MAX_REFUSED_ROTATION_RELOADS) {
      console.error(
        `[MLS] refused rotation: ${done} reloads in a row met another document writing this account's state, so this page is NOT reloaded again and writes no state - close the other tabs of this account`
      );
      this.tellMemberThisPageEnded();
      return;
    }
    console.warn(
      `[MLS] refused rotation: reloading (${done + 1}/${MAX_REFUSED_ROTATION_RELOADS}) to start again from the state on disk`
    );
    this.reloadDocument();
  }

  /** The reload itself, apart so a test can observe it without unloading its runner. */
  protected reloadDocument(): void {
    window.location.reload();
  }

  /**
   * The member's half of a page that stopped reloading ({@link endDocumentAfterRefusedRotation}):
   * the console is not where anybody reads that the page now saves nothing. A toast with the remedy
   * and a reload button, and NO close button: closed, it would leave a page that saves nothing and
   * looks alive. The reload is the member's to take, once the other tabs are closed.
   */
  protected tellMemberThisPageEnded(): void {
    showPinnedToast(m.mls_page_ended_other_tab_writing(), 'error', {
      label: m.common_reload_button(),
      run: () => this.reloadDocument(),
    });
  }

  /**
   * Platform hook: restore a previously-used device id from native storage when
   * localStorage was cleared (Tauri reads push_context.json to avoid a credential
   * mismatch after a WebView eviction / reinstall). Web has no native store → null.
   */
  protected async restoreDeviceIdFromNative(_userId: string): Promise<string | null> {
    return null;
  }

  /**
   * Platform hook: mirror this device's id somewhere a `localStorage` eviction cannot reach, so
   * {@link restoreDeviceIdFromNative} has something to read back. Web has nowhere more durable
   * than the store being lost, so it is a no-op there.
   *
   * IT TAKES NO DEVICE KEY AND MAKES NO REQUEST, and that is the whole point. The mirror used to
   * be a side effect of `store_push_context`, which needs a derived device key, a platform-keystore
   * write that succeeds, and - at its JS call site - an auth-token refresh that has come back from
   * the network. None of those three is a fact about identity, and each one failing quietly minted
   * a new device instead: on production (2026-09-12) 138 of 361 accounts carried one device NAME
   * under several ids, 40% of iOS accounts and 38% of Android against 12% Windows and 9% macOS.
   */
  protected async persistDeviceIdNatively(_userId: string, _deviceId: string): Promise<void> {}

  /** Generates a fresh, unique per-user device id prefixed with the platform tag. */
  protected generateDeviceId(userId: string): string {
    return `${this.platform}-${userId}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  }

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
    return this.delivery.fetchUserDevices(userId);
  }

  /**
   * Deletes every published one-time prekey, then regenerates the key material (static
   * fallback + pool) from the current local keystore via {@link generateKeyPackage}. Guarantees
   * that no published KeyPackage references a private key missing locally - the root of the
   * `NoMatchingKeyPackage` loop.
   *
   * Debounces close-together calls (<= 30 s): several groups can fail at the same time, but a
   * single purge/regeneration (expensive, up to 50 KeyPackages) is enough to reconcile all
   * published material.
   */
  async republishKeyMaterial(deviceKeyB64: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastKeyMaterialRepublish < 30_000) return;
    this.lastKeyMaterialRepublish = now;
    const purged = await this.delivery.deleteAllOneTimePrekeys();
    await this.forgetPurgedPrekeys(purged);
    await this.generateKeyPackage(deviceKeyB64);
  }

  /**
   * Validates every published one-time prekey and purges from the server those whose local
   * private key is gone (state reset/restored). Conservative: only purges *proven* orphans
   * (KeyPackage validated but absent from the keystore); a KeyPackage that cannot be validated
   * is left in place (a peer might be able to validate it). Best-effort.
   */
  async reconcilePublishedKeyPackages(): Promise<void> {
    const published = await this.delivery.listOwnPrekeys();
    if (published.length === 0) return;

    const orphanIds: string[] = [];
    let disownedOwnMints = 0;
    for (const { id, keyPackage } of published) {
      try {
        if (await this.keyPackageHasPrivate(keyPackage)) continue;

        // A PACKAGE THIS SESSION PUBLISHED IS NEVER AN ORPHAN, AND SAYING SO IS THE WHOLE GUARD.
        //
        // Measured on the Mi 9T on 2026-09-06: `needed=49` on every connection, and immediately
        // after each top-up `purged 49/50 orphaned prekey(s)` - the device throwing away the very
        // packages it had just minted, so the pool never filled and it minted fifty more next
        // time. ~97 kB of bundles a round into a state nothing prunes below 84 days; `mls.bin`
        // grew 1.26 MB in a day and a checkpoint went from 17 s to 48 s.
        //
        // A SHARE-BASED FLOOR WOULD BE WRONG HERE. A device restored from an older backup has
        // genuinely lost every private key, and purging 50 of 50 is exactly what this function is
        // for - so "too many" cannot be the test. What separates the loop from the legitimate case
        // is not the proportion but the PROVENANCE: this process minted these bytes, so it holds
        // the private key by construction, and a `false` about one of them is never evidence about
        // the server. It is evidence that the seam between minting and asking is broken.
        //
        // So it is refused and ACCUSED rather than executed. The cause is still open
        // (`docs/wiki/backlog.md`); what this closes is the silence - a reconciliation undoing its
        // own top-up looked exactly like a reconciliation doing its job.
        if (this.publishedThisSession.has(fingerprintKeyPackage(keyPackage))) {
          disownedOwnMints++;
          continue;
        }
        orphanIds.push(id);
      } catch {
        // KeyPackage not locally deserializable/validatable: don't purge it.
      }
    }

    if (disownedOwnMints > 0) {
      console.error(
        `[MLS] reconcilePublishedKeyPackages: REFUSED to purge ${disownedOwnMints}/${published.length} prekey(s) ` +
          'this session published itself - the device cannot back a package it just minted, which is a broken ' +
          'seam between minting and asking, NOT a server orphan. Purging them is the loop that empties the pool ' +
          'and mints fifty more on every connection (see backlog: the prekey purge loop).'
      );
    }

    if (orphanIds.length > 0) {
      await this.delivery.pruneOwnPrekeys(orphanIds);
      console.log(
        `[MLS] reconcilePublishedKeyPackages: purged ${orphanIds.length}/${published.length} orphaned prekey(s)`
      );
    }
  }

  /** True if the local keystore still holds the private key for the given public KeyPackage. */
  protected abstract keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean>;

  /**
   * Drops the local private bundles for key packages the SERVER HAS CONFIRMED IT DELETED.
   *
   * Never called with a set this client worked out for itself - see
   * {@link forgetPurgedPrekeys} for why that distinction is the whole safety argument.
   */
  protected abstract forgetKeyPackages(publicKeyPackages: Uint8Array[]): Promise<number>;

  /**
   * COMPLETES A PURGE, which emptied the server and left the device holding the whole pool.
   *
   * Publishing a prekey writes a private bundle locally, and nothing ever deleted one: for the
   * life of an install, every purge/remint round orphaned fifty bundles of ~2 364 bytes until
   * their 84-day lifetimes elapsed. Measured on a Mi 9T on 2026-09-09 - 2782 one-time bundles
   * against a pool of fifty, two thirds of a 10.7 MB state, none of it yet expired.
   *
   * THE LIST MUST COME FROM THE SERVER AND MAY NEVER BE DERIVED HERE. A row the purge deleted was
   * still in the pool, and being in the pool is the same as never having been handed out - the
   * hand-out is what removes it. A row absent for any other reason may be absent precisely
   * because a peer is about to send the Welcome built on it, and forgetting that bundle loses the
   * join. So this takes what `deleteAllOneTimePrekeys` reported and nothing else.
   *
   * Best-effort by design: it runs behind a purge that already succeeded, and a device that could
   * not shed a stale bundle still works. The failure is logged rather than swallowed, because an
   * unreclaimed pool is the leak coming back and nothing else would say so.
   */
  protected async forgetPurgedPrekeys(purged: string[]): Promise<void> {
    if (purged.length === 0) return;
    try {
      const bytes = purged.map((b64) => fromBase64(b64));
      const forgotten = await this.forgetKeyPackages(bytes);
      console.log(`[MLS] purge reclaimed ${forgotten}/${purged.length} local prekey bundle(s)`);
    } catch (e) {
      console.warn(
        '[MLS] could not forget purged prekey bundles; the local pool stays until it expires:',
        String(e).slice(0, 200)
      );
    }
  }

  async fetchDeviceKeyPackage(userId: string, deviceId: string): Promise<DeviceKeyPackageAnswer> {
    return this.delivery.fetchDeviceKeyPackage(userId, deviceId);
  }

  /** Delegates to the delivery API; see {@link IMlsService.fetchDeviceSignatureKeys}. */
  async fetchDeviceSignatureKeys(userId: string, deviceId: string): Promise<DeviceSignatureKeys> {
    return this.delivery.fetchDeviceSignatureKeys(userId, deviceId);
  }

  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  async publishKeyPackages(packages: DatedKeyPackage[]): Promise<void> {
    for (const kp of packages) this.publishedThisSession.add(fingerprintKeyPackage(kp.bytes));
    return this.delivery.publishKeyPackages(packages);
  }

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
    return this.delivery.updateDeviceMetadata(userId, deviceId, metadata);
  }

  /**
   * Takes the group's add lock.
   *
   * FIRST, A RELEASE THIS DEVICE STILL OWES IS SENT (`addLockMarkers.ts`): every acquisition is
   * marked durably until a release of it is ANSWERED, and the server's lock refuses even its own
   * holder (`SET NX`) - so a release lost with the connection, or never sent by a page that died
   * mid-Add, would refuse this device's next Add for the whole TTL. The marker is CLAIMED
   * synchronously, so two acquires racing in this page never both send it, and none is sent for a
   * group this page holds; the release names the acquisition's TOKEN, so a late one frees that
   * acquisition or nothing - never a lock taken since (this page's, or the Android service's).
   *
   * A REFUSAL CARRIES THE SERVER'S OWN FACT ABOUT WHEN THE LOCK ENDS (`retryAfterMs`): a lost
   * invitation waiting on this group is re-planned at that moment ({@link wakeAtAddLockExpiry}) -
   * the holder's release sends no frame, so nothing else would say it.
   */
  async acquireAddLock(groupId: string): Promise<boolean> {
    return (await this.acquireAddLockAnswer(groupId)) === 'taken';
  }

  /**
   * {@link acquireAddLock} with WHY a refusal happened kept: `held` is the server's own answer that
   * another device holds the lock; `unanswered` is a transport error or a non-2xx answer, which says
   * nothing about anyone else.
   */
  async acquireAddLockAnswer(groupId: string): Promise<'taken' | 'held' | 'unanswered'> {
    const short = groupId.slice(0, 8);
    if (!this.addLocksHeld.has(groupId)) {
      const owed = claimAddLockMarker(this.userId, groupId);
      if (owed) {
        // Said as OWED: on the server line, this `released=false` is not an Add outliving its TTL.
        const released = await this.delivery.releaseAddLock(groupId, owed.token, { owed: true });
        console.log(
          `[ADD_LOCK] ${short}... a release this device owed (${owed.token ? 'token' : 'no token'}) was sent before acquiring: ${released ? 'answered' : 'still unanswered - kept'}`
        );
        if (!released) markAddLock(this.userId, groupId, owed.token);
      }
    }
    const answer = await this.delivery.acquireAddLock(groupId);
    if (answer.acquired) {
      this.addLocksHeld.set(groupId, answer.token);
      markAddLock(this.userId, groupId, answer.token);
      return 'taken';
    }
    this.wakeAtAddLockExpiry(groupId, answer.retryAfterMs);
    return answer.answered ? 'held' : 'unanswered';
  }

  /**
   * Releases the group's add lock - naming the acquisition's token - and, once this device holds
   * none, drains the lost invitations a held lock deferred ({@link replanOwedInvitations}): the
   * server's lock is not re-entrant, so a re-plan run under one would be refused its own. Forgotten
   * as HELD before the request; its marker leaves only when the release is ANSWERED, so an unanswered
   * one is sent again before the next acquire.
   */
  async releaseAddLock(groupId: string): Promise<void> {
    const token = this.addLocksHeld.get(groupId);
    this.addLocksHeld.delete(groupId);
    try {
      if (await this.delivery.releaseAddLock(groupId, token)) {
        clearAddLockMarker(this.userId, groupId, token);
      }
    } finally {
      if (
        this.addLocksHeld.size === 0 &&
        this.owedInvitationReplanner &&
        listOwedInvitations(this.userId).length > 0
      ) {
        this.replanOwedInvitations('add lock released');
      }
    }
  }

  /**
   * A refused acquire on a group where a lost invitation waits: re-plans it when the server SAID the
   * holder's lock ends - one wake per group, a fact and not a guess (an earlier release by the holder
   * is only a bound this does not need to observe). No stated end (a server that predates it, an
   * acquire nothing answered): no wake, the next commit or connection drains.
   */
  private wakeAtAddLockExpiry(groupId: string, stated: number | undefined): void {
    if (!this.owedInvitationReplanner || !owesInvitationIn(this.userId, groupId)) return;
    const short = groupId.slice(0, 8);
    const retryAfterMs = boundAddLockWait(stated);
    if (retryAfterMs !== stated) {
      console.warn(
        `[INVITE_OWED] ${short}... the add lock's stated end (${String(stated)} ms) is outside 0..${ADD_LOCK_WAIT_BOUND_MS} ms - read as ${String(retryAfterMs)}`
      );
    }
    if (retryAfterMs === undefined) {
      console.log(
        `[INVITE_OWED] ${short}... the add lock was refused with no stated end - the next commit in the group or the next connection re-plans`
      );
      return;
    }
    clearTimeout(this.addLockExpiryWakes.get(groupId));
    console.log(
      `[INVITE_OWED] ${short}... the add lock was refused - re-planned when the server says it ends, in ${retryAfterMs} ms`
    );
    this.addLockExpiryWakes.set(
      groupId,
      setTimeout(() => {
        this.addLockExpiryWakes.delete(groupId);
        this.replanOwedInvitationsIn(groupId, 'add lock ended (server-stated)');
      }, retryAfterMs)
    );
  }

  /** Cancels every pending {@link wakeAtAddLockExpiry} wake (a sign-out, or this client's destroy). */
  private cancelAddLockExpiryWakes(): void {
    for (const wake of this.addLockExpiryWakes.values()) clearTimeout(wake);
    this.addLockExpiryWakes.clear();
  }

  async createRemoteGroup(name: string, isGroup = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number,
    until?: string
  ): Promise<import('$lib/mls-client/historyTypes').HistoryPage> {
    return this.delivery.fetchHistory(groupId, afterStreamId, limit, until);
  }

  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryPage>> {
    return this.delivery.fetchHistoryBatch(groups);
  }

  async fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
  }> {
    return this.delivery.fetchCommitsSince(groupId, sinceEpoch);
  }

  async forceLeaveGroup(groupId: string): Promise<void> {
    try {
      await this.delivery.deliveryPost(`groups/${groupId}/force_leave`, {
        deviceId: this.deviceId,
      });
    } catch (e) {
      console.warn('[MLS] forceLeaveGroup error (non-fatal):', e);
    }
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    return this.delivery.renameGroup(groupId, name);
  }

  async setGroupImage(groupId: string, mediaId: string | null): Promise<void> {
    return this.delivery.setGroupImage(groupId, mediaId);
  }

  async deleteGroupOnServer(groupId: string): Promise<void> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  async declineJoinRequest(groupId: string, userId: string): Promise<JoinDeclineOutcome> {
    return this.delivery.declineJoinRequest(groupId, userId);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  async getGroupUserMembers(
    groupId: string,
    opts?: { fresh?: boolean }
  ): Promise<GroupUserMemberRow[]> {
    return this.delivery.getGroupUserMembers(groupId, opts);
  }

  async getGroupRosterAtGeneration(groupId: string): Promise<GroupRosterAtGeneration> {
    return this.delivery.getGroupRosterAtGeneration(groupId);
  }

  async getGroupWithheld(groupId: string, forUserId?: string): Promise<GroupExclusions> {
    return this.delivery.getGroupWithheld(groupId, forUserId);
  }

  async getGroupExclusions(groupId: string, forUserId?: string): Promise<GroupExclusions> {
    return this.delivery.getGroupExclusions(groupId, forUserId);
  }

  async getAddressedAnswersSupported(groupId: string, forUserId?: string): Promise<boolean> {
    return this.delivery.getAddressedAnswersSupported(groupId, forUserId);
  }

  async getGroupRosters(groupIds: string[]): Promise<GroupRosterBatch> {
    return this.delivery.fetchGroupRosters(groupIds);
  }

  async getRevokedLeaves(groupId: string, identities: string[]): Promise<string[]> {
    return this.delivery.fetchRevokedLeaves(groupId, identities);
  }

  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  async getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta> {
    return this.delivery.getGroupServerStatus(groupId);
  }

  async getDismissedGroups(): Promise<string[]> {
    return this.delivery.getDismissedGroups();
  }

  async dismissGroup(groupId: string): Promise<void> {
    return this.delivery.dismissGroup(groupId);
  }

  async undismissGroup(groupId: string): Promise<void> {
    return this.delivery.undismissGroup(groupId);
  }

  async getPendingInvitations(userId: string, deviceId: string): Promise<PendingInvitationRow[]> {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  async getDeviceMemberships(userId: string, deviceId: string): Promise<DeviceMembershipRow[]> {
    return this.delivery.getDeviceMemberships(userId, deviceId);
  }

  /**
   * Marks a device's membership `pending` or `active` on the server.
   *
   * GUARDED, because this is the only client call that can CREATE an `active` membership row from
   * nothing, and it was reached twice with an identity that did not exist yet - see
   * {@link assertResolvedIdentity} for what that cost. The throw is the report: every call site is
   * fire-and-forget and re-driven, so refusing here delays a promotion by one cycle and prevents a
   * placeholder from being written into a roster for good.
   */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void> {
    assertResolvedIdentity('updateInvitationStatus', userId, deviceId);
    return this.delivery.updateInvitationStatus(deviceId, userId, groupId, status);
  }

  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    return this.delivery.kickStaleDevice(deviceId, userId, groupId);
  }

  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteDeviceMembership(userId, deviceId, groupId);
  }

  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteAllDeviceMemberships(userId, deviceId);
  }

  async deleteDevice(
    userId: string,
    deviceId: string,
    reason?: 'retired'
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }> {
    return this.delivery.deleteDevice(userId, deviceId, reason);
  }

  // ── Shared MLS decrypt session (overridden on Web for the worker path) ─────

  /** Sequential, in-place session used by Tauri and when the crypto worker is disabled. */
  async createDecryptSession(groupId: string): Promise<MlsDecryptSession> {
    // The sequential path decrypts in place, so it cannot be UNDONE by a swap the way the worker
    // path can - but a send during it is still a send racing a catch-up, and the ordering rule is
    // about the sequence, not about which platform happens to survive breaking it.
    this.beginCatchUp(groupId);
    let session: MlsDecryptSession;
    try {
      session = await createSequentialDecryptSession(this, groupId);
    } catch (e) {
      this.endCatchUp(groupId);
      throw e;
    }
    return {
      decryptPage: (msgs) => session.decryptPage(msgs),
      finish: async () => {
        try {
          await session.finish();
        } finally {
          this.endCatchUp(groupId);
        }
      },
    };
  }

  /**
   * Default no-op: only Tauri/Android has a background JNI engine that can advance `mls.bin`
   * while the app is backgrounded, so only TauriMlsService overrides this to reload (C2). On
   * web/desktop the in-memory engine is the sole writer; there is nothing to reload.
   */
  async reloadStateFromDisk(): Promise<void> {}

  /**
   * Default null: every path but the Tauri biometric one derives the device key in the frontend
   * and hands it to {@link init}, so there is nothing to ask back for.
   */
  async resolveSessionDeviceKey(): Promise<string | null> {
    return null;
  }

  // ── Platform-specific (abstract) ──────────────────────────────────────────

  /**
   * Writes the current state to this platform's durable store, and it is THE ONLY persistence this
   * class knows about. Tauri's write already lands on disk (`TauriMlsService.persistState`, which
   * returns a byte count) while Web still has to hand the bytes to IndexedDB
   * (`WebMlsService.saveState`, which returns them) - and no caller - {@link rotateDeviceIdentity},
   * the checkpoint persister, the structural checkpoint - may have to know which.
   *
   * THOSE TWO METHODS ARE DELIBERATELY NOT A SHARED ABSTRACT ANY MORE. One shared signature meant
   * one shared return type, web's `Uint8Array`, which native satisfied by marshalling a 7.8 MB
   * snapshot across the IPC bridge as a JSON array of one number per byte for four call sites that
   * all threw it away. A contract that forces a platform to produce something no caller of that
   * platform wants is not an abstraction, and this seam - a write, returning nothing - is.
   *
   * `latch` is this document's write latch ({@link stateWritesEnded}); a platform whose store can
   * refuse a write reads it AT THE PUT, and rejects `MlsStateWriteRefusedError('ended')` on it.
   */
  protected abstract writeCheckpoint(
    deviceKeyB64: string,
    latch: MlsStateWriteLatch
  ): Promise<void>;

  /**
   * Advances this device's send ratchet by `count` generations without emitting anything.
   *
   * Platform-specific and nothing else: WHEN to burn, and by how much, is decided once in
   * {@link reconcileSendRatchets}. See `MlsManager::skip_send_generations` for why it encrypts and
   * why burning too many is free while burning too few is the defect.
   */
  protected abstract skipSendGenerations(groupId: string, count: number): Promise<number>;

  /**
   * Checkpoints the live state AND records how much of this device's send ratchet it makes durable.
   *
   * CONCRETE, FOR THE REASON {@link sendMessage} IS. The count is read BEFORE the write is started
   * and committed only AFTER it resolves, and that order is the entire guarantee: a send landing
   * during the write is then counted as unpersisted and costs one burnt generation too many on the
   * next load, where the opposite order costs one too few and reproduces exactly the fault this
   * exists to close. Leaving the pairing to each call site would be the eighteen-call-sites lesson
   * of `sendMessage`, re-learnt on the seam that guards the ratchet instead of the one that moves it.
   *
   * THE LATCH IS READ TWICE ({@link stateWritesEnded}): here, so an ended document captures
   * nothing, and at the put, where it decides. `endsDocumentOnRefusal` is the rotation's: its write
   * sets the latch in the very transaction that refuses it.
   */
  async persistCheckpoint(options?: { endsDocumentOnRefusal?: boolean }): Promise<void> {
    if (this.stateWritesEnded === true) throw new MlsStateWriteRefusedError('ended');
    const emitted = snapshotEmitted(this.userId);
    // A RATCHET WHOSE REPAIR THIS STATE DOES NOT HOLD IS NOT DECLARED DURABLE. A burn still owed
    // (or still running) when the count is read is not in the state this checkpoint exports, so
    // committing `persisted = emitted` for that ratchet would erase the only record of the debt: the
    // settle merges into the epoch, a checkpoint lands, a reload finds nothing owed and re-issues
    // generation 0. Left out at SNAPSHOT time; a burn that lands during the write is only over-counted
    // on the next load, which is free.
    for (const key of this.sendRatchetsNotDurable()) delete emitted[key];
    // The replay marks are captured BEFORE the write for the same reason as `emitted`: a page
    // decrypted while the seal runs is marked in memory, and this write does not hold its advance.
    const replayMarks = snapshotPendingHistoryMarks(this.userId);
    await this.writeCheckpoint(this.currentDeviceKeyB64, {
      isEnded: () => this.stateWritesEnded === true,
      endOnRefusal: options?.endsDocumentOnRefusal
        ? () => {
            this.stateWritesEnded = true;
          }
        : undefined,
    });
    commitPersisted(this.userId, emitted);
    // TWO LEDGERS, ONE WRITE, AND THE SECOND ONE WAS BOUND TO THE WRONG EVENT UNTIL 2026-09-08.
    //
    // The send ledger above declares what this checkpoint made durable. The history replay's marks
    // owed exactly the same declaration and did not get it: they became durable only in the thunk at
    // the END of the archive walk, so a checkpoint landing mid-walk - and one lands on any structural
    // mutation, because `flushEncryptedInternal` is not gated by the bulk-ingest depth - made the
    // ratchet durable while the marks were still in memory. A page killed there re-accuses frames it
    // had really read. Proved by insertion order on TAB-3b: six accused row keys all sat at the END
    // of a 3 511-entry set, so two whole runs had written nothing durable at all.
    //
    // AFTER the write, never before, for the reason spelt out on `commitPendingHistoryMarks`: the two
    // orderings are not symmetric, and only "ratchet ahead of ledger" is survivable.
    commitPendingHistoryMarks(replayMarks);
  }

  /**
   * Re-seals this device's state under a new key, and MOVES the key every later checkpoint uses.
   *
   * Concrete here for the same reason {@link generateKeyPackage} is: the platforms differ only in
   * how they re-encrypt, and the bookkeeping either happens for both or is forgotten by one. The
   * field moves only AFTER the impl resolves - a re-seal that threw leaves the durable blob under
   * the old key, so the old key is what still describes it.
   */
  async changeDeviceKey(newDeviceKeyB64: string): Promise<void> {
    if (this.stateWritesEnded === true) throw new MlsStateWriteRefusedError('ended');
    await this.changeDeviceKeyImpl(newDeviceKeyB64, {
      isEnded: () => this.stateWritesEnded === true,
    });
    this.currentDeviceKeyB64 = newDeviceKeyB64;
  }

  /**
   * Generations owed to an epoch the restored state has not reached yet, per group then epoch:
   * frames this device sent after a merge its last checkpoint does not hold. Filled by
   * {@link reconcileSendRatchets}, spent by {@link burnOwedOnArrival} before the first frame sealed
   * at that epoch, and removed only once its burn has run.
   *
   * In memory, and the LEDGER keeps the debt durable: a reload before the burn reads it again only
   * because no checkpoint declared that ratchet durable meanwhile - {@link persistCheckpoint} leaves
   * every ratchet named here out of what it commits ({@link sendRatchetsNotDurable}).
   */
  private owedSendBurns = new Map<string, Map<number, number>>();

  /**
   * Ledger keys whose epoch the load could not read, so their burn ran blind (in whatever epoch the
   * state held) and may not have been the repair. Never declared durable this session, so the next
   * load - which can read the epoch - judges them again; over-burning there is free.
   */
  private unprovenSendRatchets = new Set<string>();

  /** The owed burn running for a group, which every send to that group awaits. */
  private owedBurnInFlight = new Map<string, Promise<void>>();

  /** The ledger keys a checkpoint must not declare durable: see {@link persistCheckpoint}. */
  private sendRatchetsNotDurable(): string[] {
    const keys = [...this.unprovenSendRatchets];
    for (const [groupId, owed] of this.owedSendBurns) {
      for (const epoch of owed.keys()) keys.push(sendRatchetKey(groupId, epoch));
    }
    return keys;
  }

  /**
   * Burns whatever this device sent but never checkpointed, so the restored ratchet is back where
   * the peers already believe it is. Runs once per {@link init}, before anything can send.
   *
   * A fresh start has no history to repair and any surviving count describes a device that no longer
   * exists, so the ledger is dropped rather than replayed.
   *
   * EACH COUNT IS BURNT IN THE EPOCH IT WAS COUNTED IN ({@link sendRatchetDebt}). The restored state
   * can sit BEHIND an epoch this device already sent in - its own commit merged after the checkpoint
   * that holds the stage, or a received one never checkpointed - and that epoch restarts at
   * generation 0 when the group gets there again. Burnt here, those frames moved the restored epoch's
   * ratchet, which nobody reads any more, and the merge then re-issued every generation the peers had
   * consumed (`SecretReuseError`). So a count AHEAD of the state is kept for that epoch, and burnt when
   * the first frame is about to be sealed there.
   *
   * Per group, and isolated per group: the ledger can name a conversation this device has since left
   * or forgotten, and the platform answers `GroupNotFound` for it. One unrepairable group must not
   * cost the repair of the others.
   */
  protected async reconcileSendRatchets(): Promise<void> {
    this.owedSendBurns.clear();
    this.unprovenSendRatchets.clear();
    if (this.freshStart) {
      resetSendRatchetLedger(this.userId);
      return;
    }
    const entries = sendRatchetEntries(this.userId);
    if (entries.length === 0) return;

    const restored = new Map<string, number | 'not-held' | 'unknown'>();
    const forget: string[] = [];
    let repaired = 0;
    for (const entry of entries) {
      const { groupId } = entry;
      const short = groupId.slice(0, 8);
      if (!restored.has(groupId)) restored.set(groupId, await this.restoredEpochOf(groupId));
      const restoredEpoch = restored.get(groupId);
      if (restoredEpoch === 'not-held') {
        forget.push(entry.key);
        continue;
      }
      // NO EPOCH TO JUDGE BY IS NO REASON TO SKIP THE REPAIR: the debt is burnt where the state is,
      // as the per-group ledger always did. Right when the frames were sent in the epoch the state
      // holds (the common case: a send not yet checkpointed); a burn moving an epoch nobody reads
      // when they were not, which is free. What it cannot prove is that it repaired, so the key is
      // never declared durable this session (`unprovenSendRatchets`) and the next load judges it.
      const debt =
        restoredEpoch === 'unknown' || restoredEpoch === undefined
          ? sendRatchetDebt({ ...entry, epoch: null }, 0)
          : sendRatchetDebt(entry, restoredEpoch);
      if (restoredEpoch === 'unknown' || restoredEpoch === undefined) {
        this.unprovenSendRatchets.add(entry.key);
      }
      if (debt.kind === 'spent' || debt.kind === 'settled') {
        // A settled entry with an epoch keeps counting; a spent one, or a settled pre-epoch one,
        // will never be read again.
        if (debt.kind === 'spent' || (entry.epoch === null && restoredEpoch !== 'unknown')) {
          forget.push(entry.key);
        }
        continue;
      }
      if (debt.clamped) {
        // NAMED, NEVER SILENT: a deficit past the receivers' forward window is a corrupt counter,
        // not a backlog, and burning the cap will not repair it. Saying so is what separates
        // "repaired" from "gave up at the bound" in the log a later reader will have.
        console.warn(
          `[MLS] Send ledger for ${short}... claims more than ${MAX_BURN_GENERATIONS} unpersisted frames - burning the cap only; the ratchet cannot be repaired past the receivers' forward window`
        );
      }
      if (debt.kind === 'on-arrival') {
        const epoch = entry.epoch as number;
        const owed = this.owedSendBurns.get(groupId) ?? new Map<number, number>();
        owed.set(epoch, debt.count);
        this.owedSendBurns.set(groupId, owed);
        console.log(
          `[MLS] Restored state for ${short}... is at epoch ${restoredEpoch}, behind ${debt.count} frame(s) this device sent at epoch ${epoch} - owed there, burnt before the first frame sealed at it`
        );
        continue;
      }
      try {
        await this.skipSendGenerations(groupId, debt.count);
        repaired++;
        console.log(
          `[MLS] Restored state for ${short}... was ${debt.count} generation(s) behind this device's own sends at epoch ${restoredEpoch} - burnt, no frame will re-use a spent generation`
        );
      } catch (e) {
        console.warn(
          `[MLS] Could not burn ${debt.count} generation(s) for ${short}...:`,
          String(e).slice(0, 160)
        );
      }
    }
    forgetSendRatchetEntries(this.userId, forget);
    const blind = [...restored.values()].filter((r) => r === 'unknown').length;
    if (blind > 0) {
      console.warn(
        `[MLS] Send ledger: the restored epoch of ${blind} group(s) could not be read - their debt was burnt in whatever epoch the state holds, and stays open for the next load`
      );
    }

    // The burn moved the live ratchet and nothing durable knows it yet, so a second reload would
    // burn the same generations again. Harmless (over-shooting is free) but pointless, and the
    // checkpoint is what closes the ledger: it commits `persisted = emitted` through the pairing
    // above. A failure leaves the deficit standing, which repairs itself on the next load.
    if (repaired > 0) {
      await this.persistCheckpoint().catch((e) =>
        console.warn('[MLS] Checkpoint after the ratchet burn failed:', String(e).slice(0, 160))
      );
    }
  }

  /**
   * The epoch the restored state holds `groupId` at; `'not-held'` for a group the state does not
   * hold (left or forgotten - a later join builds a new ratchet, so its counts describe nothing);
   * `'unknown'` when that cannot be told, which burns blind and forgets nothing (see
   * {@link reconcileSendRatchets}).
   */
  private async restoredEpochOf(groupId: string): Promise<number | 'not-held' | 'unknown'> {
    // Asked FIRST, and only of a listing known to describe the state: both platforms answer epoch
    // 0 for a group they do not hold, which would read as a real epoch.
    if (!this.heldGroupsKnown()) return 'unknown';
    if (!this.getLocalGroups().includes(groupId)) return 'not-held';
    try {
      return await this.freshEpoch(groupId);
    } catch (e) {
      console.warn(
        `[MLS] Send ledger names ${groupId.slice(0, 8)}..., whose epoch cannot be read - its debt is burnt blind:`,
        String(e).slice(0, 160)
      );
      return 'unknown';
    }
  }

  /**
   * Spends what {@link reconcileSendRatchets} left owed to `groupId` at `epoch`, which the group has
   * now reached, and drops what it owed to epochs it went past without sending (their ratchets can
   * no longer be used).
   *
   * The entry is removed only AFTER its burn has run: until then it is what keeps every checkpoint
   * from declaring that ratchet durable. A burn that fails leaves it owed and THROWS
   * ({@link OwedSendBurnFailedError}) - a frame sealed past it would re-use a generation the peers
   * consumed, so the send is refused and the next one tries again.
   *
   * Never called directly: {@link settleOwedBurns} runs it one at a time per group.
   */
  private async burnOwedOnArrival(groupId: string, epoch: number): Promise<void> {
    const owed = this.owedSendBurns.get(groupId);
    if (!owed) return;
    const short = groupId.slice(0, 8);
    for (const passed of [...owed.keys()].filter((e) => e < epoch)) {
      owed.delete(passed);
      console.log(
        `[MLS] ${short}... went past epoch ${passed} without sealing a frame there - its owed burn is moot`
      );
    }
    const count = owed.get(epoch);
    if (count !== undefined) {
      try {
        await this.skipSendGenerations(groupId, count);
      } catch (e) {
        console.error(
          `[MLS] Could not burn ${count} owed generation(s) for ${short}... at epoch ${epoch} - the send is refused rather than sealed over a consumed generation:`,
          String(e).slice(0, 160)
        );
        throw new OwedSendBurnFailedError(groupId, epoch, e);
      }
      owed.delete(epoch);
      console.log(
        `[MLS] ${short}... reached epoch ${epoch}, where this device had sent ${count} frame(s) its restored state did not hold - burnt before sealing there`
      );
      // The burn is in the live state only; the next checkpoint holds it, and from then on the
      // ratchet may be declared durable.
      scheduleOutboundMlsPersist();
    }
    if (owed.size === 0) this.owedSendBurns.delete(groupId);
  }

  /**
   * Runs `groupId`'s owed burn at `epoch` (the group's current one when omitted), AFTER any burn
   * already running for it. ONE AT A TIME PER GROUP, and every send awaits it: two sends that both
   * found a burn owed used to race - the first removed the entry and awaited the platform, the
   * second saw nothing owed and sealed, and only the order of two platform calls stood between that
   * frame and a consumed generation.
   */
  private settleOwedBurns(groupId: string, epoch?: number): Promise<void> {
    const before = this.owedBurnInFlight.get(groupId) ?? Promise.resolve();
    const run = before
      // The previous burn's failure belongs to the send that ran it; this one re-reads what is owed.
      .catch(() => {})
      .then(async () => {
        if (!this.owedSendBurns.has(groupId)) return;
        await this.burnOwedOnArrival(groupId, epoch ?? (await this.freshEpoch(groupId)));
      });
    this.owedBurnInFlight.set(groupId, run);
    void run
      .finally(() => {
        if (this.owedBurnInFlight.get(groupId) === run) this.owedBurnInFlight.delete(groupId);
      })
      // Awaited by the caller, which receives the failure; this tail only ends the bookkeeping.
      .catch(() => {});
    return run;
  }

  /**
   * Seals `messageBytes` at a generation no peer has consumed: what is owed to the group's epoch is
   * burnt first, and the frame's OWN epoch is read back - the fact the ledger counts it against.
   *
   * An incoming commit is not held off by the send barrier (only this device's own are), so one can
   * move the group between the epoch read and the encrypt. A frame sealed at an epoch that still owes
   * a burn is therefore never posted: the overlap is said, the burn is spent, and the frame is sealed
   * again. It terminates - each pass that does not return removes one owed epoch, or throws.
   */
  private async sealPastOwedBurns(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<AuthoredFrame & { epoch: number }> {
    for (;;) {
      if (this.owedSendBurns.has(groupId) || this.owedBurnInFlight.has(groupId)) {
        await this.settleOwedBurns(groupId);
      }
      const frame = await this.encryptForSend(groupId, messageBytes);
      const epoch = sealedFrameEpoch(frame.sealed);
      if (!this.owedSendBurns.get(groupId)?.has(epoch)) return { ...frame, epoch };
      console.error(
        `[MLS] ${groupId.slice(0, 8)}... a frame was sealed at epoch ${epoch}, which still owed a burn - an incoming commit moved the group between the burn and the encrypt; the frame is dropped unsent and sealed again`
      );
      await this.settleOwedBurns(groupId, epoch);
    }
  }

  /** `latch`: as on {@link writeCheckpoint}, read at the put. */
  protected abstract changeDeviceKeyImpl(
    newDeviceKeyB64: string,
    latch: MlsStateWriteLatch
  ): Promise<void>;
  protected abstract generateKeyPackageImpl(deviceKeyB64: string): Promise<DatedKeyPackage>;
  abstract publishKeyPackage(keyPackage: DatedKeyPackage): Promise<void>;

  /**
   * Creates `groupId` in this device's MLS state, as its only member.
   *
   * CONCRETE, AND REFUSED ON A FOLLOWER TAB ({@link FollowerTabCommitError}), for the reason a
   * commit is ({@link runCommitTransaction}): a follower's state is a copy no disk and no other tab
   * follows, so a group created there exists only in that copy - the leader never holds it, and
   * every message and commit of it after that is the follower's alone. Here rather than at each
   * caller, so no caller can create one around it.
   */
  async createGroup(groupId: string): Promise<void> {
    if (getTabLeadership() === 'follower') {
      console.warn(
        `[MLS] createGroup ${groupId.slice(0, 8)}... refused on a follower tab - only the leader creates groups`
      );
      throw new FollowerTabCommitError(groupId);
    }
    await this.createGroupImpl(groupId);
  }

  /** The platform half of {@link createGroup}. */
  protected abstract createGroupImpl(groupId: string): Promise<void>;

  // ── One commit regime (C7-A unified: stage -> validate -> merge/clear) ──────
  //
  // Every structural commit (ADD and REMOVE) runs through runCommitTransaction: the stage step
  // produces the commit WITHOUT merging, the server validates the epoch, then we merge (accept) or
  // clear (reject). A rejected commit therefore never leaves the local epoch ahead, so the whole
  // class of "sender fork" desyncs disappears. The platform primitives below (stage / merge / clear
  // / export tree / fresh epoch) are the only pieces that differ between WASM and native.

  /** Stages an Add commit WITHOUT merging. Returns the commit, shared Welcome, the input
   *  positions actually added / dropped-as-invalid (already-member dedup is silent), and
   *  `groupInfo`: the external-join base for the epoch the commit CREATES (see
   *  {@link runCommitTransaction}). Each package travels with the `userId:deviceId` it was
   *  FETCHED FOR, and Rust skips one whose credential names another device or whose key is not
   *  the one pinned for it (`deviceTrust.ts`). Every stage below RECORDS its submission from
   *  `intent` and its own output in the same platform call (`commitSubmission.ts`). */
  protected abstract stageAddMembers(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; identity: string }>,
    intent: Uint8Array
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    groupInfo: Uint8Array;
    addedIndices: number[];
    skipped: SkippedKeyPackage[];
  }>;
  /** Stages ONE commit removing the device `identity`'s leaf and adding it back from `keyPackage`,
   *  WITHOUT merging (`replace_device_with_base`). Returns the commit, the Welcome for that device
   *  and the external-join base for the epoch the commit creates. */
  protected abstract stageReplaceDevice(
    groupId: string,
    identity: string,
    keyPackage: Uint8Array,
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; welcome: Uint8Array; groupInfo: Uint8Array }>;
  /** Stages a Remove commit (all devices of the given users) WITHOUT merging. Returns the commit
   *  and the external-join base for the epoch it creates. */
  protected abstract stageRemoveMembers(
    groupId: string,
    userIds: string[],
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>;
  /** Stages a Remove commit for specific devices ("userId:deviceId") WITHOUT merging. Returns the
   *  commit and the external-join base for the epoch it creates. */
  protected abstract stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[],
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>;
  /** Stages a refresh of this device's own leaf - an empty commit with a path and no proposal -
   *  WITHOUT merging. Returns the commit and the external-join base for the epoch it creates. */
  protected abstract stageSelfUpdate(
    groupId: string,
    intent: Uint8Array
  ): Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>;
  /** When this device's leaf in `groupId` was minted (Unix seconds), `null` once a commit replaced
   *  it. See `MlsManager::own_leaf_minted_at` and `leafRefresh.ts`. */
  protected abstract ownLeafMintedAt(groupId: string): Promise<number | null>;
  /** This device's leaf key in `groupId` as hex - what names the leaf for the refresh ledger -
   *  or `null` when the tree holds no leaf of ours. See `MlsManager::own_leaf_encryption_key`. */
  protected abstract ownLeafKey(groupId: string): Promise<string | null>;
  /** Whether this device's current context in `groupId` (epoch, tree hash, confirmed transcript
   *  hash) is the one the served base `groupInfo` describes. See
   *  `MlsManager::own_context_matches_base`. */
  protected abstract ownContextMatchesBase(
    groupId: string,
    groupInfo: Uint8Array
  ): Promise<boolean>;
  /** Merges the pending staged commit (server accepted): advances the local epoch. */
  protected abstract mergePendingCommit(groupId: string): Promise<void>;
  /** Clears the pending staged commit (server rejected): local epoch unchanged, no fork. */
  protected abstract clearPendingCommit(groupId: string): Promise<void>;
  /** Exports the group's ratchet tree from the CURRENT (post-merge) state for the Welcome. */
  protected abstract exportRatchetTree(groupId: string): Promise<Uint8Array>;
  /** Reads the authoritative current (pre-merge) epoch for server validation. */
  protected abstract freshEpoch(groupId: string): Promise<number>;
  /** Exports a self-contained GroupInfo (ratchet tree included) for the external-join base. */
  protected abstract exportGroupInfo(groupId: string): Promise<Uint8Array>;
  /** Builds an external commit from a served GroupInfo and stages it locally (group at epoch+1).
   *  Returns the resolved group id and the commit to submit for server epoch validation. */
  protected abstract joinByExternalCommit(
    groupInfoBytes: Uint8Array
  ): Promise<{ groupId: string; commit: Uint8Array }>;
  /** Whether an external commit on this GroupInfo would bring this device in as a FURTHER DEVICE
   *  OF A MEMBER: its tree holds a leaf of this user and none of this device's own. */
  protected abstract isFurtherDeviceIn(groupInfoBytes: Uint8Array): Promise<boolean>;

  /**
   * Runs one staged commit transaction under the MLS lock: stage (no merge) -> validate the epoch
   * server-side -> merge (accept) or clear (reject, throws). On accept it broadcasts the commit
   * (skipping `excludeDeviceIds`) and, when `exportTree` is set, exports the post-merge ratchet
   * tree for the caller to deliver in the Welcome. The network preamble that builds the stage
   * inputs stays OUTSIDE this method; only the stage->merge unit is locked.
   *
   * **THE BASE FOR THE EPOCH THIS COMMIT CREATES TRAVELS INSIDE THE SUBMISSION** (COMM-22), exactly
   * as an external join's does: `stageFn` returns the GroupInfo OpenMLS built while building the
   * commit, and the server stores it in the same transaction as the epoch advance. It describes
   * epoch N+1 while this device is still at N, so it is never published on its own - only the gate
   * accepting the commit makes it true. Nothing is left to mint after the merge, so there is no
   * follow-up to lose and no window between "the epoch moved" and "its base exists".
   *
   * **A SUBMISSION THAT GETS NO ANSWER IS RESUBMITTED, NEVER GUESSED** (`commitSubmission.ts`). The
   * same request goes again and the gate's verdict decides: accepted or answered as a duplicate ->
   * merge; refused -> clear and catch up; still no answer -> the staged commit is KEPT with the
   * record its stage wrote beside it, and {@link CommitOutcomeUnknownError} is thrown. Both are on
   * disk before the FIRST request leaves (a checkpoint awaited between the stage and the send), so a
   * crash at any point after the send reloads them. Until a resubmission
   * answers - at the next connection, the next send, the next commit in the group, or a replay that
   * finds the log decided at that epoch - the group takes no commit and no send.
   */
  protected async runCommitTransaction(
    groupId: string,
    stageFn: (intent: Uint8Array) => Promise<{
      commit: Uint8Array;
      welcome?: Uint8Array;
      groupInfo: Uint8Array;
      addedDeviceIds?: string[];
      skipped?: SkippedDevice[];
    }>,
    opts: {
      excludeDeviceIds?: string[];
      exportTree?: boolean;
      removes?: CommitRemoval[];
      /** For an Add of several devices: the device of each key package, by position. */
      keyPackageDevices?: string[];
      /** A member's invitation, carried by the intent (`CommitIntent.invitation`). */
      invitation?: CommitInvitation;
    } = {}
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skipped: SkippedDevice[];
    /** Admitted to the tree, NOT recorded by the gate, and owed no Welcome ({@link undeliverableAdmits}). */
    notAdmitted: RefusedAdmit[];
  }> {
    // A FOLLOWER TAB DOES NOT COMMIT (`FollowerTabCommitError`): its state is a copy no disk and no
    // other tab will follow, so a commit it sent stranded the leader behind the group.
    if (getTabLeadership() === 'follower') {
      console.warn(
        `[COMMIT] ${groupId.slice(0, 8)}... commit refused on a follower tab - only the leader commits`
      );
      throw new FollowerTabCommitError(groupId);
    }
    const out = await this.runCommitUnderMlsLock(groupId, async () =>
      // RAISED UNDER THE MLS MUTEX, WHICH IS WHAT MAKES IT DEADLOCK-FREE: a send that sees this
      // barrier provably does not hold the mutex, so it blocks nothing the drain inside waits for.
      // The section covers stage through merge - the whole window in which this device's notion
      // of the epoch and the server's can disagree. See `epochSendBarrier`.
      runAsEpochAdvance(groupId, async () => {
        // ONE COMMIT, REBUILT WHILE THE SERVER ANSWERS `SEAT_CLAIM_OVERTAKEN`. That refusal moved
        // nothing - the epoch, the tree and the log stand where they were - and it reaches EVERY
        // commit that writes a seat, an ordinary conversation's included: a pending member's own
        // add or remove carries its committer's claim. Rebuilt here, under the same lock, no caller
        // has to know about it; only the last refusal of the bound is handed up.
        //
        // ONLY A FIRST REQUEST THE GATE ANSWERED IS REBUILT. The 409 refuses the request that got
        // it, and nothing more: the gate reads seat claims per request, so a first request that got
        // no answer - stalled on the way, or inside its transaction past the server's 5 s commit
        // lock while this client waits up to 30 s - may still land with claims of its own. After
        // one, a 409 keeps the stage (`resubmitUnresolved`), never clears or rebuilds it.
        //
        // A STAGE LEFT ON A FAILED CLEAR IS STILL UNRESOLVED, so every clear here notes the group
        // when it fails: the next settlement reads it again.
        const clear = async () => {
          try {
            await this.clearPendingCommit(groupId);
          } catch (clearErr) {
            this.unresolvedGroups?.add(groupId);
            throw clearErr;
          }
        };
        // ONE BUDGET FOR THE WHOLE HOLD, settlement and rebuilds included (`COMMIT_LOCK_HOLD_BUDGET_MS`):
        // the lock this runs under guards every exclusive MLS section (the drain borrows it only
        // while a request is on the network - `submitRecorded`), and this group's own frames.
        const holdEndsAt = commitLockHoldEndsAt();
        for (let attempt = 1; ; attempt++) {
          // NOT STAGED AT ALL while the server still refuses this account's commits: the answer is
          // already known (`commitRateLimit.ts`), and nothing is left to roll back.
          const waitMs = commitRateLimitRemainingMs();
          if (waitMs > 0) {
            const epoch = await this.freshEpoch(groupId);
            console.warn(
              `[COMMIT] ${groupId.slice(0, 8)}... not submitted - the commit rate limit holds for ${Math.round(waitMs / 1000)} s more`
            );
            throw new CommitRefusedError('rate_limited', epoch, undefined, waitMs);
          }
          // A PREVIOUS COMMIT WHOSE OUTCOME IS UNKNOWN IS SETTLED FIRST, and nothing is staged on
          // top of it while it stays unknown: openmls holds it pending, and the epoch this commit
          // would be built on is exactly what that outcome decides.
          // Its own type: THIS commit was never staged, so nothing of the caller's is kept.
          if ((await this.settleUnresolvedLocked(groupId, holdEndsAt)) === 'unknown') {
            throw new PreviousCommitUnresolvedError(groupId, this.getEpoch(groupId));
          }
          // NOTHING IS STAGED THAT THE BUDGET CANNOT SEE ANSWERED: a stage whose first request
          // cannot start would only be rolled back.
          if (!mayStartCommitRequest(holdEndsAt)) {
            const epoch = this.getEpoch(groupId);
            console.warn(
              `[COMMIT] ${groupId.slice(0, 8)}... not staged on ${epoch} (attempt ${attempt}) - the MLS lock budget of ${COMMIT_LOCK_HOLD_BUDGET_MS} ms is spent`
            );
            throw new CommitRefusedError(
              attempt > 1 ? SEAT_CLAIM_OVERTAKEN_REASON : COMMIT_LOCK_BUDGET_SPENT_REASON,
              epoch,
              attempt > 1 ? epoch : undefined
            );
          }
          // WHAT THIS CLIENT KNOWS OF THE COMMIT GOES INTO THE STAGE ITSELF, and the platform records
          // it with the staged commit in the SAME call (`commitSubmission.ts`): a checkpoint does not
          // take this lock, so a record written by a second call could miss one that ran between.
          const intent: CommitIntent = {
            groupId,
            self: `${this.userId}:${this.deviceId}`,
            ...(opts.excludeDeviceIds ? { excludeDeviceIds: opts.excludeDeviceIds } : {}),
            // Whom this commit removes, so the server queues it to the devices its half of the
            // removal already parted (`commitRemovals`).
            ...(opts.removes ? { removes: opts.removes } : {}),
            ...(opts.keyPackageDevices ? { keyPackageDevices: opts.keyPackageDevices } : {}),
            // What a lost commit owes a re-plan of (`owedInvitations.ts`), on disk with the stage.
            ...(opts.invitation ? { invitation: opts.invitation } : {}),
          };
          const staged = await stageFn(encodeIntent(intent));
          // THE REQUEST IS COMPOSED FROM THE RECORD, never from the values in hand, so the first
          // submission and any resubmission are one spelling of the same bytes.
          const read = await this.pendingSubmission(groupId);
          const submission = read.status === 'recorded' ? composeSubmission(read.record) : null;
          if (!submission) {
            // The platform staged without the record its contract promises: nothing has been sent,
            // so clearing is safe - and this is a defect of the stage, said as one.
            await this.clearPendingCommit(groupId).catch(() => {});
            console.error(
              `[COMMIT] ${groupId.slice(0, 8)}... the stage left ${read.status === 'recorded' ? 'an unreadable' : read.status} ` +
                'record beside its commit - cleared before sending anything'
            );
            throw new Error(`staged commit of ${groupId.slice(0, 8)}... has no usable record`);
          }
          const { baseEpoch } = submission;
          // ON DISK BEFORE THE FIRST REQUEST LEAVES. Once it has left, the gate may accept it at any
          // moment, so a crash from here on must reload a state that holds this stage and its
          // record - the resubmission at the next connection then decides. Without this, a crash
          // before the next checkpoint reloaded the state from BEFORE the stage: a commit the
          // server may hold, that this device can neither merge nor resubmit.
          //
          // A CHECKPOINT THAT THREW SENDS NOTHING. What it does with the stage depends on WHERE it
          // threw, read from the type (`checkpointWroteNothing`):
          //  - it stored nothing (refused, or failed before anything was stored): the commit never
          //    left and this write did not save it, so it is CLEARED and the failure is definitive
          //    (`CommitStageNotSavedError`) - a checkpoint that keeps failing costs each commit, not
          //    every send of the session. An earlier checkpoint exporting after the stage may still
          //    have saved it; a reload then holds a stage that never left, which its settle submits
          //    as a first request and the gate decides - a commit the member asked for, never a fork;
          //  - anything else may have thrown after its write landed, so the stage may be on disk and
          //    a clear reported as "failed" would be contradicted by the next reload. It is KEPT,
          //    exactly like an unanswered one, and the settle decides - after its own checkpoint.
          const unsaved = await this.checkpointStageBeforeSend(groupId, baseEpoch);
          if (unsaved !== null && checkpointWroteNothing(unsaved)) {
            try {
              await this.clearPendingCommit(groupId);
            } catch (clearErr) {
              // Not cleared: the stage stays, so its outcome is the settle's to decide.
              console.error(
                `[COMMIT] ${groupId.slice(0, 8)}... could not clear the unsaved stage on ${baseEpoch}: ${String(clearErr).slice(0, 120)}`
              );
              this.unresolvedGroups?.add(groupId);
              throw new CommitOutcomeUnknownError(groupId, baseEpoch, clearErr, 'its clear failed');
            }
            console.warn(
              `[COMMIT] ${groupId.slice(0, 8)}... the stage on epoch ${baseEpoch} was not saved (the checkpoint stored nothing) - cleared, nothing sent`
            );
            throw new CommitStageNotSavedError(groupId, baseEpoch, unsaved);
          }
          if (unsaved !== null) {
            this.unresolvedGroups?.add(groupId);
            throw new CommitOutcomeUnknownError(
              groupId,
              baseEpoch,
              unsaved,
              'its checkpoint failed before the first request, so it was never sent'
            );
          }
          // THE BUDGET IS READ AGAIN AFTER THE CHECKPOINT, which may have taken long: a first request
          // that cannot start is never sent, so its stage is cleared exactly as an unsaved one is.
          // The checkpoint may have saved it; a reload then settles a stage that never left, which
          // the gate decides as a first request - never a fork.
          if (!mayStartCommitRequest(holdEndsAt)) {
            try {
              await clear();
            } catch (clearErr) {
              console.error(
                `[COMMIT] ${groupId.slice(0, 8)}... could not clear the unsent stage on ${baseEpoch}: ${String(clearErr).slice(0, 120)}`
              );
              throw new CommitOutcomeUnknownError(groupId, baseEpoch, clearErr, 'its clear failed');
            }
            console.warn(
              `[COMMIT] ${groupId.slice(0, 8)}... the stage on ${baseEpoch} was not sent - the MLS lock budget of ${COMMIT_LOCK_HOLD_BUDGET_MS} ms is spent; cleared`
            );
            throw new CommitRefusedError(
              attempt > 1 ? SEAT_CLAIM_OVERTAKEN_REASON : COMMIT_LOCK_BUDGET_SPENT_REASON,
              baseEpoch,
              attempt > 1 ? baseEpoch : undefined
            );
          }
          if (submission.admits) {
            console.log(
              `[COMMIT] ${groupId.slice(0, 8)}... admits ${submission.admits.length} device(s) at epoch ${baseEpoch + 1}: ${submission.admits.map((a) => `${a.userId.slice(0, 8)}:${a.deviceId}`).join(', ')}`
            );
          }
          // One atomic server round-trip: validate the epoch, and on accept the server records the
          // commit in the epoch-indexed log (rung-1 replay) AND fans it out to members. If we crash
          // between this accept and the local merge below, the reload holds the stage and its record
          // (checkpointed above), and the resubmission at the next connection merges it. [[C7]]
          let validation: Awaited<ReturnType<typeof this.delivery.submitCommit>>;
          try {
            validation = await this.submitRecorded(submission);
          } catch (e) {
            // A 429 ON THE FIRST REQUEST IS A REFUSAL, NOT A SILENCE: the per-user limit on
            // `POST /mls/commit` answers before the epoch gate, and no earlier request of these
            // bytes exists, so the server provably did not advance. Rolled back exactly as on a
            // business refusal, with the limit remembered (`commitRateLimit.ts`). On a RESUBMISSION
            // the same 429 says nothing of the first request, which `resubmitUnresolved` keeps.
            if (e instanceof ApiRefusalError && e.status === 429) {
              console.warn(
                `[COMMIT] ${groupId.slice(0, 8)}... refused by the commit rate limit at epoch ${baseEpoch} - staged commit rolled back`
              );
              noteCommitRateLimited(e.retryAfterMs);
              await clear().catch((clearErr: unknown) =>
                console.error(
                  `[COMMIT] ${groupId.slice(0, 8)}... could not roll back the rate-limited commit:`,
                  String(clearErr).slice(0, 120)
                )
              );
              throw new CommitRefusedError(
                'rate_limited',
                baseEpoch,
                undefined,
                commitRateLimitRemainingMs()
              );
            }
            if (isDefinitiveCommitRefusal(e)) {
              // The gate ANSWERED, and refused before reaching the epoch: nothing landed.
              if (await rebuildOnOvertakenClaim(clear, groupId, baseEpoch, attempt, e)) continue;
              await clear().catch((clearErr: unknown) =>
                console.error(
                  `[COMMIT] ${groupId.slice(0, 8)}... could not clear the refused commit at ` +
                    `${baseEpoch}: ${String(clearErr)}`
                )
              );
              throw e;
            }
            // NO ANSWER IS NOT A REFUSAL, AND IT IS NOT A GUESS EITHER. The request may still be on
            // its way, or it was taken and only the answer lost - the same bytes, sent again, make
            // the gate say which (an accepted commit is answered as a duplicate).
            console.warn(
              `[COMMIT] ${groupId.slice(0, 8)}... no answer to the commit from epoch ${baseEpoch} ` +
                `(${String(e).slice(0, 120)}) - resubmitting the same commit`
            );
            const answer = await this.resubmitUnresolved(submission, holdEndsAt);
            if (answer.verdict === 'unknown') {
              // KEPT: the staged commit and its record stay in the state - already on disk, by the
              // checkpoint before the first request - and a later resubmission decides. Never
              // rebuilt: the first request's outcome is what is unknown.
              this.unresolvedGroups?.add(groupId);
              throw new CommitOutcomeUnknownError(
                groupId,
                baseEpoch,
                answer.error ?? answer.answer?.reason ?? e
              );
            }
            if (answer.answer === undefined) {
              // Refused by a 4xx that is neither a 429 nor a 409 (`resubmitUnresolved` reads both as unknown): the gate
              // answered these bytes before reaching the epoch, and nothing landed.
              await clear().catch((clearErr: unknown) =>
                console.error(
                  `[COMMIT] ${groupId.slice(0, 8)}... could not clear the commit refused on resubmission at ` +
                    `${baseEpoch}: ${String(clearErr).slice(0, 120)}`
                )
              );
              throw answer.error;
            }
            validation = answer.answer;
          }
          if (!validation.accepted) {
            // Rejected: roll back the staged commit. The local epoch never moved, so there is NO
            // fork. Throw without the `server epoch:.., sent:..` marker so the caller treats it as a
            // retryable failure rather than a fork to heal. [[C7]]
            await clear().catch((clearErr: unknown) =>
              console.error(
                `[COMMIT] ${groupId.slice(0, 8)}... could not clear the refused commit at ` +
                  `${baseEpoch}: ${String(clearErr).slice(0, 120)}`
              )
            );
            // ...and MAKE that retry true, because until now nothing did. See `catchUpOnRefusedCommit`.
            await this.catchUpOnRefusedCommit(
              groupId,
              baseEpoch,
              validation.currentEpoch,
              validation.reason
            );
            throw new CommitRefusedError(
              validation.reason || 'epoch_mismatch',
              baseEpoch,
              validation.currentEpoch,
              null,
              Array.isArray(validation.userIds) ? validation.userIds : null
            );
          }
          if (validation.duplicate) {
            console.log(
              `[COMMIT] ${groupId.slice(0, 8)}... the commit from epoch ${baseEpoch} had been ` +
                'accepted - its first answer was lost; merging'
            );
          }
          // AN ADD IS MERGED OWING ITS WELCOME, IN THE SAME PLATFORM CALL (`owed_welcome.rs`). The
          // caller sends it after this returns, and that send consumes the obligation
          // ({@link sendWelcome}); held only in the caller's hands, a reload before the send lost it
          // with the merge already on disk, and only the invitee's own repair let it in (DUP-7).
          // ...TO THE DEVICES THE GATE ADMITTED. One it did not record, for a reason no Welcome can
          // get past, is owed none (`undeliverableAdmits`): the answer already said so.
          const notAdmitted = undeliverableAdmits(groupId, validation.refusedAdmits);
          // ACCEPTED, SO IT LANDED: a merge failure from here on is typed as such, so no caller
          // reads it as a refusal of a commit every member already has.
          try {
            await this.mergeAccepted(submission, notAdmitted);
          } catch (mergeError) {
            throw new AcceptedCommitNotMergedError(groupId, baseEpoch, mergeError);
          }
          const ratchetTree = opts.exportTree ? await this.exportRatchetTree(groupId) : undefined;
          return {
            welcome: staged.welcome,
            ratchetTree,
            addedDeviceIds: staged.addedDeviceIds ?? [],
            skipped: staged.skipped ?? [],
            notAdmitted,
          };
        }
      })
    );
    // NO FOLLOW-UP REFRESH HERE, AND ITS ABSENCE IS THE FIX (COMM-22). It used to be a
    // fire-and-forget `refreshGroupInfo` that was the only thing minting the successor base for a
    // staged commit, and losing it stranded the published base one epoch behind. The base now
    // travelled inside the accepted submission. `republishStaleBase` / `republishBaseIfStale` stay
    // as the holder repair for the OTHER causes of a stale base (a legacy client's commit, a
    // server-side write that failed), which is a different question from this commit's own base.
    return out;
  }

  /**
   * Submits `submission` to the commit gate, exactly as recorded - the one spelling of the request.
   *
   * THE MLS MUTEX IS LENT WHILE THE REQUEST IS ON THE NETWORK (`lendMlsLockWhile`): frames of OTHER
   * groups are applied meanwhile, one at a time, and the mutex is taken back before this returns, so
   * the merge or clear that follows runs exactly as before. Called only by the holder of
   * {@link runCommitUnderMlsLock} for this group - the transaction and the settlement.
   */
  private submitRecorded(
    submission: CommitSubmission
  ): ReturnType<typeof this.delivery.submitCommit> {
    return this.lendMlsLockDuring(submission.groupId, () =>
      this.delivery.submitCommit(
        submission.groupId,
        submission.baseEpoch,
        submission.commit,
        submission.excludeDeviceIds,
        submission.groupInfo,
        submission.admits,
        submission.removes,
        submission.invitationSeatGeneration
      )
    );
  }

  /**
   * Submits `submission` AGAIN and reads the gate's verdict (`commitSubmission.ts`): accepted (the
   * first time, or answered as a duplicate), refused (an epoch conflict, or a 4xx), or unknown (no
   * answer, a 5xx, or `concurrent_commit` - a lock our own first request may hold).
   *
   * A 429, A 401 AND A 403 ARE UNKNOWN HERE, never a refusal ({@link refusesOnlyThisRequest}): the
   * throttler and the auth guard answer before the gate, so they say nothing of the EARLIER request
   * of these bytes, which may have landed - a session that expired after an accepted but unanswered
   * commit is exactly that. Clearing on one could leave this device behind its own accepted commit,
   * on the way to a re-Welcome; the stage is kept (and a 429's limit remembered).
   *
   * SO IS A `409 SEAT_CLAIM_OVERTAKEN`. The gate reads a commit's seat claims per REQUEST, when it
   * arrives, so the 409 refuses this copy only: the first request, stalled on the way or inside its
   * transaction past the server's 5 s commit lock, reads its own claims and may still land. The gate
   * answers `duplicate` instead of the 409 once that first request's log row exists, so the next
   * settlement decides; never cleared, never rebuilt here.
   *
   * No request starts once `holdEndsAt` would be passed ({@link mayStartCommitRequest}): the outcome
   * then stays unknown.
   */
  private async resubmitUnresolved(
    submission: CommitSubmission,
    holdEndsAt: number
  ): Promise<{
    verdict: ResubmissionVerdict;
    answer?: Awaited<ReturnType<MlsDeliveryApi['submitCommit']>>;
    error?: unknown;
  }> {
    const short = submission.groupId.slice(0, 8);
    const from = `the commit from epoch ${submission.baseEpoch}`;
    if (!mayStartCommitRequest(holdEndsAt)) {
      const error = new Error(
        `the MLS lock budget of ${COMMIT_LOCK_HOLD_BUDGET_MS} ms is spent - no resubmission sent`
      );
      console.warn(`[COMMIT] ${short}... resubmission of ${from}: unknown (${error.message})`);
      return { verdict: 'unknown', error };
    }
    try {
      const answer = await this.submitRecorded(submission);
      const verdict = resubmissionVerdict(answer);
      console.log(
        `[COMMIT] ${short}... resubmission of ${from}: ` +
          `${verdict}${answer.duplicate ? ' (duplicate of an accepted commit)' : ''}` +
          `${answer.reason ? ` (${answer.reason}${answer.currentEpoch !== undefined ? `, server at ${answer.currentEpoch}` : ''})` : ''}`
      );
      return { verdict, answer };
    } catch (e) {
      const rateLimited = e instanceof ApiRefusalError && e.status === 429;
      if (rateLimited) noteCommitRateLimited(e.retryAfterMs);
      const verdict: ResubmissionVerdict =
        !refusesOnlyThisRequest(e) && !isSeatClaimOvertaken(e) && isDefinitiveCommitRefusal(e)
          ? 'refused'
          : 'unknown';
      console.warn(
        `[COMMIT] ${short}... resubmission of ${from}: ${verdict} (${String(e).slice(0, 120)})`
      );
      return { verdict, error: e };
    }
  }

  /**
   * Makes `groupId`'s staged commit and its record durable BEFORE a request carrying it leaves - the
   * first one, and a settle's resubmission - and returns what stopped it, or `null`. Awaited under
   * the MLS lock, which is safe: the checkpoint exports the state without taking that lock. Its cost
   * is one checkpoint per commit, paid while the commit holds the lock - measured in
   * `mls-protocol.md`.
   */
  private async checkpointStageBeforeSend(groupId: string, baseEpoch: number): Promise<unknown> {
    try {
      await persistMlsStructuralCheckpoint({ mlsService: this });
      return null;
    } catch (e) {
      console.error(
        `[COMMIT] ${groupId.slice(0, 8)}... the commit staged on epoch ${baseEpoch} could NOT be ` +
          `checkpointed - nothing is sent (${checkpointWroteNothing(e) ? 'nothing was stored' : 'the write may have landed'}): ${String(e).slice(0, 120)}`
      );
      return e;
    }
  }

  /**
   * Awaits the structural checkpoint after an unresolved commit was settled: the server already
   * holds the outcome, and the merged epoch's secrets exist only in memory until this lands.
   */
  private async awaitCommitCheckpoint(groupId: string, what: string): Promise<void> {
    try {
      await persistMlsStructuralCheckpoint({ mlsService: this });
    } catch (e) {
      console.error(
        `[COMMIT] ${groupId.slice(0, 8)}... ${what} was NOT checkpointed - a reload before the ` +
          `next write loses it: ${String(e).slice(0, 120)}`
      );
    }
  }

  /** The record its stage wrote beside `groupId`'s staged commit (`commitSubmission.ts`). */
  protected abstract pendingSubmission(groupId: string): Promise<PendingSubmissionRead>;
  /** Merges `groupId`'s accepted Add and records its Welcome as owed to `recipients`, in one call. */
  protected abstract mergePendingCommitOwingWelcome(
    groupId: string,
    recipients: string[]
  ): Promise<void>;
  /** Every Welcome the state still owes (`mls-core/src/owed_welcome.rs`). */
  protected abstract owedWelcomes(): Promise<OwedWelcome[]>;
  /** `recipient` was answered for `welcome` in `groupId`: the entry carrying those bytes owes it no longer. */
  protected abstract welcomeDelivered(
    groupId: string,
    recipient: string,
    welcome: Uint8Array
  ): Promise<void>;
  /** Every group whose state holds a staged commit not yet merged or cleared. */
  protected abstract groupsWithPendingCommit(): Promise<string[]>;

  /**
   * The groups this session knows hold an unresolved commit - a DERIVED index of the MLS state, read
   * from it once ({@link groupsWithPendingCommit}) and then kept by the paths that keep or settle a
   * commit, so a send does not cross into the platform to ask. The state stays the one truth: every
   * settlement reads it again.
   */
  private unresolvedGroups: Set<string> | null = null;

  private async knownUnresolvedGroups(): Promise<Set<string>> {
    if (this.unresolvedGroups === null) {
      this.unresolvedGroups = new Set(await this.groupsWithPendingCommit());
    }
    return this.unresolvedGroups;
  }

  /**
   * Drops the derived index of unresolved groups, so the next send re-reads it from the state. Called
   * BEFORE a state swap as well as after it: a send between the two must not trust an index of the
   * state being replaced.
   */
  protected forgetUnresolvedIndex(): void {
    this.unresolvedGroups = null;
  }

  /**
   * The MLS state was replaced under this session - a resume reload installed `mls.bin`, which a
   * background engine may have written with a commit staged and unsettled (an Android background
   * Welcome whose answer it never read). The derived index is dropped AT ONCE, before this returns,
   * so the next send re-reads the state and settles first ({@link knownUnresolvedGroups}); then every
   * staged commit is settled, without holding the caller: its outcome needs the server, and a resume
   * must not wait on the network.
   */
  protected settleAfterStateReplaced(): void {
    this.forgetUnresolvedIndex();
    void this.settleUnresolvedCommits().catch((e: unknown) =>
      console.error(
        `[COMMIT] settling the commits of a reloaded state failed: ${String(e).slice(0, 160)}`
      )
    );
  }

  /**
   * Settles `groupId`'s staged commit, if its state holds one, by resubmitting the submission kept
   * beside it. MUST be called holding the MLS lock (and inside the group's epoch-advance barrier):
   * it merges or clears.
   *
   * - `none`: no staged commit;
   * - `merged`: the gate accepted it (first time or duplicate) - merged, and an Add's Welcome
   *   delivered to the devices it admits, since nobody else is left to send it;
   * - `cleared`: refused (and caught up), or staged and NEVER SENT - no record beside it, which the
   *   one-call stage makes a proof, not a guess;
   * - `unknown`: still no answer, or a record that cannot be read
   *   ({@link escalateUnreadableSubmission}); the staged commit and its record stay.
   *
   * `holdEndsAt` is the lock-hold budget of the caller's transaction ({@link commitLockHoldEndsAt}):
   * this settlement's requests count against it.
   */
  private async settleUnresolvedLocked(
    groupId: string,
    holdEndsAt: number
  ): Promise<'none' | 'merged' | 'cleared' | 'unknown'> {
    if (!(await this.groupsWithPendingCommit()).includes(groupId)) {
      this.unresolvedGroups?.delete(groupId);
      return 'none';
    }
    const short = groupId.slice(0, 8);
    const read = await this.pendingSubmission(groupId);
    if (read.status === 'none') {
      await this.clearPendingCommit(groupId).catch((e: unknown) =>
        console.error(`[COMMIT] ${short}... could not clear an unsent staged commit: ${String(e)}`)
      );
      this.unresolvedGroups?.delete(groupId);
      console.warn(
        `[COMMIT] ${short}... a staged commit with no record beside it was never sent - cleared`
      );
      return 'cleared';
    }
    const submission = read.status === 'recorded' ? composeSubmission(read.record) : null;
    if (!submission) {
      this.escalateUnreadableSubmission(groupId);
      return 'unknown';
    }
    // NOTHING IS SUBMITTED THAT IS NOT ON DISK. A stage kept because its checkpoint threw may never
    // have reached disk, and this request may be its FIRST: the same rule as in
    // `runCommitTransaction`, paid only when a kept commit is settled.
    if ((await this.checkpointStageBeforeSend(groupId, submission.baseEpoch)) !== null) {
      this.unresolvedGroups?.add(groupId);
      return 'unknown';
    }
    const answer = await this.resubmitUnresolved(submission, holdEndsAt);
    if (answer.verdict === 'unknown') {
      this.unresolvedGroups?.add(groupId);
      return 'unknown';
    }
    this.unresolvedGroups?.delete(groupId);
    if (answer.verdict === 'accepted') {
      await this.mergeSettled(submission);
      return 'merged';
    }
    // CLASSIFIED BY THE GATE'S TYPED REASON: `epoch_mismatch` is the race (another commit holds the
    // epoch). Every other refusal - a business refusal in a 200 body (`departed`,
    // `welcome_target_not_member`, ...) or a 4xx - would meet the same answer again. Recorded BEFORE
    // the clear, which erases the invitation's only other copy (`owedInvitations.ts`).
    const reason =
      answer.answer?.reason ??
      (answer.error instanceof ApiRefusalError
        ? (answer.error.code ?? `http_${answer.error.status}`)
        : undefined);
    // A COMMIT REFUSED WHOLE FOR THE PEOPLE IT WOULD ADMIT (`admit_refused`) is the invitation minus
    // them: re-planned for the others as a race is, never again for the people it names.
    const refusedPeople =
      answer.answer?.reason === ADMIT_REFUSED_REASON && Array.isArray(answer.answer.userIds)
        ? answer.answer.userIds
        : null;
    const owed = this.oweLostInvitation(
      read.status === 'recorded' ? read.record : null,
      submission,
      reason === RACE_REFUSAL_REASON ? 'race' : 'refused',
      reason,
      refusedPeople ?? undefined
    );
    await this.clearPendingCommit(groupId).catch((e: unknown) => {
      // Still staged, so still unresolved: the next settlement reads it again.
      this.unresolvedGroups?.add(groupId);
      console.warn(`[COMMIT] ${short}... could not clear the refused commit: ${String(e)}`);
    });
    console.log(
      `[COMMIT] ${short}... the kept commit from epoch ${submission.baseEpoch}: refused - cleared`
    );
    await this.catchUpOnRefusedCommit(groupId, submission.baseEpoch, answer.answer?.currentEpoch);
    // NOT AWAITED: the re-plan takes this lock itself, after its holder lets go.
    if (owed) this.replanOwedInvitations('a kept commit was refused');
    return 'cleared';
  }

  /**
   * A kept commit that did NOT land is about to be cleared: if it was the Add of a member's
   * invitation (`CommitIntent.invitation`), records that invitation as owed a re-plan, synchronously
   * and before the clear (`owedInvitations.ts`). Any other commit owes nothing here - an automatic
   * Add is re-derived from the server row it answers, a Remove by the roster collector.
   *
   * A RECORD THAT CANNOT BE WRITTEN (no storage, a full quota) NEVER STOPS THE CLEAR: a refused stage
   * left in place blocks every commit of the group at every connection. The loss is said instead -
   * at error, with its reason, and to the member - and nothing is re-planned.
   *
   * @returns whether an invitation was recorded.
   */
  private oweLostInvitation(
    record: StagedRecord | null,
    submission: CommitSubmission,
    refusedCause: LostInvitationCause,
    reason?: string,
    notAdmitted?: readonly string[]
  ): boolean {
    const recorded = record ? invitationOf(record) : null;
    if (!recorded) return false;
    // The people the gate refused to admit leave the invitation; the others are owed it as after a
    // race - the refusal named them, so nobody else is what it was about. Refused for everyone it
    // named, it stays `refused`, and the member is told.
    let invitation = recorded;
    let cause = refusedCause;
    const users = notAdmitted ? recorded.users.filter((u) => !notAdmitted.includes(u)) : [];
    if (notAdmitted && notAdmitted.length > 0 && users.length > 0) {
      invitation = {
        ...recorded,
        users,
        ...(recorded.rostered
          ? { rostered: recorded.rostered.filter((u) => !notAdmitted.includes(u)) }
          : {}),
      };
      cause = 'race';
      console.warn(
        `[INVITE_OWED] ${submission.groupId.slice(0, 8)}... the gate refused to admit ${notAdmitted.length} invited person(s) - the invitation goes on without them`
      );
    }
    const { groupId, baseEpoch } = submission;
    try {
      recordOwedInvitation(this.userId, {
        groupId,
        baseEpoch,
        invitation,
        cause,
        ...(reason ? { reason } : {}),
      });
    } catch (e) {
      if (!(e instanceof OwedInvitationNotRecordedError)) throw e;
      console.error(
        `[INVITE_OWED] ${groupId.slice(0, 8)}... the Add of ${invitation.users.length} invited person(s) staged on epoch ${baseEpoch} did not land (${cause}${reason ? `: ${reason}` : ''}) and could NOT be recorded (${e.reason}) - not re-planned, the member is told`
      );
      // Told BY THE CONVERSATION'S NAME, which only the chat layer holds: at once if its teller is
      // registered, else once it is (the conversations restored) - never a nameless toast.
      if (this.unrecordedInvitationTeller) this.unrecordedInvitationTeller(groupId);
      else this.unrecordedInvitationsUntold.push(groupId);
      return false;
    }
    console.log(
      `[INVITE_OWED] ${groupId.slice(0, 8)}... the Add of ${invitation.users.length} invited person(s) staged on epoch ${baseEpoch} did not land (${cause}${reason ? `: ${reason}` : ''}) - recorded, ${cause === 'race' ? 're-planned at the new epoch' : 'not re-planned, the member is told'}`
    );
    return true;
  }

  /**
   * Who re-plans a lost invitation - the chat layer, which holds the conversation and the notices
   * (`replanLostInvitation`). See {@link IMlsService.setOwedInvitationReplanner}.
   */
  private owedInvitationReplanner: OwedInvitationReplanner | null = null;
  /** Moves with every registration or removal of the re-planner: a drain runs for ONE of them. */
  private owedInvitationGeneration = 0;
  /** The drain running, and whether another was asked while it ran: one drain at a time. */
  private owedInvitationDrain: Promise<void> | null = null;
  private owedInvitationDrainAgain = false;
  /** A connection's settlement is walking every kept stage: it drains when it is done. */
  private connectionSettling = false;
  /** A connection's settlement has completed in this session (see the registration). */
  private connectionSettled = false;
  /**
   * The groups whose add lock THIS device holds. The server's lock is not re-entrant (one holder
   * per group, this device included), so a re-plan run while one is held is refused its own lock:
   * the drain waits for the release instead ({@link releaseAddLock}).
   */
  private readonly addLocksHeld = new Map<string, string | undefined>();
  /** The one wake per group at the end of a lock the server refused (see {@link wakeAtAddLockExpiry}). */
  private readonly addLockExpiryWakes = new Map<string, ReturnType<typeof setTimeout>>();
  /** Who tells the member of an invitation that could not be recorded, by its conversation's name. */
  private unrecordedInvitationTeller: UnrecordedInvitationTeller | null = null;
  /** The groups of such invitations, until a teller is registered (the conversations restored). */
  private unrecordedInvitationsUntold: string[] = [];

  /** See {@link IMlsService.setOwedInvitationReplanner}. */
  setOwedInvitationReplanner(
    replanner: OwedInvitationReplanner | null,
    tellUnrecorded: UnrecordedInvitationTeller | null = null
  ): void {
    this.owedInvitationReplanner = replanner;
    this.unrecordedInvitationTeller = replanner ? tellUnrecorded : null;
    this.owedInvitationGeneration++;
    if (!replanner) {
      // The session's wakes and notices are its own: the next account inherits none.
      this.cancelAddLockExpiryWakes();
      this.unrecordedInvitationsUntold = [];
    } else if (tellUnrecorded) {
      const untold = this.unrecordedInvitationsUntold;
      this.unrecordedInvitationsUntold = [];
      for (const groupId of untold) tellUnrecorded(groupId);
    }
    // Drained by the connection's settlement, once it has settled every kept stage. A re-planner that
    // arrives after that settlement drains at once, while the gateway answers; one that arrives
    // before it leaves the drain to it - draining first would re-plan an invitation whose stage that
    // settlement is about to refuse and record again.
    if (replanner && this.connectionSettled && this.isWsOpen()) {
      this.replanOwedInvitations('re-planner registered');
    }
  }

  /**
   * Drains again when an event lifts what a waiting entry waits on in `groupId` - its conversation
   * became available - and only if something is owed there, so the event costs nothing otherwise.
   */
  private replanOwedInvitationsIn(groupId: string, why: string): void {
    // Without a re-planner there is nothing to drain into: its registration drains instead.
    if (!this.owedInvitationReplanner) return;
    if (owesInvitationIn(this.userId, groupId)) this.replanOwedInvitations(why);
  }

  /**
   * Hands every owed invitation to the re-planner, one at a time, and drops each entry whose re-plan
   * CONCLUDED - the re-planner tells the member every ending it does not complete. An entry that must
   * WAIT (`ReplanVerdict`) stays, for the event that lifts its wait. NEVER AWAITED BY A LOCK HOLDER:
   * the re-plan takes the MLS lock itself.
   *
   * Nothing runs without a re-planner, on a follower tab (only the leader commits), or while this
   * device holds an add lock: the entries stay for the next drain, and the release asks for it. A
   * drain asked while one runs runs once more after it, so an entry recorded meanwhile - the
   * re-plan's own Add lost in turn - is not left behind.
   */
  protected replanOwedInvitations(why: string): void {
    // A connection's settlement drains once it has settled EVERY kept stage (see there).
    if (this.connectionSettling) return;
    // Asked while one runs - its own re-plans hold add locks, so this comes first.
    if (this.owedInvitationDrain) {
      this.owedInvitationDrainAgain = true;
      return;
    }
    // The release of the last one drains (`releaseAddLock`).
    if (this.addLocksHeld.size > 0) return;
    const drain = async () => {
      do {
        this.owedInvitationDrainAgain = false;
        await this.drainOwedInvitationsOnce(why);
      } while (this.owedInvitationDrainAgain);
    };
    this.owedInvitationDrain = drain()
      .catch((e: unknown) =>
        console.error(`[INVITE_OWED] the drain failed (${why}): ${String(e).slice(0, 160)}`)
      )
      .finally(() => {
        this.owedInvitationDrain = null;
      });
  }

  private async drainOwedInvitationsOnce(why: string): Promise<void> {
    const owed = listOwedInvitations(this.userId);
    if (owed.length === 0) return;
    const replanner = this.owedInvitationReplanner;
    if (!replanner) {
      console.log(
        `[INVITE_OWED] ${owed.length} lost invitation(s) owed a re-plan - no re-planner yet, kept (${why})`
      );
      return;
    }
    if (getTabLeadership() === 'follower') {
      console.log(
        `[INVITE_OWED] ${owed.length} lost invitation(s) owed a re-plan - a follower tab does not commit, left to the leader (${why})`
      );
      return;
    }
    // THE RE-PLANNER IS A SESSION'S: a sign-out (null) or a new session's registration during the
    // drain ends it here, so no entry of the leaving account is re-planned or told over the next.
    const generation = this.owedInvitationGeneration;
    for (const entry of owed) {
      if (this.owedInvitationGeneration !== generation) {
        console.log(
          `[INVITE_OWED] the re-planner changed during the drain - its remaining entries are kept (${why})`
        );
        return;
      }
      console.log(
        `[INVITE_OWED] ${entry.groupId.slice(0, 8)}... re-planning the invitation lost at epoch ${entry.baseEpoch} (${entry.cause}, ${why})`
      );
      let verdict: ReplanVerdict;
      try {
        verdict = await replanner(entry);
      } catch (e) {
        // The re-planner reports every ending itself; a throw is a defect of it, said as one.
        console.error(
          `[INVITE_OWED] ${entry.groupId.slice(0, 8)}... the re-plan of the invitation lost at epoch ${entry.baseEpoch} THREW - dropped: ${String(e).slice(0, 160)}`
        );
        verdict = 'concluded';
      }
      if (verdict === 'concluded') settleOwedInvitation(this.userId, entry);
    }
  }

  /**
   * A staged commit whose record cannot be read: its outcome is UNDECIDED, and nothing here can
   * decide it - the bytes a resubmission needs are the unreadable part, and the commit log can only
   * be compared against them. Clearing would be a guess (the commit may have landed, and a cleared
   * device then forks); merging would be the opposite guess.
   *
   * THE RUNG TAKEN IS THE LADDER'S SECOND, forget + re-Welcome, because it is the one repair that is
   * right whichever way the commit went: the group is marked in the epoch-gap registry, which keeps
   * every send out of it and hands it to the sync watchdog that owns rung 2. The staged commit stays
   * until then, so no new commit is built on an epoch nobody knows.
   */
  private escalateUnreadableSubmission(groupId: string): void {
    this.unresolvedGroups?.add(groupId);
    markEpochGap(groupId);
    console.error(
      `[COMMIT] ${groupId.slice(0, 8)}... the record of the staged commit is UNREADABLE - its outcome ` +
        'cannot be learnt, so it is neither merged nor cleared; the group is handed to rung 2 ' +
        '(forget + re-Welcome) through the epoch-gap registry'
    );
  }

  /**
   * Merges `submission`'s staged commit, which the gate accepted - an Add OWING ITS WELCOME to the
   * devices it admits, in the same platform call (`mls-core/src/owed_welcome.rs`), anything else
   * plainly - and returns those recipients (none for a commit that is not an Add). The ONE merge of
   * an accepted commit, for the transaction that got the accept and the settlement that learnt it
   * later alike: whichever state reaches disk, it holds either the stage and its record (a
   * settlement re-derives the Add) or the merge and its owed Welcome (the connection drain sends
   * it), never the merge alone.
   *
   * `notAdmitted` are admits the gate's answer said it did not record and that no Welcome can reach
   * ({@link undeliverableAdmits}): they are owed nothing. A settlement learns the accept from a
   * `duplicate` answer, which names none, so it owes every admit, and a refused one is answered by
   * its Welcome's typed refusal instead.
   */
  private async mergeAccepted(
    submission: CommitSubmission,
    notAdmitted: readonly RefusedAdmit[] = []
  ): Promise<string[]> {
    const refused = new Set(notAdmitted.map((r) => `${r.userId}:${r.deviceId}`));
    const recipients = submission.welcome
      ? (submission.admits ?? [])
          .map((a) => `${a.userId}:${a.deviceId}`)
          .filter((recipient) => !refused.has(recipient))
      : [];
    if (recipients.length > 0) {
      await this.mergePendingCommitOwingWelcome(submission.groupId, recipients);
    } else {
      await this.mergePendingCommit(submission.groupId);
    }
    // EVERY OWN COMMIT REPLACES THIS DEVICE'S LEAF - openmls puts a path in each member commit it
    // builds (`mls-core/tests/self_update.rs`) - so an Add or a Remove is a refresh too, and the
    // periodic one is not owed again for an interval. Dated HERE, the one merge both the transaction
    // and a settlement go through.
    await this.noteOwnLeafReplaced(submission.groupId, submission.baseEpoch + 1);
    return recipients;
  }

  /**
   * Dates this device's leaf in `groupId` in the refresh ledger, after a merge of its own commit
   * created `epoch` - naming the leaf by the key the merge gave it (`leafRefresh.ts`).
   *
   * The ONE writer of a refresh, reached by {@link mergeAccepted} and by an accepted external join.
   * A key that cannot be read leaves the entry of the former leaf, which the next send reads as a
   * first sight - no commit - and it is said.
   */
  private async noteOwnLeafReplaced(groupId: string, epoch: number): Promise<void> {
    let leaf: string | null;
    try {
      leaf = await this.ownLeafKey(groupId);
    } catch (e) {
      console.warn(
        `[LEAF_REFRESH] ${groupId.slice(0, 8)}... the leaf our commit made at epoch ${epoch} could not be read - not dated, the next send observes it: ${String(e).slice(0, 120)}`
      );
      return;
    }
    if (leaf === null) {
      console.warn(
        `[LEAF_REFRESH] ${groupId.slice(0, 8)}... our commit merged at epoch ${epoch} and the tree holds no leaf of ours - nothing to date`
      );
      return;
    }
    noteOwnLeafRefreshed(this.userId, this.deviceId, groupId, epoch, leaf);
  }

  /**
   * Merges a kept commit the gate has now accepted, dates the leaf, and - for an Add - delivers its
   * Welcome to the devices it admits: the Welcome is a separate request made after the accept, and
   * the call that staged the Add is long gone.
   *
   * **THE OWED WELCOME IS STATE, WRITTEN BY THE MERGE** (`mls-core/src/owed_welcome.rs`). This used
   * to merge, send, and leave the checkpoint for later, so a reload in between settled the same Add
   * again and sent every Welcome twice. Now the merge records "owed to these devices" in the same
   * platform call, the checkpoint is awaited, and only then is anything sent, each recipient
   * cleared as it goes ({@link deliverOwedWelcomes}). A reload re-sends at most what was not yet
   * cleared, and the joiner takes a copy of a Welcome for a group it holds as a redelivery
   * (`setupMessageHandler`).
   */
  private async mergeSettled(submission: CommitSubmission): Promise<void> {
    const { groupId, baseEpoch } = submission;
    const short = groupId.slice(0, 8);
    const recipients = await this.mergeAccepted(submission);
    console.log(`[COMMIT] ${short}... the kept commit from epoch ${baseEpoch}: accepted - merged`);
    if (recipients.length === 0) return;
    // ON DISK BEFORE THE FIRST SEND: from here a reload finds the Add merged and its Welcome owed,
    // never the Add still staged.
    await this.awaitCommitCheckpoint(groupId, 'the settled Add and the Welcome it owes');
    await this.deliverOwedWelcomes(groupId);
  }

  /**
   * Sends every Welcome the state still owes - `groupId`'s only, when given - through
   * {@link sendWelcome}, which clears each recipient once the server answered. A send that fails is
   * said and stays owed, for the next connection to send again. The clears reach disk with the next
   * checkpoint: a lost clear means one more copy of the same bytes, which the server stores once
   * (`MessagingService.sendWelcome`) and the joiner takes as a redelivery.
   */
  private async deliverOwedWelcomes(groupId?: string): Promise<void> {
    const owed = (await this.owedWelcomes()).filter((w) => !groupId || w.groupId === groupId);
    // ONE persist for the whole pass, scheduled after it: each clear is a state change, and a
    // checkpoint per recipient would cost seconds each on a phone.
    let changed = false;
    for (const w of owed) {
      const short = w.groupId.slice(0, 8);
      // A tree the merge could not export is recorded empty (`owed_welcome.rs`): sent without one.
      const ratchetTree = w.ratchetTree.length > 0 ? w.ratchetTree : undefined;
      for (const recipient of w.recipients) {
        const device = parseDeviceIdentity(recipient);
        if (!device) {
          // Written by this client from `userId:deviceId` admits; unreachable, and said if reached.
          // Nothing was sent, so no server answer is claimed: dropped as a defect of the record.
          console.error(
            `[COMMIT] ${short}... owed Welcome names no device (${recipient}) - a defect of the record, dropped unsent`
          );
          try {
            await this.welcomeDelivered(w.groupId, recipient, w.welcome);
            changed = true;
          } catch (e) {
            console.error(
              `[COMMIT] ${short}... the unaddressable owed Welcome could not be dropped: ${String(e).slice(0, 120)}`
            );
          }
          continue;
        }
        try {
          // Clears the recipient once the server answered (`consumeOwedWelcome`), unpersisted.
          await this.sendWelcomeConsuming(
            w.welcome,
            device.userId,
            w.groupId,
            device.deviceId,
            ratchetTree,
            false
          );
          changed = true;
          console.log(
            `[COMMIT] ${short}... owed Welcome of an Add delivered to ${device.deviceId}`
          );
        } catch (e) {
          // Terminal: already dropped from the state, and said why.
          if (isTerminalWelcomeRefusal(e)) {
            changed = true;
            continue;
          }
          console.error(
            `[COMMIT] ${short}... owed Welcome of an Add NOT delivered to ${device.deviceId} - ` +
              `still owed, sent again at the next connection: ${String(e).slice(0, 120)}`
          );
        }
      }
    }
    if (changed) scheduleOutboundMlsPersist();
  }

  /**
   * See {@link IMlsService.settleUnresolvedCommits}. Takes the MLS lock and the epoch-advance barrier
   * per group, then awaits a checkpoint when any group's state moved.
   */
  async settleUnresolvedCommits(groupIds?: string[]): Promise<void> {
    // A Welcome a previous settlement owed and did not get out (a reload, a failed send) goes first.
    if (!groupIds) await this.deliverOwedWelcomes();
    // READ AND INDEXED UNDER THE LOCK every settlement and every stage takes: a read made outside it
    // and assigned after its await could re-index a group a concurrent settle had just merged, or
    // drop one a concurrent commit had just staged.
    const all = await this.runUnderMlsLock(async () => {
      const groups = await this.groupsWithPendingCommit();
      this.unresolvedGroups = new Set(groups);
      return groups;
    });
    const pending = all.filter((g) => !groupIds || groupIds.includes(g));
    if (!groupIds) this.connectionSettling = true;
    try {
      await this.settleEach(pending);
    } finally {
      if (!groupIds) {
        this.connectionSettling = false;
        this.connectionSettled = true;
      }
      // A CONNECTION'S SETTLEMENT IS WHEN AN INVITATION LOST BEFORE IT IS RE-PLANNED - one a
      // previous session recorded included (`owedInvitations.ts`) - and only AFTER every kept stage
      // was settled: a stage a reload brought back with its entry is refused once more and recorded
      // under the same key, and a drain run before it would re-plan that invitation twice. Not
      // awaited: it takes the lock and the network, and a connection does not wait on an invitation.
      if (!groupIds) this.replanOwedInvitations('connection settled');
    }
  }

  /** Settles each of `pending` under its own lock hold, then awaits one checkpoint if any moved. */
  private async settleEach(pending: string[]): Promise<void> {
    if (pending.length === 0) return;
    console.log(`[COMMIT] settling ${pending.length} staged commit(s) by resubmission`);
    let moved = false;
    for (const groupId of pending) {
      try {
        const outcome = await this.runCommitUnderMlsLock(groupId, () =>
          runAsEpochAdvance(groupId, () =>
            this.settleUnresolvedLocked(groupId, commitLockHoldEndsAt())
          )
        );
        if (outcome === 'merged' || outcome === 'cleared') moved = true;
      } catch (e) {
        console.warn(
          `[COMMIT] ${groupId.slice(0, 8)}... settling the kept commit failed: ${String(e).slice(0, 160)}`
        );
      }
    }
    if (moved) await this.awaitCommitCheckpoint(pending[0], 'the settled commit');
  }

  /**
   * See {@link IMlsService.settleUnresolvedCommitFromLog}. Takes no lock: it is called from inside a
   * commit replay, by whoever holds the client for it.
   */
  async settleUnresolvedCommitFromLog(
    groupId: string,
    commitAtBase: string | null
  ): Promise<'none' | 'merged' | 'cleared' | 'undecided'> {
    if (!(await this.groupsWithPendingCommit()).includes(groupId)) return 'none';
    const short = groupId.slice(0, 8);
    const read = await this.pendingSubmission(groupId);
    const submission = read.status === 'recorded' ? composeSubmission(read.record) : null;
    if (read.status !== 'none' && !submission) {
      this.escalateUnreadableSubmission(groupId);
      return 'undecided';
    }
    if (submission && commitAtBase === null) return 'undecided';
    this.unresolvedGroups?.delete(groupId);
    if (submission && commitAtBase === submission.commit) {
      await this.mergeSettled(submission);
      return 'merged';
    }
    // Another device's commit holds the epoch, or ours was never sent: either way it did not land.
    // The first is the race, and an invitation it carried is recorded before the clear erases it.
    const owed =
      submission !== null &&
      this.oweLostInvitation(read.status === 'recorded' ? read.record : null, submission, 'race');
    await this.clearPendingCommit(groupId).catch((e: unknown) =>
      console.warn(`[COMMIT] ${short}... could not clear the lost commit: ${String(e)}`)
    );
    console.log(
      `[COMMIT] ${short}... the kept commit: ${submission ? "another device's commit holds its epoch" : 'never sent'} - cleared`
    );
    // Called from inside a replay, under its caller's lock: never awaited.
    if (owed) this.replanOwedInvitations('a kept commit lost to the log');
    return 'cleared';
  }

  /**
   * Enters the recovery ladder from the WRITE side, on a commit the server refused because our base
   * epoch is behind its active one.
   *
   * **THE LADDER HAD EXACTLY ONE ENTRANCE, AND IT WAS THE READ SIDE.** Both rungs - the
   * non-destructive {@link attemptCommitReplay}, then the forget + re-Welcome - are reached from
   * `setupMessageHandler`, when a frame arrives this device cannot decrypt. So a device that is
   * behind but receives nothing never enters it, and the retry the rejection above is designed for
   * rests on a premise nothing establishes: that the commit we missed reaches us on its own. On a
   * quiet conversation it never does, because the only traffic left is our own refused commits.
   *
   * The refusal carries the server's `activeEpoch`, so being behind is KNOWN here rather than
   * inferred, and re-applying the commits we missed is what makes the caller's next retry the one
   * the design already expects to succeed. When rung 1 cannot close the gap - commits pruned below
   * the log floor, or one that will not apply - the group is left in the epoch-gap registry, whose
   * owner is the sync watchdog: it escalates to rung 2, and freezing the outbox until it does keeps
   * a stale-epoch ciphertext off the wire.
   *
   * No rung, no cadence and no escalation is added here. This is the entrance the write side never
   * had, and the ladder behind it is the one the read side has always used.
   *
   * @param baseEpoch - the epoch we staged the commit on, i.e. our local epoch.
   * @param activeEpoch - the server's own epoch, absent when it refused for any other reason.
   * @param reason - the gate's refusal reason; `concurrent_commit` is read below.
   */
  private async catchUpOnRefusedCommit(
    groupId: string,
    baseEpoch: number,
    activeEpoch: number | undefined,
    reason?: string
  ): Promise<void> {
    const short = groupId.slice(0, 8);
    const log = (msg: string) => console.log(msg);
    // A `concurrent_commit` REPORTS THE EPOCH IT READ WHILE ANOTHER COMMIT HELD THE GATE'S LOCK, so
    // "not ahead" there is not an answer: the lock holder may have landed a moment after that read
    // (CC-4, 2026-10-25: a leaf refresh accepted at epoch 3, the Add beside it refused with
    // `currentEpoch=2`, nothing rebuilt, the Add lost). The log is read ONCE, here, under the lock:
    // a landed winner is applied, so the caller sees the epoch MOVE - the proof its rebuild needs
    // (`rebuildableRefusal`) - and a winner not landed leaves the epoch where it was, so the caller
    // surfaces the refusal instead. No gap is marked unless the log itself shows the server ahead.
    //
    // ONE `[COMMIT]` LINE, NEVER A `[GAP]` ONE: this read is part of an ordinary race, and the replay's
    // own narration (`[GAP] ... healed=false (nothing to replay ...)` on every refusal whose winner had
    // not landed) named a gap that was never there - noise the GAP rows assert the absence of. Its
    // lines are kept and carried, as detail, only when the log really shows the server ahead.
    if (reason === 'concurrent_commit' && (activeEpoch === undefined || activeEpoch <= baseEpoch)) {
      const detail: string[] = [];
      try {
        // The same books as every rung-1 replay (`replayAndRecord`), its narration kept quiet.
        const replay = await replayAndRecord(
          this,
          groupId,
          this.userId,
          (msg) => detail.push(msg),
          {
            persist: scheduleOutboundMlsPersist,
            refusedBacklog: 'hold',
          }
        );
        if (replay.heldBehindRefusedBacklog) {
          log(
            `[COMMIT] ${short}... refused concurrent_commit at epoch ${baseEpoch}: frames refused for lack of a row are still queued - no replay past them, nothing to rebuild on`
          );
          return;
        }
        const now = this.getEpoch(groupId);
        if (!replay.healed && (replay.activeEpoch ?? 0) > now) {
          markEpochGap(groupId);
          console.warn(
            `[COMMIT] ${short}... refused concurrent_commit at epoch ${baseEpoch}: the commit log is ahead (${replay.activeEpoch}) and could not be applied (now ${now}) - left to the sync watchdog: ${detail.join(' | ').slice(0, 240)}`
          );
          return;
        }
        log(
          `[COMMIT] ${short}... refused concurrent_commit at epoch ${baseEpoch}: read the commit log, ${replay.applied} commit(s) applied, now epoch ${now}`
        );
      } catch (e) {
        console.warn(
          `[COMMIT] ${short}... refused concurrent_commit at epoch ${baseEpoch}: the commit log could not be read - nothing to rebuild on: ${String(e).slice(0, 120)}`
        );
      }
      return;
    }
    // The EPOCHS decide, not the reason string: a refusal that does not report a server epoch ahead
    // of ours says nothing about a gap, and re-applying commits would answer a question nobody asked.
    if (activeEpoch === undefined || activeEpoch <= baseEpoch) return;

    log(`[GAP] commit refused on ${short}: we are at ${baseEpoch}, the server at ${activeEpoch}`);
    markEpochGap(groupId);
    let exhausted: string | undefined;
    try {
      // Persisted on any applied commit, un-marked on a heal, held behind a refused backlog
      // (`replayAndRecord`): the frames that backlog holds would not survive a replay past them,
      // and they bring the missing commits themselves.
      const replay = await replayAndRecord(this, groupId, this.userId, log, {
        persist: scheduleOutboundMlsPersist,
        refusedBacklog: 'hold',
      });
      if (replay.healed) return;
      if (replay.heldBehindRefusedBacklog) {
        log(
          `[GAP] ${short} not replayed: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked`
        );
        return;
      }
      // "Still behind" merges two futures: one where the next frame closes the gap, and one where
      // NOTHING ever does because the server has no commits to give. The escalation still belongs
      // to the watchdog - deliberately, see above - but the line must say which of the two this is,
      // or a log read cannot tell a transient lag from a permanently holed log.
      if (replay.belowFloor) exhausted = 'the commits are pruned below the log floor';
      else if (replay.gapAt !== undefined) {
        exhausted = `the commit log is HOLED at epoch ${replay.gapAt} and can never be refilled`;
      }
    } catch (e) {
      // Swallowed on purpose - the caller is about to throw the refusal, which is the outcome that
      // matters - but never silently: this is the branch that leaves the group to rung 2.
      console.warn(`[GAP] replay error for ${short} after a refused commit:`, e);
    }
    log(
      exhausted
        ? `[GAP] ${short} cannot be caught up by replay - ${exhausted}; rung 2 is OWED, not merely possible (waiting on the sync watchdog)`
        : `[GAP] ${short} still behind after rung 1 - left to the sync watchdog for rung 2`
    );
  }

  /**
   * Declares `groupId` to be the Graine key-distribution group of `scope`.
   *
   * Called once the client has learned the pair from social-service. From here on, every decision
   * that differs for this group - where its external-join base lives, and that its frames are seeds
   * rather than a conversation - is taken from THIS fact rather than rediscovered.
   */
  registerDistributionGroup(scope: DistributionScope, groupId: string): void {
    const previous = this.distributionScopeByGroup.get(groupId);
    this.distributionScopeByGroup.set(groupId, scope);
    this.knownDistributionGroups.add(groupId);
    this.openAdmissionOfKeyGroup(groupId);
    // Written only when it is NEWS: the community loop re-registers every group on every load, and
    // a row restored by `hydrateDistributionGroups` already says exactly this.
    if (previous === undefined || !sameScope(previous, scope)) {
      this.persistDistributionGroup(scope, groupId);
    }
    this.collectFramesLeftForKeyGroup(groupId);
  }

  /**
   * Records that `groupId` IS a distribution group, without claiming to know whose.
   *
   * The server's answer for a salon's group whose community this session has not loaded. Naming the
   * scope has to wait for that load; being right about what the group is must not.
   *
   * Not persisted: a row that cannot name the roster cannot route a seed either, and the
   * registration that names it writes the row.
   */
  noteDistributionGroup(groupId: string): void {
    this.knownDistributionGroups.add(groupId);
    this.openAdmissionOfKeyGroup(groupId);
    this.collectFramesLeftForKeyGroup(groupId);
  }

  /**
   * Classifies a key-distribution group as OPEN for the admission rule: its members enter by
   * external commit by design, and a group a conversation's rule closed would refuse every newcomer
   * of a community. Called wherever this session learns a group IS a key group, which is always
   * BEFORE it is joined or created (the registration precedes both), and keyed by group id so it
   * stands whether or not the group is held yet.
   *
   * Never throws: a failure leaves the group unclassified, which merges its external commits exactly
   * as before - the safe side - and is said at WARN because the rule then does not apply to it.
   */
  private openAdmissionOfKeyGroup(groupId: string): void {
    void this.setAdmissionPolicy(groupId, 'open').catch((e: unknown) => {
      console.warn(
        `[ADMISSION] key group ${groupId.slice(0, 8)}... could not be classified open (it stays unclassified): ${String(e)}`
      );
    });
  }

  /**
   * Re-fetches whatever the handler refused for `groupId` before this session knew what it was.
   *
   * THE EVENT THAT MAKES THOSE FRAMES READABLE IS THIS ONE, and nothing listened to it. A frame on a
   * key group that arrives before the group is identified takes the conversation path and is left
   * as `absent-conversation` - whose only other discharge is a conversation appearing, which for a
   * key group never happens. Measured on production 2026-09-28: 51 frames refused on every load of
   * one device, 8 epochs of commits among them, and a salon blank on that device for a day.
   *
   * Once the scope is named, a frame left as `unscoped-distribution-group` is collectable too.
   *
   * A FALLBACK IS A SIGNAL. For a group this device HELD AT START-UP the stored registry should have
   * named it before the drain (`hydrateDistributionGroups`), so reaching this with frames to collect
   * means the durable half failed - said at a level that accuses. For a group first joined in this
   * session it is the ordinary order of events.
   */
  private collectFramesLeftForKeyGroup(groupId: string): void {
    const short = groupId.slice(0, 8);
    const reasons: UnackedReason[] = this.distributionScopeByGroup.has(groupId)
      ? ['absent-conversation', 'unscoped-distribution-group']
      : ['absent-conversation'];
    const collected = this.refetchFramesLeftBehind(
      reasons,
      `key group ${short}... identified`,
      groupId
    );
    if (collected && this.heldAtHydration.has(groupId)) {
      console.warn(
        `[GRAINE] key group ${short}... was held at start-up and the stored registry did not name it ` +
          '- its frames took the conversation path and were refused until now. Its row is written ' +
          'by this registration; a second load that prints this line means the row did not land'
      );
    }
  }

  /** Wires the durable half of the key-distribution registry. See `IMlsService`. */
  setDistributionGroupStore(store: DistributionGroupStore | null): void {
    this.distributionGroupStore = store;
    if (store === null) this.heldAtHydration.clear();
  }

  /** @inheritdoc */
  async hydrateDistributionGroups(): Promise<void> {
    const store = this.distributionGroupStore;
    if (!store) {
      // Every key group's backlog would then be refused until the community loop names it - the
      // exact defect this method exists to close, so it is never a quiet no-op.
      console.error(
        '[GRAINE] key-group registry not restored - no store wired; every key-group backlog is refused until its community loads'
      );
      return;
    }
    // A DELETION GATED ON KNOWING: below, a row whose group is not in `getLocalGroups()` is deleted
    // for good. An empty cache that was never filled (the listing failed, or - before 2026-10-16 -
    // the login after a PIN recovery, which skipped it) made every row look stale: iPhone 12,
    // `[GRAINE] ... 0 group(s), 1 row(s) for groups no longer held deleted`, and the community's key
    // group failed after it. Without the listing, nothing is restored and nothing is deleted.
    if (!this.heldGroupsKnown()) {
      console.error(
        '[GRAINE] key-group registry not restored - the held groups were never listed, so no row can be judged stale; nothing deleted'
      );
      return;
    }
    this.heldAtHydration.clear();
    for (const groupId of this.getLocalGroups()) this.heldAtHydration.add(groupId);

    let rows: Awaited<ReturnType<DistributionGroupStore['getDistributionGroups']>>;
    try {
      rows = await store.getDistributionGroups();
    } catch (e) {
      console.error(
        '[GRAINE] key-group registry unreadable - every key-group backlog is refused until its community loads:',
        String(e)
      );
      return;
    }

    let restored = 0;
    const stale: string[] = [];
    for (const row of rows) {
      // THE ALLOWLIST IS THE LOCAL MLS STATE. A row names a group; only a held tree makes routing
      // a frame to it meaningful, so a row outliving its tree is deleted rather than believed.
      if (!holdsGroupState(this, row.groupId)) {
        stale.push(row.groupId);
        continue;
      }
      const scope =
        row.channelId === null
          ? workspaceScope(row.workspaceId)
          : channelScope(row.workspaceId, row.channelId);
      this.distributionScopeByGroup.set(row.groupId, scope);
      this.knownDistributionGroups.add(row.groupId);
      restored++;
    }
    for (const groupId of stale) {
      await store.deleteDistributionGroup(groupId).catch((e: unknown) => {
        console.warn(
          `[GRAINE] could not delete the stale key-group row ${groupId.slice(0, 8)}... - it is re-checked on the next start-up:`,
          String(e)
        );
      });
    }
    console.log(
      `[GRAINE] key-group registry restored before the drain - ${restored} group(s)` +
        (stale.length > 0 ? `, ${stale.length} row(s) for groups no longer held deleted` : '')
    );
  }

  /** @inheritdoc */
  whenInitialDrainSettled(): Promise<void> {
    return this.initialDrain;
  }

  /** @inheritdoc */
  verifyDistributionEpoch(
    groupId: string,
    activeEpoch: number
  ): Promise<'current' | DistributionGapVerdict> {
    const short = groupId.slice(0, 8);
    const check = (async (): Promise<'current' | DistributionGapVerdict> => {
      // AFTER THE DRAIN, BECAUSE BEFORE IT "BEHIND" IS NOT A FACT. The server's epoch was read while
      // this device's own queue may still hold every commit it is missing - production 2026-09-28
      // held eight - and those apply in order with their seeds between them. Replaying from the log
      // first would jump past the epochs those seeds were sealed at, and `max_past_epochs` is 2.
      await this.initialDrain;
      await this.waitForGroupQueueIdle('key-group epoch check', groupId).catch(() => {});
      const local = this.getEpoch(groupId);
      if (local >= activeEpoch) return 'current';
      // A PROOF, AND SAID AS ONE: the drain has settled and the group is still short of an epoch the
      // server named before it began, so its commits were never queued to this device. A commit
      // still on the wire can make this line wrong by one epoch; the replay below is then a no-op
      // that costs one read, never a state.
      console.warn(
        `[GRAINE] key group ${short}... is at epoch ${local} after the drain and the server at ${activeEpoch} - ` +
          'its missing commits were never queued to this device; replaying them from the commit log'
      );
      return this.catchUpDistributionGroup(groupId, activeEpoch);
    })().catch((e: unknown): DistributionGapVerdict => {
      console.error(`[GRAINE] epoch check of key group ${short}... failed:`, String(e));
      return 'replay-failed';
    });
    this.distributionEpochChecks.set(groupId, check);
    void check.then(() => {
      if (this.distributionEpochChecks.get(groupId) === check) {
        this.distributionEpochChecks.delete(groupId);
      }
    });
    return check;
  }

  /** @inheritdoc */
  async whenDistributionEpochSettled(groupId: string): Promise<void> {
    await this.initialDrain;
    await this.distributionEpochChecks.get(groupId);
  }

  /** @inheritdoc */
  onDistributionGapVerdict(listener: DistributionGapListener | null): void {
    this.distributionGapListener = listener;
  }

  /**
   * Rung 1 for a key group known to be BEHIND `target`: replay the missing commits from the log.
   *
   * THE GAP IS ARMED FOR THE WHOLE CATCH-UP, and that is the half of this that protects the other
   * members: `distributionEpochFor` answers null while it is, so no seed and no request is sealed at
   * an epoch the group is about to leave. Production 2026-09-28: this device's requests went out at
   * epoch 5 to members all at 13, and not one of them could read them. The verdict reaches the
   * wired listener, which owns rung 2.
   */
  private async catchUpDistributionGroup(
    groupId: string,
    target: number
  ): Promise<DistributionGapVerdict> {
    const short = groupId.slice(0, 8);
    const log = (msg: string) => console.log(msg);
    markEpochGap(groupId);
    this.distributionGapTarget.set(
      groupId,
      Math.max(target, this.distributionGapTarget.get(groupId) ?? target)
    );
    let verdict: DistributionGapVerdict = 'replay-failed';
    try {
      const replay = await attemptCommitReplay(this, groupId, this.userId, log);
      // Applied commits moved the epoch whatever verdict follows (caught up, evicted, partial).
      if (replay.applied > 0) scheduleOutboundMlsPersist();
      if (replay.activeEpoch !== undefined) {
        this.distributionGapTarget.set(
          groupId,
          Math.max(replay.activeEpoch, this.distributionGapTarget.get(groupId) ?? 0)
        );
      }
      // EVICTED IS ASKED FIRST: the commit that removes this device's leaf still APPLIES, so a
      // replay can reach its target on it and report `healed` (measured locally 2026-09-29:
      // "replayed 1 commit(s), epoch 24->25, healed=true" on the very commit that evicted it).
      if (!(await this.isGroupActive(groupId))) {
        verdict = 'evicted';
      } else if (this.getEpoch(groupId) >= (this.distributionGapTarget.get(groupId) ?? target)) {
        // Already asked above when commits applied; a second call after the `await` there would
        // split the microtask merge and queue a SECOND full checkpoint.
        if (replay.applied === 0) scheduleOutboundMlsPersist();
        verdict = 'caught-up';
      } else if (replay.belowFloor || replay.gapAt !== undefined) {
        verdict = 'replay-exhausted';
      }
    } catch (e) {
      console.warn(`[GAP] replay error for key group ${short}...:`, String(e));
    }
    if (verdict === 'caught-up') {
      this.closeDistributionGap(groupId);
    } else if (verdict !== 'evicted') {
      log(
        verdict === 'replay-exhausted'
          ? `[GAP] key group ${short}... cannot be caught up by replay - a re-join is OWED now`
          : `[GAP] key group ${short}... still behind after rung 1 - left to the sync watchdog`
      );
    }
    if (verdict === 'evicted') this.tellEvictedOnce(groupId);
    else this.tellDistributionGapVerdict(groupId, verdict);
    return verdict;
  }

  /**
   * Replays the ONE commit a key group is missing next, and says whether it moved.
   *
   * The gap stays armed until the group reaches the SERVER's epoch, whichever path gets it there -
   * this step, or the queued commits it unblocked (`routeDistributionFrame`'s commit branch).
   */
  private async stepDistributionGroup(groupId: string): Promise<boolean> {
    const short = groupId.slice(0, 8);
    const log = (msg: string) => console.log(msg);
    const from = this.getEpoch(groupId);
    markEpochGap(groupId);
    try {
      const replay = await attemptCommitReplay(this, groupId, this.userId, log, from + 1);
      if (replay.activeEpoch !== undefined) {
        this.distributionGapTarget.set(
          groupId,
          Math.max(replay.activeEpoch, this.distributionGapTarget.get(groupId) ?? 0)
        );
      }
      if (replay.applied > 0) scheduleOutboundMlsPersist();
      const closesAt = this.distributionGapTarget.get(groupId);
      // Evicted first, for the reason given in `catchUpDistributionGroup`.
      if (!(await this.isGroupActive(groupId))) {
        this.tellEvictedOnce(groupId);
      } else if (closesAt !== undefined && this.getEpoch(groupId) >= closesAt) {
        this.closeDistributionGap(groupId);
        this.tellDistributionGapVerdict(groupId, 'caught-up');
      } else if (replay.belowFloor || replay.gapAt !== undefined) {
        log(`[GAP] key group ${short}... cannot be caught up by replay - a re-join is OWED now`);
        this.tellDistributionGapVerdict(groupId, 'replay-exhausted');
      }
      return this.getEpoch(groupId) > from;
    } catch (e) {
      console.warn(`[GAP] replay error for key group ${short}...:`, String(e));
      return false;
    }
  }

  /**
   * Tells the listener, ONCE per group until it is forgotten, that this device's own leaf is gone
   * from key group `groupId`. A burst of queued frames is one eviction, not one re-join per frame.
   */
  private tellEvictedOnce(groupId: string): void {
    if (this.evictionTold.has(groupId)) return;
    this.evictionTold.add(groupId);
    console.warn(
      `[GRAINE] this device's leaf is gone from key group ${groupId.slice(0, 8)}... - the loader decides whether a re-join is owed`
    );
    this.tellDistributionGapVerdict(groupId, 'evicted');
  }

  /** Lifts a key group's gap and its target together - never one without the other. */
  private closeDistributionGap(groupId: string): void {
    clearEpochGap(groupId);
    this.distributionGapTarget.delete(groupId);
  }

  /** Hands `verdict` to the wired listener. A listener that throws is logged, never propagated. */
  private tellDistributionGapVerdict(groupId: string, verdict: DistributionGapVerdict): void {
    const short = groupId.slice(0, 8);
    const listener = this.distributionGapListener;
    if (!listener) {
      console.error(
        `[GRAINE] no gap listener wired - key group ${short}... is ${verdict} and nothing acts on it`
      );
      return;
    }
    try {
      listener(groupId, verdict);
    } catch (e) {
      console.error(`[GRAINE] gap listener threw for key group ${short}...:`, String(e));
    }
  }

  /** Writes `groupId`'s registration to the durable store, when one is wired. Best-effort, logged. */
  private persistDistributionGroup(scope: DistributionScope, groupId: string): void {
    const store = this.distributionGroupStore;
    if (!store) return;
    void store
      .saveDistributionGroup({
        groupId,
        workspaceId: scope.workspaceId,
        channelId: scope.kind === 'channel' ? scope.channelId : null,
      })
      .catch((e: unknown) => {
        // Not thrown: the registration in memory holds for this session. What is lost is the NEXT
        // start-up's head start, and that is what the line says.
        console.warn(
          `[GRAINE] key group ${groupId.slice(0, 8)}... registered but not stored - the next start-up will refuse its backlog until its community loads:`,
          String(e)
        );
      });
  }

  /** True when `groupId` carries channel seeds and must never reach the conversation pipeline. */
  isDistributionGroup(groupId: string): boolean {
    return this.knownDistributionGroups.has(groupId);
  }

  /**
   * Whether `groupId`'s external-join base is arbitrated - the question "held locally" cannot answer.
   *
   * True for every group this device did not create in this session: JOINING one means its base was
   * already published, and the publish is the arbitration. False only inside the create window of
   * {@link ensureDistributionGroup}; the reason is on {@link unsettledDistributionGroups}.
   */
  isDistributionBaseSettled(groupId: string): boolean {
    return !this.unsettledDistributionGroups.has(groupId);
  }

  /**
   * Leaves a scope's key-distribution group: the MLS tree AND the registration, together.
   *
   * THE COUNTERPART OF {@link ensureDistributionGroup}, and it did not exist. Nothing removed this
   * group when a community left the device, because the reconciliation sweep destroyed it on the
   * next connection anyway - by accident, and for the wrong reason. Once the sweep correctly keeps
   * it (WP-GRAINE-1), a community left in the morning would still have its seed carrier held at
   * midnight, and every seed sent in it would still arrive.
   *
   * Both halves or neither: forgetting the tree while leaving the registration would leave
   * `distributionGroupFor` naming a group this device no longer holds, which is the exact state
   * `distributionEpochFor` exists to refuse.
   *
   * ASYNC BECAUSE THE DROP IS: dropping local MLS state is one operation
   * ({@link dropGroupState}) and it ends with a durable checkpoint, which is what this used to
   * leave to the caller and what half its callers forgot.
   *
   * @returns the group that was left, or null when this device held none for that community.
   */
  async forgetDistributionGroup(scope: DistributionScope): Promise<string | null> {
    const groupId = this.distributionGroupFor(scope);
    if (!groupId) return null;
    await this.forgetDistributionGroupById(groupId);
    return groupId;
  }

  /**
   * The same, named by the GROUP - for a caller holding the server's answer rather than a scope.
   *
   * IT CANNOT BE EXPRESSED THROUGH THE SCOPE FORM, and that is the whole reason it exists. The
   * scope form resolves the group through `distributionScopeByGroup`, so it forgets only what that
   * registration already names; the state worth forgetting is one where the registration and the
   * held tree have drifted apart, and there the scope form returns null and leaves the tree behind -
   * whereupon {@link ensureDistributionGroup}, which early-returns on the GROUP ID, sees the group
   * still held and joins nothing. Named by the group, both halves go, whatever the registration
   * says.
   *
   * @returns whether this device held anything under that id
   */
  async forgetDistributionGroupById(groupId: string): Promise<boolean> {
    const held = holdsGroupState(this, groupId) || this.knownDistributionGroups.has(groupId);
    if (!held) return false;
    // The eviction belonged to the state being dropped; the next one, if any, is a new fact.
    this.evictionTold.delete(groupId);
    await dropGroupState(this, groupId, {
      reason: 'distribution group left',
      checkpoint: 'awaited',
    });
    this.distributionScopeByGroup.delete(groupId);
    // BOTH, OR THE PREDICATE OUTLIVES THE GROUP: a set entry left behind would go on answering
    // "distribution group" for state this device no longer holds, and the sweep would go on
    // sparing it for ever.
    this.knownDistributionGroups.delete(groupId);
    // The stored row too, for the same reason one start-up later. Hydration would delete it anyway
    // (the tree is gone), so a failure here costs a read, never a mis-routed frame.
    await this.distributionGroupStore?.deleteDistributionGroup(groupId).catch((e: unknown) => {
      console.warn(
        `[GRAINE] key group ${groupId.slice(0, 8)}... forgotten but its row survived - the next start-up deletes it:`,
        String(e)
      );
    });
    return true;
  }

  /**
   * The distribution group registered for `scope`, or null.
   *
   * Scanned rather than kept in a second map on purpose: a reverse index is a second copy of the
   * same fact, and two copies of a fact drift. The population is one entry per community a user
   * belongs to plus one per private salon they may open - dozens at most - so the scan is not worth
   * a consistency risk.
   */
  distributionGroupFor(scope: DistributionScope): string | null {
    const key = scopeKey(scope);
    for (const [groupId, registered] of this.distributionScopeByGroup) {
      if (scopeKey(registered) === key) return groupId;
    }
    return null;
  }

  /**
   * Every scope this device holds a distribution group for.
   *
   * The enumeration a sweep needs: a reconciliation or a forget that could only ask about scopes it
   * already knew would never find the one it had stopped knowing about.
   */
  distributionScopes(): DistributionScope[] {
    return [...this.distributionScopeByGroup.values()];
  }

  /** Wires the social-service transport for distribution-group GroupInfo. Set once, at startup. */
  setDistributionGroupInfoTransport(transport: DistributionGroupInfoTransport | null): void {
    this.distributionGroupInfo = transport;
  }

  /** Wires what decrypted key-distribution frames are handed to. Set once, at startup. */
  onDistributionFrame(handler: DistributionFrameHandler | null): void {
    this.distributionFrameHandler = handler;
  }

  /**
   * Decrypts a frame that arrived on a key-distribution group and hands it to the Graine handler.
   *
   * It never touches a conversation, and it is the reason the pipeline branches on
   * {@link isDistributionGroup} BEFORE anything else: `handleKnownGroup` looks the group up in the
   * conversation map, finds nothing, and returns without acknowledging - so every seed frame would
   * be redelivered for ever while never being read.
   *
   * @returns whether the frame may be acknowledged. A commit is applied and acknowledged with no
   *   handler involvement (it carries no payload); a frame this device cannot yet decrypt is NOT
   *   acknowledged, so the server redelivers it once the join has landed.
   */
  async routeDistributionFrame(
    groupId: string,
    sender: string,
    ciphertext: Uint8Array,
    senderDeviceId?: string
  ): Promise<boolean> {
    const scope = this.distributionScopeByGroup.get(groupId);
    if (scope === undefined) {
      // REACHABLE, AND IT USED TO SAY IT WAS NOT. `isDistributionGroup` is also true for a group the
      // server named as one before this session could name its roster (`noteDistributionGroup` - a
      // salon's group whose community has not loaded). A seed cannot be filed without its
      // community, so the frame waits - but NOTED, so the registration naming the scope collects it;
      // refused bare, it was redelivered on every connection with nothing left to re-fetch it.
      console.warn(
        `[GRAINE] frame for key group ${sanitizeForLog(groupId).slice(0, 8)}... whose roster is not named yet - kept for its registration`
      );
      noteUnackedFrame(groupId, 'unscoped-distribution-group');
      return false;
    }
    const { workspaceId } = scope;

    let plaintext: Uint8Array | null;
    try {
      plaintext = await this.openDistributionFrame(groupId, sender, ciphertext, senderDeviceId);
    } catch (e) {
      // A FRAME FROM AN EPOCH THIS DEVICE HAS NOT REACHED IS THE ONE REFUSAL A REPLAY REPAIRS, and it
      // used to be refused bare: not acknowledged, no gap armed, so nothing caught the group up and
      // every later frame failed the same way - 1984 of them in ten seconds on production
      // 2026-09-28, a group at epoch 4 refusing frames of epochs 6 to 15.
      //
      // ONE COMMIT AT A TIME, re-trying the frame after each: the commits between are usually in
      // this very queue, with seeds sealed at their epochs between them, and only a step as small as
      // the hole lets the queue apply them in order. Bounded by the log - every step applies a
      // commit, or ends the loop.
      if (classifyIncomingDecryptError(e) !== 'epoch-gap') {
        return this.dispositionOfUnreadableFrame(groupId, e);
      }
      plaintext = null;
      let opened = false;
      while (!opened) {
        if (!(await this.stepDistributionGroup(groupId))) return false;
        try {
          plaintext = await this.openDistributionFrame(groupId, sender, ciphertext, senderDeviceId);
          opened = true;
        } catch (again) {
          if (classifyIncomingDecryptError(again) !== 'epoch-gap') {
            return this.dispositionOfUnreadableFrame(groupId, again);
          }
        }
      }
    }

    // A commit: MLS state advanced and there is nothing to hand over. Acknowledged, because
    // replaying it would only be refused.
    //
    // AND IT IS WHAT CLOSES A GAP, exactly as it is for a conversation (`handleKnownGroup` clears
    // the registry on the same fact). This branch did not, and this group reaches no other clearer:
    // the pipeline routes it here BEFORE the two sites that call `clearEpochGap`, so a mark left by
    // a refused commit stood for the rest of the session over state that had long since caught up -
    // holding `anyEpochGapArmed` true, which is what keeps the sync watchdog on its fine tick.
    // Only a commit may do this: an application message that decrypts proves nothing about the
    // epoch, which is why the conversation side clears on `isCommit` and not on a successful read.
    //
    // BUT ONLY AT THE EPOCH THAT CLOSES IT. Eight commits behind, the first used to lift the mark
    // with seven still to come - see {@link distributionGapTarget}.
    if (!plaintext) {
      const closesAt = this.distributionGapTarget.get(groupId);
      if (closesAt === undefined || this.getEpoch(groupId) >= closesAt) {
        const wasArmed = isInEpochGap(groupId);
        this.closeDistributionGap(groupId);
        if (wasArmed) this.tellDistributionGapVerdict(groupId, 'caught-up');
      }
      return true;
    }

    const handler = this.distributionFrameHandler;
    if (!handler) {
      // Not silent, and not acknowledged: the frame is a seed somebody needs, and the ONLY symptom
      // of a handler never wired would otherwise be a community whose history quietly never loads.
      console.error(
        `[GRAINE] no handler wired - dropping a ${plaintext.length}-byte frame from ${sender.slice(0, 8)}... on community ${workspaceId.slice(0, 8)}...`
      );
      return false;
    }

    try {
      await handler({
        scope,
        workspaceId,
        groupId,
        sender,
        plaintext,
        ...(senderDeviceId ? { senderDeviceId } : {}),
      });
    } catch (e) {
      // NOT acknowledged, on purpose: the handler is what STORES a seed, so a throw here means the
      // seed did not land, and acknowledging would drop key material nobody can ask for again.
      // Redelivery is exactly the right outcome - including after a logout, where the session this
      // handler needs is gone by construction.
      //
      // BY CLASS: a handler that could not REACH the server (it asks the delivery service, which got
      // no answer - `DeliveryUnreachableError`) refused nothing about the frame. That is the expected
      // state of an absent link, said as what is owed next; anything else is a defect and accuses.
      if (isTransportFailure(e)) {
        console.warn(
          `[GRAINE] frame from ${sender.slice(0, 8)} on community ${workspaceId.slice(0, 8)} not handled - the server got no answer; not acknowledged, so the next pull redelivers it: ${String(e)}`
        );
        return false;
      }
      console.error(
        `[GRAINE] handler refused a frame from ${sender.slice(0, 8)} on community ${workspaceId.slice(0, 8)} - not acknowledged:`,
        String(e)
      );
      return false;
    }
    return true;
  }

  /**
   * Decrypts one key-group frame and records the generation it spent. Throws what MLS threw.
   *
   * `senderDeviceId` is the envelope's device claim: handed to the sender check, a frame whose
   * device disagrees with the credential is refused like a user mismatch (`[SENDER_MISMATCH]
   * path=distribution kind=device`), so a device cannot speak in a sibling's name.
   */
  private async openDistributionFrame(
    groupId: string,
    sender: string,
    ciphertext: Uint8Array,
    senderDeviceId?: string
  ): Promise<Uint8Array | null> {
    let plaintext: Uint8Array | null;
    try {
      // A key-group frame relays no history, so its author verdict has no use here.
      plaintext =
        (
          await this.processIncomingMessage(groupId, ciphertext, {
            userId: sender,
            ...(senderDeviceId ? { deviceId: senderDeviceId } : {}),
            path: 'distribution',
          })
        )?.plaintext ?? null;
    } catch (e) {
      // REFUSED FOR ITS SENDER, BUT DECRYPTED: the generation is spent all the same (WP-G2-1b).
      if (e instanceof SenderMismatchError) {
        noteFrameConsumed(this.userId, groupId, ciphertext);
        noteInboundMlsFrame(false);
      }
      throw e;
    }
    // A key-group commit (null plaintext) is structural, and a seed or application frame spends a
    // generation: neither goes through the conversation path, so the persister is told here or a
    // live drain of them would look receive-only and empty to the measurement switch.
    noteInboundMlsFrame(plaintext === null);
    // A DISTRIBUTION FRAME SPENDS A GENERATION LIKE ANY OTHER, so it is recorded like any other.
    // This group's frames are not what a conversation replay walks, so the mark is cheap insurance
    // rather than a known fix - and the direction it can be wrong in is the safe one: a recorded
    // consumption can only ever prevent a false claim of loss about bytes this device really did
    // read. Not recording is what cost TAB-3b its accusations. See {@link noteFrameConsumed}.
    noteFrameConsumed(this.userId, groupId, ciphertext);
    return plaintext;
  }

  /**
   * Whether a key-group frame this device could not open may be acknowledged.
   *
   * @returns true for a frame no redelivery can ever make readable, false for one a later epoch may.
   */
  private dispositionOfUnreadableFrame(groupId: string, e: unknown): boolean {
    // WHY THIS ASKS WHICH FAILURE IT WAS. Refusing to acknowledge is right for a frame that may
    // still become readable - the join has not landed, a commit is missing - and it is an
    // INFINITE REDELIVERY LOOP for one that never will. This branch used to refuse them all, so
    // a device's own seeds (`CannotDecryptOwnMessage`) and every seed overtaken by a commit came
    // back on every single connection, for ever: 6 frames re-read ten times per boot, measured on
    // prod 2026-08-19 while WP-GRAINE-1 was moving the epoch under them.
    //
    // The permanence is decided at the throw, by `classifyIncomingDecryptError`, and never by
    // re-reading a sentence here.
    const kind = classifyIncomingDecryptError(e);
    // A FRAME WHOSE ENVELOPE LIED ABOUT ITS SENDER (WP-G2-1b) is acknowledged and never handed to
    // the seed handler: redelivery would bring back the same lie. `assertVerifiedSender` already
    // accused it at ERROR, so the "comes back through a history request" line below would only be
    // a second, wrong, account of it.
    if (kind === 'sender-mismatch') return true;
    const permanent =
      kind === 'own-message' ||
      kind === 'secret-reuse' ||
      kind === 'past-epoch-application' ||
      kind === 'generation-gap' ||
      // Refused at exactly the epoch it names, which no later arrival changes. THIS IS THE ARM
      // THE LIST ABOVE WAS MISSING: those four name a ratchet position, and everything else fell
      // through to `unknown` and was refused an ACK on the argument that it might still become
      // readable - true of a frame from an epoch we have not reached, false of one already
      // compared against ours. On prod 2026-08-26 that was a single `InvalidSignature` at
      // epoch 0 on two distribution groups, handed back on every connection for ever and
      // dirtying eleven cells of the COMM rung by itself.
      kind === 'same-epoch-refusal' ||
      // Removed from the distribution group: the frame is unreadable to THIS state for good. What
      // is NOT permanent is the removal itself - see the arm below.
      kind === 'evicted';
    if (kind === 'evicted') {
      // A KEY GROUP IS NOT A CONVERSATION ONE WAS REMOVED FROM. Nobody removes a device from a
      // community's key group while its roster still names it - but OpenMLS does, on its own: an
      // external join commits a Remove of every leaf carrying the joiner's signature key, so a
      // device that joins twice with one key pair evicts its own first leaf, and the state that
      // survived on disk may be that first one. Production 2026-09-28: the user's PC, removed so by
      // its own second join on 2026-09-25, acknowledged every frame of Mineurchestre's key group as
      // "no repair is owed" for three days. Whether a re-join is owed is the SERVER's answer, which
      // only the loader reads - so this tells the fact, once, and the listener asks.
      this.tellEvictedOnce(groupId);
    }
    if (permanent) {
      // COUNTED for the seed requests that follow, which print it (`keyGroupFrameLosses`). A
      // device's own frame is not a loss: there was never anything for it to read.
      if (kind !== 'own-message') noteKeyGroupFrameLost(groupId, kind);
      // ACKNOWLEDGED, and said once. The seed is gone from THIS device for good; what recovers it
      // is a peer answering `requestCommunityHistory`, never the server handing the same
      // undecryptable bytes back. Leaving it queued would cost the line above on every boot and
      // hide the next real refusal underneath it.
      console.warn(
        `[GRAINE] frame on ${groupId.slice(0, 8)}... is unreadable for good (${kind}) - acknowledged; its seed comes back through a history request, not a redelivery`
      );
      return true;
    }
    console.warn(
      `[GRAINE] undecryptable frame on ${groupId.slice(0, 8)}... - not acknowledged (${kind}):`,
      String(e).slice(0, 120)
    );
    return false;
  }

  /**
   * THE ONE PLACE that decides where a group's external-join base lives.
   *
   * Both callers below need the same answer, and a group cannot change kind, so the decision is made
   * once from a fact already registered rather than re-derived at each call site - which is the shape
   * of rule the next call site forgets.
   *
   * A group registered as a distribution group with no transport wired is a WIRING BUG, and it
   * throws: routing it to chat-delivery instead would produce a 403 that reads like a permission
   * problem and send the next reader to entirely the wrong place.
   */
  protected groupInfoChannel(groupId: string): {
    /** `seat` is served by a key group's transport only - see {@link DistributionSeat}. */
    fetch(): Promise<{
      groupInfo: string;
      baseEpoch: number;
      activeEpoch: number;
      seat?: DistributionSeat;
    } | null>;
    publish(groupInfoBase64: string, baseEpoch: number): Promise<{ stored: boolean }>;
  } {
    const scope = this.distributionScopeByGroup.get(groupId);
    if (scope === undefined) {
      // A KEY GROUP THE SERVER NAMED BUT NO SCOPE YET ADDRESSES (`noteDistributionGroup`: a salon
      // whose community this session has not loaded) has no base anywhere this device can reach.
      // chat-delivery would answer 403, which reads as "not a member" - the one refusal a caller
      // treats as final. So it is refused HERE, as what it is; the community load registers the
      // scope, and every caller retries through it. No caller is known to reach this (every gap,
      // join and publish on a key group starts from a scope), and that is why it throws.
      if (this.knownDistributionGroups.has(groupId)) {
        throw new Error(
          `[MLS] key group ${groupId.slice(0, 8)}... has no scope yet - its base is not addressable until its community loads`
        );
      }
      return {
        fetch: () => this.delivery.fetchGroupInfo(groupId),
        publish: (gi, epoch) => this.delivery.storeGroupInfo(groupId, gi, epoch),
      };
    }
    const transport = this.distributionGroupInfo;
    if (!transport) {
      throw new Error(
        `[MLS] no distribution GroupInfo transport wired - group ${groupId.slice(0, 8)}... belongs to ${scopeLabel(scope)}`
      );
    }
    return {
      fetch: () => transport.fetch(scope, this.deviceId),
      publish: (gi, epoch) => transport.publish(scope, gi, epoch, this.deviceId),
    };
  }

  /**
   * THE BASE AND THE EPOCH IT BELONGS TO, READ AS ONE ACT. The caller MUST hold the MLS lock.
   *
   * `exportGroupInfo` awaits - an IPC round trip on Tauri - so a commit landing while it is in
   * flight moves the epoch under it: the blob is the tree at N and the number read afterwards is
   * N+1. That pair is not a transient error. The stored base is STRICTLY monotonic, so epoch N+1 is
   * then OWNED by a base that is actually N, the real N+1 base is refused for ever, and every
   * stateless joiner builds an external commit the gate cannot accept. {@link externalJoin} has
   * always guarded it - "a blob exported at any other epoch than the one the server will record it
   * under would strand the group for good" - by exporting inside the lock its own commit holds. The
   * other two publishers read the two halves separately, and outside any lock.
   *
   * The equality check is this function's self-check on the lock: under it nothing else can move the
   * epoch, so a difference means the lock was NOT held, and the answer is to fail loudly rather than
   * publish a pair nothing can walk back.
   */
  protected async exportBaseForPublication(
    groupId: string
  ): Promise<{ base: string; baseEpoch: number }> {
    const before = this.getEpoch(groupId);
    const base = toBase64(await this.exportGroupInfo(groupId));
    const after = this.getEpoch(groupId);
    if (before !== after) {
      throw new Error(
        `the epoch moved ${before} -> ${after} while exporting the base for ${groupId.slice(0, 8)}...`
      );
    }
    return { base, baseEpoch: after };
  }

  /**
   * PUBLISHES THIS DEVICE'S TREE AS THE GROUP'S EXTERNAL-JOIN BASE - the one publisher.
   *
   * The export happens under the MLS lock and the round trip does NOT: holding the mutex across a
   * network call would stall every send and every commit for its duration, and a base published one
   * epoch BEHIND the group is the harmless direction - the monotonic rule refuses it
   * (`stored: false`) and the commit that moved the epoch publishes its own. Only a base labelled
   * AHEAD of what it contains is unrecoverable, and that is what the lock prevents.
   *
   * @returns whether the server took it, and the epoch it was published under - which is the only
   *   epoch a caller may report, a later {@link getEpoch} being a different question.
   */
  protected async publishCurrentBase(
    groupId: string
  ): Promise<{ stored: boolean; baseEpoch: number }> {
    const { base, baseEpoch } = await this.runUnderMlsLock(() =>
      this.exportBaseForPublication(groupId)
    );
    const { stored } = await this.groupInfoChannel(groupId).publish(base, baseEpoch);
    return { stored, baseEpoch };
  }

  /**
   * Exports the current GroupInfo and pushes it to the delivery service (external-join base, Phase 4)
   * so an authorized member lacking MLS state can self-join at the current epoch.
   *
   * NO LONGER CALLED AFTER A COMMIT: every commit this device makes - staged or external - carries
   * the base for the epoch it creates inside its own submission (COMM-22). What remains is the
   * HOLDER REPAIR (`republishBaseIfStale`, `base_refresh_request`), for a base behind for any other
   * cause. NEVER THROWS, and a loss here is not momentary: nothing else publishes a base, so a
   * refresh lost leaves the published one behind until some holder repairs it; the strict gate
   * refuses every external commit built on it meanwhile, and a distribution group has no
   * peer-Welcome fallback. The repair is `republishStaleBase` in
   * [distributionGroup](../utils/graine/distributionGroup.ts), driven by any HOLDER's ordinary read.
   */
  async refreshGroupInfo(groupId: string): Promise<{ stored: boolean; baseEpoch: number } | null> {
    try {
      return await this.publishCurrentBase(groupId);
    } catch (e) {
      console.warn(
        `[MLS] refreshGroupInfo failed for ${groupId.slice(0, 8)}...:`,
        String(e).slice(0, 120)
      );
      return null;
    }
  }

  /**
   * Attempts to (re)join `groupId` via an external commit built from the server-stored GroupInfo,
   * WITHOUT a peer Welcome. This is the self-service recovery seam (Phase 4): a member with no local
   * MLS state fetches the published base, builds an external commit, and submits it under the strict
   * epoch gate (no peer liveness required, which is what makes a distribution group joinable at all).
   *
   * EVERY OUTCOME IS A TYPE, and that is the whole shape of this method. Five different things can
   * stop a join and exactly one of them is worth retrying; flattened into `false` they were
   * indistinguishable to every caller, so the one retry-forever loop was taken for all five.
   *
   * **A stale base is not a race, and no number of attempts wins it.** The gate accepts a base equal
   * to `activeEpoch` and nothing else. That base is published by a follow-up call from the device
   * whose commit was just accepted, and NOTHING else ever mints one - so when that call is lost the
   * two numbers separate for good, and every commit built on the published base is refused, for
   * ever. The server now serves both numbers, so this is READ rather than discovered by submitting:
   * we answer {@link ExternalJoinOutcome} `stale_base` and let a device that HOLDS the tree repair
   * it (see `joinDistributionGroup`). Found on production 2026-08-25, when it cost a private salon
   * its second member: three refusals in one second, the freshly built tree discarded each time, and
   * the same doomed base still being submitted twenty minutes later.
   *
   * **Termination is a proof, not a count.** The bound below only covers `concurrent_commit` - the
   * commit lock being busy, where the base genuinely may move. A refusal whose refetch shows the
   * base behind the group's epoch exits on that fact instead of burning the remaining attempts.
   *
   * THROWS {@link NotAGroupMemberError} when the server says we hold no membership row, and that is
   * the one outcome a caller must not treat as "try again later". A distribution group cannot reach
   * that branch: {@link groupInfoChannel} routes those to their own transport, so a 403 here is
   * always a chat group we are genuinely outside of.
   */
  async externalJoin(
    groupId: string,
    opts: { asAFurtherDevice?: 'ask'; welcomeOwed?: 'ask' } = {}
  ): Promise<ExternalJoinOutcome> {
    // AN EXTERNAL JOIN IS A COMMIT, so a follower tab refuses it as {@link runCommitTransaction}
    // does: the tree it would join into is a copy no disk and no other tab will follow.
    if (getTabLeadership() === 'follower') {
      console.warn(
        `[MLS] externalJoin ${groupId.slice(0, 8)}... refused on a follower tab - only the leader commits`
      );
      throw new FollowerTabCommitError(groupId);
    }
    // ONE JOIN PER GROUP AT A TIME. The wait below can be long, so a second caller (the recovery
    // seam's own cooldown is 60 s) could otherwise start a second join of a group the first is
    // about to hold - the duplicate-leaf race. Sharing the promise gives both the same answer.
    const flights =
      externalJoinFlights.get(this) ?? new Map<string, Promise<ExternalJoinOutcome>>();
    externalJoinFlights.set(this, flights);
    const running = flights.get(groupId);
    if (running) {
      console.log(`[MLS] externalJoin ${groupId.slice(0, 8)}... already in flight - awaiting it`);
      return running;
    }
    const attempt = (async (): Promise<ExternalJoinOutcome> => {
      const short = groupId.slice(0, 8);

      // A DEVICE IS ADDRESSABLE ONLY ONCE ITS KEYPACKAGE IS PUBLISHED, and the commit below is the
      // request that asks the gate to make it so. The gate answers an activation for a device with no
      // static KeyPackage `no_key_package` and writes NO membership row, so a commit that wins the
      // race against the publication leaves a device holding the tree of a group that routes nothing
      // to it - the "holds the group, the group holds no row" repair, and its extra epoch.
      //
      // Measured on production 2026-10-09: all six `[MEMBERSHIP_ACTIVE] REFUSED ... no_key_package`
      // lines of 32 hours, on four community distribution groups and no conversation. Each device's
      // first run logged `[PURGE_PREKEYS]` (the start of its key package round), then this commit and
      // its refusal in the same second, then `[REGISTER_DEVICE] START`. The mint holds the MLS lock
      // only for its own span, so the join took the lock the moment the mint let go and committed one
      // checkpoint and one round trip ahead of the publication. Three of the six healed 2 minutes to
      // 1 h 44 min later, an iPhone among them, and the other three devices no longer exist.
      //
      // WAITS FOR THE PUBLISHED FACT, not for a round: the server's own statement that this device
      // holds a static KeyPackage, read from what the gate reads. A round not started yet, running or
      // ended is one case, and no timer decides it (see {@link awaitOwnKeyPackagePublished}). The
      // earlier version waited on a round already running and left two holes this closes: a join that
      // started BEFORE the round set its field, and a round whose request never answered.
      const publication = await this.awaitOwnKeyPackagePublished(short);
      if (publication === 'round_failed') {
        return { joined: false, reason: 'key_package_round_failed' };
      }
      if (publication === 'unverified') {
        return { joined: false, reason: 'own_key_package_unverified' };
      }
      // READ AFTER THE WAIT: the round can re-enrol the device under a new id (a revoked id), and the
      // gate must exclude the id that actually joins.
      const excludeSelf = [`${this.userId}:${this.deviceId}`];
      for (let attempt = 0; attempt < EXTERNAL_JOIN_MAX_ATTEMPTS; attempt++) {
        // The server already refuses this account's commits for a while: nothing is built, and the
        // caller is told how long (`commitRateLimit.ts`), so a sweep can stop rather than ask again.
        const waitMs = commitRateLimitRemainingMs();
        if (waitMs > 0) {
          console.warn(
            `[MLS] externalJoin ${short}... not attempted - the commit rate limit holds for ${Math.round(waitMs / 1000)} s more`
          );
          return { joined: false, reason: 'rate_limited', retryAfterMs: waitMs };
        }
        // THE REFUSAL HAS TO SURVIVE THIS CATCH, which flattened every outcome into `null` and cost
        // the caller the only discriminator it needed. `NotAGroupMemberError` is the server answering
        // the question recovery is asking; anything else says nothing about membership and leaves the
        // welcome_request fallback the right next move. And it is logged now: this was a swallowed
        // branch on the path a real outage would take.
        const gi = await this.groupInfoChannel(groupId)
          .fetch()
          .catch((e) => {
            if (e instanceof NotAGroupMemberError) throw e;
            console.warn(
              `[MLS] externalJoin GroupInfo fetch failed for ${short}...:`,
              String(e).slice(0, 120)
            );
            return null;
          });
        if (!gi) return { joined: false, reason: 'no_base_published' };

        // NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU. A base behind the group's epoch is
        // refused by the gate with certainty, and the refusal costs a round trip and the tree we would
        // build to make it. Only a member already holding the tree can publish a usable one.
        if (gi.baseEpoch < gi.activeEpoch) {
          console.warn(
            `[MLS] externalJoin STALE base for ${short}... (published ${gi.baseEpoch}, group at ${gi.activeEpoch})` +
              ` - not attempting; a member holding the tree must republish it`
          );
          return {
            joined: false,
            reason: 'stale_base',
            baseEpoch: gi.baseEpoch,
            serverEpoch: gi.activeEpoch,
          };
        }

        // A FURTHER DEVICE OF A MEMBER DOES NOT LET ITSELF INTO A CONVERSATION (2026-10-27), decided
        // on THIS GroupInfo's tree - the one the commit would be built on and every member's verdict
        // reads - so an honest device never makes the entry a member says as nobody's. Read again on
        // every attempt: each one fetched a fresh base.
        if (opts.asAFurtherDevice === 'ask') {
          let further: boolean;
          try {
            further = await this.isFurtherDeviceIn(fromBase64(gi.groupInfo));
          } catch (e) {
            console.warn(
              `[MLS] externalJoin ${short}... the served tree could not be read for the door: ${String(e).slice(0, 120)}`
            );
            return { joined: false, reason: 'build_failed' };
          }
          if (further) {
            console.log(
              `[MLS] externalJoin ${short}... the tree holds this account's other device and not this one - not built, a member's Add is its door`
            );
            return { joined: false, reason: 'further_device' };
          }
        }

        // ONE DOOR AT A TIME, ASKED OF THE BASE IN HAND (key groups, channel-encryption section 20).
        // An admitter's Add writes this device's `pending` seat and stores the base for the epoch it
        // creates in ONE transaction, and holds the add lock until its Welcomes are queued - so the
        // seat the server read AFTER this base, in the same answer, says whether the base already
        // carries our leaf. The caller's own roster read came BEFORE it: on 11 of 11 kept rig
        // consoles (RM-4, RM-4b, RM-5, SALON-REVOKE-COMMIT, 2026-10-25..29) a device whose roster
        // read predated the Add joined on the base the Add stored, the admitter's Welcome then landed
        // on the group that join had just built (`already held - redelivered Welcome ignored`), and
        // the external commit replaced the leaf the Add wrote. One Welcome, never a redelivery - two
        // doors opened on one seat. Served WITH the base: one read, no extra round trip.
        if (opts.welcomeOwed === 'ask') {
          const reading = readWelcomeOwedFromSeat(gi.seat);
          if (reading === null) {
            console.warn(
              `[MLS] externalJoin ${short}... base ${gi.baseEpoch} came without a readable seat (${gi.seat ? 'add lock unread' : 'none served'}) - not built this pass`
            );
            return { joined: false, reason: 'seat_unreadable' };
          }
          if (isWelcomeOwed(reading)) {
            return { joined: false, reason: 'welcome_owed', reading };
          }
        }

        // BUILD THE COMMIT AND THE BASE IT CREATES IN THE SAME BREATH. An external commit is applied
        // to the returned instance at once (unlike a staged add/remove), so this device - and for one
        // moment ONLY this device - can export the GroupInfo for the epoch its own commit produces.
        // That base then travels inside the submission below and is stored with the epoch advance,
        // which is what stops an external joiner from locking the NEXT one out (COMM-22).
        let joined: { groupId: string; commit: Uint8Array; nextBase: string } | 'already-held';
        try {
          joined = await this.runUnderMlsLock(async () => {
            // THE GROUP IS READ AGAIN UNDER THE LOCK, BECAUSE A WELCOME INSTALLS IT UNDER THE SAME
            // LOCK. Everything above ran outside it - a recovery started by one failed Welcome reaches
            // here after a second Welcome for the group may have been applied by the drain - and an
            // external commit built over a held group was refused only AFTER OpenMLS had written it
            // into the live group's storage rows, then read as a failed build that asked a member to
            // re-add a healthy leaf (review of #2466). Held now means joined: nothing to build.
            if (holdsGroupState(this, groupId)) return 'already-held' as const;
            const built = await this.joinByExternalCommit(fromBase64(gi.groupInfo));
            // The same atomic read as every other publisher, under the lock this section already holds.
            const { base, baseEpoch } = await this.exportBaseForPublication(built.groupId);
            // A HARD ERROR, NOT A DEGRADED SUBMISSION, and one step STRONGER than the read above: the
            // published base is monotonic and cannot be walked back, so a blob exported at any other
            // epoch than the one the server will record it under would strand the group for good.
            // Nothing about this can be true and unnoticed: if the instance is not at base + 1 the
            // join is abandoned like any other build failure, and the caller's welcome_request
            // fallback is the right next move.
            if (baseEpoch !== gi.baseEpoch + 1) {
              throw new Error(
                `external join instance at epoch ${baseEpoch}, expected ${gi.baseEpoch + 1}`
              );
            }
            return { ...built, nextBase: base };
          });
        } catch (e) {
          // THE ENGINE'S OWN REFUSAL OF A HELD GROUP (`MlsError::GroupAlreadyHeld`, a token this
          // repository defines) is the same answer as the read above, from the side that cannot be
          // wrong - so it is joined, and the line ACCUSES: reaching it means this service's list of
          // held groups missed one the engine holds, and the read above trusted that list.
          //
          // ONLY FOR THE GROUP ASKED FOR. The refusal names the group the served GroupInfo is for,
          // and a base naming ANOTHER group the engine holds says nothing about this one: that is a
          // base this join cannot use, so it fails the build like any other unusable base.
          const held = /GROUP_ALREADY_HELD: (\S+)/.exec(String(e))?.[1];
          if (held === groupId) {
            console.error(
              `[MLS] externalJoin ${short}... refused by the engine: the group is already held, but this service's list of held groups did not say so - joined, nothing built`
            );
            return { joined: true, alreadyHeld: true };
          }
          if (held !== undefined) {
            console.error(
              `[MLS] externalJoin ${short}... the served base is for another group (${held.slice(0, 8)}...), one this device holds - not joined`
            );
            return { joined: false, reason: 'build_failed' };
          }
          console.warn(`[MLS] externalJoin build failed for ${short}...:`, String(e).slice(0, 120));
          return { joined: false, reason: 'build_failed' };
        }
        if (joined === 'already-held') {
          console.log(
            `[MLS] externalJoin ${short}... the group is already held (a Welcome installed it first) - joined, nothing built`
          );
          return { joined: true, alreadyHeld: true };
        }

        // Submit under the epoch gate against the GroupInfo's base epoch. The server fans the external
        // commit out to existing members (excluding this device, which already applied it).
        let validation: { accepted: boolean; reason?: string; currentEpoch?: number };
        try {
          validation = await this.delivery.submitCommit(
            joined.groupId,
            gi.baseEpoch,
            toBase64(joined.commit),
            excludeSelf,
            joined.nextBase
          );
        } catch (e) {
          // A TRANSPORT FAILURE IS NOT AN ANSWER, and this used to be relabelled an epoch race: the
          // staged commit was discarded, the base refetched, and the whole thing retried against a
          // server that had never been reached. We claim NOTHING about membership here. The group is
          // still dropped, because an external commit cannot be cleared and a pending one left
          // unmerged breaks every later operation on it - and if the server DID accept the commit we
          // never saw acknowledged, its base is now stale and a holder's republish is what fixes it.
          const rateLimited = e instanceof ApiRefusalError && e.status === 429;
          const overtaken = isSeatClaimOvertaken(e);
          await dropGroupState(this, joined.groupId, {
            reason: rateLimited
              ? 'the commit gate refused it under the rate limit'
              : overtaken
                ? 'an unrelated eviction overtook its seat claim'
                : 'the commit gate could not be reached',
            // Built in memory during this very call and never checkpointed: there is nothing
            // durable to undo, and a save here would cost one per failed attempt.
            checkpoint: 'never-persisted',
          });
          // A 429 IS AN ANSWER: the throttler refused before the gate, so nothing was accepted. Its
          // wait is recorded for every commit path and handed to the caller, which stops its sweep.
          if (rateLimited) {
            noteCommitRateLimited(e.retryAfterMs);
            return {
              joined: false,
              reason: 'rate_limited',
              retryAfterMs: commitRateLimitRemainingMs(),
            };
          }
          // A 409 SEAT_CLAIM_OVERTAKEN IS AN ANSWER: nothing advanced, and the next attempt asks
          // for a fresh claim at once. Each refusal proves an eviction landed in between, and the
          // attempt bound still holds against a group evicting without pause.
          if (overtaken) {
            console.warn(
              `[MLS] externalJoin seat claim OVERTAKEN for ${short}... (base ${gi.baseEpoch}) - attempt ${attempt + 1}/${EXTERNAL_JOIN_MAX_ATTEMPTS}`
            );
            if (attempt === EXTERNAL_JOIN_MAX_ATTEMPTS - 1) {
              return {
                joined: false,
                reason: 'refused',
                serverReason: SEAT_CLAIM_OVERTAKEN_REASON,
              };
            }
            continue;
          }
          console.warn(
            `[MLS] externalJoin could not reach the commit gate for ${short}... (base ${gi.baseEpoch}) -` +
              ` nothing is claimed about membership:`,
            String(e).slice(0, 120)
          );
          return { joined: false, reason: 'unreachable' };
        }

        if (validation.accepted) {
          await this.runUnderMlsLock(() => this.mergePendingCommit(joined.groupId));
          // The external commit's path IS this device's new leaf, so the group's periodic refresh is
          // dated from here - not from a ledger entry of an earlier incarnation (`leafRefresh.ts`).
          await this.noteOwnLeafReplaced(joined.groupId, gi.baseEpoch + 1);
          // THE SERVER HAS ALREADY MADE THIS DURABLE FOR EVERYONE ELSE, so this device may not hold
          // its half in RAM. The commit is accepted: the group's epoch has advanced for every other
          // member, and the secrets that make the new epoch usable exist ONLY here, in WASM memory.
          // A reload before the next checkpoint restores a device that is IN the published tree and
          // cannot read a word of it - and, finding no local group, joins again from the new base.
          //
          // THAT SECOND JOIN FORKS THE GROUP. Measured on prod 2026-08-27: a device joined one salon
          // at base 0 and again at base 1 two seconds apart across a navigation, leaving the salon at
          // epoch 2, the granting device stranded at 0 refusing frames it could not read, and the
          // seed that device held undeliverable - a member granted access who can read nothing.
          //
          // `mlsStatePersister` defers routine writes for a reason it states in full: inbound state
          // is replayable from the server, and outbound ratchet state is checkpointed on the send
          // path. AN EXTERNAL JOIN IS NEITHER. Nothing on the server can replay these secrets back,
          // so the structural checkpoint is awaited here, at the point the state moved.
          let checkpointed: boolean;
          try {
            checkpointed = await persistMlsStructuralCheckpoint();
          } catch (e) {
            checkpointed = false;
            console.error(
              `[MLS] externalJoin FAILED to checkpoint ${short}... - a reload before the next write` +
                ` would rejoin and fork the group:`,
              String(e).slice(0, 120)
            );
          }
          // The join stands either way - it is accepted server-side and usable for this session, and
          // refusing it here would discard a membership the rest of the group can already see. What
          // is lost is only its durability, which is why this accuses rather than informs.
          if (!checkpointed) {
            console.error(
              `[MLS] externalJoin for ${short}... was not checkpointed: no persister is registered,` +
                ` so this membership does not survive a reload and the next load will rejoin`
            );
          }
          // NO FOLLOW-UP REFRESH HERE, AND ITS ABSENCE IS THE FIX. The base for the epoch this join
          // created was written in the same transaction as the epoch itself, so there is nothing left
          // to mint and nothing left to lose - which is what a reload used to take with it.
          console.log(
            `[MLS] externalJoin succeeded for ${joined.groupId.slice(0, 8)}... (base epoch ${gi.baseEpoch},` +
              ` base for ${gi.baseEpoch + 1} stored with the commit)`
          );
          return { joined: true };
        }

        // REFUSED, and the server said WHY - both fields used to be dropped and the line called every
        // refusal an epoch race. An external commit cannot be cleared, so the group goes; the next
        // pass re-reads the base and exits on the stale-base fact above if nobody republished.
        await dropGroupState(this, joined.groupId, {
          reason: 'the server refused the external commit',
          // Built in memory during this very call and never checkpointed: there is nothing
          // durable to undo, and a save here would cost one per failed attempt.
          checkpoint: 'never-persisted',
        });
        console.warn(
          `[MLS] externalJoin REFUSED for ${joined.groupId.slice(0, 8)}... (base ${gi.baseEpoch},` +
            ` reason ${validation.reason ?? 'unspecified'}, group at ${validation.currentEpoch ?? '?'})` +
            ` - attempt ${attempt + 1}/${EXTERNAL_JOIN_MAX_ATTEMPTS}`
        );
        if (attempt === EXTERNAL_JOIN_MAX_ATTEMPTS - 1) {
          return {
            joined: false,
            reason: 'refused',
            serverReason: validation.reason ?? 'unspecified',
            ...(validation.currentEpoch !== undefined
              ? { serverEpoch: validation.currentEpoch }
              : {}),
          };
        }
      }
      // Unreachable - the last attempt returns above. Typed rather than asserted.
      return { joined: false, reason: 'refused', serverReason: 'unspecified' };
    })().finally(() => {
      // Identity-checked: a teardown cleared the map and a later join may own the entry by now.
      if (flights.get(groupId) === attempt) flights.delete(groupId);
    });
    flights.set(groupId, attempt);
    return attempt;
  }

  /**
   * Makes this device a member of a community's Graine key-distribution group, whatever state it
   * finds - the "on first use" entry point of WP-22.
   *
   * Three states, and the caller does not have to know which one it is in:
   *  - already held locally: nothing to do;
   *  - a base is published: external-join it, exactly as any other group is rejoined;
   *  - nothing published: this device is the first member in, so it CREATES the MLS group and
   *    publishes the base everyone after it will join from.
   *
   * THE THIRD CASE RACES, AND IS SETTLED WITHOUT AN ELECTION. Two devices can both find the group
   * uninitialised, and both create an MLS group under the same id at epoch 0 - so the monotonic
   * rule cannot separate them, epoch 0 being no newer than epoch 0. What separates them is who won
   * the INSERT, which the server now reports: the loser throws its group away and joins the
   * winner's. No peer has to be online for any of it.
   *
   * DISCARDING THE LOSER COSTS NOTHING ONLY IF NOTHING WAS BUILT ON IT, and this used to claim that
   * outright - "this runs before any seed is sent". It runs before any seed is sent BY THIS CALL;
   * it does not run before any seed is sent AT ALL, and a salon message concurrent with the create
   * window sealed one against the group about to be discarded. The window is now closed rather
   * than asserted away: {@link unsettledDistributionGroups} holds the group for its duration, and
   * `distributionEpochFor` refuses to mint against a group it names.
   *
   * @param ref what social-service answered: the group id, the published base or null, and the
   *   group's real epoch - which the base can be permanently behind (see {@link externalJoin})
   * @returns the outcome, distinguishable: a stale base is not a lost race
   */
  async ensureDistributionGroup(
    scope: DistributionScope,
    ref: {
      groupId: string;
      groupInfo: string | null;
      baseEpoch: number | null;
      activeEpoch: number;
    }
  ): Promise<ExternalJoinOutcome> {
    const { groupId } = ref;
    this.registerDistributionGroup(scope, groupId);

    if (holdsGroupState(this, groupId)) return { joined: true };

    if (ref.groupInfo !== null) {
      return this.externalJoin(groupId, { welcomeOwed: 'ask' });
    }

    console.log(
      `[GRAINE] no base published for ${scopeLabel(scope)} - creating group ${groupId.slice(0, 8)}...`
    );
    // MARKED BEFORE IT EXISTS, so there is no instant at which a sender can find it both held and
    // settled. Cleared in the `finally`, on every branch: a mark outliving its window would strand
    // the scope refusing to send for the rest of the session.
    this.unsettledDistributionGroups.add(groupId);
    try {
      await this.runUnderMlsLock(() => this.createGroup(groupId));

      let published: { stored: boolean };
      try {
        published = await this.publishCurrentBase(groupId);
      } catch (e) {
        // The group exists locally and nobody can join it: that is worse than not having created
        // it, because the next call would find it in `getLocalGroups` and return early for ever.
        await dropGroupState(this, groupId, {
          reason: 'the base could not be published, so nobody could ever join',
          // Built in memory during this very call and never checkpointed: there is nothing
          // durable to undo, and a save here would cost one per failed attempt.
          checkpoint: 'never-persisted',
        });
        console.warn(
          `[GRAINE] publishing the base for ${groupId.slice(0, 8)}... failed - group discarded:`,
          String(e).slice(0, 120)
        );
        return { joined: false, reason: 'unreachable' };
      }

      if (published.stored) return { joined: true };

      // Lost the race: another device published first and its base is what everyone else will join
      // from. Ours would fork the community in two.
      await dropGroupState(this, groupId, {
        reason: 'lost the first-publish race',
        // Built in memory during this very call and never checkpointed: there is nothing
        // durable to undo, and a save here would cost one per failed attempt.
        checkpoint: 'never-persisted',
      });
      console.log(
        `[GRAINE] lost the first-publish race for ${groupId.slice(0, 8)}... - joining the published base instead`
      );
      return this.externalJoin(groupId, { welcomeOwed: 'ask' });
    } finally {
      this.unsettledDistributionGroups.delete(groupId);
    }
  }

  /** Asks the MLS layer whether a package may be added as `identity` - see {@link vetKeyPackage}. */
  protected abstract vetKeyPackageNative(
    keyPackage: Uint8Array,
    identity: string
  ): Promise<KeyPackageVerdict>;
  /** Takes the pending device events from the MLS layer - see {@link takeDeviceEvents}. */
  protected abstract takeDeviceEventsNative(): Promise<DeviceEvent[]>;
  /** Reads the pin of one device from the MLS layer - see {@link pinnedSignatureKeys}. */
  protected abstract pinnedSignatureKeysNative(
    userId: string,
    deviceId: string
  ): Promise<DevicePin | null>;
  /** Reads the recorded departures from the MLS layer - see {@link removalEpochs}. */
  protected abstract removalEpochsNative(groupId: string, userId: string): Promise<number[]>;

  /**
   * What THIS DEVICE has seen of `userId:deviceId`'s signature key in a signed tree it merged or
   * joined (`DevicePin`), or `null` for a device it never saw - THE SINGLE SOURCE OF TRUST for "a key
   * this device has seen" (`MlsManager::pinned_signature_keys`, the device pins).
   *
   * WHY: a verifier of a signature made by a device key (a community admission voucher, a signed
   * history entry) must not take the key from the server, which is the party the signature has to
   * hold against. A pinned key came from a tree whose commits this device verified itself.
   *
   * `null` MEANS UNVERIFIED, NEVER FORGED. Pins are bounded, and past the bound (at load only, never
   * on a heal) the pin of a device no held tree contains any more is dropped, so a device seen once
   * can come back unknown. `anchored: false` MEANS THE SAME FOR A CONTRADICTION: that pin was
   * written after the device's previous pin was pruned, from whatever tree came next, so a signature
   * failing under it is unverified, never forged. Several `keys` come back only for a state seeded
   * from trees that disagreed; a signature verifying under ANY of them was made by a key this device
   * saw for that device. The user half matches case-insensitively and the device half exactly, as
   * the KeyPackage binding reads them. A miss is logged once, in Rust - this per-message path adds
   * no line of its own.
   */
  async pinnedSignatureKeys(userId: string, deviceId: string): Promise<DevicePin | null> {
    return this.pinnedSignatureKeysNative(userId, deviceId);
  }

  /**
   * The epochs at which this device saw `userId` LEAVE `groupId`'s tree - a merged commit removed
   * the user's last leaf; each epoch is the first one the user is no longer in - oldest first.
   *
   * WHY: a verifier that must know whether a user was removed (and when) cannot ask the server, and
   * observing the tree finds a removal only when it happens to look between a kick and a re-add.
   * This is recorded at MERGE time in Rust, in the one place every merged commit passes - live,
   * replayed on catch-up, or our own.
   *
   * TWO PROPERTIES A CALLER RELIES ON: it is PER USER - a single commit that swaps a leaf (a resync,
   * a heal) and the removal of one device among several record nothing, while a kick and a re-add in
   * TWO commits is a departure whatever the kick was for; and it holds only commits THIS device
   * merged - a device that entered the group later knows no departure from before it arrived.
   *
   * AN EMPTY LIST IS "NOT SEEN", NEVER "NEVER HAPPENED": commits merged before this record existed,
   * by a state since lost, before this device joined, or dropped past its bound are absent. Kept in
   * the sealed state; never a device event and never user-visible.
   */
  async removalEpochs(groupId: string, userId: string): Promise<number[]> {
    return this.removalEpochsNative(groupId, userId);
  }

  /**
   * Whether `keyPackage` may be added as the device `userId:deviceId`, WITHOUT staging anything.
   *
   * For the caller that must decide BEFORE a destructive step: the re-add of a device whose leaf is
   * still in the tree removes that leaf first, and a removal made for a replacement the Add then
   * refuses would take the device out of the group for nothing. The Add re-runs the same check in
   * Rust, so this is the same decision taken earlier, never a second policy.
   */
  async vetKeyPackage(
    keyPackage: Uint8Array,
    userId: string,
    deviceId: string
  ): Promise<KeyPackageVerdict> {
    const verdict = await this.vetKeyPackageNative(keyPackage, `${userId}:${deviceId}`);
    console.debug(
      `[TRUST] KeyPackage for ${sanitizeForLog(userId).slice(0, 8)}:${sanitizeForLog(deviceId)} vetted: ${verdict}`
    );
    return verdict;
  }

  /**
   * Every device admission recorded since the last call (`DeviceEvent`), oldest first, and forgets
   * them. Computed in Rust from the signed commits this device merged - never from the server - and
   * kept in the sealed MLS state until taken. The notices take them through
   * {@link setDeviceEventConsumer}; this is the direct read.
   */
  async takeDeviceEvents(): Promise<DeviceEvent[]> {
    return this.takeDeviceEventsNative();
  }

  /** Who the device events go to - the new-device notices (`deviceNotices.svelte.ts`). */
  private deviceEventConsumer: ((events: DeviceEvent[]) => Promise<boolean>) | null = null;
  /** Serialises the hand-overs, so two drains ending together deliver in order. */
  private deviceEventHandOver: Promise<unknown> = Promise.resolve();

  /**
   * Registers the consumer of device events, or removes it (`null`, sign-out). Registering hands it
   * whatever the state already holds - events recorded while nothing listened (a previous session,
   * a background Add written to `mls.bin`) - so the bounded store drains rather than filling.
   */
  setDeviceEventConsumer(consumer: ((events: DeviceEvent[]) => Promise<boolean>) | null): void {
    this.deviceEventConsumer = consumer;
    console.debug(`[TRUST] device-event consumer ${consumer ? 'registered' : 'removed'}`);
    if (consumer) void this.handOverDeviceEvents('consumer registered');
  }

  /**
   * Takes the pending device events and hands them to the consumer - an empty take included, so the
   * consumer retries what it parked. Called when a drain ends (the commits it merged are the usual
   * source), after this device's own Adds and at registration. With no consumer the events stay in
   * the sealed state, untaken, for the next one.
   *
   * A consumer that throws loses the events it was handed - logged at error, since that is a notice
   * the user will never see; the consumer isolates each event itself so one cannot cost the others.
   */
  /** {@link IMlsService.settleDeviceEvents}: one more hand-over, chained after any pending one. */
  settleDeviceEvents(why: string): Promise<boolean> {
    return this.handOverDeviceEvents(why);
  }

  /** @returns whether the events were handed over and decided ({@link settleDeviceEvents}). */
  protected handOverDeviceEvents(why: string): Promise<boolean> {
    const run = this.deviceEventHandOver.then(async (): Promise<boolean> => {
      const consumer = this.deviceEventConsumer;
      if (!consumer) {
        console.debug(`[TRUST] no device-event consumer registered (${why}) - nothing decided`);
        return false;
      }
      let events: DeviceEvent[];
      try {
        events = await this.takeDeviceEventsNative();
      } catch (e) {
        console.error(`[TRUST] device events not taken (${why}) - they stay in the state:`, e);
        return false;
      }
      // AN EMPTY TAKE IS HANDED OVER TOO: the consumer parks an event whose evidence the server did
      // not answer, and each hand-over - registration, every drain end, every own Add - is the
      // durable moment it retries it. Skipping the call would leave it parked on a quiet account.
      if (events.length > 0) {
        console.debug(`[TRUST] ${events.length} device event(s) handed to the notices (${why})`);
      }
      try {
        return await consumer(events);
      } catch (e) {
        console.error(
          `[TRUST] the device-notice consumer failed - ${events.length} event(s) lost:`,
          e
        );
        return false;
      }
    });
    this.deviceEventHandOver = run;
    return run;
  }

  async addMember(
    groupId: string,
    device: { keyPackage: Uint8Array; userId: string; deviceId: string },
    excludeDeviceIds?: string[]
  ): Promise<OneDeviceAddResult> {
    // REFUSED BEFORE THE LOCK, NOT INSIDE IT: a package the binding or the pin refuses would make
    // Rust stage nothing and answer with a sentence; the type is decided here, from the verdict.
    const verdict = await this.vetKeyPackage(device.keyPackage, device.userId, device.deviceId);
    if (!verdictAdmits(verdict) && isDeviceTrustRefusal(verdict)) {
      throw new DeviceTrustRefusedError(verdict, device.userId, device.deviceId);
    }
    const result = await this.runCommitTransaction(
      groupId,
      async (intent) => {
        const staged = await this.stageAddMembers(
          groupId,
          [{ keyPackage: device.keyPackage, identity: `${device.userId}:${device.deviceId}` }],
          intent
        );
        return {
          commit: staged.commit,
          welcome: staged.welcome,
          groupInfo: staged.groupInfo,
        };
      },
      { excludeDeviceIds, exportTree: true }
    );
    // This device's own Add may have given its account - or a contact - a new device.
    void this.handOverDeviceEvents('own add');
    return oneDeviceAddResult(result, device);
  }

  /**
   * Re-adds a device whose leaf is STILL in the tree, removing that leaf and adding the device back
   * from `device.keyPackage` in ONE commit (staged, validated, merged as every commit is - C7-A).
   *
   * WHY ONE COMMIT: a kick and a re-add in two commits leave one epoch where the user is out of the
   * tree, which reads as a departure to every member (`removalEpochs`) - and a server that answers
   * one way could steer an honest member into that shape. One commit has no such epoch. The package
   * is vetted first and a trust refusal throws the typed `DeviceTrustRefusedError`, as `addMember`.
   */
  async replaceMember(
    groupId: string,
    device: { keyPackage: Uint8Array; userId: string; deviceId: string },
    excludeDeviceIds?: string[]
  ): Promise<OneDeviceAddResult> {
    const verdict = await this.vetKeyPackage(device.keyPackage, device.userId, device.deviceId);
    if (!verdictAdmits(verdict) && isDeviceTrustRefusal(verdict)) {
      throw new DeviceTrustRefusedError(verdict, device.userId, device.deviceId);
    }
    console.info(
      `[TRUST] replacing ${sanitizeForLog(device.userId).slice(0, 8)}:${sanitizeForLog(device.deviceId)} in ${groupId.slice(0, 8)}... in one commit`
    );
    const result = await this.runCommitTransaction(
      groupId,
      async (intent) =>
        this.stageReplaceDevice(
          groupId,
          `${device.userId}:${device.deviceId}`,
          device.keyPackage,
          intent
        ),
      { excludeDeviceIds, exportTree: true }
    );
    // As `addMember`: a replaced device under a new key is a device event this commit recorded.
    void this.handOverDeviceEvents('own add');
    return oneDeviceAddResult(result, device);
  }

  async addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string; userId: string }>,
    excludeDeviceIds?: string[],
    invitation?: CommitInvitation,
    beforeStage?: () => Promise<void>
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skipped: SkippedDevice[];
    notAdmitted: RefusedAdmit[];
  }> {
    const result = await this.runCommitTransaction(
      groupId,
      async (intent) => {
        // Under the lock, after any settlement, on the tree the stage is built on.
        await beforeStage?.();
        const staged = await this.stageAddMembers(
          groupId,
          devices.map((d) => ({ keyPackage: d.keyPackage, identity: `${d.userId}:${d.deviceId}` })),
          intent
        );
        return {
          commit: staged.commit,
          welcome: staged.welcome,
          groupInfo: staged.groupInfo,
          addedDeviceIds: staged.addedIndices.map((i) => devices[i].deviceId),
          skipped: staged.skipped.map((s) => ({
            deviceId: devices[s.index].deviceId,
            reason: s.reason,
          })),
        };
      },
      {
        excludeDeviceIds,
        exportTree: true,
        keyPackageDevices: devices.map((d) => d.deviceId),
        ...(invitation ? { invitation } : {}),
      }
    );
    void this.handOverDeviceEvents('own add');
    // A DEVICE THE GATE DID NOT ADMIT IS OWED NO WELCOME, so it leaves `addedDeviceIds` - the list
    // every caller welcomes - matched by the PAIR, never by the device id alone.
    const notAdmitted = new Set(result.notAdmitted.map((r) => `${r.userId}:${r.deviceId}`));
    const ownerOf = new Map(devices.map((d) => [d.deviceId, d.userId]));
    return {
      ...result,
      addedDeviceIds: result.addedDeviceIds.filter(
        (id) => !notAdmitted.has(`${ownerOf.get(id)}:${id}`)
      ),
    };
  }

  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    await this.runCommitTransaction(
      groupId,
      (intent) => this.stageRemoveMembers(groupId, userIds, intent),
      {
        removes: commitRemovals({ userIds }),
      }
    );
  }

  /**
   * Removes the leaves of the named devices in ONE commit - the revoked-leaf collector's commit
   * (`strayLeaves.ts`), decided by no person, so staged only on the branch the server publishes
   * ({@link assertOnPublishedBranch}): a forked device's removal would be accepted by the epoch
   * gate and break every healthy member.
   */
  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const assertOnBranch = await this.assertOnPublishedBranch(groupId, 'revoked-leaf removal');
    await this.runCommitTransaction(
      groupId,
      async (intent) => {
        await assertOnBranch();
        return this.stageRemoveMembersByDevice(groupId, deviceIdentities, intent);
      },
      { removes: commitRemovals({ deviceIdentities }) }
    );
  }

  /**
   * Removes every leaf of the named users in ONE commit - the commit a roster DIFF decides (the
   * conversation stray sweep in `strayLeaves.ts`, the key-group roster pass in `rosterReconcile.ts`),
   * not a person. So it is staged only on the branch the server publishes, through the same check
   * as {@link removeMemberDevice}: a forked device's removal would be accepted by the epoch gate and
   * break every healthy member. {@link removeMember} stays the path of a removal a person asked for.
   *
   * @throws {UnpublishedBranchError} having staged nothing, when the published base cannot vouch.
   */
  async removeDepartedMembers(groupId: string, userIds: string[]): Promise<void> {
    // A CONVERSATION THAT NEVER PUBLISHED A BASE has nothing to compare against, and refusing there
    // would keep its departed members' leaves forever: no base is ever published for it by a sweep.
    // So for a conversation, a base never published is "nothing to vouch" (`classifyBase`'s
    // `no-base-published`), and the removal is staged as it always was. A KEY GROUP's base is
    // published with the group itself, so its absence stays a refusal.
    const assertOnBranch = await this.assertOnPublishedBranch(groupId, 'departed-member removal', {
      withoutBase: this.isDistributionGroup(groupId) ? 'refuse' : 'stage-unvouched',
    });
    await this.runCommitTransaction(
      groupId,
      async (intent) => {
        await assertOnBranch();
        return this.stageRemoveMembers(groupId, userIds, intent);
      },
      { removes: commitRemovals({ userIds }) }
    );
  }

  /**
   * Replaces this device's own leaf in `groupId` - the periodic refresh (`leafRefresh.ts`). A commit
   * like any other: staged, submitted to the epoch gate, merged on its accept (which dates the leaf
   * in the refresh ledger) or cleared on its refusal, which throws {@link CommitRefusedError}.
   * Admits nobody and removes nobody, so it declares neither. Staged only on the published branch.
   */
  async refreshOwnLeaf(groupId: string): Promise<void> {
    // THE ROLE BEFORE THE BASE: a follower tab never commits (`runCommitTransaction` refuses it), so
    // fetching the published base first only cost a request per epoch before the same refusal.
    if (getTabLeadership() === 'follower') {
      console.log(
        `[LEAF_REFRESH] ${groupId.slice(0, 8)}... not refreshed on a follower tab - the leader refreshes`
      );
      throw new FollowerTabCommitError(groupId);
    }
    const assertOnBranch = await this.assertOnPublishedBranch(groupId, 'leaf refresh');
    await this.runCommitTransaction(groupId, async (intent) => {
      await assertOnBranch();
      return this.stageSelfUpdate(groupId, intent);
    });
  }

  /**
   * Reads the external-join base the server publishes for `groupId` and returns the check a
   * MECHANISM's commit runs in its stage callback, before staging anything (`publishedBranch.ts`):
   * this device's epoch must be the base's, and its context (tree hash, confirmed transcript hash)
   * the one the base describes.
   *
   * The base is read OUTSIDE the MLS lock (network) and compared INSIDE it, against the state the
   * commit is built from: an epoch that moved in between no longer matches, and nothing is staged.
   *
   * **A `diverged` ANSWER IS A FORK, AND IT IS HANDED TO THE RECOVERY LADDER HERE**, where it is
   * known, for every caller: the group is marked in the epoch-gap registry - which keeps every send
   * out of it and hands it to the sync watchdog's rung 2 (forget + re-Welcome) - with an
   * error-level line, the route {@link escalateUnreadableSubmission} takes for the other state
   * whose branch cannot be trusted. Rung 1 (replaying the commit log) cannot help: the device is not
   * behind, it is beside. `no-base` and `other-epoch` accuse nothing and enter nothing.
   *
   * **THE BASE IS READ WHERE THE GROUP KEEPS IT** ({@link groupInfoChannel}): a key group's lives on
   * social-service, and chat-delivery's route answers 403 for it by construction - read there, every
   * key-group check failed before comparing anything.
   *
   * `withoutBase: 'stage-unvouched'` is for a caller whose group may never have published a base
   * (a conversation's departed-member removal): the check then has nothing to compare, says so, and
   * lets the commit be staged as it was before the check existed. Every other caller refuses.
   *
   * @throws {UnpublishedBranchError} from the returned check, and from here when no base exists.
   */
  private async assertOnPublishedBranch(
    groupId: string,
    what: string,
    opts: { withoutBase: 'refuse' | 'stage-unvouched' } = { withoutBase: 'refuse' }
  ): Promise<() => Promise<void>> {
    const base = await this.groupInfoChannel(groupId).fetch();
    if (!base) {
      if (opts.withoutBase === 'refuse') throw new UnpublishedBranchError(groupId, 'no-base', what);
      console.log(
        `[MLS] ${groupId.slice(0, 8)}... ${what}: no base was ever published for this conversation - nothing to vouch against, staged as before the check`
      );
      return async () => {};
    }
    const baseBytes = fromBase64(base.groupInfo);
    return async () => {
      const epoch = await this.freshEpoch(groupId);
      if (base.baseEpoch !== epoch) throw new UnpublishedBranchError(groupId, 'other-epoch', what);
      if (await this.ownContextMatchesBase(groupId, baseBytes)) return;
      markEpochGap(groupId);
      console.error(
        `[FORK] ${groupId.slice(0, 8)}... ${what} not staged: this device's context DIVERGES from ` +
          `the published base at the same epoch ${epoch} - another branch; the group is handed to ` +
          'rung 2 (forget + re-Welcome) through the epoch-gap registry'
      );
      throw new UnpublishedBranchError(groupId, 'diverged', what);
    };
  }

  /** The epoch at which a refresh of each group last failed this session (`leafRefresh.ts`). */
  private readonly leafRefreshAttempts = new Map<string, number>();
  /** The epoch each active group was last reported holding no leaf of ours at (`leafRefresh.ts`). */
  private readonly leafRefreshNoOwnLeafReports = new Map<string, number>();
  /** One refresh decision in flight per group: two sends in a row must not stage two commits. */
  private readonly leafRefreshInFlight = new Map<string, Promise<unknown>>();

  /**
   * Runs the periodic leaf refresh for `groupId` after a durable send, without holding the send up.
   *
   * NOT AWAITED BY THE SEND, AND OUTSIDE ITS BARRIER: the refresh is a commit, which takes the MLS
   * lock and the epoch-advance barrier itself, and a send must never wait for one. Its loss costs
   * nothing - the ledger is written only on an accepted commit, so the next durable send decides
   * again from the same durable facts.
   */
  private scheduleLeafRefresh(groupId: string): void {
    if (this.leafRefreshInFlight.has(groupId)) return;
    const run = refreshLeafIfDue(
      {
        userId: this.userId,
        deviceId: this.deviceId,
        isDistributionGroup: (g) => this.isDistributionGroup(g),
        isInEpochGap,
        isGroupActive: (g) => this.isGroupActive(g),
        getEpoch: (g) => this.getEpoch(g),
        ownLeafMintedAt: (g) => this.ownLeafMintedAt(g),
        ownLeafKey: (g) => this.ownLeafKey(g),
        refreshOwnLeaf: (g) => this.refreshOwnLeaf(g),
        checkpoint: () => persistMlsStructuralCheckpoint({ mlsService: this }),
        attemptedAtEpoch: this.leafRefreshAttempts,
        noOwnLeafReportedAtEpoch: this.leafRefreshNoOwnLeafReports,
        now: () => Date.now(),
        log: (message) => console.log(message),
        warn: (message) => console.warn(message),
      },
      groupId
    )
      .catch((e) =>
        console.warn(
          `[LEAF_REFRESH] ${groupId.slice(0, 8)}... decision failed: ${String(e).slice(0, 160)}`
        )
      )
      .finally(() => this.leafRefreshInFlight.delete(groupId));
    this.leafRefreshInFlight.set(groupId, run);
  }

  abstract processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string>;
  /**
   * Encrypts one application message against the LIVE client, advancing this device's send ratchet.
   * Platform-specific and nothing else: every rule that has to hold around a send lives in
   * {@link sendMessage}, which is the only caller.
   */
  protected abstract encryptForSend(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<AuthoredFrame>;

  /**
   * Encrypts an application message and puts it on the wire.
   *
   * CONCRETE, AND SHARED BY BOTH PLATFORMS ON PURPOSE. Three things must happen around every send,
   * and each of them was previously the responsibility of the caller:
   *
   * - nothing leaves this device while a catch-up is open ({@link waitForCatchUpIdle}), because a
   *   send advances the ratchet of a client the catch-up is about to replace with a copy taken
   *   before it;
   * - the advance is COUNTED ({@link noteLiveMutation}), which is what lets every state-replacement
   *   seam refuse a candidate that predates it;
   * - the advance is CHECKPOINTED, because the moment the frame is on the wire the peer has consumed
   *   that generation, and a ratchet that only moved in RAM is a ratchet the next load puts back.
   *
   * It was a template method the day the third rule was found at TWO of the EIGHTEEN call sites
   * that reach a send - the sixteen others (read receipts, reactions, edits, deletes, pins, group
   * control, calls) advanced the ratchet and checkpointed nothing. A rule that each caller has to
   * remember is a rule the next caller will not, so it is enforced here or not at all.
   */
  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string,
    frameDelivery: FrameDelivery = DELIVERY.visible
  ): Promise<SentFrame> {
    await this.waitForCatchUpIdle();
    // NOTHING IS SEALED ON TOP OF A COMMIT WHOSE OUTCOME IS UNKNOWN: whether this device is at N or
    // N+1 is exactly what that outcome decides, so it is asked first, by the same resubmission.
    await this.settleBeforeSend(groupId);
    // ...and nothing straddles a LOCAL epoch advance either: a frame encrypted at epoch N and posted
    // after this device's own commit moved the group to N+1 is a past-epoch frame for every
    // recipient, which two further commits make undecryptable for good. The barrier deletes the
    // overlap rather than detecting it afterwards - see `epochSendBarrier`, which also carries the
    // lock order this relies on.
    const emit = () =>
      runAsEpochSend(groupId, () => this.emitFrame(groupId, messageBytes, frameDelivery));
    let sent: SentFrame;
    try {
      sent = await emit();
    } catch (e) {
      // THE STATE REFUSED WHAT THE INDEX ALLOWED: it holds a staged commit the index did not name
      // (a state swapped under it). Re-indexed from the state, settled as any known one, and sealed
      // once more - a second refusal is an outcome still unknown, never a failed send.
      if (!(e instanceof StagedCommitPendingError)) throw e;
      console.warn(
        `[COMMIT] ${groupId.slice(0, 8)}... the state refused a send its index allowed - settling first`
      );
      this.forgetUnresolvedIndex();
      await this.settleBeforeSend(groupId);
      try {
        sent = await emit();
      } catch (again) {
        if (!(again instanceof StagedCommitPendingError)) throw again;
        console.error(
          `[COMMIT] ${groupId.slice(0, 8)}... refused again after the settle - a commit was staged in between`
        );
        throw new CommitOutcomeUnknownError(
          groupId,
          this.getEpoch(groupId),
          again,
          'a commit was staged again between the settle and the send'
        );
      }
    }
    // ACTIVITY IN THE GROUP IS WHAT DUE LEAF REFRESHES WAIT FOR: a conversation frame the server
    // just accepted. An ALLOWLIST of the two conversation kinds, by identity, because neither the
    // value nor `durable` can tell them from key material: a seed is shaped exactly like a mutation,
    // and an addressed seed is a fresh object each time. Never a seed (key groups are not refreshed,
    // see `leafRefresh.ts` - and the key-group registry is empty at a cold start), never
    // transport traffic, which every connection sends. See `leafRefresh.ts`.
    if (frameDelivery === DELIVERY.visible || frameDelivery === DELIVERY.mutation) {
      this.scheduleLeafRefresh(groupId);
    }
    return sent;
  }

  /**
   * Settles `groupId`'s staged commit before a send when the index names one, and throws
   * {@link CommitOutcomeUnknownError} when it is still unresolved after the resubmission.
   */
  private async settleBeforeSend(groupId: string): Promise<void> {
    if (!(await this.knownUnresolvedGroups()).has(groupId)) return;
    await this.settleUnresolvedCommits([groupId]);
    if ((await this.knownUnresolvedGroups()).has(groupId)) {
      throw new CommitOutcomeUnknownError(
        groupId,
        this.getEpoch(groupId),
        'a send waits for the resubmission to answer'
      );
    }
  }

  /**
   * The frame itself: encrypt against the live client, count the advance, checkpoint it, post it.
   *
   * Split out of {@link sendMessage} only so the whole of it - encrypt AND post - sits inside one
   * barrier section. Registering just the post would leave the straddle the barrier exists to
   * delete, the stale epoch being chosen at the encrypt.
   */
  private async emitFrame(
    groupId: string,
    messageBytes: Uint8Array,
    frameDelivery: FrameDelivery
  ): Promise<SentFrame> {
    const {
      sealed: encryptedBytes,
      authorProof,
      epoch,
    } = await this.sealPastOwedBurns(groupId, messageBytes);
    this.noteLiveMutation();
    // DURABLE, AND BEFORE THE POST. The ratchet has moved by now and stays moved whether or not the
    // POST below succeeds, so this is the only correct moment: counting a successful send instead
    // would leave every failed POST as an under-count, which is the direction that re-issues a spent
    // generation. It is what a reload recovers the advance from when the checkpoint below does not
    // land in time - the whole reason that checkpoint is allowed not to be awaited.
    noteFrameEmitted(this.userId, groupId, epoch);
    // BEST-EFFORT, AND DELIBERATELY NOT AWAITED. It shortens the window; the ledger write above is
    // what CLOSES it. Awaiting here would put a checkpoint on the latency of every message - 1.7 s
    // on the phone - to buy a guarantee that is already held, so the trade is refused.
    scheduleOutboundMlsPersist();
    const proto = toBase64(encryptedBytes);
    const receivedAt = await this.delivery.postApplicationMessage(groupId, proto, frameDelivery);
    return { sealed: encryptedBytes, authorProof, receivedAt };
  }
  abstract processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array,
    envelope?: EnvelopeSender
  ): Promise<DecryptedApplication | null>;
  abstract exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;
  abstract getLocalGroups(): string[];
  abstract setAdmissionPolicy(groupId: string, policy: 'closed' | 'open'): Promise<void>;

  /** See {@link IMlsService.isGroupActive}. Platform-specific: WASM query vs Tauri `invoke`. */
  abstract isGroupActive(groupId: string): Promise<boolean>;
  abstract getEpoch(groupId: string): number;
  abstract getGroupMemberIdentities(groupId: string): Promise<string[]>;
  abstract memberSignatureKey(groupId: string, identity: string): Promise<Uint8Array | null>;
  abstract leafHoldingKeyOf(groupId: string, keyPackage: Uint8Array): Promise<string | null>;
  abstract graineRun(groupId: string): Promise<GraineRunReading>;
  abstract graineSignatureEngine(): GraineSignatureEngine;
  abstract signWithDeviceCredential(message: Uint8Array): Promise<Uint8Array>;
  abstract takeForkFindings(): Promise<ForkFinding[]>;
  abstract forgetGroup(groupId: string, minEpoch?: number): void;
}
