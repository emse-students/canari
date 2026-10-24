//! A shut phone joins a community salon's key group from the PUSH (channel-encryption section 26,
//! decided by the user 2026-10-22: "Oui, rejoindre au push").
//!
//! A member whose phone never LOADED a community holds no seat in its key group, so every salon push
//! reaches it sealed to a seed it can never open - until the app is next opened. A DM newcomer is not
//! in that position: it is Welcomed and its phone processes the Welcome with the app shut. This module
//! is the native half of giving the salon the same property: when a salon push names a key group this
//! device does not hold, the push service makes the SAME external commit the app makes on load,
//! through the SAME server gate (`isEntitledToDistributionGroup`), and persists it.
//!
//! Three pieces, each with one job:
//!
//! - **The ledger** (`key_group_push_joins.json`) - ONE JOIN PER DEVICE PER GROUP, from durable state
//!   and never from a clock. An attempt is CLAIMED before anything is fetched and SETTLED after; a
//!   group whose last attempt was refused, lost or never settled (the process died inside it) is not
//!   attempted again from a push. A group whose prepare - the expensive step - failed on a base is
//!   DEFERRED with that base's epoch, and tried again only for a different base. The app clears the ledger at its next start ([`take_all`]), because
//!   from then on its own join owns the group. A server sending pushes for many groups cannot make the
//!   phone commit more than once per group, nor grow the file past [`LEDGER_CAPACITY`].
//! - **The prepare** ([`prepare_key_group_join`]) - builds the external commit and the base it
//!   creates against the state the caller LOADED, and stages the sealed post-join state beside
//!   `mls.bin` with the digest of what was loaded. Nothing is written to `mls.bin` before the server
//!   accepts: an external commit cannot be cleared, so an unaccepted one must leave no trace.
//! - **The finish** ([`finish_key_group_join`]) - installs the staged state only over the very file it
//!   was built from, and never in a warm process (a compare-and-swap,
//!   [`background_write_mls_bin_if_unchanged_and_cold`]).
//!
//! Android only today: the iOS notification extension reads a MIRROR of `mls.bin` in the App Group
//! and never writes the app's state, so a join made there would put a leaf in the tree whose secrets
//! no process keeps. The extension shows the generic banner and the app joins at its next foreground.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use mls_core::MlsManager;

use crate::concurrency::{
    background_write_mls_bin_if_unchanged_and_cold, foreground_is_active, live_manager_in_process,
    mls_bin_digest,
};
use crate::native_cache::{exclude_from_backup, open_file, seal_file, CacheKey, Opened, Purpose};

/// The ledger of joins attempted from a push, in the app data directory. SEALED at rest under the
/// install's native cache key ([`Purpose::KeyGroupJoinLedger`]): it names key groups, their state and
/// the salon scope the server answered - metadata the app's own stores seal - in a file the push
/// service must read and write with the app shut. No key, no ledger: a claim is refused rather than
/// written in the clear. The sign-out sweep removes it with `mls.bin`.
pub const LEDGER_FILE: &str = crate::commands::storage::KEY_GROUP_PUSH_JOIN_LEDGER_FILE;
/// The OS lock that orders every ledger edit - the push lane and the app's take alike.
const LEDGER_LOCK_FILE: &str = "key_group_push_joins.lock";
/// The sealed post-join state, waiting for the server's answer: `digest (32) || sealed state`.
/// Sealed under the device key like `mls.bin` itself, and removed with it at sign-out.
pub const STAGED_STATE_FILE: &str = crate::commands::storage::STAGED_KEY_GROUP_JOIN_FILE;
/// The most groups the ledger names. A capacity, not a clock: a full ledger refuses new attempts
/// until the app takes it, and says so.
pub const LEDGER_CAPACITY: usize = 64;

/// What a claim answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    /// No earlier attempt: the caller may go on, and the group is now `attempting`.
    Granted,
    /// The last prepare failed on the base at this epoch: the caller may go on, and must not
    /// prepare again on a base at the same epoch ([`Settlement::Deferred`]).
    GrantedUnlessBaseAt(u64),
    /// An earlier attempt stands in the ledger, in this state - not attempted again from a push.
    AlreadyAttempted(String),
    /// The ledger names [`LEDGER_CAPACITY`] groups already.
    LedgerFull,
}

/// How an attempt ended, as the ledger records it.
#[derive(Debug, PartialEq, Eq)]
pub enum Settlement {
    /// Accepted by the server and installed: the scope the server named, for the app's registry.
    Joined {
        scope_kind: String,
        scope_id: String,
    },
    /// Refused for a reason no later push can change (not entitled, an inconsistent push).
    Refused(String),
    /// Accepted by the server and NOT installed - the leaf is in the tree and its secrets are gone.
    /// The app's own join at its next start repairs it (an external commit replaces a leaf carrying
    /// the same signature key); a push must not try again before then.
    Lost(String),
    /// Nothing was decided (no base yet, a Welcome on its way, the gate unanswered, a race): the
    /// entry is removed, so a later push may try again.
    Retryable(String),
    /// The prepare - seconds of loading and building on the push lane - failed on the base served
    /// at `base_epoch`. Kept, so a later push prepares again only once the server serves ANOTHER
    /// base: the same base would fail the same way, on every salon push.
    Deferred { reason: String, base_epoch: u64 },
}

/// Runs `edit` on the ledger map under the ledger's OS lock, writing it back SEALED, by rename, when
/// `edit` says it changed. An absent ledger reads as empty; one that does not open under `key`, or
/// does not parse, reads as empty too and is said at error level - it can only be damage, since the
/// key never rotates and no build ever wrote this file in the clear.
fn with_ledger<R>(
    data_dir: &Path,
    key: &CacheKey,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> (R, bool),
) -> Result<R, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join(LEDGER_LOCK_FILE))
        .map_err(|e| format!("open {LEDGER_LOCK_FILE}: {e}"))?;
    // Released when `lock` is dropped, on every return path.
    crate::commands::push::lock_exclusive(&lock)
        .map_err(|e| format!("lock {LEDGER_LOCK_FILE}: {e}"))?;
    let path = data_dir.join(LEDGER_FILE);
    let mut map = match std::fs::read(&path) {
        Ok(bytes) => read_ledger(key, &bytes).unwrap_or_else(|why| {
            log::error!("[KG_PUSH_JOIN] ledger unreadable ({why}) - read as empty");
            serde_json::Map::new()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("read {LEDGER_FILE}: {e}")),
    };
    let (result, changed) = edit(&mut map);
    if changed {
        let plain = serde_json::Value::Object(map).to_string();
        let sealed = seal_file(key, Purpose::KeyGroupJoinLedger, plain.as_bytes());
        let tmp = data_dir.join(format!("{LEDGER_FILE}.tmp"));
        std::fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        // A new inode: the backup exclusion does not travel with the name.
        exclude_from_backup(&path);
    }
    Ok(result)
}

/// Opens and parses the ledger's bytes. Only the sealed envelope is a ledger: this file never
/// existed in the clear in any shipped build, so there is no older format to read.
fn read_ledger(
    key: &CacheKey,
    bytes: &[u8],
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let plain = match open_file(key, Purpose::KeyGroupJoinLedger, bytes) {
        Ok(Opened::Sealed(plain)) => plain,
        Ok(Opened::Plaintext(_)) => return Err("not sealed".into()),
        Err(e) => return Err(e.to_string()),
    };
    match serde_json::from_slice::<serde_json::Value>(&plain) {
        Ok(serde_json::Value::Object(m)) => Ok(m),
        Ok(_) => Err("not an object".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Claims one attempt at `group_id`: [`Claim::Granted`] writes it `attempting` BEFORE anything is
/// fetched, so a process that dies inside the attempt leaves a claim no later push will repeat.
pub fn claim(data_dir: &Path, key: &CacheKey, group_id: &str) -> Result<Claim, String> {
    with_ledger(data_dir, key, |map| {
        if let Some(entry) = map.get(group_id) {
            let state = entry
                .get("state")
                .and_then(|s| s.as_str())
                .unwrap_or("unreadable")
                .to_string();
            let deferred_at = entry.get("baseEpoch").and_then(|e| e.as_u64());
            if let ("deferred", Some(epoch)) = (state.as_str(), deferred_at) {
                // Claimed again, the deferral kept: a process dying in this attempt leaves it
                // `attempting`, which no push repeats.
                map.insert(
                    group_id.to_string(),
                    serde_json::json!({ "state": "attempting", "deferredAt": epoch }),
                );
                return (Claim::GrantedUnlessBaseAt(epoch), true);
            }
            return (Claim::AlreadyAttempted(state), false);
        }
        if map.len() >= LEDGER_CAPACITY {
            return (Claim::LedgerFull, false);
        }
        map.insert(
            group_id.to_string(),
            serde_json::json!({ "state": "attempting" }),
        );
        (Claim::Granted, true)
    })
}

/// Records how the attempt at `group_id` ended - see [`Settlement`].
pub fn settle(
    data_dir: &Path,
    key: &CacheKey,
    group_id: &str,
    settlement: &Settlement,
) -> Result<(), String> {
    with_ledger(data_dir, key, |map| {
        let entry = match settlement {
            Settlement::Joined {
                scope_kind,
                scope_id,
            } => {
                serde_json::json!({ "state": "joined", "scopeKind": scope_kind, "scopeId": scope_id })
            }
            Settlement::Refused(reason) => {
                serde_json::json!({ "state": "refused", "reason": reason })
            }
            Settlement::Lost(reason) => serde_json::json!({ "state": "lost", "reason": reason }),
            Settlement::Deferred { reason, base_epoch } => {
                serde_json::json!({ "state": "deferred", "reason": reason, "baseEpoch": base_epoch })
            }
            Settlement::Retryable(_) => {
                let removed = map.remove(group_id).is_some();
                return ((), removed);
            }
        };
        map.insert(group_id.to_string(), entry);
        ((), true)
    })
}

/// One ledger entry as the app takes it.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TakenJoin {
    pub group_id: String,
    pub state: String,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    pub reason: Option<String>,
}

/// Takes the whole ledger and deletes it: from now on the app's own join owns every group in it.
/// Called by the app at start-up, before the drain (`take_key_group_push_joins`).
pub fn take_all(data_dir: &Path, key: &CacheKey) -> Result<Vec<TakenJoin>, String> {
    let taken = with_ledger(data_dir, key, |map| {
        let mut out = Vec::with_capacity(map.len());
        for (group_id, entry) in map.iter() {
            let field = |k: &str| entry.get(k).and_then(|v| v.as_str()).map(str::to_string);
            out.push(TakenJoin {
                group_id: group_id.clone(),
                state: field("state").unwrap_or_else(|| "unreadable".into()),
                scope_kind: field("scopeKind"),
                scope_id: field("scopeId"),
                reason: field("reason"),
            });
        }
        let had = !map.is_empty();
        map.clear();
        (out, had)
    })?;
    // A staged state outliving its attempt is a join that never finished: it is never installed.
    match std::fs::remove_file(data_dir.join(STAGED_STATE_FILE)) {
        Ok(()) => log::warn!(
            "[KG_PUSH_JOIN] a staged join state was left behind by an attempt that never settled - deleted, never installed"
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[KG_PUSH_JOIN] staged join state not deleted: {e}"),
    }
    Ok(taken)
}

/// What a prepare refusal does to the ledger.
#[derive(Clone, Copy)]
enum Refusal {
    /// Cheap, and about this moment (the foreground runs): [`Settlement::Retryable`].
    Retry,
    /// Reached after the expensive load or build, and about THIS base:
    /// [`Settlement::Deferred`] until the server serves another one.
    Defer,
    /// No later push can make it true (an inconsistent push): [`Settlement::Refused`].
    Terminal,
}

/// Why a prepare stopped, as the token the Kotlin caller branches on - never prose. `terminal` and
/// `deferrable` carry the [`Refusal`] kind.
fn refusal(reason: &str, kind: Refusal) -> serde_json::Value {
    let terminal = matches!(kind, Refusal::Terminal);
    let deferrable = matches!(kind, Refusal::Defer);
    log::warn!(
        "[KG_PUSH_JOIN] prepare refused reason={reason} terminal={terminal} deferrable={deferrable}"
    );
    serde_json::json!({ "ok": false, "reason": reason, "terminal": terminal, "deferrable": deferrable })
}

/// The inputs of one prepare, as the push service read them.
pub struct JoinInputs<'a> {
    /// The key group the push names (`seedGroupId`).
    pub group_id: &'a str,
    /// The base the server served (`mls/push/key-group-base`), base64.
    pub group_info_b64: &'a str,
    /// The epoch the server says that base is at.
    pub base_epoch: u64,
    /// The seed frame the salon push carries (`seedFrame`), base64.
    pub seed_frame_b64: &'a str,
    /// The salon message's author (`senderId`), who attached that frame.
    pub frame_sender_id: &'a str,
}

/// Builds the external commit into a key group and stages the state it produces.
///
/// Answers `{"ok": true, "commit", "nextBase"}` (base64), or `{"ok": false, "reason", "terminal"}`.
///
/// THE CHECKS A CLIENT CAN ADD TO THE SERVER'S GATE, every one cheap and every one before anything
/// leaves the device. The server decides who may join (its entitlement call); what the phone can
/// still refuse is a push that does not hang together:
///
/// - the push's seed frame must be a frame OF the group it names (its clear header) - a salon
///   message is a reason to join the key group ITS seed travels on, and no other;
/// - the base must build that same group (`join_by_external_commit` returns the id it built);
/// - the message's author must hold a leaf in that group's tree, other than this device's own -
///   the group must be one the author actually seals seeds on;
/// - the built instance must sit at the served base + 1, the epoch the server will record it at.
///
/// Read-only until the stage: the state is sealed into [`STAGED_STATE_FILE`] beside the digest of
/// the bytes it was loaded from, and `mls.bin` is untouched until [`finish_key_group_join`].
pub fn prepare_key_group_join(
    data_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    inputs: &JoinInputs<'_>,
) -> serde_json::Value {
    let gid = inputs.group_id;
    let short: String = gid.chars().take(8).collect();
    log::info!(
        "[KG_PUSH_JOIN] prepare group={short} baseEpoch={} sender={}",
        inputs.base_epoch,
        inputs.frame_sender_id.chars().take(8).collect::<String>()
    );
    // The foreground owns the state while it runs, and it joins every community's group on load.
    if foreground_is_active() {
        return refusal("foreground-active", Refusal::Retry);
    }
    // A warm process: its manager would persist over the install at the next resume. The app's own
    // load joins the group instead.
    if live_manager_in_process() {
        return refusal("warm-process", Refusal::Retry);
    }
    let Ok(frame) = STANDARD.decode(inputs.seed_frame_b64.trim()) else {
        return refusal("frame-unreadable", Refusal::Terminal);
    };
    if MlsManager::parse_message_group_id(&frame).as_deref() != Some(gid) {
        return refusal("frame-group-mismatch", Refusal::Terminal);
    }
    let Ok(group_info) = STANDARD.decode(inputs.group_info_b64.trim()) else {
        return refusal("base-unreadable", Refusal::Retry);
    };
    let key = match mls_core::crypto::decode_base64_to_32_bytes(key_b64.trim()) {
        Ok(k) => k,
        Err(e) => {
            log::error!("[KG_PUSH_JOIN] device key unreadable: {e}");
            return refusal("state-unreadable", Refusal::Defer);
        }
    };
    let mut manager =
        match MlsManager::load_with_key(user_id, device_id, Some(state_bytes.to_vec()), &key) {
            Ok(m) => m,
            Err(e) => {
                log::error!("[KG_PUSH_JOIN] mls.bin unreadable with the device key: {e}");
                return refusal("state-unreadable", Refusal::Defer);
            }
        };
    if manager.get_epoch(gid).is_ok() {
        return refusal("already-held", Refusal::Defer);
    }
    let (built, commit) = match manager.join_by_external_commit(&group_info) {
        Ok(pair) => pair,
        Err(e) => {
            log::warn!("[KG_PUSH_JOIN] external commit not built for group={short}: {e}");
            return refusal("base-unusable", Refusal::Defer);
        }
    };
    if built != gid {
        return refusal("base-group-mismatch", Refusal::Terminal);
    }
    let own = format!("{user_id}:{device_id}");
    let author_prefix = format!("{}:", inputs.frame_sender_id);
    let author_in_tree = match manager.member_identities(gid) {
        Ok(ids) => ids
            .iter()
            .any(|id| id != &own && id.starts_with(&author_prefix)),
        Err(e) => {
            log::warn!("[KG_PUSH_JOIN] tree unreadable for group={short}: {e}");
            false
        }
    };
    if inputs.frame_sender_id.is_empty() || !author_in_tree {
        return refusal("sender-not-in-tree", Refusal::Terminal);
    }
    match manager.get_epoch(gid) {
        Ok(e) if e == inputs.base_epoch + 1 => {}
        other => {
            log::warn!(
                "[KG_PUSH_JOIN] instance epoch {:?} for group={short}, expected {}",
                other.ok(),
                inputs.base_epoch + 1
            );
            return refusal("epoch-mismatch", Refusal::Defer);
        }
    }
    // The base for the epoch this commit creates travels with it (COMM-22): exported now, while
    // this device is the only one that can.
    let next_base = match manager.export_group_info(gid) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[KG_PUSH_JOIN] next base not exported for group={short}: {e}");
            return refusal("base-unusable", Refusal::Defer);
        }
    };
    if let Err(e) = manager.merge_pending_commit_for(gid) {
        log::warn!("[KG_PUSH_JOIN] pending commit not merged for group={short}: {e}");
        return refusal("base-unusable", Refusal::Defer);
    }
    let sealed = match manager.save_encrypted_with_key(&key) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[KG_PUSH_JOIN] post-join state not sealed for group={short}: {e}");
            return refusal("stage-failed", Refusal::Defer);
        }
    };
    let mut staged = Vec::with_capacity(32 + sealed.len());
    staged.extend_from_slice(&mls_bin_digest(state_bytes));
    staged.extend_from_slice(&sealed);
    let staged_path = data_dir.join(STAGED_STATE_FILE);
    let staged_tmp = data_dir.join(format!("{STAGED_STATE_FILE}.tmp"));
    let written = std::fs::write(&staged_tmp, &staged)
        .and_then(|()| std::fs::rename(&staged_tmp, &staged_path));
    if let Err(e) = written {
        log::error!("[KG_PUSH_JOIN] post-join state not staged for group={short}: {e}");
        return refusal("stage-failed", Refusal::Defer);
    }
    log::info!(
        "[KG_PUSH_JOIN] prepared group={short} commit={}B nextBase={}B staged={}B",
        commit.len(),
        next_base.len(),
        sealed.len()
    );
    serde_json::json!({
        "ok": true,
        "commit": STANDARD.encode(&commit),
        "nextBase": STANDARD.encode(&next_base),
    })
}

/// Installs the state [`prepare_key_group_join`] staged, once the server ACCEPTED its commit - and
/// only over the `mls.bin` it was built from. The stage is deleted whatever happens.
///
/// An error here is a [`Settlement::Lost`]: the server holds a leaf this device has no secrets for.
pub fn finish_key_group_join(data_dir: &Path) -> Result<usize, String> {
    let staged_path = data_dir.join(STAGED_STATE_FILE);
    let staged = std::fs::read(&staged_path).map_err(|e| format!("read staged state: {e}"));
    if let Err(e) = std::fs::remove_file(&staged_path) {
        log::warn!("[KG_PUSH_JOIN] staged state not deleted after the finish: {e}");
    }
    let staged = staged?;
    if staged.len() <= 32 {
        return Err("staged state is truncated".into());
    }
    let (digest, sealed) = staged.split_at(32);
    let digest: [u8; 32] = digest.try_into().map_err(|_| "staged digest".to_string())?;
    background_write_mls_bin_if_unchanged_and_cold(&data_dir.join("mls.bin"), &digest, sealed)?;
    log::info!(
        "[KG_PUSH_JOIN] joined state installed (mls.bin {} bytes)",
        sealed.len()
    );
    Ok(sealed.len())
}

/// Deletes a staged state whose commit was NOT accepted - an external commit cannot be cleared,
/// so the built group must leave no trace.
pub fn abandon_key_group_join(data_dir: &Path) {
    match std::fs::remove_file(data_dir.join(STAGED_STATE_FILE)) {
        Ok(()) => log::info!("[KG_PUSH_JOIN] staged state abandoned - mls.bin untouched"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[KG_PUSH_JOIN] staged state not deleted on abandon: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::{forget_live_manager_for_test, test_support::serialise};

    /// The cold, backgrounded process every join test starts from.
    fn mark_foreground_inactive() {
        crate::concurrency::mark_foreground_inactive();
        forget_live_manager_for_test();
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-kgjoin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn key() -> [u8; 32] {
        [7u8; 32]
    }

    /// The install's native cache key the ledger is sealed under.
    const K: CacheKey = [3u8; 32];

    /// A key group held by `alice` (who seals a seed frame on it), and `phone`'s sealed `mls.bin`
    /// holding nothing - the phone that never loaded the community.
    struct Fixture {
        dir: std::path::PathBuf,
        alice: MlsManager,
        state: Vec<u8>,
        group_info: String,
        base_epoch: u64,
        frame: String,
        /// The seed frame's author, whose leaf is in the group.
        sender: String,
    }

    fn fixture(tag: &str) -> Fixture {
        let dir = temp_dir(tag);
        let gid = format!("kg-{tag}");
        let mut alice =
            MlsManager::load_or_create(&format!("alice-{tag}"), "dev-a", None).expect("alice");
        alice.create_group(gid.clone()).expect("create");
        let frame = alice.send_message(&gid, b"seed").expect("frame");
        let phone = MlsManager::load_or_create("phone-user", "dev-p", None).expect("phone");
        let state = phone.save_encrypted_with_key(&key()).expect("seal");
        std::fs::write(dir.join("mls.bin"), &state).expect("write mls.bin");
        Fixture {
            dir,
            group_info: STANDARD.encode(alice.export_group_info(&gid).expect("gi")),
            base_epoch: alice.get_epoch(&gid).expect("epoch"),
            frame: STANDARD.encode(frame),
            sender: format!("alice-{tag}"),
            state,
            alice,
        }
    }

    fn inputs<'a>(f: &'a Fixture, gid: &'a str, sender: &'a str) -> JoinInputs<'a> {
        JoinInputs {
            group_id: gid,
            group_info_b64: &f.group_info,
            base_epoch: f.base_epoch,
            seed_frame_b64: &f.frame,
            frame_sender_id: sender,
        }
    }

    fn prepare(f: &Fixture, i: &JoinInputs<'_>) -> serde_json::Value {
        prepare_key_group_join(
            &f.dir,
            &f.state,
            &STANDARD.encode(key()),
            "phone-user",
            "dev-p",
            i,
        )
    }

    #[test]
    fn a_push_joins_the_key_group_and_the_installed_state_reads_the_next_seed() {
        let _g = serialise();
        mark_foreground_inactive();
        let mut f = fixture("ok");
        let gid = "kg-ok".to_string();
        let answer = prepare(&f, &inputs(&f, &gid, &f.sender));
        assert_eq!(answer["ok"], true, "{answer}");
        // Nothing is installed before the server answers.
        assert_eq!(std::fs::read(f.dir.join("mls.bin")).unwrap(), f.state);

        // The server accepted; alice applies the commit as every member would.
        let commit = STANDARD.decode(answer["commit"].as_str().unwrap()).unwrap();
        f.alice
            .process_incoming_message(&gid, &commit)
            .expect("alice applies the external commit");
        finish_key_group_join(&f.dir).expect("finish");
        assert!(!f.dir.join(STAGED_STATE_FILE).exists());

        let installed = std::fs::read(f.dir.join("mls.bin")).unwrap();
        let mut phone =
            MlsManager::load_with_key("phone-user", "dev-p", Some(installed), &key()).unwrap();
        assert_eq!(phone.get_epoch(&gid).unwrap(), f.base_epoch + 1);
        let next = f.alice.send_message(&gid, b"next seed").unwrap();
        let opened = phone
            .process_incoming_message(&gid, &next)
            .expect("phone opens");
        assert_eq!(opened.as_deref(), Some(&b"next seed"[..]));

        // The base it published opens the group to the NEXT joiner at the new epoch.
        let next_base = STANDARD
            .decode(answer["nextBase"].as_str().unwrap())
            .unwrap();
        let mut carol = MlsManager::load_or_create("carol", "dev-c", None).unwrap();
        carol
            .join_by_external_commit(&next_base)
            .expect("next base is usable");
        assert_eq!(carol.get_epoch(&gid).unwrap(), f.base_epoch + 2);
    }

    #[test]
    fn a_frame_of_another_group_is_not_a_reason_to_join_this_one() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("mismatch");
        let answer = prepare(&f, &inputs(&f, "kg-somewhere-else", &f.sender));
        assert_eq!(answer["reason"], "frame-group-mismatch");
        assert_eq!(answer["terminal"], true);
        assert!(!f.dir.join(STAGED_STATE_FILE).exists());
    }

    #[test]
    fn an_author_without_a_leaf_in_the_group_is_refused() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("author");
        let gid = "kg-author".to_string();
        let answer = prepare(&f, &inputs(&f, &gid, "mallory"));
        assert_eq!(answer["reason"], "sender-not-in-tree");
        assert_eq!(answer["terminal"], true);
        assert!(!f.dir.join(STAGED_STATE_FILE).exists());
    }

    #[test]
    fn a_base_behind_the_served_epoch_is_refused_and_retryable() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("epoch");
        let gid = "kg-epoch".to_string();
        let mut i = inputs(&f, &gid, &f.sender);
        i.base_epoch += 1;
        let answer = prepare(&f, &i);
        assert_eq!(answer["reason"], "epoch-mismatch");
        assert_eq!(answer["terminal"], false);
        // Reached after the load and the build: deferred on this base, not retried on every push.
        assert_eq!(answer["deferrable"], true);
    }

    /// A WARM PROCESS NEVER INSTALLS: its manager would persist over the join at the next resume
    /// (`LiveAhead`). Refused before the build, and again at the install for a manager loaded while
    /// the join was in flight.
    #[test]
    fn a_warm_process_is_refused_before_the_build_and_at_the_install() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("warm");
        let gid = "kg-warm".to_string();
        assert_eq!(prepare(&f, &inputs(&f, &gid, &f.sender))["ok"], true);

        // The app is opened during the round trip, and then backgrounded again before the answer.
        crate::concurrency::foreground_load_mls_bin(&f.dir.join("mls.bin")).unwrap();
        crate::concurrency::mark_foreground_inactive();
        let err = finish_key_group_join(&f.dir).unwrap_err();
        assert!(err.contains("foreground manager is loaded"), "{err}");
        assert_eq!(std::fs::read(f.dir.join("mls.bin")).unwrap(), f.state);

        let answer = prepare(&f, &inputs(&f, &gid, &f.sender));
        mark_foreground_inactive();
        assert_eq!(answer["reason"], "warm-process");
        assert_eq!(answer["deferrable"], false);
        assert!(!f.dir.join(STAGED_STATE_FILE).exists());
    }

    /// THE LOGIN'S READ AND A BACKGROUND INSTALL, IN BOTH ORDERS. Installed first: the login reads
    /// the joined state. Login first: the install is refused, so the manager built from the read can
    /// never persist over it.
    #[test]
    fn a_login_read_either_sees_the_install_or_refuses_it() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("login");
        let gid = "kg-login".to_string();
        assert_eq!(prepare(&f, &inputs(&f, &gid, &f.sender))["ok"], true);
        finish_key_group_join(&f.dir).expect("cold process installs");
        let read = crate::concurrency::foreground_load_mls_bin(&f.dir.join("mls.bin"))
            .unwrap()
            .unwrap();
        let loaded = MlsManager::load_with_key("phone-user", "dev-p", Some(read), &key()).unwrap();
        assert!(
            loaded.get_epoch(&gid).is_ok(),
            "the login read the joined state"
        );

        mark_foreground_inactive();
        let g = fixture("login2");
        let gid2 = "kg-login2".to_string();
        assert_eq!(prepare(&g, &inputs(&g, &gid2, &g.sender))["ok"], true);
        let before = crate::concurrency::foreground_load_mls_bin(&g.dir.join("mls.bin"))
            .unwrap()
            .unwrap();
        // Even with the heartbeat lapsed, the warm mark holds.
        crate::concurrency::mark_foreground_inactive();
        assert!(finish_key_group_join(&g.dir).is_err());
        assert_eq!(std::fs::read(g.dir.join("mls.bin")).unwrap(), before);
        mark_foreground_inactive();
    }

    #[test]
    fn nothing_is_built_while_the_foreground_runs() {
        let _g = serialise();
        crate::concurrency::mark_foreground_active();
        let f = fixture("fg");
        let gid = "kg-fg".to_string();
        let answer = prepare(&f, &inputs(&f, &gid, &f.sender));
        mark_foreground_inactive();
        assert_eq!(answer["reason"], "foreground-active");
        assert_eq!(answer["terminal"], false);
    }

    #[test]
    fn the_finish_refuses_a_mls_bin_that_moved_since_the_prepare() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("cas");
        let gid = "kg-cas".to_string();
        assert_eq!(prepare(&f, &inputs(&f, &gid, &f.sender))["ok"], true);
        // Another writer (the foreground, between two heartbeats) moved the file.
        std::fs::write(f.dir.join("mls.bin"), b"a newer state").unwrap();
        let err = finish_key_group_join(&f.dir).unwrap_err();
        assert!(err.contains("changed since it was loaded"), "{err}");
        assert_eq!(
            std::fs::read(f.dir.join("mls.bin")).unwrap(),
            b"a newer state"
        );
        assert!(!f.dir.join(STAGED_STATE_FILE).exists());
    }

    #[test]
    fn an_abandoned_join_leaves_mls_bin_untouched() {
        let _g = serialise();
        mark_foreground_inactive();
        let f = fixture("abandon");
        let gid = "kg-abandon".to_string();
        assert_eq!(prepare(&f, &inputs(&f, &gid, &f.sender))["ok"], true);
        abandon_key_group_join(&f.dir);
        assert!(!f.dir.join(STAGED_STATE_FILE).exists());
        assert_eq!(std::fs::read(f.dir.join("mls.bin")).unwrap(), f.state);
    }

    #[test]
    fn the_ledger_grants_one_attempt_per_group_and_the_app_takes_it_whole() {
        let dir = temp_dir("ledger");
        assert_eq!(claim(&dir, &K, "g1").unwrap(), Claim::Granted);
        // A second push for the same group while the first is unsettled - or after the process died.
        assert_eq!(
            claim(&dir, &K, "g1").unwrap(),
            Claim::AlreadyAttempted("attempting".into())
        );
        // A retryable outcome removes the claim; a later push may try again.
        settle(&dir, &K, "g1", &Settlement::Retryable("no-base".into())).unwrap();
        assert_eq!(claim(&dir, &K, "g1").unwrap(), Claim::Granted);
        settle(
            &dir,
            &K,
            "g1",
            &Settlement::Joined {
                scope_kind: "workspace".into(),
                scope_id: "ws-1".into(),
            },
        )
        .unwrap();
        assert_eq!(claim(&dir, &K, "g2").unwrap(), Claim::Granted);
        settle(&dir, &K, "g2", &Settlement::Refused("not-entitled".into())).unwrap();
        // A prepare failed on the base at epoch 4: claimed again, with the epoch to skip.
        assert_eq!(claim(&dir, &K, "g3").unwrap(), Claim::Granted);
        settle(
            &dir,
            &K,
            "g3",
            &Settlement::Deferred {
                reason: "epoch-mismatch".into(),
                base_epoch: 4,
            },
        )
        .unwrap();
        assert_eq!(
            claim(&dir, &K, "g3").unwrap(),
            Claim::GrantedUnlessBaseAt(4)
        );
        // That claim is an attempt like any other: a second push meanwhile is not granted.
        assert_eq!(
            claim(&dir, &K, "g3").unwrap(),
            Claim::AlreadyAttempted("attempting".into())
        );
        settle(
            &dir,
            &K,
            "g3",
            &Settlement::Deferred {
                reason: "base-unchanged".into(),
                base_epoch: 4,
            },
        )
        .unwrap();
        assert_eq!(
            claim(&dir, &K, "g2").unwrap(),
            Claim::AlreadyAttempted("refused".into())
        );

        let mut taken = take_all(&dir, &K).unwrap();
        taken.sort_by(|a, b| a.group_id.cmp(&b.group_id));
        assert_eq!(
            taken,
            vec![
                TakenJoin {
                    group_id: "g1".into(),
                    state: "joined".into(),
                    scope_kind: Some("workspace".into()),
                    scope_id: Some("ws-1".into()),
                    reason: None,
                },
                TakenJoin {
                    group_id: "g2".into(),
                    state: "refused".into(),
                    scope_kind: None,
                    scope_id: None,
                    reason: Some("not-entitled".into()),
                },
                TakenJoin {
                    group_id: "g3".into(),
                    state: "deferred".into(),
                    scope_kind: None,
                    scope_id: None,
                    reason: Some("base-unchanged".into()),
                },
            ]
        );
        // Taken means gone: the app's own join owns these groups now.
        assert!(take_all(&dir, &K).unwrap().is_empty());
        assert_eq!(claim(&dir, &K, "g2").unwrap(), Claim::Granted);
    }

    /// THE LEDGER IS SEALED AT REST: its group ids and salon scopes never reach the disk in the
    /// clear, and a file that does not open under the key - another key, damage, or a plaintext
    /// one - is read as empty and replaced sealed at the next write.
    #[test]
    fn the_ledger_is_sealed_at_rest_and_opens_under_its_key_only() {
        let dir = temp_dir("sealed");
        assert_eq!(claim(&dir, &K, "kg-secret-group").unwrap(), Claim::Granted);
        settle(
            &dir,
            &K,
            "kg-secret-group",
            &Settlement::Joined {
                scope_kind: "workspace".into(),
                scope_id: "salon-secret".into(),
            },
        )
        .unwrap();
        let on_disk = std::fs::read(dir.join(LEDGER_FILE)).unwrap();
        assert!(crate::native_cache::is_sealed_file(&on_disk));
        let text = String::from_utf8_lossy(&on_disk);
        assert!(!text.contains("kg-secret-group") && !text.contains("salon-secret"));

        // Under another key it reads as empty - never as a ledger that granted nothing.
        assert_eq!(
            claim(&dir, &[9u8; 32], "kg-secret-group").unwrap(),
            Claim::Granted
        );

        // A plaintext ledger was never written by a shipped build: it is not read as one.
        std::fs::write(dir.join(LEDGER_FILE), r#"{"kg-plain":{"state":"refused"}}"#).unwrap();
        assert_eq!(claim(&dir, &K, "kg-plain").unwrap(), Claim::Granted);
        assert!(crate::native_cache::is_sealed_file(
            &std::fs::read(dir.join(LEDGER_FILE)).unwrap()
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_full_ledger_refuses_a_new_group_and_keeps_answering_for_the_old_ones() {
        let dir = temp_dir("full");
        for i in 0..LEDGER_CAPACITY {
            assert_eq!(claim(&dir, &K, &format!("g{i}")).unwrap(), Claim::Granted);
        }
        assert_eq!(claim(&dir, &K, "one-more").unwrap(), Claim::LedgerFull);
        assert_eq!(
            claim(&dir, &K, "g0").unwrap(),
            Claim::AlreadyAttempted("attempting".into())
        );
    }
}
