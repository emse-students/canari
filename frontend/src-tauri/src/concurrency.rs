//! Concurrency primitives for multi-engine MLS state (`mls.bin`) coordination.
//!
//! On Android, three MLS engines coexist in the SAME process (same .so Rust):
//! foreground (MlsManager via Tauri commands), FCM JNI and Worker JNI.
//! Only FCM<->Worker shared a lock (Kotlin `MlsStateLock`); the foreground didn't
//! participate and never reloaded `mls.bin`. Result: a background advance
//! (Welcome/send/worker) was overwritten on foreground return (lost-update -> SecretReuse).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

/// Process-global lock serializing `mls.bin` WRITES across the three engines. Held briefly, just
/// around the atomic write. `nativeDecryptMessage` does not write (ephemeral manager) -> not
/// concerned. (C1)
pub(crate) fn mls_bin_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Deadline (ms since epoch) until which the foreground is considered active. While
/// `now < deadline`, background JNI writes GIVE UP rather than overwrite the state the foreground
/// holds in memory and has not reloaded yet. Refreshed by heartbeat while the WebView is visible;
/// expires on its own if the foreground dies or freezes -> NO stuck-true that would kill background
/// delivery (FCM1/FCM2 regression). (C1 / FCM3)
fn foreground_active_until() -> &'static AtomicI64 {
    static UNTIL: AtomicI64 = AtomicI64::new(0);
    &UNTIL
}

/// Foreground heartbeat margin: must comfortably exceed its cadence (10 s) so the guard does not
/// expire while the app really is in the foreground.
const FOREGROUND_GRACE_MS: i64 = 30_000;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Refreshes the foreground guard (heartbeat, resume, or foreground write).
pub(crate) fn mark_foreground_active() {
    foreground_active_until().store(now_ms() + FOREGROUND_GRACE_MS, Ordering::SeqCst);
}

/// Releases the foreground guard (moving to the background).
pub(crate) fn mark_foreground_inactive() {
    foreground_active_until().store(0, Ordering::SeqCst);
}

/// True while the foreground guard has not expired (the background must then refrain from writing).
/// Mobile only: that is where the background writers (`background_write_mls_bin`) live.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn foreground_is_active() -> bool {
    now_ms() < foreground_active_until().load(Ordering::SeqCst)
}

/// Writes `mls.bin` from the background under the global lock, UNLESS the foreground is active (in
/// which case it gives up: the foreground holds the up-to-date state in memory and would overwrite
/// it - C1/FCM3). The "foreground active" error leaves the work pending, picked up on the next
/// foreground pass.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_write_mls_bin(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if foreground_is_active() {
        return Err("foreground active - background mls.bin write abandoned (C1/FCM3)".to_string());
    }
    write_mls_bin_atomically(path, data)
}

/// Writes `data` to `path` atomically: write to a temporary file followed by a `rename(2)`, which
/// is atomic on Linux/Android within the same filesystem. Guarantees a reader never sees a
/// partially written file.
pub(crate) fn write_mls_bin_atomically(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("write mls.bin.tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename mls.bin.tmp -> mls.bin: {e}"))
}

/// Writes the MLS state to `{app_data_dir}/mls.bin` under the global lock, refreshing the
/// foreground guard.
pub(crate) fn write_mls_state_blob(app: &tauri::AppHandle, data: &[u8]) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // A foreground write proves the foreground is alive: refresh the guard so background engines
    // refrain from writing in parallel (C1/FCM3). Global lock held briefly around the atomic write.
    mark_foreground_active();
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    write_mls_bin_atomically(&data_dir.join("mls.bin"), data)
}
