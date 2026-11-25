import interstitialHtml from '$lib/leaveInAppBrowser/interstitial.html?raw';
import { leaveInAppBrowserResponse, type GateRequest } from '$lib/leaveInAppBrowser/gate';
import { iosAppOpenHref } from '$lib/mobile/openInApp';

/**
 * Canari's use of the shared in-app browser gate (owner decision of 2026-11-25): a page request
 * from the browser built into Messenger, Facebook, Instagram or Threads is answered with the shared
 * interstitial, which leaves for the real browser - or, on Android, for the app when it claims the
 * page - and on iOS offers the app as a tapped second button (`iosAppOpenHref`). Null lets the
 * request through to the page.
 *
 * Its own module so `hooks.server.ts` stays a list of steps and this is testable without the SEO
 * chain's `$app/env/private`. The interstitial is the one user-visible text of Canari outside
 * Paraglide: it is the same bytes on every site of the ecosystem and in front of MiConnect's
 * authentik, where no Paraglide exists (docs/wiki/frontend/leaving-in-app-browsers.md).
 */
export function canariLeaveInAppBrowser(request: GateRequest, url: URL): Response | null {
  return leaveInAppBrowserResponse(request, url, {
    html: interstitialHtml,
    site: 'canari',
    appLinkFor: iosAppOpenHref,
    log: (line) => console.log(line),
  });
}
