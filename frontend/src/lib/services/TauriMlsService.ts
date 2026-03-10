import { invoke } from '@tauri-apps/api/core';
import type { IMlsService } from './IMlsService';
import {
  decodeInboundMsg,
  encodeEnvelope,
  mkMlsEnvelope,
  mkWelcomeEnvelope,
} from '$lib/proto/codec';

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly

export class TauriMlsService implements IMlsService {
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
  private baseUrl: string;
  private historyUrl: string;
  private userId: string = 'unknown';
  private deviceId: string;

  constructor() {
    // Device ID is initialized per-user in init() — see WebMlsService for rationale.
    this.deviceId = 'pending';

    const envGateway = import.meta.env.VITE_GATEWAY_URL;
    this.baseUrl = envGateway && envGateway.trim() ? envGateway : 'http://localhost:3000';

    const envHistory = import.meta.env.VITE_HISTORY_URL;
    this.historyUrl = envHistory && envHistory.trim() ? envHistory : 'http://localhost:3001';
  }

  async connect(token: string): Promise<void> {
    // Reuse direct WebSocket logic for now (Tauri allows localhost by default)
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${this.baseUrl.replace('http', 'ws')}/ws?token=${token}&device_id=${this.deviceId}`
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
          const buffer: ArrayBuffer =
            event.data instanceof ArrayBuffer
              ? event.data
              : await (event.data as Blob).arrayBuffer();
          const inbound = decodeInboundMsg(new Uint8Array(buffer));
          const senderId = inbound.senderId || 'unknown';
          const groupId = inbound.groupId || undefined;
          if (inbound.ciphertext?.length && this.messageCallback) {
            this.messageCallback(
              senderId,
              inbound.ciphertext as Uint8Array,
              groupId,
              inbound.isWelcome === true
            );
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
      const wRes = await fetch(`${this.historyUrl}/mls-api/welcome/${this.deviceId}`);
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
            inbound.isWelcome === true
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
          (data.senderId || 'unknown') as string,
          bytes,
          (data.groupId || data.session_id) as string | undefined,
          data.type === 'mlsWelcome'
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
      isWelcome?: boolean
    ) => Promise<boolean>
  ) {
    this.messageCallback = callback;
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
      await fetch(`${this.historyUrl}/mls-api/welcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDeviceId,
          targetUserId,
          senderUserId: this.userId,
          welcomePayload: base64,
          groupId,
        }),
      });
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        encodeEnvelope(
          mkWelcomeEnvelope(welcomeBytes, groupId, [
            { userId: targetUserId, deviceId: targetDeviceId ?? '' },
          ])
        )
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

  async sendCommit(commitBytes: Uint8Array, groupId: string): Promise<void> {
    const base64 = btoa(String.fromCharCode(...commitBytes));

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeEnvelope(mkMlsEnvelope(commitBytes, groupId)));
    } else {
      // Fallback HTTP
      await fetch(`${this.historyUrl}/mls-api/send`, {
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
    const result = await invoke<[number[], number[] | null]>('ajouter_membre', {
      groupId,
      keyPackageBytes: Array.from(keyPackageBytes),
    });
    return {
      commit: Uint8Array.from(result[0]),
      welcome: result[1] ? Uint8Array.from(result[1]) : undefined,
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
    const addedDeviceIds: string[] = [];
    for (const device of devices) {
      try {
        const res = await this.addMember(groupId, device.keyPackage);
        lastCommit = res.commit;
        lastWelcome = res.welcome;
        addedDeviceIds.push(device.deviceId);
      } catch (e) {
        console.warn(`Skipping device ${device.deviceId}: ${e}`);
      }
    }
    if (!lastCommit) throw new Error('No valid devices to add');
    return { commit: lastCommit, welcome: lastWelcome, addedDeviceIds };
  }

  async processWelcome(welcomeBytes: Uint8Array) {
    return await invoke<string>('trailer_welcome', { welcomeBytes: Array.from(welcomeBytes) });
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
      this.ws.send(encodeEnvelope(mkMlsEnvelope(encryptedBytes, groupId)));
    } else {
      console.warn('WebSocket not open, using HTTP fallback');
      try {
        const response = await fetch(`${this.historyUrl}/mls-api/send`, {
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
