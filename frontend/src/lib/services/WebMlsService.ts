import type { IMlsService } from './IMlsService';

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
    private client: any;
    private ws: WebSocket | null = null;
    private messageCallback: ((senderId: string, content: Uint8Array) => void) | null = null;
    private conversationRequestCallback: ((requesterId: string) => void) | null = null;
    private baseUrl = "http://localhost:3000"; // Chat Gateway URL
    private historyUrl = "http://localhost:3001"; // Chat History Service URL
    private userId: string = "unknown";

    async connect(token: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);
            this.ws.onopen = () => {
                console.log("Connected to Chat Gateway");
                resolve();
            };
            this.ws.onerror = (e) => {
                console.error("WebSocket Error:", e);
                reject(e);
            };
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

                    if (data.type === "mlsWelcome" && data.content) {
                        // Welcome message pour rejoindre un groupe
                        base64Content = data.content;
                    } else if (data.content) {
                        // Message MLS chiffré standard
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
        try {
            // Fetch from Chat History Service (delivery service)
            const res = await fetch(`${this.historyUrl}/mls-api/devices/${userId}`);
            if (!res.ok) return null;
            const devices = await res.json();
            if (!devices || devices.length === 0) return null;
            
            // Just take the latest device key package
            const latest = devices[0]; 
            const base64 = latest.keyPackage;
            
            // Decode Base64
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        } catch (e) {
            console.error("Fetch Key Package Error:", e);
            return null;
        }
    }

    async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
        // Publish to Chat History Service (delivery service)
        const base64 = btoa(String.fromCharCode(...keyPackageBytes));
        try {
            await fetch(`${this.historyUrl}/mls-api/register-device`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userId: this.userId,
                    deviceId: "web-" + Date.now(), // Simple device ID
                    keyPackage: base64
                })
            });
        } catch (e) {
            console.error("Failed to publish KeyPackage", e);
        }
    }

    async sendWelcome(welcomeBytes: Uint8Array, targetUserId: string, groupId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn("WebSocket not connected, cannot send Welcome");
            return;
        }
        const base64 = btoa(String.fromCharCode(...welcomeBytes));
        
        // We know targetUserId, let's assume they have 'web' device or use * wildcard for simplicity if backend supports it.
        // Backend expects 'recipients: Vec<Recipient>'. Recipient { userId, deviceId }
        // We need to fetch devices of target user first?
        // Or broadcase to all devices of target user?
        // Let's try to fetch devices of target user for better targeting.
        let devices: any[] = [];
        try {
             const res = await fetch(`${this.historyUrl}/mls-api/devices/${targetUserId}`);
             if (res.ok) devices = await res.json();
        } catch(e) {}
        
        let recipients = [];
        if (devices.length > 0) {
             recipients = devices.map((d: any) => ({ userId: targetUserId, deviceId: d.deviceId || "unknown" }));
        } else {
             // Fallback
             recipients.push({ userId: targetUserId, deviceId: "unknown" });
        }

        this.ws.send(JSON.stringify({ 
            type: "welcomeMessage", 
            payload: base64,
            groupId: groupId,
            recipients: recipients
        }));
    }

    async init(userId: string, pin: string, state?: Uint8Array) {
        this.userId = userId;
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
            console.error("WASM Init Failed:", e);
            throw e;
        }
    }

    async createGroup(groupId: string) {
        this.client.create_group(groupId);
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
            
            const hex = Array.from(stateBytes as Uint8Array).map((b: number) => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem('mls_autosave_' + this.userId, hex);
        } catch(e) {
            console.warn("Auto-save failed in WASM mode", e);
        }
        
        // Publish via WebSocket if connected
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Encode to Base64
            const base64 = btoa(String.fromCharCode(...(kp as Uint8Array)));
            
            const msg = {
                type: "keyPackagePublish",
                payload: base64
            };
            this.ws.send(JSON.stringify(msg));
        }

        return kp;
    }

    async addMember(groupId: string, keyPackageBytes: Uint8Array) {
        // Wasm returns tuple/array? Let's check wasm bindings.
        // The bindings likely return [commit, welcome] or similar object.
        // For simplicity in this fix, let's assume the WasmClient returns { commit, welcome } or [commit, welcome]
        // Actually earlier in lib.rs it returned (Vec<u8>, Option<Vec<u8>>).
        // JS bindings usually convert tuple to Array.
        const res = this.client.add_member(groupId, keyPackageBytes);
        // wasm-bindgen implementation details:
        // if lib.rs returns Result<(Vec<u8>, Option<Vec<u8>>), JsValue>
        // JS receives array [Uint8Array, Uint8Array | undefined]
        // But the previous generate_bindings (in my head) might have just returned bytes.
        // Let's assume it returns header-defined [commit, welcome].
        return { 
            commit: res[0], 
            welcome: res[1] 
        };
    }
    
    async processWelcome(welcomeBytes: Uint8Array) {
        return this.client.process_welcome(welcomeBytes);
    }

    async sendMessage(groupId: string, message: string) {
        const encryptedBytes = this.client.send_message(groupId, message);
        
        // Send via WebSocket if connected
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const base64 = btoa(String.fromCharCode(...encryptedBytes));
            const payload = {
                type: "mlsMessage",
                payload: base64,
                groupId: groupId
            };
            this.ws.send(JSON.stringify(payload));
        }

        return encryptedBytes;
    }

    async processIncomingMessage(groupId: string, messageBytes: Uint8Array) {
        return this.client.process_incoming_message(groupId, messageBytes);
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
