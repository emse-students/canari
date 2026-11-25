// @vitest-environment happy-dom
/**
 * THE CLIENT GUARD OF THE META IN-APP BROWSER GATE: captured once per document from the address the
 * visitor was sent, logged at warn (reaching it accuses the server's answer), and null for every
 * other browser. docs/wiki/frontend/leaving-in-app-browsers.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inAppBrowserGuard, resetInAppBrowserGuardForTests } from './inAppBrowserGuard';

const MESSENGER_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/485.0.0.42.109;FBSN/iOS;FBSV/18.1]';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

function asBrowser(userAgent: string, path: string): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  window.history.replaceState(null, '', path);
}

beforeEach(() => resetInAppBrowserGuardForTests());
afterEach(() => vi.restoreAllMocks());

describe('inAppBrowserGuard', () => {
  it('holds in a Meta in-app browser, with the address it was opened on, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    asBrowser(MESSENGER_IOS, '/posts/abc?ref=x');
    const guard = inAppBrowserGuard();
    expect(guard?.browser).toEqual({ app: 'messenger', os: 'ios', iosMajor: 18 });
    expect(guard?.href).toBe(`${window.location.origin}/posts/abc?ref=x`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('past the server');
    expect(String(warn.mock.calls[0][0])).toContain('route=/posts');
  });

  it('keeps the FIRST address of the document, whatever the page moves to afterwards', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    asBrowser(MESSENGER_IOS, '/posts/abc');
    inAppBrowserGuard();
    window.history.replaceState(null, '', '/login?returnTo=%2Fposts%2Fabc');
    expect(inAppBrowserGuard()?.href).toBe(`${window.location.origin}/posts/abc`);
  });

  it('is null, and silent, in any other browser', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    asBrowser(SAFARI_IOS, '/posts/abc');
    expect(inAppBrowserGuard()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
