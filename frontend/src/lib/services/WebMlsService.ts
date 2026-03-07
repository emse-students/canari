import type { IMlsService } from './IMlsService';

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
    private client: any;
    private ws: WebSocket | null = null;
    private messageCallback: ((senderId: string, content: Uint8Array, groupId?: string) => void) | null = null;
    private baseUrl = "http://localhost:3000"; // Chat Gateway URL
    private historyUrl = "http://localhost:3001"; // Chat History Service URL
    private userId: string = "unknown";
    private deviceId: string;

    constructor() {
        // Ensure stable Device ID across sessions
        const stored = localStorage.getItem("mls_device_id");
        if (stored) {
            this.deviceId = stored;
        } else {
            this.deviceId = "web-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
            localStorage.setItem("mls_device_id", this.deviceId);
        }
    }

    async connect(token: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`${this.baseUrl.replace('http', 'ws')}/ws?token=${token}&device_id=${this.deviceId}`);
            this.ws.onopen = async () => {
                console.log("Connected to Chat Gateway with DeviceID:", this.deviceId);
                await this.fetchPendingMessages();
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
                        const groupId = data.groupId || data.session_id; // Support both legacy and new
                        this.messageCallback(senderId, bytes, groupId);
                    }
                } catch (e) {
                    console.error("Failed to process WebSocket message:", e);
                }
            };
        });
    }

    onMessage(callback: (senderId: string, content: Uint8Array, groupId?: string) => void) {
        this.messageCallback = callback;
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

    async fetchKeyPackage(userId: string): Promise<{ keyPackage: Uint8Array, deviceId: string } | null> {
        try {
            // Fetch from Chat History Service (delivery service)
            const res = await fetch(`${this.historyUrl}/mls-api/devices/${userId}`);
            if (!res.ok) return null;
            const devices = await res.json();
            if (!devices || devices.length === 0) return null;
            
            // Just take the latest device key package
            const latest = devices[0]; 
            const base64 = latest.keyPackage;
            const deviceId = latest.deviceId;
            
            // Decode Base64
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
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
        // Publish to Chat History Service (delivery service)
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn("WebSocket not connected, cannot send Welcome");
            return;
        }
        const base64 = btoa(String.fromCharCode(...welcomeBytes));
        
        // Let Delivery Service handle fan-out/routing
        const recipients = [{ userId: targetUserId, deviceId: null }];

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
        
        await this.publishKeyPackage(kp as Uint8Array);

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
        const base64 = btoa(String.fromCharCode(...encryptedBytes));
        
        // Send via WebSocket if connected
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = {
                type: "mlsMessage",
                payload: base64,
                groupId: groupId
            };
            this.ws.send(JSON.stringify(payload));
        } else {
            // Fallback: Send via HTTP to History Service (Delivery)
            console.warn("WebSocket not connected. Sending via HTTP fallback...");
            try {
                await fetch(`${this.historyUrl}/mls-api/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        senderId: this.userId,
                        senderDeviceId: this.deviceId,
                        content: base64,
                        groupId: groupId
                    })
                });
            } catch (e) {
                console.error("HTTP Send failed:", e);
                // Throw error so UI knows it failed?
                // But encryptedBytes is returned... UI might think it succeeded.
                throw e; 
            }
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
    getDeviceId(): string {
        return this.deviceId;
    }
}
