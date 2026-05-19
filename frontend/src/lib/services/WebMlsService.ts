import type { IMlsService, GroupMeta, UserGroupRow } from '$lib/mls-client';
import {
  loadAndInitWasm,
  shouldAckAfterSuccess,
  shouldAckAfterWebException,
  logMlsMetric,
  resolveMlsPublicUrls,
  MlsDeliveryApi,
  detectRuntimeDeviceOs,
} from '$lib/mls-client';
import { getToken } from '$lib/stores/auth';
import { saveMlsState } from '$lib/utils/hex';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Message pending in the processing queue */
interface QueuedMessage {
  senderId: string;
  ciphertext: Uint8Array;
  groupId?: string;
  isWelcome: boolean;
  isCommit: boolean;
  ratchetTreeBytes?: Uint8Array;
  /** ID from the delivery service queue — used for at-least-once ACK */
  queuedMessageId?: string;
}

/** Queue depth above which incoming messages are batched into one UI update per conversation. */
const BULK_CATCHUP_THRESHOLD = 3;

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
  private client: any;
  private ws: WebSocket | null = null;
  public onChannelEvent?: (event: { type: string; data: any }) => void;
  private messageCallback:
    | ((
        senderId: string,
        content: Uint8Array,
        groupId?: string,
        isWelcome?: boolean,
        ratchetTreeBytes?: Uint8Array,
        isCommit?: boolean
      ) => Promise<boolean>)
    | null = null;
  private disconnectCallback: (() => void) | null = null;
  private reinviteRequestCallback: ((senderDeviceId: string, groupId: string) => void) | null =
    null;
  private welcomeRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;
  private welcomeProcessedCallback: ((groupId?: string) => void) | null = null;
  private baseUrl: string; // Chat Gateway URL
  private historyUrl: string; // Chat Delivery Service URL
  private userId: string = 'unknown';
  private deviceId: string;
  /** Shared chat-delivery REST client (`/api/mls/*`). */
  private readonly delivery: MlsDeliveryApi;
  /** Resolved when init() completes; shared across concurrent callers to avoid double WASM init. */
  private initPromise: Promise<void> | null = null;
  /** True when initialized without existing state — triggers OTKP purge before new ones are published. */
  private freshStart = false;
  private networkListenersRegistered = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Message queue for sequential processing
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue = false;
  // Timer de retry in-session : si un message delivery-queue n'a pas été ACKé (return false),
  // on reprogramme fetchPendingMessages après PENDING_RETRY_DELAY_MS plutôt d'attendre reconnect.
  private pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PENDING_RETRY_DELAY_MS = 15_000;
  private bulkIngestStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void;
  private bulkIngestEnd?: (
    enableBulkBuffer?: boolean,
    showOverlay?: boolean
  ) => void | Promise<void>;
  // Groups currently being joined (Welcome in progress) - buffer messages for these
  private pendingWelcomeGroups = new Map<string, QueuedMessage[]>();
  constructor() {
    // Device ID is initialized per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    const urls = resolveMlsPublicUrls();
    this.baseUrl = urls.baseUrl;
    this.historyUrl = urls.historyUrl;
    this.delivery = new MlsDeliveryApi({
      historyUrl: this.historyUrl,
      getToken,
      getEpoch: (groupId) => this.getEpoch(groupId),
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pendingRetryTimer !== null) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        this.disconnectCallback?.();
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.clearHeartbeat();
        this.disconnectCallback?.();
      }
    }, 8_000);
  }

  isWsOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** WASM client wrapper — opens a native browser WebSocket to the chat gateway, wiring message/close handlers and registering reconnect listeners once. */
  async connect(): Promise<void> {
    this.clearHeartbeat();
    // Close existing socket before creating a new one
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    // Register visibility/online listeners once — trigger reconnect when the
    // tab becomes visible or the network comes back after a gap.
    if (!this.networkListenersRegistered && typeof document !== 'undefined') {
      this.networkListenersRegistered = true;
      document.addEventListener('visibilitychange', () => {
        if (
          document.visibilityState === 'visible' &&
          (!this.ws || this.ws.readyState !== WebSocket.OPEN)
        ) {
          this.disconnectCallback?.();
        }
      });
      window.addEventListener('online', () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.disconnectCallback?.();
        }
      });
    }

    // Same-origin cookie often works; passing JWT in the query matches Tauri and
    // fixes upgrades where `canari_ws_token` is not forwarded (proxies, ITP).
    const wsUrl = this.baseUrl.replace(/^https?:/, (match) =>
      match === 'https:' ? 'wss:' : 'ws:'
    );
    let tokenParam = '';
    try {
      const t = await getToken();
      if (t) tokenParam = `&token=${encodeURIComponent(t)}`;
    } catch {
      /* rely on canari_ws_token cookie only */
    }
    const fullWsUrl = `${wsUrl}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam}`;
    const logUrl = `${wsUrl}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam ? '&token=***' : ''}`;

    return new Promise((resolve, reject) => {
      console.log(`Connecting to WebSocket: ${logUrl}`);
      this.ws = new WebSocket(fullWsUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.ws?.close();
          reject(new Error('WebSocket connection timeout after 15s'));
        }
      }, 15_000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        resolved = true;
        this.startHeartbeat();
        console.log('Connected to Chat Gateway with DeviceID:', this.deviceId);
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timeout);
        console.error('WebSocket Error:', event);
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `WebSocket connection failed to ${wsUrl}/api/ws (chat-gateway). Check that the gateway is running and reachable.`
            )
          );
        }
      };
      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `WebSocket closed before opening. Code: ${event.code}, Reason: ${event.reason || 'Connection refused or network error'}`
            )
          );
        } else {
          this.clearHeartbeat();
          console.warn(
            `WebSocket disconnected. Code: ${event.code}, Reason: ${event.reason || 'no reason'}`
          );
          this.disconnectCallback?.();
        }
      };
      this.ws.onmessage = async (event) => {
        try {
          // Gateway sends JSON text frames: { senderId, senderDeviceId, groupId, isWelcome, proto: base64(ciphertext) }
          const text: string =
            typeof event.data === 'string'
              ? event.data
              : event.data instanceof Blob
                ? await (event.data as Blob).text()
                : new TextDecoder().decode(event.data as ArrayBuffer);

          const msg = JSON.parse(text);
          console.log(
            `[WS RCV] JSON frame: senderId=${msg.senderId}, groupId=${msg.groupId}, isWelcome=${msg.isWelcome}, protoLen=${(msg.proto as string)?.length}`
          );
          if (msg.type && (msg.type.startsWith('channel.') || msg.type === 'post_created')) {
            if (this.onChannelEvent) {
              console.log(`[WS RCV] Triggering onChannelEvent for ${msg.type}`);
              this.onChannelEvent({ type: msg.type, data: msg.data });
            } else {
              console.warn(
                `[WS RCV] Received channel/post event but no onChannelEvent registered.`
              );
            }
            return;
          }
          if (msg.type === 'reinvite_request') {
            const senderDev = (msg.senderDeviceId as string) || '';
            const groupId = (msg.groupId as string) || '';
            console.log(`[WS RCV] reinvite_request from ${senderDev} for group ${groupId}`);
            this.reinviteRequestCallback?.(senderDev, groupId);
            return;
          }
          if (msg.type === 'welcome_request') {
            const requesterUserId = (msg.requesterUserId as string) || '';
            const requesterDeviceId = (msg.requesterDeviceId as string) || '';
            const groupId = (msg.groupId as string) || '';
            console.log(
              `[WS RCV] welcome_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
            );
            this.welcomeRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msg.type === 'epoch_rejected') {
            console.warn(
              `[WS RCV] Epoch rejected for group ${msg.groupId} (server epoch: ${msg.currentEpoch})`
            );
            // Notify via channel event so connection.ts can trigger recovery
            if (this.onChannelEvent) {
              this.onChannelEvent({
                type: 'epoch_rejected',
                data: { groupId: msg.groupId, currentEpoch: msg.currentEpoch },
              });
            }
            return;
          }
          if (msg.proto && this.messageCallback) {
            const binaryString = atob(msg.proto as string);
            const ciphertext = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++)
              ciphertext[i] = binaryString.charCodeAt(i);
            const ratchetTreeBytes =
              typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                ? Uint8Array.from(atob(msg.ratchetTree as string), (c) => c.charCodeAt(0))
                : undefined;

            if (ciphertext.length > 0) {
              // Queue the message for sequential processing
              this.enqueueMessage({
                senderId: (msg.senderId as string) || 'unknown',
                ciphertext,
                groupId: (msg.groupId as string) || undefined,
                isWelcome: msg.isWelcome === true,
                isCommit: msg.isCommit === true,
                ratchetTreeBytes,
                queuedMessageId: (msg.queuedMessageId as string) || undefined,
              });
            }
          } else {
            console.warn(`[WS RCV] No proto or no messageCallback set. Message ignored.`);
          }
        } catch (e) {
          console.error('Failed to process WebSocket message:', e);
        }
      };
    });
  }

  onMessage(
    callback: (
      senderId: string,
      content: Uint8Array,
      groupId?: string,
      isWelcome?: boolean,
      ratchetTreeBytes?: Uint8Array,
      isCommit?: boolean
    ) => Promise<boolean>
  ) {
    this.messageCallback = callback;
  }

  /**
   * Enqueue a message for sequential processing.
   * Welcome messages are prioritized and processed first.
   * Messages for groups with pending Welcomes are buffered.
   */
  private enqueueMessage(msg: QueuedMessage) {
    const groupId = msg.groupId;

    // If a Welcome is being processed for this group, buffer the message
    if (groupId && this.pendingWelcomeGroups.has(groupId) && !msg.isWelcome) {
      console.log(`[QUEUE] Buffering message for group ${groupId} (Welcome in progress)`);
      this.pendingWelcomeGroups.get(groupId)!.push(msg);
      return;
    }

    // Welcome messages go to front of queue for priority processing
    if (msg.isWelcome) {
      // Mark this group as having a pending Welcome
      if (groupId) {
        this.pendingWelcomeGroups.set(groupId, []);
      }
      this.messageQueue.unshift(msg);
    } else {
      this.messageQueue.push(msg);
    }

    // Start processing if not already running
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Process messages from the queue one by one.
   * This ensures Welcome messages complete before regular messages.
   */
  private async processQueue() {
    if (this.isProcessingQueue) {
      console.log('[QUEUE] Déjà en cours de traitement — déclenchement ignoré');
      return;
    }
    if (!this.messageCallback) {
      console.warn(
        '[QUEUE] messageCallback non défini — messages en attente ne seront pas traités'
      );
      return;
    }

    this.isProcessingQueue = true;
    const queuedAtStart = this.messageQueue.length;
    const useBulkCatchup = queuedAtStart >= BULK_CATCHUP_THRESHOLD;
    console.log(`[QUEUE] Démarrage traitement (${queuedAtStart} messages en file)`);

    const ackIds: string[] = [];
    let hadFailedQueuedMessage = false;

    try {
      if (queuedAtStart > 0) {
        this.bulkIngestStart?.(useBulkCatchup, useBulkCatchup);
      }

      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift()!;
        const groupId = msg.groupId;

        try {
          console.log(
            `[QUEUE] Traitement ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'message'} groupe=${groupId ?? 'inconnu'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );
          const cbResult = await this.messageCallback(
            msg.senderId,
            msg.ciphertext,
            msg.groupId,
            msg.isWelcome,
            msg.ratchetTreeBytes,
            msg.isCommit
          );
          console.log(
            `[QUEUE] messageCallback → ${cbResult} (groupe=${groupId ?? 'inconnu'})${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
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
              platform: 'web',
              reason: 'callback_retry',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }

          // If this was a Welcome, process buffered messages for this group
          if (msg.isWelcome && groupId && this.pendingWelcomeGroups.has(groupId)) {
            const buffered = this.pendingWelcomeGroups.get(groupId)!;
            console.log(
              `[QUEUE] Welcome complete, processing ${buffered.length} buffered messages`
            );
            this.pendingWelcomeGroups.delete(groupId);

            // Add buffered messages to front of queue (in order)
            for (let i = buffered.length - 1; i >= 0; i--) {
              this.messageQueue.unshift(buffered[i]);
            }
          }

          // Notify Svelte that a Welcome has been fully processed
          if (msg.isWelcome) {
            this.welcomeProcessedCallback?.(groupId);
          }
        } catch (e) {
          console.error(`[QUEUE] Error processing message:`, e);
          const exFlags = {
            isWelcome: msg.isWelcome,
            isCommit: msg.isCommit,
            hasQueuedId: Boolean(msg.queuedMessageId),
          };
          if (shouldAckAfterWebException(exFlags) && msg.queuedMessageId) {
            ackIds.push(msg.queuedMessageId);
          } else if (exFlags.hasQueuedId) {
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: 'web',
              reason: 'web_exception_non_commit',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }
          // Flush buffered messages back to the main queue so they are not lost.
          // They will be processed normally (likely fail with group-not-found, get ACK'd).
          if (groupId && this.pendingWelcomeGroups.has(groupId)) {
            const buffered = this.pendingWelcomeGroups.get(groupId)!;
            this.pendingWelcomeGroups.delete(groupId);
            for (let i = buffered.length - 1; i >= 0; i--) {
              this.messageQueue.unshift(buffered[i]);
            }
          }
        }

        // Let the UI thread paint / handle input between MLS steps (cooperative, not parallel).
        if (this.messageQueue.length > 0) {
          await yieldToMainThread();
        }
      }

      // Batch-ACK all processed real-time messages
      if (ackIds.length > 0) {
        logMlsMetric({ kind: 'queue_ack', platform: 'web', count: ackIds.length });
        void this.delivery.deliveryPost('messages/ack', {
          userId: this.userId,
          deviceId: this.deviceId,
          messageIds: ackIds,
        });
      }

      // Si un message de la delivery queue n'a pas été ACKé (return false), programmer un
      // retry in-session plutôt d'attendre la prochaine reconnexion (backoff ≤ 30s).
      if (hadFailedQueuedMessage && this.ws?.readyState === WebSocket.OPEN) {
        if (this.pendingRetryTimer !== null) clearTimeout(this.pendingRetryTimer);
        this.pendingRetryTimer = setTimeout(() => {
          this.pendingRetryTimer = null;
          if (this.ws?.readyState === WebSocket.OPEN) {
            console.log('[QUEUE] Retry in-session: fetchPendingMessages (message non-ACKé)');
            this.fetchPendingMessages();
          }
        }, WebMlsService.PENDING_RETRY_DELAY_MS);
      }
    } finally {
      if (queuedAtStart > 0) {
        try {
          await this.bulkIngestEnd?.(useBulkCatchup, useBulkCatchup);
        } catch (e) {
          console.error('[QUEUE] bulkIngestEnd failed:', e);
        }
      }
      this.isProcessingQueue = false;
      console.log(`[QUEUE] Queue processing complete`);
    }
  }

  onDisconnect(callback: () => void) {
    this.disconnectCallback = callback;
  }

  /** WASM client wrapper — broadcasts a reinvite_request signal to online group members via the delivery service. */
  async sendReinviteRequest(groupId: string): Promise<void> {
    await this.delivery.deliveryPost('reinvite-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
  }

  onReinviteRequest(callback: (senderDeviceId: string, groupId: string) => void): void {
    this.reinviteRequestCallback = callback;
  }

  /** WASM client wrapper — signals the delivery service that this device needs a Welcome for the given group. */
  async sendWelcomeRequest(groupId: string): Promise<void> {
    await this.delivery.deliveryPost('welcome-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
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
    this.bulkIngestStart = onStart;
    this.bulkIngestEnd = onEnd;
  }

  /** Sends a disconnect control frame over the browser WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'disconnect' }));
      } catch {
        // Best-effort — ignore if the socket is already closing
      }
    }
  }

  // simulateMessageReceive removed — pending messages now go through enqueueMessage
  // so they are serialized with live WebSocket messages via processQueue.

  /** WASM client wrapper — fetches offline-queued messages from the delivery service and routes each one through the message queue. */
  async fetchPendingMessages() {
    if (this.userId === 'unknown') return;

    const FETCH_TIMEOUT = 10_000;

    try {
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), FETCH_TIMEOUT);
      const messages = await this.delivery.pullPendingMessagesJson(ctrl2.signal);
      clearTimeout(tid2);
      if (Array.isArray(messages)) {
        if (messages.length > 0) {
          console.log(`Fetched ${messages.length} pending messages`);

          // Route all pending messages through the serialized queue so they
          // never race with live WebSocket messages calling messageCallback.
          for (const msg of messages as Record<string, unknown>[]) {
            const msgId = (msg.id || msg._id) as string | undefined;
            const proto: string | undefined = typeof msg.proto === 'string' ? msg.proto : undefined;
            const content: string | undefined =
              typeof msg.content === 'string' ? msg.content : undefined;

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
                  });
                }
              } catch (e) {
                console.error('[PENDING] Failed to enqueue proto message:', e);
              }
            } else if (content) {
              // Legacy format (mlsWelcome offline inbox)
              try {
                const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
                if (bytes.length > 0) {
                  this.enqueueMessage({
                    senderId: (msg.senderId || 'unknown') as string,
                    ciphertext: bytes,
                    groupId: (msg.groupId || msg.session_id) as string | undefined,
                    isWelcome: msg.type === 'mlsWelcome',
                    isCommit: msg.isCommit === true,
                    ratchetTreeBytes:
                      typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                        ? Uint8Array.from(atob(msg.ratchetTree as string), (c) => c.charCodeAt(0))
                        : undefined,
                    queuedMessageId: msgId,
                  });
                }
              } catch (e) {
                console.error('[PENDING] Failed to enqueue content message:', e);
              }
            }
          }
        } else {
          console.log(`[MSG][PENDING] No pending MLS message for ${this.userId}:${this.deviceId}`);
        }
      } else {
        console.warn(
          `[MSG][PENDING] Pending message fetch failed or non-array (${this.userId}:${this.deviceId})`
        );
      }
    } catch (e) {
      console.error('Failed to fetch pending messages', e);
    }
  }

  /** WASM client wrapper — fetches all registered devices for a user from the delivery service, decoding base64 key packages. */
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

  /** WASM client wrapper — registers a user as a server-side member of the given MLS group on the delivery service. */
  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  /** WASM client wrapper — publishes this device's static fallback KeyPackage to the delivery service, including device name/OS metadata. */
  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = btoa(Array.from(keyPackageBytes, (b) => String.fromCharCode(b)).join(''));
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    await this.delivery.registerDeviceKeyPackage({
      keyPackageBase64: base64,
      deviceName: storedName,
      deviceOs: detectRuntimeDeviceOs(),
    });
  }

  /** WASM client wrapper — bulk-uploads one-time prekey packages to replenish the server pool. */
  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    return this.delivery.publishKeyPackages(packages);
  }

  /** WASM client wrapper — PATCHes device label and/or OS metadata on the delivery service. */
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

  /** WASM client wrapper — delivers an MLS Welcome message to all devices (or a specific device) of the target user in parallel. */
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

  /** WASM client wrapper — validates the commit epoch via the delivery service then broadcasts the MLS commit to all group members. */
  async sendCommit(
    commitBytes: Uint8Array,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    return this.delivery.sendCommitBytes(commitBytes, groupId, excludeDeviceIds);
  }

  /** WASM client wrapper — requests the Redis add-lock from the delivery service; fails open (returns true) on network error to avoid deadlock. */
  async acquireAddLock(groupId: string, ttlMs = 10_000): Promise<boolean> {
    return this.delivery.acquireAddLock(groupId, ttlMs);
  }

  /** WASM client wrapper — releases the Redis add-lock for the given group; errors are silently ignored. */
  async releaseAddLock(groupId: string): Promise<void> {
    return this.delivery.releaseAddLock(groupId);
  }

  /** WASM client wrapper — loads and initializes the WASM module via `loadAndInitWasm`, deduplicating concurrent calls via a shared promise. */
  async init(userId: string, pin: string, state?: Uint8Array) {
    // If already initialized or initialization is in flight, reuse the same promise.
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initImpl(userId, pin, state);
    try {
      await this.initPromise;
    } finally {
      // Keep initPromise set so late callers still short-circuit via `this.client`.
    }
  }

  /** Implementation body for init(); resolves device ID from localStorage and calls `loadAndInitWasm`, handling credential-mismatch recovery. */
  private async _initImpl(userId: string, pin: string, state?: Uint8Array) {
    this.userId = userId;
    this.delivery.userId = userId;
    this.freshStart = !state;

    // Per-user device ID — prevents two users in the same browser from sharing a
    // device ID, which would cause the delivery service to route the welcome message
    // to the wrong user.
    const deviceKey = `mls_device_id_${userId}`;
    const storedDevice = localStorage.getItem(deviceKey);
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      this.deviceId =
        'web-' +
        userId +
        '-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2, 6);
      localStorage.setItem(deviceKey, this.deviceId);
    }

    this.delivery.deviceId = this.deviceId;

    try {
      this.client = await loadAndInitWasm(userId, this.deviceId, state, pin);
    } catch (e) {
      // Credential identity mismatch: saved WASM state embeds a different device ID
      // (e.g. localStorage cleared and device ID regenerated, or state imported from
      // another device). Discard the stale state and start fresh.
      if (String(e).includes('identity mismatch') || String(e).includes('Credential identity')) {
        const oldDeviceId = this.deviceId;
        console.warn('[MLS] Credential mismatch — discarding stale state, starting fresh');
        this.deviceId =
          'web-' +
          userId +
          '-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 6);
        localStorage.setItem(deviceKey, this.deviceId);
        this.delivery.deviceId = this.deviceId;
        this.client = await loadAndInitWasm(userId, this.deviceId, undefined, pin);
        this.deleteDevice(userId, oldDeviceId).catch((err) =>
          console.warn(`[MLS] Cleanup old device ${oldDeviceId} failed:`, err)
        );
      } else {
        console.error('WASM Init Failed:', e);
        throw e;
      }
    }
  }

  /** WASM client wrapper — calls `this.client.create_group` to create a new local MLS group. */
  async createGroup(groupId: string) {
    this.client.create_group(groupId);
  }

  /** WASM client wrapper — calls `this.client.force_create_group`, wiping any orphan state before creating the group. */
  async forceCreateGroup(groupId: string) {
    this.client.force_create_group(groupId);
  }

  /** WASM client wrapper — creates a group record on the delivery service and returns the server-assigned groupId. */
  async createRemoteGroup(name: string, isGroup: boolean = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  // Updated to accept PIN
  /** WASM client wrapper — calls `this.client.save_state(pin)` to encrypt and return the current MLS state as bytes. */
  async saveState(pin: string) {
    // Pass PIN to save encrypted
    // Wasm binding updated to accept optional PIN
    return this.client.save_state(pin);
  }

  /** WASM client wrapper — calls `this.client.generate_key_package`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  async generateKeyPackage(pin: string) {
    // Always generate a fresh static fallback KP for this device.
    const fallback = this.client.generate_key_package() as Uint8Array;

    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      await this.delivery.deleteAllOneTimePrekeys();
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    // 50 is sufficient for normal use and avoids bloating the MLS state
    // with hundreds of unused private key bundles (each ~400 bytes).
    const existing = await this.delivery.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);

    let poolPackages: Uint8Array[] = [];
    if (needed > 0) {
      // generate_key_packages returns a js_sys::Array of Uint8Array values.
      poolPackages = [
        ...(this.client.generate_key_packages(needed) as unknown as Iterable<Uint8Array>),
      ];
    }

    // Save state once after all generations so the private key material is persisted.
    try {
      const stateBytes = this.client.save_state(pin);
      await saveMlsState(this.userId, stateBytes as Uint8Array);
    } catch (e) {
      console.warn('Auto-save failed in WASM mode', e);
    }

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /** WASM client wrapper — calls `this.client.add_member` and returns the commit, optional Welcome, and optional ratchet tree. */
  async addMember(groupId: string, keyPackageBytes: Uint8Array) {
    const res = this.client.add_member(groupId, keyPackageBytes);
    return {
      commit: res[0],
      welcome: res[1],
      ratchetTree: res[2] as Uint8Array | undefined,
    };
  }

  /** WASM client wrapper — calls `this.client.add_members_bulk` to add multiple devices in a single OpenMLS commit, producing one shared Welcome. */
  async addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>
  ) {
    // Build a JS Array of Uint8Array for the WASM call
    const jsArray = devices.reduce((arr, d) => {
      arr.push(d.keyPackage);
      return arr;
    }, [] as Uint8Array[]);
    const res = this.client.add_members_bulk(groupId, jsArray);
    // res = [commit: Uint8Array, welcome: Uint8Array|undefined, added_count: number]
    const addedCount = res[2] as number;
    const addedDeviceIds = devices.slice(0, addedCount).map((d) => d.deviceId);
    return {
      commit: res[0] as Uint8Array,
      welcome: res[1] as Uint8Array | undefined,
      addedDeviceIds,
      ratchetTree: res[3] as Uint8Array | undefined,
    };
  }

  /** WASM client wrapper — calls `this.client.process_welcome` and returns the derived groupId. */
  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array) {
    return this.client.process_welcome(welcomeBytes, ratchetTreeBytes);
  }

  /** WASM client wrapper — encrypts plaintext via `this.client.send_message_bytes`, then POSTs the ciphertext to the delivery service. */
  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string,
    silent = false
  ): Promise<Uint8Array> {
    const encryptedBytes: Uint8Array = this.client.send_message_bytes(groupId, messageBytes);
    const proto = btoa(Array.from(encryptedBytes, (b) => String.fromCharCode(b)).join(''));
    await this.delivery.postApplicationMessage(groupId, proto, silent);
    return encryptedBytes;
  }

  /** WASM client wrapper — decrypts a raw MLS ciphertext via `this.client.process_incoming_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const result = this.client.process_incoming_message_bytes(groupId, messageBytes);
    return result ?? null;
  }

  /** WASM client wrapper — calls `this.client.export_secret` to derive keying material for channel encryption. */
  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    if (!this.client) throw new Error('WC not initialized');
    return this.client.export_secret(groupId, label, context, keyLen);
  }

  /** WASM client wrapper — fetches Redis Stream history from the delivery service, optionally starting after a given stream ID. */
  async fetchHistory(
    groupId: string,
    afterStreamId?: string
  ): Promise<{ id?: string; sender_id: string; content: string; timestamp: string }[]> {
    return this.delivery.fetchHistory(groupId, afterStreamId);
  }

  /** Returns the stable per-user device ID used to identify this browser client on the delivery service. */
  getDeviceId(): string {
    return this.deviceId;
  }

  /** WASM client wrapper — returns all MLS group IDs known to the WASM module via `this.client.get_groups`. */
  getLocalGroups(): string[] {
    if (!this.client) return [];
    return Array.from(this.client.get_groups() as Iterable<string>);
  }

  /** WASM client wrapper — returns the current MLS epoch for a group via `this.client.get_epoch`, or 0 if unavailable. */
  getEpoch(groupId: string): number {
    if (!this.client) return 0;
    try {
      return this.client.get_epoch(groupId) as number;
    } catch {
      return 0;
    }
  }

  /** WASM client wrapper — calls `this.client.forget_group` to drop local MLS state for the given group. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    if (!this.client) return;
    try {
      this.client.forget_group(groupId, minEpoch);
    } catch (e) {
      console.warn('[MLS] forgetGroup error:', e);
    }
  }

  /** WASM client wrapper — PATCHes the group name on the delivery service. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    return this.delivery.renameGroup(groupId, name);
  }

  /** WASM client wrapper — DELETEs the group record from the delivery service. */
  async deleteGroupOnServer(groupId: string): Promise<void> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  /** WASM client wrapper — removes a user's server-side membership from the group on the delivery service. */
  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  /** WASM client wrapper — calls `this.client.remove_members` to generate a remove commit for all devices of the given users, then broadcasts it. */
  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    // Build a JS Array for the WASM call
    const jsArray = userIds.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    const commitBytes: Uint8Array = this.client.remove_members(groupId, jsArray);
    await this.sendCommit(commitBytes, groupId);
  }

  /** WASM client wrapper — calls `this.client.remove_members_by_device` to remove specific devices by identity string and broadcasts the resulting commit. */
  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const jsArray = deviceIdentities.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    const commitBytes: Uint8Array = this.client.remove_members_by_device(groupId, jsArray);
    await this.sendCommit(commitBytes, groupId);
  }

  /** WASM client wrapper — fetches the server-side member list for a group from the delivery service. */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  /** WASM client wrapper — fetches all groups the given user belongs to from the delivery service. */
  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  /** WASM client wrapper — fetches server-side group metadata (successor routing). */
  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  /** WASM client wrapper — CAS claim for dead-group successor. */
  async claimGroupSuccessor(
    deadGroupId: string,
    successorId: string
  ): Promise<{ claimed: boolean; successorId: string | null }> {
    return this.delivery.claimGroupSuccessor(deadGroupId, successorId);
  }

  /** WASM client wrapper — retrieves pending device-group invitations for this device from the delivery service. */
  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  /** WASM client wrapper — retrieves all device-group membership records for this device from the delivery service. */
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
      lastEpochSeen: number;
    }>
  > {
    return this.delivery.getDeviceMemberships(userId, deviceId);
  }

  /** WASM client wrapper — POSTs an invitation status update (e.g. welcome_received) to the delivery service. */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'welcome_sent' | 'welcome_received' | 'stale',
    lastEpochSeen?: number
  ): Promise<void> {
    return this.delivery.updateInvitationStatus(deviceId, userId, groupId, status, lastEpochSeen);
  }

  /** WASM client wrapper — resets a device-group membership to pending after an MLS remove commit targeting that device. */
  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    return this.delivery.kickStaleDevice(deviceId, userId, groupId);
  }

  /** WASM client wrapper — DELETEs a single device-group membership record from the delivery service. */
  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteDeviceMembership(userId, deviceId, groupId);
  }

  /** WASM client wrapper — DELETEs all device-group membership records for a device from the delivery service. */
  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteAllDeviceMemberships(userId, deviceId);
  }

  /** WASM client wrapper — fully removes a device from the delivery service, cleaning up groups, KeyPackages, and push token. */
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
}
