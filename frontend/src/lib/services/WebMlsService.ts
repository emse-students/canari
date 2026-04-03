import type { IMlsService } from './IMlsService';

/** Message pending in the processing queue */
interface QueuedMessage {
  senderId: string;
  ciphertext: Uint8Array;
  groupId?: string;
  isWelcome: boolean;
  ratchetTreeBytes?: Uint8Array;
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
        ratchetTreeBytes?: Uint8Array
      ) => Promise<boolean>)
    | null = null;
  private disconnectCallback: (() => void) | null = null;
  private syncRequestCallback: ((senderDeviceId: string) => void) | null = null;
  private baseUrl: string; // Chat Gateway URL
  private historyUrl: string; // Chat Delivery Service URL
  private authToken: string | null = null;
  private userId: string = 'unknown';
  private deviceId: string;

  // Message queue for sequential processing
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue = false;
  // Groups currently being joined (Welcome in progress) - buffer messages for these
  private pendingWelcomeGroups = new Map<string, QueuedMessage[]>();

  private withAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    return headers;
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

  async connect(token: string): Promise<void> {
    this.authToken = token;

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

    return new Promise((resolve, reject) => {
      // Convert HTTP(S) URL to WS(S) URL
      // https:// -> wss://, http:// -> ws://
      const wsUrl = this.baseUrl.replace(/^https?:/, (match) =>
        match === 'https:' ? 'wss:' : 'ws:'
      );
      const fullWsUrl = `${wsUrl}/api/ws?token=${token}&device_id=${this.deviceId}`;

      console.log(`Connecting to WebSocket: ${fullWsUrl.replace(/token=[^&]+/, 'token=***')}`);
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
          if (msg.type === 'sync_request') {
            const senderDev = (msg.senderDeviceId as string) || '';
            console.log(`[WS RCV] sync_request from ${senderDev}`);
            this.syncRequestCallback?.(senderDev);
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
                ratchetTreeBytes,
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
      ratchetTreeBytes?: Uint8Array
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
    if (this.isProcessingQueue || !this.messageCallback) return;

    this.isProcessingQueue = true;
    console.log(`[QUEUE] Starting queue processing (${this.messageQueue.length} messages)`);

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      const groupId = msg.groupId;

      try {
        console.log(
          `[QUEUE] Processing ${msg.isWelcome ? 'Welcome' : 'message'} for group ${groupId ?? 'unknown'}`
        );
        await this.messageCallback(
          msg.senderId,
          msg.ciphertext,
          msg.groupId,
          msg.isWelcome,
          msg.ratchetTreeBytes
        );

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
        // Clean up pending Welcome state on error to prevent buffering forever
        if (groupId) {
          this.pendingWelcomeGroups.delete(groupId);
        }
      }
    }

    this.isProcessingQueue = false;
    console.log(`[QUEUE] Queue processing complete`);
  }

  onDisconnect(callback: () => void) {
    this.disconnectCallback = callback;
  }

  sendSyncRequest(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sync_request', proto: '' }));
      console.log('[WS] sync_request sent');
    }
  }

  onSyncRequest(callback: (senderDeviceId: string) => void): void {
    this.syncRequestCallback = callback;
  }

  async fetchPendingMessages() {
    if (this.userId === 'unknown') return;

    const FETCH_TIMEOUT = 10_000;

    // Fetch pending welcome messages (group invitations stored while offline)
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      const wRes = await fetch(`${this.historyUrl}/api/mls-api/welcome/${this.deviceId}`, {
        headers: this.withAuthHeaders(),
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (wRes.ok) {
        const welcomes = await wRes.json();
        if (Array.isArray(welcomes) && welcomes.length > 0) {
          console.log(`Fetched ${welcomes.length} pending welcome message(s)`);
          for (const w of welcomes) {
            // Normalise the stored welcome into the same shape simulateMessageReceive expects
            await this.simulateMessageReceive({
              type: 'mlsWelcome',
              content: w.message,
              senderId: w.senderUserId ?? 'system', // senderUserId = the inviter, NOT the recipient
              groupId: w.groupId,
              ratchetTree: w.ratchetTree,
            });
          }
        } else {
          console.log(`[WELCOME][PENDING] No pending welcome for device ${this.deviceId}`);
        }
      } else {
        console.warn(
          `[WELCOME][PENDING] Welcome fetch failed: ${wRes.status} ${wRes.statusText} (device=${this.deviceId})`
        );
      }
    } catch (e) {
      console.error('Failed to fetch pending welcome messages', e);
    }

    try {
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), FETCH_TIMEOUT);
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/messages/${this.userId}/${this.deviceId}`,
        { headers: this.withAuthHeaders(), signal: ctrl2.signal }
      );
      clearTimeout(tid2);
      if (res.ok) {
        const messages = await res.json();
        if (Array.isArray(messages) && messages.length > 0) {
          console.log(`Fetched ${messages.length} pending messages`);

          const successfullyProcessedIds: string[] = [];

          for (const msg of messages) {
            const success = await this.simulateMessageReceive(msg);
            const msgId = msg.id || msg._id;
            if (success && msgId) {
              successfullyProcessedIds.push(msgId);
            }
          }

          if (successfullyProcessedIds.length > 0) {
            const ackRes = await fetch(`${this.historyUrl}/api/mls-api/messages/ack`, {
              method: 'POST',
              headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                userId: this.userId,
                deviceId: this.deviceId,
                messageIds: successfullyProcessedIds,
              }),
            });
            if (!ackRes.ok) {
              console.error(`Message ACK failed: ${ackRes.status}`);
            } else {
              console.log(`Acknowledged ${successfullyProcessedIds.length} messages`);
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

  private async simulateMessageReceive(data: any): Promise<boolean> {
    if (!this.messageCallback) return false;

    // Flat format: proto = base64(raw ciphertext), metadata fields alongside
    if (data.proto) {
      try {
        const binaryString = atob(data.proto as string);
        const ciphertext = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) ciphertext[i] = binaryString.charCodeAt(i);
        if (ciphertext.length > 0) {
          return await this.messageCallback(
            (data.senderId as string) || 'unknown',
            ciphertext,
            (data.groupId as string) || undefined,
            data.isWelcome === true,
            typeof data.ratchetTree === 'string' && data.ratchetTree.length > 0
              ? Uint8Array.from(atob(data.ratchetTree as string), (c) => c.charCodeAt(0))
              : undefined
          );
        }
      } catch (e) {
        console.error('Message processing failed', e);
      }
      return false;
    }

    // Legacy format: raw base64 ciphertext + metadata (from /api/mls-api/welcome offline inbox)
    if (data.content) {
      try {
        const binaryString = atob(data.content as string);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        return await this.messageCallback(
          (data.senderId || data.sender_id || 'unknown') as string,
          bytes,
          (data.groupId || data.session_id) as string | undefined,
          data.type === 'mlsWelcome',
          typeof data.ratchetTree === 'string' && data.ratchetTree.length > 0
            ? Uint8Array.from(atob(data.ratchetTree as string), (c) => c.charCodeAt(0))
            : undefined
        );
      } catch (e) {
        console.error('Message processing failed', e);
      }
    }
    return false;
  }

  async fetchUserDevices(
    userId: string
  ): Promise<Array<{ keyPackage: Uint8Array; deviceId: string }>> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/devices/${userId}`, {
        headers: this.withAuthHeaders(),
      });
      if (!res.ok) return [];
      const devices = await res.json();

      return devices.map((d: any) => {
        const binaryString = atob(d.keyPackage);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return { keyPackage: bytes, deviceId: d.deviceId };
      });
    } catch (e) {
      console.error('Fetch User Devices Error:', e);
      return [];
    }
  }

  async registerMember(groupId: string, userId: string, deviceId: string): Promise<void> {
    try {
      await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members`, {
        method: 'POST',
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ userId, deviceId }),
      });
    } catch (e) {
      console.error('Failed to register member', e);
    }
  }

  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    // Publish to Chat History Service (delivery service)
    const base64 = btoa(String.fromCharCode(...keyPackageBytes));
    const response = await fetch(`${this.historyUrl}/api/mls-api/register-device`, {
      method: 'POST',
      headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: this.userId,
        deviceId: this.deviceId,
        keyPackage: base64,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to publish KeyPackage: ${response.status} ${response.statusText}`);
    }
  }

  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    console.log(
      `[MLS] sendWelcome called: target=${targetUserId}:${targetDeviceId}, group=${groupId}, welcomeLen=${welcomeBytes.length}, treeLen=${ratchetTreeBytes?.length ?? 0}`
    );
    const base64 = btoa(String.fromCharCode(...welcomeBytes));
    const ratchetTreeBase64 = ratchetTreeBytes
      ? btoa(String.fromCharCode(...ratchetTreeBytes))
      : undefined;

    if (targetDeviceId) {
      // Dedicated welcome endpoint: persists to MongoDB (offline inbox) and pushes
      // via Redis pubsub if the target device is currently online.
      console.log(`[MLS] POSTing Welcome to ${this.historyUrl}/api/mls-api/welcome`);
      const response = await fetch(`${this.historyUrl}/api/mls-api/welcome`, {
        method: 'POST',
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          targetDeviceId,
          targetUserId, // required to disambiguate when device IDs collide
          senderUserId: this.userId,
          welcomePayload: base64,
          ratchetTreePayload: ratchetTreeBase64,
          groupId,
        }),
      });
      console.log(`[MLS] Welcome POST response: ${response.status}`);
      await this.assertOkResponse(
        response,
        `Welcome delivery to ${targetUserId}:${targetDeviceId} (group ${groupId})`
      );
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // WS path: we need a deviceId for the gateway to route properly.
      // If caller didn't provide one, resolve it from the delivery service.
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
      this.ws.send(
        JSON.stringify({
          type: 'welcome',
          groupId,
          proto: btoa(String.fromCharCode(...welcomeBytes)),
          ratchetTree: ratchetTreeBase64,
          recipients: [{ userId: targetUserId, deviceId: resolvedDeviceId }],
        })
      );
    } else {
      // WS closed fallback: resolve deviceId and use the dedicated REST endpoint.
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
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
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
        `Welcome fallback delivery to ${targetUserId}:${resolvedDeviceId} (group ${groupId})`
      );
    }
  }

  async sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void> {
    const proto = btoa(String.fromCharCode(...commitBytes));
    const baseEpoch = this.getEpoch(groupId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'commit', groupId, proto, baseEpoch }));
    } else {
      const base64 = btoa(String.fromCharCode(...commitBytes));
      await fetch(`${this.historyUrl}/api/mls-api/send`, {
        method: 'POST',
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          senderId: this.userId,
          senderDeviceId: this.deviceId,
          groupId,
          content: base64,
          type: 'handshake',
        }),
      });
    }
  }

  async acquireAddLock(groupId: string, ttlMs = 10_000): Promise<boolean> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/add-lock`, {
        method: 'POST',
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
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
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId }),
      });
    } catch {
      // Non-bloquant
    }
  }

  async init(userId: string, pin: string, state?: Uint8Array) {
    this.userId = userId;

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

    // Import dynamique du WASM généré
    try {
      // Import from local lib and force the .wasm asset URL through Vite.
      const [initWasm, wasmAsset] = await Promise.all([
        import('$lib/wasm/mls_wasm.js'),
        import('$lib/wasm/mls_wasm_bg.wasm?url'),
      ]);

      const wasmUrl = (wasmAsset as { default: string }).default;
      const wasmResponse = await fetch(wasmUrl, { credentials: 'same-origin' });
      if (!wasmResponse.ok) {
        throw new Error(
          `Chargement WASM impossible (${wasmResponse.status} ${wasmResponse.statusText}) depuis ${wasmUrl}`
        );
      }

      const contentType = wasmResponse.headers.get('Content-Type')?.toLowerCase() ?? '';
      if (contentType.includes('text/html')) {
        throw new Error(
          `Réponse HTML reçue à la place du binaire WASM (${wasmUrl}). Vérifiez le routage statique / MIME.`
        );
      }

      const magic = new Uint8Array((await wasmResponse.clone().arrayBuffer()).slice(0, 4));
      const isWasmMagic =
        magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d;
      if (!isWasmMagic) {
        throw new Error(`Binaire WASM invalide (${wasmUrl}) : signature incorrecte.`);
      }

      await initWasm.default(wasmResponse);

      const w = window as Window & { wasm_bindings_log?: (level: string, msg: string) => void };
      if (typeof w.wasm_bindings_log !== 'function') {
        // Defensive fallback: logger must exist before init_logger() is called.
        w.wasm_bindings_log = (level: string, msg: string) => {
          // Filter out expected MLS errors that are handled gracefully:
          // - WrongEpoch: happens when receiving own commits (already merged locally)
          // - CannotDecryptOwnMessage: expected for self-sent messages
          const isExpectedError =
            level === 'ERROR' &&
            (msg.includes('Wrong Epoch') ||
              msg.includes('CannotDecryptOwnMessage') ||
              msg.includes('wrong epoch'));
          if (isExpectedError) {
            // Downgrade to debug level - these are expected during normal operation
            console.debug(`[RUST::${level}] ${msg}`);
          } else if (level === 'DEBUG') {
            console.debug(`[RUST::${level}] ${msg}`);
          } else {
            console.log(`[RUST::${level}] ${msg}`);
          }
        };
      }

      // Initialize logger if available
      if (initWasm.init_logger) {
        initWasm.init_logger();
      }

      this.client = new initWasm.WasmMlsClient(userId, state, pin);
    } catch (e) {
      console.error('WASM Init Failed:', e);
      throw e;
    }
  }

  async createGroup(groupId: string) {
    this.client.create_group(groupId);
  }

  async createRemoteGroup(name: string, isGroup: boolean = true): Promise<string> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/groups`, {
        method: 'POST',
        headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name, createdBy: this.userId, isGroup }),
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

  async generateKeyPackage(pin: string) {
    const kp = this.client.generate_key_package();
    // WASM side persistence for web:
    // Attempt to save state.
    try {
      const stateBytes = this.client.save_state(pin); // Returns Encrypted Uint8Array

      const hex = Array.from(stateBytes as Uint8Array)
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');
      localStorage.setItem('mls_autosave_' + this.userId, hex);
    } catch (e) {
      console.warn('Auto-save failed in WASM mode', e);
    }

    await this.publishKeyPackage(kp as Uint8Array);

    return kp;
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

  async sendMessage(groupId: string, messageBytes: Uint8Array) {
    const encryptedBytes: Uint8Array = this.client.send_message_bytes(groupId, messageBytes);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Binary proto WsEnvelope { mls: { ciphertext, groupId } }
      try {
        this.ws.send(
          JSON.stringify({
            type: 'mls',
            groupId,
            proto: btoa(String.fromCharCode(...encryptedBytes)),
          })
        );
      } catch (wsErr) {
        // WebSocket closed between readyState check and send — fall through to HTTP
        console.warn('WebSocket send failed, falling back to HTTP:', wsErr);
        await this.sendViaHttp(encryptedBytes, groupId);
      }
    } else {
      await this.sendViaHttp(encryptedBytes, groupId);
    }

    return encryptedBytes;
  }

  private async sendViaHttp(encryptedBytes: Uint8Array, groupId: string): Promise<void> {
    console.warn('Sending via HTTP fallback...');
    const base64 = btoa(String.fromCharCode(...encryptedBytes));
    const res = await fetch(`${this.historyUrl}/api/mls-api/send`, {
      method: 'POST',
      headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        content: base64,
        groupId,
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP send failed: ${res.status} ${res.statusText}`);
    }
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
        headers: this.withAuthHeaders(),
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
      headers: this.withAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
  }

  async deleteGroupOnServer(groupId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}`, {
      method: 'DELETE',
      headers: this.withAuthHeaders(),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
      headers: this.withAuthHeaders(),
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

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members`, {
        headers: this.withAuthHeaders(),
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
        headers: this.withAuthHeaders(),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }
}
