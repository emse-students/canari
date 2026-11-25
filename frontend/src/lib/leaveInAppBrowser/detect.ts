/**
 * THE ONE DEFINITION OF "A META IN-APP BROWSER", AND THE WAY OUT OF ONE - shared by every site of
 * the ecosystem (owner decision of 2026-11-25, Canari's
 * docs/wiki/frontend/leaving-in-app-browsers.md).
 *
 * VENDORED BYTE-IDENTICALLY: the source is Canari's `libs/leave-in-app-browser/detect.ts`; every
 * site carries a copy, and each copy is held equal to the source by a test. No dependency, no
 * browser or server global: it runs in a SvelteKit hook, in a Svelte component and in the nginx
 * generator alike.
 */

/** The four Meta apps whose built-in browser our sites refuse to run in. */
export type MetaInAppBrowserApp = 'messenger' | 'instagram' | 'threads' | 'facebook';

/** The phone's system, as far as leaving is concerned. `other` has no automatic exit. */
export type InAppBrowserOs = 'android' | 'ios' | 'other';

/**
 * THE TOKENS, ORDERED: the first rule whose pattern matches names the app. Messenger and Instagram
 * come before Facebook because the order is the only thing that tells them apart where a user agent
 * carries Facebook's tokens too.
 *
 * Each pattern is written in the subset JavaScript and nginx's PCRE read identically - literal
 * characters, `|`, `[0-9]` and a space - because the SAME strings become the nginx `map` in front of
 * MiConnect (`nginx.ts`); `detect.test.ts` refuses any other character.
 *
 * - `FBAN/Messenger` (iOS: `FBAN/MessengerForiOS`, `FBAN/MessengerLiteForiOS`) and
 *   `FB_IAB/Orca-Android` (Android Messenger);
 * - `Instagram <version>` (both systems);
 * - `Barcelona <version>` - Threads, by its code name (both systems);
 * - `FBAN/`, `FBAV/`, `FB_IAB/`, `FBIOS` - Facebook (`FBAN/FBIOS`, `FB_IAB/FB4A`, Facebook Lite's
 *   `FBAN/EMA`).
 *
 * NOT matched, deliberately, and pinned by `fixtures.json`: Meta's crawlers
 * (`facebookexternalhit/1.1`, which draws every link-preview card in those apps, and the
 * `meta-external*` / `meta-webindexer` fetchers) carry none of these tokens. A pattern widened to
 * "facebook" would block the preview card of every link we share.
 */
export const META_IN_APP_BROWSER_RULES: readonly (readonly [MetaInAppBrowserApp, string])[] = [
  ['messenger', 'FBAN/Messenger|FB_IAB/Orca-Android'],
  ['instagram', 'Instagram [0-9]'],
  ['threads', 'Barcelona [0-9]'],
  ['facebook', 'FBAN/|FBAV/|FB_IAB/|FBIOS'],
];

const RULES = META_IN_APP_BROWSER_RULES.map(
  ([app, pattern]) => [app, new RegExp(pattern)] as const
);

/** What a user agent says about where the page is being read. */
export interface MetaInAppBrowser {
  app: MetaInAppBrowserApp;
  os: InAppBrowserOs;
  /** The iOS major version (`17` for `OS 17_5`), or null when not iOS or not stated. */
  iosMajor: number | null;
}

/**
 * The Meta in-app browser `userAgent` names, or null for any other client - a real browser, a
 * crawler, the Canari app's own WebView.
 */
export function detectMetaInAppBrowser(userAgent: string): MetaInAppBrowser | null {
  const rule = RULES.find(([, pattern]) => pattern.test(userAgent));
  if (!rule) return null;
  const ios = /(?:iPhone|iPad|iPod|CPU) OS ([0-9]+)_/.exec(userAgent);
  if (/iPhone|iPad|iPod/.test(userAgent)) {
    return { app: rule[0], os: 'ios', iosMajor: ios ? Number(ios[1]) : null };
  }
  if (/Android/.test(userAgent)) return { app: rule[0], os: 'android', iosMajor: null };
  return { app: rule[0], os: 'other', iosMajor: null };
}

/**
 * THE FIRST iOS WHERE `x-safari-https://` IS ATTEMPTED. The scheme is undocumented by Apple and
 * reported working from iOS 17 (not on 16); on 16 and older nothing is attempted and the page says
 * how to leave by hand (owner, 2026-11-25).
 */
export const FIRST_IOS_WITH_SAFARI_SCHEME = 17;

/**
 * The URL that leaves the in-app browser for the page at `href`, or null where no door exists.
 *
 * - **Android**: an `intent:` for an ordinary https VIEW, with NO package and NO
 *   `S.browser_fallback_url`. The system resolves it by its own rule: the app that holds a verified
 *   App Link for that URL (Canari, on a page it claims), otherwise the default browser. A fallback
 *   URL would load INSIDE the in-app browser - the one place this page must never send anyone back
 *   to. The page's `#fragment` cannot travel: an intent uses the fragment for its own parameters.
 * - **iOS 17 and later**: `x-safari-<href>`, the same page in Safari.
 * - **iOS 16 and older, or another system**: null.
 */
export function exitHref(browser: MetaInAppBrowser, href: string): string | null {
  const url = new URL(href);
  if (browser.os === 'android') {
    return (
      `intent://${url.host}${url.pathname}${url.search}#Intent;` +
      `scheme=${url.protocol.slice(0, -1)};action=android.intent.action.VIEW;` +
      'category=android.intent.category.BROWSABLE;end'
    );
  }
  if (
    browser.os === 'ios' &&
    browser.iosMajor !== null &&
    browser.iosMajor >= FIRST_IOS_WITH_SAFARI_SCHEME
  ) {
    return `x-safari-${url.href}`;
  }
  return null;
}
