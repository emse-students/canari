import type { IMlsService } from '$lib/mls-client';
import { TauriMlsService } from './services/TauriMlsService';

/**
 * THE NATIVE HALF OF THE SEAM DESCRIBED IN `mlsServicePlatform.ts`, WHICH IS WHERE THE REASONING IS.
 *
 * Nothing imports this file by name. `platformMlsService()` in `vite.config.js` resolves every
 * import of `mlsServicePlatform` here when the build is a native one - Android and desktop through
 * `TAURI_ENV_PLATFORM`, which the Tauri CLI sets for its `beforeBuildCommand`, and iOS through the
 * `TAURI_TARGET` its workflow sets by hand. Keep the two files' exports identical: the gate
 * `scripts/check-platform-service.mjs` asserts a build carries exactly one of them, and nothing
 * else would notice a name that only exists on one side.
 */
export const MLS_PLATFORM = 'canari-mls-platform:native';

/** The MLS implementation this build ships - `TauriMlsService` here, `WebMlsService` on the web. */
export const MlsService: new () => IMlsService = TauriMlsService;
