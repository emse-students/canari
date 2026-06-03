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
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import type { IncomingDeliveryMeta } from '$lib/mls-client/IMlsService';
import { MlsPerGroupScheduler, type MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import MlsKeyPackageWorker from '../workers/mlsKeyPackage.worker?worker';

/**
 * Worker result for key package generation done off the main thread.
 * Buffers are transferred back to avoid an additional clone cost.
 */
interface WorkerKeyPackageResult {
  fallback: Uint8Array;
  poolPackages: Uint8Array[];
  state: Uint8Array;
}

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
        isCommit?: boolean,
        deliveryMeta?: IncomingDeliveryMeta
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
  /** True when initialized without existing state - triggers OTKP purge before new ones are published. */
  private freshStart = false;
  private _visibilityHandler: (() => void) | null = null;
  private _onlineHandler: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive pings sent without any incoming data frame from the server. */
  private missedHeartbeats = 0;
  /** Maximum consecutive pings without any server activity before we force-close. */
  private static readonly MAX_MISSED_HEARTBEATS = 3;
  /** Last persisted MLS state snapshot used as worker bootstrap input. */
  private lastKnownState: Uint8Array | undefined;
  /** Dedicated worker for expensive key package generation. */
  private keyPackageWorker: Worker | null = null;
  /** Feature flag for workerized key package generation (enabled by default). */
  private readonly useKeyPackageWorker = import.meta.env.VITE_MLS_KEYPACKAGE_WORKER !== 'false';

  /** Per-conversation queues with round-robin scheduling and a global MLS mutex. */
  private readonly messageScheduler = new MlsPerGroupScheduler('web');
  // Timer de retry in-session : si un message delivery-queue n'a pas été ACKé (return false),
  // on reprogramme fetchPendingMessages après PENDING_RETRY_DELAY_MS plutôt d'attendre reconnect.
  private pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PENDING_RETRY_DELAY_MS = 15_000;
  private bulkIngestStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void;
  private bulkIngestEnd?: (
    enableBulkBuffer?: boolean,
    showOverlay?: boolean
  ) => void | Promise<void>;
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

  /** Returns a singleton key package worker instance. */
  private getOrCreateKeyPackageWorker(): Worker {
    if (!this.keyPackageWorker) {
      this.keyPackageWorker = new MlsKeyPackageWorker();
    }
    return this.keyPackageWorker;
  }

  /** Rebuilds the in-memory WASM client from a trusted persisted state snapshot. */
  private async reloadClientFromState(state: Uint8Array, pin: string): Promise<void> {
    this.client = await loadAndInitWasm(this.userId, this.deviceId, state, pin);
  }

  /**
   * Runs key package generation in a worker and resolves with generated artifacts.
   *
   * Garanties :
   * - Timeout 30s : le timer est annulé dès que le worker répond (pas de fuite de timer).
   * - Cleanup des listeners : `removeEventListener` est toujours appelé, qu'on résolve,
   *   rejette ou timeout, grâce au flag `settled` et à `cleanup()`.
   * - Fin de worker sur timeout : le worker est terminé (`terminate()`) et le singleton
   *   mis à null pour éviter qu'une réponse tardive ne contamine le prochain appel.
   * - Transfert du buffer d'état : le `ArrayBuffer` est transféré (pas copié) pour éviter
   *   la duplication mémoire sur un snapshot qui peut peser plusieurs centaines de ko.
   */
  private runWorkerKeyPackageGeneration(
    pin: string,
    needed: number,
    state?: Uint8Array
  ): Promise<WorkerKeyPackageResult> {
    return new Promise<WorkerKeyPackageResult>((resolve, reject) => {
      const worker = this.getOrCreateKeyPackageWorker();
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timeoutId);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      const onMessage = (event: MessageEvent): void => {
        if (settled) return;
        const msg = event.data as
          | {
              type: 'generateKeyPackage:ok';
              payload: { fallback: ArrayBuffer; poolPackages: ArrayBuffer[]; state: ArrayBuffer };
            }
          | { type: 'generateKeyPackage:error'; error: string };
        if (!msg) return;
        if (msg.type === 'generateKeyPackage:ok') {
          settled = true;
          cleanup();
          resolve({
            fallback: new Uint8Array(msg.payload.fallback),
            poolPackages: msg.payload.poolPackages.map((b) => new Uint8Array(b)),
            state: new Uint8Array(msg.payload.state),
          });
        } else if (msg.type === 'generateKeyPackage:error') {
          settled = true;
          cleanup();
          reject(new Error(msg.error));
        }
      };

      const onError = (event: ErrorEvent): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(event.error ?? new Error(event.message || 'worker error'));
      };

      // Le timer est annulé par cleanup() dans onMessage/onError — pas de fuite.
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // Terminer l'instance worker pour qu'une réponse tardive n'arrive pas sur
        // un nouveau listener enregistré par le prochain appel à generateKeyPackage.
        this.keyPackageWorker?.terminate();
        this.keyPackageWorker = null;
        reject(new Error('key package worker timeout after 15s'));
      }, 15_000);

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);

      // Transférer le buffer (ownership move, pas de copie) pour éviter de doubler
      // la mémoire sur un snapshot pouvant peser plusieurs centaines de ko.
      const workerState = state ? state.slice() : undefined;
      worker.postMessage(
        {
          type: 'generateKeyPackage',
          payload: {
            userId: this.userId,
            deviceId: this.deviceId,
            pin,
            needed,
            state: workerState?.buffer,
          },
        },
        workerState ? [workerState.buffer] : []
      );
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

  /** Closes the socket without throwing on already-closing WebViews. */
  private safeCloseWebSocket(ws: WebSocket, code = 1000, reason?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        this.disconnectCallback?.();
        return;
      }
      // Check if the server has sent anything since the last ping (JSON pong or data).
      // WS protocol Pong frames do not fire `onmessage` in browsers.
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats > WebMlsService.MAX_MISSED_HEARTBEATS) {
        console.warn(
          `[WS] ${this.missedHeartbeats} pings sans réponse serveur — fermeture connexion zombie`
        );
        this.clearHeartbeat();
        this.safeCloseWebSocket(ws, 1001, 'heartbeat timeout');
        this.disconnectCallback?.();
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.clearHeartbeat();
        this.disconnectCallback?.();
      }
    }, 8_000);
  }

  /** Call whenever a data frame is received to reset the heartbeat counter. */
  private resetHeartbeatCounter(): void {
    this.missedHeartbeats = 0;
  }

  isWsOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** WASM client wrapper - opens a native browser WebSocket to the chat gateway, wiring message/close handlers and registering reconnect listeners once. */
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

    // Register visibility/online listeners once - trigger reconnect when the
    // tab becomes visible or the network comes back after a gap.
    if (!this._visibilityHandler && typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        if (
          document.visibilityState === 'visible' &&
          (!this.ws || this.ws.readyState !== WebSocket.OPEN)
        ) {
          this.disconnectCallback?.();
        }
      };
      this._onlineHandler = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.disconnectCallback?.();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      window.addEventListener('online', this._onlineHandler);
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
        // Any incoming frame proves the server is alive — reset heartbeat miss counter.
        this.resetHeartbeatCounter();
        try {
          // Gateway sends JSON text frames: { senderId, senderDeviceId, groupId, isWelcome, proto: base64(ciphertext) }
          const text: string =
            typeof event.data === 'string'
              ? event.data
              : event.data instanceof Blob
                ? await (event.data as Blob).text()
                : new TextDecoder().decode(event.data as ArrayBuffer);

          const msg = JSON.parse(text);
          const frameType = typeof msg.type === 'string' ? msg.type : '';
          if (frameType === 'pong' || frameType === 'ping') {
            return;
          }
          console.log(
            `[WS RCV] JSON frame: senderId=${msg.senderId}, groupId=${msg.groupId}, isWelcome=${msg.isWelcome}, protoLen=${(msg.proto as string)?.length}`
          );
          if (frameType && (frameType.startsWith('channel.') || frameType === 'post_created')) {
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
                queuedCreatedAt: parseServerTimestampMs(msg.createdAt),
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
      isCommit?: boolean,
      deliveryMeta?: IncomingDeliveryMeta
    ) => Promise<boolean>
  ) {
    this.messageCallback = callback;
  }

  /** Enqueues a message and starts the per-group fair drain loop if idle. */
  private enqueueMessage(msg: MlsQueuedMessage) {
    this.messageScheduler.enqueue(msg);
    if (!this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /** Resolves when all per-group MLS queues are drained. */
  async waitForMessageQueueIdle(): Promise<void> {
    return this.messageScheduler.waitUntilIdle();
  }

  /** Drains per-group queues (round-robin across conversations, sequential MLS mutex). */
  private async processQueue() {
    if (!this.messageCallback) {
      console.warn(
        '[QUEUE] messageCallback non défini - messages en attente ne seront pas traités'
      );
      return;
    }

    const ackIds: string[] = [];
    let hadFailedQueuedMessage = false;

    await this.messageScheduler.drain(
      async (msg) => {
        const groupId = msg.groupId;

        try {
          console.log(
            `[QUEUE] Traitement ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'message'} groupe=${groupId ?? 'inconnu'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
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

          if (msg.isWelcome && groupId) {
            this.messageScheduler.reinjectAfterWelcome(groupId);
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
          if (groupId && this.messageScheduler.hasWelcomePending(groupId)) {
            this.messageScheduler.reinjectAfterWelcome(groupId);
          }
        }
      },
      {
        onDrainStart: (pendingCount) => this.bulkIngestStart?.(true, pendingCount > 1),
        onDrainEnd: async () => {
          if (ackIds.length > 0) {
            logMlsMetric({ kind: 'queue_ack', platform: 'web', count: ackIds.length });
            void this.delivery.deliveryPost('messages/ack', {
              userId: this.userId,
              deviceId: this.deviceId,
              messageIds: ackIds,
            });
          }

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

          await this.bulkIngestEnd?.(true, true);
        },
      }
    );

    // Messages arrivés via WebSocket pendant onDrainEnd (isDraining=true) : relancer le drain.
    if (this.messageScheduler.getPendingCount() > 0 && !this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  onDisconnect(callback: () => void) {
    this.disconnectCallback = callback;
  }

  /** WASM client wrapper - broadcasts a reinvite_request signal to online group members via the delivery service. */
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

  /** WASM client wrapper - signals the delivery service that this device needs a Welcome for the given group. */
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
    // Deux appelants distincts (setupMessageHandler + useChatSession) enregistrent
    // chacun leurs propres hooks ; on les chaîne pour que les deux s'exécutent.
    // Chaque appelant fournit un onStart ET un onEnd symétriques, donc bulkIngestDepth
    // reste équilibré (N incréments = N décréments) quelle que soit l'ordre d'enregistrement.
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

  /** Removes network event listeners and clears all timers. Must be called before discarding this instance (e.g. on logout + device wipe). */
  destroy(): void {
    this.clearHeartbeat();
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    if (this.keyPackageWorker) {
      this.keyPackageWorker.terminate();
      this.keyPackageWorker = null;
    }
  }

  /** Sends a disconnect control frame over the browser WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'disconnect' }));
      } catch {
        // Best-effort - ignore if the socket is already closing
      }
    }
  }

  // simulateMessageReceive removed - pending messages now go through enqueueMessage
  // so they are serialized with live WebSocket messages via processQueue.

  /** WASM client wrapper - fetches offline-queued messages from the delivery service and routes each one through the message queue. */
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
            const queuedCreatedAt = parseServerTimestampMs(msg.createdAt);
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
                    queuedCreatedAt,
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
                    queuedCreatedAt,
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
    await this.waitForMessageQueueIdle();
  }

  /** WASM client wrapper - fetches all registered devices for a user from the delivery service, decoding base64 key packages. */
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

  /** WASM client wrapper - fetches one device's KeyPackage (invite / welcome flows). */
  async fetchDeviceKeyPackage(userId: string, deviceId: string) {
    return this.delivery.fetchDeviceKeyPackage(userId, deviceId);
  }

  /** WASM client wrapper - registers a user as a server-side member of the given MLS group on the delivery service. */
  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  /** WASM client wrapper - publishes this device's static fallback KeyPackage to the delivery service, including device name/OS metadata. */
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

  /** WASM client wrapper - bulk-uploads one-time prekey packages to replenish the server pool. */
  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    return this.delivery.publishKeyPackages(packages);
  }

  /** WASM client wrapper - PATCHes device label and/or OS metadata on the delivery service. */
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

  /** WASM client wrapper - delivers an MLS Welcome message to all devices (or a specific device) of the target user in parallel. */
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

  /** WASM client wrapper - validates the commit epoch via the delivery service then broadcasts the MLS commit to all group members. */
  async sendCommit(
    commitBytes: Uint8Array,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    return this.delivery.sendCommitBytes(commitBytes, groupId, excludeDeviceIds);
  }

  /** WASM client wrapper - requests the Redis add-lock from the delivery service; fails open (returns true) on network error to avoid deadlock. */
  async acquireAddLock(groupId: string, ttlMs = 10_000): Promise<boolean> {
    return this.delivery.acquireAddLock(groupId, ttlMs);
  }

  /** WASM client wrapper - releases the Redis add-lock for the given group; errors are silently ignored. */
  async releaseAddLock(groupId: string): Promise<void> {
    return this.delivery.releaseAddLock(groupId);
  }

  /** WASM client wrapper - loads and initializes the WASM module via `loadAndInitWasm`, deduplicating concurrent calls via a shared promise. */
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
    this.lastKnownState = state ? state.slice() : undefined;

    // Per-user device ID - prevents two users in the same browser from sharing a
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
      // Si l'init échoue ET qu'un état sauvegardé existait, c'est l'état qui est fautif
      // (credential mismatch, corruption partielle, clé Argon2 invalide…).
      // → fresh-start systématique pour ne pas bloquer l'utilisateur indéfiniment.
      // Si state == null et erreur → crash réel (pas d'état à blâmer) → on remonte.
      const errStr = String(e);
      const isCredentialMismatch =
        errStr.includes('identity mismatch') || errStr.includes('Credential identity');
      if (isCredentialMismatch || state != null) {
        const oldDeviceId = this.deviceId;
        if (isCredentialMismatch) {
          console.warn('[MLS] Credential mismatch - discarding stale state, starting fresh');
        } else {
          console.warn(
            '[MLS] État chargé inutilisable (corruption ?) → fresh-start:',
            errStr.slice(0, 200)
          );
        }
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

  /** WASM client wrapper - calls `this.client.create_group` to create a new local MLS group. */
  async createGroup(groupId: string) {
    this.client.create_group(groupId);
  }

  /** WASM client wrapper - calls `this.client.force_create_group`, wiping any orphan state before creating the group. */
  async forceCreateGroup(groupId: string) {
    this.client.force_create_group(groupId);
  }

  /** WASM client wrapper - creates a group record on the delivery service and returns the server-assigned groupId. */
  async createRemoteGroup(name: string, isGroup: boolean = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  // Updated to accept PIN
  /** WASM client wrapper - calls `this.client.save_state(pin)` to encrypt and return the current MLS state as bytes. */
  async saveState(pin: string) {
    // Pass PIN to save encrypted
    // Wasm binding updated to accept optional PIN
    const stateBytes = this.client.save_state(pin) as Uint8Array;
    this.lastKnownState = stateBytes.slice();
    return stateBytes;
  }

  /** WASM client wrapper - calls `this.client.generate_key_package`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  async generateKeyPackage(pin: string) {
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

    let fallback: Uint8Array;
    let poolPackages: Uint8Array[] = [];
    let stateBytesToPersist: Uint8Array | undefined;

    if (this.useKeyPackageWorker && typeof Worker !== 'undefined') {
      // Le worker génère les KeyPackages off-thread, mais son résultat contient des clés
      // privées issues d'un snapshot qui peut être périmé si des messages WebSocket ont été
      // traités en parallèle. On tient le verrou MLS pendant toute la durée du worker pour
      // empêcher tout traitement concurrent — reloadClientFromState est ainsi toujours sûr.
      const workerGenResult = await this.messageScheduler.runUnderMlsLock(async () => {
        try {
          console.log('[MLS] generateKeyPackage via worker (sous mlsLock)');
          const snapshot = (this.client.save_state(pin) as Uint8Array).slice();
          const workerResult = await this.runWorkerKeyPackageGeneration(pin, needed, snapshot);
          // Le verrou est tenu : aucun message n'a pu modifier l'état WASM pendant le worker.
          await this.reloadClientFromState(workerResult.state, pin);
          return {
            fallback: workerResult.fallback,
            poolPackages: workerResult.poolPackages,
            stateBytesToPersist: workerResult.state,
          };
        } catch (e) {
          console.warn('[MLS] key package worker failed, fallback main thread path:', e);
          const fb = this.client.generate_key_package() as Uint8Array;
          const pool =
            needed > 0
              ? [...(this.client.generate_key_packages(needed) as unknown as Iterable<Uint8Array>)]
              : [];
          return {
            fallback: fb,
            poolPackages: pool,
            stateBytesToPersist: this.client.save_state(pin) as Uint8Array,
          };
        }
      });
      fallback = workerGenResult.fallback;
      poolPackages = workerGenResult.poolPackages;
      stateBytesToPersist = workerGenResult.stateBytesToPersist;
    } else {
      // Always generate a fresh static fallback KP for this device.
      fallback = this.client.generate_key_package() as Uint8Array;
      if (needed > 0) {
        // generate_key_packages returns a js_sys::Array of Uint8Array values.
        poolPackages = [
          ...(this.client.generate_key_packages(needed) as unknown as Iterable<Uint8Array>),
        ];
      }
      stateBytesToPersist = this.client.save_state(pin) as Uint8Array;
    }

    if (stateBytesToPersist) {
      try {
        await saveMlsState(this.userId, stateBytesToPersist);
        this.lastKnownState = stateBytesToPersist.slice();
      } catch (e) {
        console.warn('Auto-save failed in WASM mode', e);
      }
    }

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /** WASM client wrapper - calls `this.client.add_member` and returns the commit, optional Welcome, and optional ratchet tree. */
  async addMember(groupId: string, keyPackageBytes: Uint8Array) {
    const res = this.client.add_member(groupId, keyPackageBytes);
    return {
      commit: res[0],
      welcome: res[1],
      ratchetTree: res[2] as Uint8Array | undefined,
    };
  }

  /** WASM client wrapper - calls `this.client.add_members_bulk` to add multiple devices in a single OpenMLS commit, producing one shared Welcome. */
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

  /** WASM client wrapper - calls `this.client.process_welcome` and returns the derived groupId. */
  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array) {
    return this.client.process_welcome(welcomeBytes, ratchetTreeBytes);
  }

  /** WASM client wrapper - encrypts plaintext via `this.client.send_message_bytes`, then POSTs the ciphertext to the delivery service. */
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

  /** WASM client wrapper - decrypts a raw MLS ciphertext via `this.client.process_incoming_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const result = this.client.process_incoming_message_bytes(groupId, messageBytes);
    return result ?? null;
  }

  /** WASM client wrapper - calls `this.client.export_secret` to derive keying material for channel encryption. */
  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    if (!this.client) throw new Error('WC not initialized');
    return this.client.export_secret(groupId, label, context, keyLen);
  }

  /** WASM client wrapper - fetches Redis Stream history from the delivery service, optionally starting after a given stream ID. */
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

  /** WASM client wrapper - returns all MLS group IDs known to the WASM module via `this.client.get_groups`. */
  getLocalGroups(): string[] {
    if (!this.client) return [];
    return Array.from(this.client.get_groups() as Iterable<string>);
  }

  /** WASM client wrapper - returns the current MLS epoch for a group via `this.client.get_epoch`, or 0 if unavailable. */
  getEpoch(groupId: string): number {
    if (!this.client) return 0;
    try {
      return this.client.get_epoch(groupId) as number;
    } catch {
      return 0;
    }
  }

  /** WASM client wrapper - calls `this.client.forget_group` to drop local MLS state for the given group. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    if (!this.client) return;
    try {
      this.client.forget_group(groupId, minEpoch);
    } catch (e) {
      console.warn('[MLS] forgetGroup error:', e);
    }
  }

  /** Poison Pill - purge définitive : mémoire WASM, stockage OpenMLS et verrou d'epoch à MAX. */
  dropGroup(groupId: string): void {
    if (!this.client) return;
    try {
      this.client.drop_group(groupId);
    } catch (e) {
      console.warn('[MLS] dropGroup error:', e);
    }
  }

  /** Signale au serveur que ce device quitte un groupe de manière irrécupérable (Poison Pill). */
  async forceLeaveGroup(groupId: string): Promise<void> {
    try {
      await this.delivery.deliveryPost(`mls/groups/${groupId}/force_leave`, {
        deviceId: this.deviceId,
      });
    } catch (e) {
      console.warn('[MLS] forceLeaveGroup error (non-fatal):', e);
    }
  }

  /** WASM client wrapper - PATCHes the group name on the delivery service. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    return this.delivery.renameGroup(groupId, name);
  }

  /** WASM client wrapper - DELETEs the group record from the delivery service. */
  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  /** WASM client wrapper - removes a user's server-side membership from the group on the delivery service. */
  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  /** WASM client wrapper - calls `this.client.remove_members` to generate a remove commit for all devices of the given users, then broadcasts it. */
  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    // Build a JS Array for the WASM call
    const jsArray = userIds.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    const commitBytes: Uint8Array = this.client.remove_members(groupId, jsArray);
    await this.sendCommit(commitBytes, groupId);
  }

  /** WASM client wrapper - calls `this.client.remove_members_by_device` to remove specific devices by identity string and broadcasts the resulting commit. */
  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const jsArray = deviceIdentities.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    const commitBytes: Uint8Array = this.client.remove_members_by_device(groupId, jsArray);
    await this.sendCommit(commitBytes, groupId);
  }

  /** WASM client wrapper - fetches the server-side member list for a group from the delivery service. */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  /** WASM client wrapper - fetches all groups the given user belongs to from the delivery service. */
  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  /** WASM client wrapper - fetches server-side group metadata (successor routing). */
  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  /** WASM client wrapper - CAS claim for dead-group successor. */
  async claimGroupSuccessor(
    deadGroupId: string,
    successorId: string
  ): Promise<{ claimed: boolean; successorId: string | null }> {
    return this.delivery.claimGroupSuccessor(deadGroupId, successorId);
  }

  /** WASM client wrapper - retrieves pending device-group invitations for this device from the delivery service. */
  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  /** WASM client wrapper - retrieves all device-group membership records for this device from the delivery service. */
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

  /** WASM client wrapper - POSTs an invitation status update (e.g. welcome_received) to the delivery service. */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'welcome_sent' | 'welcome_received' | 'stale',
    lastEpochSeen?: number
  ): Promise<void> {
    return this.delivery.updateInvitationStatus(deviceId, userId, groupId, status, lastEpochSeen);
  }

  /** WASM client wrapper - resets a device-group membership to pending after an MLS remove commit targeting that device. */
  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    return this.delivery.kickStaleDevice(deviceId, userId, groupId);
  }

  /** WASM client wrapper - DELETEs a single device-group membership record from the delivery service. */
  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteDeviceMembership(userId, deviceId, groupId);
  }

  /** WASM client wrapper - DELETEs all device-group membership records for a device from the delivery service. */
  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteAllDeviceMemberships(userId, deviceId);
  }

  /** WASM client wrapper - fully removes a device from the delivery service, cleaning up groups, KeyPackages, and push token. */
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
