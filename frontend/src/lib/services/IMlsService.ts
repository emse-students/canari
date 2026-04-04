export interface IMlsService {
  init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
  createGroup(groupId: string): Promise<void>;
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
  sendMessage(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array>;
  processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array | null>;
  exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;

  // Networking
  connect(token: string): Promise<void>;
  fetchUserDevices(userId: string): Promise<Array<{ keyPackage: Uint8Array; deviceId: string }>>;
  publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
  sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void>;
  /** Returns the current MLS epoch for a group (needed for epoch-gating). */
  getEpoch(groupId: string): number;
  sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void>; // New Method for WS priority
  registerMember(groupId: string, userId: string, deviceId: string): Promise<void>;
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
    status: 'pending' | 'added' | 'welcome_sent' | 'welcome_received' | 'stale',
    lastEpochSeen?: number
  ): Promise<void>;

  /** Reset all devices of a user in a group to pending (after MLS remove commit). */
  kickStaleUser(userId: string, groupId: string): Promise<void>;

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

  // Callbacks
  onChannelEvent?: (event: { type: string; data: any }) => void;
  onMessage(
    callback: (
      senderId: string,
      content: Uint8Array,
      groupId?: string,
      isWelcome?: boolean,
      ratchetTreeBytes?: Uint8Array
    ) => Promise<boolean>
  ): void;
  onDisconnect(callback: () => void): void;

  // Device sync notification
  sendSyncRequest(): void;
  onSyncRequest(callback: (senderDeviceId: string) => void): void;
}
