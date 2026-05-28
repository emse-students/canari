import type { IncomingDeliveryMeta } from './incomingDelivery';

export type { IncomingDeliveryMeta };

/** Row from `GET /api/mls/users/:id/groups` (includes successor routing when soft-deleted). */
export type UserGroupRow = {
  groupId: string;
  name: string;
  isGroup: boolean;
  successorId?: string | null;
  deletedAt?: string | null;
};

/** Metadata from `GET /api/mls/groups/:id` for recovery / successor checks. */
export type GroupMeta = {
  groupId: string;
  name?: string;
  isGroup?: boolean;
  successorId?: string | null;
  deletedAt?: string | null;
};

export interface IMlsService {
  /** Initialises the MLS identity for the given user, decrypting stored state with the PIN. */
  init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
  /** Creates a new local MLS group with the given ID. */
  createGroup(groupId: string): Promise<void>;
  /** Wipes any orphan OpenMLS state for groupId then creates a fresh group. */
  forceCreateGroup(groupId: string): Promise<void>;
  /** Creates a new named group on the delivery server and returns its assigned group ID. */
  createRemoteGroup(name: string, isGroup?: boolean): Promise<string>;
  /** Serialises and AES-GCM encrypts the current MLS state to a byte array using the PIN. */
  saveState(pin: string): Promise<Uint8Array>;
  /** Generates a fresh MLS KeyPackage for this device, signed with the PIN-encrypted identity key. */
  generateKeyPackage(pin: string): Promise<Uint8Array>;
  /** Adds one device to a group via an MLS Add commit, returning the Commit and optional Welcome. */
  addMember(
    groupId: string,
    keyPackageBytes: Uint8Array
  ): Promise<{ commit: Uint8Array; welcome?: Uint8Array; ratchetTree?: Uint8Array }>;
  /** Adds multiple devices to a group in a single MLS commit, returning the Commit and Welcome. */
  addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedDeviceIds: string[];
    ratchetTree?: Uint8Array;
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
  /** Exports a derived secret from a group's epoch key material using the given label and context. */
  exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;

  // Networking
  /** Opens a WebSocket connection to the chat gateway using the given JWT access token. */
  connect(token: string): Promise<void>;
  /** True when the live gateway WebSocket is open (used for reconnect watchdog). */
  isWsOpen(): boolean;
  /** Fetches all registered devices (with KeyPackages) for the given user from the delivery service. */
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
  /**
   * Broadcast a structural commit to all group members.
   * `excludeDeviceIds` - optional list of "userId:deviceId" pairs to skip
   * (typically the inviter and the newly-welcomed invitee).
   */
  sendCommit(commitBytes: Uint8Array, groupId: string, excludeDeviceIds?: string[]): Promise<void>;
  /** Registers a user as a member of a group on the delivery service (server-side membership tracking). */
  registerMember(groupId: string, userId: string): Promise<void>;
  /** Acquiert un verrou distribué Redis pour éviter les commits MLS concurrents sur le même groupe.
   *  Retourne true si le verrou a été acquis, false si un autre appareil le détient déjà. */
  acquireAddLock(groupId: string, ttlMs?: number): Promise<boolean>;
  /** Libère le verrou acquis via acquireAddLock. */
  releaseAddLock(groupId: string): Promise<void>;
  /** Fetches the Redis Stream history for a group, optionally starting after a given stream entry ID. */
  fetchHistory(
    groupId: string,
    afterStreamId?: string
  ): Promise<{ id?: string; sender_id: string; content: string; timestamp: string }[]>;
  /** Returns the unique device ID assigned to this MLS instance. */
  getDeviceId(): string;
  /** Fetches messages queued on the delivery service that were not yet delivered
   * (e.g. during a disconnect). Should be called after every connect/reconnect. */
  fetchPendingMessages(): Promise<void>;

  // Group management
  /** Returns the list of group IDs for which this device holds local MLS state. */
  getLocalGroups(): string[];
  /** Oublie l'état MLS local d'un groupe pour forcer une re-synchronisation via Welcome.
   *  `minEpoch` : l'époch minimale que le nouveau Welcome doit atteindre (0 = pas de restriction). */
  forgetGroup(groupId: string, minEpoch?: number): void;
  /** Purge définitive d'un groupe (Poison Pill) : mémoire, stockage OpenMLS et verrou d'epoch
   *  à MAX. Aucun Welcome ne sera jamais accepté pour ce groupId après cet appel. */
  dropGroup(groupId: string): void;
  /** Signale au serveur que ce device quitte un groupe de manière irrécupérable.
   *  Supprime le DeviceGroupMembership et retire l'appareil du routage Redis. */
  forceLeaveGroup(groupId: string): Promise<void>;
  /** Updates the display name of a group on the delivery service. */
  renameGroup(groupId: string, name: string): Promise<void>;
  /** Deletes a group and all its messages from the delivery service. */
  deleteGroupOnServer(groupId: string): Promise<boolean>;
  /** Removes a user from the server-side membership list of a group (no MLS commit). */
  removeMemberFromServer(groupId: string, userId: string): Promise<void>;
  /** Performs a real MLS remove commit for all devices of the given user(s) and broadcasts it. */
  removeMember(groupId: string, userIds: string[]): Promise<void>;
  /** Performs a real MLS remove commit for specific devices by identity ("userId:deviceId") and broadcasts it. */
  removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void>;
  /** Returns the list of (userId, deviceId) pairs currently in a group according to the delivery service. */
  getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]>;
  /** Returns all groups the given user belongs to according to the delivery service. */
  getUserGroups(userId: string): Promise<UserGroupRow[]>;
  /** Fetches server metadata for one group (successor link, soft-delete). */
  getGroupMeta(groupId: string): Promise<GroupMeta | null>;
  /**
   * Atomically claims `successorId` as the replacement for a dead group (CAS).
   * On conflict, returns `claimed: false` and the winning `successorId`.
   */
  claimGroupSuccessor(
    deadGroupId: string,
    successorId: string
  ): Promise<{ claimed: boolean; successorId: string | null }>;

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
      lastEpochSeen: number;
    }>
  >;
  /** Update the status of a device-group membership on the server */
  updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'welcome_sent' | 'welcome_received' | 'stale',
    lastEpochSeen?: number
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
  onChannelEvent?: (event: { type: string; data: any }) => void;
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
   * Optional hooks for batching UI updates while draining a large MLS message queue
   * (e.g. after reconnect). Implemented by WebMlsService / TauriMlsService.
   */
  setBulkIngestHooks?(
    onStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void,
    onEnd?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void | Promise<void>
  ): void;

  // Device sync notification
  /** Broadcasts a reinvite_request control frame so group members know this device needs re-inviting. */
  sendReinviteRequest(groupId: string): Promise<void>;
  /** Registers a callback invoked when another device sends a reinvite_request for a group this device manages. */
  onReinviteRequest(callback: (senderDeviceId: string, groupId: string) => void): void;

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
   * Send a `disconnect` control frame over the WebSocket so the gateway
   * removes the presence key immediately (instead of waiting for TTL / heartbeat
   * miss). Call this in `beforeunload` or when the app is intentionally closed.
   * No-op if the socket is not open.
   */
  sendDisconnect(): void;

  /**
   * Removes network event listeners (`visibilitychange`, `online`) and clears
   * all internal timers. Must be called before the instance is discarded (e.g.
   * on logout + device wipe) to prevent orphaned handlers keeping a stale
   * reference to this object and blocking GC.
   */
  destroy?(): void;
}
