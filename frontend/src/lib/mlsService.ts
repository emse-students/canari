export type { IMlsService } from '$lib/mls-client';
import type { IMlsService } from '$lib/mls-client';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { MLS_PLATFORM, MlsService } from './mlsServicePlatform';

export { MlsService };

/**
 * Refuses to build an MLS service when the bundle and the runtime disagree about the platform.
 *
 * The implementation is chosen when the bundle is BUILT (see `mlsServicePlatform.ts`), so this is
 * the one thing that could go wrong and could not go wrong before: a Tauri shell pointed at a dev
 * server started outside the Tauri CLI loads the WEB bundle, and a web page served by a native
 * build is not reachable at all. The first case is a real development corner, and half-working is
 * the worst thing it could do - `TauriMlsService` would call commands that are not there, or
 * `WebMlsService` would keep a second, divergent MLS state beside the native one.
 *
 * It ACCUSES rather than adapting. Falling back to the other implementation is exactly the fallback
 * path this repository forbids: reaching it would mean the build that is running is not the build
 * that should be, and the fix belongs in whatever produced it.
 *
 * @param platform The platform token compiled into this bundle.
 * @param native Whether the page is running inside a Tauri webview. Injectable for tests.
 * @throws When a native bundle is running in a browser, or a web bundle inside Tauri.
 */
export function assertPlatformMatchesRuntime(
  platform: string = MLS_PLATFORM,
  native: boolean = isTauriRuntime()
): void {
  const builtForNative = platform.endsWith(':native');
  if (builtForNative === native) return;
  throw new Error(
    builtForNative
      ? '[MLS] this bundle was built for Tauri and is running in a plain browser - serve the web build, or start the app through the Tauri CLI so the dev server is built for it'
      : '[MLS] this bundle was built for the web and is running inside Tauri - start the app through the Tauri CLI rather than pointing it at a dev server started separately'
  );
}

/**
 * Builds the MLS service this platform can actually run.
 *
 * The ONE place an instance is made, so the platform check cannot be skipped by a later call site
 * that constructs the class directly.
 */
export function createMlsService(): IMlsService {
  assertPlatformMatchesRuntime();
  return new MlsService();
}
