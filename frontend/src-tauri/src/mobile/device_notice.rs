//! "A new device was added to your account" - the native half (user decision 2026-10-22).
//!
//! The owner of an account is told when a device joins it, in the app AND as a local notification
//! on the phone. The app tells it from the events it takes after a drain (`deviceNotices.ts`); this
//! module is what the BACKGROUND engines (the Android FCM service, the iOS notification extension)
//! need to do the same from a commit they merged in memory while the app was not running:
//!
//! - [`owner_alert_keys`] reads, from the manager a background decrypt just used, the events that
//!   are the owner's alert ([`mls_core::DeviceEvent::is_owner_alert`], the rule the app's
//!   `deviceEventAudience` follows too), as their de-duplication keys;
//! - [`claim_device_notices`] is the ledger both engines share: one marker file per key, created
//!   with `create_new`, so the first engine to claim a key announces it and every later one - the
//!   next push that replays the same commit, the app taking the same event, another process on iOS
//!   - is refused by the filesystem itself. Atomic across processes, no lock and no clock.
//! - [`engine_claim_device_notices`] is the engines' door to it: they announce only for an account
//!   the app has pre-claimed since the update ([`preclaim_device_notices`]), since only the app
//!   knows which of the account's devices are old.
//!
//! Every engine reads the event from a SIGNED commit it merged, never from a server message: a
//! server that stays silent cannot silence the alert.
//!
//! The ledger lives where both engines of a platform can reach it: the app data directory on
//! Android (one process), the App Group container on iOS (the app and its extension). It holds ONE
//! DIRECTORY PER ACCOUNT (`device_notices/<sha256(userId)>/`: a marker per key, and the pre-claim
//! marker), so an account's deletion removes its own markers and no other account's.

use std::path::Path;

use mls_core::MlsManager;

/// The directory, inside the shared data directory, that holds the ledger; the per-account
/// directory under it, and the one encoder of a file name, live with the deletion that sweeps them
/// (`commands::push`), which is compiled off a phone too.
pub(crate) use crate::commands::push::{
    device_notice_file_name, device_notice_legacy_name, device_notices_account_dir,
    DEVICE_NOTICES_DIR,
};

/// The most markers kept per account. Past it the OLDEST are removed: a key that old was announced long ago,
/// and the event that names it will not come back (the commit is merged and persisted by then).
pub const MAX_DEVICE_NOTICE_MARKERS: usize = 256;

/// Takes every pending device event from `manager` and returns the keys of those that are this
/// account's owner alert, de-duplicated, in order.
///
/// For a manager the caller DISCARDS afterwards (the read-only push paths): taking is free there,
/// the foreground merges the same commit again later and gets its own copy of each event. A caller
/// that WRITES the state back uses [`owner_alert_keys_of`] over the events it leaves in place.
pub fn owner_alert_keys(manager: &mut MlsManager, user_id: &str, device_id: &str) -> Vec<String> {
    owner_alert_keys_of(&manager.take_device_events(), user_id, device_id)
}

/// The keys of the owner alerts among `events`, de-duplicated, in order.
pub fn owner_alert_keys_of(
    events: &[mls_core::DeviceEvent],
    user_id: &str,
    device_id: &str,
) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for event in events {
        if !event.is_owner_alert(user_id, device_id) {
            continue;
        }
        let Some(key) = event.notice_key() else {
            // Unreachable: `is_owner_alert` holds only for an identity that names a device.
            log::error!("[DEVICE_NOTICE] an owner alert whose identity names no device - skipped");
            continue;
        };
        if !keys.contains(&key) {
            log::info!(
                "[DEVICE_NOTICE] a device was added to this account in {} at epoch {} - key {}",
                event.group_id.get(..8).unwrap_or(&event.group_id),
                event.epoch,
                event.key_fingerprint
            );
            keys.push(key);
        }
    }
    if events.len() > keys.len() {
        log::debug!(
            "[DEVICE_NOTICE] {} device event(s) read, {} owner alert(s)",
            events.len(),
            keys.len()
        );
    }
    keys
}

/// The file, in an account's ledger directory, saying the app has pre-claimed that account's older
/// devices since this build ([`preclaim_device_notices`]). Not hex, so no key marker can be named so.
const PRECLAIM_MARKER: &str = "preclaimed";

/// The marker file name of `key`: [`device_notice_file_name`] of it - 64 characters whatever the
/// key.
///
/// Before 1.6.1 the name was the whole key in hex ([`legacy_marker_name`]), twice the key's length:
/// a production key (`userId:deviceId|fingerprint`) runs to ~160 bytes, its name to ~320, and
/// every claim failed with `File name too long (os error 36)` - so no background engine announced
/// a new device, and no key the app showed or pre-claimed was recorded, from 1.4.1-alpha.2 on.
fn marker_name(key: &str) -> String {
    device_notice_file_name(key)
}

/// The marker name builds before 1.6.1 wrote, in the ledger's ROOT: the key's bytes in hex. Read,
/// and migrated to [`marker_name`] on a hit - see [`announced_by_an_older_build`].
fn legacy_marker_name(key: &str) -> String {
    device_notice_legacy_name(key)
}

/// Whether a build before 1.6.1 already announced `key`. Such a marker can exist only for a key of
/// at most 127 bytes (a user id of roughly 40 characters or fewer): a longer key's hex name was
/// refused by the filesystem, so it was NEVER written - and `exists` answers `false` for a name the
/// filesystem refuses, so no length guard is needed. Honoured so the upgrade announces nothing
/// twice (`docs/wiki/legacy-compatibility.md`, "a device-notice marker named by the key in hex").
fn announced_by_an_older_build(root: &Path, key: &str) -> bool {
    root.join(legacy_marker_name(key)).exists()
}

/// The account a key names: the user id before its first `:` (`userId:deviceId|fingerprint`).
fn account_of(key: &str) -> Option<&str> {
    key.split_once(':').map(|(user, _)| user)
}

/// Whether the app has pre-claimed `user_id`'s older devices on this install since this build.
fn is_preclaimed(data_dir: &Path, user_id: &str) -> bool {
    device_notices_account_dir(data_dir, user_id)
        .join(PRECLAIM_MARKER)
        .exists()
}

/// What one pass over the ledger did: the keys it claimed, and how many it could not record.
struct ClaimPass {
    claimed: Vec<String>,
    unrecorded: usize,
}

/// Claims each key in its account's directory of the ledger under `data_dir`. A key already
/// claimed - by this build or, migrated on the way, by an older one - is neither claimed nor
/// counted; a key whose marker could not be written is logged at ERROR and counted in `unrecorded`.
fn claim_in(data_dir: &Path, keys: &[String]) -> ClaimPass {
    let root = data_dir.join(DEVICE_NOTICES_DIR);
    let mut pass = ClaimPass {
        claimed: Vec::new(),
        unrecorded: 0,
    };
    let mut touched: Vec<std::path::PathBuf> = Vec::new();
    for key in keys {
        let Some(user) = account_of(key) else {
            log::error!("[DEVICE_NOTICE] key {key} names no account - not recorded, not announced");
            pass.unrecorded += 1;
            continue;
        };
        let dir = device_notices_account_dir(data_dir, user);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::error!(
                "[DEVICE_NOTICE] ledger directory {} unavailable, {key} not recorded, not announced: {e}",
                dir.display()
            );
            pass.unrecorded += 1;
            continue;
        }
        let path = dir.join(marker_name(key));
        let legacy = announced_by_an_older_build(&root, key);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) if legacy => {
                log::debug!("[DEVICE_NOTICE] announced by an older build, marker migrated: {key}");
            }
            Ok(_) => {
                pass.claimed.push(key.clone());
                if !touched.contains(&dir) {
                    touched.push(dir);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                log::debug!("[DEVICE_NOTICE] already announced: {key}");
            }
            Err(e) if legacy => {
                // Announced all the same: the legacy marker still answers until this write succeeds.
                log::error!(
                    "[DEVICE_NOTICE] legacy marker of {key} not migrated to {}: {e}",
                    path.display()
                );
                pass.unrecorded += 1;
            }
            Err(e) => {
                log::error!(
                    "[DEVICE_NOTICE] marker {} for {key} not written, not announced: {e}",
                    path.display()
                );
                pass.unrecorded += 1;
            }
        }
    }
    for dir in &touched {
        prune_markers(dir);
    }
    pass
}

/// THE APP's claim: claims each key in the ledger under `data_dir` and returns the keys THIS call
/// claimed - the ones nobody announced before. A key already claimed is not returned; a key whose
/// marker could not be written is logged and NOT returned, since nothing would then stop a second
/// announcement of it. Ungated: the app decides from key ages it holds, which the engines do not.
pub fn claim_device_notices(data_dir: &Path, keys: &[String]) -> Vec<String> {
    claim_in(data_dir, keys).claimed
}

/// THE APP's pre-claim of `user_id`'s older devices (`preclaimOldOwnDevices`): records `keys`, then,
/// only when `complete` (the app read the key ages of EVERY listed device) and every key is
/// recorded, writes the account's pre-claim marker, which is what lets a background engine
/// announce for this account at all ([`engine_claim_device_notices`]). Returns whether the marker
/// is in place. Otherwise it stays absent: the next registration tries again, and the engines stay
/// quiet meanwhile rather than post for a device whose age nobody read.
pub fn preclaim_device_notices(
    data_dir: &Path,
    user_id: &str,
    keys: &[String],
    complete: bool,
) -> bool {
    let pass = claim_in(data_dir, keys);
    if !complete {
        log::warn!(
            "[DEVICE_NOTICE] {} older key(s) recorded, but a device's key ages went unanswered - pre-claim marker NOT written, the background engines stay quiet for this account until a complete pass",
            pass.claimed.len()
        );
        return false;
    }
    if pass.unrecorded > 0 {
        log::error!(
            "[DEVICE_NOTICE] {} of {} older key(s) not recorded - pre-claim marker NOT written, the background engines stay quiet for this account",
            pass.unrecorded,
            keys.len()
        );
        return false;
    }
    let dir = device_notices_account_dir(data_dir, user_id);
    let marker = dir.join(PRECLAIM_MARKER);
    match std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&marker, b"")) {
        Ok(()) => {
            log::info!(
                "[DEVICE_NOTICE] {} older key(s) pre-claimed, {} newly - the background engines may announce for this account",
                keys.len(),
                pass.claimed.len()
            );
            true
        }
        Err(e) => {
            log::error!(
                "[DEVICE_NOTICE] pre-claim marker {} not written, the background engines stay quiet for this account: {e}",
                marker.display()
            );
            false
        }
    }
}

/// What a background engine's claim answers: the keys it may announce, and how many it HELD
/// because their account is not pre-claimed - so the platform's own log line can say which of the
/// two reasons left it nothing to post (this crate's log reaches no logger in a killed app).
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct EngineClaim {
    pub claimed: Vec<String>,
    pub held: usize,
}

/// A BACKGROUND ENGINE's claim (the Android FCM service, the iOS notification extension): as
/// [`claim_device_notices`], but only for a key whose account the app has pre-claimed
/// ([`preclaim_device_notices`]).
///
/// The engines hold no key ages, so they cannot tell an old device a heal brings back from a new
/// one; the app's pre-claim records every old key first. After a store update the engines run the
/// new build BEFORE the app's next launch, and every pre-claim of 1.4.1-alpha.2 to 1.6.0 failed
/// (the name was too long), so without this gate one heal commit pushed before the first open would
/// post a false "new device" for an old laptop. A key whose account has no marker is NOT claimed
/// (the app's own pass, which reads the same event after its drain, decides) and is counted `held`.
pub fn engine_claim_device_notices(data_dir: &Path, keys: &[String]) -> EngineClaim {
    let (open, held): (Vec<String>, Vec<String>) = keys
        .iter()
        .cloned()
        .partition(|key| account_of(key).is_some_and(|user| is_preclaimed(data_dir, user)));
    for key in &held {
        log::info!(
            "[DEVICE_NOTICE] {key} held by the background engine: the app has not pre-claimed this account's older devices since the update - the app's own pass decides"
        );
    }
    EngineClaim {
        claimed: claim_in(data_dir, &open).claimed,
        held: held.len(),
    }
}

/// [`engine_claim_device_notices`] over JSON, for the JNI and C-FFI entry points of the background
/// engines: a JSON array of keys in, an [`EngineClaim`] object out. A payload that is not an array
/// of strings claims nothing and answers an empty claim, logged.
pub fn engine_claim_device_notices_json(data_dir: &Path, keys_json: &str) -> String {
    let claim = match serde_json::from_str::<Vec<String>>(keys_json) {
        Ok(keys) => engine_claim_device_notices(data_dir, &keys),
        Err(e) => {
            log::error!("[DEVICE_NOTICE] keys payload is not a JSON array of strings: {e}");
            EngineClaim {
                claimed: Vec::new(),
                held: 0,
            }
        }
    };
    serde_json::to_string(&claim).unwrap_or_else(|e| {
        log::error!("[DEVICE_NOTICE] engine claim not serialisable: {e}");
        r#"{"claimed":[],"held":0}"#.to_string()
    })
}

/// Keeps the newest [`MAX_DEVICE_NOTICE_MARKERS`] key markers of one account's directory. Its
/// pre-claim marker is never pruned: it is not a key, and losing it would silence the engines.
fn prune_markers(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut markers: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != PRECLAIM_MARKER)
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();
    if markers.len() <= MAX_DEVICE_NOTICE_MARKERS {
        return;
    }
    markers.sort_by_key(|(t, _)| *t);
    let excess = markers.len() - MAX_DEVICE_NOTICE_MARKERS;
    for (_, path) in markers.into_iter().take(excess) {
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("[DEVICE_NOTICE] old marker not pruned: {e}");
        }
    }
    log::debug!("[DEVICE_NOTICE] {excess} old marker(s) pruned");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-notice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// The engine's answer, read back.
    fn engine(dir: &Path, keys_json: &str) -> (Vec<String>, usize) {
        let v: serde_json::Value =
            serde_json::from_str(&engine_claim_device_notices_json(dir, keys_json)).unwrap();
        let claimed = v["claimed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        (claimed, v["held"].as_u64().unwrap() as usize)
    }

    /// `user`'s directory of the ledger under `dir`.
    fn account(dir: &Path, user: &str) -> std::path::PathBuf {
        device_notices_account_dir(dir, user)
    }

    #[test]
    fn a_key_is_claimed_once_whoever_asks_again() {
        let dir = temp_dir("once");
        let keys = vec!["bob:web-2|00ff".to_string(), "bob:web-3|11ee".to_string()];
        assert_eq!(claim_device_notices(&dir, &keys), keys);
        assert!(
            claim_device_notices(&dir, &keys).is_empty(),
            "a replay announces nothing"
        );
        assert!(preclaim_device_notices(&dir, "bob", &[], true));
        assert_eq!(
            engine(&dir, r#"["bob:web-2|00ff","bob:web-4|22dd"]"#),
            (vec!["bob:web-4|22dd".to_string()], 0)
        );
    }

    #[test]
    fn a_payload_that_is_not_a_list_of_keys_claims_nothing() {
        let dir = temp_dir("bad");
        assert_eq!(engine(&dir, "{}"), (vec![], 0));
        assert!(!dir.join(DEVICE_NOTICES_DIR).exists());
    }

    #[test]
    fn the_ledger_is_bounded_per_account() {
        let dir = temp_dir("bound");
        let keys: Vec<String> = (0..MAX_DEVICE_NOTICE_MARKERS + 5)
            .map(|i| format!("u:d{i}|ff"))
            .collect();
        claim_device_notices(&dir, &keys);
        let count = std::fs::read_dir(account(&dir, "u")).unwrap().count();
        assert_eq!(count, MAX_DEVICE_NOTICE_MARKERS);
    }

    /// A production-shaped key: a 36-byte user id, a long device id, a 16-hex fingerprint - the
    /// shape whose hex name (~320 bytes) the Mi 9T refused at every start.
    fn long_key(device: &str) -> String {
        format!(
            "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:android-{device}-{}|00112233aabbccdd",
            "7".repeat(100)
        )
    }

    #[test]
    fn a_long_key_names_a_short_stable_distinct_marker() {
        let (a, b) = (long_key("a"), long_key("b"));
        assert!(legacy_marker_name(&a).len() > 255, "the shape that failed");
        assert_eq!(marker_name(&a).len(), 64);
        assert_eq!(marker_name(&a), marker_name(&a), "deterministic");
        assert_ne!(marker_name(&a), marker_name(&b), "one marker per key");
    }

    #[test]
    fn a_long_key_is_claimed_and_then_reads_announced() {
        let dir = temp_dir("long");
        let keys = vec![long_key("a")];
        assert_eq!(
            claim_device_notices(&dir, &keys),
            keys,
            "the marker is written"
        );
        assert!(account(&dir, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
            .join(marker_name(&keys[0]))
            .exists());
        assert!(
            claim_device_notices(&dir, &keys).is_empty(),
            "the second claim reads it announced"
        );
    }

    #[test]
    fn a_marker_written_by_an_older_build_still_reads_announced() {
        let dir = temp_dir("legacy");
        let key = "bob:web-2|00ff".to_string();
        let root = dir.join(DEVICE_NOTICES_DIR);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(legacy_marker_name(&key)), b"").unwrap();
        assert!(claim_device_notices(&dir, std::slice::from_ref(&key)).is_empty());
        assert!(
            account(&dir, "bob").join(marker_name(&key)).exists(),
            "the hit is migrated to the digest marker"
        );
    }

    /// A key of `len` bytes for the account `u`.
    fn key_of_len(len: usize) -> String {
        let key = format!("u:{}|ff", "d".repeat(len - 5));
        assert_eq!(key.len(), len);
        key
    }

    /// 127 bytes is the longest key whose hex name (254) an older build could write; at 128 the
    /// name (256) is refused, so no legacy marker can exist and `exists` reads it absent.
    #[test]
    fn the_legacy_marker_is_read_up_to_127_bytes_and_absent_from_128() {
        let dir = temp_dir("boundary");
        let root = dir.join(DEVICE_NOTICES_DIR);
        std::fs::create_dir_all(&root).unwrap();
        let short = key_of_len(127);
        std::fs::write(root.join(legacy_marker_name(&short)), b"").unwrap();
        assert!(claim_device_notices(&dir, std::slice::from_ref(&short)).is_empty());

        let long = key_of_len(128);
        assert!(
            std::fs::write(root.join(legacy_marker_name(&long)), b"").is_err(),
            "a 256-byte name cannot be written"
        );
        assert!(!announced_by_an_older_build(&root, &long));
        assert_eq!(
            claim_device_notices(&dir, std::slice::from_ref(&long)),
            vec![long]
        );
    }

    /// After a store update the engines run before the app's next launch: until the app has
    /// pre-claimed the account, an engine posts nothing and claims nothing, so the app decides -
    /// and says so (`held`), so the platform's own log line is true.
    #[test]
    fn an_engine_announces_only_for_an_account_the_app_has_pre_claimed() {
        let dir = temp_dir("gate");
        let fresh = r#"["alice:laptop|00ff"]"#;
        assert_eq!(engine(&dir, fresh), (vec![], 1), "no marker, no post");
        assert!(!account(&dir, "alice")
            .join(marker_name("alice:laptop|00ff"))
            .exists());

        // The app's pre-claim: the old key is recorded, then the marker written.
        assert!(preclaim_device_notices(
            &dir,
            "Alice",
            &["alice:old-laptop|11ee".to_string()],
            true
        ));
        assert_eq!(
            engine(&dir, r#"["alice:old-laptop|11ee"]"#),
            (vec![], 0),
            "an old device a heal brings back is never posted"
        );
        assert_eq!(
            engine(&dir, fresh),
            (vec!["alice:laptop|00ff".to_string()], 0),
            "marker, post"
        );
        // Another account on the same install is still gated.
        assert_eq!(engine(&dir, r#"["bob:x|22"]"#), (vec![], 1));
    }

    /// A device whose key ages went unanswered may be old: its keys are not known, so the pass
    /// records what it knows and withholds the marker - the engines stay quiet.
    #[test]
    fn an_incomplete_pre_claim_records_the_known_keys_and_withholds_the_marker() {
        let dir = temp_dir("incomplete");
        let old = "alice:old-laptop|11ee".to_string();
        assert!(!preclaim_device_notices(
            &dir,
            "alice",
            std::slice::from_ref(&old),
            false
        ));
        assert!(account(&dir, "alice").join(marker_name(&old)).exists());
        assert!(!is_preclaimed(&dir, "alice"));
        assert_eq!(engine(&dir, r#"["alice:unread-tablet|22dd"]"#), (vec![], 1));
    }

    #[test]
    fn the_pre_claim_marker_is_never_pruned() {
        let dir = temp_dir("keep");
        assert!(preclaim_device_notices(&dir, "u", &[], true));
        let keys: Vec<String> = (0..MAX_DEVICE_NOTICE_MARKERS + 5)
            .map(|i| format!("u:d{i}|ff"))
            .collect();
        claim_device_notices(&dir, &keys);
        assert!(is_preclaimed(&dir, "u"));
    }

    /// The source of `path`, relative to this crate's root.
    fn source(path: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
            .unwrap()
    }

    /// The text of `source` from `from` up to the next `\n}` - one item's body.
    fn item<'a>(source: &'a str, from: &str) -> &'a str {
        let start = source
            .find(from)
            .unwrap_or_else(|| panic!("{from} not found"));
        let rest = &source[start..];
        &rest[..rest.find("\n}").unwrap()]
    }

    /// Both engines' entry points go through the GATED door; none reaches the app's ungated claim.
    #[test]
    fn each_engine_entry_point_calls_the_gated_claim() {
        let jni = source("src/lib.rs");
        let jni = item(
            &jni,
            "Java_fr_emse_canari_CanariFirebaseMessagingService_nativeClaimDeviceNotices",
        );
        assert!(jni.contains("device_notice::engine_claim_device_notices_json("));
        let ffi = source("src/mobile/ios_ffi.rs");
        let ffi = item(&ffi, "fn canari_native_claim_device_notices");
        assert!(ffi.contains("device_notice::engine_claim_device_notices_json("));
    }

    /// The pre-claim command is reachable from the page: registered in the invoke handler.
    #[test]
    fn the_pre_claim_command_is_registered() {
        let lib = source("src/lib.rs");
        let handler = &lib[lib
            .find(".invoke_handler(tauri::generate_handler![")
            .unwrap()..];
        let handler = &handler[..handler.find("])").unwrap()];
        assert!(handler.contains("\n            preclaim_device_notices,\n"));
    }

    /// The app's pass calls the pre-claim command whatever it found - with no old key too, since
    /// the call is also what writes the marker - and says whether it read every device.
    #[test]
    fn the_app_pre_claims_even_with_no_old_key() {
        let ts = source("../src/lib/utils/chat/deviceNoticeWiring.ts");
        let pass = item(&ts, "async function preclaimOldOwnDevices");
        let call = pass
            .find("invoke<boolean>('preclaim_device_notices'")
            .expect("the pass calls the pre-claim command");
        assert!(pass[call..].contains("complete"));
        assert!(
            !pass[..call].contains("old.length > 0"),
            "the call is not conditioned on an old key"
        );
    }

    /// The background engine's half end to end: a commit that gives this account another device,
    /// merged by a manager the push path discards, yields its key exactly once.
    #[test]
    fn a_merged_commit_adding_an_own_device_yields_its_owner_alert() {
        let gid = "notice-group";
        let mut phone = MlsManager::load_or_create("alice", "phone", None).unwrap();
        let laptop = MlsManager::load_or_create("alice", "laptop", None).unwrap();
        let mut bob = MlsManager::load_or_create("bob", "dev1", None).unwrap();
        bob.create_group(gid.to_string()).unwrap();
        let kp = phone.generate_key_package().unwrap();
        let ((_c, welcome, _a, _s), _b) = bob
            .add_members_bulk_with_base(gid, &[&kp], &["alice:phone"])
            .unwrap();
        bob.merge_pending_commit_for(gid).unwrap();
        let tree = bob.export_ratchet_tree_for(gid).unwrap();
        phone
            .process_welcome(welcome.as_deref().unwrap(), Some(&tree))
            .unwrap();
        phone.take_device_events();

        // bob serves the laptop's welcome request; the phone merges that commit in the background.
        let kp = laptop.generate_key_package().unwrap();
        let ((commit, _w, _a, _s), _b) = bob
            .add_members_bulk_with_base(gid, &[&kp], &["alice:laptop"])
            .unwrap();
        bob.merge_pending_commit_for(gid).unwrap();
        phone.process_incoming_message(gid, &commit).unwrap();

        let keys = owner_alert_keys(&mut phone, "alice", "phone");
        assert_eq!(keys.len(), 1, "{keys:?}");
        assert!(keys[0].starts_with("alice:laptop|"), "{keys:?}");
        assert!(owner_alert_keys(&mut phone, "alice", "phone").is_empty());
        // bob, a contact, has no owner alert for it.
        assert!(owner_alert_keys(&mut bob, "bob", "dev1").is_empty());
    }
}
