//! Whether the iPhone app is ACTIVE, ASKED by the page rather than only told to it.
//!
//! The page holds the answer in `window.__canariActive`, which `CanariPushActiveToPage`
//! (canari_ios.mm) writes on every transition. A push can be LOST - `evaluateJavaScript` failed, or
//! no WebView existed yet - and a page left on `false` while the app is in front withholds every
//! queued frame (`appActive.ts`). So the page also asks, on load, on `visibilitychange` and on
//! `focus`, and this is the answer.
//!
//! THE ANSWER IS UIKIT'S OWN STATE, `UIApplication.applicationState`, read on the main thread - not a
//! mirror of it. The App Group flag the extension reads (`app_in_foreground`) is a WRITE, and a write
//! that failed would hand back a stale value that overrides a correct told one; the application
//! state has no write to fail. `Active` is exactly the span between `didBecomeActive` and
//! `willResignActive`, the two callbacks that tell the page.
//!
//! Through the Objective-C runtime, like `app_group.rs`: `libapp.a` is linked into the notification
//! extension too, so no app-only symbol may be named here. The command never runs in the extension.

// Everything but the command is reached only on iOS (and by the host tests).
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

/// `UIApplicationStateActive` - the first case of `UIApplicationState` (`Inactive` is 1,
/// `Background` 2), fixed by UIKit's ABI.
const UI_APPLICATION_STATE_ACTIVE: isize = 0;

/// Whether a `UIApplicationState` value is `Active`. Inactive (Control Center, a system prompt,
/// the app switcher) and Background are both "not active", as the told signal says.
pub(crate) fn is_active_state(state: isize) -> bool {
    state == UI_APPLICATION_STATE_ACTIVE
}

/// Reads `[[UIApplication sharedApplication] applicationState]`. MAIN THREAD ONLY (UIKit).
#[cfg(target_os = "ios")]
fn application_state_on_main() -> Result<isize, String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let class = AnyClass::get(c"UIApplication").ok_or("UIApplication is not loaded")?;
    // SAFETY: plain UIKit messages with the argument and return types their headers declare,
    // sent on the main thread (the caller is `run_on_main_thread`).
    unsafe {
        let app: *mut AnyObject = msg_send![class, sharedApplication];
        if app.is_null() {
            return Err("no shared UIApplication".into());
        }
        let state: isize = msg_send![app, applicationState];
        Ok(state)
    }
}

/// The app's active state as UIKit holds it: `Some(true|false)` on iOS, `None` where the question
/// has no answer - off iOS, or a main-thread read that did not come back (logged as an error,
/// because the page then keeps a value it cannot check).
#[tauri::command]
pub(crate) async fn ios_app_active(app: tauri::AppHandle) -> Option<bool> {
    #[cfg(target_os = "ios")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Err(e) = app.run_on_main_thread(move || {
            let _ = tx.send(application_state_on_main());
        }) {
            log::error!("[APP_ACTIVE] the main thread could not be asked: {e}");
            return None;
        }
        let answer = tauri::async_runtime::spawn_blocking(move || rx.recv()).await;
        match answer {
            Ok(Ok(Ok(state))) => {
                log::debug!("[APP_ACTIVE] applicationState={state}");
                Some(is_active_state(state))
            }
            Ok(Ok(Err(e))) => {
                log::error!("[APP_ACTIVE] the application state could not be read: {e}");
                None
            }
            Ok(Err(e)) => {
                log::error!("[APP_ACTIVE] the main thread never answered: {e}");
                None
            }
            Err(e) => {
                log::error!("[APP_ACTIVE] the wait for the main thread failed: {e}");
                None
            }
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        log::debug!("[APP_ACTIVE] not iOS - no active state to ask");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_active_state_is_active() {
        assert!(is_active_state(0));
        assert!(
            !is_active_state(1),
            "inactive: Control Center, a system prompt"
        );
        assert!(!is_active_state(2), "background");
    }
}
