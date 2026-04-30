import type { IMlsService } from './IMlsService';
import { getToken } from '$lib/stores/auth';
import { loadAndInitWasm } from './mlsWasmLoader';
import { saveMlsState } from '$lib/utils/hex';

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
  // Callback déclenché quand le serveur signale qu'un groupe est mort et doit
  // être recréé. Le client fait forgetGroup() + isReady=false puis, à la
  // reconnexion, envoie un welcome_request pour être ré-invité.
  private groupResetCallback: ((groupId: string, reason: string) => void) | null = null;
  private baseUrl: string; // Chat Gateway URL
  private historyUrl: string; // Chat Delivery Service URL
  private userId: string = 'unknown';
  private deviceId: string;
  /** Resolved when init() completes; shared across concurrent callers to avoid double WASM init. */
  private initPromise: Promise<void> | null = null;
  /** True when initialized without existing state — triggers OTKP purge before new ones are published. */
  private freshStart = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private networkListenersRegistered = false;

  // Message queue for sequential processing
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue = false;
  // Groups currently being joined (Welcome in progress) - buffer messages for these
  private pendingWelcomeGroups = new Map<string, QueuedMessage[]>();
  private async withAuthHeaders(
    extra: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...extra };
    const token = await getToken();
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Fire-and-forget POST to the delivery service.
   * `keepalive: true` lets the request complete even when the page is being
   * unloaded (navigation / tab close), so ack/signal calls are never dropped.
   * The browser HTTP connection pool reuses the underlying TCP connection
   * across calls to the same origin (HTTP keep-alive is the default for
   * HTTP/1.1; over HTTPS the browser will also try to use HTTP/2 multiplexing).
   */
  private async deliveryPost(path: string, body: Record<string, unknown>): Promise<void> {
    await fetch(`${this.historyUrl}/api/mls-api/${path}`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      keepalive: true,
    }).catch((e) => console.warn(`[HTTP] ${path} failed:`, e));
  }

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

  constructor() {
    // Device ID is initialized per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    // Prefer explicit env vars; fall back to same-origin (works behind a reverse proxy
    // like Nginx that routes /ws and /api/mls-api/ on the same domain).
    // An empty string is treated as "not configured" to match .env.example production convention.
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

  async connect(): Promise<void> {
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

    // Clear any heartbeat from a previous connection.
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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

    return new Promise((resolve, reject) => {
      // Convert HTTP(S) URL to WS(S) URL
      // https:// -> wss://, http:// -> ws://
      const wsUrl = this.baseUrl.replace(/^https?:/, (match) =>
        match === 'https:' ? 'wss:' : 'ws:'
      );
      const fullWsUrl = `${wsUrl}/api/ws?device_id=${encodeURIComponent(this.deviceId)}`;

      console.log(`Connecting to WebSocket: ${fullWsUrl}`);
      this.ws = new WebSocket(fullWsUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.ws?.close();
          reject(new Error('WebSocket connection timeout after 15s'));
        }
      }, 15_000);

      this.ws.onopen = async () => {
        clearTimeout(timeout);
        resolved = true;
        console.log('Connected to Chat Gateway with DeviceID:', this.deviceId);
        // Application-level heartbeat every 8 s. Sent as a data frame so it
        // travels end-to-end through nginx (unlike WebSocket Ping control
        // frames which can be absorbed by the proxy on mobile networks).
        // The gateway uses it to clear the awaiting-pong flag and refresh
        // the Redis presence TTL, giving ≤16 s dead-connection detection.
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(JSON.stringify({ type: 'ping' }));
            } catch {
              /* socket closed between check and send */
            }
          }
        }, 8_000);
        try {
          await this.fetchPendingMessages();
        } catch (e) {
          console.error('Failed to fetch pending messages on connect:', e);
          // Non-blocking: connection is still valid, proceed
        }
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timeout);
        console.error('WebSocket Error:', event);
        if (!resolved) {
          resolved = true;
          const errorMsg = `WebSocket connection failed to ${wsUrl}/ws. Check that Chat Gateway is running and accessible.`;
          reject(new Error(errorMsg));
        }
      };
      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `WebSocket closed before opening. Code: ${event.code}, Reason: ${event.reason || 'Connection refused or network error'}`
            )
          );
        } else {
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
          // ── group_reset : signal hors-bande MLS ──────────────────────────
          // Le serveur a décidé que la session MLS de ce groupe est morte.
          // Chaque client doit oublier son état local et attendre d'être
          // ré-invité via welcome_request à la prochaine connexion.
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
    console.log(`[QUEUE] Démarrage traitement (${this.messageQueue.length} messages en file)`);

    const ackIds: string[] = [];

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

        // Track for batch ACK — only if the callback succeeded.
        // Returning false means "keep in queue for retry" (e.g. Welcome failed).
        if (cbResult !== false && msg.queuedMessageId) {
          ackIds.push(msg.queuedMessageId);
        }

        // If this was a Welcome, process buffered messages for this group
        if (msg.isWelcome && groupId && this.pendingWelcomeGroups.has(groupId)) {
          const buffered = this.pendingWelcomeGroups.get(groupId)!;
          console.log(`[QUEUE] Welcome complete, processing ${buffered.length} buffered messages`);
          this.pendingWelcomeGroups.delete(groupId);

          // Add buffered messages to front of queue (in order)
          for (let i = buffered.length - 1; i >= 0; i--) {
            this.messageQueue.unshift(buffered[i]);
          }
        }
      } catch (e) {
        console.error(`[QUEUE] Error processing message:`, e);
        // On exception, only ACK MLS structure messages (Welcome/Commit) — those
        // are idempotent and re-processing them would cause duplicate state.
        // Application messages are kept in queue so they can be retried after
        // the group state is repaired (e.g. after a successful re-Welcome).
        if (msg.queuedMessageId && (msg.isWelcome || msg.isCommit)) {
          ackIds.push(msg.queuedMessageId);
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
    }

    // Batch-ACK all processed real-time messages
    if (ackIds.length > 0) {
      void this.deliveryPost('messages/ack', {
        userId: this.userId,
        deviceId: this.deviceId,
        messageIds: ackIds,
      });
    }

    this.isProcessingQueue = false;
    console.log(`[QUEUE] Queue processing complete`);
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

  /**
   * Demande au serveur de déclencher un group_reset.
   * Le serveur va : reset toutes les memberships → reset epoch → broadcast
   * group_reset via WebSocket → chaque client oublie l'état MLS local.
   */
  async sendGroupReset(groupId: string, reason = 'bootstrap'): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/reset`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ reason, triggeredBy: `${this.userId}:${this.deviceId}` }),
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

  // simulateMessageReceive removed — pending messages now go through enqueueMessage
  // so they are serialized with live WebSocket messages via processQueue.

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
    // Publish to Chat History Service (delivery service)
    const base64 = btoa(String.fromCharCode(...keyPackageBytes));
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    const deviceOs = this.detectRuntimeDeviceOs();
    const response = await fetch(`${this.historyUrl}/api/mls-api/register-device`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: this.userId,
        deviceId: this.deviceId,
        keyPackage: base64,
        ...(storedName ? { deviceName: storedName } : {}),
        deviceOs,
        deviceAppVersion: undefined,
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
    return 'web';
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

  async sendCommit(
    commitBytes: Uint8Array,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    const proto = btoa(String.fromCharCode(...commitBytes));
    // Rust merges pending commit before returning bytes, so local epoch is already advanced.
    // The backend validates against the pre-commit epoch.
    const currentEpoch = this.getEpoch(groupId);
    const baseEpoch = Math.max(0, currentEpoch - 1);

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
      // En cas d'erreur réseau, on laisse passer (fail-open pour éviter le deadlock)
      return true;
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

  private async _initImpl(userId: string, pin: string, state?: Uint8Array) {
    this.userId = userId;
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

  async createGroup(groupId: string) {
    this.client.create_group(groupId);
  }

  async forceCreateGroup(groupId: string) {
    this.client.force_create_group(groupId);
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

  // Updated to accept PIN
  async saveState(pin: string) {
    // Pass PIN to save encrypted
    // Wasm binding updated to accept optional PIN
    return this.client.save_state(pin);
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
    const fallback = this.client.generate_key_package() as Uint8Array;

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
    // 50 is sufficient for normal use and avoids bloating the MLS state
    // with hundreds of unused private key bundles (each ~400 bytes).
    const existing = await this.fetchPrekeyCount();
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

  async addMember(groupId: string, keyPackageBytes: Uint8Array) {
    const res = this.client.add_member(groupId, keyPackageBytes);
    return {
      commit: res[0],
      welcome: res[1],
      ratchetTree: res[2] as Uint8Array | undefined,
    };
  }

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

  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array) {
    return this.client.process_welcome(welcomeBytes, ratchetTreeBytes);
  }

  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string
  ): Promise<Uint8Array> {
    const encryptedBytes: Uint8Array = this.client.send_message_bytes(groupId, messageBytes);
    const proto = btoa(String.fromCharCode(...encryptedBytes));
    const res = await fetch(`${this.historyUrl}/api/mls-api/send`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        groupId,
        proto,
      }),
    });
    if (!res.ok) {
      throw new Error(`Message send HTTP error: ${res.status}`);
    }
    return encryptedBytes;
  }

  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const result = this.client.process_incoming_message_bytes(groupId, messageBytes);
    return result ?? null;
  }

  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    if (!this.client) throw new Error('WC not initialized');
    return this.client.export_secret(groupId, label, context, keyLen);
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
  getDeviceId(): string {
    return this.deviceId;
  }

  getLocalGroups(): string[] {
    if (!this.client) return [];
    return Array.from(this.client.get_groups() as Iterable<string>);
  }

  getEpoch(groupId: string): number {
    if (!this.client) return 0;
    try {
      return this.client.get_epoch(groupId) as number;
    } catch {
      return 0;
    }
  }

  forgetGroup(groupId: string, minEpoch = 0): void {
    if (!this.client) return;
    try {
      this.client.forget_group(groupId, minEpoch);
    } catch (e) {
      console.warn('[MLS] forgetGroup error:', e);
    }
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
    // Build a JS Array for the WASM call
    const jsArray = userIds.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    const commitBytes: Uint8Array = this.client.remove_members(groupId, jsArray);
    await this.sendCommit(commitBytes, groupId);
  }

  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const jsArray = deviceIdentities.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    const commitBytes: Uint8Array = this.client.remove_members_by_device(groupId, jsArray);
    await this.sendCommit(commitBytes, groupId);
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
        `${this.historyUrl}/api/mls-api/pending-invitations/${userId}/${deviceId}`,
        { headers: await this.withAuthHeaders() }
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
        `${this.historyUrl}/api/mls-api/device-memberships/${userId}/${deviceId}`,
        { headers: await this.withAuthHeaders() }
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
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ deviceId, userId, groupId, status, lastEpochSeen }),
      });
    } catch (e) {
      console.error('Failed to update invitation status', e);
    }
  }

  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/kick-stale-device`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviceId, userId, groupId }),
    });
    if (!res.ok) throw new Error(`kickStaleDevice failed: ${res.status}`);
  }

  async resetGroupEpoch(groupId: string): Promise<void> {
    const res = await fetch(
      `${this.historyUrl}/api/mls-api/groups/${encodeURIComponent(groupId)}/reset-epoch`,
      {
        method: 'POST',
        headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
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
      if (!res.ok) {
        console.error(`deleteDeviceMembership failed: ${res.status}`);
        return { status: 'error', affected: 0 };
      }
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
      if (!res.ok) {
        console.error(`deleteAllDeviceMemberships failed: ${res.status}`);
        return { status: 'error', affected: 0 };
      }
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
      if (!res.ok) {
        console.error(`deleteDevice failed: ${res.status}`);
        return {
          status: 'error',
          groupsCleaned: 0,
          keyPackagesDeleted: 0,
          oneTimeKeyPackagesDeleted: 0,
        };
      }
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
