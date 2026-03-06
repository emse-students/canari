export interface IMlsService {
    init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
    createGroup(groupId: string): Promise<void>;
    saveState(pin: string): Promise<Uint8Array>;
    generateKeyPackage(pin: string): Promise<Uint8Array>;
    addMember(groupId: string, keyPackageBytes: Uint8Array): Promise<{ commit: Uint8Array, welcome?: Uint8Array }>;
    processWelcome(welcomeBytes: Uint8Array): Promise<string>;
    sendMessage(groupId: string, message: string): Promise<Uint8Array>;
    processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<string | null>;
    
    // Networking
    connect(token: string): Promise<void>;
    fetchKeyPackage(userId: string): Promise<Uint8Array | null>;
    publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
    sendWelcome(welcomeBytes: Uint8Array, targetUserId: string): Promise<void>;
    requestConversation(targetUserId: string): Promise<void>;
    fetchHistory(groupId: string): Promise<{ sender_id: string, content: string, timestamp: string }[]>;
    
    // Callbacks
    onMessage(callback: (senderId: string, content: Uint8Array) => void): void;
    onConversationRequest(callback: (requesterId: string) => void): void;
}

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
    private client: any;
    private ws: WebSocket | null = null;
    private messageCallback: ((senderId: string, content: Uint8Array) => void) | null = null;
    private conversationRequestCallback: ((requesterId: string) => void) | null = null;
    private baseUrl = "http://localhost:3000"; // Chat Gateway URL
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
                        this.conversationRequestCallback(requesterId);
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
            const res = await fetch(`${this.baseUrl}/keys/${userId}`);
            if (!res.ok) return null;
            const base64 = await res.text();
            
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn("WebSocket not connected, cannot publish KeyPackage");
            return;
        }
        const base64 = btoa(String.fromCharCode(...keyPackageBytes));
        this.ws.send(JSON.stringify({ type: "keyPackagePublish", payload: base64 }));
    }

    async sendWelcome(welcomeBytes: Uint8Array, targetUserId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn("WebSocket not connected, cannot send Welcome");
            return;
        }
        const base64 = btoa(String.fromCharCode(...welcomeBytes));
        this.ws.send(JSON.stringify({ 
            type: "mlsWelcome", 
            payload: base64, 
            targetUserId: targetUserId 
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
            
            const hex = Array.from(stateBytes as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('');
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
            const res = await fetch(`${this.baseUrl}/history/${groupId}`);
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

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly
import { invoke } from '@tauri-apps/api/core';

export class TauriMlsService implements IMlsService {
    private ws: WebSocket | null = null;
    private messageCallback: ((senderId: string, content: Uint8Array) => void) | null = null;
    private conversationRequestCallback: ((requesterId: string) => void) | null = null;
    private baseUrl = "http://localhost:3000";
    private userId: string = "unknown";

    async connect(token: string): Promise<void> {
        // Reuse direct WebSocket logic for now (Tauri allows localhost by default)
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);
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
                        this.conversationRequestCallback(requesterId);
                        return;
                    }

                    // Filter out own messages (avoid echo from server broadcast)
                    // Always drop messages where WE are the sender — no type check needed
                    if (senderId === this.userId) {
                        console.debug(`Filtering out own message echo`);
                        return;
                    }

                    if (data.type === "mlsWelcome" && data.content) {
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
            const res = await fetch(`${this.baseUrl}/keys/${userId}`);
            if (!res.ok) return null;
            const base64 = await res.text();
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

    async sendWelcome(welcomeBytes: Uint8Array, targetUserId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const base64 = btoa(String.fromCharCode(...welcomeBytes));
        this.ws.send(JSON.stringify({ 
            type: "mlsWelcome", 
            payload: base64, 
            targetUserId: targetUserId 
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
            const res = await fetch(`http://localhost:3000/history/${groupId}`);
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