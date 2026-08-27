import { buildAllowedOrigins, isAllowedOrigin, TAURI_WEBVIEW_ORIGINS } from './cors-origins';

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

  it('accepts http(s) loopback on any port, and no others', () => {
    expect(isAllowedOrigin('http://localhost:1420', allowed)).toBe(true);
    expect(isAllowedOrigin('https://127.0.0.1', allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost.evil.com', allowed)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.evil.com', allowed)).toBe(false);
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
});
