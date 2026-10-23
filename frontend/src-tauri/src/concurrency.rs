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
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
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
///
/// A Welcome the server accepted and that was handed over ([`HANDED_OVER_SUFFIX`]) is installed
/// FIRST, and then this write is refused: the caller's state was built on the file the add
/// replaced, and writing it would erase a commit the server holds.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_write_mls_bin(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if foreground_is_active() {
        return Err("foreground active - background mls.bin write abandoned (C1/FCM3)".to_string());
    }
    if install_handed_over_welcomes_locked(path) > 0 {
        return Err(
            "an accepted Welcome handed over earlier was installed first - this write, built on the file it replaced, is refused"
                .to_string(),
        );
    }
    write_mls_bin_atomically(path, data)
}

/// The digest of `mls.bin` bytes, so a writer can refuse to write over a file that moved since it
/// was loaded ([`background_write_mls_bin_if_unchanged`], [`install_handed_over_welcomes_locked`]).
pub(crate) fn mls_bin_digest(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// Why [`background_write_mls_bin_if_unchanged`] did not write - a TYPE, because the background
/// Welcome keeps its staged state on two of these and drops it on the third.
#[cfg(any(target_os = "android", target_os = "ios", test))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BackgroundWriteRefused {
    /// The foreground holds the state; nothing was written (C1/FCM3).
    ForegroundActive,
    /// `mls.bin` is not the file the caller loaded: the write would erase what replaced it.
    Moved,
    /// The file could not be read or written.
    Io(String),
}

#[cfg(any(target_os = "android", target_os = "ios", test))]
impl std::fmt::Display for BackgroundWriteRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ForegroundActive => {
                f.write_str("foreground active - background mls.bin write abandoned (C1/FCM3)")
            }
            Self::Moved => f.write_str(
                "mls.bin changed since it was loaded - background write abandoned (lost update refused)",
            ),
            Self::Io(e) => write!(f, "mls.bin I/O: {e}"),
        }
    }
}

/// [`background_write_mls_bin`], AND ONLY OVER THE FILE THE CALLER LOADED - a compare-and-swap.
///
/// A background engine that holds its loaded state across a network round trip - the background
/// Welcome waits for the server's answer before it installs anything - cannot rely on the
/// foreground guard alone: the foreground can start, checkpoint and stop again inside that span,
/// after which the guard reads "inactive" and a plain write would erase what the foreground did.
/// So this write compares the file's CURRENT bytes with the digest of the bytes the caller loaded,
/// under the same write lock every `mls.bin` writer takes, and refuses on any difference. A
/// handed-over Welcome is installed before the comparison, so it counts as a difference.
///
/// A refusal is an error the caller must say out loud: the work it wanted to persist is lost.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_write_mls_bin_if_unchanged(
    path: &std::path::Path,
    loaded_digest: &[u8; 32],
    data: &[u8],
) -> Result<(), BackgroundWriteRefused> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| BackgroundWriteRefused::Io("mls_bin write lock poisoned".to_string()))?;
    if foreground_is_active() {
        return Err(BackgroundWriteRefused::ForegroundActive);
    }
    install_handed_over_welcomes_locked(path);
    let current = std::fs::read(path)
        .map_err(|e| BackgroundWriteRefused::Io(format!("re-read mls.bin: {e}")))?;
    if &mls_bin_digest(&current) != loaded_digest {
        return Err(BackgroundWriteRefused::Moved);
    }
    write_mls_bin_atomically(path, data).map_err(BackgroundWriteRefused::Io)
}

/// The suffix a staged background Welcome takes when the server ACCEPTED it and it could not be
/// installed at once - the foreground was active, or the Kotlin state lock was busy - so the state
/// is HANDED OVER rather than deleted: it holds the only copy of this device's own accepted commit.
/// The file keeps the staged layout, `digest of the base mls.bin (32) || sealed post-add state`,
/// and the staged prefix, so deleting `mls.bin` sweeps it.
pub(crate) const HANDED_OVER_SUFFIX: &str = ".accepted";

/// The handed-over Welcome files of `dir`, sorted.
pub(crate) fn handed_over_welcomes(
    dir: &std::path::Path,
) -> std::io::Result<Vec<std::path::PathBuf>> {
    let prefix = crate::commands::storage::STAGED_WELCOME_PREFIX;
    let mut handed: Vec<std::path::PathBuf> = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy())
                .is_some_and(|n| n.starts_with(prefix) && n.ends_with(HANDED_OVER_SUFFIX))
        })
        .collect();
    handed.sort();
    Ok(handed)
}

/// Installs every handed-over Welcome beside `mls_path` whose base is still the file on disk, and
/// returns how many it installed. THE CALLER HOLDS [`mls_bin_write_lock`] - every `mls.bin` writer
/// and every foreground load runs this before it writes or reads, so an accepted add is never
/// written over or read past.
///
/// A handed-over state whose base MOVED can never be installed - no later state is built from that
/// base - so it is deleted and said loudly: the server holds a commit this device does not, and the
/// foreground's replay meets it and recovers through the usual ladder. A failed write keeps the file
/// for the next writer or load.
pub(crate) fn install_handed_over_welcomes_locked(mls_path: &std::path::Path) -> usize {
    let Some(dir) = mls_path.parent() else {
        log::error!(
            "[BG_WELCOME] mls.bin path has no directory: {}",
            mls_path.display()
        );
        return 0;
    };
    let handed = match handed_over_welcomes(dir) {
        Ok(handed) => handed,
        Err(e) => {
            log::error!("[BG_WELCOME] handed-over Welcomes not listed: {e}");
            return 0;
        }
    };
    let mut installed = 0;
    for path in handed {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let file = match std::fs::read(&path) {
            Ok(f) if f.len() > 32 => f,
            Ok(_) => {
                log::error!(
                    "[BG_WELCOME] ACCEPTED AND NOT INSTALLED {name}: handed-over state truncated"
                );
                let _ = std::fs::remove_file(&path);
                continue;
            }
            Err(e) => {
                log::error!("[BG_WELCOME] handed-over state {name} unreadable, kept: {e}");
                continue;
            }
        };
        let base_on_disk = match std::fs::read(mls_path) {
            Ok(current) => mls_bin_digest(&current)[..] == file[..32],
            Err(e) => {
                log::error!("[BG_WELCOME] mls.bin unreadable while installing {name}: {e}");
                false
            }
        };
        if !base_on_disk {
            log::error!(
                "[BG_WELCOME] ACCEPTED AND NOT INSTALLED {name}: mls.bin moved since the stage - the server holds this device's commit, the replay recovers it"
            );
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("[BG_WELCOME] handed-over state {name} not deleted: {e}");
            }
            continue;
        }
        match write_mls_bin_atomically(mls_path, &file[32..]) {
            Ok(()) => {
                installed += 1;
                log::info!(
                    "[BG_WELCOME] handed-over add installed {name} ({} bytes)",
                    file.len() - 32
                );
                if let Err(e) = std::fs::remove_file(&path) {
                    log::warn!("[BG_WELCOME] handed-over state {name} not deleted: {e}");
                }
            }
            Err(e) => log::error!("[BG_WELCOME] handed-over add {name} not written, kept: {e}"),
        }
    }
    installed
}

/// The background Welcomes staged and not yet settled, by group: from a successful prepare until
/// its install, hand-over or discard.
///
/// **A FOREGROUND LOAD WAITS FOR THEM, AND THAT IS THE WHOLE FIX.** A background Welcome is staged
/// from `mls.bin`, submitted, and installed only once the server accepts it. A foreground that loads
/// `mls.bin` inside that round trip loads the base - and its manager then moves on from there, so no
/// later compare-and-swap can install the add under it: the device ends one epoch behind its own
/// accepted commit. So every foreground load ([`await_background_welcomes`]) waits for the round
/// trip to settle, then installs what was handed over, then reads. Registration and the
/// "foreground active" check share one mutex ([`register_background_welcome`]), so a foreground
/// that marked itself active before waiting either waits for a prepare or makes it refuse.
///
/// Not a clock: every prepared Welcome is settled exactly once, by the answer's type, and the
/// round trip is bounded by the HTTP client's own timeouts. A process that dies takes this with it.
struct InFlightWelcomes {
    groups: Mutex<std::collections::BTreeSet<String>>,
    settled: std::sync::Condvar,
    /// Foreground loads blocked in [`await_background_welcomes`] right now.
    waiting: AtomicUsize,
}

fn in_flight_welcomes() -> &'static InFlightWelcomes {
    static IN_FLIGHT: InFlightWelcomes = InFlightWelcomes {
        groups: Mutex::new(std::collections::BTreeSet::new()),
        settled: std::sync::Condvar::new(),
        waiting: AtomicUsize::new(0),
    };
    &IN_FLIGHT
}

/// How many foreground loads are blocked waiting for a background Welcome - for a test to order a
/// settlement AFTER a load reached its wait, which is the interleaving that loses the add without it.
#[cfg(test)]
pub(crate) fn foreground_loads_waiting() -> usize {
    in_flight_welcomes().waiting.load(Ordering::SeqCst)
}

/// The registry's set, taken even if poisoned: it holds group ids and nothing a panic can leave
/// half-written.
fn in_flight_groups() -> std::sync::MutexGuard<'static, std::collections::BTreeSet<String>> {
    in_flight_welcomes()
        .groups
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records a staged background Welcome for `group_id` as in flight - unless the foreground is
/// active, checked under the same mutex a foreground load waits on. `false` means refused: the
/// foreground owns the state.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn register_background_welcome(group_id: &str) -> bool {
    let mut groups = in_flight_groups();
    if foreground_is_active() {
        return false;
    }
    groups.insert(group_id.to_owned());
    true
}

/// Ends the round trip of `group_id`'s background Welcome - installed, handed over or discarded - and
/// wakes the foreground loads waiting on it.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn settle_background_welcome(group_id: &str) {
    let removed = in_flight_groups().remove(group_id);
    if removed {
        in_flight_welcomes().settled.notify_all();
    }
}

/// How many background Welcomes are in flight.
#[cfg(test)]
pub(crate) fn background_welcomes_in_flight() -> usize {
    in_flight_groups().len()
}

/// Waits until no background Welcome is in flight. Every foreground load of `mls.bin` calls it
/// AFTER marking the foreground active and BEFORE it reads - see [`InFlightWelcomes`].
pub(crate) fn await_background_welcomes() {
    let mut groups = in_flight_groups();
    if groups.is_empty() {
        return;
    }
    log::info!(
        "[MLS] foreground load waits for {} background Welcome(s) awaiting the server's answer",
        groups.len()
    );
    let registry = in_flight_welcomes();
    registry.waiting.fetch_add(1, Ordering::SeqCst);
    while !groups.is_empty() {
        groups = registry
            .settled
            .wait(groups)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    registry.waiting.fetch_sub(1, Ordering::SeqCst);
    log::info!("[MLS] background Welcome(s) settled - foreground load proceeds");
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

    /// Settles a background Welcome's round trip when dropped: a test that fails between its prepare
    /// and its settlement must not leave every later foreground load in the process waiting.
    /// Settling twice is a no-op, so the normal path is unaffected.
    pub(crate) struct SettleOnDrop(pub(crate) String);

    impl Drop for SettleOnDrop {
        fn drop(&mut self) {
            super::settle_background_welcome(&self.0);
        }
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
}
