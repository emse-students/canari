//! One MLS state per ACCOUNT on an install more than one account signs in on (owner, 2026-11-02).
//!
//! **THE SLOT AND THE PARKED STATES.** Every engine that reads the MLS state - the foreground
//! manager, the Android push and background engines, the iOS mirror the notification extension
//! decrypts with - reads `{app_data_dir}/mls.bin`, and every one of them reads it for the account
//! signed in on the install, because that is the only account a push or a resume is ever for. So
//! that path stays THE SLOT: the signed-in account's state. Every other account's state is PARKED,
//! whole and untouched, under `{app_data_dir}/mls_accounts/<sha256(user id)>/`, with the same file
//! names ([`mls_state_file_names`]) - its owner record included.
//!
//! When an account signs in (`initialiser_mls`, [`select_account_state`]), the state in the slot is
//! parked under the account its owner record names and the signing-in account's parked state, if
//! any, is moved into the slot. **The files are RENAMED, never read or rewritten**: no byte of an
//! MLS state, and no key, is touched by a switch. Before this, account B signing in on account A's
//! install found A's `mls.bin`, could not open it, and the only exit was a reinstall (backlog "P3 -
//! switching accounts on one iPhone install").
//!
//! **OWNERSHIP IS PROVEN BY THE OWNER RECORD, NEVER GUESSED.** `mls.owner` is written by
//! `initialiser_mls` only after `load_or_create` OPENED the state for that account (its credential
//! check refuses another account's state), so it names the account that created or last opened the
//! file. That is the whole migration of an existing `mls.bin`: it already sits in the slot, with the
//! record naming its account, and the first sign-in of ANOTHER account parks it under that name. A
//! slot holding a state with NO record (written before `v1.3.0` and never opened since) is never
//! moved and never attributed: it is left where it is, accused at ERROR, and only the load - the
//! credential check - can say whose it is.
//!
//! **A MOVE CUT PART-WAY IS FINISHED, NOT GUESSED AT.** A park first creates `<hash>.parking/`, an
//! unpark first renames `<hash>/` to `<hash>.unparking/`; each directory is a durable statement that
//! the files of the slot (parking) or in it (unparking) belong to that account, so the next process
//! completes the move before anything reads a state ([`settle_pending_moves_held`]). No clock, no
//! retry: the directories ARE the journal. Where both ends hold one file, THE SLOT'S COPY WINS: the
//! journal proves both are that account's, and the slot is where every writer writes, so its copy
//! is the later one.
//!
//! **ONE ACCOUNT'S BROKEN JOURNAL STOPS THAT ACCOUNT, NOT THE INSTALL** (review of #2919). A move that
//! cannot be finished is reported against the account it belongs to; every other account's query
//! still answers. Only a PARK that cannot finish also refuses other accounts' sign-ins: the slot then
//! still holds part of that account's state, and handing it onward is the cross-account write this
//! module exists to prevent. A file nobody listed in a parked directory never blocks anything: it is
//! set aside as `<hash>.residue-<n>` and accused.
//!
//! Everything here runs under [`mls_bin_write_lock`], the lock every writer of the state files takes
//! (`mls.bin`, the JSON ledgers, and the key-group join's ledger and stage in `key_group_join.rs`), so
//! no write lands between a park and its unpark, and a background engine that loaded the slot before
//! a switch fails its compare-and-swap re-read.

use std::path::{Path, PathBuf};

use crate::commands::storage::{mls_state_file_names, read_mls_state_owner, remove_mls_state_held};
use crate::concurrency::{
    live_manager_in_process, mark_foreground_active, mark_foreground_manager_loading,
    mls_bin_write_lock,
};

/// The directory, beside `mls.bin`, holding the states of the accounts NOT signed in on the install.
pub(crate) const PARKED_STATES_DIR: &str = "mls_accounts";

/// Suffix of a park in progress: the slot's files are moving into this directory.
const PARKING_SUFFIX: &str = ".parking";

/// Suffix of an unpark in progress: this directory's files are moving into the slot.
const UNPARKING_SUFFIX: &str = ".unparking";

/// Infix of a directory holding files a parked state carried that no list names - set aside, accused.
const RESIDUE_INFIX: &str = ".residue-";

/// What [`select_account_state`] did to give the slot to the signing-in account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Selection {
    /// The slot already holds this account's state (its owner record names it): nothing moved.
    AlreadyInSlot,
    /// `parked_other`: the slot's state was parked under the account its record names.
    /// `unparked`: this account's parked state was moved into the slot.
    Moved { parked_other: bool, unparked: bool },
    /// The slot holds a state with NO owner record: nothing moved, nothing attributed. The load
    /// under this account's key is the only proof of whose it is.
    UnprovenLeftInSlot,
}

/// A journalled move [`settle_pending_moves_held`] could not finish, named by the account it is of.
struct UnfinishedMove {
    /// The parked directory name (the account's hash) the move belongs to.
    account: String,
    /// A park: part of that account's state may still be in the slot.
    park: bool,
}

/// The directory name of `user_id`'s parked state: the hex SHA-256 of the id.
///
/// A HASH AND NOT THE ID, for two reasons a filesystem imposes: an id is free text a path must not
/// be built from, and iOS's default volume is case-insensitive, where `Alice` and `alice` would be
/// one directory - one account's state handed to the other.
fn parked_dir_name(user_id: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(user_id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `{data_dir}/mls_accounts/<hash>` for `user_id`.
fn parked_dir(data_dir: &Path, user_id: &str) -> PathBuf {
    data_dir
        .join(PARKED_STATES_DIR)
        .join(parked_dir_name(user_id))
}

/// `path` with `suffix` appended to its last component.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

/// Whether the slot holds a state: a non-empty `mls.bin`. An empty one is the trace of a write cut
/// short and is no state (the same rule `state_file_absent` applies).
pub(crate) fn slot_holds_state(data_dir: &Path) -> bool {
    std::fs::metadata(data_dir.join("mls.bin"))
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

/// Whether a FRESH START asked of `initialiser_mls` would be sealed over this account's own state
/// that the switch has just brought back: the caller decided "no state" on an answer that did not
/// see it. Only a non-empty `mls.bin` counts - a parked owner record alone is no state to lose.
pub(crate) fn fresh_start_would_replace_unparked_state(
    selection: Selection,
    caller_says_no_state: bool,
    data_dir: &Path,
) -> bool {
    caller_says_no_state
        && matches!(selection, Selection::Moved { unparked: true, .. })
        && slot_holds_state(data_dir)
}

/// Moves every state file present in `from` into `to`, in [`mls_state_file_names`] order (the owner
/// record LAST). Where both ends hold one file, the SLOT'S copy is kept (see the module comment):
/// moving out of the slot replaces the older copy, moving into it drops it. Only ever called where a
/// journal proves both ends are one account's.
fn move_state_files(from: &Path, to: &Path, from_is_slot: bool) -> Result<usize, String> {
    let mut moved = 0;
    for name in mls_state_file_names() {
        let src = from.join(&name);
        if !src.exists() {
            continue;
        }
        let dst = to.join(&name);
        if dst.exists() {
            if from_is_slot {
                log::warn!(
                    "[MLS_ACCOUNT] {name} is at both ends of a park - the slot's later copy replaces the parked one"
                );
                std::fs::remove_file(&dst).map_err(|e| format!("replace {name}: {e}"))?;
            } else {
                log::warn!(
                    "[MLS_ACCOUNT] {name} is at both ends of an unpark - the slot's later copy is kept, the parked one dropped"
                );
                std::fs::remove_file(&src).map_err(|e| format!("drop {name}: {e}"))?;
                continue;
            }
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("move {name}: {e}"))?;
        moved += 1;
    }
    Ok(moved)
}

/// Removes `dir` once its listed files are gone; anything left in it was never listed, so the
/// directory is set aside as `<dir>.residue-<n>` and accused - it never blocks a move again.
fn remove_or_set_aside(dir: &Path) -> Result<(), String> {
    if std::fs::remove_dir(dir).is_ok() {
        return Ok(());
    }
    let left: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    // Named after the account (`<hash>.residue-<n>`), never after the move it was found in.
    let base = PathBuf::from(
        dir.to_string_lossy()
            .trim_end_matches(UNPARKING_SUFFIX)
            .to_string(),
    );
    let mut n = 0u32;
    let aside = loop {
        let candidate = with_suffix(&base, &format!("{RESIDUE_INFIX}{n}"));
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };
    std::fs::rename(dir, &aside).map_err(|e| format!("set the residue aside: {e}"))?;
    log::error!(
        "[MLS_ACCOUNT] a parked state carried {} file(s) no list names ({}) - set aside, nothing deleted",
        left.len(),
        left.join(", ")
    );
    Ok(())
}

/// Completes a park: the slot's remaining state files into `staging`, then `staging` renamed to its
/// final name. `staging` existing IS the proof that the slot's files are that account's.
fn finish_park(data_dir: &Path, staging: &Path) -> Result<(), String> {
    let final_dir = PathBuf::from(
        staging
            .to_string_lossy()
            .strip_suffix(PARKING_SUFFIX)
            .ok_or_else(|| "a park directory without its suffix".to_string())?,
    );
    let moved = move_state_files(data_dir, staging, true)?;
    if final_dir.exists() {
        log::error!(
            "[MLS_ACCOUNT] TWO PARKED STATES FOR ONE ACCOUNT - the park is left staged, nothing overwritten"
        );
        return Err("this account already has a parked state".to_string());
    }
    std::fs::rename(staging, &final_dir).map_err(|e| format!("rename the parked state: {e}"))?;
    log::info!("[MLS_ACCOUNT] slot state parked ({moved} file(s) moved)");
    Ok(())
}

/// Completes an unpark: `staging`'s state files into the slot, then `staging` removed (or set aside
/// when it still holds a file nobody listed).
fn finish_unpark(data_dir: &Path, staging: &Path) -> Result<(), String> {
    let moved = move_state_files(staging, data_dir, false)?;
    remove_or_set_aside(staging)?;
    log::info!("[MLS_ACCOUNT] parked state moved into the slot ({moved} file(s) moved)");
    Ok(())
}

/// Finishes every move a previous process was cut in the middle of: parks first, then unparks - the
/// order one selection runs them in. **EACH MOVE IS FINISHED OR REPORTED ON ITS OWN**: one that
/// fails is logged at ERROR and returned against its account, and the others still run.
/// **THE CALLER HOLDS [`mls_bin_write_lock`].**
fn settle_pending_moves_held(data_dir: &Path) -> Vec<UnfinishedMove> {
    let root = data_dir.join(PARKED_STATES_DIR);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            // Nothing can be located without this directory; reported against no account in
            // particular, as a park - the slot's state cannot be proven whole either.
            log::error!("[MLS_ACCOUNT] {PARKED_STATES_DIR} unreadable: {e}");
            return vec![UnfinishedMove {
                account: String::new(),
                park: true,
            }];
        }
    };
    let mut parking = Vec::new();
    let mut unparking = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(account) = name.strip_suffix(UNPARKING_SUFFIX) {
            unparking.push((account.to_string(), entry.path()));
        } else if let Some(account) = name.strip_suffix(PARKING_SUFFIX) {
            parking.push((account.to_string(), entry.path()));
        }
    }
    if parking.len() + unparking.len() > 0 {
        log::warn!(
            "[MLS_ACCOUNT] {} park(s) and {} unpark(s) were cut part-way by a previous process - finishing them",
            parking.len(),
            unparking.len()
        );
    }
    let mut unfinished = Vec::new();
    for (account, staging) in parking {
        if let Err(e) = finish_park(data_dir, &staging) {
            log::error!("[MLS_ACCOUNT] a cut park could not be finished: {e}");
            unfinished.push(UnfinishedMove {
                account,
                park: true,
            });
        }
    }
    for (account, staging) in unparking {
        if let Err(e) = finish_unpark(data_dir, &staging) {
            log::error!("[MLS_ACCOUNT] a cut unpark could not be finished: {e}");
            unfinished.push(UnfinishedMove {
                account,
                park: false,
            });
        }
    }
    unfinished
}

/// The refusal owed to `user_id` from the moves [`settle_pending_moves_held`] left unfinished: its
/// own, always; another account's park only when `needs_slot` (a sign-in, never a query).
fn refusal_for(unfinished: &[UnfinishedMove], user_id: &str, needs_slot: bool) -> Option<String> {
    let mine = parked_dir_name(user_id);
    unfinished
        .iter()
        .find(|m| m.account == mine || (needs_slot && m.park))
        .map(|m| {
            if m.account == mine {
                "this account's state was cut part-way through a move that cannot be finished"
                    .to_string()
            } else {
                "the slot still holds part of another account's state".to_string()
            }
        })
}

/// The path of `user_id`'s `mls.bin` on this install, or `None` when the account has no state here.
///
/// - the slot, when its owner record names `user_id`;
/// - the account's parked `mls.bin`, when it has one;
/// - the slot, when it holds a state with NO record - unproven, so the load decides, which is the
///   answer this install gave before one state per account existed;
/// - otherwise `None`: the slot is another account's, and this account has nothing here.
///
/// Read-only apart from finishing a move a previous process left cut ([`settle_pending_moves_held`]):
/// the move itself happens at sign-in, in [`select_account_state`].
pub(crate) fn account_state_file(
    data_dir: &Path,
    user_id: &str,
) -> Result<Option<PathBuf>, String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if let Some(refusal) = refusal_for(&settle_pending_moves_held(data_dir), user_id, false) {
        return Err(refusal);
    }
    let parked = parked_dir(data_dir, user_id);
    let located = match read_mls_state_owner(data_dir) {
        Some(owner) if owner == user_id => Some(data_dir.join("mls.bin")),
        _ if parked.exists() => Some(parked.join("mls.bin")),
        None if slot_holds_state(data_dir) => {
            log::warn!(
                "[MLS_ACCOUNT] the slot holds a state with no owner record - offered to the load, whose credential check decides"
            );
            Some(data_dir.join("mls.bin"))
        }
        _ => None,
    };
    log::debug!(
        "[MLS_ACCOUNT] the account's state is {}",
        match &located {
            None => "absent from this install",
            Some(p) if p.starts_with(data_dir.join(PARKED_STATES_DIR)) => "parked",
            Some(_) => "in the slot",
        }
    );
    Ok(located)
}

/// Gives the slot to `user_id`: parks the state it holds under the account its owner record names,
/// then moves `user_id`'s parked state, if any, into it. Called by `initialiser_mls` before it reads
/// the slot, on every path - a fresh start included, which would otherwise seal a new state over the
/// previous account's file.
///
/// **THE PROCESS IS MARKED WARM IN THE SAME HOLD** (review of #2919): a second sign-in interleaved
/// with this one then finds a manager loading and is refused, instead of selecting the slot for its
/// own account between this selection and this account's load - which wrote one account's owner
/// beside the other's state. The caller's install guard clears the mark if the sign-in fails.
///
/// **REFUSED, WITH NOTHING MOVED**, when a foreground manager is loaded (or loading) in this process
/// and the slot is not already this account's, and when the move would overwrite anything: two parked
/// states for one account, or a parked state to unpark into a slot that holds an unproven one.
pub(crate) fn select_account_state(data_dir: &Path, user_id: &str) -> Result<Selection, String> {
    log::debug!("[MLS_ACCOUNT] selecting the signing-in account's state");
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let selection = select_held(data_dir, user_id)?;
    mark_foreground_manager_loading();
    if matches!(selection, Selection::Moved { .. }) {
        refresh_extension_copy(data_dir);
    }
    log::info!("[MLS_ACCOUNT] slot selected for the signing-in account: {selection:?}");
    Ok(selection)
}

/// [`select_account_state`] under the lock it holds.
fn select_held(data_dir: &Path, user_id: &str) -> Result<Selection, String> {
    if let Some(refusal) = refusal_for(&settle_pending_moves_held(data_dir), user_id, true) {
        log::error!("[MLS_ACCOUNT] sign-in refused: {refusal}");
        return Err(refusal);
    }
    let owner = read_mls_state_owner(data_dir);
    if owner.as_deref() != Some(user_id) && live_manager_in_process() {
        log::error!(
            "[MLS_ACCOUNT] a foreground manager is loaded or loading in this process - the slot is NOT switched under it"
        );
        return Err("a foreground MLS session is still open".to_string());
    }
    let mine = parked_dir(data_dir, user_id);
    let mine_parked = mine.exists();

    let mut parked_other = false;
    match owner {
        Some(owner) if owner == user_id => {
            if mine_parked {
                log::error!(
                    "[MLS_ACCOUNT] the slot AND a parked state both belong to the signing-in account - neither is moved"
                );
                return Err("two states for one account".to_string());
            }
            log::debug!("[MLS_ACCOUNT] the slot already holds the account's state");
            return Ok(Selection::AlreadyInSlot);
        }
        Some(owner) => {
            // A sign-in IS the foreground: a background engine checking the guard gives way early,
            // and one that loaded the slot before this hold fails its compare-and-swap re-read.
            mark_foreground_active();
            let other = parked_dir(data_dir, &owner);
            if other.exists() {
                log::error!(
                    "[MLS_ACCOUNT] the slot's owner already has a parked state - nothing moved, nothing overwritten"
                );
                return Err("the slot's owner already has a parked state".to_string());
            }
            std::fs::create_dir_all(data_dir.join(PARKED_STATES_DIR))
                .map_err(|e| format!("create {PARKED_STATES_DIR}: {e}"))?;
            let staging = with_suffix(&other, PARKING_SUFFIX);
            std::fs::create_dir(&staging).map_err(|e| format!("create the park: {e}"))?;
            finish_park(data_dir, &staging)?;
            parked_other = true;
        }
        None if slot_holds_state(data_dir) => {
            if mine_parked {
                log::error!(
                    "[MLS_ACCOUNT] the slot holds a state with NO owner record and the account has a parked one - neither is moved, the unproven state is not handed to anyone"
                );
                return Err("the slot holds a state of unproven owner".to_string());
            }
            log::error!(
                "[MLS_ACCOUNT] the slot holds a state with NO owner record - left in place for its owner, never attributed; the load's credential check decides"
            );
            return Ok(Selection::UnprovenLeftInSlot);
        }
        None => {}
    }

    if mine_parked {
        mark_foreground_active();
        let staging = with_suffix(&mine, UNPARKING_SUFFIX);
        std::fs::rename(&mine, &staging).map_err(|e| format!("start the unpark: {e}"))?;
        finish_unpark(data_dir, &staging)?;
    }
    Ok(Selection::Moved {
        parked_other,
        unparked: mine_parked,
    })
}

/// Makes the iOS notification extension's copy of `mls.bin` in the App Group the slot's again after
/// a switch - written when the slot holds a state, DELETED when it holds none - so the extension
/// never decrypts the new account's pushes with the previous account's state until the next
/// activation's mirror. A failure is accused and the switch stands: the copy is a cache, and the
/// mirror at the next activation rewrites it. A no-op off iOS.
fn refresh_extension_copy(data_dir: &Path) {
    #[cfg(target_os = "ios")]
    {
        match crate::app_group::app_group_dir() {
            Ok(group) => {
                if let Err(e) = sync_extension_copy(data_dir, &group) {
                    log::error!(
                        "[MLS_ACCOUNT] the extension's copy of the state was not refreshed: {e}"
                    );
                }
            }
            Err(e) => log::error!(
                "[MLS_ACCOUNT] no App Group container - the extension's copy was not refreshed: {e}"
            ),
        }
    }
    #[cfg(not(target_os = "ios"))]
    let _ = data_dir;
}

/// [`refresh_extension_copy`] on two real directories: the slot's `mls.bin` copied into `group`
/// atomically (tmp + rename), or `group`'s copy removed when the slot holds no state.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn sync_extension_copy(data_dir: &Path, group: &Path) -> Result<(), String> {
    let copy = group.join("mls.bin");
    if slot_holds_state(data_dir) {
        let tmp = group.join("mls.bin.tmp");
        std::fs::copy(data_dir.join("mls.bin"), &tmp).map_err(|e| format!("copy mls.bin: {e}"))?;
        std::fs::rename(&tmp, &copy).map_err(|e| format!("rename mls.bin copy: {e}"))?;
        log::info!("[MLS_ACCOUNT] the extension's copy of the state now follows the slot");
    } else {
        match std::fs::remove_file(&copy) {
            Ok(()) => log::info!(
                "[MLS_ACCOUNT] the extension's copy of the previous account's state removed"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove the mls.bin copy: {e}")),
        }
    }
    Ok(())
}

/// What [`remove_account_state`] removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Removed {
    /// Files of the account's parked state.
    pub parked_files: usize,
    /// Whether the slot was the account's and was swept.
    pub slot: bool,
}

/// Removes EVERY MLS state `user_id` has on this install - the deleted-account wipe
/// (`accountLocalWipe.ts`), after which nobody can ever open it again: its parked directory, and the
/// SLOT when the slot's owner record names it (review of #2919: a deleted account that signed in last
/// left its state there, and the next switch parked it under its name for ever).
///
/// The slot is swept only on that proof, and REFUSED while a foreground manager is loaded: the
/// manager's next checkpoint would write the state back.
pub(crate) fn remove_account_state(data_dir: &Path, user_id: &str) -> Result<Removed, String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let unfinished = settle_pending_moves_held(data_dir);
    if let Some(refusal) = refusal_for(&unfinished, user_id, false) {
        return Err(refusal);
    }
    let mut removed = Removed {
        parked_files: 0,
        slot: false,
    };
    if read_mls_state_owner(data_dir).as_deref() == Some(user_id) {
        if live_manager_in_process() {
            log::error!(
                "[MLS_ACCOUNT] the deleted account's state is in the slot under a loaded manager - not swept"
            );
            return Err("a foreground MLS session is still open".to_string());
        }
        remove_mls_state_held(data_dir)?;
        removed.slot = true;
        refresh_extension_copy(data_dir);
        log::info!("[MLS_ACCOUNT] the deleted account's state removed from the slot");
    }
    let dir = parked_dir(data_dir, user_id);
    if dir.exists() {
        for name in mls_state_file_names() {
            if dir.join(&name).exists() {
                removed.parked_files += 1;
            }
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove the parked state: {e}"))?;
        log::info!(
            "[MLS_ACCOUNT] the deleted account's parked state removed ({} file(s))",
            removed.parked_files
        );
    } else {
        log::debug!("[MLS_ACCOUNT] no parked state for the deleted account");
    }
    Ok(removed)
}

/// The frontend's view of [`remove_account_state`]: the number of state files removed, the slot's
/// counted as one.
///
/// SYNCHRONOUS, like `delete_user_push_files`: on iOS it runs on the main thread, where the
/// activation mirror runs, so the mirror cannot copy the swept slot back into the App Group between
/// the sweep and the copy's removal.
#[tauri::command]
pub(crate) fn delete_user_mls_state(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<usize, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let removed = remove_account_state(&data_dir, &user_id)?;
    Ok(removed.parked_files + usize::from(removed.slot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::storage::MLS_STATE_OWNER_FILE;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canari-account-state-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// What `initialiser_mls` leaves in the slot once `user`'s state was opened and saved there.
    fn sign_in_and_save(dir: &Path, user: &str, state: &[u8]) {
        std::fs::write(dir.join(MLS_STATE_OWNER_FILE), user).unwrap();
        std::fs::write(dir.join("mls.bin"), state).unwrap();
    }

    /// A sign-in's selection followed by its sign-out: the session the selection marked warm ends.
    fn select(dir: &Path, user: &str) -> Result<Selection, String> {
        let selected = select_account_state(dir, user);
        crate::concurrency::forget_live_manager_for_test();
        selected
    }

    fn slot(dir: &Path) -> Option<Vec<u8>> {
        std::fs::read(dir.join("mls.bin")).ok()
    }

    fn owner(dir: &Path) -> Option<String> {
        read_mls_state_owner(dir)
    }

    /// Serialises with every other test that reads or flips the process-wide live-manager flag.
    fn cold() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::concurrency::test_support::serialise();
        crate::concurrency::forget_live_manager_for_test();
        guard
    }

    /// THE A -> B -> A -> B READING, AS A TEST: two accounts take turns on one install and each
    /// finds ITS OWN bytes in the slot every time, byte for byte - a switch moves, never rewrites.
    #[test]
    fn two_accounts_switching_back_and_forth_each_find_their_own_state() {
        let _cold = cold();
        let dir = temp_dir("switch");
        let a_state = b"account A's sealed state".to_vec();
        let b_state = b"account B's sealed state".to_vec();

        // A signs in on a fresh install: nothing to move.
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: false
            }
        );
        sign_in_and_save(&dir, "user-a", &a_state);
        std::fs::write(dir.join("background_stages.json"), b"A's stages").unwrap();

        // B signs in: A's state is parked whole (ledger included), B starts with an empty slot.
        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::Moved {
                parked_other: true,
                unparked: false
            }
        );
        assert_eq!(slot(&dir), None, "B must not be handed A's state");
        assert!(!dir.join("background_stages.json").exists());
        assert_eq!(owner(&dir), None);
        sign_in_and_save(&dir, "user-b", &b_state);

        // A is located while parked, then gets its bytes back unchanged; B's go aside.
        let a_parked = account_state_file(&dir, "user-a").unwrap().unwrap();
        assert_eq!(std::fs::read(&a_parked).unwrap(), a_state);
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::Moved {
                parked_other: true,
                unparked: true
            }
        );
        assert_eq!(slot(&dir), Some(a_state.clone()));
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        assert_eq!(
            std::fs::read(dir.join("background_stages.json")).unwrap(),
            b"A's stages",
            "what was built from A's state comes back with it"
        );

        // And B again.
        select(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir), Some(b_state.clone()));
        assert_eq!(owner(&dir).as_deref(), Some("user-b"));
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(dir.join("mls.bin"))
        );

        // Selecting the account already in the slot moves nothing.
        assert_eq!(select(&dir, "user-b").unwrap(), Selection::AlreadyInSlot);
        assert_eq!(slot(&dir), Some(b_state));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// THE MIGRATION: an install from before this change holds ONE `mls.bin` and the record naming
    /// the account that opened it. That account keeps it in place; the first OTHER account parks it
    /// under that name, and the owner gets it back - nothing decided by anything but the record.
    #[test]
    fn an_existing_mls_bin_goes_to_the_account_its_record_names() {
        let _cold = cold();
        let dir = temp_dir("migration");
        sign_in_and_save(&dir, "user-a", b"pre-existing state");

        assert_eq!(select(&dir, "user-a").unwrap(), Selection::AlreadyInSlot);
        assert_eq!(slot(&dir).as_deref(), Some(&b"pre-existing state"[..]));

        select(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir), None);
        let parked = parked_dir(&dir, "user-a");
        assert_eq!(
            std::fs::read(parked.join("mls.bin")).unwrap(),
            b"pre-existing state"
        );
        assert_eq!(
            std::fs::read_to_string(parked.join(MLS_STATE_OWNER_FILE)).unwrap(),
            "user-a",
            "the record travels with the state it names"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A STATE NOBODY IS RECORDED FOR IS NEVER HANDED TO ANYONE: it stays in the slot, offered only
    /// to the load whose credential check is the proof - and never moved aside for a parked state.
    #[test]
    fn a_state_with_no_owner_record_is_left_in_the_slot() {
        let _cold = cold();
        let dir = temp_dir("unproven");
        std::fs::write(dir.join("mls.bin"), b"state of unknown owner").unwrap();

        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        assert_eq!(slot(&dir).as_deref(), Some(&b"state of unknown owner"[..]));
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(dir.join("mls.bin"))
        );

        // With a parked state of its own, the account is refused rather than either being moved.
        let mine = parked_dir(&dir, "user-b");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::write(mine.join("mls.bin"), b"B's parked state").unwrap();
        assert!(select(&dir, "user-b").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"state of unknown owner"[..]));
        assert_eq!(
            std::fs::read(mine.join("mls.bin")).unwrap(),
            b"B's parked state"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A LIVE FOREGROUND MANAGER IS NEVER SWITCHED UNDER: its next checkpoint would write its
    /// account's state into the slot just given to another.
    #[test]
    fn the_slot_is_not_switched_under_a_live_manager() {
        let _cold = cold();
        let dir = temp_dir("live");
        sign_in_and_save(&dir, "user-a", b"A");
        crate::concurrency::mark_foreground_manager_loading();
        let refused = select(&dir, "user-b");

        assert!(refused.is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F2 (review of #2919): TWO SIGN-INS INTERLEAVED. The first selection marks the process warm in
    /// its own hold, so the second - for another account, between the first's selection and its
    /// load - is refused instead of selecting the slot for itself and leaving one account's owner
    /// beside the other's state. Once the first session ends, the second goes through.
    #[test]
    fn a_second_sign_in_between_a_selection_and_its_load_is_refused() {
        let _cold = cold();
        let dir = temp_dir("interleaved");
        sign_in_and_save(&dir, "user-b", b"B");
        select(&dir, "user-a").unwrap();
        sign_in_and_save(&dir, "user-a", b"A");
        select(&dir, "user-b").unwrap();

        // B's sign-in selects (B's state is in the slot, the process is now warm)...
        assert_eq!(
            select_account_state(&dir, "user-b").unwrap(),
            Selection::AlreadyInSlot
        );
        // ...and A's, interleaved before B's load, is refused with nothing moved.
        assert!(select_account_state(&dir, "user-a").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        assert_eq!(owner(&dir).as_deref(), Some("user-b"));
        // An empty slot too: the first fresh sign-in owns it until its session ends.
        crate::concurrency::forget_live_manager_for_test();
        let fresh = temp_dir("interleaved-fresh");
        select_account_state(&fresh, "user-a").unwrap();
        assert!(select_account_state(&fresh, "user-b").is_err());
        crate::concurrency::forget_live_manager_for_test();
        assert!(select(&fresh, "user-b").is_ok());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&fresh).ok();
    }

    /// A MOVE CUT PART-WAY IS FINISHED by the next process, from the directory that journals it -
    /// before anything locates a state.
    #[test]
    fn a_park_or_an_unpark_cut_part_way_is_finished() {
        let _cold = cold();
        let dir = temp_dir("cut");
        // A park of A cut after `mls.bin` moved and before its record did.
        sign_in_and_save(&dir, "user-a", b"A");
        let a = parked_dir(&dir, "user-a");
        let staging = with_suffix(&a, PARKING_SUFFIX);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::rename(dir.join("mls.bin"), staging.join("mls.bin")).unwrap();

        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
        assert!(!staging.exists());
        assert_eq!(std::fs::read(a.join("mls.bin")).unwrap(), b"A");
        assert_eq!(
            std::fs::read_to_string(a.join(MLS_STATE_OWNER_FILE)).unwrap(),
            "user-a"
        );
        assert_eq!(owner(&dir), None);

        // An unpark of A cut after its record arrived and before `mls.bin` did.
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        std::fs::rename(&a, &unstaging).unwrap();
        std::fs::rename(
            unstaging.join(MLS_STATE_OWNER_FILE),
            dir.join(MLS_STATE_OWNER_FILE),
        )
        .unwrap();

        assert_eq!(
            account_state_file(&dir, "user-a").unwrap(),
            Some(dir.join("mls.bin"))
        );
        assert!(!unstaging.exists());
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F1 (review of #2919): A LEDGER WRITTEN INTO THE SLOT WHILE A MOVE WAS CUT - a key-group join
    /// settling in a new process before anything finished the journal - lands at both ends of the
    /// move. The slot's copy is the later one and wins, and nothing is refused: before, the occupied
    /// destination failed every account's selection until a factory wipe.
    #[test]
    fn a_ledger_written_into_the_slot_during_a_cut_move_does_not_block_the_install() {
        let _cold = cold();
        let dir = temp_dir("ledger-between");
        let ledger = crate::commands::storage::KEY_GROUP_PUSH_JOIN_LEDGER_FILE;
        // A's park, cut after its ledger moved; A's join settles again into the slot afterwards.
        sign_in_and_save(&dir, "user-a", b"A");
        std::fs::write(dir.join(ledger), b"old ledger").unwrap();
        let a = parked_dir(&dir, "user-a");
        let staging = with_suffix(&a, PARKING_SUFFIX);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::rename(dir.join(ledger), staging.join(ledger)).unwrap();
        std::fs::write(dir.join(ledger), b"newer ledger").unwrap();

        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: false
            }
        );
        assert_eq!(std::fs::read(a.join(ledger)).unwrap(), b"newer ledger");
        assert!(!dir.join(ledger).exists());
        sign_in_and_save(&dir, "user-b", b"B");

        // A's unpark, cut after the ledger arrived; a write lands in the slot, then the rest.
        select(&dir, "user-a").unwrap();
        select(&dir, "user-b").unwrap();
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        // B in the slot, A parked: park B by hand, then cut A's unpark before any file moved.
        let b_parked = parked_dir(&dir, "user-b");
        assert!(!b_parked.exists());
        std::fs::create_dir_all(&b_parked).unwrap();
        for name in ["mls.bin", MLS_STATE_OWNER_FILE] {
            std::fs::rename(dir.join(name), b_parked.join(name)).unwrap();
        }
        std::fs::rename(&a, &unstaging).unwrap();
        std::fs::write(dir.join(ledger), b"newest ledger").unwrap();

        assert_eq!(select(&dir, "user-a").unwrap(), Selection::AlreadyInSlot);
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        assert_eq!(std::fs::read(dir.join(ledger)).unwrap(), b"newest ledger");
        assert!(!unstaging.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F1: A FILE NOBODY LISTED IN A PARKED DIRECTORY never blocks the unpark: it is set aside,
    /// nothing is deleted, and the account gets its state.
    #[test]
    fn a_stray_file_in_a_parked_directory_is_set_aside() {
        let _cold = cold();
        let dir = temp_dir("stray");
        sign_in_and_save(&dir, "user-a", b"A");
        select(&dir, "user-b").unwrap();
        let a = parked_dir(&dir, "user-a");
        std::fs::write(a.join("stray.bin"), b"?").unwrap();

        select(&dir, "user-a").unwrap();
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        assert!(!a.exists());
        let residue = with_suffix(&a, &format!("{RESIDUE_INFIX}0"));
        assert_eq!(std::fs::read(residue.join("stray.bin")).unwrap(), b"?");
        // And it never blocks again.
        select(&dir, "user-b").unwrap();
        select(&dir, "user-a").unwrap();
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F1: ONE ACCOUNT'S UNFINISHABLE MOVE STOPS THAT ACCOUNT ONLY - every other account is located
    /// and signs in.
    #[test]
    fn an_unfinishable_move_refuses_only_its_own_account() {
        let _cold = cold();
        let dir = temp_dir("one-broken");
        sign_in_and_save(&dir, "user-b", b"B");
        select(&dir, "user-c").unwrap();
        sign_in_and_save(&dir, "user-c", b"C");
        // An unpark of A that cannot finish: its parked `mls.bin` is a directory the slot's copy
        // would have to replace.
        let a = parked_dir(&dir, "user-a");
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        std::fs::create_dir_all(unstaging.join("mls.bin")).unwrap();
        std::fs::write(unstaging.join("mls.bin").join("x"), b"x").unwrap();

        assert!(account_state_file(&dir, "user-a").is_err());
        assert!(select(&dir, "user-a").is_err());
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(parked_dir(&dir, "user-b").join("mls.bin"))
        );
        select(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// NOTHING IS OVERWRITTEN: an owner whose state is somehow parked twice keeps both.
    #[test]
    fn a_second_parked_state_for_one_account_is_refused() {
        let _cold = cold();
        let dir = temp_dir("twice");
        sign_in_and_save(&dir, "user-a", b"A in the slot");
        let a = parked_dir(&dir, "user-a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("mls.bin"), b"A parked").unwrap();

        assert!(select(&dir, "user-b").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"A in the slot"[..]));
        assert_eq!(std::fs::read(a.join("mls.bin")).unwrap(), b"A parked");
        assert!(select(&dir, "user-a").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F3: the deleted-account wipe removes that account's parked state AND the slot when the slot's
    /// record names it - never another account's slot, never under a loaded manager.
    #[test]
    fn a_deleted_account_loses_its_parked_state_and_its_slot_only() {
        let _cold = cold();
        let dir = temp_dir("delete");
        sign_in_and_save(&dir, "user-a", b"A");
        select(&dir, "user-b").unwrap();
        sign_in_and_save(&dir, "user-b", b"B");

        let removed = remove_account_state(&dir, "user-a").unwrap();
        assert_eq!(
            removed,
            Removed {
                parked_files: 2,
                slot: false
            }
        );
        assert!(!parked_dir(&dir, "user-a").exists());
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));

        // B, signed in last, is deleted while signed out: its slot goes.
        crate::concurrency::mark_foreground_manager_loading();
        assert!(remove_account_state(&dir, "user-b").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        crate::concurrency::forget_live_manager_for_test();
        let removed = remove_account_state(&dir, "user-b").unwrap();
        assert!(removed.slot);
        assert_eq!(slot(&dir), None);
        assert_eq!(owner(&dir), None);
        assert_eq!(
            remove_account_state(&dir, "user-b").unwrap(),
            Removed {
                parked_files: 0,
                slot: false
            }
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F4: the fresh-start guard needs a STATE to have come back - an unparked owner record alone is
    /// no state to lose.
    #[test]
    fn the_fresh_start_guard_needs_an_unparked_state_not_a_record() {
        let _cold = cold();
        let dir = temp_dir("fresh-guard");
        std::fs::write(dir.join(MLS_STATE_OWNER_FILE), "user-a").unwrap();
        select(&dir, "user-b").unwrap();
        let moved = select(&dir, "user-a").unwrap();
        assert_eq!(
            moved,
            Selection::Moved {
                parked_other: false,
                unparked: true
            }
        );
        assert!(!fresh_start_would_replace_unparked_state(moved, true, &dir));

        std::fs::write(dir.join("mls.bin"), b"A").unwrap();
        assert!(fresh_start_would_replace_unparked_state(moved, true, &dir));
        assert!(!fresh_start_would_replace_unparked_state(
            moved, false, &dir
        ));
        assert!(!fresh_start_would_replace_unparked_state(
            Selection::AlreadyInSlot,
            true,
            &dir
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F5: the extension's App Group copy follows the slot - rewritten from it, removed when it is
    /// empty - so it never holds the previous account's state after a switch.
    #[test]
    fn the_extension_copy_follows_the_slot() {
        let dir = temp_dir("group-slot");
        let group = temp_dir("group-copy");
        std::fs::write(group.join("mls.bin"), b"previous account").unwrap();

        sync_extension_copy(&dir, &group).unwrap();
        assert!(!group.join("mls.bin").exists());
        sync_extension_copy(&dir, &group).unwrap();

        std::fs::write(dir.join("mls.bin"), b"this account").unwrap();
        sync_extension_copy(&dir, &group).unwrap();
        assert_eq!(
            std::fs::read(group.join("mls.bin")).unwrap(),
            b"this account"
        );
        assert!(!group.join("mls.bin.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&group).ok();
    }

    /// Ids differing only by case are two accounts, and two directories on a case-insensitive volume.
    #[test]
    fn the_parked_directory_is_a_hash_of_the_id() {
        assert_ne!(parked_dir_name("Alice"), parked_dir_name("alice"));
        assert_eq!(parked_dir_name("alice").len(), 64);
        assert!(parked_dir_name("../x")
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
    }
}
