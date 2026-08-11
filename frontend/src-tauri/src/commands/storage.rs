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

// Deletes every .db file in the app data directory.
#[tauri::command]
pub(crate) fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if data_dir.exists() {
        for entry in std::fs::read_dir(data_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("db") {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
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
    /// The local message database: `canari_<userId>.db` plus its WAL/SHM side files.
    /// `clear_app_data`'s `Path::extension()` filter only ever matches the base `.db` file, never
    /// `db-wal`/`db-shm` - a gap worth knowing about but not fixing here. A size REPORT must not
    /// repeat it: those side files can hold a meaningful fraction of what SQLite has on disk
    /// while a write-ahead log is active, so this counts them by substring instead.
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
