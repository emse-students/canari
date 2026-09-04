import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Which runtimes carry their own refresh credential.
 *
 * TWO FACTS DECIDE IT, AND THEY ARE DIFFERENT FACTS. The document's SCHEME says whether the ENGINE
 * can keep a third-party cookie at all - `tauri:` is WKWebView, which refuses the class outright.
 * The API's scheme says whether the SERVER can issue one this context would accept: `SameSite=None`
 * needs `Secure`, `Secure` needs TLS, and a `Lax` cookie cannot be SET third-party. Neither is the
 * user agent, where the platform would be a consequence standing in for the cause.
 *
 * Both are exactly what the server decides from - the request `Origin` and `ALLOW_INSECURE_COOKIES`
 * - so the two sides compute one answer from one pair of facts. The twin is
 * `usesBodyRefreshTransport(origin, thirdPartyCookieIsIssuable)` in
 * `apps/core-service/src/auth/refresh-transport.ts`.
 */

const isTauriRuntime = vi.fn(() => true);
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => isTauriRuntime() }));

const coreUrl = vi.fn(() => 'https://canari-emse.fr');
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => coreUrl() }));

const { usesBodyRefreshTransport } = await import('$lib/stores/nativeRefreshToken');

/** Puts the document on a scheme, the way each platform's WebView serves the app. */
function servedOver(protocol: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, protocol, href: `${protocol}//tauri.localhost/` },
    writable: true,
    configurable: true,
  });
}

/** The estate this build talks to. HTTPS is production and dev; HTTP is the local stack. */
function apiAt(origin: string) {
  coreUrl.mockReturnValue(origin);
}

afterEach(() => {
  isTauriRuntime.mockReturnValue(true);
  apiAt('https://canari-emse.fr');
});

describe('usesBodyRefreshTransport', () => {
  it('is true on the custom scheme - iOS, macOS and a Linux desktop build - whatever the estate', () => {
    // WKWebView blocks the third-party class through ITP and publishes no opt-in, so no server-side
    // cookie attribute can rescue it. This answer must not become conditional on the deployment.
    servedOver('tauri:');
    apiAt('https://canari-emse.fr');
    expect(usesBodyRefreshTransport()).toBe(true);
    apiAt('http://localhost:8081');
    expect(usesBodyRefreshTransport()).toBe(true);
  });

  it('is FALSE on http(s) against an HTTPS API - Android and Windows, whose cookie is proven', () => {
    // WP-ANDROID-SESS-1 verified that durability on hardware, and A1 re-confirmed it across an
    // `am force-stop` on 2026-08-27. Production and dev are HTTPS, so this is the branch they take
    // and nothing proven on hardware is re-decided.
    apiAt('https://canari-emse.fr');
    servedOver('http:');
    expect(usesBodyRefreshTransport()).toBe(false);
    servedOver('https:');
    expect(usesBodyRefreshTransport()).toBe(false);
  });

  it('is TRUE on http(s) against a PLAIN-HTTP API, because no cookie can be set third-party there', () => {
    // The half that was missing until 2026-09-04. Over plain HTTP the only cookie available is
    // `SameSite=Lax`, and a `Lax` cookie cannot be SET in a third-party context - the shell discards
    // it on arrival. Measured on the local estate: the phone held 0 matching cookies against a
    // browser's 3, the server logged `cookies=[]`, and the device logged itself out before it had
    // published a key package, blocking every phone row of the campaign.
    apiAt('http://localhost:8081');
    servedOver('http:');
    expect(usesBodyRefreshTransport()).toBe(true);
    servedOver('https:');
    expect(usesBodyRefreshTransport()).toBe(true);
  });

  it('is false on the web whatever the scheme, because there is no native store to write to', () => {
    isTauriRuntime.mockReturnValue(false);
    servedOver('tauri:');
    expect(usesBodyRefreshTransport()).toBe(false);
    apiAt('http://localhost:8081');
    servedOver('http:');
    expect(usesBodyRefreshTransport()).toBe(false);
  });
});
