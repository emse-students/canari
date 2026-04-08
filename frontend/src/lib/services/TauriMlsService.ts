import { invoke } from '@tauri-apps/api/core';
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
  private baseUrl: string;
  private historyUrl: string;
  private userId: string = 'unknown';
  private deviceId: string;
  /** Cache of locally known MLS group IDs, populated after init and updated on group changes. */
  private _knownGroups: Set<string> = new Set();
  /** Resolved when init() completes; shared across concurrent callers to avoid double native init. */
  private initPromise: Promise<void> | null = null;

  // Message queue for sequential processing
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue = false;
  // Groups currently being joined (Welcome in progress) - buffer messages for these
  private pendingWelcomeGroups = new Map<string, QueuedMessage[]>();

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

    const token = await getToken();

    // Reuse direct WebSocket logic for now (Tauri allows localhost by default)
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${this.baseUrl.replace('http', 'ws')}/api/ws?token=${token}&device_id=${this.deviceId}`
      );
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
        console.log('Connected to Chat Gateway (Tauri) with DeviceID:', this.deviceId);
        try {
          await this.fetchPendingMessages();
        } catch (e) {
          console.error('Failed to fetch pending messages on connect (Tauri):', e);
          // Non-blocking: connection is still valid, proceed
        }
        resolve();
      };
      this.ws.onerror = (e) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(e);
        }
      };
      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed before opening. Code: ${event.code}`));
        } else {
          console.warn(`WebSocket disconnected. Code: ${event.code}`);
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
          if (msg.type && msg.type.startsWith('channel.')) {
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
              });
            }
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

          const successfullyProcessedIds: string[] = [];

          for (const msg of messages) {
            const msgId = (msg.id || msg._id) as string | undefined;
            const processed = await this.simulateMessageReceive(msg);
            if (msgId && processed) successfullyProcessedIds.push(msgId);
          }

          if (successfullyProcessedIds.length > 0) {
            const ackRes = await fetch(`${this.historyUrl}/api/mls-api/messages/ack`, {
              method: 'POST',
              headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                userId: this.userId,
                deviceId: this.deviceId,
                messageIds: successfullyProcessedIds,
              }),
              keepalive: true,
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
              : undefined,
            data.isCommit === true
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
          (data.senderId || 'unknown') as string,
          bytes,
          (data.groupId || data.session_id) as string | undefined,
          data.type === 'mlsWelcome',
          typeof data.ratchetTree === 'string' && data.ratchetTree.length > 0
            ? Uint8Array.from(atob(data.ratchetTree as string), (c) => c.charCodeAt(0))
            : undefined,
          data.isCommit === true
        );
      } catch (e) {
        console.error('Message processing failed', e);
      }
    }
    return false;
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
          msg.ratchetTreeBytes,
          msg.isCommit
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

  getDeviceId(): string {
    return this.deviceId;
  }

  async fetchUserDevices(
    userId: string
  ): Promise<Array<{ keyPackage: Uint8Array; deviceId: string }>> {
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
        return { keyPackage: bytes, deviceId: d.deviceId };
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
    const response = await fetch(`${this.historyUrl}/api/mls-api/register-device`, {
      method: 'POST',
      headers: await this.withAuthHeaders({ 'Content-Type': 'application/json' }),
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

    // Per-user device ID (same rationale as WebMlsService)
    const deviceKey = `mls_device_id_${userId}`;
    const storedDevice = localStorage.getItem(deviceKey);
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      this.deviceId =
        'tauri-' +
        userId +
        '-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2, 6);
      localStorage.setItem(deviceKey, this.deviceId);
    }

    const encryptedState = state ? Array.from(state) : null;
    await invoke('initialiser_mls', { userId, deviceId: this.deviceId, pin, encryptedState });

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
    // Pass the PIN to the Tauri command
    return await invoke<Uint8Array>('sauvegarder_mls', { pin });
  }

  async generateKeyPackage(pin: string) {
    // Generate the KP
    const kp = await invoke<number[]>('generer_key_package');
    // Force save state
    await this.saveState(pin);

    // Publish via WS
    const kpBytes = Uint8Array.from(kp);
    await this.publishKeyPackage(kpBytes);

    return kpBytes;
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
    // Tauri: call add_member once per device (Tauri backend may not have bulk yet),
    // but wrap in a single logical operation and return combined result.
    // The welcome from the LAST successful add covers all added members (openMLS behaviour).
    let lastCommit: Uint8Array | undefined;
    let lastWelcome: Uint8Array | undefined;
    let lastRatchetTree: Uint8Array | undefined;
    const addedDeviceIds: string[] = [];
    for (const device of devices) {
      try {
        const res = await this.addMember(groupId, device.keyPackage);
        lastCommit = res.commit;
        lastWelcome = res.welcome;
        lastRatchetTree = res.ratchetTree;
        addedDeviceIds.push(device.deviceId);
      } catch (e) {
        console.warn(`Skipping device ${device.deviceId}: ${e}`);
      }
    }
    if (!lastCommit) throw new Error('No valid devices to add');
    return {
      commit: lastCommit,
      welcome: lastWelcome,
      addedDeviceIds,
      ratchetTree: lastRatchetTree,
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
    await this.sendCommit(new Uint8Array(commitBytes), groupId, [
      `${this.userId}:${this.getDeviceId()}`,
    ]);
  }

  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    const commitBytes = await invoke<number[]>('retirer_membres_par_appareil', {
      groupId,
      deviceIdentities,
    });
    await this.sendCommit(new Uint8Array(commitBytes), groupId, [
      `${this.userId}:${this.getDeviceId()}`,
    ]);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members`);
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
      const res = await fetch(`${this.historyUrl}/api/mls-api/user-groups/${userId}`);
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
        { method: 'DELETE' }
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
        { method: 'DELETE' }
      );
      if (!res.ok) return { status: 'error', affected: 0 };
      return await res.json();
    } catch (e) {
      console.error('Failed to delete all device memberships', e);
      return { status: 'error', affected: 0 };
    }
  }
}
