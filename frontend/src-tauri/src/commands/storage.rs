//! Storage Tauri commands: persistence, reload, heartbeat, flags.

use crate::concurrency::{mark_foreground_active, mls_bin_write_lock, write_mls_state_blob};
use crate::state::AppState;
use mls_core::MlsManager;
use tauri::Manager;

/// Write an already-encrypted MLS state blob into {app_data_dir}/mls.bin.
/// Accepts the encrypted bytes (as number[] from JS) and writes them verbatim.
/// This is used by the frontend when it already holds an encrypted state and
/// wants to persist it to the native app data directory (avoid WebView eviction).
#[tauri::command]
pub(crate) fn save_mls_state(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    write_mls_state_blob(&app, &data)
}

/// C2: reloads `mls.bin` from disk into the in-memory foreground manager, under the global lock,
/// and marks the foreground active. Called on foreground return BEFORE any operation: while in the
/// background a JNI engine (Welcome/send/worker) may have advanced `mls.bin`; without this reload
/// the hot manager is stale and its next persist would OVERWRITE the background advance
/// (lost-update -> SecretReuse + epoch regression). Returns `true` if a reload happened, `false` if
/// `mls.bin` is absent (nothing to do). Callers are mobile-only (no background engine on desktop).
#[tauri::command]
pub(crate) async fn recharger_mls_au_resume(
    user_id: String,
    device_id: String,
    device_key_b64: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    // Mark active BEFORE reading: any in-flight background write completes (lock) and subsequent
    // ones give up -> the read below picks up the latest background advance.
    mark_foreground_active();
    let manager_state = state.mls_manager.clone();
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = data_dir.join("mls.bin");
        // Read the file UNDER the lock (never read while a JNI engine writes). Released before the
        // decrypt (direct ChaCha20 via device key): the foreground guard now blocks any new write.
        let bytes = {
            let _guard = mls_bin_write_lock()
                .lock()
                .map_err(|_| "mls_bin write lock poisoned".to_string())?;
            match std::fs::read(&path) {
                Ok(b) => Some(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(format!("read mls.bin: {e}")),
            }
        };
        let Some(bytes) = bytes else {
            log::debug!("[RESUME] mls.bin absent - nothing to reload (C2)");
            return Ok(false);
        };
        let key = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"))?;
        let candidate = MlsManager::load_with_key(&user_id, &device_id, Some(bytes), &key)
            .map_err(|e| format!("reload mls.bin: {e}"))?;
        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        // Epoch-monotonic reload guard (C2): a snapshot must never regress a live group's epoch.
        // If the live manager already holds a group at a higher epoch than the reloaded candidate
        // (e.g. a stale mls.bin), keep the live state rather than clobber it. [[C2]]
        if let Some(current) = lock.as_ref() {
            if !current.reload_is_monotonic(&candidate) {
                log::warn!(
                    "[RESUME] reload refused - mls.bin would regress a live group epoch, keeping live state (C2)"
                );
                return Ok(false);
            }
        }
        *lock = Some(candidate);
        log::debug!("[RESUME] foreground manager reloaded from mls.bin (C2)");
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Foreground heartbeat: refreshes the guard while the WebView is visible. As long as it stays
/// fresh, background JNI engines give up their `mls.bin` writes (C1/FCM3).
#[tauri::command]
pub(crate) fn mls_foreground_heartbeat() {
    mark_foreground_active();
}

/// Releases the foreground guard (moving to the background): immediately allows JNI engines to
/// write `mls.bin`. The guard would expire anyway after FOREGROUND_GRACE_MS; this speeds up the
/// clean case (`hidden` event received) so background delivery is not delayed.
#[tauri::command]
pub(crate) fn pause_mls_foreground() {
    crate::concurrency::mark_foreground_inactive();
}

#[tauri::command]
pub(crate) fn delete_mls_state(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("mls.bin");
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Reads {app_data_dir}/mls.bin and returns its encrypted contents.
/// Returns None when the file does not exist (first install).
/// Used at startup on mobile when localStorage is empty (WebView cleared).
#[tauri::command]
pub(crate) fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[MLS] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join("mls.bin");
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("[MLS] read mls.bin: {e}");
            None
        }
    }
}

/// Entries at the top of `{app_data_dir}` that this must NOT empty wholesale, for one of two
/// reasons: they belong to a framework, or Canari only owns part of what is inside (`files` and
/// `shared_prefs`, both emptied selectively below - and a first draft of this constant omitted
/// those two, which deleted Firebase's installation id and left both prefix lists dead code).
///
/// Everything else at that level is deleted, so the default for a file added tomorrow is ERASED.
/// The filter this replaced kept only `*.db`, which is why a device revoked on 2026-08-28 was
/// measured still holding `graine_seeds.json` - the seeds the background service decrypts push
/// payloads with - plus `channel_keys.json`, `push_context.json`, `fcm_token.txt` and
/// `session-meta.json`. None of them carries the one extension the filter could see, and every
/// one of them was added AFTER it: a wipe whose default is SURVIVE is wrong the day the next file
/// lands, and nothing tells you.
///
/// `app_webview` is the store the RUNNING WebView reads out of and `no_backup` holds
/// WorkManager's live database. Deleting either from under its owner is the process-killing
/// mistake that already cost this wipe every step after its first; they are cleared through
/// their own APIs instead - the WebView stores by `deviceReset.ts`, measured empty the same day.
const KEPT_AT_TOP_LEVEL: &[&str] = &[
    "app_textures",
    "app_webview",
    "cache",
    "code_cache",
    "databases",
    "lib",
    "no_backup",
    // Shared with Firebase - emptied by prefix, not wholesale.
    "files",
    "shared_prefs",
];

/// Names inside `{app_data_dir}/files`, a directory Canari SHARES with Firebase, that are ours.
/// `avatar_<hash>.jpg` is written by `CanariFirebaseMessagingService` so a notification can show
/// a face: cached photographs of real people, which is exactly what a revocation must not leave.
const OUR_FILES_PREFIXES: &[&str] = &["avatar_"];

/// Names inside `{app_data_dir}/shared_prefs` that are ours. `keystore_aliases.xml` is spelled
/// out because it carries no `canari_` prefix: it maps the MLS device-key aliases, so leaving it
/// behind leaves a revoked device the index of its own keys.
const OUR_PREFS_PREFIXES: &[&str] = &["canari_", "keystore_aliases"];

/// Erases every trace of the account this device held, natively.
///
/// Pairs with the WebView half in `deviceReset.ts`: this owns the native app data directory,
/// that one owns the stores inside the engine. Both are best-effort by design, so a single
/// unremovable entry must not abandon the rest - each failure is logged and carried, and the
/// error returned at the end names how many there were.
#[tauri::command]
pub(crate) fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    wipe_app_data(&data_dir)
}

/// The whole of `clear_app_data` minus the `AppHandle`, so it can be tested against a real
/// directory. A wipe is the one operation whose bug is invisible until someone reads the disk.
pub(crate) fn wipe_app_data(data_dir: &std::path::Path) -> Result<(), String> {
    if !data_dir.exists() {
        log::debug!("[RESET] no native app data directory - nothing to wipe");
        return Ok(());
    }
    let mut removed = 0usize;
    let mut failures = 0usize;

    match std::fs::read_dir(data_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        log::warn!("[RESET] unreadable entry in the app data directory: {e}");
                        failures += 1;
                        continue;
                    }
                };
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                if KEPT_AT_TOP_LEVEL.contains(&name.as_str()) {
                    log::debug!("[RESET] leaving {name} to its owner");
                    continue;
                }
                remove_entry(&path, &mut removed, &mut failures);
            }
        }
        Err(e) => return Err(format!("read the app data directory: {e}")),
    }

    wipe_by_prefix(
        &data_dir.join("files"),
        OUR_FILES_PREFIXES,
        &mut removed,
        &mut failures,
    );
    wipe_by_prefix(
        &data_dir.join("shared_prefs"),
        OUR_PREFS_PREFIXES,
        &mut removed,
        &mut failures,
    );

    log::info!("[RESET] native wipe removed {removed} entries, {failures} failed");
    if failures == 0 {
        Ok(())
    } else {
        Err(format!("{failures} native entries could not be removed"))
    }
}

/// Deletes the entries of `dir` whose name starts with one of `prefixes`, for the two
/// directories Canari shares with a framework and therefore cannot empty wholesale.
fn wipe_by_prefix(
    dir: &std::path::Path,
    prefixes: &[&str],
    removed: &mut usize,
    failures: &mut usize,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("[RESET] read {}: {e}", dir.display());
            *failures += 1;
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if prefixes.iter().any(|p| name.starts_with(p)) {
            remove_entry(&path, removed, failures);
        }
    }
}

/// Removes one file or directory tree, counting the outcome. Logs at a level that ACCUSES on
/// failure: what a wipe leaves behind is only ever found by reading the disk afterwards.
fn remove_entry(path: &std::path::Path, removed: &mut usize, failures: &mut usize) {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Ok(()) => *removed += 1,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::error!("[RESET] could not remove {}: {e}", path.display());
            *failures += 1;
        }
    }
}

/// Stores a boolean flag in {app_data_dir}/native_flags.json.
/// Used to persist UI flags (e.g. biometric enrollment) outside the WebView
/// storage layer, which MIUI and other aggressive OEMs may clear between sessions.
#[tauri::command]
pub(crate) fn set_native_flag(
    key: String,
    value: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("native_flags.json");
    let mut flags: serde_json::Map<String, serde_json::Value> = if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    flags.insert(key, serde_json::Value::Bool(value));
    std::fs::write(&path, serde_json::Value::Object(flags).to_string()).map_err(|e| e.to_string())
}

/// Removes one flag from `native_flags.json`, deleting the file when nothing is left in it.
///
/// `set_native_flag(key, false)` says the same thing to every READER - `get_native_flags` cannot
/// tell an absent key from a `false` one - but not on disk, and that difference is load-bearing
/// exactly once. The device wipe runs `BiometricService.forget` as its LAST step, by a rule and a
/// guard test, which is AFTER `clear_app_data`: a flag written there re-creates the file the wipe
/// had just deleted, and a criterion reading the disk then has to carve out an exception for it.
/// Exceptions in a wipe's criterion are how this one stayed broken twice.
#[tauri::command]
pub(crate) fn remove_native_flag(key: String, app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    remove_flag(&data_dir, &key)
}

/// `remove_native_flag` minus the `AppHandle`, so the file it must NOT recreate can be tested.
fn remove_flag(data_dir: &std::path::Path, key: &str) -> Result<(), String> {
    let path = data_dir.join("native_flags.json");
    if !path.exists() {
        log::debug!("[Flags] no native_flags.json - {key} is already absent");
        return Ok(());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut flags: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&bytes).unwrap_or_default();
    if flags.remove(key).is_none() {
        return Ok(());
    }
    if flags.is_empty() {
        log::debug!("[Flags] {key} was the last flag - removing native_flags.json");
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    } else {
        std::fs::write(&path, serde_json::Value::Object(flags).to_string())
            .map_err(|e| e.to_string())
    }
}

/// Name of the file `CanariApplication.onCreate` (Kotlin) writes the installing package
/// name into. Cross-process contract with the Android side - pinned by
/// `frontend/src/lib/mobile/installerPackageContract.test.ts`, which is the only thing
/// standing between a rename here and a reader that silently finds nothing.
const INSTALLER_PACKAGE_FILE: &str = "installer_package.txt";

/// Reads the package that installed this app, as recorded by the Android side at startup
/// (`com.android.vending` for Google Play, something else or empty for a sideload).
///
/// The frontend needs this because the Play build and the GitHub APK carry DIFFERENT
/// signatures - neither can install over the other - so the update destination depends on
/// how this install actually arrived. Returns `None` off Android, and whenever the file is
/// missing or empty; the caller decides what an unknown source means.
#[tauri::command]
pub(crate) fn get_installer_package(app: tauri::AppHandle) -> Option<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[Installer] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join(INSTALLER_PACKAGE_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::debug!("[Installer] {INSTALLER_PACKAGE_FILE} unreadable: {e}");
            return None;
        }
    };
    let installer = raw.trim();
    if installer.is_empty() {
        log::debug!("[Installer] no installing package recorded (sideload or adb install)");
        return None;
    }
    log::debug!("[Installer] installing package: {installer}");
    Some(installer.to_string())
}

/// Bucketed disk usage of `{app_data_dir}`, for the Settings storage panel (WP-DEVICESTORAGE-1).
#[derive(serde::Serialize)]
pub(crate) struct LocalStorageUsage {
    /// The local message database: `canari_<userId>.db` plus its WAL/SHM side files, counted by
    /// substring rather than by extension. Those side files can hold a meaningful fraction of
    /// what SQLite has on disk while a write-ahead log is active, so a size REPORT that matched
    /// only `.db` would understate the total - which is exactly the reading `clear_app_data` used
    /// to make when it DELETED by extension, and how `mls_pending.db-wal` outlived a wipe.
    messages_bytes: u64,
    /// `mls.bin` - the MLS encryption state. Reported separately and must NEVER be offered as
    /// part of a "clear cache" action: it is identity and key material, not a cache.
    encryption_state_bytes: u64,
    /// Everything else in the app data directory (outbox mirror, FCM cache, push context, native
    /// flags, the installer-package marker) - individually tiny, lumped together on purpose
    /// rather than growing this struct one field per file.
    other_bytes: u64,
}

/// Walks `{app_data_dir}` once and buckets every file's size. Read-only - pairs with the
/// JS-side Cache Storage measurement (media/avatar/logo caches), which this command knows
/// nothing about since those live inside the WebView, not the native app data directory.
#[tauri::command]
pub(crate) fn get_local_storage_usage(app: tauri::AppHandle) -> Result<LocalStorageUsage, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut usage = LocalStorageUsage {
        messages_bytes: 0,
        encryption_state_bytes: 0,
        other_bytes: 0,
    };
    if !data_dir.exists() {
        return Ok(usage);
    }
    for entry in std::fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "mls.bin" {
            usage.encryption_state_bytes += size;
        } else if name.starts_with("canari_") && name.contains(".db") {
            usage.messages_bytes += size;
        } else {
            usage.other_bytes += size;
        }
    }
    Ok(usage)
}

/// Reads all boolean flags from {app_data_dir}/native_flags.json.
/// Returns an empty object if the file does not exist yet.
#[tauri::command]
pub(crate) fn get_native_flags(app: tauri::AppHandle) -> serde_json::Value {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[Flags] app_data_dir() failed: {e}");
            return serde_json::Value::Object(serde_json::Map::new());
        }
    };
    let path = data_dir.join("native_flags.json");
    if !path.exists() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-wipe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(dir: &Path, rel: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    /// The measurement of 2026-08-28, as a test: a revoked device kept its Graine seeds, its
    /// channel keys, its push session and its FCM token, because none of them ends in `.db`.
    /// Against the extension filter this replaced, exactly ONE of these names disappeared.
    #[test]
    fn erases_what_a_revocation_must_not_leave() {
        let dir = temp_dir("revoked");
        for name in [
            "graine_seeds.json",
            "channel_keys.json",
            "push_context.json",
            "session-meta.json",
            "oidc-state.json",
            "fcm_token.txt",
            "keystore_ok.flag",
            "native_flags.json",
            "installer_package.txt",
            "mls.bin",
            "mls_pending.db",
            "mls_pending.db-wal",
            "mls_pending.db-shm",
            "canari_user.db",
        ] {
            file(&dir, name);
        }
        file(&dir, "logs/app.log");

        wipe_app_data(&dir).unwrap();

        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.is_empty(), "the wipe left {left:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The other half of the same rule: a wipe that deletes the store its own engine is reading
    /// out of kills the process, and every step after it becomes collateral.
    #[test]
    fn leaves_the_stores_their_owners_are_still_reading() {
        let dir = temp_dir("owners");
        file(&dir, "app_webview/Default/Local Storage/leveldb/CURRENT");
        file(&dir, "no_backup/androidx.work.workdb");
        file(&dir, "cache/WebView/blob");
        file(&dir, "code_cache/x");
        file(&dir, "app_textures/x");
        file(&dir, "databases/x");
        file(&dir, "graine_seeds.json");

        wipe_app_data(&dir).unwrap();

        assert!(dir
            .join("app_webview/Default/Local Storage/leveldb/CURRENT")
            .exists());
        assert!(dir.join("no_backup/androidx.work.workdb").exists());
        assert!(dir.join("cache/WebView/blob").exists());
        assert!(dir.join("code_cache/x").exists());
        assert!(dir.join("app_textures/x").exists());
        assert!(dir.join("databases/x").exists());
        assert!(!dir.join("graine_seeds.json").exists(), "ours was kept");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `files/` and `shared_prefs/` are shared with Firebase, so they are the two directories
    /// this cannot empty wholesale - and the two where a prefix list can go stale silently.
    #[test]
    fn empties_only_our_share_of_the_two_shared_directories() {
        let dir = temp_dir("shared");
        file(&dir, "files/avatar_deadbeef.jpg");
        file(&dir, "files/PersistedInstallation.W0RFRkFVTFRd.json");
        file(&dir, "files/generatefid.lock");
        file(&dir, "shared_prefs/keystore_aliases.xml");
        file(&dir, "shared_prefs/canari_push_prefs.xml");
        file(&dir, "shared_prefs/canari_notif_ids.xml");
        file(&dir, "shared_prefs/com.google.android.gms.appid.xml");
        file(&dir, "shared_prefs/WebViewChromiumPrefs.xml");

        wipe_app_data(&dir).unwrap();

        assert!(
            !dir.join("files/avatar_deadbeef.jpg").exists(),
            "a cached face survived"
        );
        assert!(
            !dir.join("shared_prefs/keystore_aliases.xml").exists(),
            "the alias index survived"
        );
        assert!(!dir.join("shared_prefs/canari_push_prefs.xml").exists());
        assert!(!dir.join("shared_prefs/canari_notif_ids.xml").exists());
        assert!(dir
            .join("files/PersistedInstallation.W0RFRkFVTFRd.json")
            .exists());
        assert!(dir.join("files/generatefid.lock").exists());
        assert!(dir
            .join("shared_prefs/com.google.android.gms.appid.xml")
            .exists());
        assert!(dir.join("shared_prefs/WebViewChromiumPrefs.xml").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reason `remove_native_flag` exists rather than `set_native_flag(key, false)`: the wipe's
    /// LAST step must not put back the file the wipe deleted.
    #[test]
    fn removing_the_last_flag_removes_the_file() {
        let dir = temp_dir("flags");
        let path = dir.join("native_flags.json");
        std::fs::write(&path, br#"{"biometricConfigured":true}"#).unwrap();

        remove_flag(&dir, "biometricConfigured").unwrap();

        assert!(!path.exists(), "the file survived its last flag");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// And it must not take the OTHER flags with it - `biometricPromptDismissed` lives in the same
    /// file and is written by a different call site.
    #[test]
    fn removing_one_flag_keeps_the_others() {
        let dir = temp_dir("flags-kept");
        let path = dir.join("native_flags.json");
        std::fs::write(
            &path,
            br#"{"biometricConfigured":true,"biometricPromptDismissed":true}"#,
        )
        .unwrap();

        remove_flag(&dir, "biometricConfigured").unwrap();

        let left: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            left["biometricPromptDismissed"],
            serde_json::Value::Bool(true)
        );
        assert!(left.get("biometricConfigured").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A wipe that already deleted the file calls this anyway, and it must not recreate it.
    #[test]
    fn removing_a_flag_from_nothing_creates_nothing() {
        let dir = temp_dir("flags-gone");
        remove_flag(&dir, "biometricConfigured").unwrap();
        assert!(!dir.join("native_flags.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fresh install has neither directory, and a wipe with nothing to do is not a failure -
    /// `deviceReset.ts` runs this on the login page, where there may never have been an account.
    #[test]
    fn nothing_to_wipe_is_not_a_failure() {
        let dir = temp_dir("empty");
        wipe_app_data(&dir).unwrap();
        wipe_app_data(&dir.join("never-existed")).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
