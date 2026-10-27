import type { GraineSignatureEngine } from '$lib/crypto/graineV2';
import type { AuthorVerdict } from '$lib/crypto/messageAuthorship';
import type { DatedKeyPackage } from './keyPackages';
import type { SkippedDevice } from './skippedKeyPackage';
import type { DeviceEvent, DevicePin, KeyPackageVerdict } from './deviceTrust';
import type { DeviceKeyPackageAnswer, DeviceSignatureKeys } from './deviceKeyPackage';
import type { FrameDelivery } from './frameDelivery';
import type { IncomingDeliveryMeta } from './incomingDelivery';
import type { MlsDecryptSession } from './mlsDecryptSession';
import type { DistributionScope } from './distributionScope';
import type { EnvelopeSender } from './verifiedSender';
import type { IStorage } from '$lib/db/types';
import type {
  AdmitRefusalReason,
  GroupExclusions,
  GroupRosterBatch,
  GroupUserMemberRow,
  GroupRosterAtGeneration,
  JoinDeclineOutcome,
  PendingInvitationRow,
  RefusedAdmit,
  SentFrame,
} from './mlsDeliveryApi';

/**
 * What an accepted one-device Add ({@link IMlsService.addMember}, {@link IMlsService.replaceMember})
 * leaves its caller to do.
 *
 * `notAdmitted` is set when the commit gate accepted the commit but did NOT record the device, for a
 * reason that makes its Welcome undeliverable (`admitRefusalMakesWelcomeUndeliverable`) - its owner
 * revoked it while the Add was in flight. `welcome` is then ABSENT: the commit merged, the Welcome
 * the merge owed is already discharged, and nothing is to be sent to that device (DEV-3, 2026-10-25).
 */
export interface OneDeviceAddResult {
  welcome?: Uint8Array;
  ratchetTree?: Uint8Array;
  notAdmitted?: AdmitRefusalReason;
}
import type { ForkFinding } from './integrityFindings';
import type { CommitInvitation } from './commitSubmission';
import type { OwedInvitationReplanner, UnrecordedInvitationTeller } from './owedInvitations';

export type { FrameDelivery };
export type { DistributionScope };

export type { IncomingDeliveryMeta };

/**
 * Where a distribution-group GroupInfo is fetched from and published to.
 *
 * INJECTED RATHER THAN IMPORTED, for one reason: this transport is social-service, and the MLS
 * layer must not learn to speak to the communities API. Everything it needs is the pair of calls,
 * keyed by the scope whose roster the group carries - a community, or ONE private salon.
 */
export interface DistributionGroupInfoTransport {
  /**
   * The published base, or null when no client has initialised the MLS group yet.
   *
   * `activeEpoch` travels with it because the two can disagree PERMANENTLY, and only the server
   * knows both: a base behind the group's epoch is refused by the commit gate every time, so a
   * joiner handed one must be able to tell that apart from a fresh base before it builds anything.
   */
  fetch(
    scope: DistributionScope
  ): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null>;
  /**
   * Publishes a committed base. Monotonic on the far side: `stored: false` is a base that was not
   * newer, or a first publish lost to a concurrent one - legitimate outcomes, not errors.
   */
  publish(
    scope: DistributionScope,
    groupInfoBase64: string,
    baseEpoch: number,
    /**
     * The device doing the publishing, which is ALSO how it gets into the group's delivery roster.
     *
     * A distribution group's roster is written by the commit fan-out, where the activating device
     * is the commit SENDER - so the device that CREATES the MLS group, which sends no commit, was
     * never written into it and therefore received nothing on the group it had just made: not the
     * next member's external-join commit, so its epoch never moved and every seed it sealed was
     * unreadable to them, and not their request for the missing seed either, so the repair could
     * not answer. A private salon with two members did not work. Found on prod 2026-08-20.
     */
    deviceId: string
  ): Promise<{ stored: boolean }>;
}

/**
 * Why an external-commit join did not happen - or that it did.
 *
 * A TYPE BECAUSE THE CALLERS DIFFER, and while this was a bare `false` they could not. "Nothing is
 * published yet" is a state to act on (create the group, or ask a peer to Welcome us); "the
 * published base is behind the group's epoch" is a state no caller can act on by retrying, because
 * only a device holding the tree can mint a fresh base; "the server was never reached" says nothing
 * at all and must not retire anything. Flattened together, the loop written for one was taken for
 * all of them - which is how the same doomed commit was resubmitted for twenty minutes on
 * production (2026-08-25).
 */
export type ExternalJoinOutcome =
  /**
   * The group is held. `alreadyHeld` says nothing was built because the group was ALREADY here when
   * the MLS lock was taken - a Welcome installed it while the caller's recovery was on its way - so
   * the caller stands down: the path that installed it owns everything after (review of #2466).
   */
  | { joined: true; alreadyHeld?: true }
  /** No base has been published on the group yet - nobody has initialised its MLS group. */
  | { joined: false; reason: 'no_base_published' }
  /**
   * The published base is BEHIND the group's real epoch, so the commit gate refuses anything built
   * on it. Terminal for a joiner: the repair is a republish, which only a holder can perform.
   */
  | { joined: false; reason: 'stale_base'; baseEpoch: number; serverEpoch: number }
  /**
   * The external commit could not be built locally. NEVER because the group is already held: that
   * is `{ joined: true, alreadyHeld: true }`, read under the lock before anything is built.
   */
  | { joined: false; reason: 'build_failed' }
  /**
   * The join was NOT attempted: this device's own key package round was running and failed, so the
   * commit gate would refuse the activation (`no_key_package`). The round reported its own cause.
   */
  | { joined: false; reason: 'key_package_round_failed' }
  /**
   * The join was NOT attempted: the server's statement about this device's KeyPackage could not be
   * established (unreadable, or still absent after a round of ours) and no round can change it.
   * Nothing is claimed about membership; the caller's cadence retries.
   */
  | { joined: false; reason: 'own_key_package_unverified' }
  /** The commit gate was never reached. Nothing is claimed about membership. */
  | { joined: false; reason: 'unreachable' }
  /**
   * The server's per-user commit limit refused it (`429`), or still holds from an earlier refusal.
   * Nothing is claimed about membership; nothing else this account commits is accepted for
   * `retryAfterMs`, so a sweep stops there rather than ask group after group.
   */
  | { joined: false; reason: 'rate_limited'; retryAfterMs: number }
  /** The gate refused every bounded attempt; `serverReason` is its own classification. */
  | { joined: false; reason: 'refused'; serverReason: string; serverEpoch?: number };

/** A decrypted frame that arrived on a key-distribution group. */
export interface DistributionFrame {
  /** The roster the group carries - a community, or one private salon of it. */
  scope: DistributionScope;
  /**
   * The community the group belongs to. Carried beside the scope because seeds are stored and
   * mirrored per community whichever group they arrived on, so every consumer needs it and none
   * should have to unpack the union to get it.
   */
  workspaceId: string;
  /** The MLS group it arrived on. */
  groupId: string;
  /** Lower-cased sender user id. */
  sender: string;
  /**
   * The sending DEVICE the delivery envelope names, when it names one - what a seed answer is
   * addressed to (channel-encryption section 23). Self-asserted by the sender, and that is enough
   * for an address: the server delivers only to a `userId:deviceId` that is a live member of the
   * group, so a lie about it reaches nobody else.
   */
  senderDeviceId?: string;
  /** The decrypted payload - a Graine control message, never a chat message. */
  plaintext: Uint8Array;
}

/**
 * What a decrypted distribution-group frame is handed to.
 *
 * A SEAM, deliberately: WP-22 gets these frames out of the conversation pipeline and delivers them
 * somewhere; what a seed offer, a seed request or a history bundle MEANS is WP-30..33. A frame
 * arriving with no handler wired is logged rather than dropped in silence, because that is the one
 * symptom the omission would otherwise have.
 */
export type DistributionFrameHandler = (frame: DistributionFrame) => Promise<void>;

/**
 * Where the key-distribution registry survives a reload - the three `IStorage` calls it needs.
 *
 * Injected rather than imported for the reason {@link DistributionGroupInfoTransport} is: the MLS
 * layer must not learn which store a platform uses, and the store must not learn what a group is.
 */
export type DistributionGroupStore = Pick<
  IStorage,
  'saveDistributionGroup' | 'getDistributionGroups' | 'deleteDistributionGroup'
>;

/**
 * What a key group's catch-up concluded, once it was found BEHIND the server's epoch.
 *
 * - `caught-up`: the missing commits were replayed from the commit log - nothing was lost.
 * - `replay-exhausted`: the log CANNOT supply them (below its floor, or holed) - a PROOF that only a
 *   re-join brings this device back, so it is owed at once rather than after a clock.
 * - `replay-failed`: the attempt failed for a reason that says nothing about the next one; the group
 *   stays in the epoch-gap registry and the sync watchdog owns it.
 */
/**
 * A key group's clean run at its current epoch (`mls-core/src/graine_run.rs`).
 *
 * `epochFingerprint` is a domain-separated hash of the epoch authenticator, never the authenticator
 * itself: it identifies the epoch of THIS group instance, so two instances at the same epoch number
 * never compare equal.
 */
export interface GraineRunReading {
  runId: string;
  epoch: number;
  epochFingerprint: string;
}

export type DistributionGapVerdict = 'caught-up' | 'replay-exhausted' | 'replay-failed' | 'evicted';

/** Told every {@link DistributionGapVerdict}, for the key group it concerns. */
export type DistributionGapListener = (groupId: string, verdict: DistributionGapVerdict) => void;

/** Per-message outcome from a {@link MlsDecryptSession} page decrypt. */
export type MlsBatchProcessResult =
  | {
      ok: true;
      plaintext: Uint8Array | null;
      /**
       * The sender OpenMLS verified (`userId:deviceId`): `null` when unreadable, absent when the
       * path carries none (a stub) or the frame had no plaintext.
       */
      sender?: string | null;
      /**
       * mls-core's verdict on the frame's author proof, beside a plaintext and only with it: absent
       * when the path carries none (a stub) or the frame had no plaintext. Only `verified` lets a
       * proof be recorded (`recordAuthorship`).
       */
      author?: AuthorVerdict;
    }
  | { ok: false; error: string };

/**
 * One decrypted application frame: the plaintext, and mls-core's verdict on the author proof it
 * may end with. The verdict is the ONLY thing that says a proof was checked - see `recordAuthorship`.
 */
export interface DecryptedApplication {
  plaintext: Uint8Array;
  author: AuthorVerdict;
}

/** Options for {@link IMlsService.init}. */
export interface MlsInitOptions {
  /**
   * When true, a saved state that fails to decrypt with the given PIN is NOT discarded
   * via the destructive fresh-start fallback; instead {@link SavedStateUnopenedError}
   * is thrown so the caller can offer cross-device PIN recovery (decrypt with the old PIN)
   * before any local history is dropped. A state no PIN can open (`mismatch`, `altered`) is
   * rotated regardless: pausing for it would strand the user with nothing to try.
   */
  noFreshStart?: boolean;
  /**
   * The PIN just verified server-side, supplied ONLY so a snapshot left behind by a pre-v0.11.0
   * install can be re-sealed under the current device key (Argon2id + salt-prefix envelope ->
   * ChaCha20-Poly1305 + device key). Absent on the biometric and vault paths, where no PIN was
   * typed and therefore no legacy snapshot can be opened.
   *
   * Never used as a key: it is passed straight to the one-shot legacy decrypt and dropped.
   */
  legacyPin?: string;
  /**
   * The saved state exists but was deliberately NOT loaded into the frontend: the native side is
   * to read `mls.bin` itself. **Tauri only**, and meaningless on the web, where the bytes and the
   * MLS client live in the same process.
   *
   * IT EXISTS BECAUSE AN ABSENT `state` ALREADY MEANT SOMETHING, and what it meant was FIRST
   * INSTALL - which fresh-starts, rotating this device's identity and dropping its history. "There
   * is no state" and "the state is on disk, not in this argument" are two different facts, and one
   * missing array cannot carry both; whoever omits the bytes says which one they mean.
   *
   * What it saves is measured: `mls.bin` was 7,8 MB on a real account and crossed the IPC bridge
   * TWICE as a JSON array of per-byte numbers, 29 074 883 characters each way, for bytes that had
   * been read natively three lines earlier and were going straight back.
   */
  stateOnDisk?: boolean;
  /**
   * Biometric mode only, **Tauri only**: read the keystore key WITHOUT a biometric sheet, because
   * the user's unlock cadence is "every 12h" and a prompted unlock happened inside that window.
   * The decision belongs to `biometricCadence.ts`; this flag only carries it to the native side.
   */
  unattendedKeyRead?: boolean;
  /**
   * The device key came from the UNLABELLED vault an older build wrote, so nothing yet says it
   * belongs to the account signing in (`deviceKeyVault.loadDeviceKey`). Such a key is accepted only
   * if it OPENS a saved state whose credential names this account; any other outcome - the state
   * will not open, it opens and names someone else (`mismatch`), or the load fails otherwise -
   * throws {@link VaultOwnerUnprovenError} and changes NOTHING: no rotation, no fresh start, no
   * write. On a phone `mls.bin` is one file per install, so a rotation here is another account's
   * local state overwritten.
   */
  vaultOwnerUnproven?: boolean;
}

/**
 * What refused a vaulted key of unproven owner: `no_state` (nothing on this device to prove the
 * account with - the login checks this before init), `mismatch` (the key OPENED the state and its
 * credential names another account or device: on a phone, the state of the account that signed in
 * before), or `unopenable` (the state did not open under it, or the load failed otherwise).
 */
export type VaultRefusal = 'no_state' | 'mismatch' | 'unopenable';

/**
 * A vaulted device key whose owner was not proven was refused, and nothing local was changed
 * ({@link MlsInitOptions.vaultOwnerUnproven}). The login turns it into the PIN gate.
 */
export class VaultOwnerUnprovenError extends Error {
  readonly refusal: VaultRefusal;

  constructor(refusal: VaultRefusal) {
    super(`vaulted device key refused: its owner is not proven (${refusal})`);
    this.name = 'VaultOwnerUnprovenError';
    this.refusal = refusal;
  }
}

/**
 * A state opened outside `init` (the PIN recovery's `openLocalStateWithKey`) could not be made
 * ready: the groups it holds could not be listed, or the send ratchets could not be reconciled.
 * Nothing was written. A login run on top would read an empty group cache and act on it (a false
 * "partial restore", re-joins of groups held, key-group rows deleted), so the open is REFUSED and
 * the recovery reports a failure the same two PINs retry.
 */
export class LocalStateNotReadyError extends Error {
  constructor(readonly reason: unknown) {
    super(`the opened local state could not be made ready: ${String(reason)}`);
    this.name = 'LocalStateNotReadyError';
  }
}

/**
 * What a pending {@link IMlsService.whenGroupDrained} rejects with when its service is destroyed
 * (sign-out): the group will never be drained by THIS client, and a waiter left pending would hold
 * the account that left in memory until a reload.
 */
export class GroupDrainAbandonedError extends Error {
  constructor(readonly groupId: string) {
    super(`the MLS service ended before key group ${groupId.slice(0, 8)} drained`);
    this.name = 'GroupDrainAbandonedError';
  }
}

/**
 * Thrown by {@link IMlsService.init} when `noFreshStart` is set and the saved local state did not
 * open under the key in hand for a reason an OLD PIN may still cure. Nothing was written.
 *
 * **IT CARRIES ITS CAUSE AS A TYPE, AND THAT IS WHY IT REPLACED A MESSAGE.** It used to be
 * `new Error('MLS_LOCAL_STATE_UNDECRYPTABLE')`, read back by comparing `reason.message`, and the one
 * marker collapsed every cause into the same screen. Since step 2 framed every save (2026-10-17),
 * `rotated` is a FACT - the header names another key, so the old PIN opens it - while `undecryptable`
 * (a legacy blob, whose bytes say nothing) and `unknown` stay observations, and the login says which.
 * `mismatch` and `altered` never reach it: no PIN opens either, so `init` rotates the device identity
 * instead ({@link StateLoadFailure}).
 */
export class SavedStateUnopenedError extends Error {
  readonly reason: Extract<
    StateLoadFailure,
    'rotated' | 'undecryptable' | 'unreadable_now' | 'unknown'
  >;

  constructor(
    reason: Extract<StateLoadFailure, 'rotated' | 'undecryptable' | 'unreadable_now' | 'unknown'>,
    cause: unknown
  ) {
    super(`the saved MLS state did not open under this key (${reason}) - nothing written`, {
      cause,
    });
    this.name = 'SavedStateUnopenedError';
    this.reason = reason;
  }
}

/**
 * Thrown by {@link IMlsService.init} on a phone whose ONE `mls.bin` is recorded as another
 * account's (`mls.owner`, written by `initialiser_mls` each time a state OPENS for an account), when
 * this account's key did not open it. Nothing was rotated, written or offered for deletion: the
 * gate says another account's messages are here and withholds the reset, which would erase them.
 *
 * Only a RECORD naming someone else proves it. No record (an install older than the record, or a
 * first install) is absence of proof, and the load failure is reported as itself.
 */
export class SavedStateOfAnotherAccountError extends Error {
  constructor(cause: unknown) {
    super("the saved MLS state is recorded as another account's - nothing written", { cause });
    this.name = 'SavedStateOfAnotherAccountError';
  }
}

/**
 * True when an MLS init failed because biometric mode found no key in the platform keystore - a
 * cancelled or refused sheet, or an entry that was never written or was wiped.
 *
 * Reads `mls-core`'s `KEYSTORE_KEY_UNAVAILABLE` code, the one contract that crosses the Tauri
 * boundary, so the service and the login flow cannot disagree about it. Both used to match the
 * sentence `"No keystore key ..."` with a regex of their own.
 */
export function isKeystoreKeyUnavailable(error: unknown): boolean {
  return String(error).includes('KEYSTORE_KEY_UNAVAILABLE');
}

/**
 * Why a stored MLS state did not load, typed at the one place that reads `mls-core`'s codes:
 * `mismatch` (another device's identity), `rotated` (a framed state whose header names another
 * key: the old PIN opens it), `altered` (a framed state whose header names THE KEY IN HAND and whose
 * tag fails: no PIN opens it), `undecryptable` (a legacy state that did not open - either of the two,
 * and nothing says which), `keystore_unavailable` (biometric mode found no key), `unreadable_now`
 * (the web's WebCrypto refused a v2 state and the deterministic reader did not prove it altered:
 * nothing is known about the bytes, so the state is re-read and never replaced -
 * `MlsStateUnreadableNowError`) and `unknown` (an untyped failure).
 */
export type StateLoadFailure =
  | 'mismatch'
  | 'undecryptable'
  | 'rotated'
  | 'altered'
  | 'keystore_unavailable'
  | 'unreadable_now'
  | 'unknown';

/**
 * True when NO PIN can ever open the state that failed: it opened and names another device
 * (`mismatch`), or its header names the key in hand and its tag fails (`altered`). Both platforms'
 * `init` rotate the device identity for these even under `noFreshStart`, and ONLY for these - every
 * other cause may be a PIN rotated elsewhere, whose history a rotation would destroy (DE7, CORRUPT-2).
 */
export function noPinOpensState(cause: StateLoadFailure): boolean {
  return cause === 'mismatch' || cause === 'altered';
}

/** The answer of {@link IMlsService.openLocalStateWithKey}: opened, or refused with its cause. */
export type LocalStateOpenResult = { opened: true } | { opened: false; cause: StateLoadFailure };

/**
 * Describes a bulk-ingest window: a span during which many MLS messages are processed at once
 * (a queue drain after reconnect, or a history restore). The same immutable object is replayed
 * at open and close, which guarantees the two ends agree on what to do.
 */
export interface BulkIngestPhase {
  /**
   * Buffer decrypted messages for a single grouped UI flush at close. `true` for a live drain
   * (avoids N reactive updates that cause jank); `false` for a history restore that already
   * appends its messages in one batch.
   */
  readonly bufferUi: boolean;
  /** Show the blocking sync overlay for the duration of the window. */
  readonly showOverlay: boolean;
}

/**
 * Names one open bulk-ingest window: returned by `beginBulkIngest`, handed back to `endBulkIngest`
 * so the close ends THAT window even when another opened after it is still open.
 */
export type BulkIngestHandle = number;

/**
 * Observer of the bulk-ingest window lifecycle. Each `onBulkIngestStart` is paired with exactly
 * one `onBulkIngestEnd` receiving the same {@link BulkIngestPhase}, even when windows nest or
 * overlap.
 */
export interface BulkIngestObserver {
  onBulkIngestStart(phase: BulkIngestPhase): void;
  onBulkIngestEnd(phase: BulkIngestPhase): void | Promise<void>;
}

/** Row from `GET /api/mls/users/:id/groups`. */
export type UserGroupRow = {
  groupId: string;
  name: string;
  isGroup: boolean;
  /** Media-service id of the group avatar; null when the group has no custom photo. */
  imageMediaId?: string | null;
  deletedAt?: string | null;
  /**
   * The instant the group was created, server-side, ISO-8601.
   *
   * IT ANSWERS "IS THERE ANYTHING OLDER TO ASK FOR", which nothing else here can. The scrollback
   * reaches BELOW this device's retention window by asking a member who kept more; a group created
   * INSIDE that window has nothing below it, and everything inside belongs to the reconciliation on
   * connect. The messages alone cannot separate the two, because the oldest message a device holds
   * is always strictly after the group was created - so a first contact looked exactly like a
   * device missing the past, asked, and was told nobody was online to answer.
   *
   * Optional because a client may be talking to a server that predates it, and absence must read as
   * "unknown" - which asks, the safe direction - rather than as "nothing exists".
   */
  createdAt?: string | null;
  /**
   * The epoch the group is at, server-side.
   *
   * Carried so a device that HOLDS the tree can see, on the one read it already makes on every
   * connection, that the published external-join base is behind - see {@link baseEpoch}. Optional
   * because a client may be talking to a server that predates it, and a missing pair must read as
   * "nothing known to be stale" rather than as "everything is stale".
   */
  activeEpoch?: number;
  /**
   * The epoch the published external-join base describes, `null` when none has ever been published.
   *
   * `null` IS NOT STALENESS and the two must not be collapsed: no base published means a joiner asks
   * a member for a Welcome and a holder has nothing to repair, while a base BEHIND `activeEpoch` is
   * a group no stateless device can enter until some member republishes. Only a member's commit
   * mints a base, and that publish is a follow-up that can be lost - so the gap is permanent until
   * somebody acts on it, which is what `republishBaseIfStale` is for.
   */
  baseEpoch?: number | null;
  /**
   * THIS device's own seat in the group, as the server holds it - `null` from a server that predates
   * the field (and for a group the device has no row for), which reads as "the server did not say",
   * never as "nothing is owed".
   *
   * It exists for the device that HOLDS the group's tree and never sends: `recoverRosterDisagreement`
   * is entered by a refused send, and a silent reader is refused nothing while every frame the group
   * produces is sealed to a tree its leaf is absent from. The partition is the one
   * {@link DeviceMembershipRow} carries (`welcomeQueued`, `addInFlight`), plus `admitted`: a commit
   * admitted this device and its Welcome is owed, so it is not a seat nothing follows.
   */
  deviceMembership?: {
    status: 'pending' | 'active';
    welcomeQueued: boolean;
    addInFlight: boolean;
    admitted: boolean;
    /** The seat waits for a member's admission (see {@link DeviceMembershipRow}); absent from an older server. */
    awaitingAdmission?: boolean;
  } | null;
};

/** Metadata from `GET /api/mls/groups/:id` for recovery checks (`deletedAt` = tombstone). */
export type GroupMeta = {
  groupId: string;
  name?: string;
  isGroup?: boolean;
  deletedAt?: string | null;
  /**
   * The community whose Graine key-distribution group this is, null on a conversation.
   *
   * THE DISCRIMINATOR A DESTRUCTIVE SWEEP NEEDS, carried from where it is already known. A
   * distribution group holds no `dm_group_members` row by construction, so it can never appear in
   * {@link UserGroupRow} - and a reconciler that reads that list as "every group this device may
   * legitimately hold" destroys it. The `dm_groups` row is the only thing that can tell the two
   * kinds apart, and it says so here rather than leaving every reconciler to infer it.
   */
  distributionWorkspaceId?: string | null;
  /**
   * Set when the group carries a PRIVATE SALON's seeds. The sibling of the field above, and exactly
   * one of the two is ever set - a database CHECK says so.
   *
   * Both are carried because the sweep's question is "is this a conversation", and a salon's group
   * is no more a conversation than a community's. Reading only the first would destroy every
   * private salon's seed carrier on the first sweep that ran before the Graine layer registered it.
   */
  distributionChannelId?: string | null;
  /**
   * The epoch the group's ratchet tree is really at, server-side.
   *
   * Undefined from a server too old to send it, which is not zero: reading a missing epoch as 0
   * calls every base stale. See `classifyBase` in `$lib/utils/chat/staleBase`, where the same three
   * numbers are turned into a verdict for the OTHER half of this problem - the holder's repair.
   */
  activeEpoch?: number;
  /**
   * The epoch of the published external-join base, `null` when none has ever been published.
   *
   * **THE PAIR IS WHAT SAYS WHETHER A LOCKED-OUT DEVICE HAS ANY REASON TO TRY AGAIN**, and it
   * travels on this read because this read is the first call of every recovery pass. `baseEpoch <
   * activeEpoch` is the stale base: the commit gate accepts equality and nothing else, so until
   * these two numbers converge the join is refused, every time, whoever asks. `null` is NOT
   * staleness - nothing has been lost, and the answer to it is a Welcome.
   */
  baseEpoch?: number | null;
};

/**
 * What the server said about a history solicitation.
 *
 * `noPeerOnline` is the server's own verdict, not an inference: it elects the responder, so it is
 * the only party that knows whether one existed. False therefore covers both "a peer was picked"
 * and "we could not find out", which is why the field names the negative - the caller may act on a
 * definite NO and must never read silence as one.
 */
export type HistoryRequestOutcome = {
  noPeerOnline: boolean;
  /** The member key (`userId:deviceId`) the server elected, when it elected one. */
  target?: string;
  /**
   * How many members were online and skipped ONLY because we had already heard from them.
   *
   * Read together with `noPeerOnline`, and never on its own: `noPeerOnline` with a positive count
   * means *every reachable member has answered you*, which is what ends a coverage chase. The same
   * status with zero means *nobody was there*, which a different edge answers. One status, two
   * facts, separated by evidence rather than by prose. Zero when the server said nothing.
   */
  excludedOnline: number;
};

/**
 * What the server did with a base-refresh request, as the server itself answers it.
 *
 * **THE ELECTION IS THE SERVER'S, SO THE ANSWER IS TOO** - the same shape as
 * {@link HistoryRequestOutcome} next door, for the same reason. A requester cannot see who is
 * online; the server picks one member and publishes to it, or finds none. Until this type existed
 * that verdict was thrown away at the call site, and a device refused `stale_base` re-asked once a
 * minute for as long as the session lasted. Measured on production
 * 2026-09-12: group `4f87267a` answered `NO_PEER_ONLINE members=1` once a minute for at least
 * twenty-seven consecutive minutes, to a group whose only other member had not connected since
 * 2026-08-03.
 *
 * `noPeerOnline` is true ONLY on an explicit `no_peer_online`. A request that failed to reach the
 * server, or answered something unparseable, proves NOTHING about who is reachable - reading
 * silence as "nobody" would stop a repair on a dropped packet.
 */
export type BaseRefreshOutcome = {
  /** The server looked at the roster and found no member it could publish to, right now. */
  noPeerOnline: boolean;
  /** The member key (`userId:deviceId`) the server elected, when it elected one. */
  target?: string;
};

/**
 * ONE device's membership of ONE group, as the server answers it.
 *
 * NAMED, BECAUSE THREE FILES DECLARED IT INLINE AND A FOURTH HAD TO AGREE WITH ALL OF THEM. The
 * shape was written out in `IMlsService`, `MlsDeliveryApi` and `BaseMlsService`, so adding a field
 * meant editing three copies and the compiler could not say which one a caller was reading.
 *
 * `welcomeQueued` and `addInFlight` ARE THE POINT OF THE TYPE. `status` alone cannot say which kind
 * of `pending` a row is - see `getDeviceMemberships` in
 * `apps/chat-delivery-service/src/controllers/invitations.controller.ts` for the two situations it
 * collapses and what reading it as one cost on production. They are optional so that a row which
 * does not carry them is never read as `false`: every deployed server writes both on a pending row,
 * so `undefined` is an anomaly `readWelcomeOwedFromRow` answers `null` (unanswered, the pass is
 * skipped and accused) - never a licence to serve itself.
 */
export type DeviceMembershipRow = {
  id: string;
  userId: string;
  deviceId: string;
  groupId: string;
  status: string;
  /** A `queued_message` carrying a Welcome exists for this device AND this group. */
  welcomeQueued?: boolean;
  /** Some member holds this group's add lock right now, so an Add really is in flight. */
  addInFlight?: boolean;
  /**
   * The seat came from an invitation link and no member has admitted the person yet: the server
   * refuses them the external-join base and every commit, so the device WAITS for a member's Add
   * (`readWelcomeOwedFromRow` -> `awaiting-admission`). Absent from a server older than the field.
   */
  awaitingAdmission?: boolean;
  /**
   * The epoch at which an accepted commit ADMITTED this device (`DeviceGroupMembership`), so its
   * leaf is in the tree while the row is still `pending`; `null` for a seat no commit has admitted.
   * Read by `requestReAdd` to name an admitted seat it serves itself over - the external commit
   * replaces that leaf (`mls-core/tests/external_join.rs`).
   */
  admittedAtEpoch?: number | null;
};

export interface IMlsService {
  /** Initialises the MLS identity for the given user, decrypting stored state with the device key. */
  init(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void>;
  /**
   * Creates a new local MLS group with the given ID. Refused on a follower tab
   * (`FollowerTabCommitError`), whose state is a copy the leader never holds.
   */
  createGroup(groupId: string): Promise<void>;
  /** Creates a new named group on the delivery server and returns its assigned group ID. */
  createRemoteGroup(name: string, isGroup?: boolean): Promise<string>;
  /**
   * Writes the current MLS state to THIS platform's durable store - the whole checkpoint, and the
   * only call a checkpoint needs.
   *
   * It exists because saving does not mean the same thing on the two platforms. On web
   * `WebMlsService.saveState` RETURNS bytes that still have to be handed to IndexedDB; on native
   * `TauriMlsService.persistState` has already written `mls.bin` before it returns, so handing
   * those bytes back through `save_mls_state` writes the same file, with the same bytes, a second
   * time - and pays a `number[]` IPC marshalling of the whole snapshot to do it, which is the very
   * cost `sauvegarder_mls_et_persister` was written to avoid. Measured on the phone 2026-08-14:
   * 3.7 s per checkpoint, of which 1.7 s was the real save and 2.0 s the duplicate.
   *
   * AND THE SAVE ITSELF IS NO LONGER ON THIS INTERFACE, which is the other half of the same fact.
   * Declaring it here gave the two platforms one return type - web's - so native kept marshalling
   * the whole snapshot back across the bridge for four call sites that all discarded it, long after
   * the duplicate write above had been removed for naming that very cost. This seam is the one
   * every caller wants; the per-platform save is the platform's own business.
   *
   * A caller that has to know which platform it is on in order to persist correctly is a caller
   * that will get it wrong; this is the seam that removes the question.
   *
   * CONCRETE IN `BaseMlsService`, and platforms supply only the write itself (`writeCheckpoint`),
   * because a checkpoint is not just a write: it is also the moment this device may declare how much
   * of its send ratchet is now durable. That count is read before the write and committed after it,
   * and the ordering is what makes a restored snapshot repairable at all - see `sendRatchetLedger`.
   */
  persistCheckpoint(): Promise<void>;
  /**
   * Reloads the persisted MLS state from disk into the in-memory engine (C2). Android-only:
   * while the app is backgrounded, a native JNI engine (Welcome/send/worker) may advance
   * `mls.bin`; without reloading on resume the warm in-memory state is stale and its next save
   * would clobber that advance (lost-update -> SecretReuse). No-op where there is no background
   * engine (web/desktop).
   */
  reloadStateFromDisk(): Promise<void>;
  /**
   * Returns the at-rest key this session actually initialised with, base64-encoded, or `null`
   * where the caller already holds it. Only the Tauri biometric path answers: it calls
   * {@link init} with an empty key and lets the native side resolve it from the platform
   * keystore, so the frontend - which encrypts every locally stored message with that same key -
   * ends up without it unless it asks.
   */
  resolveSessionDeviceKey(): Promise<string | null>;
  /**
   * Re-encrypts the in-memory MLS state with a new device key and persists it.
   * Must be called after the user successfully changes their PIN on the server,
   * so the stored state remains decryptable on the next login.
   */
  changeDeviceKey(newDeviceKeyB64: string): Promise<void>;
  /**
   * Forgot-PIN-elsewhere recovery: opens this device's local state with the OLD key
   * (non-destructively, nothing written) and marks the client initialised so a following login
   * reuses it. A refusal carries its typed cause: only `undecryptable` / `rotated` prove the old PIN
   * wrong; the others would refuse every PIN, so a caller must not word them as one.
   * The re-seal is a later {@link changeDeviceKey}.
   */
  openLocalStateWithKey(
    userId: string,
    deviceKeyB64: string,
    state: Uint8Array
  ): Promise<LocalStateOpenResult>;
  /**
   * Points the unattended unlock (platform keystore: biometrics, background push) at a new device
   * key, awaited. A no-op on web. Rejects when the keystore refused the write; resolves `true` when
   * an entry was written, `false` when there is no keystore (nothing moved).
   */
  pointUnattendedUnlockAt(newDeviceKeyB64: string): Promise<boolean>;
  /** Generates a fresh MLS KeyPackage for this device, signed with the device-key-encrypted identity key. */
  generateKeyPackage(deviceKeyB64: string): Promise<DatedKeyPackage>;
  /**
   * Purges the published KeyPackages (static fallback + one-time pool) and republishes
   * fresh ones from the current local keystore.
   *
   * Call this when we detect that our server-side KeyPackages no longer match our local
   * private keys (`NoMatchingKeyPackage` error while processing a Welcome): without it, the
   * inviter keeps re-adding in a loop with the same orphaned KeyPackage.
   */
  republishKeyMaterial(deviceKeyB64: string): Promise<void>;
  /**
   * Proactive reconciliation: lists the one-time prekeys published on the server, validates
   * locally which ones we still hold a private key for, and purges the orphaned ones from the
   * server (private key lost after a state reset/restore).
   *
   * Prevents a peer from consuming a KeyPackage we cannot honour - the cause of the
   * `NoMatchingKeyPackage` loop - instead of waiting for the failure. Best-effort, designed
   * to run in the background on connect.
   */
  reconcilePublishedKeyPackages(): Promise<void>;
  /**
   * Adds one device to a group via a STAGED MLS Add commit (C7-A unified regime): stages the
   * commit under the MLS lock, validates it server-side, merges on accept / rolls back on reject
   * (throws), broadcasts the commit, and returns the Welcome + post-merge ratchet tree for the
   * caller to deliver to the new device. `excludeDeviceIds` are skipped in the commit broadcast
   * (typically the inviter self and the invitee).
   *
   * The package is checked against `userId:deviceId`, the device it was fetched for, and against
   * the signature key pinned for that device on first sight; either refusal throws a
   * `DeviceTrustRefusedError` before anything is staged (`deviceTrust.ts`).
   */
  addMember(
    groupId: string,
    device: { keyPackage: Uint8Array; userId: string; deviceId: string },
    excludeDeviceIds?: string[]
  ): Promise<OneDeviceAddResult>;
  /**
   * {@link addMember} for a device whose leaf is STILL in the tree: removes that leaf and adds the
   * device back in ONE commit, so no epoch has the user out of the tree (no departure, see
   * {@link removalEpochs}). Same vetting, same typed refusal, same transaction.
   */
  replaceMember(
    groupId: string,
    device: { keyPackage: Uint8Array; userId: string; deviceId: string },
    excludeDeviceIds?: string[]
  ): Promise<OneDeviceAddResult>;
  /**
   * Whether a package may be added as `userId:deviceId`, staging nothing - the same check the Add
   * runs in Rust, taken BEFORE a destructive step (the removal of a stale leaf it would replace).
   */
  vetKeyPackage(
    keyPackage: Uint8Array,
    userId: string,
    deviceId: string
  ): Promise<KeyPackageVerdict>;
  /**
   * The identity (`userId:deviceId`) of the leaf of `groupId` carrying `keyPackage`'s signature
   * key, or `null` when no leaf does. Asked after an Add refused as a DUPLICATE SIGNATURE KEY: the
   * refusal says the key is in the tree, not whose leaf holds it, and assuming it is the identity
   * the package was fetched for would vouch for, or replace, a device on another device's key.
   * Throws for a group this device does not hold or a package it cannot read.
   */
  leafHoldingKeyOf(groupId: string, keyPackage: Uint8Array): Promise<string | null>;
  /**
   * The new devices (first sight or a changed key) recorded from merged signed commits since the
   * last call, oldest first; taking them forgets them. The new-device notices take them through
   * `setDeviceEventConsumer`.
   */
  takeDeviceEvents(): Promise<DeviceEvent[]>;
  /**
   * Registers who device events are handed to - after each drain, after this device's own Adds,
   * and once at registration for what the state already holds - or removes it with `null`. The
   * new-device notices (`deviceNotices.svelte.ts`) are the one consumer.
   */
  setDeviceEventConsumer(consumer: ((events: DeviceEvent[]) => Promise<void>) | null): void;
  /**
   * The pin of `userId:deviceId` - the signature keys this device has seen for it in a signed tree
   * it merged or joined (`DevicePin`) - or `null` for a device it never saw: THE SINGLE SOURCE OF
   * TRUST for "a key this device has seen", for any verifier of a device-key signature, since a key
   * the server published alone proves nothing against the server. `null`, and a contradiction with
   * an `anchored: false` pin, mean UNVERIFIED, never FORGED. See `BaseMlsService.pinnedSignatureKeys`.
   */
  pinnedSignatureKeys(userId: string, deviceId: string): Promise<DevicePin | null>;
  /**
   * The epochs at which this device saw `userId` leave `groupId`'s tree (its last leaf removed by a
   * merged commit, live or caught up), oldest first. Per USER, and only commits this device merged.
   * Empty means NOT SEEN, never "never happened". Never user-visible. See
   * `BaseMlsService.removalEpochs`.
   */
  removalEpochs(groupId: string, userId: string): Promise<number[]>;
  /**
   * Adds multiple devices to a group in a single STAGED MLS commit (C7-A unified regime): stages
   * the commit, validates server-side, merges on accept / rolls back on reject (throws), broadcasts
   * the commit (skipping `excludeDeviceIds`), and returns the Welcome + post-merge ratchet tree.
   * Devices already present in the group (e.g. a "ghost" member from a prior add whose
   * Welcome/commit failed to deliver) are silently skipped: `addedDeviceIds` may be a strict
   * subset of the input. If *every* device in the batch is already a member, the call rejects
   * with an error whose message contains `ALREADY_MEMBER` - callers should detect this and
   * recover (e.g. remove then re-add the affected user) instead of surfacing a raw crypto error.
   * Devices dropped because their KeyPackage was **invalid/undeserializable** (expired, wrong
   * ciphersuite, lost private key, corrupted bytes) are reported in `skipped` WITH a typed reason
   * (`SkippedKeyPackageReason`, classified in Rust) so the caller can surface a non-silent member
   * loss and say why instead of letting them disappear. [[C5]] A package whose credential does
   * not name `userId:deviceId`, or carries a key other than the one pinned for that device, is one
   * of those skips (`identity-mismatch`, `signature-key-changed`).
   *
   * `notAdmitted` names the devices the commit added to the tree that the commit gate did NOT record,
   * for a reason that makes their Welcome undeliverable (a device revoked while the Add was in
   * flight): they are NOT in `addedDeviceIds`, so a caller welcoming `addedDeviceIds` sends them none.
   */
  addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string; userId: string }>,
    excludeDeviceIds?: string[],
    /**
     * Set by a MEMBER'S INVITATION only: written into the commit's intent, so a kept commit that
     * does not land is re-planned rather than lost (`CommitIntent.invitation`).
     */
    invitation?: CommitInvitation,
    /**
     * Runs UNDER THE MLS LOCK, right before the stage, on the tree the commit is built on: a premise
     * a commit applied after the caller's own check could break is checked here, where nothing can
     * apply one in between. Throwing stages nothing.
     */
    beforeStage?: () => Promise<void>
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skipped: SkippedDevice[];
    notAdmitted: RefusedAdmit[];
  }>;
  /** Processes an incoming MLS Welcome message and returns the resulting group ID. */
  processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string>;
  /**
   * Encrypts an application message for the group and delivers it via the delivery service.
   *
   * `delivery` declares both whether the frame notifies and whether it is appended to the group's
   * shared log; the server sees only ciphertext and cannot work either out. Defaults to
   * {@link DELIVERY.visible}.
   */
  sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    messageId?: string,
    delivery?: FrameDelivery
  ): Promise<SentFrame>;
  /**
   * Decrypts and processes an incoming MLS message for the group, returning the plaintext with
   * mls-core's author-proof verdict, or null for a commit or a proposal.
   *
   * `envelope` is the sender the delivery server named for this frame. When given, it is checked
   * against the sender OpenMLS verified, and a disagreement throws a `SenderMismatchError`: the
   * frame is decrypted and consumed, and nothing of it is shown (channel-encryption section 21.1,
   * WP-G2-1b).
   */
  processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array,
    envelope?: EnvelopeSender
  ): Promise<DecryptedApplication | null>;
  /**
   * Decrypts a page of ciphertexts in ratchet order with a single WASM crossing when available.
   * Per-message failures are returned in the result vector instead of aborting the batch.
   */
  processIncomingMessagesBatch?(
    groupId: string,
    messages: Uint8Array[]
  ): Promise<MlsBatchProcessResult[]>;
  /**
   * Opens a paged decrypt session for one group's history catch-up (ratchet order preserved).
   * Web runs it off-thread via a persistent worker; Tauri / disabled-worker decrypt sequentially
   * on the live client. The caller feeds pages then calls {@link MlsDecryptSession.finish}.
   */
  createDecryptSession(groupId: string): Promise<MlsDecryptSession>;
  /**
   * Runs `fn` while holding the global MLS client mutex, so callers that interleave network
   * I/O with WASM operations (e.g. the Welcome handler) can keep their WASM critical section
   * exclusive without holding the lock across their network preamble.
   */
  runUnderMlsLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Exports a derived secret from a group's epoch key material using the given label and context. */
  exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;

  // Networking
  /**
   * Opens a WebSocket connection to the chat gateway under this device's current id, queued behind
   * any open in flight. The caller fetches the token, so a refused refresh is the caller's
   * `SessionExpiredError` and never an unauthenticated open (Tauri, proxies and ITP need it in the URL).
   * `fence` is {@link socketFence}, read BEFORE that token fetch: a pause landing during the fetch
   * makes the open settle as `GatewayOpenAbandonedError`, opening nothing.
   */
  connect(token: string, fence: number): Promise<void>;
  /** The socket fence a caller of {@link connect} reads before its token fetch; moved by every pause. */
  socketFence(): number;
  /**
   * Resolves once every socket open queued so far has run - including the reopen a device identity
   * rotation queues - and rejects with the last one's own failure. The post-connect half of a
   * connection waits here so it runs on the socket that carries this device's CURRENT id.
   */
  gatewaySocketSettled(): Promise<void>;
  /**
   * Declares this client able to interpret an inbound frame, and replays everything the socket
   * collected before it was.
   *
   * THE SOCKET IS ALLOWED TO OPEN BEFORE THE MLS STATE IS LOADED - the handshake needs a device id
   * and a token and nothing else - so every frame that arrives in that window is HELD in arrival
   * order rather than routed into a client that cannot decrypt it. This call is what ends the
   * window, and the login is the only caller that can honestly make it: it is the only place that
   * knows both the MLS client and the inbound pipeline exist. Awaiting it matters, because a
   * Welcome and the Commit behind it may only be processed in the order they arrived.
   *
   * Idempotent, and silent when nothing was held.
   */
  markInboundReady(): Promise<void>;
  /** True when the live gateway WebSocket is open (used for reconnect watchdog). */
  isWsOpen(): boolean;
  /** Fetches all registered devices (with KeyPackages) for the given user. Throws on transport/HTTP failure; `[]` only when the user genuinely has no active device. */
  fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      /** The `userId` asked for, carried so an Add can check each package names this device. */
      userId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  >;
  /**
   * Fetches one device's KeyPackage when it is missing from {@link fetchUserDevices} (e.g. 30-day
   * list filter).
   *
   * NEVER `null`: a 404 and an unreachable server are different facts and exactly one of them says
   * anything about the device. See {@link DeviceKeyPackageAnswer}.
   */
  fetchDeviceKeyPackage(userId: string, deviceId: string): Promise<DeviceKeyPackageAnswer>;
  /** Every signature key the device published (`GET ./signature-keys`), for a v2 endorsement. */
  fetchDeviceSignatureKeys(userId: string, deviceId: string): Promise<DeviceSignatureKeys>;
  /** Uploads a single KeyPackage to the server so other devices can invite this one. */
  publishKeyPackage(keyPackage: DatedKeyPackage): Promise<void>;
  /** Bulk-upload multiple one-time prekeys to the server pool. */
  publishKeyPackages(packages: DatedKeyPackage[]): Promise<void>;
  /** Delivers a Welcome message to the target user/device via the delivery service. */
  sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void>;
  /** Returns the current MLS epoch number for a group (needed for epoch-gating). */
  getEpoch(groupId: string): number;
  /** Registers a user as a member of a group on the delivery service (server-side membership tracking). */
  registerMember(groupId: string, userId: string): Promise<void>;
  /** Acquires a distributed Redis lock to prevent concurrent MLS commits on the same group.
   *  Returns true if acquired, false if another device already holds the lock. */
  acquireAddLock(groupId: string): Promise<boolean>;
  /** Releases the lock acquired via acquireAddLock. */
  releaseAddLock(groupId: string): Promise<void>;
  /**
   * Fetches one Redis Stream history page for a group, optionally starting after a given stream
   * entry ID. Pass the first page's `head` back as `until` to keep the walk bounded to the rows
   * that existed when it started - see {@link import('./historyTypes').HistoryPage}.
   */
  fetchHistory(
    groupId: string,
    afterStreamId?: string,
    /** Optional page size override (server clamps). */
    limit?: number,
    /** Inclusive upper bound: the `head` returned by the first page of this walk. */
    until?: string
  ): Promise<import('./historyTypes').HistoryPage>;
  /**
   * Fetches the first page of history for multiple groups in one HTTP round-trip.
   * Groups the caller cannot read return an empty page.
   */
  fetchHistoryBatch?(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('./historyTypes').HistoryPage>>;
  /**
   * Rung-1 replay: fetches the ordered, CONTIGUOUS commits this device missed
   * (`baseEpoch >= sinceEpoch`) so a gap can be healed by re-applying them instead of dropping local
   * state. `activeEpoch` is the epoch to reach after replay.
   *
   * Two terminating answers, and the caller owes rung-2 (re-Welcome) on either: `belowFloor` when
   * the intermediate commits were pruned, `gapAt` when an epoch inside the range was never recorded
   * at all - `commits` then carries only the applicable prefix.
   */
  fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
    gapAt?: number;
  }>;
  /**
   * Resubmits every commit of this device whose outcome is unknown (`commitSubmission.ts`) - or
   * only those of `groupIds` - and merges or clears each on the gate's answer. One with no answer
   * yet stays kept and pending in the MLS state. Takes the MLS lock itself, so it must never be called holding it.
   * Called after the gateway connects and before the pending messages are drained.
   */
  settleUnresolvedCommits(groupIds?: string[]): Promise<void>;
  /**
   * Settles this device's unresolved commit of `groupId` from the server's commit log, as a replay
   * reads it: `commitAtBase` is the log's row at the commit's base epoch (`null` when it has none,
   * which decides nothing). Our bytes there -> merged (and an Add's Welcome delivered); another
   * device's -> cleared; a staged commit that was never submitted -> cleared. No lock: the caller
   * holds the client, as it does for the replay itself.
   */
  settleUnresolvedCommitFromLog(
    groupId: string,
    commitAtBase: string | null
  ): Promise<'none' | 'merged' | 'cleared' | 'undecided'>;
  /**
   * Registers who re-plans a member's invitation whose KEPT commit did not land, or removes it
   * (`null`, sign-out). The settlement records such an invitation before clearing its stage
   * (`owedInvitations.ts`) and hands it over - at once in session, and at the next connection's
   * settlement for an entry a previous session left. Without a re-planner the entries wait.
   *
   * @param tellUnrecorded - tells the member, by the conversation's name, of an invitation that
   *   could not even be RECORDED; one met before it is registered is told when it is.
   */
  setOwedInvitationReplanner(
    replanner: OwedInvitationReplanner | null,
    tellUnrecorded?: UnrecordedInvitationTeller | null
  ): void;
  /**
   * Commits were APPLIED to `groupId` - by a replay of the commit log (`attemptCommitReplay`), the
   * one path that applies commits outside the frame queue. A lost invitation waiting on the group
   * (its tree unconfirmed, another device's Add holding the lock) is re-planned.
   */
  notifyCommitsApplied(groupId: string): void;
  /**
   * Refreshes the server-stored GroupInfo (external-join base) at the current epoch. Best-effort:
   * called after every commit (a new group's first member-add is itself a commit) so a member lacking
   * state can self-join. [[Phase 4]]
   */
  refreshGroupInfo(groupId: string): Promise<{ stored: boolean; baseEpoch: number } | null>;
  /**
   * Attempts to (re)join `groupId` via an external commit built from the stored GroupInfo, without a
   * peer Welcome (self-service recovery). The outcome is a TYPE, not a boolean: see
   * {@link ExternalJoinOutcome} for why each refusal has to reach its caller distinguishable.
   */
  externalJoin(groupId: string): Promise<ExternalJoinOutcome>;
  /**
   * Declares `groupId` to be the Graine key-distribution group of `scope`, so every later decision
   * that differs for it is taken from a registered fact rather than rediscovered.
   */
  registerDistributionGroup(scope: DistributionScope, groupId: string): void;
  /** True when `groupId` carries channel seeds and must never reach the conversation pipeline. */
  isDistributionGroup(groupId: string): boolean;
  /**
   * Whether `groupId`'s external-join base is arbitrated, which "held locally" does not answer.
   *
   * False only while this device is creating the group and the server has not yet said whether its
   * base won the first-publish race. A group in that state is in `getLocalGroups()` and may still
   * be discarded, so anything minted against it dies with it - see `distributionEpochFor`.
   */
  isDistributionBaseSettled(groupId: string): boolean;
  /**
   * Records that a group IS a distribution group when the server says so but its scope cannot yet
   * be named - a private salon's group whose community this session has not loaded.
   *
   * Separate from {@link registerDistributionGroup} because the two answer different questions, and
   * conflating them made the answerable one wait on the unanswerable one.
   */
  noteDistributionGroup(groupId: string): void;
  /**
   * Leaves a scope's key-distribution group - the MLS tree and the registration together - and
   * returns the group left, or null when this device held none. The counterpart of
   * {@link ensureDistributionGroup}: without it, a community or salon that leaves this device keeps
   * delivering seeds to it.
   */
  forgetDistributionGroup(scope: DistributionScope): Promise<string | null>;
  /**
   * The same, named by the GROUP rather than by the scope. Returns whether anything was held.
   *
   * Two entry points because they answer two different questions, and one of them cannot be asked
   * through the other: {@link forgetDistributionGroup} resolves the group through the scope
   * registration, so it can only forget what that registration already names - and the state worth
   * forgetting is precisely one where the two have drifted apart. The server names the group; this
   * takes that name.
   */
  forgetDistributionGroupById(groupId: string): Promise<boolean>;
  /** The distribution group registered for `scope`, or null when none is. */
  distributionGroupFor(scope: DistributionScope): string | null;
  /** Every scope this device currently holds a distribution group for. */
  distributionScopes(): DistributionScope[];
  /**
   * Wires where distribution-group GroupInfo is fetched from and published to (social-service).
   * Injected rather than imported so the MLS layer never learns to speak to the communities API.
   */
  setDistributionGroupInfoTransport(transport: DistributionGroupInfoTransport | null): void;
  /** Wires what decrypted key-distribution frames are handed to. Set once, at startup. */
  onDistributionFrame(handler: DistributionFrameHandler | null): void;
  /**
   * Wires the durable half of the key-distribution registry: every registration is written to it
   * and every forget deletes from it. Set once per session, before {@link hydrateDistributionGroups};
   * `null` at logout.
   */
  setDistributionGroupStore(store: DistributionGroupStore | null): void;
  /**
   * Restores the key-distribution registry from the wired store, BEFORE the first drain.
   *
   * THE DRAIN ROUTES THE BACKLOG, AND ROUTING NEEDS THIS FACT: without it every frame on a key group
   * takes the conversation path, finds no conversation and is refused - on every load. Each row is
   * ALLOWLISTED by the local MLS state: a row for a group this device no longer holds is deleted,
   * never registered, so a stale row can only cost a start-up read and never mis-route a frame.
   */
  hydrateDistributionGroups(): Promise<void>;
  /**
   * Resolves once the FIRST pull of this session has emptied the mailbox and the scheduler has
   * applied it - never on a pull that failed half-way, whose rows are still on the server.
   *
   * One-shot, and never resolved by a clock: an offline start-up simply keeps it pending until the
   * reconnect's pull lands. It is the fact a verdict about a group's epoch needs - before it, "behind"
   * may only mean "its commits are still queued".
   */
  whenInitialDrainSettled(): Promise<void>;
  /**
   * Compares a HELD key group's local epoch with the server's `activeEpoch` once the initial drain
   * has settled, and replays the commits it is missing when it is behind.
   *
   * Scheduled, never awaited by the loader: the answer needs the drain, and the community loop must
   * not wait on it. A behind group is marked in the epoch-gap registry for the whole of the catch-up,
   * which is what keeps a seed or a request from being sealed at the stale epoch
   * (`distributionEpochFor`). The outcome reaches {@link onDistributionGapVerdict}.
   *
   * @returns `current` when the group was not behind, else the verdict.
   */
  verifyDistributionEpoch(
    groupId: string,
    activeEpoch: number
  ): Promise<'current' | DistributionGapVerdict>;
  /**
   * Resolves once nothing about `groupId`'s epoch is still being established: the initial drain has
   * settled and any {@link verifyDistributionEpoch} in flight for it has answered. What a request
   * about to be sealed on that group waits for, so it is never sealed at an epoch the group leaves.
   */
  whenDistributionEpochSettled(groupId: string): Promise<void>;
  /** Wires who is told each {@link DistributionGapVerdict}. Set once, at startup; `null` at logout. */
  onDistributionGapVerdict(listener: DistributionGapListener | null): void;
  /**
   * Joins the scope's key-distribution group whatever state it is in - held already, published and
   * joinable, or not yet initialised (this device then creates it).
   *
   * `activeEpoch` is required, not optional: a published base behind it cannot be joined from at all
   * and the caller has to be able to tell that apart from a lost race. The answer is the same
   * {@link ExternalJoinOutcome} for the same reason.
   */
  ensureDistributionGroup(
    scope: DistributionScope,
    ref: {
      groupId: string;
      groupInfo: string | null;
      baseEpoch: number | null;
      activeEpoch: number;
    }
  ): Promise<ExternalJoinOutcome>;
  /**
   * Decrypts a frame that arrived on a key-distribution group and hands it to the Graine handler.
   * Returns whether the frame may be acknowledged.
   */
  routeDistributionFrame(
    groupId: string,
    sender: string,
    ciphertext: Uint8Array,
    senderDeviceId?: string
  ): Promise<boolean>;
  /** Returns the unique device ID assigned to this MLS instance. */
  getDeviceId(): string;
  /**
   * Resolves (or generates and persists) this device's stable per-user id WITHOUT
   * decrypting MLS state. Safe to call before {@link init}, so the PIN can be verified
   * against the real deviceId before any state decryption / fresh-start runs.
   */
  resolveDeviceId(userId: string): Promise<string>;
  /** Fetches messages queued on the delivery service that were not yet delivered
   * (e.g. during a disconnect). Should be called after every connect/reconnect. */
  fetchPendingMessages(): Promise<void>;
  /**
   * Resolves when this device's mailbox is empty - nothing left to fetch, nothing left to apply.
   *
   * `caller` NAMES THE CALL SITE, and it is required because the two states this barrier refuses are
   * both defects in the CALLER, not in the barrier: taken from inside a catch-up it can never
   * resolve, and taken before the inbound pipeline exists it fills a queue nothing can drain. Both
   * are reported as errors, and an error that cannot say who earned it sends its reader through
   * every call site by hand - which is exactly what one `SKIPPED` line on W1 cost on 2026-08-15.
   *
   * `catchUpGroupId` IS THE ONE FACT THAT SEPARATES A DEADLOCK FROM A WAIT, and it is required for
   * the same reason: it is known at the call site and nowhere else. It is NOT "which group this call
   * is about" - it is "the group whose catch-up session this stack could be running INSIDE". Only
   * that session can fail to release, because the stack that would close it is the one waiting here;
   * anybody else's closes on its own and this barrier merely waits longer, which is all the caller
   * ever asked for.
   *
   * Pass `null` when the call site cannot be inside a session at all - a connection edge, a
   * visibility change, a click, or a leg deferred past the drain - and a group id when it can.
   */
  waitForMessageQueueIdle(caller: string, catchUpGroupId: string | null): Promise<void>;
  /**
   * The same barrier scoped to ONE conversation: its frames are applied and none of its is parked.
   *
   * **It answers a different question and it is the right one for anything that describes a single
   * group.** The whole-mailbox barrier means "I have applied everything", which is proportional to
   * the size of the account - measured at 189 s on a device rejoining twenty-nine conversations,
   * which is how long a peer waited for a digest of ONE of them. Frames for the other twenty-eight
   * cannot change that group's manifest.
   *
   * The untagged bucket is waited for too, because nothing here can say which group an untagged
   * frame belongs to. Use the whole-mailbox barrier where the answer depends on the WHOLE store -
   * an outbox flush, a re-encrypted bundle whose epoch depends on every commit applied.
   */
  waitForGroupQueueIdle(caller: string, groupId: string): Promise<void>;
  /**
   * Whether this device has merged everything the server holds for `groupId`, as a FACT read now,
   * never waited for: the last pull listed the whole mailbox, no pull is running, the socket that
   * pull was trusted with is still open, and the scheduler holds nothing of the group (nothing
   * queued, parked or being applied). `false` is "not known to be drained", never "behind".
   *
   * For a decision that must not be taken on a group state the server may still be holding commits
   * for - the admission gate's first observation of a voucher (channel-encryption section 25). It
   * reads the evidence {@link waitForGroupQueueIdle} and {@link waitForMessageQueueIdle} stand on.
   */
  isGroupDrained(groupId: string): boolean;
  /**
   * Resolves the first time {@link isGroupDrained} holds for `groupId` - at once when it holds now.
   *
   * AN EVENT, NEVER A POLL: it is re-checked only where a piece of that evidence can change - the
   * scheduler finishing a frame of the group, and a pull ending. Never await it inside a frame of
   * the group itself: that frame is the group's current work, so the group cannot be drained until
   * it returns. A caller chains on it instead (the admission gate's parked asks, section 25).
   *
   * @throws {GroupDrainAbandonedError} (as a rejection) when the service is destroyed first.
   */
  whenGroupDrained(groupId: string): Promise<void>;
  /**
   * Tells the service the local conversation store is now authoritative.
   *
   * A frame that arrived before the restore finished was left in the server queue with nothing to
   * render it into. This is the event that discharges it - the answer changed, so the ask is worth
   * repeating. Free and silent when nothing was left behind.
   */
  notifyConversationsRestored(): void;

  /**
   * Tells the service every stored conversation now has a ROW, though none has its history yet.
   *
   * THE EARLY HALF OF {@link notifyConversationsRestored}. A frame refused as absent-conversation
   * only lacked the row to land in, and the restore's first phase creates every row it will ever
   * create - synchronously, before any history is read. Waiting for the end of the second phase
   * (seconds of history replay on a cold start) delayed the very message a notification opened the
   * app for by that much, measured at ~1.2 s on the bench phone. What makes asking this early safe
   * is the order the second phase keeps with a live delivery: the pull is announced in the same
   * tick, so each archive replay waits for it at its barrier and skips what it decrypted, and every
   * later write of a row MERGES into it rather than replacing it.
   */
  notifyConversationRowsSeeded(): void;

  /**
   * One conversation now EXISTS locally, so any frame buffered for it can be asked for again.
   *
   * THE PER-GROUP HALF OF {@link notifyConversationsRestored}, and the half a device joining a group
   * it has never had needs. The boot restore reads the LOCAL store, so it can only produce
   * conversations this device already knew about; one created while the device was away appears
   * later, from discovery, when that one-shot trigger is long past. A frame that arrived in between
   * is left in the server queue with nothing scheduled to collect it.
   *
   * Every path that creates a row calls it: discovery, the redelivered Welcome of a group held with
   * no row, the push-cache merge on resume - and the gap healer, which leaves a live frame
   * `behind-refused-backlog` and asks for the backlog it waits behind.
   */
  notifyConversationAvailable(groupId: string): void;

  // Group management
  /** Returns the list of group IDs for which this device holds local MLS state. */
  getLocalGroups(): string[];
  /**
   * Whether this device is still a member of the group.
   *
   * False exactly when a Remove commit naming its own leaf has been applied. Distinct from
   * `holdsGroupState` ([groupUsability](../utils/chat/groupUsability.ts)), which stays TRUE after an
   * eviction: the state is still held, it is simply no longer usable - and reading the second as the
   * first is what let the outbox retry an evicted group until its entries expired.
   *
   * THROWS when the group is not held at all: never-joined and removed-from are opposite facts,
   * and the caller that retires a conversation on `false` must not retire one it never had.
   */
  isGroupActive(groupId: string): Promise<boolean>;
  /** Drops the local MLS state for a group, forcing re-synchronisation via a new Welcome.
   *  `minEpoch`: minimum epoch the new Welcome must reach (0 = no restriction). */
  forgetGroup(groupId: string, minEpoch?: number): void;
  /** Notifies the server that this device is leaving a group unrecoverably.
   *  Deletes the DeviceGroupMembership and removes the device from Redis routing. */
  forceLeaveGroup(groupId: string): Promise<void>;
  /** Updates the display name of a group on the delivery service. */
  renameGroup(groupId: string, name: string): Promise<void>;
  /** Sets (or clears, with mediaId=null) the group's avatar on the delivery service. */
  setGroupImage(groupId: string, mediaId: string | null): Promise<void>;
  /**
   * Deletes a group and all its messages from the delivery service. Resolves only on the delivery
   * service's own JSON 2xx; every other answer throws, a 404 included (the route never sends one).
   */
  deleteGroupOnServer(groupId: string): Promise<void>;
  /** Removes a user from the server-side membership list of a group (no MLS commit). */
  removeMemberFromServer(groupId: string, userId: string): Promise<void>;
  /**
   * A member's Decline of an invitation-link ask: withdraws the person's seat only while it still
   * awaits a member, never the seat of someone another member's Add admitted (`JoinDeclineOutcome`).
   */
  declineJoinRequest(groupId: string, userId: string): Promise<JoinDeclineOutcome>;
  /** Performs a real MLS remove commit for all devices of the given user(s) and broadcasts it. */
  removeMember(groupId: string, userIds: string[]): Promise<void>;
  /**
   * Performs a real MLS remove commit for specific devices by identity ("userId:deviceId") and
   * broadcasts it. The revoked-leaf collector's commit: staged only when this device's context is
   * the base the server publishes, else it throws `UnpublishedBranchError` having staged nothing.
   */
  removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void>;
  /**
   * Every leaf identity (`userId:deviceId`) in the group's MLS ratchet tree, read locally.
   *
   * THE TREE IS THE ONLY AUTHORITY ON WHO CAN READ A GROUP. {@link getGroupMembers} answers who
   * the delivery service will ROUTE to, which is a different question: it can be empty for a group
   * whose tree is full (a device fresh-start clears its rows), and a community's key-distribution
   * group has no user-level rows at all by construction. A decision to remove a leaf reads THIS.
   *
   * Throws when this device does not hold the group - an empty tree and an absent group are
   * opposite facts, and conflating them would read "nobody is left" off a group never joined.
   */
  getGroupMemberIdentities(groupId: string): Promise<string[]>;
  /**
   * The signature key the TREE of `groupId` holds for the leaf `identity` (`userId:deviceId`), or
   * `null` when no leaf carries it. What a Graine v2 endorsement is checked against
   * (channel-encryption section 21): the key every member of the key group already agreed on.
   *
   * Throws when this device does not hold the group, for the reason
   * {@link getGroupMemberIdentities} does: an absent leaf and an absent group are opposite facts.
   */
  memberSignatureKey(groupId: string, identity: string): Promise<Uint8Array | null>;
  /**
   * The clean run covering `groupId`'s CURRENT epoch (`mls-core/src/graine_run.rs`): what Graine's
   * outbound rotation reads to decide whether a session may outlive an epoch move. The run ends on
   * any removal and on a new user, and is kept in the MLS state beside the tree it describes.
   *
   * Throws when this device does not hold the group.
   */
  graineRun(groupId: string): Promise<GraineRunReading>;
  /** Graine v2's Ed25519 operations, from this platform's engine (`mls-core`, never WebCrypto). */
  graineSignatureEngine(): GraineSignatureEngine;
  /**
   * Signs `message` with THIS device's MLS credential key - the key its leaf in every group
   * carries. What a Graine v2 endorsement is (channel-encryption section 21): a member checks it
   * against that leaf, so no new key has to be distributed or trusted.
   */
  signWithDeviceCredential(message: Uint8Array): Promise<Uint8Array>;
  /**
   * This device's own credential signature key, public half - the key its leaves and KeyPackages
   * carry, and the one a member is shown when asked to add it. Throws before the engine is ready.
   */
  ownSignatureKey(): Promise<Uint8Array>;
  /**
   * Hands over the fork findings mls-core recorded since the last call, and forgets them
   * (`mls-core/src/fork_check.rs`): frames whose signed epoch fingerprint was not this device's at
   * the same epoch. Asked after a same-epoch refusal, where a fork is seen.
   */
  takeForkFindings(): Promise<ForkFinding[]>;
  /** Returns the (userId, deviceId) pairs currently in a group. Throws on transport/HTTP failure; `[]` only for a genuinely empty group. */
  getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]>;
  /** Returns user-level membership (dm_group_members) for `groupId`. Throws on transport/HTTP failure; `[]` only for a genuinely empty group. */
  getGroupUserMembers(groupId: string, opts?: { fresh?: boolean }): Promise<GroupUserMemberRow[]>;
  /**
   * The roster of `groupId` with the seat generation the server read before it - a member's
   * invitation's baseline, the number its Add carries so a Decline or a removal made after the member
   * decided holds against it. `seatGeneration: null` from a server older than it. Throws like
   * {@link getGroupUserMembers}.
   */
  getGroupRosterAtGeneration(groupId: string): Promise<GroupRosterAtGeneration>;
  /**
   * The windows during which each current member of `groupId` was out of it, from
   * `GET /api/mls/groups/:groupId/exclusions`. Throws on any failure: a history answer that cannot
   * read them sends nothing (see `historyEntitlement.ts`). `forUserId` only shares the request with
   * {@link getGroupWithheld} asked for the same person.
   */
  getGroupExclusions(groupId: string, forUserId?: string): Promise<GroupExclusions>;
  /**
   * What this device's user, and `forUserId` when given, may never be handed in `groupId`: their gaps
   * and, in a group conversation, everything before their first arrival. Nobody else is named. A
   * person the server counts always has an entry, an empty one included - so a missing key means
   * "not counted", never "nothing withheld". Same failures as {@link getGroupExclusions}.
   */
  getGroupWithheld(groupId: string, forUserId?: string): Promise<GroupExclusions>;
  /**
   * Whether the delivery service routes a history answer ADDRESSED to one device of a conversation
   * (`addressedAnswers` on the same exclusions read - step A,
   * docs/wiki/protocols/history-answer-addressing.md). `false` from a server that predates it, which
   * is an ordinary state while a store build runs ahead of production. Same failures as
   * {@link getGroupExclusions}, and asked with the same `forUserId` it shares that one request.
   */
  getAddressedAnswersSupported(groupId: string, forUserId?: string): Promise<boolean>;
  /**
   * The user-level rosters of many groups in one read (`POST /api/mls/group-rosters`). Never throws:
   * a group it did not answer is absent from both sets, and nothing is decided for it.
   */
  getGroupRosters(groupIds: string[]): Promise<GroupRosterBatch>;
  /** Returns all groups the given user belongs to according to the delivery service. */
  getUserGroups(userId: string): Promise<UserGroupRow[]>;
  /** Fetches server metadata for one group (name, soft-delete tombstone). */
  getGroupMeta(groupId: string): Promise<GroupMeta | null>;
  /**
   * Statut serveur d'un groupe en distinguant l'absence CONFIRMEE (`'absent'` : ligne `dm_groups`
   * gone) from network uncertainty (`'error'`) and from existence (`GroupMeta`: live group,
   * deleted tombstone, or exclusion). Used by discovery so it only auto-deletes a conversation
   * on a confirmed absence.
   */
  getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta>;
  /** Lists the groups this user dismissed (manual deletion/leave, propagated to all their devices). */
  getDismissedGroups(): Promise<string[]>;
  /** Marks a group as dismissed (manual deletion/leave) - propagates the purge to the other devices. */
  dismissGroup(groupId: string): Promise<void>;
  /** Lifts a group's dismiss (re-add via Welcome). */
  undismissGroup(groupId: string): Promise<void>;

  // DeviceGroupMembership tracking
  /** Get all pending device-group invitations in groups where this device is a full member */
  getPendingInvitations(userId: string, deviceId: string): Promise<PendingInvitationRow[]>;
  /**
   * Get all device-group memberships for the current device, each with its status.
   *
   * REJECTS when the server could not be asked - `[]` means "no row", never "I could not tell".
   * See the implementation for why one caller cannot live with the two collapsed.
   */
  getDeviceMemberships(userId: string, deviceId: string): Promise<DeviceMembershipRow[]>;
  /** Update the status of a device-group membership on the server */
  updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void>;

  /** Reset a specific device in a group to pending (after MLS remove commit for that device). */
  kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void>;

  /** Delete a specific device-group membership */
  deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }>;

  /** Delete ALL device-group memberships for a device */
  deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }>;

  /**
   * Completely delete a device from the user's account (groups + KeyPackages + push token) and ban
   * its id. Without `reason` the ban is the OWNER's revocation; `'retired'` is said only for an id
   * this install's own rotation abandoned.
   */
  deleteDevice(
    userId: string,
    deviceId: string,
    reason?: 'retired'
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }>;

  /** Update a device metadata (label and/or OS) */
  updateDeviceMetadata(
    userId: string,
    deviceId: string,
    metadata: { deviceName?: string; deviceOs?: string; deviceAppVersion?: string }
  ): Promise<{
    status: string;
    deviceName: string | null;
    deviceOs: string | null;
    deviceAppVersion: string | null;
  }>;

  // Callbacks
  /** Optional hook called when the gateway delivers a channel-level event (member join/kick, rename, delete). */
  onChannelEvent?: (event: { type: string; data: unknown }) => void;
  /** Registers a callback invoked for every incoming MLS message received over the WebSocket. */
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
  ): void;
  /** Registers a callback invoked when the WebSocket connection is lost. */
  onDisconnect(callback: () => void): void;
  /** Registers a callback invoked after a Welcome message has been successfully processed. */
  onWelcomeProcessed(callback: (groupId?: string) => void): void;

  /**
   * Registers an observer of the bulk-ingest window lifecycle. Observers are notified in
   * registration order on both open ({@link beginBulkIngest}) and close ({@link endBulkIngest}).
   * Each subscriber reacts in its own way (deferred MLS state persistence, UI render buffering);
   * none multiplexes the others' parameters.
   */
  addBulkIngestObserver(observer: BulkIngestObserver): void;

  /**
   * Opens a bulk-ingest window with the given {@link BulkIngestPhase} and returns the handle that
   * closes it. Pair with {@link endBulkIngest}; prefer the {@link withMlsBulkIngest} helper which is
   * exception-safe. The encrypted checkpoint coalesces to one flush when the last open window
   * closes. Omitting `phase` opens a persistence-only window (no UI buffering, no overlay) - the
   * default for {@link withMlsBulkIngest}.
   */
  beginBulkIngest(phase?: BulkIngestPhase): BulkIngestHandle;
  /**
   * Closes the window `handle` names, replaying the exact {@link BulkIngestPhase} it was opened
   * with. Resolves only after every observer has been told.
   *
   * BY HANDLE, NOT "THE INNERMOST": windows OVERLAP, they do not only nest. The restore, a drain
   * and a selected conversation's history load each open one, and a history load that opened
   * during a drain and outlived it used to be the window the drain's close ended - the persist-only
   * phase was replayed instead of the drain's UI one, so the drained message stayed in the UI
   * buffer until the history load closed, ~0.6 s later on the bench phone (2026-10-12).
   */
  endBulkIngest(handle: BulkIngestHandle): Promise<void>;

  /**
   * Announce to all online members of `groupId` that this device needs a Welcome.
   * Called once per pending group on connect, after KeyPackage publication.
   */
  sendWelcomeRequest(groupId: string): Promise<void>;

  /**
   * Ask one online member to republish `groupId`'s external-join base.
   *
   * THE FAVOUR THAT MATCHES THE REFUSAL, and NOT a variant of the Welcome above. `externalJoin`
   * answers `stale_base` when the published GroupInfo names an epoch the group has left - a refusal
   * no retry can satisfy, because only a member holding the tree can mint a new base. A Welcome
   * mutates the tree, takes the add lock and replays the duplicate-leaf race; a refresh is a
   * read-only publish that takes no lock and changes no epoch. Asking for the second is what lets a
   * device go back to serving itself.
   *
   * THE ANSWER IS RETURNED, AND ASKING AGAIN WHILE NOTHING HAS CHANGED IS NOT A RETRY, IT IS THE
   * SAME QUESTION. `no_peer_online` means the server read the roster and found nobody to publish
   * to; re-asking a minute later can only produce that same answer until some member's state
   * moves. See {@link BaseRefreshOutcome}.
   */
  sendBaseRefreshRequest(groupId: string): Promise<BaseRefreshOutcome>;

  /**
   * Register a callback invoked when this device is the member elected to republish a group's
   * external-join base. Read-only for the tree.
   */
  onBaseRefreshRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void;

  /**
   * Register a callback invoked when another device broadcasts a welcome_request
   * for a group this device is a member of.
   */
  onWelcomeRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void;

  /**
   * Register a callback invoked when the server tells this device, while it is connected, that its
   * owner has revoked it. Distinct from the revocation discovered when enrolling: there is no fresh
   * identity to continue under here, so the session ends and the device is wiped.
   */
  onDeviceRevoked(callback: () => void): void;

  /**
   * Asks the server whether the named device is denylisted. `false` when the question cannot be
   * reached. Ids are explicit because the answer gates a wipe and must not depend on init order.
   */
  isDeviceRevoked(userId: string, deviceId: string): Promise<boolean>;

  /**
   * Ask the server to elect ONE online member to reconcile a conversation's history with us. The
   * ask itself travels inside MLS (a state key, a digest or a range); this only decides who answers.
   * Best-effort, online-only.
   *
   * `exclude` lists member keys already heard from, so a coverage chase walks its members instead of
   * re-drawing the one that just said it cannot cover the range - see `historyReconcile.ts`.
   */
  sendHistoryRequest(
    groupId: string,
    opts?: { exclude?: string[] }
  ): Promise<HistoryRequestOutcome>;

  /**
   * Register a callback invoked when this device is the member elected to answer a history_request.
   * What is actually being asked arrives separately, over MLS - see `handleHistoryRequest`.
   */
  onHistoryRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void;

  /**
   * Send a `disconnect` control frame over the WebSocket so the gateway
   * removes the presence key immediately (instead of waiting for TTL / heartbeat
   * miss). Call this in `beforeunload` or when the app is intentionally closed.
   * No-op if the socket is not open. A backgrounded app calls {@link pauseSocket} instead, which
   * sends the same frame and also lets go of the socket.
   *
   * IT DOES NOT NEED A COMPANION THAT CLOSES AT UNLOAD. One was added on 2026-08-15 (`closeForUnload`,
   * spending `1001 - going away` so a dying document would stop reporting `1006`) and removed the
   * same day, measured inert on both sides at once: the gateway matches `disconnect` with
   * `handle_disconnect(...); break`, leaving its read loop before any close frame can be read - 0
   * `Client closed connection` lines against 12 explicit disconnects over 25 minutes of production
   * traffic - and the page's own `CloseEvent` reports `1006` either way, because a closing handshake
   * needs a reply from the server and the document is gone before one can arrive. The `1006` a
   * browser console shows at a navigation is a property of unloading, not a defect to be fixed.
   */
  sendDisconnect(): void;

  /**
   * Sends the `disconnect` frame, then lets go of the socket WITHOUT reporting a disconnection -
   * what `pauseConnectionImpl` asks of a backgrounded app.
   *
   * THE GATEWAY HAS ALREADY LET GO OF IT. It answers `disconnect` with `handle_disconnect(...);
   * break`, so it stops reading the socket the moment the frame lands. Keeping the client half
   * alive after that, which is what a bare `sendDisconnect` used to do here, kept its heartbeat too:
   * every ping went unanswered, and 32 s later the zombie watchdog closed it and reported a
   * disconnection - which the reconnect ladder answered by reconnecting a BACKGROUNDED app. Measured
   * on a Mi 9T, 2026-10-01: that reconnection pulled the incoming row a reply had just answered from
   * the shade, and its banner came back 2.5 s after the reply. A paused socket has no watchdog because
   * a paused socket does not exist; the next foreground transition opens a new one.
   *
   * IT ALSO FENCES THE SOCKET QUEUE: an open still in flight is settled at once as abandoned
   * (`GatewayOpenAbandonedError`), and no step queued before the pause - the reopen a device identity
   * rotation asks for included - assigns a socket after it. Only the next `connect` opens one.
   */
  pauseSocket(): void;

  /**
   * Send an ephemeral `typing` signal over the WebSocket for a DM/group conversation.
   * The gateway relays it to other online group members. No-op if the socket is closed.
   * Community channels route typing via `ChannelService` HTTP instead.
   */
  sendTyping(groupId: string, isTyping: boolean): void;

  /**
   * Logs what the `KeyPackage` label in the load-time composition line is made of, once per session.
   *
   * ON THE INTERFACE BECAUSE BOTH PLATFORMS OWE IT, which is the fix rather than a tidy-up: it was
   * an optional method reached through a cast and guarded by `!isTauriRuntime()`, and native's
   * "equivalent" was a log line INSIDE the awaited load - half the cost of a cold start at a large
   * pool. A capability every implementation has is a method on the interface; an optional one is a
   * capability nothing makes anybody provide.
   *
   * Never awaited and never throws: the caller has nothing to decide on the result.
   */
  logKeyPackageCensus(): void;

  /**
   * Removes network event listeners (`visibilitychange`, `online`) and clears
   * all internal timers. Must be called before the instance is discarded (e.g.
   * on logout + device wipe) to prevent orphaned handlers keeping a stale
   * reference to this object and blocking GC.
   */
  destroy(): void;
}
