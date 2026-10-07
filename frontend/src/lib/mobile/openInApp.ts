import { APP_STORE_URL, PLAY_STORE_URL } from '$lib/utils/appVersion';
import { isPublicAppUrl } from '$lib/utils/publicAppUrl';
import {
  appDeepLink,
  isClaimedAppLinkPath,
  MOBILE_APP_LINK_HOSTS,
  MOBILE_APP_PACKAGE,
} from './appSiteAssociation';

/**
 * Leaving the browser built into Messenger, Facebook or Instagram, for the app.
 *
 * Those apps never hand a tapped link to the system: they load it in their own WebView, so a
 * verified App Link (Android) or Universal Link (iOS) is never consulted and a Canari link opens
 * as a web page even on a phone with the app installed (user, 2026-09-28). Nothing on the server
 * can change that. What the PAGE can do is offer a tap that leaves: an `intent:` URL on Android,
 * which those WebViews hand to the system, and the app's own scheme on iOS.
 *
 * Protocol and the reasoning: `docs/wiki/frontend/mobile.md#leaving-an-in-app-browser-for-the-app`.
 */

/** The phone's system, as far as leaving an in-app browser is concerned. */
export type InAppBrowserOs = 'android' | 'ios';

/**
 * Whether `userAgent` is the browser built into a Meta app, and on which system.
 *
 * The tokens are the ones those apps add to their WebView's user agent: `FBAN`/`FBAV` (Facebook
 * and Messenger on iOS, `FBAN/MessengerForiOS`), `FB_IAB` (both on Android, Messenger as
 * `FB_IAB/Orca-Android`) and `Instagram`. Any other browser, the app's own WebView included,
 * answers null: a real browser follows App Links by itself and needs no offer.
 */
export function detectInAppBrowser(userAgent: string): InAppBrowserOs | null {
  if (!/FBAN\/|FBAV\/|FB_IAB|Instagram/.test(userAgent)) return null;
  if (/Android/.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  return null;
}

/** A way out of the in-app browser: where the tap goes, and where to get the app without it. */
export interface OpenInAppOffer {
  os: InAppBrowserOs;
  /** Opens `href` in the app. */
  openHref: string;
  /** The store listing, for a phone without the app. */
  storeHref: string;
}

/**
 * The offer for the page at `href`, seen by `userAgent` - or null when there is nothing to offer:
 * not an in-app browser, not a Canari page, or a path the app does not claim.
 *
 * - **Android**: `intent://<host><path>#Intent;scheme=https;package=fr.emse.canari;...`. The
 *   system resolves it against the app's existing https App Link filter - the same entry a tap in
 *   any other app takes - and falls back to the Play listing when the app is absent. The page's
 *   `#fragment` cannot travel: an intent URL uses the fragment for its own parameters.
 * - **iOS**: `fr.emse.canari://open?url=<href>`. The scheme is registered with no host filter,
 *   and `hooks.client.ts` opens the URL only if it is a claimed Canari page, like a Universal
 *   Link. iOS has no fallback of its own, hence {@link OpenInAppOffer.storeHref} on screen.
 */
export function openInAppOffer(href: string, userAgent: string): OpenInAppOffer | null {
  const os = detectInAppBrowser(userAgent);
  if (!os || !isPublicAppUrl(href)) return null;
  const url = pageBehindLogin(new URL(href));
  if (!isPublicAppUrl(url.href)) return null;
  // The claimed HOSTS, not every Canari name: an intent naming the package matches only the filter,
  // and `dev.canari-emse.fr` is in no filter - it would send a phone with the app to the store.
  if (!(MOBILE_APP_LINK_HOSTS as readonly string[]).includes(url.hostname)) return null;
  if (!isClaimedAppLinkPath(url.pathname)) return null;
  if (os === 'android') {
    const fallback = encodeURIComponent(PLAY_STORE_URL);
    return {
      os,
      openHref:
        `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;` +
        `package=${MOBILE_APP_PACKAGE};S.browser_fallback_url=${fallback};end`,
      storeHref: PLAY_STORE_URL,
    };
  }
  return {
    os,
    openHref: appDeepLink(`open?url=${encodeURIComponent(url.href)}`),
    storeHref: APP_STORE_URL,
  };
}

/**
 * The page a visitor was sent to `/login` from, or `url` itself.
 *
 * An in-app browser holds no Canari session - it is not the phone's browser - so EVERY Messenger
 * visitor lands on `/login?returnTo=<path>` (`routes/+layout.ts`), a path the app does not claim.
 * Offering `/login` itself would open the app on nothing; the page they came for is `returnTo`.
 * It is resolved against the site's own origin and then held to the same tests as any page, so a
 * `returnTo` naming another host is refused rather than offered.
 */
function pageBehindLogin(url: URL): URL {
  const returnTo = url.pathname === '/login' ? url.searchParams.get('returnTo') : null;
  if (!returnTo) return url;
  try {
    return new URL(returnTo, url.origin);
  } catch {
    return url;
  }
}
