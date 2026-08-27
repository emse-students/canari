/// <reference types="jest" />

import { TAURI_WEBVIEW_ORIGINS } from '../cors-origins';
import {
  BODY_TRANSPORT_ORIGINS,
  REFRESH_HEADER,
  usesBodyRefreshTransport,
} from './refresh-transport';

/**
 * Which clients carry their refresh credential themselves.
 *
 * The list is tiny and every entry is a decision, so each one is named individually below: a test
 * that loops over the list under test passes just as happily when an entry is added to it, and an
 * entry added here hands a refresh token to a new population.
 */
describe('the refresh transport', () => {
  it('is the body/header for the custom-scheme WebView origin, which is the one that drops cookies', () => {
    expect(usesBodyRefreshTransport('tauri://localhost')).toBe(true);
  });

  it('is the COOKIE for Android and Windows, whose persistence is proven and must not move', () => {
    // `setAcceptThirdPartyCookies` works there and WP-ANDROID-SESS-1 verified the durability on
    // hardware. Routing those platforms through the header would unprove all of it.
    expect(usesBodyRefreshTransport('http://tauri.localhost')).toBe(false);
    expect(usesBodyRefreshTransport('https://tauri.localhost')).toBe(false);
  });

  it('is the cookie for the web, where HttpOnly is a real protection', () => {
    expect(usesBodyRefreshTransport('https://canari-emse.fr')).toBe(false);
    expect(usesBodyRefreshTransport('http://localhost:5173')).toBe(false);
  });

  it('is the cookie when there is no Origin at all', () => {
    // A request with no origin is not a browser document, so it has no cookie problem to solve.
    // Answering otherwise would hand a refresh token in the body to anything that omits the header.
    expect(usesBodyRefreshTransport(undefined)).toBe(false);
    expect(usesBodyRefreshTransport('')).toBe(false);
  });

  it('is not granted by a lookalike origin', () => {
    expect(usesBodyRefreshTransport('tauri://localhost.evil.com')).toBe(false);
    expect(usesBodyRefreshTransport('tauri://evil')).toBe(false);
    expect(usesBodyRefreshTransport('https://tauri.localhost.evil.com')).toBe(false);
  });

  it('names exactly one origin, so growing the list is a deliberate act', () => {
    expect(BODY_TRANSPORT_ORIGINS).toHaveLength(1);
  });

  it('only names origins CORS already allows - a refused origin never reaches this decision', () => {
    for (const origin of BODY_TRANSPORT_ORIGINS) {
      expect(TAURI_WEBVIEW_ORIGINS as readonly string[]).toContain(origin);
    }
  });

  it('carries the credential in a lowercase header name, as Express reads them', () => {
    expect(REFRESH_HEADER).toBe(REFRESH_HEADER.toLowerCase());
  });
});
