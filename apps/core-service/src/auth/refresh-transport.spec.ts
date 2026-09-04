/// <reference types="jest" />

import { TAURI_WEBVIEW_ORIGINS } from '../cors-origins';
import {
  BODY_TRANSPORT_ORIGINS,
  REFRESH_HEADER,
  THIRD_PARTY_SHELL_ORIGINS,
  usesBodyRefreshTransport,
} from './refresh-transport';

/**
 * The two deployments, named rather than spelled as a bare boolean at forty call sites.
 *
 * `ISSUES_COOKIE` is production and `dev.canari-emse.fr`: HTTPS, so `setRefreshCookie` writes
 * `SameSite=None; Secure`, which a third-party context accepts. `CANNOT` is a stack on plain HTTP,
 * where the only cookie available is `SameSite=Lax` - and that one cannot be SET third-party at all.
 */
const ISSUES_COOKIE = true;
const CANNOT = false;

/**
 * Which clients carry their refresh credential themselves.
 *
 * The list is tiny and every entry is a decision, so each one is named individually below: a test
 * that loops over the list under test passes just as happily when an entry is added to it, and an
 * entry added here hands a refresh token to a new population.
 */
describe('the refresh transport', () => {
  it('is the body/header for the custom-scheme WebView origin, on EVERY deployment', () => {
    // WKWebView refuses the third-party class through ITP and publishes no opt-in, so no cookie
    // attribute can rescue it. This one does not depend on the deployment and must not start to.
    expect(usesBodyRefreshTransport('tauri://localhost', ISSUES_COOKIE)).toBe(true);
    expect(usesBodyRefreshTransport('tauri://localhost', CANNOT)).toBe(true);
  });

  it('is the COOKIE for Android and Windows wherever one can be issued - proven, and must not move', () => {
    // `setAcceptThirdPartyCookies` works there and WP-ANDROID-SESS-1 verified the durability on
    // hardware. Production is HTTPS, so this is the branch it takes; routing it through the header
    // would unprove all of it.
    expect(usesBodyRefreshTransport('http://tauri.localhost', ISSUES_COOKIE)).toBe(false);
    expect(usesBodyRefreshTransport('https://tauri.localhost', ISSUES_COOKIE)).toBe(false);
  });

  it('is the body/header for those same origins when the deployment CANNOT issue the cookie', () => {
    // The half that was missing until 2026-09-04. On a plain-HTTP stack the cookie is `SameSite=Lax`
    // - `None` needs `Secure`, `Secure` needs TLS - and a `Lax` cookie cannot be SET third-party, so
    // the shell discards it on arrival. Measured on the local estate: 0 matching cookies on the
    // phone against 3 in a browser, `cookies=[]` in the server log, and three `auth_sessions` rows
    // created and never used again. The device logged itself out before publishing a key package.
    expect(usesBodyRefreshTransport('http://tauri.localhost', CANNOT)).toBe(true);
    expect(usesBodyRefreshTransport('https://tauri.localhost', CANNOT)).toBe(true);
  });

  it('is the cookie for the web on BOTH deployments, where HttpOnly is a real protection', () => {
    // The web app is SAME-site with its API - it is served by the same nginx - so it has no
    // third-party problem to solve and must never be handed a token in a body it can read.
    expect(usesBodyRefreshTransport('https://canari-emse.fr', ISSUES_COOKIE)).toBe(false);
    expect(usesBodyRefreshTransport('http://localhost:5173', ISSUES_COOKIE)).toBe(false);
    expect(usesBodyRefreshTransport('https://canari-emse.fr', CANNOT)).toBe(false);
    expect(usesBodyRefreshTransport('http://localhost:5173', CANNOT)).toBe(false);
  });

  it('is the cookie when there is no Origin at all, on either deployment', () => {
    // A request with no origin is not a browser document, so it has no cookie problem to solve.
    // Answering otherwise would hand a refresh token in the body to anything that omits the header.
    expect(usesBodyRefreshTransport(undefined, ISSUES_COOKIE)).toBe(false);
    expect(usesBodyRefreshTransport('', ISSUES_COOKIE)).toBe(false);
    expect(usesBodyRefreshTransport(undefined, CANNOT)).toBe(false);
    expect(usesBodyRefreshTransport('', CANNOT)).toBe(false);
  });

  it('is not granted by a lookalike origin, and least of all on the permissive deployment', () => {
    // `CANNOT` is the branch that says yes to more origins, so it is the one a lookalike would try.
    for (const issuable of [ISSUES_COOKIE, CANNOT]) {
      expect(usesBodyRefreshTransport('tauri://localhost.evil.com', issuable)).toBe(false);
      expect(usesBodyRefreshTransport('tauri://evil', issuable)).toBe(false);
      expect(usesBodyRefreshTransport('https://tauri.localhost.evil.com', issuable)).toBe(false);
      expect(usesBodyRefreshTransport('http://tauri.localhost.evil.com', issuable)).toBe(false);
      expect(usesBodyRefreshTransport('http://tauri.localhost:9999', issuable)).toBe(false);
    }
  });

  it('names exactly one engine-bound origin and two deployment-bound ones, so growing either is deliberate', () => {
    expect(BODY_TRANSPORT_ORIGINS).toHaveLength(1);
    expect(THIRD_PARTY_SHELL_ORIGINS).toHaveLength(2);
  });

  it('only names origins CORS already allows - a refused origin never reaches this decision', () => {
    for (const origin of [...BODY_TRANSPORT_ORIGINS, ...THIRD_PARTY_SHELL_ORIGINS]) {
      expect(TAURI_WEBVIEW_ORIGINS as readonly string[]).toContain(origin);
    }
  });

  it('carries the credential in a lowercase header name, as Express reads them', () => {
    expect(REFRESH_HEADER).toBe(REFRESH_HEADER.toLowerCase());
  });
});
