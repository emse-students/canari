/**
 * How a client carries its refresh credential, decided from the ONE fact that settles it.
 *
 * The refresh credential is an HttpOnly cookie everywhere it can be, and that is not everywhere.
 * A native shell's document is its own origin (`tauri://localhost` on iOS/macOS/Linux,
 * `http://tauri.localhost` on Android/Windows) while the credential belongs to `canari-emse.fr`, so
 * the cookie is THIRD-PARTY by construction. Android blocks that class by default and exposes one
 * opt-in the app calls (`CookieManager.setAcceptThirdPartyCookies`, `MainActivity.kt`), which is why
 * Android sessions survive a restart. WKWebView blocks it through ITP and publishes NO equivalent
 * API - measured on production 2026-08-27, where an iPhone presented `cookies=[]` on 120 consecutive
 * refreshes while an Android device on the same server answered 200.
 *
 * So on those platforms the credential travels in the request HEADER and the response BODY instead.
 *
 * **This is a platform property, not a fallback.** The decision is made from the caller's `Origin`,
 * which the server already has, rather than by handing the request to a cookie jar known to refuse
 * it and classifying the refusal. One discriminator, evaluated on both sides of the wire from the
 * same fact: the client's twin is `usesBodyRefreshTransport()` in
 * `frontend/src/lib/stores/nativeRefreshToken.ts`.
 */

/** Header carrying the refresh credential when the client's engine cannot keep the cookie. */
export const REFRESH_HEADER = 'x-canari-refresh';

/**
 * Origins whose engine cannot keep a third-party cookie, so their credential travels in the
 * body/header instead.
 *
 * ONLY the custom-scheme spelling. `http(s)://tauri.localhost` is Android and Windows, where the
 * cookie works and must keep working: Android's persistence is proven on hardware
 * (WP-ANDROID-SESS-1) and moving it here would unprove it.
 */
export const BODY_TRANSPORT_ORIGINS = ['tauri://localhost'] as const;

/**
 * True when this request's client cannot keep the refresh cookie.
 *
 * A missing `Origin` is FALSE: a request with no origin is not a browser document, so it has no
 * cookie problem to solve, and answering true would hand a refresh token in the body to anything
 * that omits the header.
 */
export function usesBodyRefreshTransport(origin: string | undefined): boolean {
  if (!origin) return false;
  return (BODY_TRANSPORT_ORIGINS as readonly string[]).includes(origin);
}
