//! Concurrency primitives for multi-engine MLS state (`mls.bin`) coordination.
//!
//! On Android, three MLS engines coexist in the SAME process (same .so Rust):
//! foreground (MlsManager via Tauri commands), FCM JNI and Worker JNI.
//! Only FCM<->Worker shared a lock (Kotlin `MlsStateLock`); the foreground didn't
//! participate and never reloaded `mls.bin`. Result: a background advance
//! (Welcome/send/worker) was overwritten on foreground return (lost-update -> SecretReuse).

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
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

/// Number of foreground operations currently holding state a background write would clobber.
///
/// THE DEADLINE ABOVE CANNOT ANSWER THIS AND IT WAS ASKED TO. `sauvegarder_mls_et_persister` locks
/// the manager, spends `save_encrypted_with_key` serialising and encrypting the whole state, and
/// only THEN calls `write_mls_state_blob`, which is the first thing that refreshes the deadline.
/// That middle step cost **48 s** on a Mi 9T with an 8 MB blob. The JS heartbeat that keeps the
/// deadline fresh auto-pauses on `hidden`, so backgrounding the app during a checkpoint lets the
/// guard lapse 30 s in while the checkpoint still has ~18 s to run - and a background engine that
/// loaded `mls.bin` before the checkpoint began is then free to write it back, losing everything
/// the foreground had just done. The window is a function of the checkpoint's cost, which is why
/// the symptom followed the slow checkpoint and never appeared on a 6.9 s one.
///
/// So this is a PROOF rather than a prediction: non-zero exactly while such an operation runs,
/// whatever it costs, and no margin to choose. See `docs/wiki/backlog.md` for the measurement and
/// for the compare-and-swap that would let the deadline stop being load-bearing altogether.
fn foreground_critical_depth() -> &'static AtomicUsize {
    static DEPTH: AtomicUsize = AtomicUsize::new(0);
    &DEPTH
}

/// RAII marker for a foreground operation that must not be clobbered - see
/// [`foreground_critical_depth`]. Held across the WHOLE of a checkpoint, not just its write.
///
/// **WHY THIS DOES NOT REINTRODUCE THE STUCK-TRUE THE DEADLINE WAS CHOSEN TO AVOID.** The original
/// comment is right that a guard which can latch permanently kills background delivery
/// (FCM1/FCM2). `Drop` releases on every exit an unwinding runtime has: normal return, `?`, and
/// panic. What remains is a checkpoint that never finishes at all - and that one also holds the
/// manager mutex, so the foreground engine is already dead and no background write could be
/// reconciled with it anyway.
pub(crate) struct ForegroundCritical;

impl ForegroundCritical {
    /// Enters the critical section. Nests: several foreground writers may hold one at once.
    pub(crate) fn enter() -> Self {
        foreground_critical_depth().fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ForegroundCritical {
    fn drop(&mut self) {
        foreground_critical_depth().fetch_sub(1, Ordering::SeqCst);
    }
}

/// True while the foreground guard holds (the background must then refrain from writing): either a
/// foreground operation is IN FLIGHT, or the heartbeat deadline has not expired.
/// Mobile only: that is where the background writers (`background_write_mls_bin`) live.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn foreground_is_active() -> bool {
    foreground_critical_depth().load(Ordering::SeqCst) > 0
        || now_ms() < foreground_active_until().load(Ordering::SeqCst)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The guards under test are PROCESS-global, so these tests cannot run beside each other or
    /// beside anything else touching them - `cargo test` threads one process.
    fn serialise() -> std::sync::MutexGuard<'static, ()> {
        static M: Mutex<()> = Mutex::new(());
        M.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The defect this file was changed for: the deadline has lapsed (the app is backgrounded and
    /// the heartbeat stopped) while the checkpoint it was supposed to cover is still running.
    #[test]
    fn a_lapsed_deadline_does_not_free_the_background_while_a_checkpoint_runs() {
        let _s = serialise();
        mark_foreground_inactive();
        assert!(
            !foreground_is_active(),
            "precondition: the deadline has lapsed"
        );

        let checkpoint = ForegroundCritical::enter();
        assert!(
            foreground_is_active(),
            "a checkpoint in flight must hold the guard even with no deadline left - this is the \
             48 s window that lost fifty freshly minted key packages"
        );

        drop(checkpoint);
        assert!(
            !foreground_is_active(),
            "and it must release, or background delivery dies"
        );
    }

    /// Several foreground writers may checkpoint at once; the last one out releases.
    #[test]
    fn the_guard_nests() {
        let _s = serialise();
        mark_foreground_inactive();

        let outer = ForegroundCritical::enter();
        let inner = ForegroundCritical::enter();
        drop(inner);
        assert!(
            foreground_is_active(),
            "the outer checkpoint is still running"
        );
        drop(outer);
        assert!(!foreground_is_active());
    }

    /// The stuck-true the deadline was chosen to avoid: a checkpoint that dies must not latch the
    /// guard on for ever.
    #[test]
    fn a_panicking_checkpoint_still_releases_the_guard() {
        let _s = serialise();
        mark_foreground_inactive();

        let panicked = std::panic::catch_unwind(|| {
            let _c = ForegroundCritical::enter();
            panic!("checkpoint exploded");
        });
        assert!(panicked.is_err());
        assert!(
            !foreground_is_active(),
            "Drop runs while unwinding, so a dead checkpoint cannot strand background delivery"
        );
    }

    /// The end the guard exists for, asserted through the writer rather than the predicate.
    #[test]
    fn a_background_write_is_refused_while_a_checkpoint_runs() {
        let _s = serialise();
        mark_foreground_inactive();

        let path = std::env::temp_dir().join(format!("canari-cas-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let checkpoint = ForegroundCritical::enter();
        let refused = background_write_mls_bin(&path, b"background state");
        assert!(
            refused.is_err(),
            "the background must give up, not overwrite"
        );
        assert!(!path.exists(), "and it must not have written anything");

        drop(checkpoint);
        background_write_mls_bin(&path, b"background state")
            .expect("allowed once the checkpoint ends");
        assert_eq!(std::fs::read(&path).unwrap(), b"background state");
        let _ = std::fs::remove_file(&path);
    }
}
