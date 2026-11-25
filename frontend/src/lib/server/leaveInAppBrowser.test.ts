import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canariLeaveInAppBrowser } from './leaveInAppBrowser';

/**
 * Canari's gate, as `hooks.server.ts` calls it: the shared fixtures through the real module, the
 * paths and requests that must pass, and the iOS app link only on a page the app claims.
 */
interface Case {
  name: string;
  userAgent: string;
  expect: unknown;
}

const { cases } = JSON.parse(
  readFileSync(resolve('..', 'libs', 'leave-in-app-browser', 'fixtures.json'), 'utf8')
) as { cases: Case[] };
const messengerIos = cases.find((c) => c.name === 'Messenger, iOS 18')!.userAgent;
const messengerAndroid = cases.find((c) => c.name === 'Messenger, Android')!.userAgent;

/** A page navigation as a browser sends it, `headers` on top. */
function page(userAgent: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Request('https://canari.emse.fr/x', {
    method,
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      ...headers,
    },
  });
}

describe('canariLeaveInAppBrowser', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers every in-app fixture with the interstitial and lets every other client through', () => {
    const url = new URL('https://canari.emse.fr/posts/abc');
    for (const c of cases) {
      const response = canariLeaveInAppBrowser(page(c.userAgent), url);
      expect({ name: c.name, gated: response !== null }).toEqual({
        name: c.name,
        gated: c.expect !== null,
      });
    }
  });

  it('never gates an API call, an asset, an association file, a static file or a fetch', () => {
    for (const path of [
      '/api/users/me',
      '/_app/immutable/entry/app.js',
      '/.well-known/assetlinks.json',
    ]) {
      expect(
        canariLeaveInAppBrowser(page(messengerIos), new URL(path, 'https://canari.emse.fr'))
      ).toBeNull();
    }
    const icon = new URL('https://canari.emse.fr/icons/icon-192.png');
    expect(
      canariLeaveInAppBrowser(
        page(messengerIos, { 'sec-fetch-dest': 'image', accept: 'image/*' }),
        icon
      )
    ).toBeNull();
    expect(
      canariLeaveInAppBrowser(
        page(messengerIos, { 'sec-fetch-dest': 'empty' }),
        new URL('https://canari.emse.fr/posts/abc')
      )
    ).toBeNull();
    expect(
      canariLeaveInAppBrowser(page(messengerIos, {}, 'POST'), new URL('https://canari.emse.fr/x'))
    ).toBeNull();
  });

  it('offers the iOS app on a claimed page, and not on a page the app does not claim', async () => {
    const claimed = canariLeaveInAppBrowser(
      page(messengerIos),
      new URL('https://canari.emse.fr/posts/abc')
    )!;
    expect(await claimed.text()).toContain(
      `<meta name="leave-iab-app" content="fr.emse.canari://open?url=${encodeURIComponent('https://canari.emse.fr/posts/abc')}" />`
    );
    const unclaimed = canariLeaveInAppBrowser(
      page(messengerIos),
      new URL('https://canari.emse.fr/auth/callback')
    )!;
    expect(await unclaimed.text()).toContain('<meta name="leave-iab-app" content="" />');
  });

  it('logs one line naming the route, never the query; no-store and Vary on the answer', () => {
    const response = canariLeaveInAppBrowser(
      page(messengerAndroid),
      new URL('https://canari.emse.fr/c/join/secret-token?k=v')
    )!;
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('User-Agent');
    expect(console.log).toHaveBeenCalledWith(
      '[leave-iab] interstitial served site=canari app=messenger os=android ios=- route=/c'
    );
  });
});
