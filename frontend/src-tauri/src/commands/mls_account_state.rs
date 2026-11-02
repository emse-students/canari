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
//! retry: the directories ARE the journal.
//!
//! Everything here runs under [`mls_bin_write_lock`], the lock every writer of `mls.bin` takes: a
//! background engine that loaded the slot before a switch fails its compare-and-swap re-read.

use std::path::{Path, PathBuf};

use crate::commands::storage::{mls_state_file_names, read_mls_state_owner};
use crate::concurrency::{live_manager_in_process, mark_foreground_active, mls_bin_write_lock};

/// The directory, beside `mls.bin`, holding the states of the accounts NOT signed in on the install.
pub(crate) const PARKED_STATES_DIR: &str = "mls_accounts";

/// Suffix of a park in progress: the slot's files are moving into this directory.
const PARKING_SUFFIX: &str = ".parking";

/// Suffix of an unpark in progress: this directory's files are moving into the slot.
const UNPARKING_SUFFIX: &str = ".unparking";

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
fn slot_holds_state(data_dir: &Path) -> bool {
    std::fs::metadata(data_dir.join("mls.bin"))
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

/// Moves every state file present in `from` into `to`, in [`mls_state_file_names`] order (the owner
/// record LAST). **REFUSES TO REPLACE**: `rename(2)` overwrites silently on Unix, and a destination
/// that already holds a file is a state of someone - so it is an error, and nothing is overwritten.
fn move_state_files(from: &Path, to: &Path) -> Result<usize, String> {
    let mut moved = 0;
    for name in mls_state_file_names() {
        let src = from.join(&name);
        if !src.exists() {
            continue;
        }
        let dst = to.join(&name);
        if dst.exists() {
            return Err(format!(
                "{name} is already at the destination - nothing overwritten"
            ));
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("move {name}: {e}"))?;
        moved += 1;
    }
    Ok(moved)
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
    let moved = move_state_files(data_dir, staging)?;
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

/// Completes an unpark: `staging`'s state files into the slot, then `staging` removed.
fn finish_unpark(data_dir: &Path, staging: &Path) -> Result<(), String> {
    let moved = move_state_files(staging, data_dir)?;
    std::fs::remove_dir(staging).map_err(|e| format!("remove the emptied parked state: {e}"))?;
    log::info!("[MLS_ACCOUNT] parked state moved into the slot ({moved} file(s) moved)");
    Ok(())
}

/// Finishes every move a previous process was cut in the middle of: parks first, then unparks - the
/// order one selection runs them in, so at most one of each can be pending and an unpark pending
/// means its park completed. **THE CALLER HOLDS [`mls_bin_write_lock`].**
fn settle_pending_moves_held(data_dir: &Path) -> Result<(), String> {
    let root = data_dir.join(PARKED_STATES_DIR);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read {PARKED_STATES_DIR}: {e}")),
    };
    let mut parking = Vec::new();
    let mut unparking = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {PARKED_STATES_DIR}: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(PARKING_SUFFIX) && !name.ends_with(UNPARKING_SUFFIX) {
            parking.push(entry.path());
        } else if name.ends_with(UNPARKING_SUFFIX) {
            unparking.push(entry.path());
        }
    }
    if parking.len() + unparking.len() > 0 {
        log::warn!(
            "[MLS_ACCOUNT] {} park(s) and {} unpark(s) were cut part-way by a previous process - finishing them",
            parking.len(),
            unparking.len()
        );
    }
    for staging in parking {
        finish_park(data_dir, &staging)?;
    }
    for staging in unparking {
        finish_unpark(data_dir, &staging)?;
    }
    Ok(())
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
    settle_pending_moves_held(data_dir)?;
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
/// **REFUSED, WITH NOTHING MOVED**, when a move is needed and a foreground manager is loaded in this
/// process (its next checkpoint would write ITS account's state into the slot just handed to
/// another), and when the move would overwrite anything: two parked states for one account, or a
/// parked state to unpark into a slot that holds an unproven one.
pub(crate) fn select_account_state(data_dir: &Path, user_id: &str) -> Result<Selection, String> {
    log::debug!("[MLS_ACCOUNT] selecting the signing-in account's state");
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    settle_pending_moves_held(data_dir)?;
    let mine = parked_dir(data_dir, user_id);
    let mine_parked = mine.exists();
    let refuse_if_live = || {
        if live_manager_in_process() {
            log::error!(
                "[MLS_ACCOUNT] a foreground manager is loaded in this process - the slot is NOT switched under it"
            );
            return Err("a foreground MLS session is still open".to_string());
        }
        Ok(())
    };

    let mut parked_other = false;
    match read_mls_state_owner(data_dir) {
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
            refuse_if_live()?;
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
        refuse_if_live()?;
        mark_foreground_active();
        let staging = with_suffix(&mine, UNPARKING_SUFFIX);
        std::fs::rename(&mine, &staging).map_err(|e| format!("start the unpark: {e}"))?;
        finish_unpark(data_dir, &staging)?;
    }
    let selection = Selection::Moved {
        parked_other,
        unparked: mine_parked,
    };
    log::info!("[MLS_ACCOUNT] slot selected for the signing-in account: {selection:?}");
    Ok(selection)
}

/// Removes `user_id`'s PARKED state - the deleted-account wipe (`accountLocalWipe.ts`), after which
/// nobody can ever open it again. Returns the number of files removed.
///
/// The slot is never touched here: it is the signed-in account's, or it is reset through the one
/// teardown that ends the session in the same hold (`end_native_session`).
pub(crate) fn remove_parked_account_state(data_dir: &Path, user_id: &str) -> Result<usize, String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    settle_pending_moves_held(data_dir)?;
    let dir = parked_dir(data_dir, user_id);
    if !dir.exists() {
        log::debug!("[MLS_ACCOUNT] no parked state for the deleted account");
        return Ok(0);
    }
    let mut removed = 0;
    for name in mls_state_file_names() {
        let path = dir.join(&name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove {name}: {e}"))?;
            removed += 1;
        }
    }
    std::fs::remove_dir(&dir).map_err(|e| format!("remove the parked state: {e}"))?;
    log::info!("[MLS_ACCOUNT] the deleted account's parked state removed ({removed} file(s))");
    Ok(removed)
}

/// The frontend's view of [`remove_parked_account_state`].
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
    remove_parked_account_state(&data_dir, &user_id)
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
            select_account_state(&dir, "user-a").unwrap(),
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
            select_account_state(&dir, "user-b").unwrap(),
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
            select_account_state(&dir, "user-a").unwrap(),
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
        select_account_state(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir), Some(b_state.clone()));
        assert_eq!(owner(&dir).as_deref(), Some("user-b"));
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(dir.join("mls.bin"))
        );

        // Selecting the account already in the slot moves nothing.
        assert_eq!(
            select_account_state(&dir, "user-b").unwrap(),
            Selection::AlreadyInSlot
        );
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

        assert_eq!(
            select_account_state(&dir, "user-a").unwrap(),
            Selection::AlreadyInSlot
        );
        assert_eq!(slot(&dir).as_deref(), Some(&b"pre-existing state"[..]));

        select_account_state(&dir, "user-b").unwrap();
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
            select_account_state(&dir, "user-b").unwrap(),
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
        assert!(select_account_state(&dir, "user-b").is_err());
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
        let refused = select_account_state(&dir, "user-b");
        crate::concurrency::forget_live_manager_for_test();

        assert!(refused.is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        std::fs::remove_dir_all(&dir).ok();
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

    /// NOTHING IS OVERWRITTEN: an owner whose state is somehow parked twice keeps both.
    #[test]
    fn a_second_parked_state_for_one_account_is_refused() {
        let _cold = cold();
        let dir = temp_dir("twice");
        sign_in_and_save(&dir, "user-a", b"A in the slot");
        let a = parked_dir(&dir, "user-a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("mls.bin"), b"A parked").unwrap();

        assert!(select_account_state(&dir, "user-b").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"A in the slot"[..]));
        assert_eq!(std::fs::read(a.join("mls.bin")).unwrap(), b"A parked");
        assert!(select_account_state(&dir, "user-a").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The deleted-account wipe removes that account's parked state and nothing else.
    #[test]
    fn a_deleted_account_loses_its_parked_state_only() {
        let _cold = cold();
        let dir = temp_dir("delete");
        sign_in_and_save(&dir, "user-a", b"A");
        select_account_state(&dir, "user-b").unwrap();
        sign_in_and_save(&dir, "user-b", b"B");

        assert_eq!(remove_parked_account_state(&dir, "user-a").unwrap(), 2);
        assert!(!parked_dir(&dir, "user-a").exists());
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        assert_eq!(remove_parked_account_state(&dir, "user-a").unwrap(), 0);
        assert_eq!(remove_parked_account_state(&dir, "user-b").unwrap(), 0);
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        std::fs::remove_dir_all(&dir).ok();
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
