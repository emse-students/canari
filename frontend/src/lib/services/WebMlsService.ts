import type { IMlsService } from './IMlsService';
import {
  decodeInboundMsg,
  encodeEnvelope,
  mkMlsEnvelope,
  mkWelcomeEnvelope,
} from '$lib/proto/codec';

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
  private client: any;
  private ws: WebSocket | null = null;
  private messageCallback:
    | ((
        senderId: string,
        content: Uint8Array,
        groupId?: string,
        isWelcome?: boolean
      ) => Promise<boolean>)
    | null = null;
  private disconnectCallback: (() => void) | null = null;
  private baseUrl: string; // Chat Gateway URL
  private historyUrl: string; // Chat Delivery Service URL
  private userId: string = 'unknown';
  private deviceId: string;

  constructor() {
    // Device ID is initialized per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    // Prefer explicit env vars; fall back to same-origin (works behind a reverse proxy
    // like Nginx that routes /ws and /mls-api/ on the same domain).
    // An empty string is treated as "not configured" to match .env.example production convention.
    const envGateway = import.meta.env.VITE_GATEWAY_URL;
    this.baseUrl =
      envGateway && envGateway.trim()
        ? envGateway
        : typeof window !== 'undefined'
          ? window.location.origin
          : 'http://localhost:3000';

    const envHistory = import.meta.env.VITE_HISTORY_URL;
    this.historyUrl =
      envHistory && envHistory.trim()
        ? envHistory
        : typeof window !== 'undefined'
          ? window.location.origin
          : 'http://localhost:3001';
  }

  async connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Convert HTTP(S) URL to WS(S) URL
      // https:// -> wss://, http:// -> ws://
      const wsUrl = this.baseUrl.replace(/^https?:/, (match) =>
        match === 'https:' ? 'wss:' : 'ws:'
      );
      const fullWsUrl = `${wsUrl}/ws?token=${token}&device_id=${this.deviceId}`;

      console.log(`Connecting to WebSocket: ${fullWsUrl.replace(/token=[^&]+/, 'token=***')}`);
      this.ws = new WebSocket(fullWsUrl);
      let resolved = false;

      this.ws.onopen = async () => {
        resolved = true;
        console.log('Connected to Chat Gateway with DeviceID:', this.deviceId);
        await this.fetchPendingMessages();
        resolve();
      };
      this.ws.onerror = (event) => {
        console.error('WebSocket Error:', event);
        if (!resolved) {
          const errorMsg = `WebSocket connection failed to ${wsUrl}/ws. Check that Chat Gateway is running and accessible.`;
          reject(new Error(errorMsg));
        }
      };
      this.ws.onclose = (event) => {
        if (!resolved) {
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
          console.log(
            `[WS RCV] Raw websocket event. Type: ${typeof event.data}, isArrayBuffer: ${event.data instanceof ArrayBuffer}, isBlob: ${event.data instanceof Blob}`
          );
          // Gateway now sends binary proto InboundMsg frames.
          const buffer: ArrayBuffer =
            event.data instanceof ArrayBuffer
              ? event.data
              : await (event.data as Blob).arrayBuffer();

          console.log(`[WS RCV] Buffer byte length: ${buffer.byteLength}`);

          const inbound = decodeInboundMsg(new Uint8Array(buffer));
          console.log(
            `[WS RCV] Decoded InboundMsg: senderId=${inbound.senderId}, groupId=${inbound.groupId}, isWelcome=${inbound.isWelcome}, cipherLength=${inbound.ciphertext?.length}`
          );

          if (inbound.ciphertext && inbound.ciphertext.length > 0 && this.messageCallback) {
            console.log(`[WS RCV] Triggering messageCallback for inboud...`);
            await this.messageCallback(
              inbound.senderId || 'unknown',
              new Uint8Array(inbound.ciphertext),
              inbound.groupId || undefined,
              inbound.isWelcome === true
            );
            console.log(`[WS RCV] messageCallback finished.`);
          } else {
            console.warn(`[WS RCV] No ciphertext or no messageCallback set. Message ignored.`);
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
      isWelcome?: boolean
    ) => Promise<boolean>
  ) {
    this.messageCallback = callback;
  }

  onDisconnect(callback: () => void) {
    this.disconnectCallback = callback;
  }
  async fetchPendingMessages() {
    if (this.userId === 'unknown') return;

    // Fetch pending welcome messages (group invitations stored while offline)
    try {
      const wRes = await fetch(`${this.historyUrl}/mls-api/welcome/${this.deviceId}`);
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
            });
          }
        }
      }
    } catch (e) {
      console.error('Failed to fetch pending welcome messages', e);
    }

    try {
      const res = await fetch(
        `${this.historyUrl}/mls-api/messages/${this.userId}/${this.deviceId}`
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
            await fetch(`${this.historyUrl}/mls-api/messages/ack`, {
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

    // New format: pre-encoded InboundMsg proto (base64) — queued by gateway via delivery service
    if (data.proto) {
      try {
        const binaryString = atob(data.proto as string);
        const protoBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) protoBytes[i] = binaryString.charCodeAt(i);
        const inbound = decodeInboundMsg(protoBytes);
        if (inbound.ciphertext?.length) {
          return await this.messageCallback(
            inbound.senderId || 'unknown',
            new Uint8Array(inbound.ciphertext),
            inbound.groupId || undefined,
            inbound.isWelcome === true,
          );
        }
      } catch (e) {
        console.error('Message processing failed', e);
      }
      return false;
    }

    // Legacy format: raw base64 ciphertext + metadata (from /mls-api/welcome offline inbox)
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
      const res = await fetch(`${this.historyUrl}/mls-api/devices/${userId}`);
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
      await fetch(`${this.historyUrl}/mls-api/groups/${groupId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, deviceId }),
      });
    } catch (e) {
      console.error('Failed to register member', e);
    }
  }

  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    // Publish to Chat History Service (delivery service)
    const base64 = btoa(String.fromCharCode(...keyPackageBytes));
    const response = await fetch(`${this.historyUrl}/mls-api/register-device`, {
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
    targetDeviceId?: string
  ): Promise<void> {
    const base64 = btoa(String.fromCharCode(...welcomeBytes));

    if (targetDeviceId) {
      // Dedicated welcome endpoint: persists to MongoDB (offline inbox) and pushes
      // via Redis pubsub if the target device is currently online.
      await fetch(`${this.historyUrl}/mls-api/welcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDeviceId,
          targetUserId, // required to disambiguate when device IDs collide
          senderUserId: this.userId,
          welcomePayload: base64,
          groupId,
        }),
      });
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        encodeEnvelope(
          mkWelcomeEnvelope(welcomeBytes, groupId, [
            { userId: targetUserId, deviceId: targetDeviceId ?? '' },
          ])
        )
      );
    } else {
      await fetch(`${this.historyUrl}/mls-api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: this.userId,
          recipients: [{ userId: targetUserId }],
          content: base64,
          groupId,
          type: 'mlsWelcome',
        }),
      });
    }
  }

  async sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // MLS commit is also an MlsFrame (opaque to the server)
      this.ws.send(encodeEnvelope(mkMlsEnvelope(commitBytes, groupId)));
    } else {
      const base64 = btoa(String.fromCharCode(...commitBytes));
      await fetch(`${this.historyUrl}/mls-api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      // Import from local lib to ensure Vite handles it correctly
      const initWasm = await import('$lib/wasm/mls_wasm.js');

      await initWasm.default();

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

  async createRemoteGroup(name: string): Promise<string> {
    try {
      const res = await fetch(`${this.historyUrl}/mls-api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, createdBy: this.userId }),
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
    };
  }

  async processWelcome(welcomeBytes: Uint8Array) {
    return this.client.process_welcome(welcomeBytes);
  }

  async sendMessage(groupId: string, messageBytes: Uint8Array) {
    const encryptedBytes: Uint8Array = this.client.send_message_bytes(groupId, messageBytes);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Binary proto WsEnvelope { mls: { ciphertext, groupId } }
      this.ws.send(encodeEnvelope(mkMlsEnvelope(encryptedBytes, groupId)));
    } else {
      console.warn('WebSocket not connected. Sending via HTTP fallback...');
      const base64 = btoa(String.fromCharCode(...encryptedBytes));
      try {
        await fetch(`${this.historyUrl}/mls-api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderId: this.userId,
            senderDeviceId: this.deviceId,
            content: base64,
            groupId,
          }),
        });
      } catch (e) {
        console.error('HTTP Send failed:', e);
        throw e;
      }
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

  async fetchHistory(
    groupId: string
  ): Promise<{ sender_id: string; content: string; timestamp: string }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/history/${groupId}`);
      if (!res.ok) return [];
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

  async renameGroup(groupId: string, name: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/mls-api/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
  }

  async deleteGroupOnServer(groupId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/mls-api/groups/${groupId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    const res = await fetch(`${this.historyUrl}/mls-api/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Remove member failed: ${res.status}`);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    try {
      const res = await fetch(`${this.historyUrl}/mls-api/groups/${groupId}/members`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }
}
