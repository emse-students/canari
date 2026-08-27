import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Which runtimes carry their own refresh credential.
 *
 * The answer is the document's SCHEME, because that is what makes the backend's cookie third-party
 * in the first place - not the user agent, where the platform would be a consequence standing in for
 * the cause. It is also exactly what the server sees as the request `Origin`, so both sides decide
 * from one fact: the twin is `usesBodyRefreshTransport()` in
 * `apps/core-service/src/auth/refresh-transport.ts`.
 */

const isTauriRuntime = vi.fn(() => true);
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => isTauriRuntime() }));

const { usesBodyRefreshTransport } = await import('$lib/stores/nativeRefreshToken');

/** Puts the document on a scheme, the way each platform's WebView serves the app. */
function servedOver(protocol: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, protocol },
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  isTauriRuntime.mockReturnValue(true);
});

describe('usesBodyRefreshTransport', () => {
  it('is true on the custom scheme - iOS, macOS and the Linux AppImage', () => {
    servedOver('tauri:');
    expect(usesBodyRefreshTransport()).toBe(true);
  });

  it('is FALSE on http(s), which is Android and Windows - their cookie works and is proven', () => {
    // WP-ANDROID-SESS-1 verified that durability on hardware, and A1 re-confirmed it across an
    // `am force-stop` on 2026-08-27. Taking this path there would unprove all of it.
    servedOver('http:');
    expect(usesBodyRefreshTransport()).toBe(false);
    servedOver('https:');
    expect(usesBodyRefreshTransport()).toBe(false);
  });

  it('is false on the web whatever the scheme, because there is no native store to write to', () => {
    isTauriRuntime.mockReturnValue(false);
    servedOver('tauri:');
    expect(usesBodyRefreshTransport()).toBe(false);
  });
});
