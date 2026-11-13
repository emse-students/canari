import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import {
  buildAllowedOrigins,
  corsOptions,
  isEdgeOwnedCorsPath,
  CORS_PREFLIGHT_MAX_AGE_S,
  isAllowedOrigin,
  TAURI_WEBVIEW_ORIGINS,
} from './cors-origins';

/** The options the delegate hands `cors` for an ordinary credentialed request. */
function optionsFor(allowed: Set<string>, exposed: string[] = []) {
  let out: CorsOptions | undefined;
  corsOptions(allowed, exposed)({ originalUrl: '/api/messages' }, (_err, options) => {
    out = options as CorsOptions;
  });
  return out as CorsOptions;
}

/**
 * Guards the allowlist against the way it broke: a client platform whose origin nobody wrote down.
 * The `tauri://localhost` case is iOS, and its absence cost a whole platform its login - the
 * preflight fell through to a 404 and WebKit reported only "Load failed" (prod, 2026-08-27).
 */
describe('cors-origins', () => {
  const allowed = buildAllowedOrigins('https://canari-emse.fr/');

  it('accepts every Tauri WebView origin, on every platform', () => {
    // Named individually and not looped over the constant: a loop over the list under test passes
    // just as happily when a platform is deleted from it, which is exactly the defect here.
    expect(isAllowedOrigin('http://tauri.localhost', allowed)).toBe(true);
    expect(isAllowedOrigin('https://tauri.localhost', allowed)).toBe(true);
    expect(isAllowedOrigin('tauri://localhost', allowed)).toBe(true);
    expect(TAURI_WEBVIEW_ORIGINS).toHaveLength(3);
  });

  it('accepts the deployed frontend, trailing slash stripped', () => {
    expect(isAllowedOrigin('https://canari-emse.fr', allowed)).toBe(true);
  });

  it('accepts no loopback origin the estate does not name', () => {
    // What production builds: FRONTEND_URL alone, no estate list.
    for (const origin of [
      'http://localhost:1420',
      'http://127.0.0.1:1420',
      'http://localhost',
      'https://127.0.0.1',
      'http://localhost:8081',
      'http://[::1]:1420',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
    ]) {
      expect([origin, isAllowedOrigin(origin, allowed)]).toEqual([origin, false]);
    }
  });

  it('accepts the loopback origins an estate lists, exactly as listed', () => {
    // What the local and dev estates build: their ALLOW_ORIGIN names the dev-server pair.
    const dev = buildAllowedOrigins(
      'https://dev.example',
      'https://dev.example,http://localhost:1420, http://127.0.0.1:1420/,,*'
    );
    expect(isAllowedOrigin('http://localhost:1420', dev)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:1420', dev)).toBe(true);
    expect(isAllowedOrigin('https://dev.example', dev)).toBe(true);
    // Another port, another scheme or no port is another origin.
    expect(isAllowedOrigin('http://localhost:1421', dev)).toBe(false);
    expect(isAllowedOrigin('https://localhost:1420', dev)).toBe(false);
    expect(isAllowedOrigin('http://localhost', dev)).toBe(false);
    // A wildcard segment is never a list.
    expect(isAllowedOrigin('https://evil.example', dev)).toBe(false);
    expect(dev.has('')).toBe(false);
    expect(dev.has('*')).toBe(false);
    expect(buildAllowedOrigins('*', ' * ').has('*')).toBe(false);
  });

  it('treats a missing Origin as nothing to refuse', () => {
    // Server-to-server, curl, health checks: no browser, so no cross-origin read to protect.
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it('refuses an unknown origin, and the opaque "null" among them', () => {
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    // A sandboxed iframe or a data: URL serialises its origin as the literal "null". Allowing it
    // to read credentialed responses would hand them to any page that can frame anything.
    expect(isAllowedOrigin('null', allowed)).toBe(false);
  });

  it('works with no FRONTEND_URL set', () => {
    const bare = buildAllowedOrigins(undefined);
    expect(isAllowedOrigin('tauri://localhost', bare)).toBe(true);
    expect(isAllowedOrigin('https://canari-emse.fr', bare)).toBe(false);
  });

  it('accepts every origin in a comma-separated FRONTEND_URL', () => {
    // The same idiom chat-gateway's ALLOW_ORIGIN already uses - both hosts claimed during the
    // canari-emse.fr -> canari.emse.fr migration are one client, presenting either origin.
    const both = buildAllowedOrigins('https://canari-emse.fr/, https://canari.emse.fr/');
    expect(isAllowedOrigin('https://canari-emse.fr', both)).toBe(true);
    expect(isAllowedOrigin('https://canari.emse.fr', both)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', both)).toBe(false);
  });

  it('drops blank segments from FRONTEND_URL, so a trailing comma is not an error', () => {
    const trailing = buildAllowedOrigins('https://canari-emse.fr/,');
    expect(isAllowedOrigin('https://canari-emse.fr', trailing)).toBe(true);
    expect(trailing.has('')).toBe(false);
  });

  // A Bearer read from the phone apps preflights `authorization`; a `*` answer does not cover it.
  it('names back the preflight headers rather than a wildcard, and caches the preflight', () => {
    const options = optionsFor(allowed, ['X-Exposed']);
    expect(options.allowedHeaders).toBeUndefined();
    expect(options.maxAge).toBe(CORS_PREFLIGHT_MAX_AGE_S);
    expect(options.credentials).toBe(true);
    expect(options.exposedHeaders).toEqual(['X-Exposed']);
    expect(optionsFor(allowed)).not.toHaveProperty('exposedHeaders');
  });

  it('skips the denial log only for a clean edge-owned path', () => {
    expect(isEdgeOwnedCorsPath('/api/public/associations')).toBe(true);
    expect(isEdgeOwnedCorsPath('/api/public/../posts')).toBe(false);
    expect(isEdgeOwnedCorsPath('/api/public/%2e%2e/posts')).toBe(false);
    expect(isEdgeOwnedCorsPath('/api/public%2fx')).toBe(false);
    expect(isEdgeOwnedCorsPath('/api/public/a\\b')).toBe(false);
  });
});
