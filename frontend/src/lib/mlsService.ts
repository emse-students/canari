export interface IMlsService {
    createGroup(groupId: string): Promise<void>;
    saveState(): Promise<Uint8Array>;
}

// Implémentation pour le Site Web (WASM)
export class WebMlsService implements IMlsService {
    private client: any;

    async init(userId: string, state?: Uint8Array) {
        // Import dynamique du WASM généré
        const initWasm = await import('./wasm/mls_wasm.js');
        await initWasm.default(); // Initialise la mémoire WASM
        this.client = new initWasm.WasmMlsClient(userId, state);
    }

    async createGroup(groupId: string) {
        this.client.create_group(groupId);
    }

    async saveState() {
        return this.client.save_state();
    }
}

// Implémentation pour Tauri (App Mobile/Desktop)
import { invoke } from '@tauri-apps/api/core';
export class TauriMlsService implements IMlsService {
    async createGroup(groupId: string) {
        await invoke('create_group', { groupId });
    }

    async saveState() {
        return await invoke<Uint8Array>('save_state'); 
    }
}