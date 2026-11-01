//! Whether the iPhone app is ACTIVE, ASKED by the page rather than only told to it.
//!
//! The page holds the answer in `window.__canariActive`, which `CanariPushActiveToPage`
//! (canari_ios.mm) writes on every transition. A push can be LOST - `evaluateJavaScript` failed, or
//! no WebView existed yet - and a page left on `false` while the app is in front withholds every
//! queued frame (`appActive.ts`). So the page also asks, on load and on every `visibilitychange`,
//! and this is the answer.
//!
//! THE SAME FACT THE EXTENSION READS: `app_in_foreground` in the App Group, written by
//! `CanariSetAppGroupForegroundFlag` from the very callbacks that push the page's value
//! (`didBecomeActive` sets it, `willResignActive` and every launch clear it). Reading the static
//! `g_isInForeground` is not possible from here: `libapp.a` is linked into the notification
//! extension too, and an app-only symbol would leave its link undefined (`app_group.rs`).

// Everything but the command is reached only on iOS (and by the host tests).
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::path::Path;

/// The App Group flag present while the app is active - twin of `appInForegroundFile`
/// (`NotificationService.swift`) and of the name `CanariSetAppGroupForegroundFlag` writes.
pub(crate) const APP_ACTIVE_FLAG_FILE: &str = "app_in_foreground";

/// Whether the flag is present in `dir`. A STAT, never a read. An error is not "inactive": it is
/// returned, so the caller says it does not know.
pub(crate) fn app_active_in(dir: &Path) -> Result<bool, String> {
    let flag = dir.join(APP_ACTIVE_FLAG_FILE);
    let present = flag
        .try_exists()
        .map_err(|e| format!("the active flag could not be stat'ed: {e}"))?;
    log::debug!("[APP_ACTIVE] flag present={present}");
    Ok(present)
}

/// The app's active state as the native side holds it: `Some(true|false)` on iOS, `None` where the
/// question has no answer - off iOS, or an App Group that could not be read (logged as an error,
/// because the page then keeps a value it cannot check).
#[tauri::command]
pub(crate) fn ios_app_active() -> Option<bool> {
    #[cfg(target_os = "ios")]
    {
        let dir = match crate::app_group::app_group_dir() {
            Ok(d) => d,
            Err(e) => {
                log::error!(
                    "[APP_ACTIVE] App Group unavailable - the active state cannot be asked: {e}"
                );
                return None;
            }
        };
        match app_active_in(&dir) {
            Ok(active) => Some(active),
            Err(e) => {
                log::error!("[APP_ACTIVE] {e}");
                None
            }
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        log::debug!("[APP_ACTIVE] not iOS - no active state to ask");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_present_is_active_and_absent_is_not() {
        let dir = std::env::temp_dir().join(format!("app_active_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create dir");
        assert_eq!(app_active_in(&dir), Ok(false));
        std::fs::write(dir.join(APP_ACTIVE_FLAG_FILE), b"").expect("write flag");
        assert_eq!(app_active_in(&dir), Ok(true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
