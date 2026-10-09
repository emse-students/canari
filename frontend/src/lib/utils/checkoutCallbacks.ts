import { isTauri } from '@tauri-apps/api/core';
import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { publicAppUrl } from '$lib/utils/publicAppUrl';
import { appDeepLink } from '$lib/mobile/appSiteAssociation';

/**
 * True on Tauri Android / iOS - a checkout must return via app deep link.
 *
 * THE OS IS ASKED, NEVER THE USER AGENT. This used to test `/android|iphone|ipad|ipod/` against
 * `navigator.userAgent`, and an iPad WKWebView calls itself "Macintosh" - so an iPad was handed the
 * WEB return URL and a paying user landed on a page the app could never catch. `detectRuntimeDeviceOs`
 * answers with the compile-time target inside a Tauri build, which is the only reliable source here.
 */
export function isMobileTauri(): boolean {
  if (typeof window === 'undefined' || !isTauri()) return false;
  const os = detectRuntimeDeviceOs('desktop');
  return os === 'android' || os === 'ios';
}

/** The host of the checkout return deep link (`fr.emse.canari://payment/success`). */
export const CHECKOUT_RETURN_HOST = 'payment';

/**
 * The host builds older than the payment host registered and send (`stripe`, named for the processor
 * that left in 2026-10). Only READ, never emitted; its removal date is in
 * `docs/wiki/legacy-compatibility.md`.
 */
export const LEGACY_CHECKOUT_RETURN_HOST = 'stripe';

/** Every host the checkout return handler accepts. */
export const CHECKOUT_RETURN_HOSTS: ReadonlySet<string> = new Set([
  CHECKOUT_RETURN_HOST,
  LEGACY_CHECKOUT_RETURN_HOST,
]);

function checkoutDeepLink(path: 'success' | 'cancel', query: string): string {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return appDeepLink(`${CHECKOUT_RETURN_HOST}/${path}${q}`);
}

function webUrl(path: string): string {
  return publicAppUrl(path.startsWith('/') ? path : `/${path}`);
}

/** Checkout callbacks for paid form submissions. */
export function formCheckoutCallbacks(): { successUrl: string; cancelUrl: string } {
  if (isMobileTauri()) {
    return {
      successUrl: checkoutDeepLink('success', 'session_id={CHECKOUT_SESSION_ID}'),
      cancelUrl: checkoutDeepLink('cancel', 'session_id={CHECKOUT_SESSION_ID}'),
    };
  }
  return {
    successUrl: webUrl('/forms/success?session_id={CHECKOUT_SESSION_ID}'),
    cancelUrl: webUrl('/forms/cancel?session_id={CHECKOUT_SESSION_ID}'),
  };
}

/** Checkout callbacks for association shop product purchases. */
export function shopCheckoutCallbacks(productId: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const pid = encodeURIComponent(productId);
  if (isMobileTauri()) {
    return {
      successUrl: checkoutDeepLink('success', `purchase_success=1&productId=${pid}`),
      cancelUrl: checkoutDeepLink('cancel', 'purchase_cancel=1'),
    };
  }
  return {
    successUrl: webUrl(`/shop?purchase_success=1&productId=${pid}`),
    cancelUrl: webUrl('/shop?purchase_cancel=1'),
  };
}
