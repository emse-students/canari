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
 * Origins whose ENGINE cannot keep a third-party cookie, whatever the deployment does.
 *
 * ONLY the custom-scheme spelling. WKWebView blocks the class through ITP and publishes no opt-in,
 * so no server-side cookie attribute can rescue it: these clients carry the credential on every
 * deployment, including production.
 */
export const BODY_TRANSPORT_ORIGINS = ['tauri://localhost'] as const;

/**
 * Origins that are third-party to this API but whose engine WILL keep the cookie - provided the
 * deployment can issue one a third-party context accepts.
 *
 * Android and Windows serve the shell from `http(s)://tauri.localhost`, and Android opts into the
 * class explicitly (`CookieManager.setAcceptThirdPartyCookies`, `MainActivity.kt`). Their
 * persistence is proven on hardware (WP-ANDROID-SESS-1) and must keep working, which is why they
 * are NOT in the list above - the cookie is still the path for them wherever it can be issued.
 */
export const THIRD_PARTY_SHELL_ORIGINS = [
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const;

/**
 * True when this request's client cannot keep the refresh cookie.
 *
 * TWO REASONS A COOKIE CANNOT BE KEPT, AND THEY ARE NOT THE SAME REASON. The first is the engine:
 * WKWebView refuses the third-party class outright, so `tauri://localhost` carries the credential
 * everywhere. The second is the DEPLOYMENT, and it was missed until 2026-09-04. `setRefreshCookie`
 * issues `SameSite=None; Secure` over HTTPS and `SameSite=Lax` without `Secure` over plain HTTP -
 * there is no third option, since `None` requires `Secure` and `Secure` requires TLS - and **a
 * `Lax` cookie cannot be SET in a third-party context at all.** So on an HTTP deployment the
 * Android shell is handed a cookie its engine discards on arrival: measured on the local estate,
 * `Network.getAllCookies` returned 0 matching cookies on the phone against 3 in a browser, the
 * server logged `no canari_refresh cookie. cookies=[] origin=http://tauri.localhost`, and three
 * `auth_sessions` rows were created and never used again. The device logged itself out before it
 * had published a key package.
 *
 * `thirdPartyCookieIsIssuable` is that second fact, and the caller has it: it is the negation of
 * `ALLOW_INSECURE_COOKIES`, the same flag `setRefreshCookie` reads. It is REQUIRED rather than
 * defaulted, because a default here would silently pick a transport for a deployment that never
 * said which it was - and the flag itself has no default for exactly that reason.
 *
 * This stays a property, never a fallback: nothing is handed to a cookie jar known to refuse it in
 * order to classify the refusal. Both facts are known before the response is written, and the
 * client's twin computes the same answer from the same two facts -
 * `usesBodyRefreshTransport()` in `frontend/src/lib/stores/nativeRefreshToken.ts`, which reads the
 * API's scheme where this reads the flag that scheme decides.
 *
 * A missing `Origin` is FALSE: a request with no origin is not a browser document, so it has no
 * cookie problem to solve, and answering true would hand a refresh token in the body to anything
 * that omits the header.
 */
export function usesBodyRefreshTransport(
  origin: string | undefined,
  thirdPartyCookieIsIssuable: boolean
): boolean {
  if (!origin) return false;
  if ((BODY_TRANSPORT_ORIGINS as readonly string[]).includes(origin)) return true;
  if (thirdPartyCookieIsIssuable) return false;
  return (THIRD_PARTY_SHELL_ORIGINS as readonly string[]).includes(origin);
}
