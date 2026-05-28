import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';
import NativeWebSocket, { type Message as WsMessage } from '@tauri-apps/plugin-websocket';
import type { IMlsService, GroupMeta, UserGroupRow } from '$lib/mls-client';
import {
  shouldAckAfterSuccess,
  shouldAckAfterTauriGenericException,
  shouldAckGroupResetControl,
  logMlsMetric,
  commitBaseEpochForValidation,
  resolveMlsPublicUrls,
  MlsDeliveryApi,
  detectRuntimeDeviceOs,
} from '$lib/mls-client';
import { getToken } from '$lib/stores/auth';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import type { IncomingDeliveryMeta } from '$lib/mls-client/IMlsService';

/** Queue depth above which incoming messages are batched into one UI update per conversation. */
const BULK_CATCHUP_THRESHOLD = 3;

/** Message pending in the processing queue */
interface QueuedMessage {
  senderId: string;
  ciphertext: Uint8Array;
  groupId?: string;
  isWelcome: boolean;
  isCommit: boolean;
  ratchetTreeBytes?: Uint8Array;
  /** ID from the delivery service queue - used for at-least-once ACK */
  queuedMessageId?: string;
  /** Server queue enqueue time (ms) - timestamp fallback when `sentAt` is absent. */
  queuedCreatedAt?: number;
  /**
   * Type discriminant for control messages persisted by the server.
   * 'group_reset' : signal hors-bande indiquant que l'arbre MLS du groupe
   *                 a été reconstruit ; déclenche forgetGroup() avant le Welcome.
   */
  type?: string;
}

/** Native batch result for key package generation plus immediate `mls.bin` persistence. */
interface NativeKeyPackageBatchResult {
  fallback: number[];
  pool_packages: number[][];
  state: number[];
}

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly

export class TauriMlsService implements IMlsService {
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
  private baseUrl: string;
  private historyUrl: string;
  private userId: string = 'unknown';
  private deviceId: string;
  /** Shared chat-delivery REST client (`/api/mls/*`); uses Tauri `plugin-http` fetch. */
  private readonly delivery: MlsDeliveryApi;
  private ws: Awaited<ReturnType<typeof NativeWebSocket.connect>> | null = null;
  private wsUnlisten: (() => void) | null = null;
  /** Cache of locally known MLS group IDs, populated after init and updated on group changes. */
  private _knownGroups: Set<string> = new Set();
  /** Last known MLS epoch per group (native); keeps sync `getEpoch()` meaningful on Tauri. */
  private _epochByGroupId: Map<string, number> = new Map();
  /** Resolved when init() completes; shared across concurrent callers to avoid double native init. */
  private initPromise: Promise<void> | null = null;
  /** True when initialized without existing state - triggers OTKP purge before new ones are published. */
  private freshStart = false;
  private appVersionCache: string | null | undefined = undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private _onlineHandler: (() => void) | null = null;

  // ── File de priorité à 3 niveaux ────────────────────────────────────────
  // Ordre de traitement garanti : control (group_reset…) > Welcome > messages.
  // Cette hiérarchie assure que forgetGroup() est appelé AVANT process_welcome()
  // dans le scénario de re-bootstrap quand le device était hors-ligne.
  private controlQueue: QueuedMessage[] = []; // Niveau 0 : signaux hors-bande
  private welcomeQueue: QueuedMessage[] = []; // Niveau 1 : Welcome MLS
  private messageQueue: QueuedMessage[] = []; // Niveau 2 : messages applicatifs
  private isProcessingQueue = false;
  private bulkIngestStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void;
  private bulkIngestEnd?: (
    enableBulkBuffer?: boolean,
    showOverlay?: boolean
  ) => void | Promise<void>;
  // Groups currently being joined (Welcome in progress) - buffer messages for these
  private pendingWelcomeGroups = new Map<string, QueuedMessage[]>();
  // Serialization lock: prevents fetchPendingMessages and processQueue from calling
  // messageCallback concurrently (both await Rust invoke calls asynchronously).
  private callbackLock: Promise<void> = Promise.resolve();

  // PIN conservé en mémoire après init() pour chiffrer l'état MLS après
  // chaque message sans redemander le PIN à l'utilisateur.
  private _pin = '';

  constructor() {
    // Device ID is initialized per-user in init() - see WebMlsService for rationale.
    this.deviceId = 'pending';

    const urls = resolveMlsPublicUrls();
    this.baseUrl = urls.baseUrl;
    this.historyUrl = urls.historyUrl;
    this.delivery = new MlsDeliveryApi({
      historyUrl: this.historyUrl,
      getToken,
      getEpoch: (groupId) => this.getEpoch(groupId),
      fetchImpl: fetch,
    });
  }

  /** Refresh cached epoch from native MLS (best-effort). */
  private async refreshEpochCache(groupId: string): Promise<void> {
    try {
      const e = await invoke<number>('obtenir_epoch', { groupId });
      this._epochByGroupId.set(groupId, e);
      logMlsMetric({ kind: 'epoch_cache', platform: 'tauri', groupId, epoch: e });
    } catch {
      this._epochByGroupId.delete(groupId);
    }
  }

  /** Tauri-native `invoke` wrapper - opens a NativeWebSocket to the chat gateway, passing the Bearer token in the URL query string for mobile compatibility. */
  async connect(token?: string): Promise<void> {
    // Unlisten before disconnecting so the Close event doesn't trigger disconnectCallback.
    if (this.ws) {
      try {
        this.wsUnlisten?.();
        this.wsUnlisten = null;
        await this.ws.disconnect();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (!this._visibilityHandler && typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible' && !this.ws) {
          this.disconnectCallback?.();
        }
      };
      this._onlineHandler = () => {
        if (!this.ws) {
          this.disconnectCallback?.();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      window.addEventListener('online', this._onlineHandler);
    }

    // On Tauri mobile the cookie is not sent cross-origin, so we pass the
    // Bearer token explicitly in the URL query string.
    let resolvedToken = token;
    if (!resolvedToken) {
      try {
        resolvedToken = await getToken();
      } catch {
        // Proceed without token; gateway will reject with 401 if required.
      }
    }

    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const tokenParam = resolvedToken ? `&token=${encodeURIComponent(resolvedToken)}` : '';
    const wsUrl = `${wsBase}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam}`;
    console.log(
      `[WS] Ouverture connexion → ${wsBase}/api/ws?device_id=${this.deviceId}${resolvedToken ? '&token=***' : ' (sans token)'}`
    );

    // NativeWebSocket.connect() resolves when the handshake completes, rejects on failure.
    this.ws = await NativeWebSocket.connect(wsUrl);
    console.log(`[WS] Connecté au Chat Gateway - device=${this.deviceId}`);

    this.wsUnlisten = this.ws.addListener((msg: WsMessage) => {
      if (msg.type === 'Close') {
        this.ws = null;
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        const closeData = msg.data as { code: number; reason: string } | null;
        const code = closeData?.code ?? 0;
        const codeDesc =
          code === 1000
            ? 'fermeture normale'
            : code === 1001
              ? 'serveur en arrêt'
              : code === 1006
                ? 'fermeture anormale (pas de close frame)'
                : code === 1008
                  ? 'violation de politique (auth?)'
                  : code === 1011
                    ? 'erreur serveur interne'
                    : `code=${code}`;
        console.warn(`[WS] Déconnecté - ${codeDesc}, reason="${closeData?.reason ?? ''}"`);
        this.disconnectCallback?.();
        return;
      }

      if (msg.type !== 'Text') return;

      void (async () => {
        try {
          const parsed = JSON.parse(msg.data as string) as Record<string, unknown>;
          const msgType = parsed.type as string | undefined;

          if (msgType && (msgType.startsWith('channel.') || msgType === 'post_created')) {
            if (this.onChannelEvent) {
              console.log(`[WS RCV] Triggering onChannelEvent for ${msgType}`);
              this.onChannelEvent({ type: msgType, data: parsed.data });
            } else {
              console.warn(`[WS RCV] Received channel event but no onChannelEvent registered.`);
            }
            return;
          }
          if (msgType === 'reinvite_request') {
            const senderDev = (parsed.senderDeviceId as string) || '';
            const groupId = (parsed.groupId as string) || '';
            console.log(`[WS RCV] reinvite_request from ${senderDev} for group ${groupId}`);
            this.reinviteRequestCallback?.(senderDev, groupId);
            return;
          }
          if (msgType === 'welcome_request') {
            const requesterUserId = (parsed.requesterUserId as string) || '';
            const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
            const groupId = (parsed.groupId as string) || '';
            console.log(
              `[WS RCV] welcome_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
            );
            this.welcomeRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msgType === 'epoch_rejected') {
            console.warn(
              `[WS RCV] Epoch rejected for group ${parsed.groupId} (server epoch: ${parsed.currentEpoch})`
            );
            if (this.onChannelEvent) {
              this.onChannelEvent({
                type: 'epoch_rejected',
                data: { groupId: parsed.groupId, currentEpoch: parsed.currentEpoch },
              });
            }
            return;
          }
          if (parsed.proto && this.messageCallback) {
            const binaryString = atob(parsed.proto as string);
            const ciphertext = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++)
              ciphertext[i] = binaryString.charCodeAt(i);
            const ratchetTreeBytes =
              typeof parsed.ratchetTree === 'string' && (parsed.ratchetTree as string).length > 0
                ? Uint8Array.from(atob(parsed.ratchetTree as string), (c) => c.charCodeAt(0))
                : undefined;
            if (ciphertext.length > 0) {
              this.enqueueMessage({
                senderId: (parsed.senderId as string) || 'unknown',
                ciphertext,
                groupId: (parsed.groupId as string) || undefined,
                isWelcome: !!parsed.isWelcome,
                isCommit: !!parsed.isCommit,
                ratchetTreeBytes,
                queuedMessageId: (parsed.queuedMessageId as string) || undefined,
                queuedCreatedAt: parseServerTimestampMs(parsed.createdAt),
              });
            }
          } else {
            console.warn(`[WS RCV] No proto or no messageCallback set. Message ignored.`);
          }
        } catch (e) {
          console.error('Failed to process WebSocket message:', e);
        }
      })();
    });

    this.heartbeatTimer = setInterval(() => {
      if (this.ws) {
        this.ws.send(JSON.stringify({ type: 'ping' })).catch(() => {
          /* socket closed between check and send */
        });
      }
    }, 8_000); // data frame bypasses nginx proxy_read_timeout; keeps presence TTL fresh

    // Pending queue fetch is handled by initializeConnection() to keep
    // behavior aligned between WebMlsService and TauriMlsService.
  }

  /** Fetches offline-queued messages from the delivery service and routes each one through the priority queue. */
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

            // ── Messages de contrôle (group_reset persisté pour devices offline) ──
            // Ces messages n'ont pas de payload MLS (proto vide). Ils sont injectés
            // directement dans controlQueue via enqueueMessage({ type: 'group_reset' }).
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
  }

  // simulateMessageReceive removed - pending messages now go through enqueueMessage
  // so they are serialized with live WebSocket messages via processQueue.

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

  /**
   * Enqueue a message for sequential processing using a 3-level priority queue.
   *
   * Niveaux (traitement dans cet ordre strict) :
   *   0 - controlQueue  : group_reset et autres signaux hors-bande persistés
   *   1 - welcomeQueue  : Welcome MLS (instanciation du nouvel arbre)
   *   2 - messageQueue  : messages applicatifs (texte, commit, media…)
   *
   * Les messages pour un groupe dont un Welcome est en cours sont bufférisés
   * dans pendingWelcomeGroups jusqu'à ce que le Welcome soit traité.
   */
  private enqueueMessage(msg: QueuedMessage) {
    const groupId = msg.groupId;

    // Niveau 0 - signal de contrôle persisté (type: 'group_reset')
    // Ces messages ne passent pas par messageCallback.
    if (msg.type === 'group_reset') {
      console.log(`[QUEUE] Control: group_reset pour groupe ${groupId ?? 'inconnu'}`);
      this.controlQueue.push(msg);
      if (!this.isProcessingQueue) this.processQueue();
      return;
    }

    // Niveau 1 - Welcome MLS
    if (msg.isWelcome) {
      if (groupId) this.pendingWelcomeGroups.set(groupId, []);
      this.welcomeQueue.push(msg);
      if (!this.isProcessingQueue) this.processQueue();
      return;
    }

    // Niveau 2 - Message applicatif ou commit
    // Bufférisation si un Welcome est en attente pour ce groupe.
    if (groupId && this.pendingWelcomeGroups.has(groupId)) {
      console.log(`[QUEUE] Buffering message pour groupe ${groupId} (Welcome en attente)`);
      this.pendingWelcomeGroups.get(groupId)!.push(msg);
      return;
    }

    this.messageQueue.push(msg);
    if (!this.isProcessingQueue) this.processQueue();
  }

  /**
   * Draine la file de priorité dans l'ordre strict :
   *   controlQueue (group_reset…) → welcomeQueue (Welcome MLS) → messageQueue
   *
   * Les messages de contrôle (group_reset) sont traités directement,
   * sans passer par messageCallback (pas de bytes MLS).
   * Après un Welcome, les messages bufférisés pour ce groupe sont réinjectés
   * en tête de messageQueue.
   *
   * callbackLock sérialise avec fetchPendingMessages pour éviter toute
   * invocation concurrente de Tauri/WASM.
   */
  private async processQueue() {
    if (this.isProcessingQueue || !this.messageCallback) return;

    this.isProcessingQueue = true;
    const total = this.controlQueue.length + this.welcomeQueue.length + this.messageQueue.length;
    console.log(
      `[QUEUE] Démarrage - control=${this.controlQueue.length} welcome=${this.welcomeQueue.length} msg=${this.messageQueue.length}`
    );

    const useBulkCatchup = total >= BULK_CATCHUP_THRESHOLD;
    const ackIds: string[] = [];

    try {
      if (total > 0) {
        this.bulkIngestStart?.(useBulkCatchup, useBulkCatchup);
      }

      while (
        this.controlQueue.length > 0 ||
        this.welcomeQueue.length > 0 ||
        this.messageQueue.length > 0
      ) {
        // Dépiler dans l'ordre de priorité décroissant.
        const msg =
          this.controlQueue.shift() ?? this.welcomeQueue.shift() ?? this.messageQueue.shift()!;

        const groupId = msg.groupId;

        // ── Sérialisation des appels async ────────────────────────────────
        let resolve!: () => void;
        const prevLock = this.callbackLock;
        this.callbackLock = new Promise<void>((r) => (resolve = r));
        await prevLock;

        try {
          // ── Niveau 0 : signal de contrôle (group_reset persisté) ────────
          if (msg.type === 'group_reset') {
            console.log(`[QUEUE] group_reset (persisté) pour groupe ${groupId ?? 'inconnu'}`);
            if (groupId) {
              // Annuler la bufférisation en cours pour ce groupe (état perdu).
              this.pendingWelcomeGroups.delete(groupId);
            }
            if (shouldAckGroupResetControl({ hasQueuedId: Boolean(msg.queuedMessageId) })) {
              ackIds.push(msg.queuedMessageId!);
            }
            if (groupId) {
              await this.refreshEpochCache(groupId);
            }
            continue;
          }

          // ── Niveaux 1 et 2 : Welcome ou message applicatif ──────────────
          console.log(
            `[QUEUE] ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'Msg'} groupe=${groupId ?? '?'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
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
          const cbResult = await this.messageCallback(
            msg.senderId,
            msg.ciphertext,
            msg.groupId,
            msg.isWelcome,
            msg.ratchetTreeBytes,
            msg.isCommit,
            deliveryMeta
          );
          console.log(
            `[QUEUE] → ${cbResult} (groupe=${groupId ?? '?'})${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const flags = {
            isWelcome: msg.isWelcome,
            isCommit: msg.isCommit,
            hasQueuedId: Boolean(msg.queuedMessageId),
          };
          if (shouldAckAfterSuccess(cbResult, flags) && msg.queuedMessageId) {
            ackIds.push(msg.queuedMessageId);
          } else if (flags.hasQueuedId && cbResult === false) {
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: 'tauri',
              reason: 'callback_retry',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }

          // Après un Welcome, injecter les messages bufférisés en tête de messageQueue.
          if (msg.isWelcome && groupId && this.pendingWelcomeGroups.has(groupId)) {
            const buffered = this.pendingWelcomeGroups.get(groupId)!;
            console.log(
              `[QUEUE] Welcome terminé - réinjection de ${buffered.length} message(s) bufférisé(s) pour ${groupId}`
            );
            this.pendingWelcomeGroups.delete(groupId);
            for (let i = buffered.length - 1; i >= 0; i--) {
              this.messageQueue.unshift(buffered[i]);
            }
          }

          // Notifier uniquement après un Welcome : les messages réguliers sont déjà
          // insérés en temps réel par connection.ts ; un refresh réseau ici serait
          // superflu et provoquerait un rechargement visuel de la liste.
          if (msg.isWelcome) {
            this.welcomeProcessedCallback?.(groupId);
          }

          // Chantier 3 : persister l'état MLS après chaque message traité avec succès.
          // Garantit que le Secret Tree avancé est sauvegardé avant d'ACK le serveur.
          if (this._pin) {
            await this.saveState(this._pin).catch((saveErr) => {
              console.warn('[MLS] State save after message failed:', saveErr);
            });
          }

          if (groupId) {
            await this.refreshEpochCache(groupId);
          }
        } catch (e) {
          const errStr = String(e);
          console.error(`[QUEUE] Erreur traitement message:`, errStr);

          if (msg.isWelcome) {
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: 'tauri',
              reason: 'tauri_welcome_error',
            });
            // Le Welcome a été rejeté avec une erreur inattendue (re-thrown depuis connection.ts).
            // Ne PAS ACK : le message reste en file serveur et sera retenté à la prochaine connexion.
            // C'est intentionnel - le device a besoin de ce Welcome pour rejoindre le groupe.
            console.error(
              `[QUEUE] Welcome échoué pour groupe=${groupId} - NE PAS ACK, retry sur reconnexion`
            );
            if (groupId) this.pendingWelcomeGroups.delete(groupId);
          } else {
            const exFlags = {
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
              hasQueuedId: Boolean(msg.queuedMessageId),
            };
            if (shouldAckAfterTauriGenericException(exFlags) && msg.queuedMessageId) {
              ackIds.push(msg.queuedMessageId);
            }
            if (groupId) this.pendingWelcomeGroups.delete(groupId);
          }
        } finally {
          resolve();
        }

        const hasMore =
          this.controlQueue.length > 0 ||
          this.welcomeQueue.length > 0 ||
          this.messageQueue.length > 0;
        if (hasMore) {
          await yieldToMainThread();
        }
      }

      if (ackIds.length > 0) {
        logMlsMetric({ kind: 'queue_ack', platform: 'tauri', count: ackIds.length });
        void this.delivery.deliveryPost('messages/ack', {
          userId: this.userId,
          deviceId: this.deviceId,
          messageIds: ackIds,
        });
      }
    } finally {
      if (total > 0) {
        try {
          await this.bulkIngestEnd?.(useBulkCatchup, useBulkCatchup);
        } catch (e) {
          console.error('[QUEUE] bulkIngestEnd failed:', e);
        }
      }
      this.isProcessingQueue = false;
      console.log(`[QUEUE] Terminé (${total} messages traités)`);
    }
  }

  onWelcomeProcessed(callback: (groupId?: string) => void): void {
    this.welcomeProcessedCallback = callback;
  }

  setBulkIngestHooks(
    onStart?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void,
    onEnd?: (enableBulkBuffer?: boolean, showOverlay?: boolean) => void | Promise<void>
  ): void {
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

  isWsOpen(): boolean {
    return this.ws !== null;
  }

  onDisconnect(callback: () => void) {
    this.disconnectCallback = callback;
  }

  /** Tauri-native `invoke` wrapper - broadcasts a reinvite_request signal to online group members via the delivery service. */
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

  /** Tauri-native `invoke` wrapper - signals the delivery service that this device needs a Welcome for the given group. */
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

  /** Removes network event listeners and clears all timers. Must be called before discarding this instance (e.g. on logout + device wipe). */
  destroy(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
  }

  /** Sends a disconnect control frame over the native WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'disconnect' })).catch(() => {
        // Best-effort - ignore if the socket is already closing
      });
    }
  }

  /** Returns the stable per-user device ID used to identify this Tauri client on the delivery service. */
  getDeviceId(): string {
    return this.deviceId;
  }

  /** Tauri-native `invoke` wrapper - fetches all registered devices for a user from the delivery service, decoding base64 key packages. */
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

  /** Tauri-native wrapper - fetches one device's KeyPackage (invite / welcome flows). */
  async fetchDeviceKeyPackage(userId: string, deviceId: string) {
    return this.delivery.fetchDeviceKeyPackage(userId, deviceId);
  }

  /** Registers a user as a server-side member of the given MLS group on the delivery service. */
  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  /** Tauri-native `invoke` wrapper - publishes this device's static fallback KeyPackage to the delivery service, including device name/OS metadata. */
  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = btoa(Array.from(keyPackageBytes, (b) => String.fromCharCode(b)).join(''));
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    const deviceAppVersion = await this.getRuntimeAppVersion();
    await this.delivery.registerDeviceKeyPackage({
      keyPackageBase64: base64,
      deviceName: storedName,
      deviceOs: detectRuntimeDeviceOs('desktop'),
      ...(deviceAppVersion ? { deviceAppVersion } : {}),
    });
  }

  /** Tauri-native `invoke` wrapper - bulk-uploads one-time prekey packages to replenish the server pool. */
  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    return this.delivery.publishKeyPackages(packages);
  }

  /** Tauri-native `invoke` wrapper - PATCHes device label and/or OS metadata on the delivery service. */
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

  private async getRuntimeAppVersion(): Promise<string | undefined> {
    if (this.appVersionCache !== undefined) {
      return this.appVersionCache ?? undefined;
    }
    try {
      const v = await getVersion();
      this.appVersionCache = v?.trim() ? v.trim() : null;
      return this.appVersionCache ?? undefined;
    } catch {
      this.appVersionCache = null;
      return undefined;
    }
  }

  /** Tauri-native `invoke` wrapper - delivers an MLS Welcome message to a specific or first-available device of the target user. */
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
      ratchetTreeBytes,
      { firstDeviceOnly: true }
    );
  }

  /** Tauri-native `invoke` wrapper - initializes the Rust MLS state via `initialiser_mls`, deduplicating concurrent calls via a shared promise. */
  async init(userId: string, pin: string, state?: Uint8Array) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initImpl(userId, pin, state);
    await this.initPromise;
  }

  /** Implementation body for init(); resolves device ID from native push context or localStorage, calls `initialiser_mls`, and seeds the known-groups cache. */
  private async _initImpl(userId: string, pin: string, state?: Uint8Array) {
    this.userId = userId;
    this.delivery.userId = userId;
    this._pin = pin;
    this.freshStart = !state;

    // Per-user device ID (same rationale as WebMlsService)
    const deviceKey = `mls_device_id_${userId}`;
    const storedDevice = localStorage.getItem(deviceKey);
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      // localStorage may have been cleared (Android WebView eviction / re-install).
      // Try to restore the original device ID from the native push_context.json
      // before falling back to generating a new random one - avoids credential mismatch.
      let restoredId: string | null = null;
      try {
        const ctx = await invoke<{ deviceId?: string; userId?: string } | null>(
          'load_push_context'
        );
        if (ctx?.deviceId && ctx.userId === userId) restoredId = ctx.deviceId;
      } catch {
        /* desktop / file absent */
      }

      this.deviceId =
        restoredId ??
        'tauri-' +
          userId +
          '-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 6);
      localStorage.setItem(deviceKey, this.deviceId);
    }

    this.delivery.deviceId = this.deviceId;

    const encryptedState = state ? Array.from(state) : null;
    try {
      await invoke('initialiser_mls', { userId, deviceId: this.deviceId, pin, encryptedState });
    } catch (e) {
      // Credential identity mismatch: the saved state embeds a different device ID
      // (e.g. state restored from mls.bin but device ID regenerated).
      // Discard the stale state and start fresh so the user is not permanently blocked.
      if (String(e).includes('identity mismatch') || String(e).includes('Credential identity')) {
        const oldDeviceId = this.deviceId; // capture before overwriting
        console.warn('[MLS] Credential mismatch - discarding stale state, starting fresh');
        this.deviceId =
          'tauri-' +
          userId +
          '-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 6);
        localStorage.setItem(deviceKey, this.deviceId);
        this.delivery.deviceId = this.deviceId;
        await invoke('initialiser_mls', {
          userId,
          deviceId: this.deviceId,
          pin,
          encryptedState: null,
        });
        // Deregister the stale device from the server so other devices no longer
        // try to use its key packages when generating Welcome messages.
        // Without this, re-bootstrap sends a Welcome for the OLD key package
        // (which is now gone from our fresh state), causing NoMatchingKeyPackage.
        this.deleteDevice(userId, oldDeviceId).catch((err) =>
          console.warn(`[MLS] Cleanup old device ${oldDeviceId} failed:`, err)
        );
      } else {
        throw e;
      }
    }

    // Sauvegarde le contexte de session pour les notifications push Android (no-op desktop).
    // Le pushToken est inclus pour que le service Kotlin puisse fetch le proto MLS
    // quand il n'est pas inclus inline dans le payload FCM (messages volumineux).
    void getToken()
      .then((pushToken: string) =>
        invoke('store_push_context', {
          pin,
          userId,
          deviceId: this.deviceId,
          baseUrl: this.historyUrl,
          pushToken,
        })
      )
      .catch(() => {});

    // Écrit mls.bin dès l'init pour que le service FCM puisse déchiffrer
    // même si aucun message n'a encore été traité (saveState non appelé).
    void this.saveState(pin).catch(() => {});

    // Populate the local groups cache from Rust after init.
    try {
      const groups = await invoke<string[]>('lister_groupes');
      this._knownGroups = new Set(groups);
    } catch {
      // Non-blocking: cache stays empty, GroupAlreadyExists fallback will handle it.
    }
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` in Rust and updates the local known-groups cache. */
  async createGroup(groupId: string) {
    await invoke('creer_groupe', { groupId });
    this._knownGroups.add(groupId);
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` ignoring GroupAlreadyExists, letting Rust handle orphan state cleanup. */
  async forceCreateGroup(groupId: string) {
    // Tauri: use the same creer_groupe - orphan recovery in Rust handles the wipe.
    // A dedicated force_creer_groupe IPC command could be added later if needed.
    await invoke('creer_groupe', { groupId }).catch(() => {});
    this._knownGroups.add(groupId);
  }

  /** Tauri-native `invoke` wrapper - creates a group record on the delivery service and returns the server-assigned groupId. */
  async createRemoteGroup(name: string, isGroup: boolean = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  /** Tauri-native `invoke` wrapper - validates the commit epoch via the delivery service then broadcasts the MLS commit to all group members. */
  async sendCommit(
    commitBytes: Uint8Array,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    const proto = btoa(Array.from(commitBytes, (b) => String.fromCharCode(b)).join(''));
    let baseEpoch = 0;
    try {
      const currentEpoch = await invoke<number>('obtenir_epoch', { groupId });
      this._epochByGroupId.set(groupId, currentEpoch);
      baseEpoch = commitBaseEpochForValidation(currentEpoch);
    } catch {
      // If epoch retrieval fails, send 0 (server will validate)
    }
    await this.delivery.sendValidatedCommit(proto, groupId, baseEpoch, excludeDeviceIds);
  }

  /** Tauri-native `invoke` wrapper - requests the Redis add-lock from the delivery service; fails open (returns true) on network error to avoid deadlock. */
  async acquireAddLock(groupId: string, ttlMs = 10_000): Promise<boolean> {
    return this.delivery.acquireAddLock(groupId, ttlMs);
  }

  /** Tauri-native `invoke` wrapper - releases the Redis add-lock for the given group; errors are silently ignored. */
  async releaseAddLock(groupId: string): Promise<void> {
    return this.delivery.releaseAddLock(groupId);
  }

  /** Tauri-native `invoke` wrapper - calls `sauvegarder_mls` to encrypt and persist the MLS state to the native mls.bin file. */
  async saveState(pin: string) {
    // Native command handles save_encrypted + mls.bin write in one invoke to
    // avoid JS Array.from(...) conversion on large state blobs (notably Android).
    const raw = await invoke<number[]>('sauvegarder_mls_et_persister', { pin });
    const bytes = Uint8Array.from(raw);
    return bytes;
  }

  /** Tauri-native `invoke` wrapper - calls `generer_key_package`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  async generateKeyPackage(pin: string) {
    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      await this.delivery.deleteAllOneTimePrekeys();
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    // 50 matches WebMlsService and avoids bloating the Rust state with hundreds
    // of unused private key bundles (each ~400 bytes encrypted in mls.bin).
    const existing = await this.delivery.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);
    console.log(`[MLS][Tauri] generateKeyPackage native batch path needed=${needed}`);

    // Single native command: generate fallback + OTKPs + persist encrypted state.
    const nativeBatch = await invoke<NativeKeyPackageBatchResult>(
      'generer_key_packages_et_persister',
      {
        pin,
        count: needed,
      }
    );
    const fallback = Uint8Array.from(nativeBatch.fallback);
    const poolPackages = nativeBatch.pool_packages.map((kp) => Uint8Array.from(kp));

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /** Tauri-native `invoke` wrapper - calls `ajouter_membre` and returns the commit, optional Welcome, and optional ratchet tree as Uint8Arrays. */
  async addMember(groupId: string, keyPackageBytes: Uint8Array) {
    // Returns tuple (commit, welcome?)
    const result = await invoke<[number[], number[] | null, number[] | null]>('ajouter_membre', {
      groupId,
      keyPackageBytes: Array.from(keyPackageBytes),
    });
    return {
      commit: Uint8Array.from(result[0]),
      welcome: result[1] ? Uint8Array.from(result[1]) : undefined,
      ratchetTree: result[2] ? Uint8Array.from(result[2]) : undefined,
    };
  }

  /** Tauri-native `invoke` wrapper - calls `ajouter_membres_bulk` to add multiple devices in a single OpenMLS commit, producing one shared Welcome. */
  async addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>
  ) {
    // Single bulk Tauri invoke: all key packages are added in one OpenMLS commit
    // so all new members share the same epoch and a single Welcome covers them all.
    const keyPackagesBytes = devices.map((d) => Array.from(d.keyPackage));
    // Returns (commit: Vec<u8>, welcome: Option<Vec<u8>>, count: usize, ratchetTree: Option<Vec<u8>>)
    const result = await invoke<[number[], number[] | null, number, number[] | null]>(
      'ajouter_membres_bulk',
      { groupId, keyPackagesBytes }
    );
    const addedCount = result[2] as number;
    // Map back to device IDs in the same order as the input (first `addedCount` entries).
    const addedDeviceIds = devices.slice(0, addedCount).map((d) => d.deviceId);
    return {
      commit: Uint8Array.from(result[0]),
      welcome: result[1] ? Uint8Array.from(result[1]) : undefined,
      addedDeviceIds,
      ratchetTree: result[3] ? Uint8Array.from(result[3]) : undefined,
    };
  }

  /** Tauri-native `invoke` wrapper - calls `trailer_welcome`, updates the known-groups cache, refreshes the epoch, and returns the derived groupId. */
  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array) {
    const groupId = await invoke<string>('trailer_welcome', {
      welcomeBytes: Array.from(welcomeBytes),
      ratchetTreeBytes: ratchetTreeBytes ? Array.from(ratchetTreeBytes) : null,
    });
    this._knownGroups.add(groupId);
    await this.refreshEpochCache(groupId);
    return groupId;
  }

  /** Tauri-native `invoke` wrapper - encrypts plaintext via `envoyer_message_bytes`, then POSTs the ciphertext to the delivery service. */
  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string,
    silent = false
  ): Promise<Uint8Array> {
    const res = await invoke<number[]>('envoyer_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    const encryptedBytes = Uint8Array.from(res);
    const proto = btoa(Array.from(encryptedBytes, (b) => String.fromCharCode(b)).join(''));
    await this.delivery.postApplicationMessage(groupId, proto, silent);
    return encryptedBytes;
  }

  /** Tauri-native `invoke` wrapper - decrypts a raw MLS ciphertext via `recevoir_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const res = await invoke<number[] | null>('recevoir_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    return res ? Uint8Array.from(res) : null;
  }

  /** Tauri-native `invoke` wrapper - calls `exporter_secret` in Rust to derive a keying-material export for channel encryption. */
  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    const res = await invoke<number[]>('exporter_secret', {
      groupId,
      label,
      context: Array.from(context),
      keyLen,
    });
    return new Uint8Array(res);
  }

  /** Tauri-native `invoke` wrapper - fetches Redis Stream history from the delivery service, optionally starting after a given stream ID. */
  async fetchHistory(
    groupId: string,
    afterStreamId?: string
  ): Promise<{ id?: string; sender_id: string; content: string; timestamp: string }[]> {
    return this.delivery.fetchHistory(groupId, afterStreamId);
  }

  /** Returns the list of MLS group IDs known locally, populated from Rust via `lister_groupes` at init time. */
  getLocalGroups(): string[] {
    return [...this._knownGroups];
  }

  /** Returns the last cached MLS epoch for a group, or 0 if unknown; cache is refreshed by `refreshEpochCache`. */
  getEpoch(groupId: string): number {
    return this._epochByGroupId.get(groupId) ?? 0;
  }

  /** Tauri-native `invoke` wrapper - calls `oublier_groupe` in Rust to drop local MLS state and removes the group from the epoch cache. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    this._epochByGroupId.delete(groupId);
    invoke('oublier_groupe', { groupId, minEpoch }).catch((e) =>
      console.warn('[MLS] forgetGroup error:', e)
    );
  }

  /** Poison Pill - purge définitive via Tauri `supprimer_groupe` : mémoire Rust, stockage et verrou d'epoch à MAX. */
  dropGroup(groupId: string): void {
    this._epochByGroupId.delete(groupId);
    invoke('supprimer_groupe', { groupId }).catch((e) => console.warn('[MLS] dropGroup error:', e));
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

  /** Tauri-native `invoke` wrapper - PATCHes the group name on the delivery service. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    return this.delivery.renameGroup(groupId, name);
  }

  /** Tauri-native `invoke` wrapper - DELETEs the group record from the delivery service. */
  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  /** Tauri-native `invoke` wrapper - removes a user's server-side membership from the group on the delivery service. */
  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  /** Tauri-native `invoke` wrapper - calls `retirer_membres` to generate a remove commit for all devices of the given users, then broadcasts it. */
  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    const commitBytes = await invoke<number[]>('retirer_membres', {
      groupId,
      userIds,
    });
    await this.sendCommit(new Uint8Array(commitBytes), groupId);
  }

  /** Tauri-native `invoke` wrapper - calls `retirer_membres_par_appareil` to remove specific devices by identity string and broadcasts the resulting commit. */
  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const commitBytes = await invoke<number[]>('retirer_membres_par_appareil', {
      groupId,
      deviceIdentities,
    });
    await this.sendCommit(new Uint8Array(commitBytes), groupId);
  }

  /** Tauri-native `invoke` wrapper - fetches the server-side member list for a group from the delivery service. */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  /** Tauri-native `invoke` wrapper - fetches all groups the given user belongs to from the delivery service. */
  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  /** Tauri-native wrapper - fetches server-side group metadata (successor routing). */
  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  /** Tauri-native wrapper - CAS claim for dead-group successor. */
  async claimGroupSuccessor(
    deadGroupId: string,
    successorId: string
  ): Promise<{ claimed: boolean; successorId: string | null }> {
    return this.delivery.claimGroupSuccessor(deadGroupId, successorId);
  }

  /** Tauri-native `invoke` wrapper - retrieves pending device-group invitations for this device from the delivery service. */
  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  /** Tauri-native `invoke` wrapper - retrieves all device-group membership records for this device from the delivery service. */
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

  /** Tauri-native `invoke` wrapper - POSTs an invitation status update (e.g. welcome_received) to the delivery service. */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'welcome_sent' | 'welcome_received' | 'stale',
    lastEpochSeen?: number
  ): Promise<void> {
    return this.delivery.updateInvitationStatus(deviceId, userId, groupId, status, lastEpochSeen);
  }

  /** Tauri-native `invoke` wrapper - resets a device-group membership to pending after an MLS remove commit targeting that device. */
  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    return this.delivery.kickStaleDevice(deviceId, userId, groupId);
  }

  /** Tauri-native `invoke` wrapper - DELETEs a single device-group membership record from the delivery service. */
  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteDeviceMembership(userId, deviceId, groupId);
  }

  /** Tauri-native `invoke` wrapper - DELETEs all device-group membership records for a device from the delivery service. */
  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteAllDeviceMemberships(userId, deviceId);
  }

  /** Tauri-native `invoke` wrapper - fully removes a device from the delivery service, cleaning up groups, KeyPackages, and push token. */
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
