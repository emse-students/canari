export type { IMlsService } from './services/IMlsService';
import type { IMlsService } from './services/IMlsService';
import { TauriMlsService } from './services/TauriMlsService';
import { WebMlsService } from './services/WebMlsService';

// Synchronous platform detection — no top-level await, no TDZ risk.
// The mlsWasmStub Vite plugin stubs out mlsWasmLoader for TAURI_TARGET builds,
// so the WASM binary is excluded from Tauri bundles even though WebMlsService
// is statically imported here.
const _isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

/** Platform-selected MLS service constructor: resolves to `TauriMlsService` inside Tauri builds and `WebMlsService` in the browser/PWA. */
export const MlsService: new () => IMlsService = _isTauri ? TauriMlsService : WebMlsService;
