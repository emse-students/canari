/**
 * The refresh credential on the platforms whose WebView cannot keep a cookie.
 *
 * The app's refresh credential is an HttpOnly cookie everywhere it can be, and that is not
 * everywhere. In a native shell the document's origin is the SHELL's and the cookie's is the
 * BACKEND's, so the cookie is third-party by construction. Android blocks that class by default and
 * exposes one opt-in the app calls (`CookieManager.setAcceptThirdPartyCookies`, `MainActivity.kt`),
 * which is why an Android session survives a kill - measured on A1 2026-08-27, one `refresh 200` in
 * 218 ms after `am force-stop`, no login. WKWebView blocks it too and publishes NO equivalent API:
 * the same day, an iPhone sent 120 refreshes in 45 minutes and presented `cookies=[]` on every one.
 *
 * So on those platforms the credential travels explicitly: sent in a header, received in the body,
 * and kept here between launches. The server's twin is
 * `apps/core-service/src/auth/refresh-transport.ts`, which decides the same thing from the same
 * fact - the request's `Origin` - so neither side infers the other's platform.
 *
 * **Why a store file and not the keychain.** `patches/tauri-plugin-keystore` exists but its iOS path
 * builds `SecAccessControlCreateWithFlags` with biometric flags, because it guards the MLS device
 * key - reading it raises Face ID, which cannot sit in front of every cold start. This file is the
 * mechanism this module already uses for OIDC state, and on iOS it lives in the app's sandboxed data
 * directory under Data Protection: the same protection class as the Chromium cookie file Android
 * keeps its own refresh token in, so it matches the behaviour Android already has rather than
 * inventing a weaker or stronger one. Moving it into the keychain WITHOUT biometric flags is a
 * strict improvement and is filed as such (`docs/wiki/backlog.md`); it needs a new command in the
 * vendored plugin and an iOS build to verify.
 */

import { isTauriRuntime } from '$lib/utils/openExternal';

/** Store file holding the native refresh credential. Separate from OIDC state, which is per-login. */
const NATIVE_AUTH_STORE_FILE = 'auth-native.json';

/** Key inside {@link NATIVE_AUTH_STORE_FILE}. */
const REFRESH_KEY = 'refresh_token';

/** Header the credential is sent in. Must match `REFRESH_HEADER` on the server. */
export const REFRESH_HEADER = 'X-Canari-Refresh';

/**
 * True when this runtime cannot keep the refresh cookie, so the credential must be carried
 * explicitly.
 *
 * Decided on the document's SCHEME, which is what makes the cookie third-party in the first place,
 * and which is exactly what the server sees as the request's `Origin` (`tauri://localhost`, measured
 * in the production log). Not decided on the user agent: the platform is a consequence here, not the
 * cause, and `tauri://` is equally the origin on macOS and Linux desktop builds - which have the
 * same problem for the same reason.
 *
 * `http://tauri.localhost` (Android, Windows) is deliberately NOT included. The cookie works there,
 * its durability is proven on hardware (WP-ANDROID-SESS-1), and routing it through here would
 * unprove it.
 */
export function usesBodyRefreshTransport(): boolean {
  if (!isTauriRuntime()) return false;
  if (typeof window === 'undefined') return false;
  return window.location.protocol === 'tauri:';
}

/** Opens the store. Isolated so the three accessors below cannot drift on its options. */
async function openStore() {
  const { load } = await import('@tauri-apps/plugin-store');
  // `autoSave` is deliberately OFF: it debounces, and a debounced write is exactly the hazard
  // {@link writeNativeRefreshToken} exists to close. Every write here saves explicitly.
  return await load(NATIVE_AUTH_STORE_FILE, { autoSave: false, defaults: {} });
}

/** Reads the stored credential, or `null` when this device holds no session. */
export async function readNativeRefreshToken(): Promise<string | null> {
  const store = await openStore();
  return (await store.get<string>(REFRESH_KEY)) ?? null;
}

/**
 * Writes the credential and does not return until it is ON DISK.
 *
 * The awaited `save()` is the whole point, and the reason is the same one that cost Android a
 * revoked session (WP-ANDROID-SESS-1): rotation makes durability part of the protocol. From the
 * instant the server answers, the ONLY token it will accept is the one it just issued, and the
 * previous one becomes a REPLAY 60 s later - which the server punishes by deleting the session row,
 * permanently and correctly. A process death between the response and a debounced write would
 * therefore hand the next cold start a superseded token and lose the session for good.
 */
export async function writeNativeRefreshToken(token: string): Promise<void> {
  const store = await openStore();
  await store.set(REFRESH_KEY, token);
  await store.save();
}

/** Erases the credential. Used on logout, where the server has revoked the row anyway. */
export async function clearNativeRefreshToken(): Promise<void> {
  const store = await openStore();
  await store.delete(REFRESH_KEY);
  await store.save();
}
