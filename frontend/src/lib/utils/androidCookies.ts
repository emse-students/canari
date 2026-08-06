/**
 * Durability of the refresh cookie on Android.
 *
 * The refresh token is HttpOnly, so on Android it exists in exactly one place: the WebView's
 * Chromium cookie store. Chromium commits that store to disk on a timer, and the only thing that
 * forces it early is `CookieManager.flush()` - which the app calls from `onPause`/`onStop`.
 *
 * A process death with no lifecycle callback (`am force-stop`, a crash, an OS kill, an APK
 * reinstall) therefore reverts the on-disk cookie to the generation BEFORE the last rotation. The
 * next cold start presents it, the server reads a replayed rotating token and revokes the session -
 * and the app is left looking signed in with an empty feed (WP-ANDROID-SESS-1).
 *
 * So every response that may have carried a `Set-Cookie` for `canari_refresh` is followed by an
 * explicit flush. See `docs/wiki/sessions.md`.
 */

import { isAndroidTauriRuntime } from '$lib/utils/appVersion';

/**
 * Forces the Android WebView cookie jar to disk. No-op everywhere else.
 *
 * Awaited on purpose: returning before the bytes are written would leave the exact window this
 * closes. The flush is local I/O and costs a few milliseconds.
 */
export async function flushAndroidCookies(reason: string): Promise<void> {
  if (!isAndroidTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const ok = await invoke<boolean>('flush_webview_cookies');
    if (ok) console.debug(`[Cookies] flushed after ${reason}`);
    else console.warn(`[Cookies] flush after ${reason} returned false - cookie may not be on disk`);
  } catch (e) {
    console.warn(`[Cookies] flush after ${reason} failed: ${String(e)}`);
  }
}
