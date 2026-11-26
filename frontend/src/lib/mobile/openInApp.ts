import { APP_STORE_URL, PLAY_STORE_URL } from './storeUrls';
import { isPublicAppUrl } from '$lib/utils/publicAppUrl';
import {
  appDeepLink,
  isClaimedAppLinkPath,
  MOBILE_APP_LINK_HOSTS,
  MOBILE_APP_PACKAGE,
} from './appSiteAssociation';

/**
 * The app's own doors from a web page: "Ouvrir dans l'application" on the login page, and the iOS
 * app link the in-app browser interstitial offers as its second button.
 *
 * A browser built into Messenger, Facebook, Instagram or Threads never reaches these pages: every
 * Canari page answers it with the shared interstitial (`$lib/leaveInAppBrowser`, owner decision of
 * 2026-11-25), whose Android exit reaches the app by Android's own resolution. Protocol and
 * reasoning: `docs/wiki/frontend/leaving-in-app-browsers.md`, and
 * `docs/wiki/frontend/mobile.md#leaving-an-in-app-browser-for-the-app` for the doors themselves.
 */

/** The phone's system, as far as the app's doors are concerned. */
type PhoneOs = 'android' | 'ios';

/** A way into the app: where the tap goes, and where to get the app without it. */
export interface OpenInAppOffer {
  os: PhoneOs;
  /** Opens `href` in the app. */
  openHref: string;
  /** The store listing, for a phone without the app. */
  storeHref: string;
}

/**
 * The iOS app link for the page at `url` - `fr.emse.canari://open?url=<page>` - or null when the
 * app does not claim it. The interstitial shows it as a TAPPED second button only: iOS has no
 * fallback when the app is absent, and a page cannot tell "not installed" from success without a
 * timer (owner, 2026-11-25). Behind `/login`, the page the visitor came for.
 */
export function iosAppOpenHref(url: URL): string | null {
  return offerFor('ios', pageBehindLogin(url))?.openHref ?? null;
}

/**
 * The offer for a phone on the LOGIN page, in any browser: "Ouvrir dans l'application".
 *
 * `/login` is not a path the app claims, so the target is the page behind it (`returnTo`) when that
 * is claimed, else `/chat` - the app's home, which asks for a sign-in itself when it must. Null
 * for a desktop, an unknown system, or a host no App Link filter names (dev). Unlike an Android
 * link tapped in Chrome, nothing here is resolved by the system before the visitor chooses, so
 * the offer is the only way a phone that HAS the app gets there from the web login.
 */
export function loginOpenInAppOffer(href: string, userAgent: string): OpenInAppOffer | null {
  const os = phoneOs(userAgent);
  if (!os || !isPublicAppUrl(href)) return null;
  const url = new URL(href);
  const behind = pageBehindLogin(url);
  const claimed = offerFor(os, behind);
  if (claimed) return claimed;
  return offerFor(os, new URL('/chat', url.origin));
}

/** The phone system named by `userAgent`, whatever the browser. */
function phoneOs(userAgent: string): PhoneOs | null {
  if (/Android/.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  return null;
}

/** The offer for `url` on `os`, or null when it is not a page the app claims. */
function offerFor(os: PhoneOs, url: URL): OpenInAppOffer | null {
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
 * A visitor with no session lands on `/login?returnTo=<path>` (`routes/+layout.ts`), a path the app
 * does not claim. Offering `/login` itself would open the app on nothing; the page they came for is
 * `returnTo`.
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
