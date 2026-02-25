export interface IMlsService {
    init(userId: string, pin: string, state?: Uint8Array): Promise<void>;
    createGroup(groupId: string): Promise<void>;
    saveState(pin: string): Promise<Uint8Array>;
    generateKeyPackage(): Promise<Uint8Array>;
    // Returns the Welcome message bytes if successful (or Commit if you prefer, but for joining we need Welcome)
    // Let's return an object or tuple to be precise, but for this Mock Interface lets return the Welcome bytes if present,
    // otherwise the Commit bytes.
    // Ideally: { commit: Uint8Array, welcome?: Uint8Array }
    // For now, let's change signature to return any or specific object.
    addMember(groupId: string, keyPackageBytes: Uint8Array): Promise<{ commit: Uint8Array, welcome?: Uint8Array }>;
    processWelcome(welcomeBytes: Uint8Array): Promise<string>;
    sendMessage(groupId: string, message: string): Promise<Uint8Array>;
    processIncomingMessage(groupId: string, messageBytes: Uint8Array): Promise<string | null>;
}

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
    private client: any;

    async init(userId: string, pin: string, state?: Uint8Array) {
        // Import dynamique du WASM généré
        try {
            // Import from local lib to ensure Vite handles it correctly
            const initWasm = await import('$lib/wasm/mls_wasm.js'); 
            
            await initWasm.default(); 
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
        // TODO: Update WASM to support encrypted save with PIN
        return this.client.save_state();
    }

    async generateKeyPackage() {
        return this.client.generate_key_package();
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
        return this.client.send_message(groupId, message);
    }

    async processIncomingMessage(groupId: string, messageBytes: Uint8Array) {
        return this.client.process_incoming_message(groupId, messageBytes);
    }
}

// Implémentation pour Tauri (App Mobile/Desktop)
// Note: We use a dynamic import or checks to prevent this from crashing in pure web if invoked eagerly
import { invoke } from '@tauri-apps/api/core';

export class TauriMlsService implements IMlsService {
    async init(userId: string, pin: string, state?: Uint8Array) {
        const encrypted_state = state ? Array.from(state) : null;
        await invoke('initialiser_mls', { user_id: userId, pin, encrypted_state });
    }

    async createGroup(groupId: string) {
        await invoke('creer_groupe', { groupId });
    }

    async saveState(pin: string) {
        // Pass the PIN to the Tauri command
        return await invoke<Uint8Array>('sauvegarder_mls', { pin });
    }

    async generateKeyPackage() {
        return await invoke<Uint8Array>('generer_key_package');
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
        return Uint8Array.from(res);
    }

    async processIncomingMessage(groupId: string, messageBytes: Uint8Array) {
        return await invoke<string | null>('recevoir_message', { groupId, messageBytes: Array.from(messageBytes) });
    }
}