import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';
import type { IMlsService } from './IMlsService';

/** Message pending in the processing queue */
interface QueuedMessage {
  senderId: string;
  ciphertext: Uint8Array;
  groupId?: string;
  isWelcome: boolean;
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
        ratchetTreeBytes?: Uint8Array
      ) => Promise<boolean>)
    | null = null;
  private disconnectCallback: (() => void) | null = null;
  private baseUrl: string;
  private historyUrl: string;
  private userId: string = 'unknown';
  private deviceId: string;

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

  async connect(token: string): Promise<void> {
    // Reuse direct WebSocket logic for now (Tauri allows localhost by default)
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${this.baseUrl.replace('http', 'ws')}/api/ws?token=${token}&device_id=${this.deviceId}`
      );
      let resolved = false;
      this.ws.onopen = async () => {
        resolved = true;
        console.log('Connected to Chat Gateway (Tauri) with DeviceID:', this.deviceId);
        await this.fetchPendingMessages();
        resolve();
      };
      this.ws.onerror = (e) => {
        if (!resolved) reject(e);
      };
      this.ws.onclose = (event) => {
        if (!resolved) {
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
          }
        } catch (e) {
          console.error('Failed to process WebSocket message:', e);
        }
      };
    });
  }

  async fetchPendingMessages() {
    if (this.userId === 'unknown') return;

    // Fetch pending welcome messages (group invitations stored while offline)
    try {
      const wRes = await fetch(`${this.historyUrl}/api/mls-api/welcome/${this.deviceId}`);
      if (wRes.ok) {
        const welcomes = await wRes.json();
        if (Array.isArray(welcomes) && welcomes.length > 0) {
          console.log(`Fetched ${welcomes.length} pending welcome message(s)`);
          for (const w of welcomes) {
            await this.simulateMessageReceive({
              type: 'mlsWelcome',
              content: w.message,
              senderId: w.senderUserId ?? 'system',
              groupId: w.groupId,
              ratchetTree: w.ratchetTree,
            });
          }
        }
      }
    } catch (e) {
      console.error('Failed to fetch pending welcome messages', e);
    }

    try {
      const res = await fetch(
        `${this.historyUrl}/api/mls-api/messages/${this.userId}/${this.deviceId}`
      );
      if (res.ok) {
        const messages = await res.json();
        if (Array.isArray(messages) && messages.length > 0) {
          console.log(`Fetched ${messages.length} pending messages`);

          const successfullyProcessedIds: string[] = [];

          for (const msg of messages) {
            const success = await this.simulateMessageReceive(msg);
            if (success && msg._id) {
              successfullyProcessedIds.push(msg._id);
            }
          }

          if (successfullyProcessedIds.length > 0) {
            await fetch(`${this.historyUrl}/api/mls-api/messages/ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: this.userId,
                deviceId: this.deviceId,
                messageIds: successfullyProcessedIds,
              }),
            });
            console.log(`Acknowledged ${successfullyProcessedIds.length} messages`);
          }
        }
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
          (data.senderId || 'unknown') as string,
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
        // Clean up pending Welcome state on error
        if (msg.isWelcome && groupId) {
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

  getDeviceId(): string {
    return this.deviceId;
  }

  async fetchUserDevices(
    userId: string
  ): Promise<Array<{ keyPackage: Uint8Array; deviceId: string }>> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/devices/${userId}`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, deviceId }),
      });
    } catch (e) {
      console.error('Failed to register member', e);
    }
  }

  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = btoa(String.fromCharCode(...keyPackageBytes));
    const response = await fetch(`${this.historyUrl}/api/mls-api/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    if (targetDeviceId) {
      const response = await fetch(`${this.historyUrl}/api/mls-api/welcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDeviceId,
          targetUserId,
          senderUserId: this.userId,
          welcomePayload: base64,
          ratchetTreePayload: ratchetTreeBase64,
          groupId,
        }),
      });
      await this.assertOkResponse(
        response,
        `Welcome delivery to ${targetUserId}:${targetDeviceId} (group ${groupId})`
      );
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'welcome',
          groupId,
          proto: base64,
          ratchetTree: ratchetTreeBase64,
          recipients: [{ userId: targetUserId, deviceId: targetDeviceId ?? '' }],
        })
      );
    }
  }

  async init(userId: string, pin: string, state?: Uint8Array) {
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
    await invoke('initialiser_mls', { userId, pin, encryptedState });
  }

  async createGroup(groupId: string) {
    await invoke('creer_groupe', { groupId });
  }

  async createRemoteGroup(name: string, isGroup: boolean = true): Promise<string> {
    try {
      const res = await fetch(`${this.historyUrl}/api/mls-api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  async sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void> {
    const base64 = btoa(String.fromCharCode(...commitBytes));

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: 'mls', groupId, proto: btoa(String.fromCharCode(...commitBytes)) })
      );
    } else {
      // Fallback HTTP
      await fetch(`${this.historyUrl}/api/mls-api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: this.userId,
          senderDeviceId: this.deviceId,
          groupId: groupId,
          content: base64,
          type: 'handshake',
        }),
      });
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
    return await invoke<string>('trailer_welcome', {
      welcomeBytes: Array.from(welcomeBytes),
      ratchetTreeBytes: ratchetTreeBytes ? Array.from(ratchetTreeBytes) : null,
    });
  }

  async sendMessage(groupId: string, messageBytes: Uint8Array) {
    const res = await invoke<number[]>('envoyer_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    const encryptedBytes = Uint8Array.from(res);
    const base64 = btoa(String.fromCharCode(...encryptedBytes));

    // Send via WebSocket if connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'mls',
          groupId,
          proto: btoa(String.fromCharCode(...encryptedBytes)),
        })
      );
    } else {
      console.warn('WebSocket not open, using HTTP fallback');
      try {
        const response = await fetch(`${this.historyUrl}/api/mls-api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderId: this.userId,
            senderDeviceId: this.deviceId,
            content: base64,
            groupId: groupId,
          }),
        });
        if (!response.ok) {
          throw new Error(`HTTP fallback failed: ${response.statusText}`);
        }
      } catch (e) {
        console.error('Failed to send message via HTTP fallback', e);
        throw e;
      }
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
    groupId: string
  ): Promise<{ sender_id: string; content: string; timestamp: string }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/api/history/${groupId}`);
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
    // Tauri uses the Rust MLS core directly; group list not exposed via IPC yet.
    // Return empty array as fallback — the mismatch detection will simply be skipped.
    return [];
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
  }

  async deleteGroupOnServer(groupId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/api/mls-api/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
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
}
