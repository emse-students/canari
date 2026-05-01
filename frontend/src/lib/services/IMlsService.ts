export interface IMlsService {
  init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
  createGroup(groupId: string): Promise<void>;
  /** Wipes any orphan OpenMLS state for groupId then creates a fresh group. */
  forceCreateGroup(groupId: string): Promise<void>;
  createRemoteGroup(name: string, isGroup?: boolean): Promise<string>;
  saveState(pin: string): Promise<Uint8Array>;
  generateKeyPackage(pin: string): Promise<Uint8Array>;
  addMember(
    groupId: string,
    keyPackageBytes: Uint8Array
  ): Promise<{ commit: Uint8Array; welcome?: Uint8Array; ratchetTree?: Uint8Array }>;
  addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedDeviceIds: string[];
    ratchetTree?: Uint8Array;
  }>;
  processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string>;
  sendMessage(groupId: string, messageBytes: Uint8Array, messageId?: string): Promise<Uint8Array>;
  processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array | null>;
  exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;

  // Networking
  connect(token: string): Promise<void>;
  fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  >;
  publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
  /** Bulk-upload multiple one-time prekeys to the server pool. */
  publishKeyPackages(packages: Uint8Array[]): Promise<void>;
  sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void>;
  /** Returns the current MLS epoch for a group (needed for epoch-gating). */
  getEpoch(groupId: string): number;
  /**
   * Broadcast a structural commit to all group members.
   * `excludeDeviceIds` — optional list of "userId:deviceId" pairs to skip
   * (typically the inviter and the newly-welcomed invitee).
   */
  sendCommit(commitBytes: Uint8Array, groupId: string, excludeDeviceIds?: string[]): Promise<void>;
  registerMember(groupId: string, userId: string): Promise<void>;
  /** Acquiert un verrou distribué Redis pour éviter les commits MLS concurrents sur le même groupe.
   *  Retourne true si le verrou a été acquis, false si un autre appareil le détient déjà. */
  acquireAddLock(groupId: string, ttlMs?: number): Promise<boolean>;
  /** Libère le verrou acquis via acquireAddLock. */
  releaseAddLock(groupId: string): Promise<void>;
  fetchHistory(
    groupId: string,
    afterStreamId?: string
  ): Promise<{ id?: string; sender_id: string; content: string; timestamp: string }[]>;
  getDeviceId(): string;
  /** Fetches messages queued on the delivery service that were not yet delivered
   * (e.g. during a disconnect). Should be called after every connect/reconnect. */
  fetchPendingMessages(): Promise<void>;

  // Group management
  getLocalGroups(): string[];
  /** Oublie l'état MLS local d'un groupe pour forcer une re-synchronisation via Welcome.
   *  `minEpoch` : l'époch minimale que le nouveau Welcome doit atteindre (0 = pas de restriction). */
  forgetGroup(groupId: string, minEpoch?: number): void;
  renameGroup(groupId: string, name: string): Promise<void>;
  deleteGroupOnServer(groupId: string): Promise<void>;
  removeMemberFromServer(groupId: string, userId: string): Promise<void>;
  /** Performs a real MLS remove commit for all devices of the given user(s) and broadcasts it. */
  removeMember(groupId: string, userIds: string[]): Promise<void>;
  /** Performs a real MLS remove commit for specific devices by identity ("userId:deviceId") and broadcasts it. */
  removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void>;
  getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]>;
  getUserGroups(userId: string): Promise<{ groupId: string; name: string; isGroup: boolean }[]>;

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

  /** Reset the server-side activeEpoch of a group to 0 (used during re-bootstrap). */
  resetGroupEpoch(groupId: string): Promise<void>;

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
  onChannelEvent?: (event: { type: string; data: any }) => void;
  onMessage(
    callback: (
      senderId: string,
      content: Uint8Array,
      groupId?: string,
      isWelcome?: boolean,
      ratchetTreeBytes?: Uint8Array,
      isCommit?: boolean
    ) => Promise<boolean>
  ): void;
  onDisconnect(callback: () => void): void;

  // Device sync notification
  sendReinviteRequest(groupId: string): Promise<void>;
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
   * Demande au serveur de reset un groupe entier (hors-bande MLS).
   * Le serveur passe toutes les memberships à pending, reset l'epoch,
   * et diffuse un signal `group_reset` WebSocket à tous les appareils en ligne.
   */
  sendGroupReset(groupId: string, reason?: string): Promise<void>;

  /**
   * Callback invoqué quand le serveur diffuse un `group_reset`.
   * Le client doit : forgetGroup() + isReady=false + attendre un welcome_request.
   */
  onGroupReset(callback: (groupId: string, reason: string) => void): void;

  /**
   * Send a `disconnect` control frame over the WebSocket so the gateway
   * removes the presence key immediately (instead of waiting for TTL / heartbeat
   * miss). Call this in `beforeunload` or when the app is intentionally closed.
   * No-op if the socket is not open.
   */
  sendDisconnect(): void;
}
