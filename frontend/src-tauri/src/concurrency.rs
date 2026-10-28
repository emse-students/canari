//! Concurrency primitives for multi-engine MLS state (`mls.bin`) coordination.
//!
//! On Android, three MLS engines coexist in the SAME process (same .so Rust):
//! foreground (MlsManager via Tauri commands), FCM JNI and Worker JNI.
//! Only FCM<->Worker shared a lock (Kotlin `MlsStateLock`); the foreground didn't
//! participate and never reloaded `mls.bin`. Result: a background advance
//! (Welcome/send/worker) was overwritten on foreground return (lost-update -> SecretReuse).

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

/// Process-global lock serializing `mls.bin` WRITES across the three engines. Held briefly, just
/// around the atomic write. `nativeDecryptMessage` does not write (ephemeral manager) -> not
/// concerned. (C1)
pub(crate) fn mls_bin_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Process-global lock ORDERING the foreground engine's own checkpoints: held from before the export
/// until `mls.bin` is written, by every foreground path that writes the file from the live manager
/// or reads it into the live manager.
///
/// **IT EXISTS BECAUSE THE MANAGER LOCK NO LONGER SPANS THE WRITE** (see [`checkpoint_live_manager`]).
/// While it did, the manager mutex gave two guarantees for free, and both must survive its release:
///
/// - **An older checkpoint never lands over a newer one.** Two checkpoints export in the order they
///   take this lock and write before releasing it, so the file only ever moves forward.
/// - **A resume reload never reads a file a checkpoint is about to replace.** The export clears
///   `has_unsaved_ratchet_advance`, so between the export and the write the live manager says it is
///   NOT ahead of a file that is still behind it. `recharger_mls_au_resume` takes this lock first,
///   so it waits for the write and then reads it.
///
/// Lock order: THIS, then the manager mutex, then [`mls_bin_write_lock`]. Background JNI engines
/// never take it: they are fenced by [`ForegroundCritical`] and the deadline, exactly as before.
///
/// **IT RETURNS THE GUARD, AND A POISONED LOCK IS TAKEN ANYWAY.** It guards an ORDER, not data: a
/// writer that panicked while holding it left nothing behind to be inconsistent (the file write is
/// tmp + rename), so refusing every later checkpoint, mint and resume for the rest of the process
/// would turn one panic into an app that can never persist again. The panic is named, not hidden.
pub(crate) fn foreground_checkpoint_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| {
            log::error!(
                "[MLS] the checkpoint ordering lock was poisoned by a writer that PANICKED while holding it - taken anyway, it guards an order and no data"
            );
            poisoned.into_inner()
        })
}

/// Checkpoints the live manager, holding the manager lock ONLY for the export, and returns the
/// sealed length.
///
/// **THE MANAGER LOCK USED TO SPAN EXPORT + SEAL + WRITE, AND ON ANDROID THAT FROZE THE SCREEN.** A
/// synchronous command (`envoyer_message_bytes`, `confirmer_commit`) runs inside the WebView's
/// JavaScript bridge call, so waiting for this lock blocked the JS thread itself: 1.6-3.2 s per call,
/// 21.8 s of a 38.9 s profile on the Mi 9T (debug build, 2026-10-13 - see
/// `docs/wiki/frontend/community-open-slowness-mi9t-2026-10-13.md`). Only the export reads the
/// state; the seal and the write work on the exported copy, so the lock is released between them.
///
/// What the release does NOT change: the caller still resolves only once the file is written (the
/// durability contract of `persistState`), the write is still the atomic tmp + rename under
/// [`mls_bin_write_lock`], and a mutation landing after the export is simply not in this snapshot -
/// its own dirty bit (`invalidate` / `invalidate_ratchet`) is set AFTER the export cleared it, so
/// the next checkpoint and the resume guard both see it. Ordering is [`foreground_checkpoint_lock`]'s.
pub(crate) fn checkpoint_live_manager(
    manager_state: &Mutex<Option<mls_core::MlsManager>>,
    key: &[u8; 32],
    write: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<usize, String> {
    let _ordered = foreground_checkpoint_lock();
    let started = std::time::Instant::now();
    let (plain, ratchet_was_unsaved) = {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = crate::state::live_manager(&lock)?;
        let ahead = manager.has_unsaved_ratchet_advance();
        (manager.save_state().map_err(|e| e.to_string())?, ahead)
    };
    let exported = started.elapsed();
    let written = mls_core::MlsManager::encrypt_state_blob_with_key(&plain, key)
        .map_err(|e| e.to_string())
        .and_then(|sealed| {
            drop(plain);
            write(&sealed).map(|()| sealed)
        });
    let sealed = match written {
        Ok(sealed) => sealed,
        Err(e) => {
            // The export cleared the ratchet flag for a file that never received it. Still under
            // the ordering lock, so no resume reload can have read the flag down in between.
            if ratchet_was_unsaved {
                match manager_state.lock() {
                    Ok(lock) => match lock.as_ref() {
                        Some(manager) => restore_ratchet_flag_after_failed_write(manager, &e),
                        None => log::error!(
                            "[MLS] checkpoint failed ({e}) and the manager is gone - no ratchet flag to restore"
                        ),
                    },
                    Err(_) => log::error!(
                        "[MLS] checkpoint failed ({e}) and the manager lock is poisoned - the ratchet flag stays DOWN over a file that is behind"
                    ),
                }
            }
            return Err(e);
        }
    };
    log::debug!(
        "[MLS] checkpoint: manager lock held {} ms (export), seal + write {} ms off it, {} bytes",
        exported.as_millis(),
        started.elapsed().saturating_sub(exported).as_millis(),
        sealed.len()
    );
    Ok(sealed.len())
}

/// Serialises, seals and writes a manager the CALLER already holds locked (a mint, a reclaim), and
/// re-raises the ratchet flag when the seal or the write fails - see
/// [`mls_core::MlsManager::restore_unsaved_ratchet_advance`] for why a failed write must not leave it
/// down. Returns the sealed length.
pub(crate) fn persist_locked_manager(
    manager: &mls_core::MlsManager,
    key: &[u8; 32],
    write: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<usize, String> {
    let ratchet_was_unsaved = manager.has_unsaved_ratchet_advance();
    let written = manager
        .save_encrypted_with_key(key)
        .map_err(|e| e.to_string())
        .and_then(|sealed| write(&sealed).map(|()| sealed.len()));
    if let Err(e) = &written {
        if ratchet_was_unsaved {
            restore_ratchet_flag_after_failed_write(manager, e);
        }
    }
    written
}

/// The one gesture both writers owe a failed write that followed a ratchet-clearing export.
fn restore_ratchet_flag_after_failed_write(manager: &mls_core::MlsManager, error: &str) {
    manager.restore_unsaved_ratchet_advance();
    log::error!(
        "[MLS] mls.bin write FAILED after the export cleared the ratchet flag ({error}) - flag re-raised so a resume reload refuses the older file instead of rewinding the ratchet"
    );
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

/// Whether THIS PROCESS holds a foreground manager loaded from `mls.bin` - set by
/// [`foreground_load_mls_bin`] before the read, cleared only by [`end_native_session`] (a sign-out,
/// an account switch, a sweep, or a failed install) together with the manager it describes.
fn live_manager_flag() -> &'static AtomicBool {
    static LOADED: AtomicBool = AtomicBool::new(false);
    &LOADED
}

/// True while a foreground manager is loaded in this process (or being loaded).
///
/// **A WRITE THAT ONLY ADDS MUST NOT LAND UNDER A WARM MANAGER**, and the deadline cannot say so:
/// a backgrounded app keeps its manager in memory with the guard expired. If that manager holds a
/// ratchet advance when the app comes back, the resume reload is refused (`LiveAhead`) and the
/// live state is persisted OVER the file - erasing whatever a background engine wrote meanwhile.
/// The key-group join from a push (channel-encryption section 26) is the one background write
/// that can be deferred to the app without losing anything, so it refuses here.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn live_manager_in_process() -> bool {
    live_manager_flag().load(Ordering::SeqCst)
}

/// Test-only: forget the warm manager, so tests sharing the process start cold.
#[cfg(test)]
pub(crate) fn forget_live_manager_for_test() {
    live_manager_flag().store(false, Ordering::SeqCst);
}

/// Marks the foreground active and this process warm - the half of [`foreground_load_mls_bin`] a
/// login whose caller SUPPLIED the bytes (old-PIN recovery) can still do before installing them.
pub(crate) fn mark_foreground_manager_loading() {
    live_manager_flag().store(true, Ordering::SeqCst);
    mark_foreground_active();
}

/// Reads `mls.bin` for the FOREGROUND manager about to be built from it: marks the foreground
/// active and this process warm FIRST, then reads under [`mls_bin_write_lock`].
///
/// The order is the proof. A background writer checks both marks under the same lock before it
/// writes, so it either wrote before this read (and the read sees it) or sees a mark and gives up:
/// there is no write the manager built from these bytes can later persist over. Before
/// 2026-10-22 the login read the file with neither, and the heartbeat's first tick came up to
/// 10 s later.
pub(crate) fn foreground_load_mls_bin(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    mark_foreground_manager_loading();
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read mls.bin: {e}")),
    }
}

/// Ends the foreground MLS session of this process: the manager, its cached at-rest key and the
/// warm-process mark go, and with `sweep_dir` the state files of [`remove_mls_state_held`] go too -
/// ALL IN ONE HOLD, taken in the documented order: [`foreground_checkpoint_lock`], then the manager
/// mutex (the device-key mutex is taken and released inside it), then [`mls_bin_write_lock`].
///
/// **WHY ONE HOLD.** A sign-out on a phone is an in-app navigation, not a process restart, so whatever
/// this process holds for account A is still there when account B signs in. Emptying the slot and
/// removing the files in two steps leaves a window in which a command finds A's manager over no file,
/// or a background engine that loaded before the sweep finds a file and no foreground. Under one hold a
/// command waiting on the manager mutex finds `None` and answers [`crate::state::MLS_MANAGER_ABSENT`],
/// and a background engine that loaded before fails its compare-and-swap re-read (no file): nothing can
/// put the state back.
///
/// **EVERY LOCK IS TAKEN EVEN WHEN POISONED.** A teardown that refused on a poisoned mutex would leave
/// the previous account's manager installed for the rest of the process, which is the defect this
/// exists to close; the poison is named at ERROR. The checkpoint lock already behaves this way.
///
/// It may wait for an in-flight checkpoint (the checkpoint lock spans a whole serialise); the wait is
/// logged with its duration. Nothing under the hold calls into the JVM or the WebView: the manager is
/// DROPPED after every lock is released, and the sweep is plain file removal.
///
/// [`remove_mls_state_held`]: crate::commands::storage::remove_mls_state_held
pub(crate) fn end_native_session(
    manager_state: &Mutex<Option<mls_core::MlsManager>>,
    device_key_state: &Mutex<Option<[u8; 32]>>,
    sweep_dir: Option<&std::path::Path>,
    why: &str,
) -> Result<SessionEnded, String> {
    // DEBUG: what was ended is known only under the hold, and the closing line reports it.
    log::debug!(
        "[MLS] ending the native MLS session ({why}, state files {})",
        if sweep_dir.is_some() { "swept" } else { "kept" }
    );
    let waited = std::time::Instant::now();
    let _ordered = foreground_checkpoint_lock();
    let mut slot = manager_state.lock().unwrap_or_else(|poisoned| {
        log::error!(
            "[MLS] teardown: the manager mutex was POISONED - taken anyway, the session must end"
        );
        poisoned.into_inner()
    });
    let waited_ms = waited.elapsed().as_millis();
    if waited_ms > 0 {
        log::debug!("[MLS] teardown waited {waited_ms} ms for the checkpoint and manager locks");
    }
    let manager = slot.take();
    let had_key = device_key_state
        .lock()
        .unwrap_or_else(|poisoned| {
            log::error!(
                "[MLS] teardown: the device-key mutex was POISONED - taken anyway, the key must go"
            );
            poisoned.into_inner()
        })
        .take()
        .is_some();
    let swept = {
        let _file = mls_bin_write_lock().lock().unwrap_or_else(|poisoned| {
            log::error!(
                "[MLS] teardown: the mls.bin write lock was POISONED - taken anyway, it guards file order and the files are removed by unlink"
            );
            poisoned.into_inner()
        });
        // Under the write lock, where a background writer reads it: no foreground manager is loaded
        // any more, so the warm-process refusal must not outlive the manager it described.
        live_manager_flag().store(false, Ordering::SeqCst);
        sweep_dir.map(crate::commands::storage::remove_mls_state_held)
    };
    drop(slot);
    drop(_ordered);
    let ended = SessionEnded {
        had_manager: manager.is_some(),
        had_key,
    };
    // Dropped OFF every lock: freeing a large state costs time, and nothing waiting needs to.
    drop(manager);
    // INFO only when something was ended. One exit runs several teardowns in a row (a revoked device:
    // the reset, the failed re-enrolment, the sign-out), and only the first finds a session; the
    // others are expected no-ops, at DEBUG.
    let level = if ended.had_manager || ended.had_key {
        log::Level::Info
    } else {
        log::Level::Debug
    };
    log::log!(
        level,
        "[MLS] native MLS session ended ({why}): manager {}, at-rest key {}",
        if ended.had_manager {
            "dropped"
        } else {
            "already absent"
        },
        if ended.had_key {
            "cleared"
        } else {
            "already absent"
        }
    );
    match swept {
        Some(Err(e)) => {
            log::error!("[MLS] teardown ({why}): the state files were NOT all removed: {e}");
            Err(e)
        }
        _ => Ok(ended),
    }
}

/// What [`end_native_session`] found and ended - read by its tests and its log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionEnded {
    pub had_manager: bool,
    pub had_key: bool,
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
/// Mobile only: that is where the background writer (`background_write_mls_bin_if_unchanged`) lives.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn foreground_is_active() -> bool {
    foreground_critical_depth().load(Ordering::SeqCst) > 0
        || now_ms() < foreground_active_until().load(Ordering::SeqCst)
}

/// The digest a background engine takes of the `mls.bin` bytes it LOADED, so that
/// [`background_write_mls_bin_if_unchanged`] can refuse to write over a file that moved since.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn mls_bin_digest(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// Writes `mls.bin` from the background under the global lock, UNLESS the foreground is active (it
/// gives up: the foreground holds the up-to-date state in memory and would overwrite it - C1/FCM3),
/// AND ONLY OVER THE FILE THE CALLER LOADED - a compare-and-swap. The ONE background writer: the
/// plain write it replaced let a state loaded under one key land over a file re-sealed under another
/// (`mobile/background.rs`, `write_over_loaded_state`).
///
/// A background engine that loads, works and writes cannot rely on the foreground guard alone: the
/// foreground can start, checkpoint and stop again inside that span, after which the guard reads
/// "inactive" and a plain write would erase what the foreground did. So this write compares the
/// file's CURRENT bytes with the digest of the bytes the caller loaded, under the same write lock
/// every `mls.bin` writer takes, and refuses on any difference.
///
/// A refusal is an error the caller must say out loud: what it wanted to persist is not written. A
/// send batch is re-encrypted at the next drain; a background Welcome's stage, already in the file,
/// is settled by the foreground.
///
/// **THIS GUARDS THE BACKGROUND HALF ONLY.** The foreground's checkpoint
/// ([`write_mls_state_blob`]) is a blind write, so a live manager that never loaded what a
/// background engine wrote writes over it (docs/wiki/backlog.md, WP-CHECKPOINT-CAS).
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_write_mls_bin_if_unchanged(
    path: &std::path::Path,
    loaded_digest: &[u8; 32],
    data: &[u8],
) -> Result<(), String> {
    background_write_mls_bin_compare_and_swap(path, loaded_digest, data, false, || ())
}

/// [`background_write_mls_bin_if_unchanged`], AND ALSO REFUSED IN A WARM PROCESS - the writer of
/// the key-group join from a push (channel-encryption section 26).
///
/// That join holds its loaded state across TWO round trips to the server, and it is the one
/// background write that can be deferred to the app without losing anything: a foreground manager
/// loaded in this process ([`live_manager_in_process`]) would persist over the install at its next
/// resume, so the join refuses and the app's own load joins the group instead. The check is made
/// under the same write lock as the compare, which is what makes it a proof
/// ([`foreground_load_mls_bin`] marks the process warm before it reads under that lock).
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_write_mls_bin_if_unchanged_and_cold(
    path: &std::path::Path,
    loaded_digest: &[u8; 32],
    data: &[u8],
) -> Result<(), String> {
    background_write_mls_bin_compare_and_swap(path, loaded_digest, data, true, || ())
}

/// [`background_write_mls_bin_if_unchanged_and_cold`], then `then` UNDER THE SAME HOLD of
/// [`mls_bin_write_lock`], only once `data` is written - the background Welcome's stage and its
/// ledger entry (`mobile/background.rs`). A state reset's sweep takes that lock too
/// ([`end_native_session`], through `remove_mls_state_held`), so it removes both or neither: never
/// a ledger naming a stage beside no state. `then` must not take the lock.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_write_mls_bin_if_unchanged_and_cold_then<R>(
    path: &std::path::Path,
    loaded_digest: &[u8; 32],
    data: &[u8],
    then: impl FnOnce() -> R,
) -> Result<R, String> {
    background_write_mls_bin_compare_and_swap(path, loaded_digest, data, true, then)
}

/// The one body of the background writers above: the foreground guard, optionally the warm-process
/// refusal, then the compare-and-swap and `then`, all under [`mls_bin_write_lock`].
#[cfg(any(target_os = "android", target_os = "ios", test))]
fn background_write_mls_bin_compare_and_swap<R>(
    path: &std::path::Path,
    loaded_digest: &[u8; 32],
    data: &[u8],
    refuse_warm_process: bool,
    then: impl FnOnce() -> R,
) -> Result<R, String> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if foreground_is_active() {
        return Err("foreground active - background mls.bin write abandoned (C1/FCM3)".to_string());
    }
    if refuse_warm_process && live_manager_in_process() {
        return Err(
            "a foreground manager is loaded in this process - background mls.bin write abandoned (a resume would persist over it)"
                .to_string(),
        );
    }
    let current = std::fs::read(path).map_err(|e| format!("re-read mls.bin: {e}"))?;
    if &mls_bin_digest(&current) != loaded_digest {
        return Err(
            "mls.bin changed since it was loaded - background write abandoned (lost update refused)"
                .to_string(),
        );
    }
    write_mls_bin_atomically(path, data)?;
    Ok(then())
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

/// Fixtures shared by every test module that exercises the process-global locks above.
#[cfg(test)]
pub(crate) mod test_support {
    use super::Mutex;
    use mls_core::MlsManager;

    /// The guards under test are PROCESS-global, so these tests cannot run beside each other or
    /// beside anything else touching them - `cargo test` threads one process.
    pub(crate) fn serialise() -> std::sync::MutexGuard<'static, ()> {
        static M: Mutex<()> = Mutex::new(());
        M.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Alice and Bob in one group, Bob joined by Welcome - so Alice's frames move Bob's ratchet.
    pub(crate) fn joined_pair(tag: &str) -> (MlsManager, MlsManager, String) {
        let gid = format!("g-{tag}");
        let mut alice = MlsManager::load_or_create(&format!("{tag}-alice"), "d1", None).unwrap();
        let mut bob = MlsManager::load_or_create(&format!("{tag}-bob"), "d1", None).unwrap();
        alice.create_group(gid.clone()).unwrap();
        let kp = bob.generate_key_package().unwrap();
        let (_, welcome, _, _) = alice.add_members_bulk(&gid, &[&kp]).unwrap();
        alice.merge_pending_commit_for(&gid).unwrap();
        let tree = alice.export_ratchet_tree_for(&gid).unwrap();
        bob.process_welcome(welcome.as_deref().unwrap(), Some(&tree))
            .unwrap();
        (alice, bob, gid)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{joined_pair, serialise};
    use super::*;
    use mls_core::MlsManager;

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
        std::fs::write(&path, b"loaded state").unwrap();
        let loaded = mls_bin_digest(b"loaded state");

        let checkpoint = ForegroundCritical::enter();
        let refused = background_write_mls_bin_if_unchanged(&path, &loaded, b"background state");
        assert!(
            refused.is_err(),
            "the background must give up, not overwrite"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"loaded state",
            "and it must not have written anything"
        );

        drop(checkpoint);
        background_write_mls_bin_if_unchanged(&path, &loaded, b"background state")
            .expect("allowed once the checkpoint ends");
        assert_eq!(std::fs::read(&path).unwrap(), b"background state");
        let _ = std::fs::remove_file(&path);
    }

    const CKPT_KEY: [u8; 32] = [7u8; 32];

    /// A live manager holding one group, as the commands see it.
    fn live_manager(user: &str) -> std::sync::Arc<Mutex<Option<mls_core::MlsManager>>> {
        let mut manager = mls_core::MlsManager::load_or_create(user, "d1", None).unwrap();
        manager.create_group(format!("g-{user}")).unwrap();
        std::sync::Arc::new(Mutex::new(Some(manager)))
    }

    /// Runs a checkpoint on its own thread whose write STALLS until released, and returns once it is
    /// inside the write: the export is done, the seal is done, the file is not written yet.
    fn checkpoint_stalled_in_write(
        manager: std::sync::Arc<Mutex<Option<mls_core::MlsManager>>>,
        path: std::path::PathBuf,
        written: std::sync::mpsc::Sender<&'static str>,
    ) -> (
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<Result<usize, String>>,
    ) {
        let (in_write_tx, in_write_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            checkpoint_live_manager(&manager, &CKPT_KEY, |sealed| {
                in_write_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::fs::write(&path, sealed).map_err(|e| e.to_string())?;
                written.send("older").unwrap();
                Ok(())
            })
        });
        in_write_rx
            .recv()
            .expect("the checkpoint reached its write");
        (release_tx, handle)
    }

    /// THE FREEZE OF 2026-10-13, AS THE PROPERTY THAT REMOVES IT: while a checkpoint seals and
    /// writes, the manager is free, so a synchronous command (a send, a commit, `groupe_actif`) runs
    /// at once instead of holding the WebView's JavaScript thread for the rest of the checkpoint.
    #[test]
    fn the_manager_lock_is_free_while_a_checkpoint_seals_and_writes() {
        let _s = serialise();
        let path =
            std::env::temp_dir().join(format!("canari-ckpt-free-{}.bin", std::process::id()));
        let manager = live_manager("u-ckpt-free");
        let (written_tx, _written_rx) = std::sync::mpsc::channel();
        let (release, handle) =
            checkpoint_stalled_in_write(manager.clone(), path.clone(), written_tx);

        {
            let mut guard = manager.try_lock().expect(
                "the manager lock must be free once the export is done - holding it across the seal \
                 and the write is what froze the Mi 9T for 1.6-3.2 s per synchronous command",
            );
            let live = guard.as_mut().unwrap();
            assert!(live.is_group_active("g-u-ckpt-free").unwrap());
            live.create_group("g-created-mid-checkpoint".into())
                .unwrap();
        }

        release.send(()).unwrap();
        handle.join().unwrap().expect("the checkpoint completes");
        let on_disk = mls_core::MlsManager::load_with_key(
            "u-ckpt-free",
            "d1",
            Some(std::fs::read(&path).unwrap()),
            &CKPT_KEY,
        )
        .unwrap();
        assert!(
            on_disk
                .get_known_groups()
                .contains(&"g-u-ckpt-free".to_string()),
            "the file holds the exported state"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// WRITER ORDER: a checkpoint started while an older one is still writing must not export until
    /// the older one has written, so the file only moves forward. Without the ordering lock the
    /// newer checkpoint writes first and the older, slower one lands over it - erasing, here, a group
    /// created in between (in production: a mint's fifty private bundles, or a ratchet advance).
    ///
    /// The bounded wait only ever makes the BROKEN version pass by accident on a starved machine;
    /// with the ordering in place the newer checkpoint cannot write at all until released, so no
    /// timing can fail the correct code.
    #[test]
    fn an_older_checkpoint_never_lands_over_a_newer_one() {
        let _s = serialise();
        let path =
            std::env::temp_dir().join(format!("canari-ckpt-order-{}.bin", std::process::id()));
        let manager = live_manager("u-ckpt-order");
        let (written_tx, written_rx) = std::sync::mpsc::channel();
        let (release_older, older) =
            checkpoint_stalled_in_write(manager.clone(), path.clone(), written_tx.clone());

        // A mutation the older checkpoint did not export.
        manager
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .create_group("g-after-the-older-export".into())
            .unwrap();

        let newer = {
            let manager = manager.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                checkpoint_live_manager(&manager, &CKPT_KEY, |sealed| {
                    std::fs::write(&path, sealed).map_err(|e| e.to_string())?;
                    written_tx.send("newer").unwrap();
                    Ok(())
                })
            })
        };
        assert!(
            written_rx
                .recv_timeout(std::time::Duration::from_millis(500))
                .is_err(),
            "the newer checkpoint wrote while the older one was still in flight"
        );

        release_older.send(()).unwrap();
        older.join().unwrap().unwrap();
        newer.join().unwrap().unwrap();
        let order: Vec<_> = written_rx.try_iter().collect();
        assert_eq!(order, vec!["older", "newer"]);

        let on_disk = mls_core::MlsManager::load_with_key(
            "u-ckpt-order",
            "d1",
            Some(std::fs::read(&path).unwrap()),
            &CKPT_KEY,
        )
        .unwrap();
        assert!(
            on_disk
                .get_known_groups()
                .contains(&"g-after-the-older-export".to_string()),
            "the file must hold the NEWER export, mutation included"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A FRAME DECRYPTED BETWEEN THE EXPORT AND THE WRITE IS OWED TO THE NEXT CHECKPOINT, and the
    /// flag says so. The export cleared `has_unsaved_ratchet_advance`; the decrypt, which the released
    /// manager now lets through mid-checkpoint, must raise it again AFTER that clear - otherwise the
    /// completed write would read as covering a generation it does not hold.
    #[test]
    fn a_decrypt_during_the_write_stays_owed_to_the_next_checkpoint() {
        let _s = serialise();
        let path =
            std::env::temp_dir().join(format!("canari-ckpt-owed-{}.bin", std::process::id()));
        let (mut alice, bob, gid) = joined_pair("ckpt-owed");
        let manager = std::sync::Arc::new(Mutex::new(Some(bob)));
        let (written_tx, _written_rx) = std::sync::mpsc::channel();
        let (release, handle) =
            checkpoint_stalled_in_write(manager.clone(), path.clone(), written_tx);

        let frame = alice.send_message(&gid, b"read mid-checkpoint").unwrap();
        {
            let mut guard = manager.lock().unwrap();
            let live = guard.as_mut().unwrap();
            assert!(
                !live.has_unsaved_ratchet_advance(),
                "precondition: the export cleared the flag"
            );
            live.process_incoming_message(&gid, &frame).unwrap();
        }

        release.send(()).unwrap();
        handle.join().unwrap().unwrap();
        assert!(
            manager
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .has_unsaved_ratchet_advance(),
            "the write that just landed predates the decrypt - the flag must still say the file is behind"
        );

        checkpoint_live_manager(&manager, &CKPT_KEY, |sealed| {
            std::fs::write(&path, sealed).map_err(|e| e.to_string())
        })
        .unwrap();
        let mut on_disk = mls_core::MlsManager::load_with_key(
            "ckpt-owed-bob",
            "d1",
            Some(std::fs::read(&path).unwrap()),
            &CKPT_KEY,
        )
        .unwrap();
        assert!(
            on_disk.process_incoming_message(&gid, &frame).is_err(),
            "the next checkpoint holds the generation the mid-checkpoint decrypt spent"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A WRITE THAT FAILS MUST NOT LEAVE THE RATCHET FLAG DOWN. The export cleared it; if the file
    /// never received the export, a resume reload reading the flag down installs a file behind the
    /// live ratchet and re-derives a generation this device already spent. Both writers - the
    /// checkpoint that releases the manager and the mint that holds it - put it back.
    #[test]
    fn a_failed_write_puts_the_ratchet_flag_back() {
        let _s = serialise();
        let (mut alice, mut bob, gid) = joined_pair("ckpt-fail");
        let frame = alice.send_message(&gid, b"one").unwrap();
        bob.process_incoming_message(&gid, &frame).unwrap();
        assert!(bob.has_unsaved_ratchet_advance(), "precondition");

        let refused = persist_locked_manager(&bob, &CKPT_KEY, |_| Err("disk full".into()));
        assert!(refused.is_err());
        assert!(
            bob.has_unsaved_ratchet_advance(),
            "a mint whose write failed left the flag down over a file that is behind"
        );

        let manager = Mutex::new(Some(bob));
        let refused = checkpoint_live_manager(&manager, &CKPT_KEY, |_| Err("disk full".into()));
        assert!(refused.is_err());
        let guard = manager.lock().unwrap();
        let bob = guard.as_ref().unwrap();
        assert!(
            bob.has_unsaved_ratchet_advance(),
            "a checkpoint whose write failed left the flag down over a file that is behind"
        );
        drop(guard);

        checkpoint_live_manager(&manager, &CKPT_KEY, |_| Ok(())).unwrap();
        assert!(
            !manager
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .has_unsaved_ratchet_advance(),
            "and a write that lands clears it - the flag is not latched"
        );
    }

    /// A fresh directory standing for `app_data_dir`.
    fn teardown_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canari-teardown-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// THE GAP THIS CLOSES: account A's manager and at-rest key stayed in the slot after a sign-out,
    /// into account B's session. After the teardown the slot is empty, the key is gone, the process
    /// is no longer marked warm, and a command reading the slot gets the typed refusal.
    #[test]
    fn the_teardown_empties_the_slot_and_the_key_and_keeps_the_state_files() {
        let _s = serialise();
        let dir = teardown_dir("keep");
        std::fs::write(dir.join("mls.bin"), b"account A").unwrap();
        mark_foreground_manager_loading();
        let manager = Mutex::new(Some(
            MlsManager::load_or_create("teardown-a", "d1", None).unwrap(),
        ));
        let key = Mutex::new(Some(CKPT_KEY));

        let ended = end_native_session(&manager, &key, None, "test sign-out").unwrap();

        assert_eq!(
            ended,
            SessionEnded {
                had_manager: true,
                had_key: true
            }
        );
        assert!(
            manager.lock().unwrap().is_none(),
            "the manager outlived its account"
        );
        assert!(
            key.lock().unwrap().is_none(),
            "the at-rest key outlived its account"
        );
        assert!(
            !live_manager_in_process(),
            "the warm-process mark outlived the manager it described"
        );
        let refused = crate::state::live_manager(&manager.lock().unwrap())
            .err()
            .unwrap();
        assert!(
            refused.starts_with(crate::state::MLS_MANAGER_ABSENT),
            "{refused}"
        );
        assert!(
            dir.join("mls.bin").exists(),
            "a sign-out keeps the local state for the account's next sign-in"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A reset sweeps the state IN THE SAME HOLD as it empties the slot.
    #[test]
    fn the_teardown_with_a_sweep_removes_the_state_and_what_was_built_from_it() {
        let _s = serialise();
        let dir = teardown_dir("sweep");
        for name in [
            "mls.bin",
            "mls.owner",
            "background_stages.json",
            "unrelated.json",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let manager = Mutex::new(Some(
            MlsManager::load_or_create("teardown-sweep", "d1", None).unwrap(),
        ));
        let key = Mutex::new(Some(CKPT_KEY));

        end_native_session(&manager, &key, Some(&dir), "test reset").unwrap();

        assert!(manager.lock().unwrap().is_none());
        assert!(key.lock().unwrap().is_none());
        for gone in ["mls.bin", "mls.owner", "background_stages.json"] {
            assert!(!dir.join(gone).exists(), "{gone} outlived the reset");
        }
        assert!(
            dir.join("unrelated.json").exists(),
            "only what belongs to mls.bin"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A teardown must END the session even when a previous holder panicked: refusing on poison
    /// would leave the previous account's manager installed for the rest of the process.
    #[test]
    fn the_teardown_ends_a_session_whose_mutexes_are_poisoned() {
        let _s = serialise();
        let manager = std::sync::Arc::new(Mutex::new(Some(
            MlsManager::load_or_create("teardown-poison", "d1", None).unwrap(),
        )));
        let key = std::sync::Arc::new(Mutex::new(Some(CKPT_KEY)));
        let (m, k) = (manager.clone(), key.clone());
        let _ = std::thread::spawn(move || {
            let _a = m.lock().unwrap();
            let _b = k.lock().unwrap();
            panic!("a holder died");
        })
        .join();
        assert!(manager.is_poisoned() && key.is_poisoned(), "precondition");

        end_native_session(&manager, &key, None, "test poisoned").unwrap();

        assert!(manager.lock().unwrap_or_else(|e| e.into_inner()).is_none());
        assert!(key.lock().unwrap_or_else(|e| e.into_inner()).is_none());
    }

    /// A checkpoint asked of an empty slot is refused with the typed code, never a silent success.
    #[test]
    fn a_checkpoint_of_an_empty_slot_is_refused_with_the_typed_code() {
        let manager: Mutex<Option<MlsManager>> = Mutex::new(None);
        let refused = checkpoint_live_manager(&manager, &CKPT_KEY, |_| Ok(()))
            .err()
            .unwrap();
        assert!(
            refused.starts_with(crate::state::MLS_MANAGER_ABSENT),
            "{refused}"
        );
    }
}
