import { invoke } from '@tauri-apps/api/core';
import type { IMlsService } from './IMlsService';

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly

export class TauriMlsService implements IMlsService {
    private ws: WebSocket | null = null;
    private messageCallback: ((senderId: string, content: Uint8Array, groupId?: string) => void) | null = null;
    private baseUrl = "http://localhost:3000";
    private historyUrl = "http://localhost:3001";
    private userId: string = "unknown";
    private deviceId: string;

    constructor() {
        // Ensure stable Device ID across sessions
        const stored = localStorage.getItem("mls_device_id");
        if (stored) {
            this.deviceId = stored;
        } else {
            this.deviceId = "tauri-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
            localStorage.setItem("mls_device_id", this.deviceId);
        }
    }

    async connect(token: string): Promise<void> {
        // Reuse direct WebSocket logic for now (Tauri allows localhost by default)
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`${this.baseUrl.replace('http', 'ws')}/ws?token=${token}&device_id=${this.deviceId}`);
            this.ws.onopen = async () => {
                console.log("Connected to Chat Gateway (Tauri) with DeviceID:", this.deviceId);
                await this.fetchPendingMessages();
                resolve();
            };
            this.ws.onerror = (e) => reject(e);
            this.ws.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    let base64Content: string | null = null;
                    const senderId: string = data.senderId || data.sender_id || "unknown";

                    // Filter out own messages (avoid echo from server broadcast)
                    // Always drop messages where WE are the sender — no type check needed
                    if (senderId === this.userId) {
                        console.debug(`Filtering out own message echo`);
                        return;
                    }

                    if (data.type === "welcomeMessage" && data.content) {
                        base64Content = data.content;
                    } else if (data.content) {
                        base64Content = data.content;
                    }

                    if (base64Content && this.messageCallback) {
                        const binaryString = atob(base64Content);
                        const bytes = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                        }
                        const groupId = data.groupId || data.session_id;
                        this.messageCallback(senderId, bytes, groupId);
                    }
                } catch (e) {
                    console.error("Failed to process WebSocket message:", e);
                }
            };
        });
    }

    async fetchPendingMessages() {
        if (this.userId === "unknown") return;
        try {
            const res = await fetch(`${this.historyUrl}/mls-api/messages/${this.userId}/${this.deviceId}`);
            if (res.ok) {
                const messages = await res.json();
                if (Array.isArray(messages) && messages.length > 0) {
                    console.log(`Fetched ${messages.length} pending messages`);
                    // Simulate receiving via WebSocket for consistent processing
                    for (const msg of messages) {
                        this.simulateMessageReceive(msg);
                    }
                }
            }
        } catch (e) {
            console.error("Failed to fetch pending messages", e);
        }
    }

    private simulateMessageReceive(data: any) {
        if (this.messageCallback) {
             let base64Content: string | null = null;
             // Handle same logic as onmessage
             if (data.type === "mlsWelcome" && data.content) {
                 base64Content = data.content;
             } else if (data.content) {
                 base64Content = data.content;
             }
             
             if (base64Content) {
                 const binaryString = atob(base64Content);
                 const bytes = new Uint8Array(binaryString.length);
                 for (let i = 0; i < binaryString.length; i++) {
                     bytes[i] = binaryString.charCodeAt(i);
                 }
                 const senderId = data.senderId || "unknown";
                 const groupId = data.groupId || data.session_id;
                 this.messageCallback(senderId, bytes, groupId);
             }
        }
    }

    onMessage(callback: (senderId: string, content: Uint8Array, groupId?: string) => void) {
        this.messageCallback = callback;
    }

    getDeviceId(): string {
        return this.deviceId;
    }

    async fetchKeyPackage(userId: string): Promise<{ keyPackage: Uint8Array, deviceId: string } | null> {
        // Using fetch API directly in Tauri (webview)
        try {
            const res = await fetch(`${this.historyUrl}/mls-api/devices/${userId}`);
            if (!res.ok) return null;
            const devices = await res.json();
            if (!devices || devices.length === 0) return null;

            // Just take the latest device key package
            const latest = devices[0]; 
            const base64 = latest.keyPackage;
            const deviceId = latest.deviceId;

             const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
            return { keyPackage: bytes, deviceId };
        } catch (e) {
            console.error("Fetch Key Package Error:", e);
            return null;
        }
    }

    async registerMember(groupId: string, userId: string, deviceId: string): Promise<void> {
        try {
            await fetch(`${this.historyUrl}/mls-api/groups/${groupId}/members`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, deviceId })
            });
        } catch(e) {
            console.error("Failed to register member", e);
        }
    }

    async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
        const base64 = btoa(String.fromCharCode(...keyPackageBytes));
        try {
            await fetch(`${this.historyUrl}/mls-api/register-device`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userId: this.userId,
                    deviceId: this.deviceId,
                    keyPackage: base64
                })
            });
        } catch (e) {
            console.error("Failed to publish KeyPackage", e);
        }
    }

    async sendWelcome(welcomeBytes: Uint8Array, targetUserId: string, groupId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const base64 = btoa(String.fromCharCode(...welcomeBytes));
        
        // Let Delivery Service handle fan-out/routing
        const recipients = [{ userId: targetUserId, deviceId: null }];

        this.ws.send(JSON.stringify({ 
            type: "welcomeMessage", 
            payload: base64, 
            recipients: recipients,
            groupId: groupId
        }));
    }

    async init(userId: string, pin: string, state?: Uint8Array) {
        this.userId = userId;
        const encryptedState = state ? Array.from(state) : null;
        await invoke('initialiser_mls', { userId, pin, encryptedState });
    }

    async createGroup(groupId: string) {
        await invoke('creer_groupe', { groupId });
    }

    async createRemoteGroup(name: string): Promise<string> {
        try {
            const res = await fetch(`${this.historyUrl}/mls-api/groups`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, createdBy: this.userId })
            });
            if (!res.ok) throw new Error("Failed to create remote group");
            const data = await res.json();
            return data.groupId;
        } catch (e) {
            console.error("Failed to create remote group", e);
            throw e;
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
        const result = await invoke<[number[], number[] | null]>('ajouter_membre', { groupId, keyPackageBytes: Array.from(keyPackageBytes) });
        return {
            commit: Uint8Array.from(result[0]),
            welcome: result[1] ? Uint8Array.from(result[1]) : undefined
        };
    }

    async processWelcome(welcomeBytes: Uint8Array) {
        return await invoke<string>('trailer_welcome', { welcomeBytes: Array.from(welcomeBytes) });
    }

    async sendMessage(groupId: string, message: string) {
        const res = await invoke<number[]>('envoyer_message', { groupId, message });
        const encryptedBytes = Uint8Array.from(res);
        const base64 = btoa(String.fromCharCode(...encryptedBytes));
        
        // Send via WebSocket if connected
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "mlsMessage", payload: base64, groupId: groupId }));
        } else {
            console.warn("WebSocket not open, using HTTP fallback");
            try {
                const response = await fetch(`${this.historyUrl}/mls-api/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        senderId: this.userId,
                        senderDeviceId: this.deviceId,
                        content: base64,
                        groupId: groupId
                    })
                });
                if (!response.ok) {
                    throw new Error(`HTTP fallback failed: ${response.statusText}`);
                }
            } catch (e) {
                console.error("Failed to send message via HTTP fallback", e);
                throw e;
            }
        }

        return encryptedBytes;
    }

    async processIncomingMessage(groupId: string, messageBytes: Uint8Array) {
        return await invoke<string | null>('recevoir_message', { groupId, messageBytes: Array.from(messageBytes) });
    }

    async fetchHistory(groupId: string): Promise<{ sender_id: string, content: string, timestamp: string }[]> {
        try {
            const res = await fetch(`${this.historyUrl}/history/${groupId}`);
            if (!res.ok) return [];
            const messages = await res.json();
            return messages;
        } catch (e) {
            console.error("Fetch History Error:", e);
            return [];
        }
    }

}
