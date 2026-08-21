import type { FrameDelivery } from './frameDelivery';
import type { IncomingDeliveryMeta } from './incomingDelivery';
import type { MlsDecryptSession } from './mlsDecryptSession';
import type { DistributionScope } from './distributionScope';

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
  /** The published base, or null when no client has initialised the MLS group yet. */
  fetch(scope: DistributionScope): Promise<{ groupInfo: string; baseEpoch: number } | null>;
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

/** Per-message outcome from a {@link MlsDecryptSession} page decrypt. */
export type MlsBatchProcessResult =
  | { ok: true; plaintext: Uint8Array | null }
  | { ok: false; error: string };

/** Options for {@link IMlsService.init}. */
export interface MlsInitOptions {
  /**
   * When true, a saved state that fails to decrypt with the given PIN is NOT discarded
   * via the destructive fresh-start fallback; instead {@link MLS_LOCAL_STATE_UNDECRYPTABLE}
   * is thrown so the caller can offer cross-device PIN recovery (decrypt with the old PIN)
   * before any local history is dropped.
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
}

/**
 * Thrown by {@link IMlsService.init} when `noFreshStart` is set and the saved local state
 * cannot be decrypted with the supplied PIN - the signal that the account PIN was likely
 * rotated on another device and recovery should be offered.
 */
export const MLS_LOCAL_STATE_UNDECRYPTABLE = 'MLS_LOCAL_STATE_UNDECRYPTABLE';

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
 * Observer of the bulk-ingest window lifecycle. Each `onBulkIngestStart` is paired with exactly
 * one `onBulkIngestEnd` receiving the same {@link BulkIngestPhase}, even when windows nest.
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

export interface IMlsService {
  /** Initialises the MLS identity for the given user, decrypting stored state with the device key. */
  init(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void>;
  /** Creates a new local MLS group with the given ID. */
  createGroup(groupId: string): Promise<void>;
  /** Wipes any orphan OpenMLS state for groupId then creates a fresh group. */
  forceCreateGroup(groupId: string): Promise<void>;
  /** Creates a new named group on the delivery server and returns its assigned group ID. */
  createRemoteGroup(name: string, isGroup?: boolean): Promise<string>;
  /** Serialises and encrypts the current MLS state to a byte array using the device key. */
  saveState(deviceKeyB64: string): Promise<Uint8Array>;
  /**
   * Writes the current MLS state to THIS platform's durable store - the whole checkpoint, and the
   * only call a checkpoint needs.
   *
   * It exists because {@link saveState} does not mean the same thing on the two platforms. On web it
   * RETURNS bytes that still have to be handed to IndexedDB; on native it has already written
   * `mls.bin` before it returns, so handing those bytes back through `save_mls_state` writes the
   * same file, with the same bytes, a second time - and pays a `number[]` IPC marshalling of the
   * whole snapshot to do it, which is the very cost `sauvegarder_mls_et_persister` was written to
   * avoid. Measured on the phone 2026-08-14: 3.7 s per checkpoint, of which 1.7 s was the real save
   * and 2.0 s the duplicate.
   *
   * A caller that has to know which platform it is on in order to persist correctly is a caller
   * that will get it wrong; this is the seam that removes the question.
   *
   * CONCRETE IN `BaseMlsService`, and platforms supply only the write itself (`writeCheckpoint`),
   * because a checkpoint is not just a write: it is also the moment this device may declare how much
   * of its send ratchet is now durable. That count is read before the write and committed after it,
   * and the ordering is what makes a restored snapshot repairable at all - see `sendRatchetLedger`.
   */
  persistCheckpoint(deviceKeyB64: string): Promise<void>;
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
   * Forgot-PIN-elsewhere recovery: decrypts this device's local state with the OLD key
   * (non-destructively) then re-encrypts it under the NEW key, preserving all
   * local messages. Marks the client initialised so a following login reuses it.
   * Returns `false` if `oldDeviceKeyB64` does not decrypt the local state.
   */
  recoverAndRekey(
    userId: string,
    oldDeviceKeyB64: string,
    newDeviceKeyB64: string,
    state: Uint8Array
  ): Promise<boolean>;
  /** Generates a fresh MLS KeyPackage for this device, signed with the device-key-encrypted identity key. */
  generateKeyPackage(deviceKeyB64: string): Promise<Uint8Array>;
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
   */
  addMember(
    groupId: string,
    keyPackageBytes: Uint8Array,
    excludeDeviceIds?: string[]
  ): Promise<{ welcome?: Uint8Array; ratchetTree?: Uint8Array }>;
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
   * ciphersuite, lost private key, corrupted bytes) are reported in `skippedDeviceIds` so the
   * caller can surface a non-silent member loss instead of letting them disappear. [[C5]]
   */
  addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>,
    excludeDeviceIds?: string[]
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skippedDeviceIds: string[];
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
  ): Promise<Uint8Array>;
  /** Decrypts and processes an incoming MLS message for the group, returning the plaintext or null. */
  processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array | null>;
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
  /** Opens a WebSocket connection to the chat gateway. Token is used when the cookie is not forwarded (Tauri, proxy, ITP). Falls back to internal getToken() if omitted. */
  connect(token?: string): Promise<void>;
  /** True when the live gateway WebSocket is open (used for reconnect watchdog). */
  isWsOpen(): boolean;
  /** Fetches all registered devices (with KeyPackages) for the given user. Throws on transport/HTTP failure; `[]` only when the user genuinely has no active device. */
  fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  >;
  /** Fetches one device's KeyPackage when it is missing from {@link fetchUserDevices} (e.g. 30-day list filter). */
  fetchDeviceKeyPackage(
    userId: string,
    deviceId: string
  ): Promise<{
    keyPackage: Uint8Array;
    deviceId: string;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  } | null>;
  /** Uploads a single KeyPackage to the server so other devices can invite this one. */
  publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
  /** Bulk-upload multiple one-time prekeys to the server pool. */
  publishKeyPackages(packages: Uint8Array[]): Promise<void>;
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
  acquireAddLock(groupId: string, ttlMs?: number): Promise<boolean>;
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
   * Rung-1 replay: fetches the ordered commits this device missed (`baseEpoch >= sinceEpoch`) so a
   * gap can be healed by re-applying them instead of dropping local state. `belowFloor` signals the
   * intermediate commits were pruned (fall back to rung-2 re-Welcome); `activeEpoch` is the epoch to
   * reach after replay.
   */
  fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
  }>;
  /**
   * Refreshes the server-stored GroupInfo (external-join base) at the current epoch. Best-effort:
   * called after every commit (a new group's first member-add is itself a commit) so a member lacking
   * state can self-join. [[Phase 4]]
   */
  refreshGroupInfo(groupId: string): Promise<void>;
  /**
   * Attempts to (re)join `groupId` via an external commit built from the stored GroupInfo, without a
   * peer Welcome (self-service recovery). Returns true on success; false when unavailable (no stored
   * GroupInfo, not a member, or the epoch race is lost) so the caller falls back to welcome_request.
   */
  externalJoin(groupId: string): Promise<boolean>;
  /**
   * Declares `groupId` to be the Graine key-distribution group of `scope`, so every later decision
   * that differs for it is taken from a registered fact rather than rediscovered.
   */
  registerDistributionGroup(scope: DistributionScope, groupId: string): void;
  /** True when `groupId` carries channel seeds and must never reach the conversation pipeline. */
  isDistributionGroup(groupId: string): boolean;
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
  forgetDistributionGroup(scope: DistributionScope): string | null;
  /**
   * The same, named by the GROUP rather than by the scope. Returns whether anything was held.
   *
   * Two entry points because they answer two different questions, and one of them cannot be asked
   * through the other: {@link forgetDistributionGroup} resolves the group through the scope
   * registration, so it can only forget what that registration already names - and the state worth
   * forgetting is precisely one where the two have drifted apart. The server names the group; this
   * takes that name.
   */
  forgetDistributionGroupById(groupId: string): boolean;
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
   * Joins the scope's key-distribution group whatever state it is in - held already, published and
   * joinable, or not yet initialised (this device then creates it). Returns true when the group is
   * held afterwards.
   */
  ensureDistributionGroup(
    scope: DistributionScope,
    ref: { groupId: string; groupInfo: string | null; baseEpoch: number | null }
  ): Promise<boolean>;
  /**
   * Decrypts a frame that arrived on a key-distribution group and hands it to the Graine handler.
   * Returns whether the frame may be acknowledged.
   */
  routeDistributionFrame(groupId: string, sender: string, ciphertext: Uint8Array): Promise<boolean>;
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
   * Tells the service the local conversation store is now authoritative.
   *
   * A frame that arrived before the restore finished was left in the server queue with nothing to
   * render it into. This is the event that discharges it - the answer changed, so the ask is worth
   * repeating. Free and silent when nothing was left behind.
   */
  notifyConversationsRestored(): void;

  // Group management
  /** Returns the list of group IDs for which this device holds local MLS state. */
  getLocalGroups(): string[];
  /** Drops the local MLS state for a group, forcing re-synchronisation via a new Welcome.
   *  `minEpoch`: minimum epoch the new Welcome must reach (0 = no restriction). */
  forgetGroup(groupId: string, minEpoch?: number): void;
  /** Permanently purges a group (Poison Pill): clears memory and OpenMLS storage, then sets
   *  the epoch lock to MAX so no Welcome will ever be accepted for this groupId again. */
  dropGroup(groupId: string): void;
  /** Notifies the server that this device is leaving a group unrecoverably.
   *  Deletes the DeviceGroupMembership and removes the device from Redis routing. */
  forceLeaveGroup(groupId: string): Promise<void>;
  /** Updates the display name of a group on the delivery service. */
  renameGroup(groupId: string, name: string): Promise<void>;
  /** Sets (or clears, with mediaId=null) the group's avatar on the delivery service. */
  setGroupImage(groupId: string, mediaId: string | null): Promise<void>;
  /** Deletes a group and all its messages from the delivery service. */
  deleteGroupOnServer(groupId: string): Promise<boolean>;
  /** Removes a user from the server-side membership list of a group (no MLS commit). */
  removeMemberFromServer(groupId: string, userId: string): Promise<void>;
  /** Performs a real MLS remove commit for all devices of the given user(s) and broadcasts it. */
  removeMember(groupId: string, userIds: string[]): Promise<void>;
  /** Performs a real MLS remove commit for specific devices by identity ("userId:deviceId") and broadcasts it. */
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
  /** Returns the (userId, deviceId) pairs currently in a group. Throws on transport/HTTP failure; `[]` only for a genuinely empty group. */
  getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]>;
  /** Returns user-level membership (dm_group_members) for `groupId`. Throws on transport/HTTP failure; `[]` only for a genuinely empty group. */
  getGroupUserMembers(groupId: string): Promise<{ userId: string }[]>;
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
  getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      deviceId: string;
      groupId: string;
      status: string;
    }>
  >;
  /** Get all device-group memberships for the current device */
  getDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      deviceId: string;
      groupId: string;
      status: string;
    }>
  >;
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

  /** Completely delete a device from the user's account (groups + KeyPackages + push token) */
  deleteDevice(
    userId: string,
    deviceId: string
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
   * Opens a bulk-ingest window with the given {@link BulkIngestPhase}. Pair with
   * {@link endBulkIngest}; prefer the {@link withMlsBulkIngest} helper which is exception-safe.
   * Windows nest via an internal phase stack, so the encrypted checkpoint coalesces to one
   * flush at the outermost close. Omitting `phase` opens a persistence-only window
   * (no UI buffering, no overlay) - the default for {@link withMlsBulkIngest}.
   */
  beginBulkIngest(phase?: BulkIngestPhase): void;
  /**
   * Closes the innermost bulk-ingest window, replaying the exact {@link BulkIngestPhase} it was
   * opened with so start and end are symmetric by construction. Resolves only after the encrypted
   * checkpoint (if any) completes.
   */
  endBulkIngest(): Promise<void>;

  /**
   * Announce to all online members of `groupId` that this device needs a Welcome.
   * Called once per pending group on connect, after KeyPackage publication.
   */
  sendWelcomeRequest(groupId: string): Promise<void>;

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

  /** Asks the server whether this device is denylisted. `false` when the question cannot be reached. */
  isDeviceRevoked(): Promise<boolean>;

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
   * No-op if the socket is not open.
   *
   * THIS DOES NOT CLOSE THE SOCKET, and must not: `pauseConnectionImpl` calls it when the app is
   * backgrounded, and the socket is deliberately expected to survive that - the resume path reports
   * `[LIFECYCLE] Resume: already connected (flag=true, socket=true)` precisely because it usually
   * does. Closing here would force a full reconnect on every backgrounding.
   *
   * IT ALSO DOES NOT NEED A COMPANION THAT CLOSES. One was added on 2026-08-15 (`closeForUnload`,
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
   * Send an ephemeral `typing` signal over the WebSocket for a DM/group conversation.
   * The gateway relays it to other online group members. No-op if the socket is closed.
   * Community channels route typing via `ChannelService` HTTP instead.
   */
  sendTyping(groupId: string, isTyping: boolean): void;

  /**
   * Removes network event listeners (`visibilitychange`, `online`) and clears
   * all internal timers. Must be called before the instance is discarded (e.g.
   * on logout + device wipe) to prevent orphaned handlers keeping a stale
   * reference to this object and blocking GC.
   */
  destroy(): void;
}
