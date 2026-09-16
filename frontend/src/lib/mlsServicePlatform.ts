import type { IMlsService } from '$lib/mls-client';
import { WebMlsService } from './services/WebMlsService';

/**
 * THE WEB IMPLEMENTATION, AND THE FILE A NATIVE BUILD SUBSTITUTES.
 *
 * Which MLS implementation can run is decided by the BUILD, not by the page: a browser can never
 * run `TauriMlsService` (it needs the Rust side of the app) and a Tauri build can never run
 * `WebMlsService` (its WASM loader is stubbed out at build time). Until 2026-09-16 both were
 * statically imported and a runtime ternary picked one, so every web bundle carried an
 * implementation no browser could execute and every native build carried the other - parsed and
 * evaluated on every boot, for nothing.
 *
 * So this module is the SEAM. It is the web half and the default, because the default build
 * (`bun run dev`, `vite build` with no Tauri environment) is the one a browser loads. A native
 * build - `tauri android build`, `tauri build`, or the iOS workflow's `TAURI_TARGET=... bun run
 * build` - is resolved by `platformMlsService()` in `vite.config.js` to `mlsServicePlatform.native`
 * instead, and the two files export the same two names.
 *
 * {@link assertPlatformMatchesRuntime} is what makes the substitution safe to reason about: if the
 * bundle a page is running ever disagrees with the runtime it finds itself in, it says so loudly
 * rather than half-working.
 */
export const MLS_PLATFORM = 'canari-mls-platform:web';

/** The MLS implementation this build ships - `WebMlsService` here, `TauriMlsService` in a native build. */
export const MlsService: new () => IMlsService = WebMlsService;
