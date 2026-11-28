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

/// The directory of the watcher's per-account files, in the app's data directory. Android's native
/// side reads the same place (`MlsContextLoader.tauriDataDir` + this name).
pub(crate) const MAIL_WATCH_DIR: &str = "mail_watch";

/// The cursor text a page may store: an address and a number in JSON, never more.
const MAX_CURSOR_LEN: usize = 1024;

/// The cursor file of `user_id` in `dir`, or an error for an id outside the account allowlist
/// (refused, never sanitised: a sanitised id names another account's file).
fn cursor_path(dir: &Path, user_id: &str) -> Result<std::path::PathBuf, String> {
    if !super::storage::is_wipeable_account_id(user_id) {
        return Err("an account id outside the allowlist".into());
    }
    Ok(dir
        .join(MAIL_WATCH_DIR)
        .join(format!("cursor_{user_id}.json")))
}

/// The cursor text of `user_id`, `None` when none was written.
pub(crate) fn read_cursor(dir: &Path, user_id: &str) -> Result<Option<String>, String> {
    let path = cursor_path(dir, user_id)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read cursor: {e}")),
    }
}

/// Writes the cursor text of `user_id` ATOMICALLY (a sibling file renamed over it): a process killed
/// mid-write leaves the old cursor or the new one, never half of one.
pub(crate) fn write_cursor(dir: &Path, user_id: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_CURSOR_LEN {
        return Err(format!("a cursor of {} bytes", value.len()));
    }
    let path = cursor_path(dir, user_id)?;
    let parent = path.parent().ok_or("no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, value.as_bytes()).map_err(|e| format!("write cursor: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename cursor: {e}"))
}

/// The Android native watcher's sealed copy of the mailbox password for `user_id` (lot 4b): the
/// ciphertext `MailWatchVault.kt` writes under its Android Keystore key. Same allowlist as the cursor.
fn vault_path(dir: &Path, user_id: &str) -> Result<std::path::PathBuf, String> {
    if !super::storage::is_wipeable_account_id(user_id) {
        return Err("an account id outside the allowlist".into());
    }
    Ok(dir
        .join(MAIL_WATCH_DIR)
        .join(format!("vault_{user_id}.bin")))
}

/// Removes `files`, an absent one not being an error.
fn remove_all(files: &[std::path::PathBuf]) -> Result<(), String> {
    for file in files {
        if let Err(e) = std::fs::remove_file(file) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("remove: {e}"));
            }
        }
    }
    Ok(())
}

/// THE ONE ERASURE of the native sealed password of `user_id` (lot 4b): its ciphertext and a write
/// in flight. Every forget path reaches it - a mail sign-out, an unticked "remember", a refused
/// password, the Canari sign-out (all through `forgetMailPassword`), and through [`forget`] the
/// switch turned off, D8 and the account deletion. The Keystore key is not the account's (it wraps
/// the next copy), so the ciphertext is the whole of what is erased. The native watcher checks the
/// file before each cursor write and each notice, so an erased copy also ends its run. Idempotent.
pub(crate) fn erase_vault(dir: &Path, user_id: &str) -> Result<(), String> {
    let path = vault_path(dir, user_id)?;
    remove_all(&[path.with_extension("bin.tmp"), path])
}

/// Erases everything the watcher keeps natively for `user_id`: its cursor and the sealed password
/// ([`erase_vault`]). Idempotent.
pub(crate) fn forget(dir: &Path, user_id: &str) -> Result<(), String> {
    let path = cursor_path(dir, user_id)?;
    erase_vault(dir, user_id)?;
    remove_all(&[path.with_extension("json.tmp"), path])
}

/// Where the per-account cursor files live. On iOS, the App Group store (mail lot 5): the
/// notification extension reads the cursor above which a mail is new, and writes it after it showed
/// one, so the two processes share ONE durable answer to "already notified". Elsewhere the app's data
/// directory, which lot 4b's native Android watcher reads.
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        crate::app_group::app_group_dir().inspect_err(|e| {
            log::warn!("[MailWatch] the App Group store is unavailable: {e}");
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        app.path().app_data_dir().map_err(|e| {
            log::warn!("[MailWatch] app_data_dir() failed: {e}");
            e.to_string()
        })
    }
}

/// The page reads its cursor (the apps keep it here, not in `localStorage`, mail lot 4).
#[tauri::command]
pub(crate) fn mail_watch_cursor_read(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<Option<String>, String> {
    let found = read_cursor(&data_dir(&app)?, &user_id)
        .inspect_err(|e| log::warn!("[MailWatch] cursor not read: {e}"))?;
    log::debug!("[MailWatch] cursor read (present={})", found.is_some());
    Ok(found)
}

/// The page writes its cursor.
#[tauri::command]
pub(crate) fn mail_watch_cursor_write(
    app: tauri::AppHandle,
    user_id: String,
    value: String,
) -> Result<(), String> {
    write_cursor(&data_dir(&app)?, &user_id, &value)
        .inspect_err(|e| log::warn!("[MailWatch] cursor not written: {e}"))?;
    log::debug!("[MailWatch] cursor written ({} bytes)", value.len());
    Ok(())
}

/// D8, the switch turned off, the account's local wipe: the native mail watch state goes - the
/// cursor, and the notification extension's copy of the mailbox password (mail lot 5), which is
/// wanted only while the switch is on.
#[tauri::command]
pub(crate) fn mail_watch_forget(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    super::mail_push_secret::erase()
        .inspect_err(|e| log::warn!("[MailWatch] the extension's password copy not erased: {e}"))?;
    forget(&data_dir(&app)?, &user_id)
        .inspect_err(|e| log::warn!("[MailWatch] not forgotten: {e}"))?;
    log::info!("[MailWatch] native mail watch state erased");
    Ok(())
}

/// The remembered password is forgotten (a mail sign-out, unticked, refused, the Canari sign-out):
/// the native watcher's copy goes with it.
#[tauri::command]
pub(crate) fn mail_watch_vault_erase(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    erase_vault(&data_dir(&app)?, &user_id)
        .inspect_err(|e| log::warn!("[MailWatch] native password copy not erased: {e}"))?;
    log::info!("[MailWatch] native password copy erased");
    Ok(())
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

    #[test]
    fn the_cursor_is_kept_per_account_and_forgotten() {
        let dir = std::env::temp_dir().join(format!("canari-mail-cursor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_cursor(&dir, "alice").unwrap(), None);
        write_cursor(&dir, "alice", r#"{"v":1}"#).unwrap();
        write_cursor(&dir, "bob", "b").unwrap();
        assert_eq!(
            read_cursor(&dir, "alice").unwrap().as_deref(),
            Some(r#"{"v":1}"#)
        );
        forget(&dir, "alice").unwrap();
        forget(&dir, "alice").expect("forgotten twice");
        assert_eq!(read_cursor(&dir, "alice").unwrap(), None);
        assert_eq!(
            read_cursor(&dir, "bob").unwrap().as_deref(),
            Some("b"),
            "another account is untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sealed_copy_is_erased_alone_or_with_the_cursor_and_never_another_accounts() {
        let dir = std::env::temp_dir().join(format!("canari-mail-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = |u: &str| dir.join(MAIL_WATCH_DIR).join(format!("vault_{u}.bin"));
        std::fs::create_dir_all(dir.join(MAIL_WATCH_DIR)).unwrap();
        for u in ["alice", "bob"] {
            std::fs::write(vault(u), b"sealed").unwrap();
        }
        std::fs::write(vault("alice").with_extension("bin.tmp"), b"half").unwrap();
        write_cursor(&dir, "alice", "c").unwrap();
        // A mail sign-out: the copy goes, the cursor stays.
        erase_vault(&dir, "alice").unwrap();
        erase_vault(&dir, "alice").expect("erased twice");
        assert!(!vault("alice").exists());
        assert!(!vault("alice").with_extension("bin.tmp").exists());
        assert_eq!(read_cursor(&dir, "alice").unwrap().as_deref(), Some("c"));
        // The switch off / D8 / deletion: both go.
        std::fs::write(vault("alice"), b"sealed").unwrap();
        forget(&dir, "alice").unwrap();
        assert!(!vault("alice").exists());
        assert_eq!(read_cursor(&dir, "alice").unwrap(), None);
        assert!(vault("bob").exists(), "another account is untouched");
        assert!(erase_vault(&dir, "../bob").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_id_outside_the_allowlist_or_an_oversized_cursor_is_refused() {
        let dir =
            std::env::temp_dir().join(format!("canari-mail-cursor-bad-{}", std::process::id()));
        assert!(write_cursor(&dir, "../x", "1").is_err());
        assert!(read_cursor(&dir, "a/b").is_err());
        assert!(forget(&dir, "").is_err());
        assert!(write_cursor(&dir, "alice", &"x".repeat(MAX_CURSOR_LEN + 1)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
