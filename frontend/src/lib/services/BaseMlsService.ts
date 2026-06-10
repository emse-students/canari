import type { IMlsService, GroupMeta, UserGroupRow } from '$lib/mls-client';
import { MlsDeliveryApi, resolveMlsPublicUrls } from '$lib/mls-client';
import type { MlsDeliveryFetch } from '$lib/mls-client/mlsDeliveryApi';
import type { IncomingDeliveryMeta } from '$lib/mls-client/IMlsService';
import { MlsPerGroupScheduler, type MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
  logMlsMetric,
} from '$lib/mls-client';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { getToken } from '$lib/stores/auth';

/**
 * Abstract base class shared by WebMlsService (WASM) and TauriMlsService (Rust native).
 *
 * Contains every field and method that is identical between the two platforms:
 * - All `/api/mls/*` delivery REST wrappers (delegated to {@link MlsDeliveryApi})
 * - WebSocket callback registrations (onMessage, onDisconnect, etc.)
 * - Queue plumbing (enqueueMessage, waitForMessageQueueIdle, processQueue, fetchPendingMessages)
 * - Pending-retry scheduling (pendingRetryTimer / scheduleRetry)
 * - Lifecycle boilerplate (init promise dedup, destroy base listeners)
 *
 * Platform-specific code lives exclusively in the subclasses:
 * - WebMlsService: WASM client, key-package worker, browser WebSocket
 * - TauriMlsService: invoke() calls, native WebSocket, epoch/group caches
 */
export abstract class BaseMlsService implements IMlsService {
  // ── Platform identity ─────────────────────────────────────────────────────
  protected readonly platform: 'web' | 'tauri';

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onChannelEvent?: (event: { type: string; data: any }) => void;

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

  protected welcomeProcessedCallback: ((groupId?: string) => void) | null = null;

  // ── URLs & identity ───────────────────────────────────────────────────────
  protected baseUrl: string;
  protected historyUrl: string;
  protected userId = 'unknown';
  protected deviceId = 'pending';

  // ── Delivery REST client ──────────────────────────────────────────────────
  protected readonly delivery: MlsDeliveryApi;

  // ── Init dedup ────────────────────────────────────────────────────────────
  protected initPromise: Promise<void> | null = null;
  /** True when MLS is initialized without an existing state blob (fresh device). */
  protected freshStart = false;

  // ── Timers & event handlers ───────────────────────────────────────────────
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected _visibilityHandler: (() => void) | null = null;
  protected _onlineHandler: (() => void) | null = null;

  // ── In-session retry timer ────────────────────────────────────────────────
  /**
   * Reschedules `fetchPendingMessages` after PENDING_RETRY_DELAY_MS when a queued
   * message returned `false` from the callback (rather than waiting for a reconnect).
   */
  private pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PENDING_RETRY_DELAY_MS = 15_000;

  // ── Message queue ─────────────────────────────────────────────────────────
  /** Per-conversation queues with round-robin scheduling and a global MLS mutex. */
  protected readonly messageScheduler: MlsPerGroupScheduler;

  protected bulkIngestStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void;
  protected bulkIngestEnd?: (
    enableBulkBuffer?: boolean,
    showOverlay?: boolean
  ) => void | Promise<void>;

  constructor(platform: 'web' | 'tauri', fetchImpl?: MlsDeliveryFetch) {
    this.platform = platform;
    // Device ID is resolved per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    const urls = resolveMlsPublicUrls();
    this.baseUrl = urls.baseUrl;
    this.historyUrl = urls.historyUrl;
    this.messageScheduler = new MlsPerGroupScheduler(platform);
    this.delivery = new MlsDeliveryApi({
      historyUrl: this.historyUrl,
      getToken,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialises the MLS identity, deduplicating concurrent calls via a shared promise.
   * Delegates actual init to the platform-specific {@link _initImpl}.
   */
  async init(userId: string, pin: string, state?: Uint8Array): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initImpl(userId, pin, state);
    await this.initPromise;
  }

  /** Platform-specific init body (WASM load vs Tauri invoke). */
  protected abstract _initImpl(userId: string, pin: string, state?: Uint8Array): Promise<void>;

  /**
   * Removes shared event listeners and clears the heartbeat timer.
   * Calls {@link destroyPlatformResources} for subclass-specific teardown.
   */
  destroy(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pendingRetryTimer !== null) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    this.destroyPlatformResources();
  }

  /** Override to release platform-specific resources (e.g. Worker, native WebSocket). */
  protected destroyPlatformResources(): void {}

  // ── WebSocket (platform-specific) ─────────────────────────────────────────

  abstract connect(token?: string): Promise<void>;
  abstract isWsOpen(): boolean;
  abstract sendDisconnect(): void;

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

  onWelcomeProcessed(callback: (groupId?: string) => void): void {
    this.welcomeProcessedCallback = callback;
  }

  setBulkIngestHooks(
    onStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void,
    onEnd?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void | Promise<void>
  ): void {
    // Two callers (setupMessageHandler + useChatSession) each register their own hooks;
    // chain them so both fire. Each pair is symmetric (N starts = N ends), so
    // bulkIngestDepth stays balanced regardless of registration order.
    const prevStart = this.bulkIngestStart;
    const prevEnd = this.bulkIngestEnd;
    if (onStart) {
      this.bulkIngestStart = (enableBulkBuffer, showOverlay) => {
        prevStart?.(enableBulkBuffer, showOverlay);
        onStart(enableBulkBuffer, showOverlay);
      };
    }
    if (onEnd) {
      this.bulkIngestEnd = async (enableBulkBuffer, showOverlay) => {
        await prevEnd?.(enableBulkBuffer, showOverlay);
        await onEnd(enableBulkBuffer, showOverlay);
      };
    }
  }

  // ── Message queue ─────────────────────────────────────────────────────────

  /** Resolves when all per-group MLS queues are drained. */
  async waitForMessageQueueIdle(): Promise<void> {
    return this.messageScheduler.waitUntilIdle();
  }

  /** Enqueues a message and starts the per-group fair drain loop if idle. */
  protected enqueueMessage(msg: MlsQueuedMessage): void {
    this.messageScheduler.enqueue(msg);
    if (!this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Schedules an in-session retry of `fetchPendingMessages` after PENDING_RETRY_DELAY_MS.
   * Only fires if the WebSocket is still open at the time of execution.
   * Cancels any previously scheduled retry before registering a new one.
   */
  protected scheduleRetry(): void {
    if (this.pendingRetryTimer !== null) clearTimeout(this.pendingRetryTimer);
    this.pendingRetryTimer = setTimeout(() => {
      this.pendingRetryTimer = null;
      if (this.isWsOpen()) {
        console.log('[QUEUE] In-session retry: fetchPendingMessages (unacknowledged message)');
        void this.fetchPendingMessages();
      }
    }, BaseMlsService.PENDING_RETRY_DELAY_MS);
  }

  /** Drains per-group queues with round-robin scheduling and a global MLS mutex. */
  protected async processQueue(): Promise<void> {
    if (!this.messageCallback) {
      console.warn('[QUEUE] messageCallback not set - queued messages will not be processed');
      return;
    }

    const ackIds: string[] = [];
    let hadFailedQueuedMessage = false;

    await this.messageScheduler.drain(
      async (msg) => {
        const groupId = msg.groupId;

        // group_reset control messages: ACK and ignore on both platforms.
        // The WebSocket reconnect is sufficient to re-sync state.
        if (msg.type === 'group_reset') {
          console.log(`[QUEUE] group_reset (control) ignored - group=${groupId ?? 'unknown'}`);
          if (shouldAckGroupResetControl({ hasQueuedId: Boolean(msg.queuedMessageId) })) {
            ackIds.push(msg.queuedMessageId!);
          }
          return;
        }

        try {
          console.log(
            `[QUEUE] Processing ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'message'} group=${groupId ?? 'unknown'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const deliveryMeta: IncomingDeliveryMeta | undefined =
            msg.queuedCreatedAt !== undefined || msg.queuedMessageId
              ? {
                  ...(msg.queuedCreatedAt !== undefined
                    ? { queuedCreatedAt: msg.queuedCreatedAt }
                    : {}),
                  ...(msg.queuedMessageId ? { queuedMessageId: msg.queuedMessageId } : {}),
                }
              : undefined;

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
          if (shouldAckAfterSuccess(cbResult, flags) && msg.queuedMessageId) {
            ackIds.push(msg.queuedMessageId);
          } else if (flags.hasQueuedId && cbResult === false) {
            hadFailedQueuedMessage = true;
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'callback_retry',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }

          if (msg.isWelcome && groupId) {
            this.messageScheduler.reinjectAfterWelcome(groupId);
            this.welcomeProcessedCallback?.(groupId);
          }

          // Platform hook: called after each successful message (e.g. Tauri epoch cache refresh).
          await this.onMessageProcessed(groupId);
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
            if (groupId) this.messageScheduler.clearWelcomePending(groupId);
          } else {
            const exFlags = {
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
              hasQueuedId: Boolean(msg.queuedMessageId),
            };
            if (shouldAckAfterException(exFlags) && msg.queuedMessageId) {
              ackIds.push(msg.queuedMessageId);
            } else if (exFlags.hasQueuedId) {
              logMlsMetric({
                kind: 'queue_skip_ack',
                platform: this.platform,
                reason: 'exception_non_commit',
                isWelcome: msg.isWelcome,
                isCommit: msg.isCommit,
              });
            }
            if (groupId && this.messageScheduler.hasWelcomePending(groupId)) {
              this.messageScheduler.reinjectAfterWelcome(groupId);
            }
          }
        }
      },
      {
        onDrainStart: (pendingCount) => this.bulkIngestStart?.(true, pendingCount > 1),
        onDrainEnd: async () => {
          if (ackIds.length > 0) {
            logMlsMetric({ kind: 'queue_ack', platform: this.platform, count: ackIds.length });
            void this.delivery.deliveryPost('messages/ack', {
              userId: this.userId,
              deviceId: this.deviceId,
              messageIds: ackIds,
            });
          }

          // In-session retry: if a message was not ACKed, reschedule fetchPendingMessages
          // rather than waiting for the next reconnect.
          if (hadFailedQueuedMessage) {
            this.scheduleRetry();
          }

          await this.bulkIngestEnd?.(true, true);
        },
      }
    );

    // Messages that arrived via WebSocket while onDrainEnd was awaiting (draining=true)
    // were enqueued but could not start a new drain. Restart here so they are not stuck.
    if (this.messageScheduler.getPendingCount() > 0 && !this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Platform hook called after each successfully processed message.
   * Override in subclasses to perform platform-specific post-processing
   * (e.g. refreshing epoch cache on Tauri).
   */
  protected async onMessageProcessed(_groupId: string | undefined): Promise<void> {}

  /** Fetches offline-queued messages from the delivery service and routes each through the priority queue. */
  async fetchPendingMessages(): Promise<void> {
    if (this.userId === 'unknown') return;

    const FETCH_TIMEOUT = 10_000;

    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      const messages = await this.delivery.pullPendingMessagesJson(ctrl.signal);
      clearTimeout(tid);

      if (Array.isArray(messages)) {
        if (messages.length > 0) {
          console.log(`[PENDING] Fetched ${messages.length} pending messages`);

          // Route all pending messages through the serialized queue so they
          // never race with live WebSocket messages calling messageCallback.
          for (const msg of messages as Record<string, unknown>[]) {
            const msgId = (msg.id || msg._id) as string | undefined;
            const queuedCreatedAt = parseServerTimestampMs(msg.createdAt);
            const proto: string | undefined = typeof msg.proto === 'string' ? msg.proto : undefined;

            // ── Control messages (group_reset persisted for offline devices) ──
            // These have no MLS payload (empty proto). Both platforms ACK and ignore:
            // WebSocket reconnect is sufficient to re-sync state.
            if (msg.type === 'group_reset') {
              this.enqueueMessage({
                senderId: (msg.senderId as string) || 'unknown',
                ciphertext: new Uint8Array(0),
                groupId: (msg.groupId as string) || undefined,
                isWelcome: false,
                isCommit: false,
                queuedMessageId: msgId,
                type: 'group_reset',
                queuedCreatedAt,
              });
              continue;
            }

            if (proto) {
              try {
                const ciphertext = Uint8Array.from(atob(proto), (c) => c.charCodeAt(0));
                if (ciphertext.length > 0) {
                  this.enqueueMessage({
                    senderId: (msg.senderId as string) || 'unknown',
                    ciphertext,
                    groupId: (msg.groupId as string) || undefined,
                    isWelcome: msg.isWelcome === true,
                    isCommit: msg.isCommit === true,
                    ratchetTreeBytes:
                      typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                        ? Uint8Array.from(atob(msg.ratchetTree as string), (c) => c.charCodeAt(0))
                        : undefined,
                    queuedMessageId: msgId,
                    queuedCreatedAt,
                  });
                }
              } catch (e) {
                console.error('[PENDING] Failed to enqueue proto message:', e);
              }
            }
          }
        } else {
          console.log(`[PENDING] No pending MLS messages for ${this.userId}:${this.deviceId}`);
        }
      } else {
        console.warn(
          `[PENDING] Pending message fetch failed or non-array (${this.userId}:${this.deviceId})`
        );
      }
    } catch (e) {
      console.error('[PENDING] Failed to fetch pending messages:', e);
    }
    await this.waitForMessageQueueIdle();
  }

  // ── Delivery wrappers ─────────────────────────────────────────────────────
  // All methods below are pure pass-throughs to this.delivery. Both Web and Tauri
  // implementations were 100% identical, so they live here once.

  /** Announces to group members that this device needs a Welcome. */
  async sendWelcomeRequest(groupId: string): Promise<void> {
    await this.delivery.deliveryPost('welcome-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
  }

  async clearPendingWelcomeRequests(groupId: string): Promise<void> {
    await this.delivery.clearPendingWelcomeRequests(groupId);
  }

  /** Delivers a Welcome message to the target user/device. */
  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    return this.delivery.sendWelcome(
      welcomeBytes,
      targetUserId,
      groupId,
      targetDeviceId,
      ratchetTreeBytes
    );
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  async fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  > {
    return this.delivery.fetchUserDevices(userId);
  }

  async fetchDeviceKeyPackage(
    userId: string,
    deviceId: string
  ): Promise<{
    keyPackage: Uint8Array;
    deviceId: string;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  } | null> {
    return this.delivery.fetchDeviceKeyPackage(userId, deviceId);
  }

  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
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

  async acquireAddLock(groupId: string, ttlMs = 10_000): Promise<boolean> {
    return this.delivery.acquireAddLock(groupId, ttlMs);
  }

  async releaseAddLock(groupId: string): Promise<void> {
    return this.delivery.releaseAddLock(groupId);
  }

  async createRemoteGroup(name: string, isGroup = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  async fetchHistory(
    groupId: string,
    afterStreamId?: string
  ): Promise<{ id?: string; sender_id: string; content: string; timestamp: string }[]> {
    return this.delivery.fetchHistory(groupId, afterStreamId);
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

  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  async getGroupUserMembers(groupId: string): Promise<{ userId: string }[]> {
    return this.delivery.getGroupUserMembers(groupId);
  }

  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  async claimGroupSuccessor(
    deadGroupId: string,
    successorId: string
  ): Promise<{ claimed: boolean; successorId: string | null }> {
    return this.delivery.claimGroupSuccessor(deadGroupId, successorId);
  }

  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  async getDeviceMemberships(
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
  > {
    return this.delivery.getDeviceMemberships(userId, deviceId);
  }

  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void> {
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
    deviceId: string
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }> {
    return this.delivery.deleteDevice(userId, deviceId);
  }

  // ── Platform-specific (abstract) ──────────────────────────────────────────

  abstract saveState(pin: string): Promise<Uint8Array>;
  abstract changePIN(newPin: string): Promise<void>;
  abstract generateKeyPackage(pin: string): Promise<Uint8Array>;
  abstract publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
  abstract sendCommit(
    commitBytes: Uint8Array,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void>;
  abstract createGroup(groupId: string): Promise<void>;
  abstract forceCreateGroup(groupId: string): Promise<void>;
  abstract addMember(
    groupId: string,
    keyPackageBytes: Uint8Array
  ): Promise<{ commit: Uint8Array; welcome?: Uint8Array; ratchetTree?: Uint8Array }>;
  abstract addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedDeviceIds: string[];
    ratchetTree?: Uint8Array;
  }>;
  abstract processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string>;
  abstract sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    messageId?: string,
    silent?: boolean
  ): Promise<Uint8Array>;
  abstract processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null>;
  abstract exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;
  abstract getLocalGroups(): string[];
  abstract getEpoch(groupId: string): number;
  abstract forgetGroup(groupId: string, minEpoch?: number): void;
  abstract dropGroup(groupId: string): void;
  abstract removeMember(groupId: string, userIds: string[]): Promise<void>;
  abstract removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void>;
}
