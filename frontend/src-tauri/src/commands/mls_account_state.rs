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
    /// A "forgot PIN" reset of THIS account is staged and not settled (round 10 of the review of
    /// #2919): its state is set apart, and only the server's answer settles it. Its own type, so the
    /// gate asks the user to go online and retries the settle - never the restart a move asks for.
    ResetUnsettled(String),
    /// Anything else: a foreground session still open, a state of unproven owner, a filesystem
    /// failure.
    Other(String),
}

impl std::fmt::Display for SelectionRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MoveUnfinished(m) | Self::ResetUnsettled(m) | Self::Other(m) => f.write_str(m),
        }
    }
}

impl From<String> for SelectionRefused {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl SelectionRefused {
    /// Says the refusal at the level it deserves (round 11 of the review of #2919): an unsettled PIN
    /// reset is EXPECTED - the account's own reset waits for the server, and the gate asks the user to
    /// go online - so it is said at INFO with its reason, never as an accusation; anything else is a
    /// move that could not be finished, or a failure, and is accused.
    pub(crate) fn log(&self, what: &str) {
        match self {
            Self::ResetUnsettled(reason) => {
                log::info!("[MLS_ACCOUNT] {what}, as expected: {reason}")
            }
            other => log::error!("[MLS_ACCOUNT] {what}: {other}"),
        }
    }
}

impl From<SelectionRefused> for mls_core::StateLoadRefusal {
    fn from(refused: SelectionRefused) -> Self {
        match refused {
            SelectionRefused::MoveUnfinished(m) => Self::slot_move_unfinished(m),
            SelectionRefused::ResetUnsettled(m) => Self::reset_unsettled(m),
            SelectionRefused::Other(m) => Self::from(m),
        }
    }
}

/// A journalled move [`settle_pending_moves_held`] could not finish, named by the account it is of.
struct UnfinishedMove {
    /// The parked directory name (the account's hash) the move belongs to.
    account: String,
    /// What was left unfinished.
    kind: MoveKind,
}

/// What an [`UnfinishedMove`] left unfinished - which decides whose sign-ins it refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoveKind {
    /// A park: part of that account's state may still be in the slot.
    Park,
    /// An unpark: that account's `mls.bin` may be in the slot without its owner record.
    Unpark,
    /// A PIN reset of that account, staged and not settled (round 9 of the review of #2919): in flight
    /// in the current document, or left by a page or process that is gone after the server MAY have
    /// been asked - settled only from the server's answer ([`adopt_unsettled_reset`]). Its account's
    /// state is set apart, so a sign-in of THAT account would start fresh over it; the slot is not
    /// involved, so it refuses no other account.
    Reset,
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

/// Whether `name` is exactly a committed reset's tombstone: `<64 lowercase hex>.committed`, the shape
/// [`parked_dir_name`] gives an account and [`COMMITTED_SUFFIX`] a commit (round 12 of the review of
/// #2919). The ALLOWLIST of what the settle deletes unasked - never a suffix match, which would
/// delete anything else that happens to end the same way.
fn is_committed_tombstone(name: &str) -> bool {
    name.strip_suffix(COMMITTED_SUFFIX).is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
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
///
/// **UNDER THE UNPROVEN STEM, FROM THE COUNTER** ([`next_unproven_dir`], round 8 of the review of
/// #2919): those residues are offered in the order of their names, so a freed name taken again would
/// put a later state before an earlier one. An account's own residues are never offered, and keep the
/// first free name.
fn next_residue_dir(account_dir: &Path) -> Result<PathBuf, String> {
    if account_dir.file_name().and_then(|n| n.to_str()) == Some(UNPROVEN_STEM) {
        let data_dir = account_dir
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "an unproven residue outside the data directory".to_string())?;
        return next_unproven_dir(data_dir);
    }
    let mut n = 0u32;
    loop {
        let candidate = with_suffix(account_dir, &format!("{RESIDUE_INFIX}{n}"));
        if !candidate.exists() {
            return Ok(candidate);
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
            let dir = next_residue_dir(account_dir)?;
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
    let aside = next_residue_dir(account_dir)?;
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
        let aside = next_residue_dir(&final_dir)?;
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
                kind: MoveKind::Park,
            }];
        }
    };
    let mut parking = Vec::new();
    let mut unparking = Vec::new();
    let mut resetting = Vec::new();
    let mut committed = Vec::new();
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
            resetting.push((account.to_string(), entry.path()));
        } else if is_committed_tombstone(&name) {
            committed.push(entry.path());
        } else if name.ends_with(COMMITTED_SUFFIX) {
            log::warn!(
                "[MLS_ACCOUNT] an entry of {PARKED_STATES_DIR} ends like a committed reset but is not one - left untouched"
            );
        }
    }
    // A COMMITTED reset whose removal was cut: its commit point (the rename) was passed, so it is
    // removed - never undone (round 11 of the review of #2919).
    for tombstone in committed {
        log::warn!(
            "[MLS_ACCOUNT] a committed PIN reset's removal was cut by a previous process - finishing it"
        );
        if let Err(e) = std::fs::remove_dir_all(&tombstone) {
            log::error!("[MLS_ACCOUNT] a committed PIN reset's state could not be removed: {e}");
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
    if unreadable > 0 {
        unfinished.push(UnfinishedMove {
            account: String::new(),
            kind: MoveKind::Park,
        });
    }
    for (account, staging) in parking {
        if let Err(e) = finish_park(data_dir, &staging) {
            log::error!("[MLS_ACCOUNT] a cut park could not be finished: {e}");
            unfinished.push(UnfinishedMove {
                account,
                kind: MoveKind::Park,
            });
        }
    }
    for (account, staging) in unparking {
        if let Err(e) = finish_unpark(data_dir, &staging) {
            log::error!("[MLS_ACCOUNT] a cut unpark could not be finished: {e}");
            unfinished.push(UnfinishedMove {
                account,
                kind: MoveKind::Unpark,
            });
        }
    }
    // A PIN RESET NOT SETTLED (rounds 6 to 9 of the review of #2919). Run AFTER the parks and unparks
    // finished, so the slot an undo may write into is settled.
    // - Staged by THE CURRENT DOCUMENT: its page commits or rolls it back. Its account's state is set
    //   apart, so that account's sign-in is refused meanwhile - it would start fresh over it.
    // - Staged by a page or process that is gone, its journal naming the server's basis: the server
    //   MAY have been asked, and only its answer says whether the PIN was reset (round 9: an undo
    //   after a reset the server made sent the account back to an old PIN that opens nothing). Left
    //   for the account's next online sign-in, which settles it from that answer
    //   ([`adopt_unsettled_reset`]); its account's sign-in is refused until then.
    // - Cut before its journal was written: the server was never asked (the stage answers the page
    //   only once the journal is down), so it is UNDONE, never removed.
    let document = current_document();
    for (account, staging) in resetting {
        if reset_staged_by(&account, document) {
            unfinished.push(UnfinishedMove {
                account,
                kind: MoveKind::Reset,
            });
            continue;
        }
        match read_reset_journal(&staging) {
            Ok(journal) if journal.server_basis.is_some() => {
                log::warn!(
                    "[MLS_ACCOUNT] a PIN reset whose page is gone waits for its account's next online sign-in - settled from the server's answer, never guessed"
                );
                unfinished.push(UnfinishedMove {
                    account,
                    kind: MoveKind::Reset,
                });
            }
            Ok(_) => {
                log::error!(
                    "[MLS_ACCOUNT] a PIN reset was cut before its journal - the server was never asked, so it is undone, nothing deleted"
                );
                forget_stale_resets_of(&account);
                if let Err(e) = undo_reset_held(data_dir, &staging) {
                    log::error!("[MLS_ACCOUNT] a cut PIN reset could not be undone: {e}");
                    unfinished.push(UnfinishedMove {
                        account,
                        kind: MoveKind::Reset,
                    });
                }
            }
            Err(e) => {
                log::error!(
                    "[MLS_ACCOUNT] the journal of an unsettled PIN reset is unreadable: {e}"
                );
                unfinished.push(UnfinishedMove {
                    account,
                    kind: MoveKind::Reset,
                });
            }
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
    selection_refusal_for(unfinished, user_id, needs_slot).map(|r| r.to_string())
}

/// [`refusal_for`], TYPED for a sign-in or a size query: the account's own unsettled reset is
/// [`SelectionRefused::ResetUnsettled`], anything else [`SelectionRefused::MoveUnfinished`].
fn selection_refusal_for(
    unfinished: &[UnfinishedMove],
    user_id: &str,
    needs_slot: bool,
) -> Option<SelectionRefused> {
    let mine = parked_dir_name(user_id);
    unfinished
        .iter()
        .find(|m| m.account == mine || (needs_slot && m.kind != MoveKind::Reset))
        .map(|m| match (m.account == mine, m.kind) {
            (true, MoveKind::Reset) => SelectionRefused::ResetUnsettled(
                "a PIN reset of this account is not settled - the server's answer settles it at the next online sign-in"
                    .to_string(),
            ),
            (true, _) => SelectionRefused::MoveUnfinished(
                "this account's state was cut part-way through a move that cannot be finished"
                    .to_string(),
            ),
            (false, MoveKind::Park) => SelectionRefused::MoveUnfinished(
                "the slot still holds part of another account's state".to_string(),
            ),
            (false, _) => SelectionRefused::MoveUnfinished(
                "the slot may hold another account's state, moved in without its owner record"
                    .to_string(),
            ),
        })
}

/// Whether a move that touches the SLOT stands unfinished - a park or an unpark; an unsettled reset
/// sets apart its own account's state only.
fn slot_move_unfinished(unfinished: &[UnfinishedMove]) -> bool {
    unfinished.iter().any(|m| m.kind != MoveKind::Reset)
}

/// The path of `user_id`'s `mls.bin` on this install, or `None` when the account has no state here.
///
/// - the slot, when its owner record names `user_id`;
/// - the account's parked `mls.bin`, when it has one;
/// - the slot, when it holds a state with NO record - unproven, so the load decides, which is the
///   answer this install gave before one state per account existed - unless a move stands
///   unfinished, which may have left ANOTHER account's state there without its record;
/// - a state of unproven owner a reset set aside ([`offered_unproven_residue`]);
/// - otherwise `None`: the slot is another account's, and this account has nothing here.
///
/// The two unproven answers only for an account a state has OPENED for on this install
/// ([`account_known_here_held`]).
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
///
/// A state of UNPROVEN owner - in the slot or set aside - is located for this account only when a
/// state has OPENED for it on this install before ([`account_known_here_held`], round 8 of the review
/// of #2919). The sign-in's selection asks the same native question, so the size the login measures,
/// the bytes `load_mls_state` reads, the absence `mls_state_absent` proves and the slot the selection
/// fills never disagree.
fn account_state_file_held(
    data_dir: &Path,
    user_id: &str,
) -> Result<Option<PathBuf>, SelectionRefused> {
    let unfinished = settle_pending_moves_held(data_dir);
    if let Some(refusal) = selection_refusal_for(&unfinished, user_id, false) {
        return Err(refusal);
    }
    let parked = parked_dir(data_dir, user_id);
    let slot_has_state = slot_holds_state(data_dir)?;
    let owner = read_mls_state_owner(data_dir)?;
    let own = match owner.as_deref() {
        Some(owner) if owner == user_id => Some(data_dir.join("mls.bin")),
        _ if parked.exists() => Some(parked.join("mls.bin")),
        _ => None,
    };
    if let Some(own) = &own {
        forget_opened_if_own_state_empty_held(data_dir, user_id, own)?;
    }
    let offer_unproven = account_known_here_held(data_dir, user_id)?;
    let quiet = !slot_move_unfinished(&unfinished);
    let located = match owner {
        _ if own.is_some() => own,
        // NOT while a move stands unfinished: the unowned state may be the moving account's, its
        // `mls.bin` already in the slot and its record not (re-review of #2919).
        None if slot_has_state && quiet && offer_unproven => {
            log::warn!(
                "[MLS_ACCOUNT] the slot holds a state with no owner record - offered to the load, whose credential check decides"
            );
            Some(data_dir.join("mls.bin"))
        }
        // THE SAME OFFER THE SIGN-IN MAKES ([`select_held`], round 6): an account with no state of its
        // own is offered a state of unproven owner a reset set aside - so the login, which asks this
        // first, expects the state the sign-in will bring into the slot.
        _ if quiet => offered_unproven_residue(data_dir, user_id, offer_unproven)?
            .map(|residue| residue.join("mls.bin")),
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
/// [`account_state_file`], its refusal TYPED (round 11 of the review of #2919): old-PIN recovery reads
/// the bytes through it (`load_mls_state`), and an unsettled reset or an unfinished move must reach
/// its gate as what it is - never read as "no state here".
pub(crate) fn account_state_file_typed(
    data_dir: &Path,
    user_id: &str,
) -> Result<Option<PathBuf>, SelectionRefused> {
    if user_id.is_empty() {
        return Err("no account named".to_string().into());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| SelectionRefused::Other("mls_bin write lock poisoned".to_string()))?;
    account_state_file_held(data_dir, user_id)
}

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
///
/// **A STATE OF UNPROVEN OWNER IS OFFERED ONLY TO AN ACCOUNT A STATE HAS OPENED FOR HERE**
/// ([`account_known_here_held`], round 8 of the review of #2919): any other sign-in sets one in the
/// slot aside like any other, so a brand-new account starts fresh beside it instead of meeting it.
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
    if let Some(refusal) =
        selection_refusal_for(&settle_pending_moves_held(data_dir), user_id, true)
    {
        refusal.log("sign-in refused");
        return Err(refusal);
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
    if owner.as_deref() == Some(user_id) {
        forget_opened_if_own_state_empty_held(data_dir, user_id, &data_dir.join("mls.bin"))?;
    } else if mine_parked {
        forget_opened_if_own_state_empty_held(data_dir, user_id, &mine.join("mls.bin"))?;
    }
    let known_here = account_known_here_held(data_dir, user_id)?;

    let mut parked_other = false;
    match owner {
        Some(owner) if owner == user_id => {
            if mine_parked {
                // The slot is where every writer writes: the parked copy is the older one. Set
                // aside, never deleted, and never a refusal that would stand for ever.
                let aside = next_residue_dir(&mine)?;
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
            if mine_parked || !known_here {
                // SET ASIDE, NO LONGER A REFUSAL (round 6 of the review of #2919): the refusal stood
                // until somebody deleted one of the two states. Nothing is deleted - the unproven one
                // is offered back to an account a state has opened for here and has no state of its
                // own. An account no state has opened for here never meets it (rounds 7 and 8).
                mark_foreground_active();
                set_unproven_slot_aside_held(data_dir, next_unproven_dir(data_dir)?)?;
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
        if let Some(residue) = offered_unproven_residue(data_dir, user_id, known_here)? {
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
/// `unproven.residue-<n>`, and no unlisted entry of [`PARKED_STATES_DIR`], is ever reached. And its
/// `<hash>.resetting`, a reset in flight cancelled, and its [`UNPROVEN_DECLINED_FILE`] entry (round 7).
pub(crate) fn remove_account_state(data_dir: &Path, user_id: &str) -> Result<Removed, String> {
    if user_id.is_empty() {
        return Err("no account named".to_string());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    // An unsettled PIN reset of the account refuses nothing here: its set-apart state is removed below
    // with the rest, and the reset cancelled.
    let unfinished: Vec<UnfinishedMove> = settle_pending_moves_held(data_dir)
        .into_iter()
        .filter(|m| m.kind != MoveKind::Reset)
        .collect();
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
    let account = parked_dir_name(user_id);
    removed.residue_dirs = remove_residues_of_held(data_dir, &account)?;
    // A PIN RESET OF THIS ACCOUNT STAGED AND NOT SETTLED (round 7 of the review of #2919): its
    // set-apart state is the account's too, and a commit or rollback arriving after this would act on
    // an account that is gone. Cancelled, then removed. The unproven state it set aside stays: it was
    // never this account's to remove.
    if forget_resets_of(&account)? {
        log::warn!("[MLS_ACCOUNT] a PIN reset of the removed account was in flight - cancelled");
    }
    let resetting = with_suffix(&parked_dir(data_dir, user_id), RESETTING_SUFFIX);
    if resetting.exists() {
        std::fs::remove_dir_all(&resetting)
            .map_err(|e| format!("remove the account's set-apart state: {e}"))?;
        removed.residue_dirs += 1;
        log::info!("[MLS_ACCOUNT] the account's state set apart by a PIN reset removed");
    }
    // The declined entry names a hash nobody can sign in as again: pruned, so the list holds only
    // accounts that exist. And the account is no longer one a state has opened for here.
    undecline_held(data_dir, &account)?;
    forget_account_opened_held(data_dir, user_id)?;
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
/// ([`commit_account_reset`]), put back when it has not ([`rollback_account_reset`]). It always
/// exists while the reset does - empty but for its journal when the account had no state here.
const RESETTING_SUFFIX: &str = ".resetting";

/// Suffix of a COMMITTED reset's set-apart state, waiting to be deleted (round 11 of the review of
/// #2919): `<hash>.resetting` is RENAMED to `<hash>.committed` in one atomic step - the local commit
/// point - and only then removed. A removal cut part-way can no longer leave a `.resetting` whose
/// journal is gone, which the next look read as "the server was never asked" and UNDID: the old-PIN
/// state unparked after the server reset the PIN. Whatever finds a `.committed` removes it - never
/// undone, never offered, never counted as a state.
const COMMITTED_SUFFIX: &str = ".committed";

/// The journal inside `<hash>.resetting`: what the stage did beyond setting the account's state apart,
/// so that undoing it needs NO memory of the process that staged it (round 7 of the review of #2919: a
/// crash between the stage and the server's answer left the account declined and an unproven state
/// aside, its owner stranded). Lines `from_slot`, `declined_added` and `unproven=<directory name>`.
const RESET_JOURNAL_FILE: &str = "reset.journal";

/// The stem of the directories a state of UNPROVEN owner is set aside in (`unproven.residue-<n>`) -
/// never a hash, so no account's allowlist ([`is_residue_of`]) can ever match one, and no
/// account-scoped removal can ever delete one.
const UNPROVEN_STEM: &str = "unproven";

/// The next `<n>` of an `unproven.residue-<n>`: a counter that only grows, so a name is NEVER reused
/// (round 7: a freed `residue-0` was taken again by the next state set aside, and the order the
/// residues are offered in no longer said which was set aside first).
const UNPROVEN_COUNTER_FILE: &str = "unproven.counter";

/// The accounts that gave up any state of unproven owner by resetting their PIN: one parked
/// directory name (the account's hash) per line. An account listed here is never OFFERED an unproven
/// state ([`offered_unproven_residue`]) - whatever was set aside, it chose a fresh one.
const UNPROVEN_DECLINED_FILE: &str = "unproven.declined";

/// `{data_dir}/mls_opened/<hash>`: ONE EMPTY FILE PER ACCOUNT A STATE HAS OPENED FOR ON THIS INSTALL
/// (round 8 of the review of #2919). The only fact that decides whether a state of unproven owner is
/// offered to an account ([`account_known_here_held`]).
///
/// **WHY NOT THE DEVICE ID.** Round 7 read `mls_device_id_<userId>`, and `resolveDeviceId` writes that
/// id - and its native copy in `push_context.json` - BEFORE the state is opened: at the PIN check and
/// the revocation check. A new account that mistyped its PIN once was "known" at its second attempt,
/// was offered another account's state, and met "my PIN changed" - the round-6 symptom again. This
/// marker is written by `initialiser_mls` only once a state is INSTALLED for the account
/// ([`record_account_opened_held`]), and removed with the account's state (a reset's commit,
/// [`remove_account_state`]). Native, so no WebView eviction reaches it.
const OPENED_DIR: &str = "mls_opened";

/// The marker of `user_id` in [`OPENED_DIR`].
fn opened_marker(data_dir: &Path, user_id: &str) -> PathBuf {
    data_dir.join(OPENED_DIR).join(parked_dir_name(user_id))
}

/// Creates [`OPENED_DIR`] when it does not exist yet. ONLY THE START-UP SEED ([`seed_opened_markers`])
/// passes `seed`: it runs before the WebView can resolve any device identity, so the push context
/// still names the account of the previous build. Any later creation - the seed failed at start-up -
/// seeds NOTHING and says so at ERROR (round 9 of the review of #2919): by then a sign-in may have
/// rewritten the push context, and seeding from it would mark the account that just signed in.
///
/// THE SEED, for the one install the marker cannot be written for: one upgraded from a build before
/// the owner record, whose slot holds a state no record names and that no sign-in of THIS build has
/// opened yet. That state is the account's whose sign-in the previous build last resolved - the
/// account `push_context.json` names (its native copy of the device identity,
/// `store_device_identity`) - so that account is marked. Eligibility, never attribution: it is only
/// OFFERED the state, and its load decides. Without the seed every existing install would set its own
/// user's state aside at the first sign-in after the upgrade. **AN ACCEPTED RESIDUE, pre-1.3.0
/// installs only**: when the previous build last resolved ANOTHER account than the state's owner (two
/// accounts used the install, the last one's state never written), the wrong account is marked - it
/// is offered the state, its key does not open it, and it meets the old-PIN refusal once; the state
/// itself is never attributed, rewritten or lost.
///
/// Built in `mls_opened.tmp` and renamed into place, so a crash leaves no half-seeded directory to
/// be mistaken for a complete one. Runs under [`mls_bin_write_lock`].
fn create_opened_markers_held(data_dir: &Path, seed: bool) -> Result<(), String> {
    let dir = data_dir.join(OPENED_DIR);
    if dir.exists() {
        return Ok(());
    }
    if !seed {
        log::error!(
            "[MLS_ACCOUNT] {OPENED_DIR} is created after start-up - the start-up seed did not run or failed, so no account is offered a state of unproven owner it may own"
        );
    }
    let tmp = with_suffix(&dir, ".tmp");
    match std::fs::remove_dir_all(&tmp) {
        Ok(()) => log::warn!("[MLS_ACCOUNT] a cut seeding of {OPENED_DIR} is started again"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("clear {OPENED_DIR}.tmp: {e}")),
    }
    std::fs::create_dir_all(&tmp).map_err(|e| format!("create {OPENED_DIR}.tmp: {e}"))?;
    if seed && read_mls_state_owner(data_dir)?.is_none() && slot_holds_state(data_dir)? {
        match account_the_push_context_names(data_dir) {
            Some(user_id) => {
                write_durably(&tmp.join(parked_dir_name(&user_id)), b"")?;
                log::warn!(
                    "[MLS_ACCOUNT] an install from before the owner record: the account its push context names is marked as one a state opened for - it is offered the slot's state, and its load decides"
                );
            }
            None => log::warn!(
                "[MLS_ACCOUNT] an install from before the owner record, and no push context names an account - no account is offered the slot's state"
            ),
        }
    }
    std::fs::rename(&tmp, &dir).map_err(|e| format!("rename {OPENED_DIR}: {e}"))
}

/// The `userId` `push_context.json` names, `None` when the file is absent, unreadable or names none -
/// each accused but the absence, which a fresh install has.
fn account_the_push_context_names(data_dir: &Path) -> Option<String> {
    let path = data_dir.join(crate::commands::push::PUSH_CONTEXT_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::error!("[MLS_ACCOUNT] the push context could not be read: {e}");
            return None;
        }
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) => value
            .get("userId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        Err(e) => {
            log::error!("[MLS_ACCOUNT] the push context is malformed: {e}");
            None
        }
    }
}

/// Whether a state has OPENED for `user_id` on this install ([`OPENED_DIR`]) - the one question that
/// decides whether a state of unproven owner is offered to it. Under [`mls_bin_write_lock`].
pub(crate) fn account_known_here_held(data_dir: &Path, user_id: &str) -> Result<bool, String> {
    create_opened_markers_held(data_dir, false)?;
    let marker = opened_marker(data_dir, user_id);
    marker
        .try_exists()
        .map_err(|e| format!("examine the account's opened marker: {e}"))
}

/// Records that a state was installed for `user_id` - by `initialiser_mls`, in its claimed hold, right
/// after the owner record. Under [`mls_bin_write_lock`].
pub(crate) fn record_account_opened_held(data_dir: &Path, user_id: &str) -> Result<(), String> {
    create_opened_markers_held(data_dir, false)?;
    let marker = opened_marker(data_dir, user_id);
    if marker.exists() {
        return Ok(());
    }
    write_durably(&marker, b"")?;
    log::info!(
        "[MLS_ACCOUNT] the account is recorded as one a state has opened for on this install"
    );
    Ok(())
}

/// Removes `user_id`'s marker: its state is gone (a committed reset, a removed account).
fn forget_account_opened_held(data_dir: &Path, user_id: &str) -> Result<(), String> {
    match std::fs::remove_file(opened_marker(data_dir, user_id)) {
        Ok(()) => {
            log::info!("[MLS_ACCOUNT] the account is no longer one a state has opened for here");
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove the account's opened marker: {e}")),
    }
}

/// Seeds [`OPENED_DIR`] at start-up, before the WebView can resolve any device identity
/// (`lib.rs` setup): the push context still names the account of the previous build then. A failure
/// is accused at ERROR, with what it costs: the directory is then created unseeded at the first look,
/// and an upgraded install's own user meets its state set aside once.
pub(crate) fn seed_opened_markers(data_dir: &Path) {
    let seeded = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())
        .and_then(|_guard| create_opened_markers_held(data_dir, true));
    if let Err(e) = seeded {
        log::error!(
            "[MLS_ACCOUNT] {OPENED_DIR} could not be seeded at start-up: {e} - an install upgraded from before the owner record will not offer its state to its own user"
        );
    }
}

/// AN ACCOUNT WHOSE OWN STATE TURNS OUT EMPTY OR CUT IS NO LONGER ONE A STATE HAS OPENED FOR (round 9
/// of the review of #2919): `own` is its `mls.bin` (the slot its record names, or its parked one), and
/// when it holds no bytes the marker goes. The marker answered "this account has had a state here";
/// with that state gone it would go on offering the account a state of unproven owner - another
/// account's, which its key does not open - until its next install wrote it back. Under
/// [`mls_bin_write_lock`].
fn forget_opened_if_own_state_empty_held(
    data_dir: &Path,
    user_id: &str,
    own: &Path,
) -> Result<(), String> {
    if holds_bytes(own)? || !opened_marker(data_dir, user_id).exists() {
        return Ok(());
    }
    log::warn!(
        "[MLS_ACCOUNT] the account's own state is empty or cut - it is no longer an account a state has opened for here"
    );
    forget_account_opened_held(data_dir, user_id)
}

/// THE GENERATION OF THE WEBVIEW DOCUMENT THAT IS CURRENT NOW (round 9 of the review of #2919): the
/// one `page_ring` mints when a new page CLAIMS it (`page_ring_document`, the page's first native
/// call) and moves on at a web content death, never under [`mls_bin_write_lock`] - read here,
/// never claimed. A reset is the page's - its
/// commit or rollback lives there - so it is stamped with the document that staged it, and "in
/// flight" means "staged by the CURRENT document". Round 8 cleared the registry on a page load
/// instead: a stage still running across the navigation registered AFTER the clear and escaped it,
/// and an old document's late commit, arriving after the undo, removed the account's residues and
/// marker and answered Ok over a restored state.
///
/// Each test thread names its own document ([`set_document_for_test`]): `page_ring`'s generation is
/// process-wide, and its own test moves it.
fn current_document() -> u64 {
    #[cfg(test)]
    {
        TEST_DOCUMENT.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        crate::page_ring::current_page_document()
    }
}

#[cfg(test)]
thread_local! {
    static TEST_DOCUMENT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The current document of this test thread: a new value is a page load.
#[cfg(test)]
pub(crate) fn set_document_for_test(document: u64) {
    TEST_DOCUMENT.with(|d| d.set(document));
}

/// How a page holds a reset in [`RESETS_IN_FLIGHT`] (round 10 of the review of #2919).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResetHeld {
    /// The page staged it and its own steps settle it: never adopted beside them.
    Staged,
    /// The page ADOPTED it to settle it from the server's answer - a page that is gone left it, or
    /// this page's own steps lost the server's answer and handed it over. Adopted again, it answers
    /// its basis again, so a settle the server did not answer is asked again once the network is back.
    Adopted,
}

/// The resets staged and not yet committed or rolled back: `(parked directory name, document that
/// holds it, how)`. Only an entry of the CURRENT document is in flight ([`reset_staged_by`]); any
/// other is a page that is gone, settled from its journal ([`settle_pending_moves_held`]). Read and
/// written only under [`mls_bin_write_lock`].
static RESETS_IN_FLIGHT: std::sync::Mutex<Vec<(String, u64, ResetHeld)>> =
    std::sync::Mutex::new(Vec::new());

/// How `document` holds the reset of `account` (a parked directory name), `None` when it holds none or
/// is no longer the current document.
fn reset_held_by(account: &str, document: u64) -> Option<ResetHeld> {
    if document != current_document() {
        return None;
    }
    match RESETS_IN_FLIGHT.lock() {
        Ok(r) => r
            .iter()
            .find(|(a, d, _)| a == account && *d == document)
            .map(|(_, _, held)| *held),
        Err(_) => {
            // A poisoned registry cannot prove the reset is not this page's: treated as staged here,
            // so nothing is undone or adopted under a reset that may still be running.
            log::error!("[MLS_ACCOUNT] the reset registry is poisoned - read as in flight");
            Some(ResetHeld::Staged)
        }
    }
}

/// Whether `document` holds the reset of `account` and is still the current document.
fn reset_staged_by(account: &str, document: u64) -> bool {
    reset_held_by(account, document).is_some()
}

/// Records that `document` holds the reset of `account` as `held`, replacing any other entry of it.
fn register_reset(account: &str, document: u64, held: ResetHeld) -> Result<(), String> {
    let mut in_flight = RESETS_IN_FLIGHT
        .lock()
        .map_err(|_| "the reset registry is poisoned".to_string())?;
    in_flight.retain(|(a, _, _)| a != account);
    in_flight.push((account.to_string(), document, held));
    Ok(())
}

/// Forgets every entry of `account`, whichever document wrote it; whether there was one.
fn forget_resets_of(account: &str) -> Result<bool, String> {
    let mut in_flight = RESETS_IN_FLIGHT
        .lock()
        .map_err(|_| "the reset registry is poisoned".to_string())?;
    let before = in_flight.len();
    in_flight.retain(|(a, _, _)| a != account);
    Ok(in_flight.len() != before)
}

/// Forgets the entries of `account` written by a document that is gone - its reset is being undone.
fn forget_stale_resets_of(account: &str) {
    let document = current_document();
    match RESETS_IN_FLIGHT.lock() {
        Ok(mut in_flight) => in_flight.retain(|(a, d, _)| a != account || *d == document),
        Err(_) => log::error!(
            "[MLS_ACCOUNT] the reset registry is poisoned - a stale entry could not be forgotten"
        ),
    }
}

/// WHY A STEP OF THE PIN RESET WAS REFUSED - a TYPE across the boundary (`code`), the message evidence
/// only (round 9 of the review of #2919: the commit and the rollback used to log a missing reset and
/// go on).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct ResetRefusal {
    /// [`RESET_NOT_THIS_PAGE`], [`RESET_NOTHING_SET_APART`] or [`RESET_FAILED`].
    pub(crate) code: &'static str,
    /// What happened, for a reader of the logs.
    pub(crate) message: String,
}

/// The document asking is not the one that staged the reset, or is no longer the current one: a page
/// that is gone, whose late step must not act on what the current page or the settle did since.
pub(crate) const RESET_NOT_THIS_PAGE: &str = "RESET_NOT_STAGED_BY_THIS_PAGE";
/// No `<hash>.resetting` exists: there is nothing to commit or roll back.
pub(crate) const RESET_NOTHING_SET_APART: &str = "RESET_NOTHING_SET_APART";
/// Anything else: a refused stage, a filesystem failure, a poisoned lock.
pub(crate) const RESET_FAILED: &str = "RESET_FAILED";

impl ResetRefusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        let message = message.into();
        log::error!("[MLS_ACCOUNT] PIN reset step refused ({code}): {message}");
        Self { code, message }
    }
}

impl From<String> for ResetRefusal {
    fn from(message: String) -> Self {
        Self::new(RESET_FAILED, message)
    }
}

impl std::fmt::Display for ResetRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
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

/// Writes `text` to `{data_dir}/mls_accounts/<name>` atomically (tmp + rename).
fn write_parked_root_file(data_dir: &Path, name: &str, text: &str) -> Result<(), String> {
    let root = data_dir.join(PARKED_STATES_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {PARKED_STATES_DIR}: {e}"))?;
    write_durably(&root.join(name), text.as_bytes())
}

/// Writes `bytes` to `path` so that a crash leaves either the old file or the whole new one - never a
/// torn or empty one (round 8 of the review of #2919: the reset journal, the residue counter and the
/// declined list were written in place). A sibling `<name>.tmp`, flushed to the disk, renamed over
/// `path`, then the directory flushed so the rename itself survives a power cut (Unix; Windows has
/// no directory handle to flush, and its rename is already journalled by NTFS).
fn write_durably(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = with_suffix(path, ".tmp");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create {name}.tmp: {e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("write {name}.tmp: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("flush {name}.tmp: {e}"))?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {name}: {e}"))?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::File::open(parent).and_then(|d| d.sync_all()) {
            log::error!("[MLS_ACCOUNT] the directory of {name} could not be flushed: {e}");
        }
    }
    Ok(())
}

/// Rewrites [`UNPROVEN_DECLINED_FILE`].
fn write_declined_accounts(data_dir: &Path, accounts: &[String]) -> Result<(), String> {
    let mut text = accounts.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    write_parked_root_file(data_dir, UNPROVEN_DECLINED_FILE, &text)
}

/// Removes `account` from [`UNPROVEN_DECLINED_FILE`] - an undone reset, a removed account.
fn undecline_held(data_dir: &Path, account: &str) -> Result<(), String> {
    let declined = declined_accounts(data_dir)?;
    if !declined.iter().any(|a| a == account) {
        return Ok(());
    }
    let kept: Vec<String> = declined.into_iter().filter(|a| a != account).collect();
    write_declined_accounts(data_dir, &kept)
}

/// The `unproven.residue-<n>` directories, lowest `n` first - the order they were set aside in.
fn unproven_residues(data_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let root = data_dir.join(PARKED_STATES_DIR);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {PARKED_STATES_DIR}: {e}")),
    };
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("read an entry of {PARKED_STATES_DIR}: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let n = name
            .strip_prefix(UNPROVEN_STEM)
            .and_then(|rest| rest.strip_prefix(RESIDUE_INFIX))
            .and_then(|n| n.parse::<u64>().ok());
        if let Some(n) = n {
            found.push((n, entry.path()));
        }
    }
    found.sort_by_key(|(n, _)| *n);
    Ok(found.into_iter().map(|(_, p)| p).collect())
}

/// The `<n>` an entry of [`PARKED_STATES_DIR`] holds as `unproven.residue-<n>`, whatever follows it (a
/// cut `.parking`) - every name the counter must stay above.
fn unproven_number(name: &str) -> Option<u64> {
    let digits: String = name
        .strip_prefix(UNPROVEN_STEM)?
        .strip_prefix(RESIDUE_INFIX)?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// A fresh `unproven.residue-<n>` path from [`UNPROVEN_COUNTER_FILE`], the counter moved on BEFORE
/// the name is used - so a name is never handed out twice, even across a crash.
///
/// NEVER BELOW A NAME ON DISK, and a counter that is empty or malformed is NO REFUSAL (round 8 of the
/// review of #2919): the names on disk are the fact the counter summarises, so it falls back to them
/// and says so at WARN. Only a counter that cannot be READ refuses - its absence is not known then.
fn next_unproven_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let root = data_dir.join(PARKED_STATES_DIR);
    let counted = match std::fs::read_to_string(root.join(UNPROVEN_COUNTER_FILE)) {
        Ok(text) => match text.trim().parse::<u64>() {
            Ok(n) => n,
            Err(e) => {
                log::warn!(
                    "[MLS_ACCOUNT] {UNPROVEN_COUNTER_FILE} is empty or malformed ({e}) - the next name is taken above the names on disk"
                );
                0
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(format!("read {UNPROVEN_COUNTER_FILE}: {e}")),
    };
    let on_disk = match std::fs::read_dir(&root) {
        Ok(entries) => {
            let mut highest = 0u64;
            for entry in entries {
                let entry =
                    entry.map_err(|e| format!("read an entry of {PARKED_STATES_DIR}: {e}"))?;
                if let Some(n) = unproven_number(&entry.file_name().to_string_lossy()) {
                    highest = highest.max(n + 1);
                }
            }
            highest
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(format!("read {PARKED_STATES_DIR}: {e}")),
    };
    let n = counted.max(on_disk);
    write_parked_root_file(data_dir, UNPROVEN_COUNTER_FILE, &(n + 1).to_string())?;
    Ok(root.join(format!("{UNPROVEN_STEM}{RESIDUE_INFIX}{n}")))
}

/// The state of unproven owner a reset set aside that `user_id` is OFFERED, if any: the first, in
/// the order they were set aside, holding a non-empty `mls.bin` - and only when a state has OPENED for
/// the account on this install before (`known_here`, [`account_known_here_held`]; rounds 7 and 8 of
/// the review of #2919: a brand-new account was offered another account's state, met "sealed under
/// your old PIN" a minute after its first PIN, and nothing ever collected the residue). Never to an account that declined them all by
/// resetting its PIN ([`UNPROVEN_DECLINED_FILE`]). Offered and never attributed: the load under the
/// account's own key - the credential check - is the only proof of whose it is. A load that proves it
/// another account's puts it back aside under the NEXT name ([`return_unproven_aside_held`]), so the
/// residues are offered in turn.
fn offered_unproven_residue(
    data_dir: &Path,
    user_id: &str,
    known_here: bool,
) -> Result<Option<PathBuf>, String> {
    if !known_here || declined_accounts(data_dir)?.contains(&parked_dir_name(user_id)) {
        return Ok(None);
    }
    for dir in unproven_residues(data_dir)? {
        if holds_bytes(&dir.join("mls.bin"))? {
            return Ok(Some(dir));
        }
    }
    Ok(None)
}

/// Moves every state file of the slot into `dir` (a fresh [`next_unproven_dir`]) and accuses it: the
/// slot held a state NO owner record names, and something must take the slot. NOTHING IS DELETED -
/// the owner gets it back through [`offered_unproven_residue`].
///
/// **AS A PARK, SO A CRASH CANNOT SPLIT IT** (round 8 of the review of #2919): the files go through
/// `<dir>.parking` ([`finish_park`]), which the next look finishes ([`settle_pending_moves_held`]) -
/// `mls.bin` is never left on one side and its ledgers on the other.
fn set_unproven_slot_aside_held(data_dir: &Path, dir: PathBuf) -> Result<PathBuf, String> {
    let staging = with_suffix(&dir, PARKING_SUFFIX);
    std::fs::create_dir(&staging).map_err(|e| format!("create the unproven park: {e}"))?;
    finish_park(data_dir, &staging)?;
    log::error!(
        "[MLS_ACCOUNT] the slot's state of UNPROVEN owner set aside as {} - nothing deleted, offered back to an account a state has opened for here and with no state of its own",
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    Ok(dir)
}

/// For a sign-in that was offered an unproven state ([`Selection::UnprovenLeftInSlot`]) whose load
/// PROVED it another account's. Puts it back aside under the next name, so the next offer is the next
/// residue. Run inside the sign-in's claimed hold; a slot that no longer holds an unowned state is
/// left alone.
pub(crate) fn return_unproven_aside_held(data_dir: &Path) -> Result<(), String> {
    if read_mls_state_owner(data_dir)?.is_some() || !slot_holds_state(data_dir)? {
        return Ok(());
    }
    log::warn!(
        "[MLS_ACCOUNT] the unproven state offered to this sign-in did not open under its key - put back aside"
    );
    set_unproven_slot_aside_held(data_dir, next_unproven_dir(data_dir)?).map(|_| ())
}

/// Moves the offered unproven state `residue` into the EMPTY slot, then removes the residue
/// directory (or sets aside what no list names in it, under the counter's next name).
///
/// **AS AN UNPARK, SO A CRASH CANNOT SPLIT IT** (round 8 of the review of #2919): the residue is first
/// renamed to `unproven.unparking`, one atomic step, and [`finish_unpark`] moves its files - which the
/// next look finishes if this process dies part-way ([`settle_pending_moves_held`]).
fn bring_unproven_into_slot_held(data_dir: &Path, residue: &Path) -> Result<(), String> {
    let staging = with_suffix(
        &data_dir.join(PARKED_STATES_DIR).join(UNPROVEN_STEM),
        UNPARKING_SUFFIX,
    );
    std::fs::rename(residue, &staging).map_err(|e| format!("start bringing it back: {e}"))?;
    finish_unpark(data_dir, &staging)?;
    log::warn!(
        "[MLS_ACCOUNT] a state of unproven owner set aside earlier is offered to the signing-in account - its load decides whose it is"
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

/// What a stage did, as its journal records it.
#[derive(Debug, Default, PartialEq, Eq)]
struct ResetJournal {
    from_slot: bool,
    declined_added: bool,
    unproven: Option<String>,
    /// THE SERVER'S ANSWER BEFORE IT WAS ASKED (round 9 of the review of #2919): the fingerprint of the
    /// account's PIN salt when the reset was staged. Its presence says the server MAY have been asked
    /// (the stage answers the page only once the journal is down); its value is what the settle of a
    /// page that is gone compares the server's current salt with - the server's reset deletes it, so
    /// an equal one proves the PIN was not reset ([`adopt_unsettled_reset`]).
    server_basis: Option<String>,
}

/// Whether `basis` is a salt fingerprint as the page computes it: 64 lowercase hex digits.
fn is_server_basis(basis: &str) -> bool {
    basis.len() == 64
        && basis
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn write_reset_journal(staging: &Path, journal: &ResetJournal) -> Result<(), String> {
    let mut text = String::new();
    if journal.from_slot {
        text.push_str("from_slot\n");
    }
    if journal.declined_added {
        text.push_str("declined_added\n");
    }
    if let Some(dir) = &journal.unproven {
        text.push_str(&format!("unproven={dir}\n"));
    }
    if let Some(basis) = &journal.server_basis {
        text.push_str(&format!("server_basis={basis}\n"));
    }
    write_durably(&staging.join(RESET_JOURNAL_FILE), text.as_bytes())
}

/// The journal of `staging`; an absent one is an empty journal (the stage died before writing it,
/// so it did nothing beyond the rename the directory itself records).
fn read_reset_journal(staging: &Path) -> Result<ResetJournal, String> {
    let text = match std::fs::read_to_string(staging.join(RESET_JOURNAL_FILE)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ResetJournal::default()),
        Err(e) => return Err(format!("read the reset journal: {e}")),
    };
    let mut journal = ResetJournal::default();
    for line in text.lines() {
        match line {
            "from_slot" => journal.from_slot = true,
            "declined_added" => journal.declined_added = true,
            other => {
                if let Some(dir) = other.strip_prefix("unproven=") {
                    journal.unproven = Some(dir.to_string());
                } else if let Some(basis) = other.strip_prefix("server_basis=") {
                    journal.server_basis = Some(basis.to_string());
                }
            }
        }
    }
    Ok(journal)
}

/// UNDOES A STAGED RESET FROM ITS JOURNAL, nothing remembered by any process: the account's state
/// into the slot when it came from there and the slot is free (parked otherwise, or set aside beside a
/// parked one), the unproven state the stage set aside back into the free slot, and the account off
/// [`UNPROVEN_DECLINED_FILE`] when the stage put it there. The one implementation behind a refused
/// server reset ([`rollback_account_reset`]) and a reset a dead process left ([`settle_pending_moves_held`]).
fn undo_reset_held(data_dir: &Path, staging: &Path) -> Result<(), String> {
    let account_dir = account_dir_of(staging, RESETTING_SUFFIX)?;
    let account = account_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let journal = read_reset_journal(staging)?;
    let slot_free = |dir: &Path| -> Result<bool, String> {
        Ok(read_mls_state_owner(dir)?.is_none() && !slot_holds_state(dir)?)
    };
    // THE JOURNAL'S OWN STEPS FIRST, each one idempotent, and the journal removed only after them: a
    // process that dies part-way leaves the journal, and the next look finishes what it names. (The
    // unproven state and a state from the slot never come together: the first needs a slot no
    // record names, the second a record naming this account.)
    if let Some(name) = &journal.unproven {
        let aside = data_dir.join(PARKED_STATES_DIR).join(name);
        if aside.exists() && slot_free(data_dir)? {
            bring_unproven_into_slot_held(data_dir, &aside)?;
        }
    }
    if journal.declined_added {
        undecline_held(data_dir, &account)?;
    }
    match std::fs::remove_file(staging.join(RESET_JOURNAL_FILE)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove the reset journal: {e}")),
    }
    if std::fs::remove_dir(staging).is_ok() {
        log::debug!("[MLS_ACCOUNT] the undone reset had set apart no state of the account");
    } else if journal.from_slot && slot_free(data_dir)? && !account_dir.exists() {
        let unparking = with_suffix(&account_dir, UNPARKING_SUFFIX);
        std::fs::rename(staging, &unparking)
            .map_err(|e| format!("start putting the state back: {e}"))?;
        finish_unpark(data_dir, &unparking)?;
    } else {
        let target = if account_dir.exists() {
            next_residue_dir(&account_dir)?
        } else {
            account_dir.clone()
        };
        std::fs::rename(staging, &target).map_err(|e| format!("put the reset state back: {e}"))?;
    }
    refresh_extension_copy(data_dir);
    Ok(())
}

/// STEP ONE OF THE "FORGOT PIN" RESET OF `user_id` (round 6 of the review of #2919), run BEFORE the
/// server resets the PIN, in one hold of [`mls_bin_write_lock`]: the account's state is SET APART
/// (`<hash>.resetting`), never removed, so a server reset that fails can be rolled back
/// ([`rollback_account_reset`]) and one that lands is committed ([`commit_account_reset`]).
///
/// - The slot, when its owner record names `user_id`, is parked first (the ordinary park).
/// - A slot holding a state NO owner record names is SET ASIDE (`unproven.residue-<n>`), never
///   removed and no longer a refusal: it may be another account's, and that account gets it back at
///   its next sign-in ([`offered_unproven_residue`]).
/// - Another account's slot is not touched.
/// - The account is added to [`UNPROVEN_DECLINED_FILE`]: having reset, it is never offered an
///   unproven state again - which would be the one it just gave up, or another account's.
/// - Everything beyond the rename is written to the stage's journal ([`RESET_JOURNAL_FILE`]) before it
///   is done, so it can be undone with nothing remembered ([`undo_reset_held`]) - with the server's
///   basis (`server_basis`, the fingerprint of the account's PIN salt now), so a page that is gone
///   before it settled is settled from the server's answer ([`adopt_unsettled_reset`]).
/// - The reset is stamped with `document`, the page that staged it: only that page, while it is the
///   current document, may commit or roll it back.
///
/// Refused, with nothing moved, when `document` is no longer the current one (its page is gone and
/// would never settle it), while a foreground manager is loaded (the caller ends the session first),
/// while a reset of this account stands unsettled, and while a move of its own state stands
/// unfinished.
pub(crate) fn stage_account_reset(
    data_dir: &Path,
    user_id: &str,
    document: u64,
    server_basis: &str,
) -> Result<(), ResetRefusal> {
    if user_id.is_empty() {
        return Err("no account named".to_string().into());
    }
    if !is_server_basis(server_basis) {
        return Err("the server's basis is not a salt fingerprint"
            .to_string()
            .into());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if document != current_document() {
        return Err(ResetRefusal::new(
            RESET_NOT_THIS_PAGE,
            "the page asking is gone - nothing is set apart",
        ));
    }
    let account = parked_dir_name(user_id);
    if let Some(refusal) = refusal_for(&settle_pending_moves_held(data_dir), user_id, false) {
        log::error!("[MLS_ACCOUNT] the PIN reset is refused: {refusal}");
        return Err(refusal.into());
    }
    if live_manager_in_process() {
        log::error!("[MLS_ACCOUNT] the PIN reset is refused: a foreground manager is still loaded");
        return Err("a foreground MLS session is still open".to_string().into());
    }
    let owner = read_mls_state_owner(data_dir)?;
    let mine = parked_dir(data_dir, user_id);
    let mut journal = ResetJournal {
        from_slot: owner.as_deref() == Some(user_id),
        server_basis: Some(server_basis.to_string()),
        ..ResetJournal::default()
    };
    if journal.from_slot {
        std::fs::create_dir_all(data_dir.join(PARKED_STATES_DIR))
            .map_err(|e| format!("create {PARKED_STATES_DIR}: {e}"))?;
        let staging = with_suffix(&mine, PARKING_SUFFIX);
        std::fs::create_dir(&staging).map_err(|e| format!("create the park: {e}"))?;
        finish_park(data_dir, &staging)?;
    }
    // The set-apart directory exists from here on, with the journal of what follows.
    let resetting = with_suffix(&mine, RESETTING_SUFFIX);
    if mine.exists() {
        std::fs::rename(&mine, &resetting)
            .map_err(|e| format!("set the account's state apart: {e}"))?;
    } else {
        std::fs::create_dir_all(&resetting)
            .map_err(|e| format!("create the set-apart directory: {e}"))?;
    }
    let mut declined = declined_accounts(data_dir)?;
    journal.declined_added = !declined.contains(&account);
    let unproven_slot = owner.is_none() && slot_holds_state(data_dir)?;
    if unproven_slot {
        // Named in the journal BEFORE it is created: a crash between the two leaves a name the undo
        // finds absent, never a residue the journal does not name.
        let dir = next_unproven_dir(data_dir)?;
        journal.unproven = dir.file_name().map(|n| n.to_string_lossy().into_owned());
        write_reset_journal(&resetting, &journal)?;
        set_unproven_slot_aside_held(data_dir, dir)?;
    } else {
        write_reset_journal(&resetting, &journal)?;
    }
    if journal.declined_added {
        declined.push(account.clone());
        write_declined_accounts(data_dir, &declined)?;
    }
    if journal.from_slot || unproven_slot {
        refresh_extension_copy(data_dir);
    }
    log::info!(
        "[MLS_ACCOUNT] the PIN reset is staged by document {document}: the account's state set apart, the slot's unproven state {}",
        if unproven_slot { "set aside" } else { "untouched" }
    );
    register_reset(&account, document, ResetHeld::Staged)?;
    Ok(())
}

/// The `<hash>.resetting` of `user_id` that `document` may settle - REFUSED, as a type, when it is not
/// that page's reset or when nothing is set apart. Leaves the registry entry in place: the caller
/// forgets it only once its step has SUCCEEDED (round 11 of the review of #2919), so a step that
/// fails part-way can be asked again by the same page. Under [`mls_bin_write_lock`].
fn take_reset_of_this_page(
    data_dir: &Path,
    user_id: &str,
    document: u64,
) -> Result<PathBuf, ResetRefusal> {
    let account = parked_dir_name(user_id);
    if !reset_staged_by(&account, document) {
        return Err(ResetRefusal::new(
            RESET_NOT_THIS_PAGE,
            format!(
                "no reset of this account was staged by document {document}, or that page is gone"
            ),
        ));
    }
    let resetting = with_suffix(&parked_dir(data_dir, user_id), RESETTING_SUFFIX);
    if !resetting.exists() {
        forget_resets_of(&account)?;
        return Err(ResetRefusal::new(
            RESET_NOTHING_SET_APART,
            "the reset's set-apart state is gone",
        ));
    }
    Ok(resetting)
}

/// STEP TWO, once the server has reset the PIN: the state set apart is removed with its journal and
/// the account's residue. The state of unproven owner the stage set aside STAYS, for its owner.
/// Returns the number of directories removed (the set-apart one counted as one).
///
/// REFUSED, with nothing removed, unless `document` staged (or adopted) the reset and is the current
/// document, and its set-apart state exists ([`ResetRefusal`]): an old page's late commit after the
/// settle undid its reset would otherwise remove the account's residues and marker over a restored
/// state, and answer Ok.
pub(crate) fn commit_account_reset(
    data_dir: &Path,
    user_id: &str,
    document: u64,
) -> Result<usize, ResetRefusal> {
    if user_id.is_empty() {
        return Err("no account named".to_string().into());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let account = parked_dir_name(user_id);
    let resetting = take_reset_of_this_page(data_dir, user_id, document)?;
    // THE LOCAL COMMIT POINT IS ONE ATOMIC RENAME (round 11 of the review of #2919). Removed in
    // place, a cut `remove_dir_all` could delete `reset.journal` before `mls.bin`, and the next look
    // UNDID the half-removed reset as one "the server was never asked" - the old-PIN state back.
    let tombstone = with_suffix(&parked_dir(data_dir, user_id), COMMITTED_SUFFIX);
    if tombstone.exists() {
        std::fs::remove_dir_all(&tombstone)
            .map_err(|e| format!("remove an earlier committed reset's state: {e}"))?;
    }
    std::fs::rename(&resetting, &tombstone)
        .map_err(|e| format!("commit the reset (rename its set-apart state): {e}"))?;
    // Past the commit point: a removal that fails is finished by the next look, never undone.
    if let Err(e) = std::fs::remove_dir_all(&tombstone) {
        log::error!(
            "[MLS_ACCOUNT] the committed reset's state could not be removed now - the next look removes it: {e}"
        );
    }
    let mut removed = 1usize;
    removed += remove_residues_of_held(data_dir, &account)?;
    // Its state is gone: until a state opens for it again it is no account a state has opened for.
    forget_account_opened_held(data_dir, user_id)?;
    forget_resets_of(&account)?;
    log::info!("[MLS_ACCOUNT] the PIN reset is committed: {removed} director(y/ies) removed");
    Ok(removed)
}

/// STEP TWO, when the server did NOT reset the PIN: the stage is undone from its journal
/// ([`undo_reset_held`]). Refused as [`commit_account_reset`] is.
pub(crate) fn rollback_account_reset(
    data_dir: &Path,
    user_id: &str,
    document: u64,
) -> Result<(), ResetRefusal> {
    if user_id.is_empty() {
        return Err("no account named".to_string().into());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let resetting = take_reset_of_this_page(data_dir, user_id, document)?;
    undo_reset_held(data_dir, &resetting)?;
    forget_resets_of(&parked_dir_name(user_id))?;
    log::warn!("[MLS_ACCOUNT] the PIN reset is rolled back: the server did not reset the PIN");
    Ok(())
}

/// A RESET A PAGE THAT IS GONE LEFT UNSETTLED, ADOPTED BY `document` to settle it from the server's
/// answer (round 9 of the review of #2919). Returns the journal's server basis - the fingerprint of
/// the account's PIN salt when the reset was staged - or `None` when the account has no unsettled
/// reset (one cut before its journal is undone here, as the settle would).
///
/// The page then asks the server: no PIN registered, or a salt whose fingerprint differs, means the
/// server reset the PIN - it COMMITS ([`commit_account_reset`]); the same salt means it did not - it
/// ROLLS BACK ([`rollback_account_reset`]). Round 8 undid every such reset, and after a reload that
/// came AFTER the server's reset the account was sent back to an old PIN that opens nothing.
/// Unanswered (offline), the reset stays ADOPTED and the account's sign-in stays refused
/// (`RESET_UNSETTLED`) - and adopting it again answers its basis again, so the next attempt of this
/// page, or the next page, asks the server again (round 10).
///
/// THIS page's own STAGED reset is not adopted beside its steps (they settle it) - unless
/// `hand_over`: those steps lost the server's answer and could not learn it from the salt either, and
/// hand the reset over to the settle that every sign-in attempt runs.
pub(crate) fn adopt_unsettled_reset(
    data_dir: &Path,
    user_id: &str,
    document: u64,
    hand_over: bool,
) -> Result<Option<String>, ResetRefusal> {
    if user_id.is_empty() {
        return Err("no account named".to_string().into());
    }
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if document != current_document() {
        return Err(ResetRefusal::new(
            RESET_NOT_THIS_PAGE,
            "the page asking is gone - nothing is adopted",
        ));
    }
    let account = parked_dir_name(user_id);
    let resetting = with_suffix(&parked_dir(data_dir, user_id), RESETTING_SUFFIX);
    if !resetting.exists() {
        log::debug!("[MLS_ACCOUNT] no unsettled PIN reset of the account");
        return Ok(None);
    }
    if reset_held_by(&account, document) == Some(ResetHeld::Staged) && !hand_over {
        // THIS page's own reset, between its stage and its settle: its own steps settle it, and a
        // second settle beside them would race them.
        log::warn!(
            "[MLS_ACCOUNT] the account's PIN reset is this page's own, still running - not adopted, its own steps settle it"
        );
        return Ok(None);
    }
    let journal = read_reset_journal(&resetting)?;
    let Some(basis) = journal.server_basis else {
        log::error!(
            "[MLS_ACCOUNT] a PIN reset was cut before its journal - the server was never asked, so it is undone, nothing deleted"
        );
        forget_resets_of(&account)?;
        undo_reset_held(data_dir, &resetting)?;
        return Ok(None);
    };
    register_reset(&account, document, ResetHeld::Adopted)?;
    log::warn!(
        "[MLS_ACCOUNT] an unsettled PIN reset is adopted by document {document}{} - the server's answer settles it",
        if hand_over { ", handed over by its own steps" } else { "" }
    );
    Ok(Some(basis))
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
        let bookkeeping = [UNPROVEN_DECLINED_FILE, UNPROVEN_COUNTER_FILE]
            .iter()
            .any(|f| name == *f || name == format!("{f}.tmp"))
            // A committed reset's state, being deleted: nobody's state any more (round 11).
            || is_committed_tombstone(&name);
        let own = name == mine
            || [PARKING_SUFFIX, UNPARKING_SUFFIX, RESETTING_SUFFIX]
                .iter()
                .any(|s| name.strip_suffix(s) == Some(mine.as_str()))
            || is_residue_of(&name, &mine);
        if !own && !bookkeeping {
            log::info!("[MLS_ACCOUNT] another account's state is on this install");
            return Ok(true);
        }
    }
    Ok(false)
}

/// The frontend's step one of the "forgot PIN" reset ([`stage_account_reset`]). The caller ends the
/// native session first, WITHOUT a sweep, and asks the server only once this succeeded.
#[tauri::command]
pub(crate) fn stage_user_mls_reset(
    app: tauri::AppHandle,
    user_id: String,
    document: u64,
    server_basis: String,
) -> Result<(), ResetRefusal> {
    log::info!("[MLS_ACCOUNT] the PIN reset sets the account's local MLS state apart");
    stage_account_reset(&app_data_dir_of(&app)?, &user_id, document, &server_basis)
}

/// The frontend's step two once the server reset the PIN ([`commit_account_reset`]).
#[tauri::command]
pub(crate) fn commit_user_mls_reset(
    app: tauri::AppHandle,
    user_id: String,
    document: u64,
) -> Result<usize, ResetRefusal> {
    commit_account_reset(&app_data_dir_of(&app)?, &user_id, document)
}

/// The frontend's step two when the server did not reset the PIN ([`rollback_account_reset`]).
#[tauri::command]
pub(crate) fn rollback_user_mls_reset(
    app: tauri::AppHandle,
    user_id: String,
    document: u64,
) -> Result<(), ResetRefusal> {
    rollback_account_reset(&app_data_dir_of(&app)?, &user_id, document)
}

/// The frontend's adoption of a reset a page that is gone left unsettled ([`adopt_unsettled_reset`]),
/// asked at the start of every sign-in flow.
#[tauri::command]
pub(crate) fn adopt_unsettled_user_mls_reset(
    app: tauri::AppHandle,
    user_id: String,
    document: u64,
    hand_over: bool,
) -> Result<Option<String>, ResetRefusal> {
    adopt_unsettled_reset(&app_data_dir_of(&app)?, &user_id, document, hand_over)
}

/// `{app_data_dir}` for a reset command, its failure typed.
fn app_data_dir_of(app: &tauri::AppHandle) -> Result<PathBuf, ResetRefusal> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}").into())
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

    /// The server's basis every staged reset of the tests names: a salt fingerprint.
    const BASIS: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

    /// What `initialiser_mls` records once a state is installed for `user`: it is an account a state
    /// has opened for here, and so one a state of unproven owner may be offered to.
    fn known(dir: &Path, user: &str) {
        let _guard = mls_bin_write_lock().lock().unwrap();
        record_account_opened_held(dir, user).unwrap();
    }

    /// An install whose opened markers exist and name nobody - no seeding from a push context.
    fn no_seed(dir: &Path) {
        std::fs::create_dir_all(dir.join(OPENED_DIR)).unwrap();
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
        known(&dir, "user-b");
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

        stage_account_reset(&dir, "user-b", 0, BASIS).unwrap();
        assert!(!parked_dir(&dir, "user-b").exists(), "set apart");
        assert_eq!(commit_account_reset(&dir, "user-b", 0).unwrap(), 1);
        assert!(!with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX).exists());
        assert_eq!(slot(&dir).unwrap(), b"state-a");
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        assert!(dir.join("channel_keys.json").exists());

        // A's own reset over A's own slot does remove it.
        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();
        assert_eq!(slot(&dir), None);
        assert_eq!(owner(&dir), None);
        commit_account_reset(&dir, "user-a", 0).unwrap();
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

        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();
        assert_eq!(slot(&dir), None);
        assert!(
            stage_account_reset(&dir, "user-a", 0, BASIS).is_err(),
            "one reset at a time"
        );
        rollback_account_reset(&dir, "user-a", 0).unwrap();

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
            rollback_account_reset(&dir, "user-a", 0).is_err(),
            "nothing staged"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUNDS 6 AND 9: a reset a previous process staged and never settled is never removed on a
    /// guess - the account's sign-in is refused until the server's answer settles it, and an answer
    /// saying the PIN was NOT reset puts it back.
    #[test]
    fn a_pin_reset_cut_before_it_settled_is_put_back() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-cut");
        sign_in_and_save(&dir, "user-a", b"state-a");
        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();
        // The process dies: the next one's document is a new one.
        set_document_for_test(1);
        assert!(
            account_state_file(&dir, "user-a").is_err(),
            "unsettled: the account's sign-in is refused"
        );
        assert!(account_state_file(&dir, "user-c").is_ok(), "no other's");

        // Its next online sign-in adopts it, and the server's salt is the one it was staged under.
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 1, false)
                .unwrap()
                .as_deref(),
            Some(BASIS)
        );
        rollback_account_reset(&dir, "user-a", 1).unwrap();

        // Undone from its journal: back in the slot it came from, its owner record with it.
        assert_eq!(
            account_state_file(&dir, "user-a").unwrap(),
            Some(dir.join("mls.bin"))
        );
        assert_eq!(slot(&dir).unwrap(), b"state-a");
        assert_eq!(owner(&dir).as_deref(), Some("user-a"));
        assert!(!with_suffix(&parked_dir(&dir, "user-a"), RESETTING_SUFFIX).exists());
        assert!(!declined_accounts(&dir)
            .unwrap()
            .contains(&parked_dir_name("user-a")));
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
        // A, on the old build: a state and no owner record. B had a session here before.
        std::fs::write(dir.join("mls.bin"), b"A's state, never recorded").unwrap();
        known(&dir, "user-b");

        // B signs in on the new build: offered the unproven state, which B's key does not open.
        assert_eq!(
            select(&dir, "user-b").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        // B forgets the PIN: the unproven state is set aside, B declines it, the server resets.
        stage_account_reset(&dir, "user-b", 0, BASIS).unwrap();
        assert_eq!(slot(&dir), None);
        commit_account_reset(&dir, "user-b", 0).unwrap();
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
        known(&dir, "user-a");
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

    /// ROUNDS 7 AND 8 (M1): a state of unproven owner - in the slot or set aside - is offered ONLY to
    /// an account a state has OPENED for on this install. A brand-new account measures none, and its
    /// sign-in sets one in the slot aside and starts fresh beside it.
    #[test]
    fn an_unproven_state_is_offered_only_to_an_account_known_here() {
        let _cold = cold();
        let dir = temp_dir("unproven-known-here");
        no_seed(&dir);
        std::fs::write(dir.join("mls.bin"), b"nobody proven").unwrap();

        assert_eq!(account_state_file(&dir, "user-c").unwrap(), None);
        assert_eq!(account_state_size(&dir, "user-c").unwrap(), 0);
        assert_eq!(
            select(&dir, "user-c").unwrap(),
            Selection::Moved {
                parked_other: false,
                unparked: false
            }
        );
        assert_eq!(slot(&dir), None, "the new account starts fresh beside it");
        let aside = unproven_residues(&dir).unwrap();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(aside[0].join("mls.bin")).unwrap(),
            b"nobody proven"
        );

        // Still not offered to a new account; offered to one known here.
        assert_eq!(account_state_file(&dir, "user-d").unwrap(), None);
        known(&dir, "user-a");
        assert_eq!(
            account_state_file(&dir, "user-a").unwrap(),
            Some(aside[0].join("mls.bin"))
        );
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        assert_eq!(slot(&dir).unwrap(), b"nobody proven");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 7 (M2 b): residue names come from a counter that only grows - a freed name is never
    /// handed out again - and a residue that opened as another identity goes back aside under the
    /// NEXT name, so the residues are offered in turn.
    #[test]
    fn unproven_residues_are_offered_in_turn_under_names_never_reused() {
        let _cold = cold();
        let dir = temp_dir("unproven-in-turn");
        known(&dir, "user-a");
        let set_aside = |bytes: &[u8]| {
            std::fs::write(dir.join("mls.bin"), bytes).unwrap();
            set_unproven_slot_aside_held(&dir, next_unproven_dir(&dir).unwrap()).unwrap()
        };
        let first = set_aside(b"X's state");
        set_aside(b"Y's state");
        std::fs::remove_dir_all(&first).unwrap();
        let third = set_aside(b"Z's state");
        assert_ne!(third, first, "a freed name is never reused");
        assert!(third.to_string_lossy().ends_with("unproven.residue-2"));

        // A is offered the earliest; it opens as another identity and goes back aside, last.
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        assert_eq!(slot(&dir).unwrap(), b"Y's state");
        return_unproven_aside_held(&dir).unwrap();
        assert_eq!(slot(&dir), None);
        let names: Vec<String> = unproven_residues(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["unproven.residue-2", "unproven.residue-3"]);

        // The next offer is the next residue.
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        assert_eq!(slot(&dir).unwrap(), b"Z's state");

        // The counter is bookkeeping, never another account's state.
        std::fs::remove_file(dir.join("mls.bin")).unwrap();
        for residue in unproven_residues(&dir).unwrap() {
            std::fs::remove_dir_all(residue).unwrap();
        }
        assert!(dir
            .join(PARKED_STATES_DIR)
            .join(UNPROVEN_COUNTER_FILE)
            .exists());
        assert!(!other_accounts_state_present(&dir, "user-a").unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 7 (M2 a): a process that dies between the stage and the server's answer leaves a journal,
    /// and the next look undoes the WHOLE stage from it - the account off the declined list, the
    /// unproven state it set aside back in the slot - with nothing remembered in memory.
    #[test]
    fn a_reset_cut_between_its_stage_and_the_server_is_undone_from_its_journal() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-journal");
        // B has a parked state; the slot holds a state no record names.
        sign_in_and_save(&dir, "user-b", b"state-b");
        select(&dir, "user-a").unwrap();
        std::fs::write(dir.join("mls.bin"), b"nobody proven").unwrap();

        stage_account_reset(&dir, "user-b", 0, BASIS).unwrap();
        let account = parked_dir_name("user-b");
        assert!(declined_accounts(&dir).unwrap().contains(&account));
        assert_eq!(slot(&dir), None);
        // The process dies before the server answers; B's next online sign-in adopts the reset and
        // the server's salt is the one it was staged under: undone, all of it.
        set_document_for_test(1);
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-b", 1, false)
                .unwrap()
                .as_deref(),
            Some(BASIS)
        );
        rollback_account_reset(&dir, "user-b", 1).unwrap();
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(parked_dir(&dir, "user-b").join("mls.bin"))
        );
        assert!(!declined_accounts(&dir).unwrap().contains(&account));
        assert_eq!(slot(&dir).unwrap(), b"nobody proven");
        assert_eq!(owner(&dir), None);
        assert!(unproven_residues(&dir).unwrap().is_empty());
        assert_eq!(
            std::fs::read(parked_dir(&dir, "user-b").join("mls.bin")).unwrap(),
            b"state-b"
        );
        assert!(!with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 7 (M2 c, L): removing an account mid-reset removes its set-apart state, cancels the
    /// reset (a late commit or rollback finds nothing staged), and prunes its declined entry - and
    /// leaves the unproven state the reset set aside, which was never its own.
    #[test]
    fn removing_an_account_mid_reset_removes_and_cancels_the_reset() {
        let _cold = cold();
        let dir = temp_dir("remove-mid-reset");
        sign_in_and_save(&dir, "user-b", b"state-b");
        select(&dir, "user-a").unwrap();
        std::fs::write(dir.join("mls.bin"), b"nobody proven").unwrap();
        stage_account_reset(&dir, "user-b", 0, BASIS).unwrap();
        let account = parked_dir_name("user-b");

        remove_account_state(&dir, "user-b").unwrap();
        assert!(!with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX).exists());
        assert!(!reset_staged_by(&account, 0));
        assert!(!declined_accounts(&dir).unwrap().contains(&account));
        assert!(rollback_account_reset(&dir, "user-b", 0).is_err());
        let aside = unproven_residues(&dir).unwrap();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(aside[0].join("mls.bin")).unwrap(),
            b"nobody proven"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 8 (M-1), THE PROPERTY: what the WebView writes before a state opens never makes an
    /// account "known". B mistypes its PIN - `resolveDeviceId` has written B's device identity into
    /// `push_context.json` - and retries: A's unproven state is still not offered to B, at the size
    /// query or at the selection.
    #[test]
    fn a_device_identity_written_before_a_state_opens_never_offers_the_unproven_state() {
        let _cold = cold();
        let dir = temp_dir("unproven-retry");
        no_seed(&dir);
        std::fs::write(dir.join("mls.bin"), b"A's state, never recorded").unwrap();
        // B's first PIN check: the device identity is resolved and mirrored natively.
        std::fs::write(
            dir.join(crate::commands::push::PUSH_CONTEXT_FILE),
            r#"{"userId":"user-b","deviceId":"device-b"}"#,
        )
        .unwrap();
        // The retry.
        assert_eq!(account_state_size(&dir, "user-b").unwrap(), 0);
        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
        assert!(matches!(
            select(&dir, "user-b").unwrap(),
            Selection::Moved { .. }
        ));
        assert_eq!(slot(&dir), None);
        assert_eq!(unproven_residues(&dir).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 8 (M-1): an install upgraded from before the owner record is SEEDED once - the account
    /// the push context names is offered the slot's state, nobody else; and a marker written by an
    /// account's install, removed with its state.
    #[test]
    fn an_upgraded_install_offers_its_state_to_the_account_its_push_context_names() {
        let _cold = cold();
        let dir = temp_dir("unproven-seed");
        std::fs::write(dir.join("mls.bin"), b"A's state, never recorded").unwrap();
        std::fs::write(
            dir.join(crate::commands::push::PUSH_CONTEXT_FILE),
            r#"{"userId":"user-a","deviceId":"device-a"}"#,
        )
        .unwrap();
        seed_opened_markers(&dir);
        // B resolving its identity afterwards does not move the seed.
        std::fs::write(
            dir.join(crate::commands::push::PUSH_CONTEXT_FILE),
            r#"{"userId":"user-b","deviceId":"device-b"}"#,
        )
        .unwrap();
        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
        assert_eq!(
            account_state_file(&dir, "user-a").unwrap(),
            Some(dir.join("mls.bin"))
        );

        // A marker goes with its account's state.
        known(&dir, "user-c");
        remove_account_state(&dir, "user-c").unwrap();
        let _guard = mls_bin_write_lock().lock().unwrap();
        assert!(!account_known_here_held(&dir, "user-c").unwrap());
        drop(_guard);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUNDS 8 AND 9 (M-3, item 2): a reload AFTER THE SERVER RESET THE PIN - the new page adopts
    /// the reset, the server's salt is gone or another, and it COMMITS: the account starts fresh,
    /// never sent back to an old PIN that opens nothing. Then a new stage of it runs as any other.
    #[test]
    fn a_reset_whose_page_reloaded_after_the_server_reset_is_committed() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-reload-reset");
        sign_in_and_save(&dir, "user-a", b"state-a");
        known(&dir, "user-a");
        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();

        set_document_for_test(1);
        assert!(account_state_file(&dir, "user-a").is_err(), "unsettled");
        assert!(stage_account_reset(&dir, "user-a", 1, BASIS).is_err());
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 1, false)
                .unwrap()
                .as_deref(),
            Some(BASIS)
        );
        commit_account_reset(&dir, "user-a", 1).unwrap();
        assert_eq!(slot(&dir), None);
        assert_eq!(account_state_file(&dir, "user-a").unwrap(), None);
        {
            let _guard = mls_bin_write_lock().lock().unwrap();
            assert!(!account_known_here_held(&dir, "user-a").unwrap());
        }
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 1, false).unwrap(),
            None
        );
        stage_account_reset(&dir, "user-a", 1, BASIS).unwrap();
        commit_account_reset(&dir, "user-a", 1).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 9 (item 1): a step of a page that is gone acts on nothing, and says so as a TYPE - its
    /// late commit after the reset was settled, its rollback, its stage still running across the
    /// navigation, and a commit with nothing set apart.
    #[test]
    fn a_page_that_is_gone_settles_nothing() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-stale-page");
        sign_in_and_save(&dir, "user-a", b"state-a");
        known(&dir, "user-a");
        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();

        // The page reloads. BEFORE anyone adopts the reset (round 10, the gap): the old page's steps
        // are refused on the document alone - the registry still names it - and the state stays
        // set apart, so only the document check can be what refused them.
        set_document_for_test(1);
        assert_eq!(
            commit_account_reset(&dir, "user-a", 0).unwrap_err().code,
            RESET_NOT_THIS_PAGE
        );
        assert_eq!(
            rollback_account_reset(&dir, "user-a", 0).unwrap_err().code,
            RESET_NOT_THIS_PAGE
        );
        assert_eq!(slot(&dir), None, "still set apart");
        assert!(with_suffix(&parked_dir(&dir, "user-a"), RESETTING_SUFFIX).exists());

        // The new page settles the reset (the server did not reset the PIN).
        adopt_unsettled_reset(&dir, "user-a", 1, false).unwrap();
        rollback_account_reset(&dir, "user-a", 1).unwrap();
        assert_eq!(slot(&dir).unwrap(), b"state-a");

        // The old page's late commit lands: refused, and the restored state, its residue and its
        // marker are untouched.
        let late = commit_account_reset(&dir, "user-a", 0).unwrap_err();
        assert_eq!(late.code, RESET_NOT_THIS_PAGE);
        assert_eq!(
            rollback_account_reset(&dir, "user-a", 0).unwrap_err().code,
            RESET_NOT_THIS_PAGE
        );
        assert_eq!(slot(&dir).unwrap(), b"state-a");
        {
            let _guard = mls_bin_write_lock().lock().unwrap();
            assert!(account_known_here_held(&dir, "user-a").unwrap());
        }

        // A stage asked by the old page, landing after the navigation: nothing is set apart.
        assert_eq!(
            stage_account_reset(&dir, "user-a", 0, BASIS)
                .unwrap_err()
                .code,
            RESET_NOT_THIS_PAGE
        );
        assert_eq!(slot(&dir).unwrap(), b"state-a");

        // A commit of this page with nothing set apart is refused too, never answered Ok.
        stage_account_reset(&dir, "user-a", 1, BASIS).unwrap();
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 1, false).unwrap(),
            None,
            "this page's own running reset is never adopted beside its own steps"
        );
        std::fs::remove_dir_all(with_suffix(&parked_dir(&dir, "user-a"), RESETTING_SUFFIX))
            .unwrap();
        assert_eq!(
            commit_account_reset(&dir, "user-a", 1).unwrap_err().code,
            RESET_NOTHING_SET_APART
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 11 (N1): A COMMIT CUT AFTER ITS COMMIT POINT IS NEVER UNDONE. The commit renames the
    /// set-apart state to `<hash>.committed` before removing anything; a process that dies while the
    /// removal has taken the journal but not yet `mls.bin` leaves a tombstone, which the next look
    /// REMOVES - the old-PIN state is never unparked under a PIN the server already reset.
    #[test]
    fn a_commit_cut_after_its_journal_went_is_never_undone() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-cut-commit");
        sign_in_and_save(&dir, "user-a", b"old-pin state");
        known(&dir, "user-a");
        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();
        let resetting = with_suffix(&parked_dir(&dir, "user-a"), RESETTING_SUFFIX);
        let tombstone = with_suffix(&parked_dir(&dir, "user-a"), COMMITTED_SUFFIX);
        assert!(
            resetting.join("mls.bin").exists(),
            "the stage set the state apart"
        );

        // The commit, cut: past its rename, the removal took the journal and died before `mls.bin`.
        std::fs::rename(&resetting, &tombstone).unwrap();
        std::fs::remove_file(tombstone.join(RESET_JOURNAL_FILE)).unwrap();

        assert!(
            !other_accounts_state_present(&dir, "user-b").unwrap(),
            "a tombstone is nobody's state"
        );

        // A new process, a new page: the next look finishes the removal and undoes nothing.
        set_document_for_test(1);
        assert_eq!(account_state_file(&dir, "user-a").unwrap(), None);
        assert!(!tombstone.exists(), "the tombstone is removed");
        assert!(!resetting.exists());
        assert!(!parked_dir(&dir, "user-a").exists(), "nothing was unparked");
        assert_eq!(slot(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 12: the settle deletes a tombstone only of the EXACT shape `<account hash>.committed` -
    /// anything else ending the same way is left untouched, its content intact.
    #[test]
    fn only_an_account_hash_tombstone_is_deleted() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-tombstone-allowlist");
        let root = dir.join(PARKED_STATES_DIR);
        let real = root.join(format!("{}{COMMITTED_SUFFIX}", parked_dir_name("user-a")));
        // One hex digit short: not an account's hash (no case variant - the host may fold case).
        let short = root.join(format!(
            "{}{COMMITTED_SUFFIX}",
            &parked_dir_name("user-a")[1..]
        ));
        let foo = root.join(format!("foo{COMMITTED_SUFFIX}"));
        for d in [&real, &short, &foo] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("mls.bin"), b"kept?").unwrap();
        }
        assert!(is_committed_tombstone(
            &real.file_name().unwrap().to_string_lossy()
        ));
        assert!(!is_committed_tombstone(&format!(
            "{}{COMMITTED_SUFFIX}",
            parked_dir_name("user-a").to_uppercase()
        )));
        assert_eq!(account_state_file(&dir, "user-b").unwrap(), None);
        assert!(!real.exists(), "the account's tombstone is removed");
        assert_eq!(std::fs::read(foo.join("mls.bin")).unwrap(), b"kept?");
        assert_eq!(std::fs::read(short.join("mls.bin")).unwrap(), b"kept?");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 11 (N1): the registry entry is forgotten only once the step SUCCEEDED - a commit
    /// refused for want of a set-apart state leaves nothing behind, and a successful one forgets.
    #[test]
    fn a_committed_reset_leaves_no_entry_and_no_tombstone() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-commit-clean");
        sign_in_and_save(&dir, "user-a", b"state-a");
        known(&dir, "user-a");
        set_document_for_test(2);
        stage_account_reset(&dir, "user-a", 2, BASIS).unwrap();
        commit_account_reset(&dir, "user-a", 2).unwrap();
        assert!(!with_suffix(&parked_dir(&dir, "user-a"), COMMITTED_SUFFIX).exists());
        assert!(!reset_staged_by(&parked_dir_name("user-a"), 2));
        assert_eq!(
            commit_account_reset(&dir, "user-a", 2).unwrap_err().code,
            RESET_NOT_THIS_PAGE
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 10 (F2, F3): OFFLINE, THEN ONLINE, IN THE SAME PAGE. The sign-in meets the unsettled
    /// reset as its own TYPE, both where the login measures the state and where it selects it; the
    /// settle that got no answer leaves the reset ADOPTED, and adopting it again answers its basis
    /// again - so the retry online asks the server, settles, and the sign-in succeeds.
    #[test]
    fn an_unanswered_settle_is_asked_again_and_the_sign_in_then_succeeds() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-offline-online");
        sign_in_and_save(&dir, "user-a", b"state-a");
        known(&dir, "user-a");
        stage_account_reset(&dir, "user-a", 0, BASIS).unwrap();
        set_document_for_test(1);

        // Offline: the adopt answers the basis, the server does not answer, nothing is settled.
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 1, false)
                .unwrap()
                .as_deref(),
            Some(BASIS)
        );
        {
            let _guard = mls_bin_write_lock().lock().unwrap();
            assert!(matches!(
                account_state_file_held(&dir, "user-a"),
                Err(SelectionRefused::ResetUnsettled(_))
            ));
        }
        assert!(matches!(
            select_account_state(&dir, "user-a"),
            Err(SelectionRefused::ResetUnsettled(_))
        ));
        assert!(
            mls_core::StateLoadRefusal::from(SelectionRefused::ResetUnsettled(String::new()))
                .is_reset_unsettled()
        );

        // Online, the same page: the retry adopts it again, the salt is the same, it rolls back.
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 1, false)
                .unwrap()
                .as_deref(),
            Some(BASIS),
            "an adopted reset answers its basis again"
        );
        rollback_account_reset(&dir, "user-a", 1).unwrap();
        assert_eq!(select(&dir, "user-a").unwrap(), Selection::AlreadyInSlot);
        assert_eq!(slot(&dir).unwrap(), b"state-a");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 10 (F2): this page's own STAGED reset is adopted only when its steps HAND IT OVER - they
    /// lost the server's answer and could not learn it from the salt.
    #[test]
    fn a_staged_reset_is_adopted_only_when_its_steps_hand_it_over() {
        let _cold = cold();
        let dir = temp_dir("pin-reset-hand-over");
        sign_in_and_save(&dir, "user-a", b"state-a");
        known(&dir, "user-a");
        set_document_for_test(3);
        stage_account_reset(&dir, "user-a", 3, BASIS).unwrap();
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 3, false).unwrap(),
            None
        );
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 3, true)
                .unwrap()
                .as_deref(),
            Some(BASIS)
        );
        assert_eq!(
            adopt_unsettled_reset(&dir, "user-a", 3, false)
                .unwrap()
                .as_deref(),
            Some(BASIS),
            "handed over, it is adopted: the next attempt asks again"
        );
        commit_account_reset(&dir, "user-a", 3).unwrap();
        assert_eq!(slot(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUNDS 9 AND 10 (items 1 and F4): THE WIRING. The reset registry READS the document generation
    /// `page_ring` keeps (never claims it); a page CLAIMS it through the command `lib.rs` registers,
    /// and a dead web content process moves it on - never the page-load event, which can run after
    /// the new page's first native call on Android; and the opened markers are seeded at start-up,
    /// before the WebView exists. Removing any of these lines from `lib.rs` fails this test.
    #[test]
    fn the_document_claim_and_the_start_up_seed_are_wired() {
        let lib = include_str!("../lib.rs");
        let handler = &lib[lib.find(".invoke_handler(").expect("invoke_handler")..];
        assert!(handler.contains("page_ring::page_ring_document,"));
        assert!(
            !lib.contains("page_ring::forget_on_page_load"),
            "the page-load event moves no generation"
        );
        assert!(lib.contains("page_ring::forget_on_web_content_terminated();"));
        let setup = &lib[lib.find(".setup(move |app|").expect("setup")..];
        let seed = setup
            .find("commands::mls_account_state::seed_opened_markers(&data_dir);")
            .expect("the start-up seed is wired");
        assert!(
            seed < setup.find("sqlx::sqlite::SqlitePoolOptions").unwrap(),
            "seeded at the start of setup"
        );
        let this = include_str!("mls_account_state.rs");
        assert!(this.contains("        crate::page_ring::current_page_document()\n"));
    }

    /// ROUND 8 (L-1): an empty or malformed counter is no refusal - the next name is taken above the
    /// names on disk, a cut park among them.
    #[test]
    fn a_damaged_counter_falls_back_to_the_names_on_disk() {
        let _cold = cold();
        let dir = temp_dir("unproven-counter");
        let root = dir.join(PARKED_STATES_DIR);
        std::fs::create_dir_all(root.join("unproven.residue-4")).unwrap();
        std::fs::create_dir_all(root.join("unproven.residue-6.parking")).unwrap();
        for damaged in ["", "not a number"] {
            std::fs::write(root.join(UNPROVEN_COUNTER_FILE), damaged).unwrap();
            let next = next_unproven_dir(&dir).unwrap();
            assert!(next.ends_with("unproven.residue-7"), "{next:?}");
        }
        assert_eq!(
            std::fs::read_to_string(root.join(UNPROVEN_COUNTER_FILE)).unwrap(),
            "8"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 8 (L-2): a file left over when an unproven state goes back into the slot is set aside
    /// under the counter's next name - never a freed one.
    #[test]
    fn a_leftover_of_an_unproven_state_takes_the_counters_next_name() {
        let _cold = cold();
        let dir = temp_dir("unproven-leftover");
        known(&dir, "user-a");
        std::fs::write(dir.join("mls.bin"), b"X's state").unwrap();
        let aside = set_unproven_slot_aside_held(&dir, next_unproven_dir(&dir).unwrap()).unwrap();
        std::fs::write(aside.join("unlisted.bin"), b"?").unwrap();
        assert_eq!(
            select(&dir, "user-a").unwrap(),
            Selection::UnprovenLeftInSlot
        );
        let names: Vec<String> = unproven_residues(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            ["unproven.residue-1"],
            "the freed residue-0 is not taken again"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 8 (L-4, L-6): a set-aside or a bringing-back cut half-way is FINISHED by the next look -
    /// `mls.bin` never stays on one side and its ledger on the other.
    #[test]
    fn an_unproven_move_cut_half_way_is_finished_whole() {
        let _cold = cold();
        let dir = temp_dir("unproven-cut");
        let root = dir.join(PARKED_STATES_DIR);
        std::fs::create_dir_all(&root).unwrap();
        // A set-aside cut after `mls.bin` moved, before its ledger did.
        let staging = root.join("unproven.residue-0.parking");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("mls.bin"), b"X's state").unwrap();
        std::fs::write(dir.join("background_stages.json"), b"X's stages").unwrap();
        assert_eq!(account_state_file(&dir, "user-z").unwrap(), None);
        let aside = root.join("unproven.residue-0");
        assert_eq!(std::fs::read(aside.join("mls.bin")).unwrap(), b"X's state");
        assert_eq!(
            std::fs::read(aside.join("background_stages.json")).unwrap(),
            b"X's stages"
        );
        assert!(!dir.join("background_stages.json").exists());

        // A bringing-back cut after `mls.bin` moved into the slot, before its ledger did.
        std::fs::rename(&aside, root.join("unproven.unparking")).unwrap();
        std::fs::rename(
            root.join("unproven.unparking").join("mls.bin"),
            dir.join("mls.bin"),
        )
        .unwrap();
        assert_eq!(account_state_file(&dir, "user-z").unwrap(), None);
        assert_eq!(slot(&dir).unwrap(), b"X's state");
        assert_eq!(
            std::fs::read(dir.join("background_stages.json")).unwrap(),
            b"X's stages"
        );
        assert!(!root.join("unproven.unparking").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUNDS 8 AND 9 (L-6, item 6): the stage cut at each of its steps is undone whole - before its
    /// journal, between the set-aside and the declined list (with B already declined, and not), and in
    /// the middle of the undo.
    #[test]
    fn a_reset_cut_at_any_step_is_undone_whole() {
        let _cold = cold();
        let account = parked_dir_name("user-b");
        // A cut stage with its journal down: the process died, the next one adopts the reset at B's
        // sign-in, and the server's salt is the one it was staged under - the PIN was not reset.
        let settle_unreset = |dir: &Path| {
            set_document_for_test(1);
            assert!(account_state_file(dir, "user-b").is_err(), "unsettled");
            assert_eq!(
                adopt_unsettled_reset(dir, "user-b", 1, false)
                    .unwrap()
                    .as_deref(),
                Some(BASIS)
            );
            rollback_account_reset(dir, "user-b", 1).unwrap();
            set_document_for_test(0);
        };
        let journal = |declined_added: bool| ResetJournal {
            from_slot: false,
            declined_added,
            unproven: Some("unproven.residue-0".to_string()),
            server_basis: Some(BASIS.to_string()),
        };

        // 1. Cut before the journal: B's state set apart, nothing else done - and AS INTENDED, undone
        //    by the next look without waiting for any server: the stage answers the page only once its
        //    journal is down, so with none the server was never asked. B's state goes to its parked
        //    place (no journal says it came from the slot; B's next sign-in unparks it), and the
        //    slot's unproven state, not yet set aside, stays where it is.
        let dir = temp_dir("pin-reset-cut-no-journal");
        std::fs::write(dir.join("mls.bin"), b"nobody proven").unwrap();
        let resetting = with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX);
        std::fs::create_dir_all(&resetting).unwrap();
        std::fs::write(resetting.join("mls.bin"), b"state-b").unwrap();
        assert_eq!(
            account_state_file(&dir, "user-b").unwrap(),
            Some(parked_dir(&dir, "user-b").join("mls.bin"))
        );
        assert!(!resetting.exists());
        assert_eq!(slot(&dir).unwrap(), b"nobody proven");
        assert!(unproven_residues(&dir).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();

        // 2. Cut between the set-aside and the declined list, B ALREADY DECLINED by an earlier reset:
        //    the journal says this stage added nothing, so the undo leaves B declined.
        let dir = temp_dir("pin-reset-cut-before-decline");
        write_declined_accounts(&dir, std::slice::from_ref(&account)).unwrap();
        let resetting = with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX);
        std::fs::create_dir_all(&resetting).unwrap();
        std::fs::write(resetting.join("mls.bin"), b"state-b").unwrap();
        write_reset_journal(&resetting, &journal(false)).unwrap();
        let aside = dir.join(PARKED_STATES_DIR).join("unproven.residue-0");
        std::fs::create_dir_all(&aside).unwrap();
        std::fs::write(aside.join("mls.bin"), b"nobody proven").unwrap();
        settle_unreset(&dir);
        assert_eq!(slot(&dir).unwrap(), b"nobody proven");
        assert!(
            declined_accounts(&dir).unwrap().contains(&account),
            "declined before the stage, declined after its undo"
        );
        assert_eq!(
            std::fs::read(parked_dir(&dir, "user-b").join("mls.bin")).unwrap(),
            b"state-b"
        );
        std::fs::remove_dir_all(&dir).ok();

        //    The same cut with B not declined before: the journal names the entry the stage was about
        //    to write, the undo's removal of it is a no-op, and B ends undeclined.
        let dir = temp_dir("pin-reset-cut-before-decline-new");
        let resetting = with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX);
        std::fs::create_dir_all(&resetting).unwrap();
        std::fs::write(resetting.join("mls.bin"), b"state-b").unwrap();
        write_reset_journal(&resetting, &journal(true)).unwrap();
        let aside = dir.join(PARKED_STATES_DIR).join("unproven.residue-0");
        std::fs::create_dir_all(&aside).unwrap();
        std::fs::write(aside.join("mls.bin"), b"nobody proven").unwrap();
        settle_unreset(&dir);
        assert_eq!(slot(&dir).unwrap(), b"nobody proven");
        assert!(!declined_accounts(&dir).unwrap().contains(&account));
        std::fs::remove_dir_all(&dir).ok();

        // 3. Cut in the middle of the undo: the unproven state half back in the slot, B on the
        //    declined list, the journal still there. The next look finishes the move whole, and the
        //    settle the undo.
        let dir = temp_dir("pin-reset-cut-mid-undo");
        let resetting = with_suffix(&parked_dir(&dir, "user-b"), RESETTING_SUFFIX);
        std::fs::create_dir_all(&resetting).unwrap();
        std::fs::write(resetting.join("mls.bin"), b"state-b").unwrap();
        write_reset_journal(&resetting, &journal(true)).unwrap();
        write_declined_accounts(&dir, std::slice::from_ref(&account)).unwrap();
        let unparking = dir.join(PARKED_STATES_DIR).join("unproven.unparking");
        std::fs::create_dir_all(&unparking).unwrap();
        std::fs::write(unparking.join("background_stages.json"), b"X's stages").unwrap();
        std::fs::write(dir.join("mls.bin"), b"nobody proven").unwrap();
        settle_unreset(&dir);
        assert_eq!(slot(&dir).unwrap(), b"nobody proven");
        assert_eq!(
            std::fs::read(dir.join("background_stages.json")).unwrap(),
            b"X's stages"
        );
        assert!(!declined_accounts(&dir).unwrap().contains(&account));
        assert!(!resetting.exists());
        assert_eq!(
            std::fs::read(parked_dir(&dir, "user-b").join("mls.bin")).unwrap(),
            b"state-b"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ROUND 9 (item 4): an account whose own state turns out EMPTY is no longer one a state has
    /// opened for - it is not offered a state of unproven owner, another account's, on the strength
    /// of a state it no longer has.
    #[test]
    fn an_account_whose_own_state_is_empty_is_no_longer_known() {
        let _cold = cold();
        let dir = temp_dir("known-empty-own");
        no_seed(&dir);
        known(&dir, "user-a");
        // A's parked state is empty - a write cut at its start.
        std::fs::create_dir_all(parked_dir(&dir, "user-a")).unwrap();
        std::fs::write(parked_dir(&dir, "user-a").join("mls.bin"), b"").unwrap();
        assert_eq!(account_state_size(&dir, "user-a").unwrap(), 0);
        {
            let _guard = mls_bin_write_lock().lock().unwrap();
            assert!(!account_known_here_held(&dir, "user-a").unwrap());
        }

        // The same through the selection, for an empty slot its record names; then a state of
        // unproven owner set aside is not offered to it.
        known(&dir, "user-a");
        std::fs::remove_dir_all(parked_dir(&dir, "user-a")).unwrap();
        sign_in_and_save(&dir, "user-a", b"");
        select(&dir, "user-a").unwrap();
        {
            let _guard = mls_bin_write_lock().lock().unwrap();
            assert!(!account_known_here_held(&dir, "user-a").unwrap());
        }
        for name in ["mls.bin", MLS_STATE_OWNER_FILE] {
            std::fs::remove_file(dir.join(name)).unwrap();
        }
        let aside = dir.join(PARKED_STATES_DIR).join("unproven.residue-0");
        std::fs::create_dir_all(&aside).unwrap();
        std::fs::write(aside.join("mls.bin"), b"B's state, never recorded").unwrap();
        assert_eq!(account_state_file(&dir, "user-a").unwrap(), None);
        assert!(matches!(
            select(&dir, "user-a").unwrap(),
            Selection::Moved { .. }
        ));
        assert_eq!(slot(&dir), None, "not brought into the slot");
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
        set_unproven_slot_aside_held(&dir2, next_unproven_dir(&dir2).unwrap()).unwrap();
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
