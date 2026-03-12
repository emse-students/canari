import type { IMlsService } from './IMlsService';

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
  private client: any;
  private ws: WebSocket | null = null;
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
              console.log(`[WS RCV] Triggering messageCallback...`);
              await this.messageCallback(
                (msg.senderId as string) || 'unknown',
                ciphertext,
                (msg.groupId as string) || undefined,
                msg.isWelcome === true,
                ratchetTreeBytes
              );
              console.log(`[WS RCV] messageCallback finished.`);
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
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    const base64 = btoa(String.fromCharCode(...welcomeBytes));
    const ratchetTreeBase64 = ratchetTreeBytes
      ? btoa(String.fromCharCode(...ratchetTreeBytes))
      : undefined;

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
          ratchetTreePayload: ratchetTreeBase64,
          groupId,
        }),
      });
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'welcome',
          groupId,
          proto: btoa(String.fromCharCode(...welcomeBytes)),
          ratchetTree: ratchetTreeBase64,
          recipients: [{ userId: targetUserId, deviceId: targetDeviceId ?? '' }],
        })
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
          ratchetTree: ratchetTreeBase64,
          type: 'mlsWelcome',
        }),
      });
    }
  }

  async sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // MLS commit is also an MlsFrame (opaque to the server)
      this.ws.send(
        JSON.stringify({ type: 'mls', groupId, proto: btoa(String.fromCharCode(...commitBytes)) })
      );
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

      const w = window as Window & { wasm_bindings_log?: (level: string, msg: string) => void };
      if (typeof w.wasm_bindings_log !== 'function') {
        // Defensive fallback: logger must exist before init_logger() is called.
        w.wasm_bindings_log = (level: string, msg: string) => {
          console.log(`[RUST::${level}] ${msg}`);
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
      this.ws.send(
        JSON.stringify({
          type: 'mls',
          groupId,
          proto: btoa(String.fromCharCode(...encryptedBytes)),
        })
      );
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
