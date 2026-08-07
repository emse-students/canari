//! Durability of the WebView cookie jar (Android).
//!
//! The refresh token is an HttpOnly cookie, so on Android it lives in exactly one place: the
//! WebView's Chromium cookie store. Chromium writes that store to disk LAZILY - a `Set-Cookie`
//! processed now reaches `app_webview/Default/Cookies` seconds later, on a commit timer.
//!
//! That is fine until the process dies without a lifecycle callback (`am force-stop`, a crash, an
//! OS kill, an APK reinstall). `MainActivity.onPause`/`onStop` call `CookieManager.flush()`, but
//! none of them runs in that case, so the next cold start reads a cookie one ROTATION behind the
//! one the server has already handed out. Presenting it is a replay, and the server answers a
//! replay by revoking the session outright - the app then looks signed in and shows nothing
//! (WP-ANDROID-SESS-1, proven on prod 2026-08-06 against the server's own session row).
//!
//! So the rotation is flushed the moment it happens, from the one place that knows it happened.

/// Forces the WebView cookie jar to disk. Returns `false` if the flush could not be performed.
///
/// No-op (and `true`) off Android, but for two DIFFERENT reasons, and only one of them is settled:
///
/// - Web has no WebView cookie jar of its own, and desktop is not subject to a kill without
///   lifecycle callbacks. Nothing to do on either.
/// - **iOS is an open question, not a decision.** `WKHTTPCookieStore` has no flush API at all, so
///   there is nothing to call even if the same window exists - and it plausibly does: a suspended
///   app swiped from the switcher is terminated without `applicationWillTerminate`, which is
///   exactly the shape that rewound Android's jar by one rotation (WP-ANDROID-SESS-1). It has never
///   been observed on hardware. Recorded as `check P` in `docs/wiki/device-verification.md`; do not
///   read this no-op as evidence that iOS is safe.
#[tauri::command]
pub(crate) fn flush_webview_cookies() -> bool {
    #[cfg(target_os = "android")]
    {
        let Some(vm) = crate::android_java_vm() else {
            log::warn!("[Cookies] no JavaVM cached - flush skipped");
            return false;
        };
        let mut env = match vm.attach_current_thread() {
            Ok(env) => env,
            Err(e) => {
                log::warn!("[Cookies] attach_current_thread failed: {e}");
                return false;
            }
        };
        // `android.webkit.CookieManager` is a FRAMEWORK class, which is what makes this reachable
        // at all: a native thread has no Java frames on its stack, so `FindClass` falls back to
        // the system class loader - it finds boot-classpath classes and would NOT find one of
        // ours. Hence the framework call here rather than a helper in `MainActivity`.
        let class = match env.find_class("android/webkit/CookieManager") {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[Cookies] find_class(CookieManager) failed: {e}");
                return false;
            }
        };
        let manager = match env
            .call_static_method(
                &class,
                "getInstance",
                "()Landroid/webkit/CookieManager;",
                &[],
            )
            .and_then(|v| v.l())
        {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[Cookies] CookieManager.getInstance() failed: {e}");
                return false;
            }
        };
        // `flush()` is documented as blocking until the write is done, which is the whole point:
        // returning before the bytes are on disk would leave exactly the window this closes.
        match env.call_method(&manager, "flush", "()V", &[]) {
            Ok(_) => {
                log::debug!("[Cookies] cookie jar flushed to disk");
                true
            }
            Err(e) => {
                log::warn!("[Cookies] CookieManager.flush() failed: {e}");
                false
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        true
    }
}
