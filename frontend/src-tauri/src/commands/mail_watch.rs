//! The iOS background refresh's ONE flag for the new-mail watcher (lot 4,
//! docs/wiki/mail-client-transport.md#as-built---lot-4).
//!
//! iOS freezes the app in the background, so the watcher (in the page) cannot wait there; the system's
//! background refresh (`BGAppRefreshTask`, `canari_ios.mm`) asks the page for one check when it
//! allows. Whether to keep asking is a fact the page decides - the account's switch, the server's
//! `mail_mode`, a mailbox still open - and the native side reads it at every background entry and
//! after every run, with no page to ask. So it is ONE file, [`MAIL_WATCH_FLAG_FILE`] in the app's data
//! directory, present while the refresh is wanted, written by the call that changes the want (durable
//! rules: a copy for another process is written by the call that changes the value, never by a
//! lifecycle hook). It holds nothing: its presence is the whole fact.

use std::path::Path;

use tauri::Manager;

/// The flag's file name, beside `fcm_token.txt` in the app's data directory. `canari_ios.mm` reads the
/// same name (`kCanariMailWatchFlagFile`).
pub(crate) const MAIL_WATCH_FLAG_FILE: &str = "mail_watch_on";

/// Writes (`on`) or removes the flag in `dir`. Idempotent: an absent file removed is not an error.
pub(crate) fn write_flag(dir: &Path, on: bool) -> Result<(), String> {
    let path = dir.join(MAIL_WATCH_FLAG_FILE);
    if on {
        std::fs::create_dir_all(dir).map_err(|e| format!("create data dir: {e}"))?;
        std::fs::write(&path, b"").map_err(|e| format!("write flag: {e}"))?;
    } else if let Err(e) = std::fs::remove_file(&path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("remove flag: {e}"));
        }
    }
    Ok(())
}

/// The page's one call: the background refresh is wanted (`on`) or not.
#[tauri::command]
pub(crate) fn mail_watch_flag(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    log::info!("[MailWatch] background refresh flag -> {on}");
    let dir = app.path().app_data_dir().map_err(|e| {
        log::warn!("[MailWatch] app_data_dir() failed: {e}");
        e.to_string()
    })?;
    write_flag(&dir, on).inspect_err(|e| log::warn!("[MailWatch] flag not written: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_written_and_removed_idempotently() {
        let dir = std::env::temp_dir().join(format!("canari-mail-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_flag(&dir, false).expect("removing an absent flag is not an error");
        write_flag(&dir, true).expect("written");
        assert!(dir.join(MAIL_WATCH_FLAG_FILE).exists());
        write_flag(&dir, true).expect("written twice");
        write_flag(&dir, false).expect("removed");
        assert!(!dir.join(MAIL_WATCH_FLAG_FILE).exists());
        write_flag(&dir, false).expect("removed twice");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
