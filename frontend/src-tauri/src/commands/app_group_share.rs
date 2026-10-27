//! The iOS half of a share INTO Canari: the Share Extension (`gen/apple/canari_Share/`) copies what
//! another app shared into the `group.fr.emse.canari` App Group, and this module carries it into the
//! app's own handoff - the same `pending_share.json` and `shared_inbox/<id>/` Android's
//! `IncomingShare.kt` writes, so everything after it (the drain, the picker, the staging, the erase at
//! sign-out) is ONE implementation for both platforms. See `docs/wiki/frontend/sharing.md`.
//!
//! WHY A SECOND HOP. An app extension has a data container of its own: it can write neither the
//! app's `app_data_dir` nor its cache, and the page reads only those (`read_and_clear_pending_share`,
//! `take_picked_file`'s allowlist). So the extension leaves its manifest and copies in the App Group,
//! and the app MOVES them across - a rename on the same volume, never a copy of up to 300 MB.
//!
//! WHO CALLS IT. `canari_ios.mm` at bootstrap and on every `didBecomeActive` (the same call sites as
//! the NSE's FCM cache drain), and on the extension's "share ready" Darwin notification; and
//! `read_and_clear_pending_share` before every claim, so a drain - and the sign-out's erase, which
//! claims through that command - never misses a share the native side has not imported yet.
//!
//! ONE TAKER, ACROSS PROCESSES. The extension holds an exclusive `flock` on
//! `{group}/shared_inbox.lock` for its whole capture; the app only ever TRIES it. A share being
//! copied right now is therefore never moved half-written and never swept; and a sign-out that finds
//! the lock held leaves that capture to the share EPOCH, which the extension reads only once it holds
//! the lock (a capture that started before the advance lands stale, one that started after is the
//! next session's - `commands/handoff.rs`).
//!
//! The manifest's `path`s are written by the extension as App Group paths, which mean nothing to the
//! page; the app REWRITES each to the file of the same name in the moved directory, and keeps only a
//! regular file it finds there. An entry it cannot find is counted with the refusals, so the member is
//! told, exactly like a stream Android could not read.
//!
//! The replacement and refusal rules are Android's `runCapture` / `reportRefusals`, applied to the
//! app data manifest: an older session's share never replaces a newer one's, a refusal count never
//! crosses a sign-out, and nothing older is deleted until the newer manifest is in place.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{Map, Value};

use super::handoff::{
    claim_and_read, is_locked_read, read_handoff, read_share_epoch, write_share_epoch, Claimed,
    PENDING_SHARE_FILE,
};
use super::picked_files::SHARED_INBOX;

/// The lock file in the App Group the extension holds for a whole capture. Pinned against the Swift
/// side by `iosShareExtension.test.ts`.
pub(crate) const GROUP_LOCK_FILE: &str = "shared_inbox.lock";

/// What one import did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Import {
    /// No manifest waits in the App Group.
    Nothing,
    /// The extension holds the lock - a capture is running; the next activation imports it.
    Busy,
    /// A manifest is now in the app data directory for the page to drain.
    Imported,
    /// The App Group manifest was taken and dropped (unreadable, from an older session than the one
    /// waiting, or with nothing to offer); said at the level its cause deserves.
    Dropped,
    /// A manifest is under Data Protection and the device is locked: nothing was moved or deleted,
    /// and the next activation after the unlock imports it (`handoff::Claimed::Protected`).
    Protected,
}

/// Serialises the imports of THIS process (the native call sites and the Tauri command): the
/// cross-process `flock` would otherwise answer `Busy` to the second of two in-process callers.
static IMPORT: Mutex<()> = Mutex::new(());

/// Set once the inboxes have been swept in this process (`sweep_inboxes_once`).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
static SWEPT: AtomicBool = AtomicBool::new(false);

/// Tries the extension's lock without waiting: `Ok(None)` when a capture holds it. Released when the
/// returned file is dropped.
fn try_lock_group(group: &Path) -> std::io::Result<Option<File>> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(group.join(GROUP_LOCK_FILE))?;
    if try_lock_exclusive(&file)? {
        Ok(Some(file))
    } else {
        Ok(None)
    }
}

/// `flock(LOCK_EX | LOCK_NB)` on every Unix - the call the Swift extension makes, so the two lock the
/// same thing (`commands::push::lock_exclusive` says why not std's on Unix). `false` when held.
#[cfg(unix)]
fn try_lock_exclusive(file: &File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: the descriptor is owned by `file`, which outlives the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(error)
    }
}

/// std's on Windows, which is what a host `cargo test` runs.
#[cfg(not(unix))]
fn try_lock_exclusive(file: &File) -> std::io::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

/// A share id names a directory, so it is held to the shape the extension writes (a UUID): no
/// separator, no `..`, nothing that could reach outside the inbox it is joined to.
fn is_safe_share_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Claims `{dir}/{name}` through `handoff::claim_and_read`, the one claim of every handoff. A LOCKED
/// manifest (`Claimed::Protected`) is left in place by it, and every caller here answers that
/// outcome without deleting anything.
fn claim(dir: &Path, name: &str, suffix: &str) -> std::io::Result<Claimed> {
    claim_and_read(dir, name, suffix, read_handoff)
}

/// The manifest as a JSON object; `None` (said by the caller) when it is not one.
fn parse_manifest(raw: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// The epoch a capture started in; 0 when absent, which is STALE once any sign-out happened.
fn epoch_of(manifest: &Map<String, Value>) -> u64 {
    manifest.get("epoch").and_then(Value::as_u64).unwrap_or(0)
}

fn refused_of(manifest: &Map<String, Value>) -> u64 {
    manifest.get("refused").and_then(Value::as_u64).unwrap_or(0)
}

fn id_of(manifest: &Map<String, Value>) -> Option<&str> {
    manifest
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_safe_share_id(id))
}

/// Whether the manifest offers nothing: no text and no file.
fn offers_nothing(manifest: &Map<String, Value>) -> bool {
    let text = manifest.get("text").and_then(Value::as_str).unwrap_or("");
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    text.is_empty() && files == 0
}

/// Writes the manifest whole or not at all (a temporary file renamed into place): the page may drain
/// at any moment, and a reader catching half a file would drop the share as corrupt.
///
/// KEPT OUT OF BACKUPS, per file and after every write, by the native caches' own helper
/// (`native_cache::exclude_from_backup`, and for its reason: the rename is a new inode, which does
/// not carry the flag). The manifest carries the shared TEXT, and the app data directory is backed
/// up on iOS.
///
/// LOCKED WITH THE DEVICE: the staging file is given Data Protection's `Complete` class while it is
/// still EMPTY, so no byte of the text is ever written under a weaker key, and the rename keeps the
/// class (it is the file's, not the path's). Fails closed: a manifest that cannot be protected is
/// not written (`docs/wiki/frontend/sharing.md`, "At rest").
fn write_pending(dir: &Path, manifest: &Map<String, Value>) -> std::io::Result<()> {
    let staging = dir.join(format!("{PENDING_SHARE_FILE}.tmp"));
    let target = dir.join(PENDING_SHARE_FILE);
    std::fs::write(&staging, b"")?;
    if let Err(e) = crate::native_cache::protect_until_unlocked(&staging) {
        log::error!("[SHARE] the share manifest could not be protected - not written: {e}");
        let _ = std::fs::remove_file(&staging);
        return Err(std::io::Error::other(e));
    }
    std::fs::write(&staging, Value::Object(manifest.clone()).to_string())?;
    std::fs::rename(&staging, &target)?;
    crate::native_cache::exclude_from_backup(&target);
    Ok(())
}

/// Deletes `{inbox}/{id}`, said either way.
fn delete_share_dir(inbox: &Path, id: &str, why: &str) {
    if !is_safe_share_id(id) {
        log::error!("[SHARE] {why}: refused to delete a share directory with an unsafe id");
        return;
    }
    match std::fs::remove_dir_all(inbox.join(id)) {
        Ok(()) => log::debug!("[SHARE] {why}: share {id} deleted"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[SHARE] {why}: share {id} not entirely deleted: {e}"),
    }
}

/// Carries the App Group share, if one waits, into `data_dir/pending_share.json` and
/// `cache_dir/shared_inbox/<id>/`. Never waits for the extension's lock.
pub(crate) fn import_group_share(
    group: &Path,
    data_dir: &Path,
    cache_dir: &Path,
) -> std::io::Result<Import> {
    let _process = IMPORT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(_lock) = try_lock_group(group)? else {
        log::info!(
            "[SHARE] the Share Extension is copying a share - imported at the next activation"
        );
        return Ok(Import::Busy);
    };
    let raw = match claim(group, PENDING_SHARE_FILE, "importing")? {
        Claimed::Nothing => return Ok(Import::Nothing),
        Claimed::Protected => {
            log::info!("[SHARE] the App Group share is protected until the device is unlocked - imported at the next activation");
            return Ok(Import::Protected);
        }
        Claimed::Read(raw) => raw,
    };
    let Some(mut manifest) = parse_manifest(&raw) else {
        // Its copies stay in the App Group until the next process start sweeps what no manifest names.
        log::error!("[SHARE] the App Group share manifest is unreadable - dropped");
        return Ok(Import::Dropped);
    };
    let Some(id) = id_of(&manifest).map(str::to_owned) else {
        log::error!("[SHARE] the App Group share manifest names no usable id - dropped");
        return Ok(Import::Dropped);
    };
    let source = group.join(SHARED_INBOX).join(&id);
    let inbox = cache_dir.join(SHARED_INBOX);
    let target = inbox.join(&id);
    std::fs::create_dir_all(&inbox)?;
    if source.exists() {
        if let Err(e) = std::fs::rename(&source, &target) {
            // No copy fallback: the two containers share one volume, and a rename that fails there
            // is the defect to see, not to route around (docs/wiki/frontend/sharing.md).
            log::error!("[SHARE] share {id} could not be moved out of the App Group: {e}");
            delete_share_dir(&group.join(SHARED_INBOX), &id, "unmovable share");
            return Err(e);
        }
    }
    let (files, lost) = files_in_moved_dir(&manifest, &target);
    // READ, NOT ASSUMED: the extension wrote each copy `Complete`, and a rename keeps a file's class.
    // The first copy's class is said, so a device log shows what the move kept.
    if let Some(first) = files
        .first()
        .and_then(|f| f.get("path"))
        .and_then(Value::as_str)
    {
        if let Some(class) = crate::native_cache::file_protection(Path::new(first)) {
            log::info!("[SHARE] share {id}: moved copy protection = {class}");
        }
    }
    if lost > 0 {
        log::warn!(
            "[SHARE] share {id}: {lost} file(s) named by the manifest are not in its directory"
        );
    }
    let refused = refused_of(&manifest) + lost;
    manifest.insert("files".into(), Value::Array(files));
    manifest.insert("refused".into(), Value::from(refused));
    hand_over(data_dir, &inbox, manifest, &id)
}

/// The manifest's file entries rewritten to the moved directory: each keeps its name, mime and size,
/// and its `path` becomes `{target}/{file name}`. Only a regular file found there is kept (no
/// symlink, nothing below a separator); the rest are counted as lost.
fn files_in_moved_dir(manifest: &Map<String, Value>, target: &Path) -> (Vec<Value>, u64) {
    let declared = manifest
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut kept = Vec::new();
    let mut lost = 0u64;
    for mut entry in declared {
        let moved = entry
            .get("path")
            .and_then(Value::as_str)
            .and_then(|p| Path::new(p).file_name().map(|n| target.join(n)))
            .filter(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file()));
        match (moved, entry.as_object_mut()) {
            (Some(path), Some(object)) => {
                object.insert(
                    "path".into(),
                    Value::from(path.to_string_lossy().into_owned()),
                );
                kept.push(entry);
            }
            _ => lost += 1,
        }
    }
    (kept, lost)
}

/// Puts `manifest` in place of whatever the app data directory holds, by Android's rules
/// (`IncomingShare.runCapture` and `reportRefusals`). `inbox` is the app cache's `shared_inbox`.
fn hand_over(
    data_dir: &Path,
    inbox: &Path,
    manifest: Map<String, Value>,
    id: &str,
) -> std::io::Result<Import> {
    std::fs::create_dir_all(data_dir)?;
    let epoch = epoch_of(&manifest);
    if offers_nothing(&manifest) {
        delete_share_dir(inbox, id, "a share that kept nothing");
        return report_refusals(data_dir, inbox, manifest, epoch);
    }
    // CLAIMED, NOT PEEKED AT: the page cannot drain the older one between this reading its id and
    // deleting its copies.
    let replaced = match claim(data_dir, PENDING_SHARE_FILE, "replacing")? {
        Claimed::Nothing => None,
        // The device locked between the two claims. The waiting share may be the NEWER session's,
        // and it cannot be read to tell: it is kept, and this one goes, said.
        Claimed::Protected => {
            log::error!("[SHARE] share {id} dropped: the waiting share is locked and cannot be compared with it");
            delete_share_dir(inbox, id, "a share arriving over a locked one");
            return Ok(Import::Protected);
        }
        Claimed::Read(raw) => parse_manifest(&raw).or_else(|| {
            log::warn!("[SHARE] the waiting share manifest is unreadable - replaced");
            None
        }),
    };
    if let Some(older_session) = replaced.as_ref().filter(|r| epoch_of(r) > epoch) {
        // A NEWER SESSION'S SHARE IS NEVER REPLACED BY AN OLDER ONE: this one could only ever be
        // discarded as stale by the page.
        write_pending(data_dir, older_session)?;
        delete_share_dir(
            inbox,
            id,
            &format!("a share from a signed-out session (epoch {epoch})"),
        );
        return Ok(Import::Dropped);
    }
    if let Err(e) = write_pending(data_dir, &manifest) {
        log::error!("[SHARE] share {id} not handed over: {e}");
        delete_share_dir(inbox, id, "a share not handed over");
        if let Some(r) = &replaced {
            write_pending(data_dir, r)?;
        }
        return Err(e);
    }
    // Handed over: the older share nobody drained is now unreachable, and only now is it gone.
    if let Some(older) = replaced
        .as_ref()
        .and_then(id_of)
        .filter(|older| *older != id)
    {
        log::info!("[SHARE] an undrained share was replaced by a newer one");
        delete_share_dir(inbox, older, "replaced share");
    }
    log::info!(
        "[SHARE] share {id} imported from the App Group: {} file(s), {} refused",
        manifest
            .get("files")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        refused_of(&manifest)
    );
    Ok(Import::Imported)
}

/// A share that kept nothing still has refusals the member must hear about: added to the share
/// waiting from the SAME session, or handed over alone - never across a sign-out.
fn report_refusals(
    data_dir: &Path,
    inbox: &Path,
    manifest: Map<String, Value>,
    epoch: u64,
) -> std::io::Result<Import> {
    let refused = refused_of(&manifest);
    if refused == 0 {
        log::info!("[SHARE] an App Group share with nothing in it - dropped");
        return Ok(Import::Dropped);
    }
    let waiting = match claim(data_dir, PENDING_SHARE_FILE, "replacing")? {
        Claimed::Nothing => None,
        Claimed::Protected => {
            log::warn!("[SHARE] {refused} refusal(s) not reported: the waiting share is locked");
            return Ok(Import::Protected);
        }
        Claimed::Read(raw) => parse_manifest(&raw),
    };
    let payload = match waiting {
        Some(w) if epoch_of(&w) > epoch => {
            write_pending(data_dir, &w)?;
            log::warn!(
                "[SHARE] {refused} refusal(s) from a signed-out session (epoch {epoch}) dropped"
            );
            return Ok(Import::Dropped);
        }
        Some(mut w) if epoch_of(&w) == epoch => {
            let total = refused_of(&w) + refused;
            w.insert("refused".into(), Value::from(total));
            w
        }
        Some(stale) => {
            // The waiting share is from a signed-out session: stale, so it goes, and these stand alone.
            if let Some(id) = id_of(&stale) {
                delete_share_dir(inbox, id, "stale share");
            }
            manifest
        }
        None => manifest,
    };
    log::warn!("[SHARE] a share kept nothing: {refused} refusal(s) reported");
    write_pending(data_dir, &payload)?;
    Ok(Import::Imported)
}

/// What a sweep may keep in one inbox.
#[derive(Debug, PartialEq, Eq)]
enum Waiting {
    /// The id the current session's waiting manifest names, if any: everything else goes.
    Keep(Option<String>),
    /// The waiting manifest is LOCKED (`handoff::is_locked_read`): which copies it names cannot be
    /// read, so the inbox is not swept at all - a sweep never deletes a protected share.
    Protected,
}

/// The id of the manifest waiting in `dir` if it is from the CURRENT session; one from a session that
/// has since signed out (or with the epoch unreadable) is claimed and dropped here, so its copies go
/// with the sweep instead of waiting, on disk, for the next account. Android's
/// `IncomingShare.currentPendingShareId`.
fn current_pending_share_id(
    dir: &Path,
    current: Option<u64>,
    read: &impl Fn(&Path) -> std::io::Result<String>,
) -> Waiting {
    let raw = match read(&dir.join(PENDING_SHARE_FILE)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Waiting::Keep(None),
        Err(e) if is_locked_read(&e) => {
            log::info!(
                "[SHARE] the waiting share manifest in {} is locked - its inbox is not swept",
                dir.display()
            );
            return Waiting::Protected;
        }
        Err(e) => {
            log::warn!(
                "[SHARE] the waiting share manifest in {} is unreadable: {e}",
                dir.display()
            );
            return Waiting::Keep(None);
        }
    };
    let Some(waiting) = parse_manifest(&raw) else {
        log::warn!(
            "[SHARE] the waiting share manifest in {} is unreadable",
            dir.display()
        );
        return Waiting::Keep(None);
    };
    let epoch = epoch_of(&waiting);
    if current.is_none_or(|current| epoch < current) {
        if let Err(e) = claim(dir, PENDING_SHARE_FILE, "replacing") {
            log::warn!("[SHARE] a stale waiting share was not claimed: {e}");
        }
        log::info!("[SHARE] a waiting share from a signed-out session dropped (epoch {epoch} < {current:?})");
        return Waiting::Keep(None);
    }
    Waiting::Keep(id_of(&waiting).map(str::to_owned))
}

/// Deletes every entry of `inbox` but `keep`, and says how many went.
fn sweep_inbox(inbox: &Path, keep: Option<&str>, label: &str) -> usize {
    let entries = match std::fs::read_dir(inbox) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(e) => {
            log::warn!("[SHARE] the {label} inbox is unreadable: {e}");
            return 0;
        }
    };
    let orphans: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()) != keep)
        .collect();
    if orphans.is_empty() {
        return 0;
    }
    log::info!(
        "[SHARE] sweeping {} share(s) left in the {label} inbox by an earlier process",
        orphans.len()
    );
    let mut deleted = 0;
    for orphan in orphans {
        let removed = if orphan.is_dir() {
            std::fs::remove_dir_all(&orphan)
        } else {
            std::fs::remove_file(&orphan)
        };
        match removed {
            Ok(()) => deleted += 1,
            Err(e) => {
                log::warn!("[SHARE] an orphan share in the {label} inbox was not deleted: {e}")
            }
        }
    }
    deleted
}

/// What the launch sweep did, for `canari_ios.mm` to log: it runs before the Rust logger exists, so
/// a `log::` line from it reaches nobody, and this report is the only trace (`sweep_inboxes_once`).
/// `flags` is a set of the `SWEEP_*` bits; the same layout is declared in `canari_rust_bridge.h`.
#[repr(C)]
#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub struct CanariShareSweep {
    /// Share directories deleted, both inboxes together.
    pub deleted: i32,
    /// Leftover claim and staging files deleted from the App Group's root.
    pub leftovers: i32,
    /// `SWEEP_*` bits.
    pub flags: u32,
}

/// The sweep already ran in this process: nothing was done.
pub(crate) const SWEEP_ALREADY_RAN: u32 = 1;
/// The app data or cache directory was not handed over: nothing was done.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) const SWEEP_NO_DIRS: u32 = 1 << 1;
/// The App Group container is unavailable: only the app cache was swept.
pub(crate) const SWEEP_NO_GROUP: u32 = 1 << 2;
/// A capture holds the lock: the App Group inbox waits for the next process.
pub(crate) const SWEEP_GROUP_BUSY: u32 = 1 << 3;
/// The App Group lock could not be tried: its inbox was not swept.
pub(crate) const SWEEP_GROUP_LOCK_FAILED: u32 = 1 << 4;
/// The app's share epoch is unreadable: every waiting share was treated as stale.
pub(crate) const SWEEP_EPOCH_UNREADABLE: u32 = 1 << 5;
/// The App Group's epoch was BEHIND the app's (a failed copy at a sign-out) and was rewritten.
pub(crate) const SWEEP_EPOCH_REPAIRED: u32 = 1 << 6;
/// The App Group's epoch was behind and could NOT be rewritten.
pub(crate) const SWEEP_EPOCH_REPAIR_FAILED: u32 = 1 << 7;
/// A leftover file in the App Group's root could not be deleted.
pub(crate) const SWEEP_LEFTOVER_FAILED: u32 = 1 << 8;
/// A waiting manifest is locked (Data Protection): its inbox was left whole.
pub(crate) const SWEEP_PROTECTED: u32 = 1 << 9;

/// The App Group root files a claim or a staging write leaves when its process dies between the
/// rename and the delete: the app's claims (`.importing`, `.replacing`), the extension's
/// (`.replacing`), the tmp of either's manifest write, and the epoch copy's tmp. An ALLOWLIST: the
/// App Group also holds the NSE's files, which this never touches.
const GROUP_LEFTOVERS: [&str; 4] = [
    "pending_share.json.importing",
    "pending_share.json.replacing",
    "pending_share.json.tmp",
    "share_epoch.tmp",
];

/// Deletes the copies no waiting manifest of the current session names - in the app cache's inbox and
/// in the App Group's - ONCE per process, from the bootstrap, before the page exists: then nobody can
/// be staging them (Android's `IncomingShare.sweepOrphansOnce`). The App Group half runs only when the
/// extension's lock is free, so a capture in progress is never swept; when it is held, its leftovers
/// wait for the next process. It also REPAIRS the App Group's epoch when it is behind the app's.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn sweep_inboxes_once(
    group: Option<&Path>,
    data_dir: &Path,
    cache_dir: &Path,
) -> CanariShareSweep {
    if SWEPT.swap(true, Ordering::SeqCst) {
        return CanariShareSweep {
            flags: SWEEP_ALREADY_RAN,
            ..Default::default()
        };
    }
    sweep_inboxes(group, data_dir, cache_dir)
}

/// The sweep itself, on plain directories (`sweep_inboxes_once` is its once-per-process gate).
fn sweep_inboxes(group: Option<&Path>, data_dir: &Path, cache_dir: &Path) -> CanariShareSweep {
    sweep_inboxes_reading(group, data_dir, cache_dir, &read_handoff)
}

/// Sweeps one inbox unless its waiting manifest is locked.
fn sweep_unless_protected(
    waiting: Waiting,
    inbox: &Path,
    label: &str,
    report: &mut CanariShareSweep,
) -> usize {
    match waiting {
        Waiting::Keep(keep) => sweep_inbox(inbox, keep.as_deref(), label),
        Waiting::Protected => {
            report.flags |= SWEEP_PROTECTED;
            0
        }
    }
}

/// [`sweep_inboxes`] with the manifest reader as a parameter, so a test can stand in for a locked
/// device.
fn sweep_inboxes_reading(
    group: Option<&Path>,
    data_dir: &Path,
    cache_dir: &Path,
    read: &impl Fn(&Path) -> std::io::Result<String>,
) -> CanariShareSweep {
    let mut report = CanariShareSweep::default();
    let current = read_share_epoch(data_dir)
        .inspect_err(|e| {
            report.flags |= SWEEP_EPOCH_UNREADABLE;
            log::error!("[SHARE] the share epoch is unreadable at the sweep: {e}");
        })
        .ok();
    let waiting = current_pending_share_id(data_dir, current, read);
    let mut deleted = sweep_unless_protected(
        waiting,
        &cache_dir.join(SHARED_INBOX),
        "app cache",
        &mut report,
    );
    match group {
        None => report.flags |= SWEEP_NO_GROUP,
        Some(group) => {
            if let Some(current) = current {
                report.flags |= repair_group_epoch(group, current);
            }
            match try_lock_group(group) {
                Ok(Some(_lock)) => {
                    let waiting = current_pending_share_id(group, current, read);
                    deleted += sweep_unless_protected(
                        waiting,
                        &group.join(SHARED_INBOX),
                        "App Group",
                        &mut report,
                    );
                    let (removed, failed) = sweep_group_leftovers(group);
                    report.leftovers = i32::try_from(removed).unwrap_or(i32::MAX);
                    if failed {
                        report.flags |= SWEEP_LEFTOVER_FAILED;
                    }
                }
                Ok(None) => {
                    report.flags |= SWEEP_GROUP_BUSY;
                    log::info!(
                        "[SHARE] a capture is running - the App Group inbox is swept next process"
                    );
                }
                Err(e) => {
                    report.flags |= SWEEP_GROUP_LOCK_FAILED;
                    log::warn!("[SHARE] the App Group inbox lock failed - not swept: {e}");
                }
            }
        }
    }
    report.deleted = i32::try_from(deleted).unwrap_or(i32::MAX);
    report
}

/// RESTORES THE INVARIANT AT ITS SOURCE: the App Group's epoch is never behind the app's. A sign-out
/// whose App Group write failed (`advance_share_epoch` fails closed and says so, but cannot undo the
/// app's own advance) would otherwise leave the extension stamping the PREVIOUS session's epoch on
/// every capture - each one then dropped as stale until the next sign-out. An unreadable copy is
/// rewritten too: the extension reads it as 0, which is stale. Never moves it BACK: a copy ahead of
/// the app's is said and left alone. Returns `SWEEP_EPOCH_*` bits.
fn repair_group_epoch(group: &Path, current: u64) -> u32 {
    let behind = match read_share_epoch(group) {
        Ok(copy) if copy >= current => {
            if copy > current {
                log::warn!(
                    "[SHARE] the App Group's share epoch ({copy}) is ahead of the app's ({current}) - left alone"
                );
            }
            return 0;
        }
        Ok(copy) => format!("{copy}"),
        Err(e) => format!("unreadable ({e})"),
    };
    match write_share_epoch(group, current) {
        Ok(()) => {
            log::error!(
                "[SHARE] the App Group's share epoch was {behind}, behind the app's {current} - rewritten (a sign-out's copy had failed)"
            );
            SWEEP_EPOCH_REPAIRED
        }
        Err(e) => {
            log::error!(
                "[SHARE] the App Group's share epoch is {behind}, behind the app's {current}, and could not be rewritten: {e}"
            );
            SWEEP_EPOCH_REPAIR_FAILED
        }
    }
}

/// Deletes the `GROUP_LEFTOVERS` found in the App Group's root. Called with the extension's lock
/// held, so no capture is between its rename and its delete. Returns (deleted, any failed).
fn sweep_group_leftovers(group: &Path) -> (usize, bool) {
    let (mut removed, mut failed) = (0, false);
    for name in GROUP_LEFTOVERS {
        match std::fs::remove_file(group.join(name)) {
            Ok(()) => {
                removed += 1;
                log::info!("[SHARE] a leftover {name} deleted from the App Group");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                failed = true;
                log::warn!("[SHARE] a leftover {name} in the App Group was not deleted: {e}");
            }
        }
    }
    (removed, failed)
}

/// The factory wipe's half in the App Group (`storage::clear_app_data`): the waiting manifest and
/// every copy in its inbox - an ALLOWLIST of those two paths, the App Group also holding the NSE's
/// files. Taken under the extension's lock; a capture in progress is an error (said), since deleting
/// its directory under it would hand over a manifest naming nothing.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
pub(crate) fn wipe_group_share(group: &Path) -> Result<(), String> {
    let Some(_lock) = try_lock_group(group).map_err(|e| format!("App Group share lock: {e}"))?
    else {
        log::error!(
            "[RESET] a share is being copied into the App Group - its share was not removed"
        );
        return Err("a share is being copied into the App Group".to_string());
    };
    let mut failures = Vec::new();
    match std::fs::remove_file(group.join(PENDING_SHARE_FILE)) {
        Ok(()) => log::info!("[RESET] the App Group's waiting share manifest removed"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => failures.push(format!("{PENDING_SHARE_FILE}: {e}")),
    }
    match std::fs::remove_dir_all(group.join(SHARED_INBOX)) {
        Ok(()) => log::info!("[RESET] the App Group's share inbox removed"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => failures.push(format!("{SHARED_INBOX}: {e}")),
    }
    if failures.is_empty() {
        Ok(())
    } else {
        let joined = failures.join("; ");
        log::error!("[RESET] the App Group share was not entirely removed: {joined}");
        Err(format!(
            "the App Group share was not entirely removed: {joined}"
        ))
    }
}

/// The Tauri command's import, before every drain: resolves the three directories and logs what came
/// of it. A failure here never stops the drain of a manifest already in the app data directory.
#[cfg(target_os = "ios")]
pub(crate) fn import_for_app(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dirs = crate::app_group::app_group_dir().and_then(|group| {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        Ok((group, data, cache))
    });
    match dirs {
        Ok((group, data, cache)) => match import_group_share(&group, &data, &cache) {
            Ok(outcome) => log::debug!("[SHARE] App Group import before the drain: {outcome:?}"),
            Err(e) => log::error!("[SHARE] App Group import before the drain failed: {e}"),
        },
        Err(e) => log::error!("[SHARE] the App Group share cannot be imported: {e}"),
    }
}

/// Decodes the two directories `canari_ios.mm` hands over; `None` (said) on a null pointer.
#[cfg(target_os = "ios")]
unsafe fn ffi_dirs(
    data_dir: *const std::os::raw::c_char,
    cache_dir: *const std::os::raw::c_char,
) -> Option<(PathBuf, PathBuf)> {
    if data_dir.is_null() || cache_dir.is_null() {
        log::error!("[SHARE] the app's data or cache directory was not handed over");
        return None;
    }
    let data = std::ffi::CStr::from_ptr(data_dir)
        .to_string_lossy()
        .into_owned();
    let cache = std::ffi::CStr::from_ptr(cache_dir)
        .to_string_lossy()
        .into_owned();
    Some((PathBuf::from(data), PathBuf::from(cache)))
}

/// `canari_ios_import_app_group_share`'s answer: a share is now waiting for the page.
pub(crate) const IMPORT_IMPORTED: i32 = 1;
/// No share waited in the App Group.
pub(crate) const IMPORT_NOTHING: i32 = 0;
/// A capture holds the lock: imported at the next activation or drain.
pub(crate) const IMPORT_BUSY: i32 = 2;
/// The App Group manifest was unreadable or named no usable id, and was dropped.
pub(crate) const IMPORT_DROPPED: i32 = 3;
/// A manifest is locked by Data Protection: nothing moved, imported at the next activation.
pub(crate) const IMPORT_PROTECTED: i32 = 4;
/// The app data or cache directory was not handed over.
pub(crate) const IMPORT_NO_DIRS: i32 = -1;
/// The App Group container is unavailable.
pub(crate) const IMPORT_NO_GROUP: i32 = -2;
/// The import failed on the file system (a move or a manifest write).
pub(crate) const IMPORT_FAILED: i32 = -3;

/// The code `canari_ios_import_app_group_share` returns for an import's result.
fn import_code(result: &std::io::Result<Import>) -> i32 {
    match result {
        Ok(Import::Imported) => IMPORT_IMPORTED,
        Ok(Import::Nothing) => IMPORT_NOTHING,
        Ok(Import::Busy) => IMPORT_BUSY,
        Ok(Import::Dropped) => IMPORT_DROPPED,
        Ok(Import::Protected) => IMPORT_PROTECTED,
        Err(_) => IMPORT_FAILED,
    }
}

/// Imports the Share Extension's share into the app's handoff, and answers with one of the
/// `IMPORT_*` codes: `IMPORT_IMPORTED` when a manifest is now waiting for the page (the caller then
/// tells a live page, `canari:incoming-share`). A CODE, not only a log line, because the launch call
/// runs before the Rust logger exists: `canari_ios.mm` NSLogs every code but `IMPORT_NOTHING`.
/// Called with the app data directory (`CanariTauriDataDir`) and the app cache directory
/// (`Library/Caches/fr.emse.canari`, Tauri's `app_cache_dir`).
///
/// # Safety
/// Both arguments are null or valid NUL-terminated strings for the duration of the call.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn canari_ios_import_app_group_share(
    data_dir: *const std::os::raw::c_char,
    cache_dir: *const std::os::raw::c_char,
) -> i32 {
    let Some((data, cache)) = ffi_dirs(data_dir, cache_dir) else {
        return IMPORT_NO_DIRS;
    };
    let group = match crate::app_group::app_group_dir() {
        Ok(group) => group,
        Err(e) => {
            log::error!("[SHARE] the App Group share cannot be imported: {e}");
            return IMPORT_NO_GROUP;
        }
    };
    let result = import_group_share(&group, &data, &cache);
    match &result {
        Ok(outcome) => log::debug!("[SHARE] App Group import: {outcome:?}"),
        Err(e) => log::error!("[SHARE] App Group import failed: {e}"),
    }
    import_code(&result)
}

/// The once-per-process sweep (`sweep_inboxes_once`), called by `canari_ios.mm` at bootstrap, which
/// NSLogs the report it returns: the Rust logger does not exist yet at bootstrap, and the sweep
/// cannot wait for it - it must run before any page could be staging a share.
///
/// # Safety
/// Both arguments are null or valid NUL-terminated strings for the duration of the call.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn canari_ios_sweep_shared_inboxes(
    data_dir: *const std::os::raw::c_char,
    cache_dir: *const std::os::raw::c_char,
) -> CanariShareSweep {
    let Some((data, cache)) = ffi_dirs(data_dir, cache_dir) else {
        return CanariShareSweep {
            flags: SWEEP_NO_DIRS,
            ..Default::default()
        };
    };
    let group = crate::app_group::app_group_dir()
        .inspect_err(|e| log::error!("[SHARE] the App Group inbox cannot be swept: {e}"))
        .ok();
    sweep_inboxes_once(group.as_deref(), &data, &cache)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A fresh `(group, data, cache)` triple.
    fn scratch(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "canari-group-share-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let dirs = (root.join("group"), root.join("data"), root.join("cache"));
        for d in [&dirs.0, &dirs.1, &dirs.2] {
            std::fs::create_dir_all(d).expect("scratch dir");
        }
        dirs
    }

    fn cleanup(group: &Path) {
        if let Some(root) = group.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    /// What the extension leaves: one copy per name under `{group}/shared_inbox/{id}/`, and the
    /// manifest naming them by their App Group path.
    fn extension_share(
        group: &Path,
        id: &str,
        epoch: u64,
        text: &str,
        names: &[&str],
        refused: u64,
    ) {
        let dir = group.join(SHARED_INBOX).join(id);
        std::fs::create_dir_all(&dir).expect("share dir");
        let files: Vec<Value> = names
            .iter()
            .map(|n| {
                std::fs::write(dir.join(n), b"abc").expect("copy");
                json!({"path": dir.join(n).to_string_lossy(), "name": n, "mime": "image/png", "size": 3})
            })
            .collect();
        let manifest =
            json!({"id": id, "epoch": epoch, "text": text, "files": files, "refused": refused});
        std::fs::write(group.join(PENDING_SHARE_FILE), manifest.to_string()).expect("manifest");
    }

    fn pending(dir: &Path) -> Option<Value> {
        std::fs::read_to_string(dir.join(PENDING_SHARE_FILE))
            .ok()
            .map(|raw| serde_json::from_str(&raw).expect("json"))
    }

    #[test]
    fn a_share_is_moved_into_the_app_cache_with_its_paths_rewritten() {
        let (group, data, cache) = scratch("move");
        extension_share(&group, "aaaa-1", 0, "hi", &["0_a.png", "1_b.png"], 1);

        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );

        let m = pending(&data).expect("handed over");
        assert_eq!(m["text"], "hi");
        assert_eq!(m["refused"], 1);
        let target = cache.join(SHARED_INBOX).join("aaaa-1");
        let paths: Vec<String> = m["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            paths,
            vec![
                target.join("0_a.png").to_string_lossy().into_owned(),
                target.join("1_b.png").to_string_lossy().into_owned()
            ]
        );
        assert!(target.join("0_a.png").is_file());
        assert!(
            !group.join(SHARED_INBOX).join("aaaa-1").exists(),
            "moved, not copied"
        );
        assert!(pending(&group).is_none(), "claimed out of the App Group");
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Nothing
        );
        cleanup(&group);
    }

    #[test]
    fn a_file_the_manifest_names_but_the_directory_lacks_is_counted_refused() {
        let (group, data, cache) = scratch("lost");
        extension_share(&group, "bbbb-1", 0, "", &["0_a.png"], 0);
        std::fs::remove_file(group.join(SHARED_INBOX).join("bbbb-1").join("0_a.png")).unwrap();
        // It offers nothing then, so it is reported as a refusal alone.
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );
        let m = pending(&data).expect("refusal reported");
        assert_eq!(m["refused"], 1);
        assert_eq!(m["files"].as_array().unwrap().len(), 0);
        cleanup(&group);
    }

    #[test]
    fn a_newer_share_replaces_an_undrained_one_and_deletes_its_copies() {
        let (group, data, cache) = scratch("replace");
        extension_share(&group, "old-1", 2, "old", &["0_a.png"], 0);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );
        extension_share(&group, "new-1", 2, "new", &["0_b.png"], 0);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );

        assert_eq!(pending(&data).unwrap()["text"], "new");
        assert!(!cache.join(SHARED_INBOX).join("old-1").exists());
        assert!(cache
            .join(SHARED_INBOX)
            .join("new-1")
            .join("0_b.png")
            .is_file());
        cleanup(&group);
    }

    #[test]
    fn an_older_sessions_share_never_replaces_a_newer_ones() {
        let (group, data, cache) = scratch("older");
        extension_share(&group, "newer-1", 3, "newer", &["0_a.png"], 0);
        import_group_share(&group, &data, &cache).unwrap();
        extension_share(&group, "older-1", 2, "older", &["0_b.png"], 0);

        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Dropped
        );
        assert_eq!(pending(&data).unwrap()["text"], "newer");
        assert!(!cache.join(SHARED_INBOX).join("older-1").exists());
        assert!(cache.join(SHARED_INBOX).join("newer-1").exists());
        cleanup(&group);
    }

    #[test]
    fn refusals_merge_within_a_session_and_never_across_a_sign_out() {
        let (group, data, cache) = scratch("refusals");
        extension_share(&group, "kept-1", 4, "kept", &["0_a.png"], 0);
        import_group_share(&group, &data, &cache).unwrap();

        // Same session: added to the waiting share, which stays.
        extension_share(&group, "none-1", 4, "", &[], 2);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );
        let m = pending(&data).unwrap();
        assert_eq!(
            (m["text"].as_str(), m["refused"].as_u64()),
            (Some("kept"), Some(2))
        );

        // An older session's refusals: dropped, the waiting share untouched.
        extension_share(&group, "none-2", 3, "", &[], 5);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Dropped
        );
        assert_eq!(pending(&data).unwrap()["refused"], 2);

        // A newer session's refusals: the stale share goes, they stand alone.
        extension_share(&group, "none-3", 5, "", &[], 1);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );
        let m = pending(&data).unwrap();
        assert_eq!(
            (m["text"].as_str(), m["refused"].as_u64()),
            (Some(""), Some(1))
        );
        assert!(!cache.join(SHARED_INBOX).join("kept-1").exists());
        cleanup(&group);
    }

    #[test]
    fn a_capture_holding_the_lock_is_left_alone() {
        let (group, data, cache) = scratch("busy");
        extension_share(&group, "cccc-1", 0, "hi", &["0_a.png"], 0);
        let held = try_lock_group(&group).unwrap().expect("free");
        // Another descriptor on the same file, as the app's import opens one beside the extension's.
        let other = std::fs::OpenOptions::new()
            .write(true)
            .open(group.join(GROUP_LOCK_FILE))
            .unwrap();
        assert!(!try_lock_exclusive(&other).unwrap(), "the lock is held");
        drop(other);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Busy
        );
        assert!(
            pending(&group).is_some(),
            "a running capture's App Group is not touched"
        );
        assert!(pending(&data).is_none());
        drop(held);
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Imported
        );
        cleanup(&group);
    }

    #[test]
    fn an_unsafe_id_is_dropped_and_names_no_directory() {
        let (group, data, cache) = scratch("unsafe");
        std::fs::write(
            group.join(PENDING_SHARE_FILE),
            json!({"id": "../../data", "epoch": 0, "text": "x", "files": [], "refused": 0})
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            import_group_share(&group, &data, &cache).unwrap(),
            Import::Dropped
        );
        assert!(pending(&data).is_none());
        cleanup(&group);
    }

    /// A reader for which every manifest is LOCKED (`EPERM`, as iOS Data Protection answers).
    fn locked(_: &Path) -> std::io::Result<String> {
        Err(std::io::Error::from_raw_os_error(1))
    }

    #[test]
    fn a_locked_manifest_leaves_both_inboxes_whole() {
        let (group, data, cache) = scratch("sweep-locked");
        super::super::handoff::write_share_epoch(&data, 1).unwrap();
        std::fs::create_dir_all(cache.join(SHARED_INBOX).join("live-1")).unwrap();
        std::fs::write(
            data.join(PENDING_SHARE_FILE),
            json!({"id": "live-1", "epoch": 1, "text": "x", "files": [], "refused": 0}).to_string(),
        )
        .unwrap();
        extension_share(&group, "group-1", 1, "y", &["0_a.png"], 0);

        let report = sweep_inboxes_reading(Some(&group), &data, &cache, &locked);
        assert_eq!(report.deleted, 0);
        assert_ne!(report.flags & SWEEP_PROTECTED, 0);
        // Which copies a locked manifest names cannot be read, so nothing it may name is touched.
        assert!(cache.join(SHARED_INBOX).join("live-1").exists());
        assert!(group
            .join(SHARED_INBOX)
            .join("group-1")
            .join("0_a.png")
            .exists());
        assert!(pending(&data).is_some());
        assert!(pending(&group).is_some());
        cleanup(&group);
    }

    #[test]
    fn a_corrupt_manifest_is_no_hiding_place_the_sweep_still_runs() {
        let (group, data, cache) = scratch("sweep-corrupt");
        super::super::handoff::write_share_epoch(&data, 1).unwrap();
        std::fs::create_dir_all(cache.join(SHARED_INBOX).join("orphan-1")).unwrap();
        std::fs::write(data.join(PENDING_SHARE_FILE), "not json").unwrap();

        let report = sweep_inboxes_reading(None, &data, &cache, &read_handoff);
        assert_eq!(report.flags & SWEEP_PROTECTED, 0);
        assert!(!cache.join(SHARED_INBOX).join("orphan-1").exists());
        cleanup(&group);
    }

    #[test]
    fn the_sweep_keeps_only_the_current_sessions_waiting_shares() {
        let (group, data, cache) = scratch("sweep");
        // One sign-out ago; the app data holds a current share, the app cache holds it and an orphan.
        super::super::handoff::write_share_epoch(&data, 1).unwrap();
        std::fs::create_dir_all(cache.join(SHARED_INBOX).join("live-1")).unwrap();
        std::fs::create_dir_all(cache.join(SHARED_INBOX).join("orphan-1")).unwrap();
        std::fs::write(
            data.join(PENDING_SHARE_FILE),
            json!({"id": "live-1", "epoch": 1, "text": "x", "files": [], "refused": 0}).to_string(),
        )
        .unwrap();
        // The App Group holds a share from the signed-out session and a leftover directory.
        extension_share(&group, "stale-1", 0, "old", &["0_a.png"], 0);
        std::fs::create_dir_all(group.join(SHARED_INBOX).join("leftover-1")).unwrap();

        let report = sweep_inboxes(Some(&group), &data, &cache);
        assert_eq!(report.deleted, 3);
        // The App Group had no epoch copy while the app is one sign-out on: repaired at the source.
        assert_eq!(report.flags, SWEEP_EPOCH_REPAIRED);
        assert_eq!(read_share_epoch(&group).unwrap(), 1);

        assert!(cache.join(SHARED_INBOX).join("live-1").exists());
        assert!(!cache.join(SHARED_INBOX).join("orphan-1").exists());
        assert!(
            pending(&group).is_none(),
            "the stale App Group share was dropped"
        );
        assert!(!group.join(SHARED_INBOX).join("stale-1").exists());
        assert!(!group.join(SHARED_INBOX).join("leftover-1").exists());
        assert!(pending(&data).is_some(), "the current share stays");
        cleanup(&group);
    }

    #[test]
    fn the_group_epoch_is_raised_to_the_apps_and_never_lowered() {
        let (group, _data, _cache) = scratch("repair");
        super::super::handoff::write_share_epoch(&group, 2).unwrap();
        assert_eq!(repair_group_epoch(&group, 5), SWEEP_EPOCH_REPAIRED);
        assert_eq!(read_share_epoch(&group).unwrap(), 5);
        assert_eq!(repair_group_epoch(&group, 5), 0, "level: nothing to do");
        assert_eq!(repair_group_epoch(&group, 3), 0, "ahead: never moved back");
        assert_eq!(read_share_epoch(&group).unwrap(), 5);
        std::fs::write(group.join("share_epoch"), "garbage").unwrap();
        assert_eq!(repair_group_epoch(&group, 4), SWEEP_EPOCH_REPAIRED);
        assert_eq!(read_share_epoch(&group).unwrap(), 4);
        cleanup(&group);
    }

    #[test]
    fn the_sweep_deletes_the_allowlisted_leftovers_and_nothing_else() {
        let (group, data, cache) = scratch("leftovers");
        for name in GROUP_LEFTOVERS {
            std::fs::write(group.join(name), "x").unwrap();
        }
        // The NSE's files live beside them.
        std::fs::write(group.join("push_context.json"), "{}").unwrap();
        let report = sweep_inboxes(Some(&group), &data, &cache);
        assert_eq!(report.leftovers, 4);
        for name in GROUP_LEFTOVERS {
            assert!(!group.join(name).exists(), "{name}");
        }
        assert!(group.join("push_context.json").exists());
        // Held lock: the App Group root is left alone, and the report says why.
        std::fs::write(group.join(GROUP_LEFTOVERS[0]), "x").unwrap();
        let held = try_lock_group(&group).unwrap().expect("free");
        let report = sweep_inboxes(Some(&group), &data, &cache);
        assert_eq!(report.flags & SWEEP_GROUP_BUSY, SWEEP_GROUP_BUSY);
        assert!(group.join(GROUP_LEFTOVERS[0]).exists());
        drop(held);
        cleanup(&group);
    }

    #[test]
    fn no_group_and_an_unreadable_epoch_are_reported() {
        let (group, data, cache) = scratch("report");
        std::fs::write(data.join("share_epoch"), "garbage").unwrap();
        let report = sweep_inboxes(None, &data, &cache);
        assert_eq!(report.flags, SWEEP_NO_GROUP | SWEEP_EPOCH_UNREADABLE);
        cleanup(&group);
    }

    #[test]
    fn the_wipe_removes_the_group_share_and_only_it() {
        let (group, _data, _cache) = scratch("wipe");
        extension_share(&group, "dddd-1", 0, "hi", &["0_a.png"], 0);
        std::fs::write(group.join("push_context.json"), "{}").unwrap();
        let held = try_lock_group(&group).unwrap().expect("free");
        assert!(
            wipe_group_share(&group).is_err(),
            "a running capture is refused"
        );
        assert!(pending(&group).is_some());
        drop(held);
        wipe_group_share(&group).unwrap();
        assert!(pending(&group).is_none());
        assert!(!group.join(SHARED_INBOX).exists());
        assert!(group.join("push_context.json").exists());
        wipe_group_share(&group).expect("nothing left is not an error");
        cleanup(&group);
    }

    #[test]
    fn every_import_outcome_has_its_own_code() {
        let codes = [
            import_code(&Ok(Import::Imported)),
            import_code(&Ok(Import::Nothing)),
            import_code(&Ok(Import::Busy)),
            import_code(&Ok(Import::Dropped)),
            import_code(&Ok(Import::Protected)),
            import_code(&Err(std::io::Error::other("x"))),
            IMPORT_NO_DIRS,
            IMPORT_NO_GROUP,
        ];
        let distinct: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(distinct.len(), codes.len());
        assert_eq!(codes[0], 1, "canari_ios.mm tells the page on 1");
    }
}
