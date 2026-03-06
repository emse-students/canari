import { invoke } from '@tauri-apps/api/core';
import type { IMlsService } from './IMlsService';

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly

export class TauriMlsService implements IMlsService {
    private ws: WebSocket | null = null;
    private messageCallback: ((senderId: string, content: Uint8Array) => void) | null = null;
    private conversationRequestCallback: ((requesterId: string) => void) | null = null;
    private baseUrl = "http://localhost:3000";
    private historyUrl = "http://localhost:3001";
    private userId: string = "unknown";

    async connect(token: string): Promise<void> {
        // Reuse direct WebSocket logic for now (Tauri allows localhost by default)
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`${this.baseUrl.replace('http', 'ws')}/ws?token=${token}`);
            this.ws.onopen = () => {
                console.log("Connected to Chat Gateway (Tauri)");
                resolve();
            };
            this.ws.onerror = (e) => reject(e);
            this.ws.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    let base64Content: string | null = null;
                    const senderId: string = data.senderId || data.sender_id || "unknown";

                    // Handle conversation requests
                    if (data.type === "conversationRequest" && this.conversationRequestCallback) {
                        const requesterId = data.sender_id; // sender_id = who initiated the request
                        if (this.conversationRequestCallback) {
                             this.conversationRequestCallback(requesterId);
                        }
                        return;
                    }

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
                        this.messageCallback(senderId, bytes);
                    }
                } catch (e) {
                    console.error("Failed to process WebSocket message:", e);
                }
            };
        });
    }

    onMessage(callback: (senderId: string, content: Uint8Array) => void) {
        this.messageCallback = callback;
    }

    onConversationRequest(callback: (requesterId: string) => void) {
        this.conversationRequestCallback = callback;
    }

    async fetchKeyPackage(userId: string): Promise<Uint8Array | null> {
        // Using fetch API directly in Tauri (webview)
        try {
            const res = await fetch(`${this.historyUrl}/mls-api/devices/${userId}`);
            if (!res.ok) return null;
            const devices = await res.json();
            if (!devices || devices.length === 0) return null;

            // Just take the latest device key package
            const latest = devices[0]; 
            const base64 = latest.keyPackage;

             const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
            return bytes;
        } catch (e) {
            console.error("Fetch Key Package Error:", e);
            return null;
        }
    }

    async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const base64 = btoa(String.fromCharCode(...keyPackageBytes));
        this.ws.send(JSON.stringify({ type: "keyPackagePublish", payload: base64 }));
    }

    async sendWelcome(welcomeBytes: Uint8Array, targetUserId: string, groupId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const base64 = btoa(String.fromCharCode(...welcomeBytes));
        
        // Fetch devices for target user to build recipients list
        let recipients = [];
        try {
            const res = await fetch(`${this.historyUrl}/mls-api/devices/${targetUserId}`);
            if (res.ok) {
                 const devices = await res.json();
                 if (devices && devices.length > 0) {
                     recipients = devices.map((d: any) => ({ userId: targetUserId, deviceId: d.deviceId }));
                 }
            }
        } catch (e) {
            console.warn("Failed to fetch devices for welcome message", e);
        }
        
        if (recipients.length === 0) {
            recipients.push({ userId: targetUserId, deviceId: "unknown" });
        }

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
        
        // Send via WebSocket if connected
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const base64 = btoa(String.fromCharCode(...encryptedBytes));
            this.ws.send(JSON.stringify({ type: "mlsMessage", payload: base64, groupId: groupId }));
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

    async requestConversation(targetUserId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn("WebSocket not connected, cannot request conversation");
            return;
        }
        this.ws.send(JSON.stringify({ 
            type: "conversationRequest", 
            targetUserId: targetUserId 
        }));
    }
}
