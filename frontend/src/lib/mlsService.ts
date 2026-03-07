export type { IMlsService } from './services/IMlsService';
export { WebMlsService } from './services/WebMlsService';
export { TauriMlsService } from './services/TauriMlsService';

// Factory to automatically pick the right implementation
import { WebMlsService } from './services/WebMlsService';
import { TauriMlsService } from './services/TauriMlsService';
import type { IMlsService } from './services/IMlsService';

export function createMlsService(): IMlsService {
    // Basic detection for Tauri environment
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
        console.log("Detecting Tauri environment -> Using TauriMlsService");
        return new TauriMlsService();
    }
    console.log("Detecting Web environment -> Using WebMlsService");
    return new WebMlsService();
}
