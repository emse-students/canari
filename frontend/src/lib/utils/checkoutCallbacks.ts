import { isTauri } from '@tauri-apps/api/core';
import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { publicAppUrl } from '$lib/utils/publicAppUrl';
import { appDeepLink } from '$lib/mobile/appSiteAssociation';
import { Log } from '$lib/utils/Log';

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

/** The host of the checkout return deep link (`fr.emse.canari://payment/success`), and the only one. */
export const CHECKOUT_RETURN_HOST = 'payment';

function checkoutDeepLink(path: 'success' | 'cancel', query: string): string {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return appDeepLink(`${CHECKOUT_RETURN_HOST}/${path}${q}`);
}

/**
 * The app's own link to a form answer's payment return (`fr.emse.canari://payment/success`), for a
 * page in a BROWSER offering "Ouvrir Canari": a tap is a gesture, which a redirect is not, so the
 * system hands it to the app, whose router opens `/forms/success` on that answer.
 */
export function formPaymentReturnDeepLink(submissionId: string): string {
  return checkoutDeepLink('success', `submission_id=${encodeURIComponent(submissionId)}`);
}

/** True where a checkout still returns on the custom scheme: the iOS app, until a reading says otherwise. */
function returnsOnAppScheme(): boolean {
  return isMobileTauri() && detectRuntimeDeviceOs('desktop') === 'ios';
}

function webUrl(path: string): string {
  return publicAppUrl(path.startsWith('/') ? path : `/${path}`);
}

/**
 * Checkout callbacks for paid form submissions.
 *
 * ANDROID RETURNS ON AN HTTPS APP LINK, NOT ON THE CUSTOM SCHEME (2026-11-13). A payer who paid on
 * Lydia's page in the phone's browser was never brought back by `fr.emse.canari://payment/success`
 * (production, Android 1.6.10, the payment confirmed 43 s later by the callback). Lydia's redirect to
 * an https return WAS measured (sandbox, 2026-10-21, `lydia-api.md` section 4); one to a custom scheme
 * never was, and a browser may refuse an external scheme reached by a redirect with no gesture.
 * `/forms/success` is under the `/forms/` App Link prefix (`MOBILE_UNIVERSAL_LINK_PATHS`), so a
 * verified link opens the app on it, and a browser that keeps it lands on the web return page. iOS
 * keeps the scheme until a reading says otherwise. Either way the form page reads the answer when
 * the payer comes back by hand (`checkoutReturn.ts`), which no return URL replaces.
 */
export function formCheckoutCallbacks(): { successUrl: string; cancelUrl: string } {
  if (returnsOnAppScheme()) {
    Log.d('checkout', 'form return on the app scheme (iOS)');
    return {
      successUrl: checkoutDeepLink('success', 'session_id={CHECKOUT_SESSION_ID}'),
      cancelUrl: checkoutDeepLink('cancel', 'session_id={CHECKOUT_SESSION_ID}'),
    };
  }
  Log.d('checkout', 'form return on the https return page (an App Link on Android)');
  return {
    successUrl: webUrl('/forms/success?session_id={CHECKOUT_SESSION_ID}'),
    cancelUrl: webUrl('/forms/cancel?session_id={CHECKOUT_SESSION_ID}'),
  };
}

/**
 * Checkout callbacks for association shop product purchases. Android returns on the https `/shop`
 * link (an App Link, `android:path="/shop"`) like the paid forms (`formCheckoutCallbacks`): a
 * custom scheme reached by a redirect was never measured to bring the payer back. iOS keeps the
 * scheme. Either way the purchase button reads the attempt when the payer comes back by hand
 * (`createShopCheckoutReader`), which no return URL replaces.
 */
export function shopCheckoutCallbacks(productId: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const pid = encodeURIComponent(productId);
  if (returnsOnAppScheme()) {
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
