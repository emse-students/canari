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
//! **NOTHING IS DELETED WHEN A MOVE FINDS A FILE AT BOTH ENDS** (re-review of #2919). The copy
//! already at the DESTINATION is set aside into `<hash>.residue-<n>` and accused at ERROR, and the
//! moving copy takes its place: in a park the journal proves both are that account's and the slot's
//! is the later one; in an unpark the slot's copy is proven to be nobody's (a ledger the push service
//! recreated), while the parked one is the account's. `mls.bin` is the exception, because choosing
//! between two states is choosing which ratchet survives: an EMPTY one is no state (the trace of a
//! write cut short) and is the one set aside; two non-empty ones are REFUSED before anything moves.
//!
//! **AN UNFINISHED MOVE STOPS EVERY SIGN-IN, AND NOTHING ELSE** (review and re-review of #2919). A
//! move that cannot be finished is reported against the account it belongs to; every other account's
//! QUERY still answers. But every SIGN-IN is refused while it stands, a park's or an unpark's: either
//! way the slot may hold part of that account's state - an unpark moves `mls.bin` before its owner
//! record, so a cut one leaves the account's state UNOWNED in the slot - and handing the slot to
//! another account is the cross-account write (and the reset of someone else's state) this module
//! exists to prevent. Only a non-empty `mls.bin` at both ends of one move, or a filesystem that
//! refuses a rename, is left unfinished: a parked directory already present, or a file nobody listed
//! in one, is set aside as `<hash>.residue-<n>` and accused, so it never locks the install.
//!
//! **EVERY WRITER OF THE STATE FILES TAKES [`mls_bin_write_lock`]** (`mls.bin`, the JSON ledgers, the
//! key-group join's ledger and stage in `key_group_join.rs`, and the iOS activation mirror of
//! `mls.bin` into the App Group), and everything here runs under it, so no write lands between a park
//! and its unpark. **AND A WRITE MADE FOR AN ACCOUNT IS BOUND TO IT**: a background engine that loaded
//! the slot before a switch fails its compare-and-swap re-read, and the key-group join's ledger and
//! stage - which no compare-and-swap covers - are written only while the slot's owner record names
//! the account the push is for (`key_group_join.rs`), so a join in flight across a switch, or a push
//! for an account deleted since, writes into nobody else's state.

use std::path::{Path, PathBuf};

use crate::commands::storage::{
    mls_state_file_names, read_mls_state_owner, remove_mls_state_held, state_file_absent,
};
use crate::concurrency::{
    claim_foreground_session_held, live_manager_in_process, mark_foreground_active,
    mls_bin_write_lock, SessionClaim,
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
    /// The slot holds a state with NO owner record - left there, or brought back into the empty slot
    /// from where a PIN reset set it aside (round 6 of the review of #2919): nothing attributed. The
    /// load under this account's key is the only proof of whose it is.
    UnprovenLeftInSlot,
}

/// Why [`select_account_state`] refused a sign-in - a TYPE, so the frontend's gate can answer an
/// unfinished move (a restart retries it, nothing is offered for deletion) without reading a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SelectionRefused {
    /// A move of a state between two accounts' places was cut part-way and cannot be finished
    /// ([`refusal_for`]): handing the slot to anyone could write into, or reset, another account's
    /// state.
    MoveUnfinished(String),
    /// Anything else: a foreground session still open, a state of unproven owner, a filesystem
    /// failure.
    Other(String),
}

impl std::fmt::Display for SelectionRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MoveUnfinished(m) | Self::Other(m) => f.write_str(m),
        }
    }
}

impl From<String> for SelectionRefused {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl From<SelectionRefused> for mls_core::StateLoadRefusal {
    fn from(refused: SelectionRefused) -> Self {
        match refused {
            SelectionRefused::MoveUnfinished(m) => Self::slot_move_unfinished(m),
            SelectionRefused::Other(m) => Self::from(m),
        }
    }
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
/// short and is no state ([`state_file_absent`], the one rule). `Err` when the file could not be
/// examined: an ANSWER NOBODY HAS, which every caller refuses on rather than reading as "no state"
/// (round 4 of the review of #2919: a `false` there let a write, a fresh start or a move through).
pub(crate) fn slot_holds_state(data_dir: &Path) -> Result<bool, String> {
    holds_bytes(&data_dir.join("mls.bin"))
}

/// Why `initialiser_mls` must NOT start fresh, `None` when it may.
///
/// A fresh start seals a new state into the slot, so it is refused whenever the slot already holds
/// one (round 4 of the review of #2919, whatever the selection - not only after an unpark): the caller
/// decided "no state" on an answer that did not see it. Only a non-empty `mls.bin` counts - an owner
/// record alone is no state to lose - and a slot that could not be examined refuses too.
///
/// **THE ONE FRESH START THAT REPLACES A STATE SAYS SO** (`replaces_unopened_state`): the device
/// identity rotation, after this account's state failed to open under a cause no PIN repairs. It is
/// allowed only over THIS ACCOUNT'S OWN state (`Selection::AlreadyInSlot`, its owner record naming
/// it) - never over a state of unproven owner, nor one an unpark just brought back (round 5).
pub(crate) fn fresh_start_refusal(
    selection: Selection,
    caller_says_no_state: bool,
    replaces_unopened_state: bool,
    data_dir: &Path,
) -> Option<String> {
    if !caller_says_no_state {
        return None;
    }
    match slot_holds_state(data_dir) {
        Err(e) => Some(format!(
            "a fresh start was asked and the slot could not be examined: {e}"
        )),
        Ok(false) => None,
        // ONLY over this account's OWN state (round 5): the slot's owner record names it. Never over a
        // state of unproven owner, nor one an unpark just brought back that nothing has tried to open.
        Ok(true) if replaces_unopened_state && selection == Selection::AlreadyInSlot => {
            log::warn!(
                "[MLS_ACCOUNT] a fresh start replaces the state that did not open (the device identity rotation asked for it)"
            );
            None
        }
        Ok(true) => Some("a fresh start was asked over this account's saved state".to_string()),
    }
}

/// The first `<account_dir>.residue-<n>` that does not exist yet - where whatever a move would
/// otherwise have to delete or refuse over is set aside, under the name of the account it was found
/// with. Only [`remove_account_state`] ever removes one ([`is_residue_of`]).
fn next_residue_dir(account_dir: &Path) -> PathBuf {
    let mut n = 0u32;
    loop {
        let candidate = with_suffix(account_dir, &format!("{RESIDUE_INFIX}{n}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Whether `name` (an entry of [`PARKED_STATES_DIR`]) is one of `account`'s residue directories:
/// exactly `<account>.residue-<digits>`. The allowlist of what deleting `account` may remove besides
/// its parked directory - never a prefix match, which would reach another account's hash.
fn is_residue_of(name: &str, account: &str) -> bool {
    name.strip_prefix(account)
        .and_then(|rest| rest.strip_prefix(RESIDUE_INFIX))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Moves `file` (named `name`) into `residue`, creating `<account_dir>.residue-<n>` the first time a
/// move needs one, and accuses it: something sat where the move had to put a state file, and
/// NOTHING IS DELETED for it.
fn set_file_aside(
    file: &Path,
    name: &str,
    residue: &mut Option<PathBuf>,
    account_dir: &Path,
) -> Result<(), String> {
    let dir = match residue {
        Some(dir) => dir.clone(),
        None => {
            let dir = next_residue_dir(account_dir);
            std::fs::create_dir_all(&dir).map_err(|e| format!("create the residue: {e}"))?;
            *residue = Some(dir.clone());
            dir
        }
    };
    std::fs::rename(file, dir.join(name)).map_err(|e| format!("set {name} aside: {e}"))?;
    log::error!(
        "[MLS_ACCOUNT] {name} was at both ends of a move - one copy set aside as {}, nothing deleted",
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    Ok(())
}

/// Whether the file at `path` holds bytes - [`state_file_absent`] negated, so an absent or empty
/// `mls.bin` is no state and a file that could not be examined is an `Err`, accused, never a "no".
fn holds_bytes(path: &Path) -> Result<bool, String> {
    state_file_absent(path).map(|absent| !absent).map_err(|e| {
        log::error!("[MLS_ACCOUNT] a state file could not be examined: {e}");
        e
    })
}

/// Moves every state file present in `from` into `to`, in [`mls_state_file_names`] order (the owner
/// record LAST). `account_dir` is the account's parked directory (`<hash>`), naming any residue.
///
/// **A CLASH NEVER DELETES** (see the module comment): the copy already at the destination is set
/// aside and the moving one takes its place - except for `mls.bin`, where the EMPTY copy is the one
/// set aside, and two non-empty copies are refused BEFORE ANY FILE MOVES, so a refused move leaves
/// both ends exactly as they were.
fn move_state_files(from: &Path, to: &Path, account_dir: &Path) -> Result<usize, String> {
    let (src_bin, dst_bin) = (from.join("mls.bin"), to.join("mls.bin"));
    if holds_bytes(&src_bin)? && holds_bytes(&dst_bin)? {
        log::error!(
            "[MLS_ACCOUNT] TWO STATES AT BOTH ENDS OF ONE MOVE - nothing moved, nothing set aside: which ratchet survives is not this module's to choose"
        );
        return Err("mls.bin holds a state at both ends of the move".to_string());
    }
    let mut residue = None;
    let mut moved = 0;
    for name in mls_state_file_names() {
        let src = from.join(&name);
        if !src.exists() {
            continue;
        }
        let dst = to.join(&name);
        if dst.exists() {
            if name == "mls.bin" && !holds_bytes(&dst)? {
                set_file_aside(&dst, &name, &mut residue, account_dir)?;
            } else if name == "mls.bin" {
                // The moving copy is the empty one (two non-empty ones were refused above): the
                // state already at the destination stays, the trace of a cut write goes aside.
                set_file_aside(&src, &name, &mut residue, account_dir)?;
                continue;
            } else {
                set_file_aside(&dst, &name, &mut residue, account_dir)?;
            }
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("move {name}: {e}"))?;
        moved += 1;
    }
    Ok(moved)
}

/// Removes `dir` once its listed files are gone; anything left in it was never listed, so the
/// directory is set aside as `<account_dir>.residue-<n>` and accused - it never blocks a move again.
fn remove_or_set_aside(dir: &Path, account_dir: &Path) -> Result<(), String> {
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
    // Named after the account, never after the move it was found in.
    let aside = next_residue_dir(account_dir);
    std::fs::rename(dir, &aside).map_err(|e| format!("set the residue aside: {e}"))?;
    log::error!(
        "[MLS_ACCOUNT] a parked state carried {} file(s) no list names ({}) - set aside, nothing deleted",
        left.len(),
        left.join(", ")
    );
    Ok(())
}

/// The account directory (`<hash>`) a journal directory (`<hash>.parking` / `<hash>.unparking`)
/// belongs to.
fn account_dir_of(staging: &Path, suffix: &str) -> Result<PathBuf, String> {
    staging
        .to_string_lossy()
        .strip_suffix(suffix)
        .map(PathBuf::from)
        .ok_or_else(|| format!("a journal directory without its {suffix} suffix"))
}

/// Completes a park: the slot's remaining state files into `staging`, then `staging` renamed to its
/// final name. `staging` existing IS the proof that the slot's files are that account's.
///
/// **THE FINAL NAME IS CHECKED FIRST, AND AN OCCUPIED ONE NEVER STOPS THE PARK** (re-review of #2919):
/// a refusal there was an unfinished park, which refuses every sign-in on the install for as long as
/// it stands - for ever, since nothing would ever free the name. The directory already there is the
/// same account's OLDER state (the slot is where every writer writes), so it is set aside as
/// `<hash>.residue-<n>`, accused, and nothing is deleted; the park then completes.
fn finish_park(data_dir: &Path, staging: &Path) -> Result<(), String> {
    let final_dir = account_dir_of(staging, PARKING_SUFFIX)?;
    if final_dir.exists() {
        let aside = next_residue_dir(&final_dir);
        std::fs::rename(&final_dir, &aside)
            .map_err(|e| format!("set the older parked state aside: {e}"))?;
        log::error!(
            "[MLS_ACCOUNT] TWO PARKED STATES FOR ONE ACCOUNT - the older one set aside, nothing deleted; the slot's later state is parked"
        );
    }
    let moved = move_state_files(data_dir, staging, &final_dir)?;
    std::fs::rename(staging, &final_dir).map_err(|e| format!("rename the parked state: {e}"))?;
    log::info!("[MLS_ACCOUNT] slot state parked ({moved} file(s) moved)");
    Ok(())
}

/// Completes an unpark: `staging`'s state files into the slot, then `staging` removed (or set aside
/// when it still holds a file nobody listed).
fn finish_unpark(data_dir: &Path, staging: &Path) -> Result<(), String> {
    let account_dir = account_dir_of(staging, UNPARKING_SUFFIX)?;
    let moved = move_state_files(staging, data_dir, &account_dir)?;
    remove_or_set_aside(staging, &account_dir)?;
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
    let mut resetting = Vec::new();
    let mut unreadable = 0usize;
    for entry in entries {
        // AN ENTRY THAT COULD NOT BE READ MAY BE A JOURNAL (round 5 of the review of #2919): skipped,
        // a cut move would go unseen and a sign-in be admitted over it. Accused, and counted as an
        // unfinished move against no account in particular - which refuses every sign-in.
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::error!("[MLS_ACCOUNT] an entry of {PARKED_STATES_DIR} could not be read: {e}");
                unreadable += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(account) = name.strip_suffix(UNPARKING_SUFFIX) {
            unparking.push((account.to_string(), entry.path()));
        } else if let Some(account) = name.strip_suffix(PARKING_SUFFIX) {
            parking.push((account.to_string(), entry.path()));
        } else if let Some(account) = name.strip_suffix(RESETTING_SUFFIX) {
            if !reset_in_flight(account) {
                resetting.push((account.to_string(), entry.path()));
            }
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
    // A PIN RESET A PREVIOUS PROCESS STAGED AND NEVER SETTLED (round 6 of the review of #2919): whether
    // the server reset the PIN is not known here, so the state is PUT BACK, never removed - parked
    // under its account, or set aside beside a parked one. A state the server's reset made useless
    // then fails its load, and the account resets again; a state removed on a guess is gone.
    for (account, staging) in resetting {
        log::error!(
            "[MLS_ACCOUNT] a PIN reset was cut before it settled - the account's state is put back, nothing deleted"
        );
        if let Err(e) = restore_resetting_dir_held(&staging) {
            log::error!("[MLS_ACCOUNT] a cut PIN reset could not be put back: {e}");
            unfinished.push(UnfinishedMove {
                account,
                park: false,
            });
        }
    }
    if unreadable > 0 {
        unfinished.push(UnfinishedMove {
            account: String::new(),
            park: true,
        });
    }
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
/// own, always; ANY other account's when `needs_slot` (a sign-in, never a query).
///
/// **AN UNPARK REFUSES TOO, NOT ONLY A PARK** (re-review of #2919): `finish_unpark` moves `mls.bin`
/// before the owner record, so an unpark that cannot finish may leave that account's state in the slot
/// with NO record naming it - and a sign-in admitted over it would find a state of "unproven owner",
/// fail its credential check, and reach the reset that deletes it.
fn refusal_for(unfinished: &[UnfinishedMove], user_id: &str, needs_slot: bool) -> Option<String> {
    let mine = parked_dir_name(user_id);
    unfinished
        .iter()
        .find(|m| m.account == mine || needs_slot)
        .map(|m| {
            if m.account == mine {
                "this account's state was cut part-way through a move that cannot be finished"
                    .to_string()
            } else if m.park {
                "the slot still holds part of another account's state".to_string()
            } else {
                "the slot may hold another account's state, moved in without its owner record"
                    .to_string()
            }
        })
}

/// The path of `user_id`'s `mls.bin` on this install, or `None` when the account has no state here.
///
/// - the slot, when its owner record names `user_id`;
/// - the account's parked `mls.bin`, when it has one;
/// - the slot, when it holds a state with NO record - unproven, so the load decides, which is the
///   answer this install gave before one state per account existed - unless a move stands
///   unfinished, which may have left ANOTHER account's state there without its record;
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
    account_state_file_held(data_dir, user_id).map_err(|e| e.to_string())
}

/// [`account_state_file`] for a caller holding [`mls_bin_write_lock`]. An unfinished move of this
/// account's own state is TYPED (`SelectionRefused::MoveUnfinished`, round 5): the login asks the
/// state's size before it signs in, and the gate must meet the same code either way.
fn account_state_file_held(
    data_dir: &Path,
    user_id: &str,
) -> Result<Option<PathBuf>, SelectionRefused> {
    let unfinished = settle_pending_moves_held(data_dir);
    if let Some(refusal) = refusal_for(&unfinished, user_id, false) {
        return Err(SelectionRefused::MoveUnfinished(refusal));
    }
    let parked = parked_dir(data_dir, user_id);
    let slot_has_state = slot_holds_state(data_dir)?;
    let located = match read_mls_state_owner(data_dir)? {
        Some(owner) if owner == user_id => Some(data_dir.join("mls.bin")),
        _ if parked.exists() => Some(parked.join("mls.bin")),
        // NOT while a move stands unfinished: the unowned state may be the moving account's, its
        // `mls.bin` already in the slot and its record not (re-review of #2919).
        None if slot_has_state && unfinished.is_empty() => {
            log::warn!(
                "[MLS_ACCOUNT] the slot holds a state with no owner record - offered to the load, whose credential check decides"
            );
            Some(data_dir.join("mls.bin"))
        }
        // THE SAME OFFER THE SIGN-IN MAKES ([`select_held`], round 6): an account with no state of its
        // own is offered a state of unproven owner a reset set aside - so the login, which asks this
        // first, expects the state the sign-in will bring into the slot.
        _ if unfinished.is_empty() => {
            offered_unproven_residue(data_dir, user_id)?.map(|residue| residue.join("mls.bin"))
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

/// The size of `user_id`'s `mls.bin` on this install, 0 when it has none - located AND measured in
/// one hold of [`mls_bin_write_lock`], so a switch cannot move the file between the two. A state that
/// could not be located or examined is an `Err`, never a 0 (round 4 of the review of #2919): 0 is "no
/// state", and a login that believed it would start fresh.
pub(crate) fn account_state_size(data_dir: &Path, user_id: &str) -> Result<u64, SelectionRefused> {
    if user_id.is_empty() {
        return Err("no account named".to_string().into());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| SelectionRefused::Other("mls_bin write lock poisoned".to_string()))?;
    let Some(path) = account_state_file_held(data_dir, user_id)? else {
        return Ok(0);
    };
    match std::fs::metadata(&path) {
        Ok(m) => Ok(m.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(format!("stat mls.bin: {e}").into()),
    }
}

/// For a writer of the slot that holds [`mls_bin_write_lock`] (`save_mls_state`): finishes every move
/// a previous process cut part-way, as a sign-in does, and returns the refusal owed when one stays
/// unfinished - the slot may then hold part of another account's state, so nothing is written into
/// it (round 4 of the review of #2919).
pub(crate) fn settle_moves_for_slot_write_held(data_dir: &Path, user_id: &str) -> Option<String> {
    refusal_for(&settle_pending_moves_held(data_dir), user_id, true)
}

/// A park cut by a process death right after its journal directory was created: the slot's files
/// still in place, `<hash>.parking/` beside them. Returns the journal.
#[cfg(test)]
pub(crate) fn start_park_for_test(data_dir: &Path, owner: &str) -> PathBuf {
    std::fs::create_dir_all(data_dir.join(PARKED_STATES_DIR)).unwrap();
    let staging = with_suffix(&parked_dir(data_dir, owner), PARKING_SUFFIX);
    std::fs::create_dir(&staging).unwrap();
    staging
}

/// Gives the slot to `user_id`: parks the state it holds under the account its owner record names,
/// then moves `user_id`'s parked state, if any, into it. Called by `initialiser_mls` before it reads
/// the slot, on every path - a fresh start included, which would otherwise seal a new state over the
/// previous account's file.
///
/// **THE PROCESS IS MARKED WARM IN THE SAME HOLD** (review of #2919): a second sign-in interleaved
/// with this one then finds a manager loading and is refused, instead of selecting the slot for its
/// own account between this selection and this account's load - which wrote one account's owner
/// beside the other's state. The [`SessionClaim`] returned with the selection is what lets the
/// caller's install guard clear that mark if THIS sign-in fails; a refused selection returns none,
/// so its guard clears nothing (re-review of #2919).
///
/// **REFUSED, WITH NOTHING MOVED**, when a foreground manager is loaded (or loading) in this process
/// and the slot is not already this account's, and when a move is left unfinished
/// ([`refusal_for`]). A second parked state for the account the slot already belongs to is set aside
/// (`<hash>.residue-<n>`), never a refusal: the slot's is the later one, and a refusal there would
/// stand for ever. So is a slot state of unproven owner when this account has a parked state to
/// unpark (`unproven.residue-<n>`, round 6 of the review of #2919) - and an account with no state of
/// its own is offered such a set-aside state ([`offered_unproven_residue`]), whose load decides.
pub(crate) fn select_account_state(
    data_dir: &Path,
    user_id: &str,
) -> Result<(Selection, SessionClaim), SelectionRefused> {
    log::debug!("[MLS_ACCOUNT] selecting the signing-in account's state");
    if user_id.is_empty() {
        return Err(SelectionRefused::Other("no account named".to_string()));
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| SelectionRefused::Other("mls_bin write lock poisoned".to_string()))?;
    let selection = select_held(data_dir, user_id)?;
    let claim = claim_foreground_session_held();
    // The slot changed hands on every selection but this one (an unproven state left in place or
    // brought back from aside is a change too): the extension's copy follows.
    if selection != Selection::AlreadyInSlot {
        refresh_extension_copy(data_dir);
    }
    log::info!("[MLS_ACCOUNT] slot selected for the signing-in account: {selection:?}");
    Ok((selection, claim))
}

/// [`select_account_state`] under the lock it holds.
fn select_held(data_dir: &Path, user_id: &str) -> Result<Selection, SelectionRefused> {
    if let Some(refusal) = refusal_for(&settle_pending_moves_held(data_dir), user_id, true) {
        log::error!("[MLS_ACCOUNT] sign-in refused: {refusal}");
        return Err(SelectionRefused::MoveUnfinished(refusal));
    }
    let owner = read_mls_state_owner(data_dir)?;
    if owner.as_deref() != Some(user_id) && live_manager_in_process() {
        log::error!(
            "[MLS_ACCOUNT] a foreground manager is loaded or loading in this process - the slot is NOT switched under it"
        );
        return Err("a foreground MLS session is still open".to_string().into());
    }
    let mine = parked_dir(data_dir, user_id);
    let mine_parked = mine.exists();

    let mut parked_other = false;
    match owner {
        Some(owner) if owner == user_id => {
            if mine_parked {
                // The slot is where every writer writes: the parked copy is the older one. Set
                // aside, never deleted, and never a refusal that would stand for ever.
                let aside = next_residue_dir(&mine);
                std::fs::rename(&mine, &aside)
                    .map_err(|e| format!("set the older parked state aside: {e}"))?;
                log::error!(
                    "[MLS_ACCOUNT] the slot AND a parked state both belong to the signing-in account - the parked one set aside, nothing deleted"
                );
            }
            log::debug!("[MLS_ACCOUNT] the slot already holds the account's state");
            return Ok(Selection::AlreadyInSlot);
        }
        Some(owner) => {
            // A sign-in IS the foreground: a background engine checking the guard gives way early,
            // and one that loaded the slot before this hold fails its compare-and-swap re-read.
            mark_foreground_active();
            // A parked state the owner already has is set aside by `finish_park`, before anything
            // moves: the slot's state is the later one.
            let other = parked_dir(data_dir, &owner);
            std::fs::create_dir_all(data_dir.join(PARKED_STATES_DIR))
                .map_err(|e| format!("create {PARKED_STATES_DIR}: {e}"))?;
            let staging = with_suffix(&other, PARKING_SUFFIX);
            std::fs::create_dir(&staging).map_err(|e| format!("create the park: {e}"))?;
            finish_park(data_dir, &staging)?;
            parked_other = true;
        }
        None if slot_holds_state(data_dir)? => {
            if mine_parked {
                // SET ASIDE, NO LONGER A REFUSAL (round 6 of the review of #2919): the refusal stood
                // until somebody deleted one of the two states. Nothing is deleted - the unproven one
                // is offered back to the next account with no state of its own.
                mark_foreground_active();
                set_unproven_slot_aside_held(data_dir)?;
            } else {
                log::error!(
                    "[MLS_ACCOUNT] the slot holds a state with NO owner record - left in place for its owner, never attributed; the load's credential check decides"
                );
                return Ok(Selection::UnprovenLeftInSlot);
            }
        }
        None => {}
    }

    if !mine_parked {
        if let Some(residue) = offered_unproven_residue(data_dir, user_id)? {
            if read_mls_state_owner(data_dir)?.is_none() && !slot_holds_state(data_dir)? {
                mark_foreground_active();
                bring_unproven_into_slot_held(data_dir, &residue)?;
                return Ok(Selection::UnprovenLeftInSlot);
            }
        }
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
    if slot_holds_state(data_dir)? {
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

/// [`canari_ios_mirror_mls_bin_to_app_group`]'s answer: the copy follows the slot.
#[cfg(any(target_os = "ios", test))]
pub(crate) const MIRROR_OK: i32 = 0;
/// No data directory was handed over (null or not UTF-8): nothing was touched.
#[cfg(target_os = "ios")]
pub(crate) const MIRROR_NO_DIR: i32 = -1;
/// The App Group container could not be resolved: nothing was touched.
#[cfg(target_os = "ios")]
pub(crate) const MIRROR_NO_GROUP: i32 = -2;
/// The copy or the removal failed, or the state files' lock was poisoned.
#[cfg(any(target_os = "ios", test))]
pub(crate) const MIRROR_FAILED: i32 = -3;

/// The activation mirror's `mls.bin` half: [`sync_extension_copy`] UNDER [`mls_bin_write_lock`].
///
/// **WHY THE MIRROR TAKES THE STATE FILES' LOCK** (re-review of #2919). `CanariMirrorPushStateToAppGroup`
/// runs on the main thread at every activation, and copied `mls.bin` with no lock: it could read
/// account A's state from the slot, lose the CPU to a switch that parked it and refreshed the App
/// Group copy from B's slot, then write A's bytes over it - and the notification extension would
/// decrypt B's pushes with A's state until the next activation. Checking the owner record first
/// would not close it (the switch can land between the check and the write); the lock does, because
/// the switch's own refresh ([`refresh_extension_copy`]) runs inside the same hold as its moves. So the
/// mirror and the switch are one writer of the copy, serialised, with one implementation.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn mirror_extension_copy(data_dir: &Path, group: &Path) -> i32 {
    log::debug!("[MLS_ACCOUNT] activation mirror of mls.bin into the App Group");
    // ON THE MAIN THREAD (`didBecomeActive`, `willResignActive`), behind holders that read and write
    // a multi-megabyte `mls.bin` under the same lock: the wait and the hold are logged so a stall is
    // a number on the bench, not a guess (round 4 of the review of #2919).
    let asked = std::time::Instant::now();
    let Ok(_guard) = mls_bin_write_lock().lock() else {
        log::error!(
            "[MLS_ACCOUNT] activation mirror: the mls_bin write lock is poisoned - not mirrored"
        );
        return MIRROR_FAILED;
    };
    let held = std::time::Instant::now();
    let code = match sync_extension_copy(data_dir, group) {
        Ok(()) => MIRROR_OK,
        Err(e) => {
            log::error!("[MLS_ACCOUNT] activation mirror of mls.bin failed: {e}");
            MIRROR_FAILED
        }
    };
    log::debug!(
        "[MLS_ACCOUNT] activation mirror: waited {} ms for the state lock, held it {} ms",
        held.duration_since(asked).as_millis(),
        held.elapsed().as_millis()
    );
    code
}

/// The C entry of [`mirror_extension_copy`], called by `CanariMirrorPushStateToAppGroup`
/// (`canari_push.mm`) with the app data directory (`CanariTauriDataDir`). Answers one of the
/// `MIRROR_*` codes, which the caller NSLogs.
///
/// # Safety
/// `data_dir` is null or a valid NUL-terminated string for the duration of the call.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn canari_ios_mirror_mls_bin_to_app_group(
    data_dir: *const std::os::raw::c_char,
) -> i32 {
    if data_dir.is_null() {
        return MIRROR_NO_DIR;
    }
    // SAFETY: non-null, and NUL-terminated for the call by this function's contract.
    let Ok(dir) = std::ffi::CStr::from_ptr(data_dir).to_str() else {
        return MIRROR_NO_DIR;
    };
    let group = match crate::app_group::app_group_dir() {
        Ok(group) => group,
        Err(e) => {
            log::error!("[MLS_ACCOUNT] activation mirror: no App Group container: {e}");
            return MIRROR_NO_GROUP;
        }
    };
    mirror_extension_copy(Path::new(dir), &group)
}

/// What [`remove_account_state`] removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Removed {
    /// Files of the account's parked state.
    pub parked_files: usize,
    /// Whether the slot was the account's and was swept.
    pub slot: bool,
    /// The account's `<hash>.residue-<n>` directories - what moves set aside under its name.
    pub residue_dirs: usize,
}

/// Removes EVERY MLS state `user_id` has on this install - the deleted-account wipe and the revoked
/// device's wipe of ONE account (`accountLocalWipe.ts`), after which nobody can ever open it again:
/// its parked directory, and the SLOT when the slot's owner record names it (review of #2919: a
/// deleted account that signed in last left its state there, and the next switch parked it under its
/// name for ever).
///
/// The slot is swept only on that proof, and REFUSED while a foreground manager is loaded: the
/// manager's next checkpoint would write the state back. A slot holding a state NO owner record names
/// is not the account's to judge, and stays where it is.
///
/// **AND WHAT WAS SET ASIDE UNDER ITS NAME** (re-review of #2919): every `<hash>.residue-<n>` of THIS
/// account, matched exactly ([`is_residue_of`]) - an allowlist, so no other account's directory, no
/// `unproven.residue-<n>`, and no unlisted entry of [`PARKED_STATES_DIR`], is ever reached.
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
        residue_dirs: 0,
    };
    if read_mls_state_owner(data_dir)?.as_deref() == Some(user_id) {
        if live_manager_in_process() {
            log::error!(
                "[MLS_ACCOUNT] the account's state is in the slot under a loaded manager - not swept"
            );
            return Err("a foreground MLS session is still open".to_string());
        }
        remove_mls_state_held(data_dir)?;
        removed.slot = true;
        refresh_extension_copy(data_dir);
        log::info!("[MLS_ACCOUNT] the account's state removed from the slot");
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
            "[MLS_ACCOUNT] the account's parked state removed ({} file(s))",
            removed.parked_files
        );
    } else {
        log::debug!("[MLS_ACCOUNT] no parked state for the account");
    }
    removed.residue_dirs = remove_residues_of_held(data_dir, &parked_dir_name(user_id))?;
    Ok(removed)
}

/// The frontend's view of [`remove_account_state`]: the number of state files removed, the slot's
/// counted as one, and each residue directory as one.
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
    Ok(removed.parked_files + usize::from(removed.slot) + removed.residue_dirs)
}

/// Suffix of an account's state set apart by a "forgot PIN" reset in progress (round 6 of the review
/// of #2919): `<hash>.resetting`, removed once the server has reset the PIN
/// ([`commit_account_reset`]), put back when it has not ([`rollback_account_reset`]).
const RESETTING_SUFFIX: &str = ".resetting";

/// The stem of the directories a state of UNPROVEN owner is set aside in (`unproven.residue-<n>`) -
/// never a hash, so no account's allowlist ([`is_residue_of`]) can ever match one, and no
/// account-scoped removal can ever delete one.
const UNPROVEN_STEM: &str = "unproven";

/// The accounts that gave up any state of unproven owner by resetting their PIN: one parked
/// directory name (the account's hash) per line. An account listed here is never OFFERED an unproven
/// state ([`offered_unproven_residue`]) - whatever was set aside, it chose a fresh one.
const UNPROVEN_DECLINED_FILE: &str = "unproven.declined";

/// A "forgot PIN" reset staged in THIS process and not yet committed or rolled back: what its
/// rollback must undo. A `<hash>.resetting` with no entry here is one a previous process left - its
/// server outcome is unknown, so it is put back, never removed ([`settle_pending_moves_held`]).
#[derive(Debug, Clone)]
struct ResetInFlight {
    /// The account's parked directory name.
    account: String,
    /// Its state was the SLOT's (its owner record named it) when the reset was staged.
    from_slot: bool,
    /// The state of unproven owner the stage set aside from the slot, if any.
    unproven_aside: Option<PathBuf>,
    /// The stage added the account to [`UNPROVEN_DECLINED_FILE`] (it was not listed before).
    declined_added: bool,
}

/// The resets staged in this process. Read and written only under [`mls_bin_write_lock`].
static RESETS_IN_FLIGHT: std::sync::Mutex<Vec<ResetInFlight>> = std::sync::Mutex::new(Vec::new());

/// Whether a reset of `account` (a parked directory name) is staged in this process.
fn reset_in_flight(account: &str) -> bool {
    RESETS_IN_FLIGHT
        .lock()
        .map(|r| r.iter().any(|r| r.account == account))
        // A poisoned registry cannot prove the reset is ours: treated as in flight, so nothing is
        // put back under a reset that may still be running.
        .unwrap_or(true)
}

/// The directory names of the accounts listed in [`UNPROVEN_DECLINED_FILE`]. An absent file is an
/// empty list; an unreadable one is an `Err`, which every caller refuses on.
fn declined_accounts(data_dir: &Path) -> Result<Vec<String>, String> {
    let path = data_dir
        .join(PARKED_STATES_DIR)
        .join(UNPROVEN_DECLINED_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text.lines().map(str::to_string).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => {
            log::error!("[MLS_ACCOUNT] {UNPROVEN_DECLINED_FILE} unreadable: {e}");
            Err(format!("read {UNPROVEN_DECLINED_FILE}: {e}"))
        }
    }
}

/// Rewrites [`UNPROVEN_DECLINED_FILE`] atomically (tmp + rename).
fn write_declined_accounts(data_dir: &Path, accounts: &[String]) -> Result<(), String> {
    let root = data_dir.join(PARKED_STATES_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {PARKED_STATES_DIR}: {e}"))?;
    let tmp = root.join(format!("{UNPROVEN_DECLINED_FILE}.tmp"));
    let mut text = accounts.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    std::fs::write(&tmp, text).map_err(|e| format!("write {UNPROVEN_DECLINED_FILE}: {e}"))?;
    std::fs::rename(&tmp, root.join(UNPROVEN_DECLINED_FILE))
        .map_err(|e| format!("rename {UNPROVEN_DECLINED_FILE}: {e}"))
}

/// The `unproven.residue-<n>` directories, lowest `n` first.
fn unproven_residues(data_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let root = data_dir.join(PARKED_STATES_DIR);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {PARKED_STATES_DIR}: {e}")),
    };
    let mut found: Vec<(u32, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("read an entry of {PARKED_STATES_DIR}: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let n = name
            .strip_prefix(UNPROVEN_STEM)
            .and_then(|rest| rest.strip_prefix(RESIDUE_INFIX))
            .and_then(|n| n.parse::<u32>().ok());
        if let Some(n) = n {
            found.push((n, entry.path()));
        }
    }
    found.sort_by_key(|(n, _)| *n);
    Ok(found.into_iter().map(|(_, p)| p).collect())
}

/// The state of unproven owner a reset set aside that `user_id` is OFFERED, if any: the first
/// `unproven.residue-<n>` holding a non-empty `mls.bin`, unless the account declined them all by
/// resetting its PIN ([`UNPROVEN_DECLINED_FILE`]). Offered and never attributed: the load under the
/// account's own key - the credential check - is the only proof of whose it is (round 6 of the
/// review of #2919: a reset over an unproven slot sets it aside instead of refusing, and this is how
/// its owner gets it back).
fn offered_unproven_residue(data_dir: &Path, user_id: &str) -> Result<Option<PathBuf>, String> {
    if declined_accounts(data_dir)?.contains(&parked_dir_name(user_id)) {
        return Ok(None);
    }
    for dir in unproven_residues(data_dir)? {
        if holds_bytes(&dir.join("mls.bin"))? {
            return Ok(Some(dir));
        }
    }
    Ok(None)
}

/// Moves every state file of the slot into a new `unproven.residue-<n>` and accuses it: the slot held
/// a state NO owner record names, and something must take the slot. NOTHING IS DELETED - the owner
/// gets it back through [`offered_unproven_residue`].
fn set_unproven_slot_aside_held(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = next_residue_dir(&data_dir.join(PARKED_STATES_DIR).join(UNPROVEN_STEM));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create the unproven residue: {e}"))?;
    let mut moved = 0usize;
    for name in mls_state_file_names() {
        let src = data_dir.join(&name);
        if !src.exists() {
            continue;
        }
        std::fs::rename(&src, dir.join(&name)).map_err(|e| format!("set {name} aside: {e}"))?;
        moved += 1;
    }
    log::error!(
        "[MLS_ACCOUNT] the slot's state of UNPROVEN owner set aside as {} ({moved} file(s)) - nothing deleted, offered back to the next account with no state of its own",
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    Ok(dir)
}

/// Moves the offered unproven state `residue` into the EMPTY slot, then removes the residue
/// directory (or sets aside what no list names in it).
fn bring_unproven_into_slot_held(data_dir: &Path, residue: &Path) -> Result<(), String> {
    let stem = data_dir.join(PARKED_STATES_DIR).join(UNPROVEN_STEM);
    let moved = move_state_files(residue, data_dir, &stem)?;
    remove_or_set_aside(residue, &stem)?;
    log::warn!(
        "[MLS_ACCOUNT] a state of unproven owner set aside earlier is offered to the signing-in account ({moved} file(s) moved into the slot) - its load decides whose it is"
    );
    Ok(())
}

/// Removes every `<account>.residue-<n>` ([`is_residue_of`], an exact-match allowlist). Returns how
/// many directories went.
fn remove_residues_of_held(data_dir: &Path, account: &str) -> Result<usize, String> {
    let mut removed = 0usize;
    match std::fs::read_dir(data_dir.join(PARKED_STATES_DIR)) {
        Ok(entries) => {
            for entry in entries {
                let entry =
                    entry.map_err(|e| format!("read an entry of {PARKED_STATES_DIR}: {e}"))?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_residue_of(&name, account) {
                    continue;
                }
                std::fs::remove_dir_all(entry.path())
                    .map_err(|e| format!("remove a residue of the account: {e}"))?;
                removed += 1;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::error!("[MLS_ACCOUNT] {PARKED_STATES_DIR} unreadable - the account's residue is not removed: {e}");
            return Err(format!("read {PARKED_STATES_DIR}: {e}"));
        }
    }
    if removed > 0 {
        log::info!(
            "[MLS_ACCOUNT] the account's set-aside residue removed ({removed} director(y/ies))"
        );
    }
    Ok(removed)
}

/// Puts a `<hash>.resetting` back where a parked state lives, `<hash>` - or, when the account has one
/// there already, sets it aside as `<hash>.residue-<n>`. Nothing is deleted.
fn restore_resetting_dir_held(staging: &Path) -> Result<(), String> {
    let account_dir = account_dir_of(staging, RESETTING_SUFFIX)?;
    let target = if account_dir.exists() {
        next_residue_dir(&account_dir)
    } else {
        account_dir
    };
    std::fs::rename(staging, &target).map_err(|e| format!("put the reset state back: {e}"))
}

/// STEP ONE OF THE "FORGOT PIN" RESET OF `user_id` (round 6 of the review of #2919), run BEFORE the
/// server resets the PIN, in one hold of [`mls_bin_write_lock`]: the account's state is SET APART
/// (`<hash>.resetting`), never removed, so a server reset that fails can be rolled back
/// ([`rollback_account_reset`]) and one that lands is committed ([`commit_account_reset`]).
///
/// - The slot, when its owner record names `user_id`, is parked first (the ordinary park).
/// - A slot holding a state NO owner record names is SET ASIDE (`unproven.residue-<n>`), never
///   removed and no longer a refusal (round 5 refused, which left every install upgrading from
///   before the record with no way out but clearing the app's data): it may be another account's,
///   and that account gets it back at its next sign-in ([`offered_unproven_residue`]).
/// - Another account's slot is not touched.
/// - The account is added to [`UNPROVEN_DECLINED_FILE`]: having reset, it is never offered an
///   unproven state again - which would be the one it just gave up, or another account's.
///
/// Refused, with nothing moved, while a foreground manager is loaded (the caller ends the session
/// first) and while a move of this account's own state stands unfinished.
pub(crate) fn stage_account_reset(data_dir: &Path, user_id: &str) -> Result<(), String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let account = parked_dir_name(user_id);
    if reset_in_flight(&account) {
        return Err("a PIN reset of this account is already in progress".to_string());
    }
    if let Some(refusal) = refusal_for(&settle_pending_moves_held(data_dir), user_id, false) {
        log::error!("[MLS_ACCOUNT] the PIN reset is refused: {refusal}");
        return Err(refusal);
    }
    if live_manager_in_process() {
        log::error!("[MLS_ACCOUNT] the PIN reset is refused: a foreground manager is still loaded");
        return Err("a foreground MLS session is still open".to_string());
    }
    let owner = read_mls_state_owner(data_dir)?;
    let mine = parked_dir(data_dir, user_id);
    let mut unproven_aside = None;
    let from_slot = owner.as_deref() == Some(user_id);
    if from_slot {
        std::fs::create_dir_all(data_dir.join(PARKED_STATES_DIR))
            .map_err(|e| format!("create {PARKED_STATES_DIR}: {e}"))?;
        let staging = with_suffix(&mine, PARKING_SUFFIX);
        std::fs::create_dir(&staging).map_err(|e| format!("create the park: {e}"))?;
        finish_park(data_dir, &staging)?;
    } else if owner.is_none() && slot_holds_state(data_dir)? {
        unproven_aside = Some(set_unproven_slot_aside_held(data_dir)?);
    }
    let resetting = with_suffix(&mine, RESETTING_SUFFIX);
    if mine.exists() {
        std::fs::rename(&mine, &resetting)
            .map_err(|e| format!("set the account's state apart: {e}"))?;
    }
    let mut declined = declined_accounts(data_dir)?;
    let declined_added = !declined.contains(&account);
    if declined_added {
        declined.push(account.clone());
        write_declined_accounts(data_dir, &declined)?;
    }
    if from_slot || unproven_aside.is_some() {
        refresh_extension_copy(data_dir);
    }
    log::info!(
        "[MLS_ACCOUNT] the PIN reset is staged: the account's state set apart ({}), the slot's unproven state {}",
        if resetting.exists() { "present" } else { "none here" },
        if unproven_aside.is_some() { "set aside" } else { "untouched" }
    );
    RESETS_IN_FLIGHT
        .lock()
        .map_err(|_| "the reset registry is poisoned".to_string())?
        .push(ResetInFlight {
            account,
            from_slot,
            unproven_aside,
            declined_added,
        });
    Ok(())
}

/// Takes `user_id`'s staged reset out of [`RESETS_IN_FLIGHT`] - `None` when none was staged here.
fn take_in_flight(user_id: &str) -> Result<Option<ResetInFlight>, String> {
    let account = parked_dir_name(user_id);
    let mut in_flight = RESETS_IN_FLIGHT
        .lock()
        .map_err(|_| "the reset registry is poisoned".to_string())?;
    let at = in_flight.iter().position(|r| r.account == account);
    Ok(at.map(|i| in_flight.remove(i)))
}

/// STEP TWO, once the server has reset the PIN: the state set apart is removed with the account's
/// residue. The state of unproven owner the stage set aside STAYS, for its owner. Returns the number
/// of directories removed (the set-apart state counted as one).
pub(crate) fn commit_account_reset(data_dir: &Path, user_id: &str) -> Result<usize, String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if take_in_flight(user_id)?.is_none() {
        log::error!("[MLS_ACCOUNT] a PIN reset commit with no reset staged in this process");
    }
    let account = parked_dir_name(user_id);
    let resetting = with_suffix(&parked_dir(data_dir, user_id), RESETTING_SUFFIX);
    let mut removed = 0usize;
    if resetting.exists() {
        std::fs::remove_dir_all(&resetting)
            .map_err(|e| format!("remove the account's set-apart state: {e}"))?;
        removed += 1;
    }
    removed += remove_residues_of_held(data_dir, &account)?;
    log::info!("[MLS_ACCOUNT] the PIN reset is committed: {removed} director(y/ies) removed");
    Ok(removed)
}

/// STEP TWO, when the server did NOT reset the PIN: everything the stage moved goes back - the
/// account's state into the slot when it came from there and the slot is still empty (parked
/// otherwise), the unproven state into the slot when the stage took it from there and the slot is
/// still empty, and the account off [`UNPROVEN_DECLINED_FILE`] when the stage put it there.
pub(crate) fn rollback_account_reset(data_dir: &Path, user_id: &str) -> Result<(), String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let Some(staged) = take_in_flight(user_id)? else {
        log::error!("[MLS_ACCOUNT] a PIN reset rollback with no reset staged in this process");
        return Err("no PIN reset of this account is staged".to_string());
    };
    let slot_free = |dir: &Path| -> Result<bool, String> {
        Ok(read_mls_state_owner(dir)?.is_none() && !slot_holds_state(dir)?)
    };
    let mine = parked_dir(data_dir, user_id);
    let resetting = with_suffix(&mine, RESETTING_SUFFIX);
    if resetting.exists() {
        if staged.from_slot && slot_free(data_dir)? && !mine.exists() {
            let staging = with_suffix(&mine, UNPARKING_SUFFIX);
            std::fs::rename(&resetting, &staging)
                .map_err(|e| format!("start putting the state back: {e}"))?;
            finish_unpark(data_dir, &staging)?;
        } else {
            restore_resetting_dir_held(&resetting)?;
        }
    }
    if let Some(aside) = &staged.unproven_aside {
        if aside.exists() && slot_free(data_dir)? {
            bring_unproven_into_slot_held(data_dir, aside)?;
        }
    }
    if staged.declined_added {
        let declined: Vec<String> = declined_accounts(data_dir)?
            .into_iter()
            .filter(|a| a != &staged.account)
            .collect();
        write_declined_accounts(data_dir, &declined)?;
    }
    refresh_extension_copy(data_dir);
    log::warn!("[MLS_ACCOUNT] the PIN reset is rolled back: the server did not reset the PIN");
    Ok(())
}

/// Whether this install holds an MLS state of ANY account other than `user_id`: a parked or
/// set-aside state of another account, a state of unproven owner (in the slot or set aside), or a
/// slot whose owner record names another account. Asked by the revoked-device wipe (round 6 of the
/// review of #2919): the whole-install wipe would delete those, so it runs only when this answers
/// `false`. An entry that cannot be read is an `Err`, which the caller treats as "yes".
pub(crate) fn other_accounts_state_present(data_dir: &Path, user_id: &str) -> Result<bool, String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    match read_mls_state_owner(data_dir)? {
        Some(owner) if owner != user_id => return Ok(true),
        None if slot_holds_state(data_dir)? => return Ok(true),
        _ => {}
    }
    let mine = parked_dir_name(user_id);
    let entries = match std::fs::read_dir(data_dir.join(PARKED_STATES_DIR)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {PARKED_STATES_DIR}: {e}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("read an entry of {PARKED_STATES_DIR}: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let own = name == mine
            || [PARKING_SUFFIX, UNPARKING_SUFFIX, RESETTING_SUFFIX]
                .iter()
                .any(|s| name.strip_suffix(s) == Some(mine.as_str()))
            || is_residue_of(&name, &mine)
            || name == UNPROVEN_DECLINED_FILE
            || name == format!("{UNPROVEN_DECLINED_FILE}.tmp");
        if !own {
            log::info!("[MLS_ACCOUNT] another account's state is on this install");
            return Ok(true);
        }
    }
    Ok(false)
}

/// The frontend's step one of the "forgot PIN" reset ([`stage_account_reset`]). The caller ends the
/// native session first, WITHOUT a sweep, and asks the server only once this succeeded.
#[tauri::command]
pub(crate) fn stage_user_mls_reset(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    log::info!("[MLS_ACCOUNT] the PIN reset sets the account's local MLS state apart");
    stage_account_reset(&data_dir, &user_id)
}

/// The frontend's step two once the server reset the PIN ([`commit_account_reset`]).
#[tauri::command]
pub(crate) fn commit_user_mls_reset(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<usize, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    commit_account_reset(&data_dir, &user_id)
}

/// The frontend's step two when the server did not reset the PIN ([`rollback_account_reset`]).
#[tauri::command]
pub(crate) fn rollback_user_mls_reset(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    rollback_account_reset(&data_dir, &user_id)
}

/// The frontend's view of [`other_accounts_state_present`], asked by the revoked-device wipe.
#[tauri::command]
pub(crate) fn mls_other_accounts_present(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<bool, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let present = other_accounts_state_present(&data_dir, &user_id);
    if let Err(e) = &present {
        log::error!("[MLS_ACCOUNT] whether another account's state is here could not be read: {e}");
    }
    present
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
        let selected = select_account_state(dir, user)
            .map(|(selection, _)| selection)
            .map_err(|e| e.to_string());
        crate::concurrency::forget_live_manager_for_test();
        selected
    }

    /// A sign-in's selection whose session stays open (the manager is loading).
    fn select_and_hold(dir: &Path, user: &str) -> Result<Selection, String> {
        select_account_state(dir, user)
            .map(|(selection, _)| selection)
            .map_err(|e| e.to_string())
    }

    fn residue(dir: &Path, user: &str, n: u32) -> PathBuf {
        with_suffix(&parked_dir(dir, user), &format!("{RESIDUE_INFIX}{n}"))
    }

    fn slot(dir: &Path) -> Option<Vec<u8>> {
        std::fs::read(dir.join("mls.bin")).ok()
    }

    fn owner(dir: &Path) -> Option<String> {
        read_mls_state_owner(dir).unwrap()
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

        // With a parked state of its own, the account gets it back and the unproven state is SET
        // ASIDE, never deleted (round 6 of the review of #2919; it used to be a refusal that stood
        // until somebody deleted one of the two).
        let mine = parked_dir(&dir, "user-b");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::write(mine.join("mls.bin"), b"B's parked state").unwrap();
        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: true
            }
        );
        assert_eq!(slot(&dir).as_deref(), Some(&b"B's parked state"[..]));
        let aside = unproven_residues(&dir).unwrap();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(aside[0].join("mls.bin")).unwrap(),
            b"state of unknown owner"
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
            select_and_hold(&dir, "user-b").unwrap(),
            Selection::AlreadyInSlot
        );
        // ...and A's, interleaved before B's load, is refused with nothing moved.
        assert!(select_and_hold(&dir, "user-a").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        assert_eq!(owner(&dir).as_deref(), Some("user-b"));
        // An empty slot too: the first fresh sign-in owns it until its session ends.
        crate::concurrency::forget_live_manager_for_test();
        let fresh = temp_dir("interleaved-fresh");
        select_and_hold(&fresh, "user-a").unwrap();
        assert!(select_and_hold(&fresh, "user-b").is_err());
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

    /// F1 (review of #2919), F2 of the re-review: A LEDGER WRITTEN INTO THE SLOT WHILE A MOVE WAS CUT -
    /// a key-group join settling in a new process before anything finished the journal - lands at
    /// both ends of the move. Nothing is refused (an occupied destination used to fail every account's
    /// selection until a factory wipe), and NOTHING IS DELETED: the copy at the destination is set
    /// aside under the account's name. In a park that is the older parked copy; in an unpark it is
    /// the slot's stray, which no record proves to be the account's - the parked ledger wins.
    #[test]
    fn a_ledger_at_both_ends_of_a_cut_move_is_set_aside_never_deleted() {
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
        assert_eq!(
            std::fs::read(residue(&dir, "user-a", 0).join(ledger)).unwrap(),
            b"old ledger",
            "the older parked copy is set aside, not deleted"
        );
        assert!(!dir.join(ledger).exists());
        sign_in_and_save(&dir, "user-b", b"B");

        // B parked, A unparked: its ledger goes back with it.
        select(&dir, "user-a").unwrap();
        select(&dir, "user-b").unwrap();
        // The push service recreates a stray ledger in B's slot... B parked by hand, then A's
        // unpark cut before any file moved: the stray sits where A's ledger must go.
        let b_parked = parked_dir(&dir, "user-b");
        std::fs::create_dir_all(&b_parked).unwrap();
        for name in ["mls.bin", MLS_STATE_OWNER_FILE] {
            std::fs::rename(dir.join(name), b_parked.join(name)).unwrap();
        }
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        std::fs::rename(&a, &unstaging).unwrap();
        std::fs::write(dir.join(ledger), b"stray ledger").unwrap();

        assert_eq!(select(&dir, "user-a").unwrap(), Selection::AlreadyInSlot);
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        assert_eq!(
            std::fs::read(dir.join(ledger)).unwrap(),
            b"newer ledger",
            "the account's parked ledger wins over a stray nobody is proven to own"
        );
        assert_eq!(
            std::fs::read(residue(&dir, "user-a", 1).join(ledger)).unwrap(),
            b"stray ledger"
        );
        assert!(!unstaging.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F2 of the re-review: AN EMPTY `mls.bin` IN THE SLOT IS NO STATE, and an unpark never deletes
    /// the account's real one for it - the empty trace is set aside and the state comes back.
    #[test]
    fn an_empty_slot_mls_bin_never_costs_the_parked_state() {
        let _cold = cold();
        let dir = temp_dir("empty-slot-bin");
        sign_in_and_save(&dir, "user-a", b"A's state");
        select(&dir, "user-b").unwrap();
        std::fs::write(dir.join("mls.bin"), b"").unwrap();

        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: true
            }
        );
        assert_eq!(slot(&dir).as_deref(), Some(&b"A's state"[..]));
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        assert_eq!(
            std::fs::read(residue(&dir, "user-a", 0).join("mls.bin")).unwrap(),
            b""
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F2 of the re-review: TWO NON-EMPTY `mls.bin` AT BOTH ENDS OF ONE MOVE ARE REFUSED BEFORE ANY
    /// FILE MOVES - which ratchet survives is not a rename's to decide. Both bytes stay where they were.
    #[test]
    fn two_states_at_both_ends_of_a_move_are_refused_with_nothing_moved() {
        let _cold = cold();
        let dir = temp_dir("two-states");
        let ledger = crate::commands::storage::KEY_GROUP_PUSH_JOIN_LEDGER_FILE;
        sign_in_and_save(&dir, "user-a", b"A");
        select(&dir, "user-b").unwrap();
        let a = parked_dir(&dir, "user-a");
        std::fs::write(a.join(ledger), b"A's ledger").unwrap();
        // A state nobody is recorded for appears in the slot during A's unpark.
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        std::fs::rename(&a, &unstaging).unwrap();
        std::fs::write(dir.join("mls.bin"), b"unproven state").unwrap();

        assert!(select(&dir, "user-a").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"unproven state"[..]));
        assert_eq!(std::fs::read(unstaging.join("mls.bin")).unwrap(), b"A");
        assert_eq!(
            std::fs::read(unstaging.join(ledger)).unwrap(),
            b"A's ledger",
            "nothing moved before the refusal"
        );
        assert!(!residue(&dir, "user-a", 0).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F3 of the re-review: AN UNPARK THAT CANNOT FINISH REFUSES EVERY OTHER SIGN-IN. Its `mls.bin`
    /// moved first, so the slot holds the account's state with no owner record; admitting another
    /// account there would offer it that state as "unproven", and the reset after its failed load
    /// would delete it.
    #[test]
    fn an_unfinished_unpark_refuses_another_account_s_sign_in() {
        let _cold = cold();
        let dir = temp_dir("unpark-unowned");
        sign_in_and_save(&dir, "user-a", b"A");
        select(&dir, "user-b").unwrap();
        let a = parked_dir(&dir, "user-a");
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        std::fs::rename(&a, &unstaging).unwrap();
        std::fs::rename(unstaging.join("mls.bin"), dir.join("mls.bin")).unwrap();
        // What makes it unfinishable: a second state where the moved one now is.
        std::fs::write(unstaging.join("mls.bin"), b"another copy").unwrap();

        assert!(select(&dir, "user-b").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"A"[..]));
        assert_eq!(owner(&dir), None);
        // A query still answers for B (who has nothing here).
        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
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

    /// F1, and F3 of the re-review: ONE ACCOUNT'S UNFINISHABLE MOVE STOPS EVERY SIGN-IN, and only
    /// that: every other account is still located, and signs in again once the move can finish.
    #[test]
    fn an_unfinishable_move_stops_sign_ins_and_never_queries() {
        let _cold = cold();
        let dir = temp_dir("one-broken");
        sign_in_and_save(&dir, "user-b", b"B");
        select(&dir, "user-c").unwrap();
        sign_in_and_save(&dir, "user-c", b"C");
        // An unpark of A that cannot finish: its parked `mls.bin` is a directory the slot's copy
        // would have to replace.
        let a = parked_dir(&dir, "user-a");
        let unstaging = with_suffix(&a, UNPARKING_SUFFIX);
        std::fs::create_dir_all(&unstaging).unwrap();
        // A state the slot's (C's) would have to give way to: two states, refused.
        std::fs::write(unstaging.join("mls.bin"), b"A").unwrap();

        assert!(account_state_file(&dir, "user-a").is_err());
        assert!(select(&dir, "user-a").is_err());
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(parked_dir(&dir, "user-b").join("mls.bin"))
        );
        assert!(select(&dir, "user-b").is_err());
        assert_eq!(slot(&dir).as_deref(), Some(&b"C"[..]));
        // Once the obstacle is gone, the journal finishes and B signs in.
        std::fs::remove_file(unstaging.join("mls.bin")).unwrap();
        select(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir).as_deref(), Some(&b"B"[..]));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F4 of the re-review: AN ACCOUNT WITH A STATE IN THE SLOT AND ANOTHER PARKED NEVER LOCKS THE
    /// INSTALL. The parked one - the older, since the slot is where every writer writes - is set aside,
    /// nothing is overwritten or deleted, and both another account and the owner sign in.
    #[test]
    fn a_second_parked_state_for_one_account_is_set_aside_not_a_lock() {
        let _cold = cold();
        let dir = temp_dir("twice");
        sign_in_and_save(&dir, "user-a", b"A in the slot");
        let a = parked_dir(&dir, "user-a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("mls.bin"), b"A parked").unwrap();

        // Another account: the park finds the name taken, sets the older state aside FIRST.
        select(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir), None);
        assert_eq!(std::fs::read(a.join("mls.bin")).unwrap(), b"A in the slot");
        assert_eq!(
            std::fs::read(residue(&dir, "user-a", 0).join("mls.bin")).unwrap(),
            b"A parked"
        );

        // The owner itself, with the slot its own: the parked copy goes aside, the slot stays.
        let fresh = temp_dir("twice-owner");
        sign_in_and_save(&fresh, "user-a", b"A in the slot");
        let a = parked_dir(&fresh, "user-a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("mls.bin"), b"A parked").unwrap();
        assert_eq!(select(&fresh, "user-a").unwrap(), Selection::AlreadyInSlot);
        assert_eq!(slot(&fresh).as_deref(), Some(&b"A in the slot"[..]));
        assert!(!a.exists());
        assert_eq!(
            std::fs::read(residue(&fresh, "user-a", 0).join("mls.bin")).unwrap(),
            b"A parked"
        );
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&fresh).ok();
    }

    /// F4 of the re-review: A CUT PARK WHOSE FINAL NAME IS TAKEN checks it BEFORE moving anything, and
    /// still finishes - a refusal there stood for ever and refused every sign-in.
    #[test]
    fn a_cut_park_whose_final_name_is_taken_still_finishes() {
        let _cold = cold();
        let dir = temp_dir("cut-park-taken");
        sign_in_and_save(&dir, "user-a", b"A");
        let a = parked_dir(&dir, "user-a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("mls.bin"), b"older A").unwrap();
        std::fs::create_dir_all(with_suffix(&a, PARKING_SUFFIX)).unwrap();

        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: false
            }
        );
        assert_eq!(std::fs::read(a.join("mls.bin")).unwrap(), b"A");
        assert_eq!(
            std::fs::read(residue(&dir, "user-a", 0).join("mls.bin")).unwrap(),
            b"older A"
        );
        assert!(!with_suffix(&a, PARKING_SUFFIX).exists());
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

        // What a move set aside under A's name goes with it; a look-alike of another hash stays.
        std::fs::create_dir_all(residue(&dir, "user-a", 0)).unwrap();
        std::fs::write(residue(&dir, "user-a", 0).join("x"), b"x").unwrap();
        let other_residue = residue(&dir, "user-b", 0);
        std::fs::create_dir_all(&other_residue).unwrap();
        let look_alike = with_suffix(&parked_dir(&dir, "user-a"), ".residue-x");
        std::fs::create_dir_all(&look_alike).unwrap();

        let removed = remove_account_state(&dir, "user-a").unwrap();
        assert_eq!(
            removed,
            Removed {
                parked_files: 2,
                slot: false,
                residue_dirs: 1
            }
        );
        assert!(!residue(&dir, "user-a", 0).exists());
        assert!(
            other_residue.exists(),
            "another account's residue is not this deletion's"
        );
        assert!(
            look_alike.exists(),
            "only <hash>.residue-<digits> is on the allowlist"
        );
        std::fs::remove_dir_all(&other_residue).unwrap();
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
                slot: false,
                residue_dirs: 0
            }
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F4, widened in round 4: the fresh-start guard needs a STATE in the slot - an owner record
    /// alone is no state to lose - and refuses one WHATEVER the selection; only the rotation's own
    /// replacement passes, and never over a state an unpark just brought back.
    #[test]
    fn the_fresh_start_guard_needs_a_state_in_the_slot_not_a_record() {
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
        assert_eq!(fresh_start_refusal(moved, true, false, &dir), None);

        std::fs::write(dir.join("mls.bin"), b"A").unwrap();
        assert!(fresh_start_refusal(moved, true, false, &dir).is_some());
        assert!(
            fresh_start_refusal(moved, true, true, &dir).is_some(),
            "a rotation never replaces a state an unpark just brought back"
        );
        assert_eq!(fresh_start_refusal(moved, false, false, &dir), None);
        assert!(
            fresh_start_refusal(Selection::AlreadyInSlot, true, false, &dir).is_some(),
            "a fresh start over the slot's state is refused whatever the selection"
        );
        assert!(fresh_start_refusal(Selection::UnprovenLeftInSlot, true, false, &dir).is_some());
        assert!(
            fresh_start_refusal(Selection::UnprovenLeftInSlot, true, true, &dir).is_some(),
            "a rotation never replaces a state of unproven owner"
        );
        assert_eq!(
            fresh_start_refusal(Selection::AlreadyInSlot, true, true, &dir),
            None,
            "the rotation replaces the state that did not open"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The PIN reset of B, run as the frontend runs it: staged, then committed once the server reset the
    /// PIN. ONLY B's state goes - A's slot, A's ledgers and anything unlisted stay (round 5's H1, kept
    /// by round 6's staging).
    #[test]
    fn a_pin_reset_removes_only_its_own_accounts_state() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-scoped");
        sign_in_and_save(&dir, "user-b", b"state-b");
        select(&dir, "user-a").unwrap();
        sign_in_and_save(&dir, "user-a", b"state-a");
        std::fs::write(dir.join("channel_keys.json"), b"{}").unwrap();

        stage_account_reset(&dir, "user-b").unwrap();
        assert!(!parked_dir(&dir, "user-b").exists(), "set apart");
        assert_eq!(commit_account_reset(&dir, "user-b").unwrap(), 1);
        assert!(!with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX).exists());
        assert_eq!(slot(&dir).unwrap(), b"state-a");
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        assert!(dir.join("channel_keys.json").exists());

        // A's own reset over A's own slot does remove it.
        stage_account_reset(&dir, "user-a").unwrap();
        assert_eq!(slot(&dir), None);
        assert_eq!(owner(&dir), None);
        commit_account_reset(&dir, "user-a").unwrap();
        assert!(!parked_dir(&dir, "user-a").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 6 (L1): a server reset that FAILS rolls the stage back - the account's slot state is in
    /// the slot again, byte for byte, its owner record with it, and it is off the declined list.
    #[test]
    fn a_pin_reset_the_server_refused_is_rolled_back() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-rollback");
        sign_in_and_save(&dir, "user-a", b"state-a");
        std::fs::write(dir.join("background_stages.json"), b"A's stages").unwrap();

        stage_account_reset(&dir, "user-a").unwrap();
        assert_eq!(slot(&dir), None);
        assert!(
            stage_account_reset(&dir, "user-a").is_err(),
            "one reset at a time"
        );
        rollback_account_reset(&dir, "user-a").unwrap();

        assert_eq!(slot(&dir).unwrap(), b"state-a");
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        assert_eq!(
            std::fs::read(dir.join("background_stages.json")).unwrap(),
            b"A's stages"
        );
        assert!(!declined_accounts(&dir)
            .unwrap()
            .contains(&parked_dir_name("user-a")));
        assert!(
            rollback_account_reset(&dir, "user-a").is_err(),
            "nothing staged"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 6 (L1): a reset a previous process staged and never settled is PUT BACK at the next
    /// look - the server's answer is not known, so nothing is deleted on a guess.
    #[test]
    fn a_pin_reset_cut_before_it_settled_is_put_back() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-cut");
        sign_in_and_save(&dir, "user-a", b"state-a");
        stage_account_reset(&dir, "user-a").unwrap();
        // The process dies: its registry goes with it.
        take_in_flight("user-a").unwrap();

        assert_eq!(
            account_state_file(&dir, "user-a").unwrap(),
            Some(parked_dir(&dir, "user-a").join("mls.bin"))
        );
        assert_eq!(
            std::fs::read(parked_dir(&dir, "user-a").join("mls.bin")).unwrap(),
            b"state-a"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 6 (M1), END TO END: A used the install on a build that wrote no owner record, B signs in
    /// over A's unproven state, forgets the PIN and resets - and A, signing in next, gets its state
    /// back byte for byte. The reset SET IT ASIDE: it used to be refused, leaving "clear the app's
    /// data" as the way out, and before that it was deleted.
    #[test]
    fn an_unproven_state_set_aside_by_a_reset_goes_back_to_its_owner() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-unproven");
        // A, on the old build: a state and no owner record.
        std::fs::write(dir.join("mls.bin"), b"A's state, never recorded").unwrap();

        // B signs in on the new build: offered the unproven state, which B's key does not open.
        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        // B forgets the PIN: the unproven state is set aside, B declines it, the server resets.
        stage_account_reset(&dir, "user-b").unwrap();
        assert_eq!(slot(&dir), None);
        commit_account_reset(&dir, "user-b").unwrap();
        let aside = unproven_residues(&dir).unwrap();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(aside[0].join("mls.bin")).unwrap(),
            b"A's state, never recorded"
        );

        // B starts fresh: never offered the state it gave up.
        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: false
            }
        );
        sign_in_and_save(&dir, "user-b", b"B's fresh state");

        // No account-scoped removal can reach it: it is nobody's residue.
        for user in ["user-a", "user-b"] {
            assert!(!is_residue_of(
                &aside[0].file_name().unwrap().to_string_lossy(),
                &parked_dir_name(user)
            ));
        }
        remove_account_state(&dir, "user-a").unwrap();
        assert!(aside[0].exists());

        // A signs in: B is parked, and A is offered the state set aside - its load decides.
        assert_eq!(
            account_state_file(&dir, "user-a").unwrap(),
            Some(aside[0].join("mls.bin"))
        );
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        assert_eq!(slot(&dir).unwrap(), b"A's state, never recorded");
        assert!(unproven_residues(&dir).unwrap().is_empty());
        assert_eq!(
            std::fs::read(parked_dir(&dir, "user-b").join("mls.bin")).unwrap(),
            b"B's fresh state"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 6 (M2): whether another account's state is on the install - what decides between the
    /// whole-install wipe of a revoked device and the wipe of its one account.
    #[test]
    fn another_accounts_state_is_seen_wherever_it_lies() {
        let _cold = cold();
        let dir = temp_dir("others-present");
        assert!(!other_accounts_state_present(&dir, "user-b").unwrap());
        sign_in_and_save(&dir, "user-b", b"state-b");
        std::fs::create_dir_all(residue(&dir, "user-b", 0)).unwrap();
        assert!(
            !other_accounts_state_present(&dir, "user-b").unwrap(),
            "B's own slot and residue"
        );

        // A parked under B: present.
        select(&dir, "user-a").unwrap();
        sign_in_and_save(&dir, "user-a", b"state-a");
        select(&dir, "user-b").unwrap();
        assert!(other_accounts_state_present(&dir, "user-b").unwrap());

        // A state of unproven owner, in the slot or set aside: present.
        let dir2 = temp_dir("others-present-unproven");
        std::fs::write(dir2.join("mls.bin"), b"nobody proven").unwrap();
        assert!(other_accounts_state_present(&dir2, "user-b").unwrap());
        set_unproven_slot_aside_held(&dir2).unwrap();
        assert!(other_accounts_state_present(&dir2, "user-b").unwrap());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&dir2).ok();
    }

    /// ROUND 5 (L3): an unfinished move of the account's OWN state is typed where the login meets it
    /// first - the size it asks before signing in.
    #[test]
    fn the_size_query_types_an_unfinished_move_of_the_accounts_own_state() {
        let _cold = cold();
        let dir = temp_dir("size-own-unfinished");
        sign_in_and_save(&dir, "user-a", b"state-a");
        let journal = start_park_for_test(&dir, "user-a");
        std::fs::write(journal.join("mls.bin"), b"state-a-older").unwrap();
        assert!(matches!(
            account_state_size(&dir, "user-a"),
            Err(SelectionRefused::MoveUnfinished(_))
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

    /// F5 of the re-review: THE ACTIVATION MIRROR TAKES THE STATE FILES' LOCK. While a switch holds
    /// it, the mirror waits, and then copies the slot AS THE SWITCH LEFT IT - never the previous
    /// account's bytes read before the switch.
    #[test]
    fn the_activation_mirror_waits_for_a_switch_and_copies_what_it_left() {
        let _cold = cold();
        let dir = temp_dir("mirror-slot");
        let group = temp_dir("mirror-group");
        std::fs::write(dir.join("mls.bin"), b"account A").unwrap();

        let switching = mls_bin_write_lock().lock().unwrap();
        let (d, g) = (dir.clone(), group.clone());
        let mirror = std::thread::spawn(move || mirror_extension_copy(&d, &g));
        // The switch, inside its hold: the slot becomes B's.
        std::fs::write(dir.join("mls.bin"), b"account B").unwrap();
        drop(switching);

        assert_eq!(mirror.join().unwrap(), MIRROR_OK);
        assert_eq!(std::fs::read(group.join("mls.bin")).unwrap(), b"account B");
        // An empty slot leaves no copy for the extension.
        std::fs::remove_file(dir.join("mls.bin")).unwrap();
        assert_eq!(mirror_extension_copy(&dir, &group), MIRROR_OK);
        assert!(!group.join("mls.bin").exists());
        assert_ne!(MIRROR_FAILED, MIRROR_OK);
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&group).ok();
    }

    /// The residue allowlist matches `<hash>.residue-<digits>` exactly.
    #[test]
    fn only_an_accounts_own_residue_matches() {
        let a = parked_dir_name("user-a");
        assert!(is_residue_of(&format!("{a}.residue-0"), &a));
        assert!(is_residue_of(&format!("{a}.residue-12"), &a));
        assert!(!is_residue_of(&format!("{a}.residue-"), &a));
        assert!(!is_residue_of(&format!("{a}.residue-1x"), &a));
        assert!(!is_residue_of(&format!("{a}.parking"), &a));
        assert!(!is_residue_of(&a, &a));
        assert!(!is_residue_of(
            &format!("{}.residue-0", parked_dir_name("user-b")),
            &a
        ));
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
