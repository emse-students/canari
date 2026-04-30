import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';
import type { IMlsService } from './IMlsService';
import { getToken } from '$lib/stores/auth';

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
  /**
   * Type discriminant for control messages persisted by the server.
   * 'group_reset' : signal hors-bande indiquant que l'arbre MLS du groupe
   *                 a été reconstruit ; déclenche forgetGroup() avant le Welcome.
   */
  type?: string;
}

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly

export class TauriMlsService implements IMlsService {
  private ws: WebSocket | null = null;

  private async assertOkResponse(response: Response, context: string): Promise<void> {
    if (response.ok) return;
    let bodyPreview = '';
    try {
      bodyPreview = (await response.text()).slice(0, 300);
    } catch {
      // Silent fallback if response body cannot be read
    }
    const details = bodyPreview ? ` - ${bodyPreview}` : '';
    throw new Error(
      `Impossible d'envoyer l'invitation sécurisée (${context}). ` +
        `Le serveur a répondu ${response.status} ${response.statusText}${details}`
    );
  }
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
  // Callback déclenché quand le serveur signale qu'un groupe est mort.
  // Même pattern que welcome_request/reinvite_request : signal hors-bande MLS.
  private groupResetCallback: ((groupId: string, reason: string) => void) | null = null;
  private baseUrl: string;
  private historyUrl: string;
  private userId: string = 'unknown';
  private deviceId: string;
  /** Cache of locally known MLS group IDs, populated after init and updated on group changes. */
  private _knownGroups: Set<string> = new Set();
  /** Resolved when init() completes; shared across concurrent callers to avoid double native init. */
  private initPromise: Promise<void> | null = null;
  /** True when initialized without existing state — triggers OTKP purge before new ones are published. */
  private freshStart = false;
  private appVersionCache: string | null | undefined = undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private networkListenersRegistered = false;

  // ── File de priorité à 3 niveaux ────────────────────────────────────────
  // Ordre de traitement garanti : control (group_reset…) > Welcome > messages.
  // Cette hiérarchie assure que forgetGroup() est appelé AVANT process_welcome()
  // dans le scénario de re-bootstrap quand le device était hors-ligne.
  private controlQueue: QueuedMessage[] = []; // Niveau 0 : signaux hors-bande
  private welcomeQueue: QueuedMessage[] = []; // Niveau 1 : Welcome MLS
  private messageQueue: QueuedMessage[] = []; // Niveau 2 : messages applicatifs
  private isProcessingQueue = false;
  // Groups currently being joined (Welcome in progress) - buffer messages for these
  private pendingWelcomeGroups = new Map<string, QueuedMessage[]>();
  // Serialization lock: prevents fetchPendingMessages and processQueue from calling
  // messageCallback concurrently (both await Rust invoke calls asynchronously).
  private callbackLock: Promise<void> = Promise.resolve();

  constructor() {
    // Device ID is initialized per-user in init() — see WebMlsService for rationale.
    this.deviceId = 'pending';

    const envGateway = import.meta.env.VITE_GATEWAY_URL;
    this.baseUrl =
      envGateway && envGateway.trim()
        ? envGateway
        : typeof window !== 'undefined'
          ? window.location.origin
          : 'http://localhost:3000';

    const envHistory = import.meta.env.VITE_DELIVERY_URL;
    this.historyUrl =
      envHistory && envHistory.trim()
        ? envHistory
        : typeof window !== 'undefined'
          ? window.location.origin
          : 'http://localhost:3010';
  }

  private async withAuthHeaders(
    extra: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const token = await getToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  /**
   * Fire-and-forget POST to the delivery service.
   * `keepalive: true` lets the request complete even when the page is being
   * unloaded, so ack/signal calls are never dropped.
   */
  private async deliveryPost(path: string, body: Record<string, unknown>): Promise<void> {
    await fetch(`${this.historyUrl}/api/mls-api/${path}`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      keepalive: true,
    }).catch((e) => console.warn(`[HTTP] ${path} failed:`, e));
  }

  async connect(token?: string): Promise<void> {
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

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

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

    // Resolve token: use provided token, fall back to getToken().
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

    return new Promise((resolve, reject) => {
      const wsBase = this.baseUrl.replace(/^http/, 'ws');
      const tokenParam = resolvedToken ? `&token=${encodeURIComponent(resolvedToken)}` : '';
      const wsUrl = `${wsBase}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam}`;
      console.log(
        `[WS] Ouverture connexion → ${wsBase}/api/ws?device_id=${this.deviceId}${resolvedToken ? '&token=***' : ' (sans token)'}`
      );
      this.ws = new WebSocket(wsUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.error(`[WS] Timeout connexion après 15s — device=${this.deviceId}`);
          this.ws?.close();
          reject(new Error('WebSocket connection timeout after 15s'));
        }
      }, 15_000);

      this.ws.onopen = async () => {
        clearTimeout(timeout);
        resolved = true;
        console.log(`[WS] Connecté au Chat Gateway — device=${this.deviceId}`);
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(JSON.stringify({ type: 'ping' }));
            } catch {
              /* socket closed between check and send */
            }
          }
        }, 8_000); // data frame bypasses nginx proxy_read_timeout; keeps presence TTL fresh
        try {
          await this.fetchPendingMessages();
        } catch (e) {
          console.error('[WS] Echec fetchPendingMessages au connect (non bloquant):', e);
        }
        resolve();
      };
      this.ws.onerror = (e) => {
        clearTimeout(timeout);
        console.error(`[WS] Erreur connexion — device=${this.deviceId}`, e);
        if (!resolved) {
          resolved = true;
          reject(e);
        }
      };
      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        const codeDesc =
          event.code === 1000
            ? 'fermeture normale'
            : event.code === 1001
              ? 'serveur en arrêt'
              : event.code === 1006
                ? 'fermeture anormale (pas de close frame)'
                : event.code === 1008
                  ? 'violation de politique (auth?)'
                  : event.code === 1011
                    ? 'erreur serveur interne'
                    : `code=${event.code}`;
        if (!resolved) {
          resolved = true;
          console.error(`[WS] Fermé avant ouverture — ${codeDesc}, reason="${event.reason}"`);
          reject(new Error(`WebSocket closed before opening. Code: ${event.code}`));
        } else {
          console.warn(`[WS] Déconnecté — ${codeDesc}, reason="${event.reason}"`);
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
          if (msg.type && (msg.type.startsWith('channel.') || msg.type === 'post_created')) {
            if (this.onChannelEvent) {
              console.log(`[WS RCV] Triggering onChannelEvent for ${msg.type}`);
              this.onChannelEvent({ type: msg.type, data: msg.data });
            } else {
              console.warn(`[WS RCV] Received channel event but no onChannelEvent registered.`);
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
          // ── group_reset : signal hors-bande MLS ──────────────────────────
          // Le serveur indique que la session MLS du groupe est morte.
          // Le client doit oublier tout état local et se faire ré-inviter.
          if (msg.type === 'group_reset') {
            const groupId = (msg.groupId as string) || '';
            const reason = (msg.reason as string) || 'unknown';
            console.log(`[WS RCV] group_reset for group ${groupId} reason=${reason}`);
            this.groupResetCallback?.(groupId, reason);
            return;
          }
          if (msg.type === 'epoch_rejected') {
            console.warn(
              `[WS RCV] Epoch rejected for group ${msg.groupId} (server epoch: ${msg.currentEpoch})`
            );
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
                isWelcome: !!msg.isWelcome,
                isCommit: !!msg.isCommit,
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

  async fetchPendingMessages() {
    if (this.userId === 'unknown') return;

    const FETCH_TIMEOUT = 10_000;

    try {
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), FETCH_TIMEOUT);
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/messages/${this.userId}/${this.deviceId}`,
        { headers: await this.withAuthHeaders(), signal: ctrl2.signal }
      );
      clearTimeout(tid2);
      if (res.ok) {
        const messages = await res.json();
        if (Array.isArray(messages) && messages.length > 0) {
          console.log(`Fetched ${messages.length} pending messages`);

          // Route all pending messages through the serialized queue so they
          // never race with live WebSocket messages calling messageCallback.
          for (const msg of messages) {
            const msgId = (msg.id || msg._id) as string | undefined;
            const proto: string | undefined = msg.proto || undefined;
            const content: string | undefined = msg.content || undefined;

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
          `[MSG][PENDING] Pending message fetch failed: ${res.status} ${res.statusText} (${this.userId}:${this.deviceId})`
        );
      }
    } catch (e) {
      console.error('Failed to fetch pending messages', e);
    }
  }

  // simulateMessageReceive removed — pending messages now go through enqueueMessage
  // so they are serialized with live WebSocket messages via processQueue.

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

    // Niveau 0 — signal de contrôle persisté (type: 'group_reset')
    // Ces messages ne passent pas par messageCallback ; ils déclenchent
    // directement groupResetCallback (forgetGroup côté WASM).
    if (msg.type === 'group_reset') {
      console.log(`[QUEUE] Control: group_reset pour groupe ${groupId ?? 'inconnu'}`);
      this.controlQueue.push(msg);
      if (!this.isProcessingQueue) this.processQueue();
      return;
    }

    // Niveau 1 — Welcome MLS
    if (msg.isWelcome) {
      if (groupId) this.pendingWelcomeGroups.set(groupId, []);
      this.welcomeQueue.push(msg);
      if (!this.isProcessingQueue) this.processQueue();
      return;
    }

    // Niveau 2 — Message applicatif ou commit
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
   * Les messages de contrôle (group_reset) déclenchent groupResetCallback()
   * directement, sans passer par messageCallback (pas de bytes MLS).
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
      `[QUEUE] Démarrage — control=${this.controlQueue.length} welcome=${this.welcomeQueue.length} msg=${this.messageQueue.length}`
    );

    const ackIds: string[] = [];

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
            this.groupResetCallback?.(groupId, 'reset');
            // Annuler la bufférisation en cours pour ce groupe (état perdu).
            this.pendingWelcomeGroups.delete(groupId);
          }
          if (msg.queuedMessageId) ackIds.push(msg.queuedMessageId);
          continue;
        }

        // ── Niveaux 1 et 2 : Welcome ou message applicatif ──────────────
        console.log(
          `[QUEUE] ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'Msg'} groupe=${groupId ?? '?'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
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
          `[QUEUE] → ${cbResult} (groupe=${groupId ?? '?'})${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
        );

        if (msg.queuedMessageId) ackIds.push(msg.queuedMessageId);

        // Après un Welcome, injecter les messages bufférisés en tête de messageQueue.
        if (msg.isWelcome && groupId && this.pendingWelcomeGroups.has(groupId)) {
          const buffered = this.pendingWelcomeGroups.get(groupId)!;
          console.log(
            `[QUEUE] Welcome terminé — réinjection de ${buffered.length} message(s) bufférisé(s) pour ${groupId}`
          );
          this.pendingWelcomeGroups.delete(groupId);
          for (let i = buffered.length - 1; i >= 0; i--) {
            this.messageQueue.unshift(buffered[i]);
          }
        }
      } catch (e) {
        console.error(`[QUEUE] Erreur traitement message:`, e);
        // ACK quand même pour ne pas boucler indéfiniment : l'état MLS a
        // probablement avancé au-delà (commit dupliqué, epoch divergée…).
        if (msg.queuedMessageId) ackIds.push(msg.queuedMessageId);
        if (groupId) this.pendingWelcomeGroups.delete(groupId);
      } finally {
        resolve();
      }
    }

    if (ackIds.length > 0) {
      void this.deliveryPost('messages/ack', {
        userId: this.userId,
        deviceId: this.deviceId,
        messageIds: ackIds,
      });
    }

    this.isProcessingQueue = false;
    console.log(`[QUEUE] Terminé (${total} messages traités)`);
  }

  onDisconnect(callback: () => void) {
    this.disconnectCallback = callback;
  }

  async sendReinviteRequest(groupId: string): Promise<void> {
    await this.deliveryPost('reinvite-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
  }

  onReinviteRequest(callback: (senderDeviceId: string, groupId: string) => void): void {
    this.reinviteRequestCallback = callback;
  }

  async sendWelcomeRequest(groupId: string): Promise<void> {
    await this.deliveryPost('welcome-request', {
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

  async sendGroupReset(groupId: string, reason = 'bootstrap'): Promise<void> {
    // Do NOT include triggeredBy: user IDs may contain characters (e.g. '+' in
    // email addresses) that fail the server-side sanitizeQueryValue regex, which
    // would return 400 and silently abort the entire re-bootstrap.
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/reset`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      throw new Error(`group_reset failed: ${res.status}`);
    }
  }

  onGroupReset(callback: (groupId: string, reason: string) => void): void {
    this.groupResetCallback = callback;
  }

  sendDisconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'disconnect' }));
      } catch {
        // Best-effort — ignore if the socket is already closing
      }
    }
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
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/devices/${userId}`, {
        headers: await this.withAuthHeaders(),
      });
      if (!res.ok) return [];
      const devices = await res.json();

      return devices.map((d: any) => {
        const binaryString = atob(d.keyPackage);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return {
          keyPackage: bytes,
          deviceId: d.deviceId,
          deviceName: typeof d.deviceName === 'string' ? d.deviceName : undefined,
          deviceOs: typeof d.deviceOs === 'string' ? d.deviceOs : undefined,
          deviceAppVersion: typeof d.deviceAppVersion === 'string' ? d.deviceAppVersion : undefined,
        };
      });
    } catch (e) {
      console.error('Fetch User Devices Error:', e);
      return [];
    }
  }

  async registerMember(groupId: string, userId: string): Promise<void> {
    try {
      await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members`, {
        method: 'POST',
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ userId }),
      });
    } catch (e) {
      console.error('Failed to register member', e);
    }
  }

  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = btoa(String.fromCharCode(...keyPackageBytes));
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    const deviceOs = this.detectRuntimeDeviceOs();
    const deviceAppVersion = await this.getRuntimeAppVersion();
    const response = await fetch(`${this.historyUrl}/api/mls-api/register-device`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: this.userId,
        deviceId: this.deviceId,
        keyPackage: base64,
        ...(storedName ? { deviceName: storedName } : {}),
        deviceOs,
        ...(deviceAppVersion ? { deviceAppVersion } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to publish KeyPackage: ${response.status} ${response.statusText}`);
    }
  }

  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    const keyPackages = packages.map((bytes) =>
      btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    );
    const response = await fetch(`${this.historyUrl}/api/mls-api/register-device/prekeys`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: this.userId,
        deviceId: this.deviceId,
        keyPackages,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to publish key packages: ${response.status} ${response.statusText}`);
    }
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
    const response = await fetch(
      `${this.historyUrl}/api/mls-api/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/metadata`,
      {
        method: 'PATCH',
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(metadata),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to update device metadata: ${response.status}`);
    }
    return await response.json();
  }

  private detectRuntimeDeviceOs(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('android')) return 'android';
    if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return 'desktop';
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

  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    const base64 = btoa(String.fromCharCode(...welcomeBytes));
    const ratchetTreeBase64 = ratchetTreeBytes
      ? btoa(String.fromCharCode(...ratchetTreeBytes))
      : undefined;

    let resolvedDeviceId = targetDeviceId;
    if (!resolvedDeviceId) {
      const devices = await this.fetchUserDevices(targetUserId);
      resolvedDeviceId = devices[0]?.deviceId;
    }
    if (!resolvedDeviceId) {
      throw new Error(
        `Impossible d'envoyer l'invitation sécurisée à ${targetUserId} : ` +
          `aucun appareil actif trouvé.`
      );
    }
    const response = await fetch(`${this.historyUrl}/api/mls-api/welcome`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        targetDeviceId: resolvedDeviceId,
        targetUserId,
        senderUserId: this.userId,
        welcomePayload: base64,
        ratchetTreePayload: ratchetTreeBase64,
        groupId,
      }),
    });
    await this.assertOkResponse(
      response,
      `Welcome delivery to ${targetUserId}:${resolvedDeviceId} (group ${groupId})`
    );
  }

  async init(userId: string, pin: string, state?: Uint8Array) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initImpl(userId, pin, state);
    await this.initPromise;
  }

  private async _initImpl(userId: string, pin: string, state?: Uint8Array) {
    this.userId = userId;
    this.freshStart = !state;

    // Per-user device ID (same rationale as WebMlsService)
    const deviceKey = `mls_device_id_${userId}`;
    const storedDevice = localStorage.getItem(deviceKey);
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      // localStorage may have been cleared (Android WebView eviction / re-install).
      // Try to restore the original device ID from the native push_context.json
      // before falling back to generating a new random one — avoids credential mismatch.
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

    const encryptedState = state ? Array.from(state) : null;
    try {
      await invoke('initialiser_mls', { userId, deviceId: this.deviceId, pin, encryptedState });
    } catch (e) {
      // Credential identity mismatch: the saved state embeds a different device ID
      // (e.g. state restored from mls.bin but device ID regenerated).
      // Discard the stale state and start fresh so the user is not permanently blocked.
      if (String(e).includes('identity mismatch') || String(e).includes('Credential identity')) {
        const oldDeviceId = this.deviceId; // capture before overwriting
        console.warn('[MLS] Credential mismatch — discarding stale state, starting fresh');
        this.deviceId =
          'tauri-' +
          userId +
          '-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 6);
        localStorage.setItem(deviceKey, this.deviceId);
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
      .then((pushToken) =>
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
    void invoke('save_mls_state', { pin }).catch(() => {});

    // Populate the local groups cache from Rust after init.
    try {
      const groups = await invoke<string[]>('lister_groupes');
      this._knownGroups = new Set(groups);
    } catch {
      // Non-blocking: cache stays empty, GroupAlreadyExists fallback will handle it.
    }
  }

  async createGroup(groupId: string) {
    await invoke('creer_groupe', { groupId });
    this._knownGroups.add(groupId);
  }

  async forceCreateGroup(groupId: string) {
    // Tauri: use the same creer_groupe — orphan recovery in Rust handles the wipe.
    // A dedicated force_creer_groupe IPC command could be added later if needed.
    await invoke('creer_groupe', { groupId }).catch(() => {});
    this._knownGroups.add(groupId);
  }

  async createRemoteGroup(name: string, isGroup: boolean = true): Promise<string> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/groups`, {
        method: 'POST',
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name,
          createdBy: this.userId,
          isGroup,
          creatorDeviceId: this.deviceId,
        }),
      });
      if (!res.ok) throw new Error('Failed to create remote group');
      const data = await res.json();
      return data.groupId;
    } catch (e) {
      console.error('Failed to create remote group', e);
      throw e;
    }
  }

  async sendCommit(
    commitBytes: Uint8Array,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    const proto = btoa(String.fromCharCode(...commitBytes));
    let baseEpoch = 0;
    try {
      // Rust merges pending commit before returning bytes, so local epoch is already advanced.
      // The backend validates against the pre-commit epoch.
      const currentEpoch = await invoke<number>('obtenir_epoch', { groupId });
      baseEpoch = Math.max(0, currentEpoch - 1);
    } catch {
      // If epoch retrieval fails, send 0 (server will validate)
    }

    const validateRes = await fetch(`${this.historyUrl}/api/mls-api/commit`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ groupId, deviceId: this.deviceId, baseEpoch }),
    });
    if (!validateRes.ok) {
      throw new Error(`Commit validation HTTP error: ${validateRes.status}`);
    }
    const validation = await validateRes.json();
    if (!validation.accepted) {
      throw new Error(
        `Commit rejected: ${validation.reason || 'epoch_mismatch'} (server epoch: ${validation.currentEpoch}, sent: ${baseEpoch})`
      );
    }

    const res = await fetch(`${this.historyUrl}/api/mls-api/send`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        groupId,
        proto,
        isCommit: true,
        ...(excludeDeviceIds?.length ? { excludeDeviceIds } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Commit delivery HTTP error: ${res.status}`);
    }
  }

  async acquireAddLock(groupId: string, ttlMs = 10_000): Promise<boolean> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/add-lock`, {
        method: 'POST',
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId, ttlMs }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.acquired === true;
    } catch {
      return true; // fail-open
    }
  }

  async releaseAddLock(groupId: string): Promise<void> {
    try {
      await fetch(`${this.historyUrl}/api/mls-api/add-lock`, {
        method: 'DELETE',
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId }),
      });
    } catch {
      // Non-bloquant
    }
  }

  async saveState(pin: string) {
    const bytes = await invoke<Uint8Array>('sauvegarder_mls', { pin });
    // Await the push-state write so mls.bin is guaranteed up-to-date
    // before the app can be backgrounded. Fire-and-forget caused a race where
    // the Android FCM service loaded a stale epoch and decryption failed.
    try {
      await invoke('save_mls_state', { pin });
    } catch {
      // Non-blocking on desktop (no-op) and on write errors.
    }
    return bytes;
  }

  private async fetchPrekeyCount(): Promise<number> {
    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/devices/${this.userId}/${this.deviceId}/prekeys/count`,
        { headers: await this.withAuthHeaders() }
      );
      if (!res.ok) return 0;
      const data = await res.json();
      return typeof data.count === 'number' ? data.count : 0;
    } catch {
      return 0;
    }
  }

  async generateKeyPackage(pin: string) {
    // Always generate a fresh static fallback KP for this device.
    const fallbackRaw = await invoke<number[]>('generer_key_package');
    const fallback = Uint8Array.from(fallbackRaw);

    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      await fetch(
        `${this.historyUrl}/api/mls-api/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys`,
        { method: 'DELETE', headers: await this.withAuthHeaders() }
      ).catch(() => {});
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    // 50 matches WebMlsService and avoids bloating the Rust state with hundreds
    // of unused private key bundles (each ~400 bytes encrypted in mls.bin).
    const existing = await this.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);

    let poolPackages: Uint8Array[] = [];
    if (needed > 0) {
      const raw = await invoke<number[][]>('generer_key_packages', { count: needed });
      poolPackages = raw.map((kp) => Uint8Array.from(kp));
    }

    // Force save state once after all generations.
    await this.saveState(pin);

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

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

  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array) {
    const groupId = await invoke<string>('trailer_welcome', {
      welcomeBytes: Array.from(welcomeBytes),
      ratchetTreeBytes: ratchetTreeBytes ? Array.from(ratchetTreeBytes) : null,
    });
    this._knownGroups.add(groupId);
    return groupId;
  }

  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string
  ): Promise<Uint8Array> {
    const res = await invoke<number[]>('envoyer_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    const encryptedBytes = Uint8Array.from(res);
    const proto = btoa(String.fromCharCode(...encryptedBytes));
    const httpRes = await fetch(`${this.historyUrl}/api/mls-api/send`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        groupId,
        proto,
      }),
    });
    if (!httpRes.ok) {
      throw new Error(`Message send HTTP error: ${httpRes.status}`);
    }
    return encryptedBytes;
  }

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

  async fetchHistory(
    groupId: string,
    afterStreamId?: string
  ): Promise<{ id?: string; sender_id: string; content: string; timestamp: string }[]> {
    try {
      const url = new URL(`${this.historyUrl}/api/history/${groupId}`);
      if (afterStreamId) url.searchParams.set('after', afterStreamId);
      const res = await fetch(url.toString(), {
        headers: await this.withAuthHeaders(),
      });
      if (!res.ok) return [];
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        console.warn(
          `[History] Non-JSON response for group ${groupId}. Received content-type: ${contentType || 'unknown'}`
        );
        return [];
      }
      const messages = await res.json();
      return messages;
    } catch (e) {
      console.error('Fetch History Error:', e);
      return [];
    }
  }

  getLocalGroups(): string[] {
    return [...this._knownGroups];
  }

  getEpoch(_groupId: string): number {
    // Tauri invoke is async — for the synchronous interface we return 0.
    // The actual epoch will be retrieved via an async pre-check in sendCommit.
    return 0;
  }

  forgetGroup(groupId: string, minEpoch = 0): void {
    invoke('oublier_groupe', { groupId, minEpoch }).catch((e) =>
      console.warn('[MLS] forgetGroup error:', e)
    );
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}`, {
      method: 'PATCH',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
  }

  async deleteGroupOnServer(groupId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}`, {
      method: 'DELETE',
      headers: await this.withAuthHeaders(),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
      headers: await this.withAuthHeaders(),
    });
    if (!res.ok) throw new Error(`Remove member failed: ${res.status}`);
  }

  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    const commitBytes = await invoke<number[]>('retirer_membres', {
      groupId,
      userIds,
    });
    await this.sendCommit(new Uint8Array(commitBytes), groupId);
  }

  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const commitBytes = await invoke<number[]>('retirer_membres_par_appareil', {
      groupId,
      deviceIdentities,
    });
    await this.sendCommit(new Uint8Array(commitBytes), groupId);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members`, {
        headers: await this.withAuthHeaders(),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async getUserGroups(
    userId: string
  ): Promise<{ groupId: string; name: string; isGroup: boolean }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/user-groups/${userId}`, {
        headers: await this.withAuthHeaders(),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/pending-invitations/${userId}/${deviceId}`
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
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
      lastEpochSeen: number;
    }>
  > {
    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/device-memberships/${userId}/${deviceId}`
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'welcome_sent' | 'welcome_received' | 'stale',
    lastEpochSeen?: number
  ): Promise<void> {
    try {
      await fetch(`${this.historyUrl}/api/mls-api/invitation-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, userId, groupId, status, lastEpochSeen }),
      });
    } catch (e) {
      console.error('Failed to update invitation status', e);
    }
  }

  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/kick-stale-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, userId, groupId }),
    });
    if (!res.ok) throw new Error(`kickStaleDevice failed: ${res.status}`);
  }

  async resetGroupEpoch(groupId: string): Promise<void> {
    const res = await fetch(
      `${this.historyUrl}/api/mls-api/groups/${encodeURIComponent(groupId)}/reset-epoch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );
    if (!res.ok) throw new Error(`resetGroupEpoch failed: ${res.status}`);
  }

  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/device-memberships/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/${encodeURIComponent(groupId)}`,
        { method: 'DELETE', headers: await this.withAuthHeaders() }
      );
      if (!res.ok) return { status: 'error', affected: 0 };
      return await res.json();
    } catch (e) {
      console.error('Failed to delete device membership', e);
      return { status: 'error', affected: 0 };
    }
  }

  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/device-memberships/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: await this.withAuthHeaders() }
      );
      if (!res.ok) return { status: 'error', affected: 0 };
      return await res.json();
    } catch (e) {
      console.error('Failed to delete all device memberships', e);
      return { status: 'error', affected: 0 };
    }
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
    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: await this.withAuthHeaders() }
      );
      if (!res.ok)
        return {
          status: 'error',
          groupsCleaned: 0,
          keyPackagesDeleted: 0,
          oneTimeKeyPackagesDeleted: 0,
        };
      return await res.json();
    } catch (e) {
      console.error('Failed to delete device', e);
      return {
        status: 'error',
        groupsCleaned: 0,
        keyPackagesDeleted: 0,
        oneTimeKeyPackagesDeleted: 0,
      };
    }
  }
}
