import { describe, it, expect } from 'vitest';
import { assertPlatformMatchesRuntime } from './mlsService';
import { MLS_PLATFORM } from './mlsServicePlatform';

/**
 * THE ONE THING A BUILD-TIME CHOICE CAN GET WRONG.
 *
 * The implementation is picked when the bundle is built, so no page can pick the wrong one - except
 * in the development corner where a Tauri shell loads a dev server that was not started through the
 * Tauri CLI. What matters there is that it says so rather than half-working: a native bundle in a
 * browser would call commands that do not exist, and a web bundle inside Tauri would open a second
 * MLS state beside the native one and diverge from it silently.
 */
describe('the platform a bundle was built for, against the runtime it finds', () => {
  it('says nothing when a web bundle runs in a browser', () => {
    expect(() => assertPlatformMatchesRuntime('canari-mls-platform:web', false)).not.toThrow();
  });

  it('says nothing when a native bundle runs inside Tauri', () => {
    expect(() => assertPlatformMatchesRuntime('canari-mls-platform:native', true)).not.toThrow();
  });

  it('refuses a native bundle running in a plain browser', () => {
    expect(() => assertPlatformMatchesRuntime('canari-mls-platform:native', false)).toThrow(
      /built for Tauri and is running in a plain browser/
    );
  });

  it('refuses a web bundle running inside Tauri', () => {
    expect(() => assertPlatformMatchesRuntime('canari-mls-platform:web', true)).toThrow(
      /built for the web and is running inside Tauri/
    );
  });

  it('is the WEB half under vitest, which is the file TypeScript and the dev server see', () => {
    // The native half is substituted by resolution, in native builds only - so a test run, a
    // `svelte-check` and `bun run dev` all read this one. If this ever flips, the seam has been
    // rewired into something that changes the source under the type checker's feet.
    expect(MLS_PLATFORM).toBe('canari-mls-platform:web');
  });
});
