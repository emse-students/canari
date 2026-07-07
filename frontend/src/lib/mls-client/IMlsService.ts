import type { IncomingDeliveryMeta } from './incomingDelivery';
import type { MlsDecryptSession } from './mlsDecryptSession';

export type { IncomingDeliveryMeta };

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
};

export interface IMlsService {
  /** Initialises the MLS identity for the given user, decrypting stored state with the PIN. */
  init(userId: string, pin: string, state?: Uint8Array, opts?: MlsInitOptions): Promise<void>;
  /** Creates a new local MLS group with the given ID. */
  createGroup(groupId: string): Promise<void>;
  /** Wipes any orphan OpenMLS state for groupId then creates a fresh group. */
  forceCreateGroup(groupId: string): Promise<void>;
  /** Creates a new named group on the delivery server and returns its assigned group ID. */
  createRemoteGroup(name: string, isGroup?: boolean): Promise<string>;
  /** Serialises and AES-GCM encrypts the current MLS state to a byte array using the PIN. */
  saveState(pin: string): Promise<Uint8Array>;
  /**
   * Reloads the persisted MLS state from disk into the in-memory engine (C2). Android-only:
   * while the app is backgrounded, a native JNI engine (Welcome/send/worker) may advance
   * `mls.bin`; without reloading on resume the warm in-memory state is stale and its next save
   * would clobber that advance (lost-update -> SecretReuse). No-op where there is no background
   * engine (web/desktop).
   */
  reloadStateFromDisk(): Promise<void>;
  /**
   * Re-encrypts the in-memory MLS state with a new PIN and persists it.
   * Must be called after the user successfully changes their PIN on the server,
   * so the stored state remains decryptable on the next login.
   */
  changePIN(newPin: string): Promise<void>;
  /**
   * Forgot-PIN-elsewhere recovery: decrypts this device's local state with the OLD pin
   * (non-destructively) then re-encrypts it under the NEW account pin, preserving all
   * local messages. Marks the client initialised so a following login reuses it.
   * Returns `false` if `oldPin` does not decrypt the local state.
   */
  recoverAndRekey(
    userId: string,
    oldPin: string,
    newPin: string,
    state: Uint8Array
  ): Promise<boolean>;
  /** Generates a fresh MLS KeyPackage for this device, signed with the PIN-encrypted identity key. */
  generateKeyPackage(pin: string): Promise<Uint8Array>;
  /**
   * Purge les KeyPackages publiés (fallback statique + pool one-time) et en republie
   * de frais à partir du keystore local courant.
   *
   * À appeler quand on détecte que nos KeyPackages serveur ne correspondent plus à nos
   * clés privées locales (erreur `NoMatchingKeyPackage` au traitement d'un Welcome) :
   * sans ça, l'invitant ré-ajoute en boucle avec le même KeyPackage orphelin.
   */
  republishKeyMaterial(pin: string): Promise<void>;
  /**
   * Réconciliation proactive : liste les one-time prekeys publiés sur le serveur,
   * valide localement lesquels on possède encore en clé privée, et purge du serveur
   * ceux qui sont orphelins (clé privée perdue après reset/restauration d'état).
   *
   * Empêche un pair de consommer un KeyPackage qu'on ne peut pas honorer - la cause
   * de la boucle `NoMatchingKeyPackage` - au lieu d'attendre l'échec. Best-effort,
   * conçu pour tourner en arrière-plan à la connexion.
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
  /** Encrypts an application message for the group and delivers it via the delivery service. */
  sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    messageId?: string,
    silent?: boolean
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
  /** Fetches the Redis Stream history for a group, optionally starting after a given stream entry ID. */
  fetchHistory(
    groupId: string,
    afterStreamId?: string,
    /** Optional page size override (server clamps). */
    limit?: number
  ): Promise<import('./historyTypes').HistoryStreamRow[]>;
  /**
   * Fetches the first page of history for multiple groups in one HTTP round-trip.
   * Groups the caller cannot read return an empty array.
   */
  fetchHistoryBatch?(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('./historyTypes').HistoryStreamRow[]>>;
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
  /** Resolves when the internal MLS message queue is drained. */
  waitForMessageQueueIdle(): Promise<void>;

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
   * disparue) de l'incertitude reseau (`'error'`) et de l'existence (`GroupMeta` : groupe vivant,
   * tombstone supprime, ou exclusion). Utilise par la discovery pour n'auto-supprimer une conv que
   * sur absence confirmee.
   */
  getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta>;
  /** Liste les groupes que cet utilisateur a dismisses (suppression/quitter manuel propage a tous ses appareils). */
  getDismissedGroups(): Promise<string[]>;
  /** Marque un groupe comme dismisse (suppression/quitter manuel) - propage la purge aux autres appareils. */
  dismissGroup(groupId: string): Promise<void>;
  /** Leve le dismiss d'un groupe (re-ajout via Welcome). */
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
   * Ask one online member to resend the history bundle after this device self-joined a group via an
   * external commit. History-only (already a member), never a re-add. Best-effort, online-only.
   */
  sendHistoryRequest(groupId: string): Promise<void>;

  /**
   * Register a callback invoked when a member device receives a history_request for a group it
   * belongs to (the requester joined via external commit and wants the pre-join history).
   */
  onHistoryRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void;

  /**
   * Send a `disconnect` control frame over the WebSocket so the gateway
   * removes the presence key immediately (instead of waiting for TTL / heartbeat
   * miss). Call this in `beforeunload` or when the app is intentionally closed.
   * No-op if the socket is not open.
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
