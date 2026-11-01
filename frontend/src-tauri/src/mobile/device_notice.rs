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
//!
//! Every engine reads the event from a SIGNED commit it merged, never from a server message: a
//! server that stays silent cannot silence the alert.
//!
//! The ledger lives where both engines of a platform can reach it: the app data directory on
//! Android (one process), the App Group container on iOS (the app and its extension).

use std::path::Path;

use mls_core::MlsManager;

/// The directory, inside the shared data directory, that holds one marker per announced key -
/// swept with the account's other push files when the account is deleted.
pub(crate) use crate::commands::push::DEVICE_NOTICES_DIR;

/// The most markers kept. Past it the OLDEST are removed: a key that old was announced long ago,
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

/// The longest file name the filesystems the ledger lives on accept (ext4/f2fs on Android, APFS on
/// iOS): 255 bytes.
const MAX_FILE_NAME_BYTES: usize = 255;

/// The marker file name of `key`: the SHA-256 of its bytes, in hex - 64 characters whatever the
/// key, so `:` and `|` never reach a path and no key can name a file the filesystem refuses.
///
/// Before 1.6.1 the name was the whole key in hex ([`legacy_marker_name`]), twice the key's length:
/// a production key (`userId:deviceId|fingerprint`) runs to ~160 bytes, its name to ~320, and
/// every claim failed with `File name too long (os error 36)` - so no background engine announced
/// a new device, and no key the app showed was claimed, from 1.4.1-alpha.2 on.
fn marker_name(key: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The marker name builds before 1.6.1 wrote: the key's bytes in hex. Read, never written - see
/// [`announced_by_an_older_build`].
fn legacy_marker_name(key: &str) -> String {
    key.bytes().map(|b| format!("{b:02x}")).collect()
}

/// Whether a build before 1.6.1 already announced `key`. Such a marker can exist only for a key of
/// at most 127 bytes: a longer key's hex name was refused by the filesystem, so it was NEVER
/// written and there is nothing to read. A short key's marker is honoured so the upgrade announces
/// nothing twice (`docs/wiki/legacy-compatibility.md`, "a device-notice marker named by the key in
/// hex").
fn announced_by_an_older_build(dir: &Path, key: &str) -> bool {
    let name = legacy_marker_name(key);
    name.len() <= MAX_FILE_NAME_BYTES && dir.join(name).exists()
}

/// Claims each key in the ledger under `data_dir` and returns the keys THIS call claimed - the ones
/// nobody announced before. A key already claimed is not returned; a key whose marker could not be
/// written for another reason is logged and NOT returned, since nothing would then stop a second
/// announcement of it.
pub fn claim_device_notices(data_dir: &Path, keys: &[String]) -> Vec<String> {
    let dir = data_dir.join(DEVICE_NOTICES_DIR);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!(
            "[DEVICE_NOTICE] ledger directory unavailable, {} notice(s) not announced: {e}",
            keys.len()
        );
        return Vec::new();
    }
    let mut claimed = Vec::new();
    for key in keys {
        if announced_by_an_older_build(&dir, key) {
            log::debug!("[DEVICE_NOTICE] already announced by an older build: {key}");
            continue;
        }
        let path = dir.join(marker_name(key));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => claimed.push(key.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                log::debug!("[DEVICE_NOTICE] already announced: {key}");
            }
            Err(e) => log::error!(
                "[DEVICE_NOTICE] marker {} for {key} not written, not announced: {e}",
                path.display()
            ),
        }
    }
    if !claimed.is_empty() {
        prune_markers(&dir);
    }
    claimed
}

/// [`claim_device_notices`] over JSON arrays of strings, for the JNI and C-FFI entry points. A
/// payload that is not an array of strings claims nothing and answers `[]`, logged.
pub fn claim_device_notices_json(data_dir: &Path, keys_json: &str) -> String {
    let keys: Vec<String> = match serde_json::from_str(keys_json) {
        Ok(k) => k,
        Err(e) => {
            log::error!("[DEVICE_NOTICE] keys payload is not a JSON array of strings: {e}");
            return "[]".to_string();
        }
    };
    serde_json::to_string(&claim_device_notices(data_dir, &keys)).unwrap_or_else(|e| {
        log::error!("[DEVICE_NOTICE] claimed keys not serialisable: {e}");
        "[]".to_string()
    })
}

/// Keeps the newest [`MAX_DEVICE_NOTICE_MARKERS`] claim markers.
fn prune_markers(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut markers: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .filter_map(Result::ok)
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

    #[test]
    fn a_key_is_claimed_once_whoever_asks_again() {
        let dir = temp_dir("once");
        let keys = vec!["bob:web-2|00ff".to_string(), "bob:web-3|11ee".to_string()];
        assert_eq!(claim_device_notices(&dir, &keys), keys);
        assert!(
            claim_device_notices(&dir, &keys).is_empty(),
            "a replay announces nothing"
        );
        assert_eq!(
            claim_device_notices_json(&dir, r#"["bob:web-2|00ff","bob:web-4|22dd"]"#),
            r#"["bob:web-4|22dd"]"#
        );
    }

    #[test]
    fn a_payload_that_is_not_a_list_of_keys_claims_nothing() {
        let dir = temp_dir("bad");
        assert_eq!(claim_device_notices_json(&dir, "{}"), "[]");
        assert!(!dir.join(DEVICE_NOTICES_DIR).exists());
    }

    #[test]
    fn the_ledger_is_bounded() {
        let dir = temp_dir("bound");
        let keys: Vec<String> = (0..MAX_DEVICE_NOTICE_MARKERS + 5)
            .map(|i| format!("u:d{i}|ff"))
            .collect();
        claim_device_notices(&dir, &keys);
        let count = std::fs::read_dir(dir.join(DEVICE_NOTICES_DIR))
            .unwrap()
            .count();
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
        assert!(
            legacy_marker_name(&a).len() > MAX_FILE_NAME_BYTES,
            "the shape that failed"
        );
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
        assert!(dir
            .join(DEVICE_NOTICES_DIR)
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
        let ledger = dir.join(DEVICE_NOTICES_DIR);
        std::fs::create_dir_all(&ledger).unwrap();
        std::fs::write(ledger.join(legacy_marker_name(&key)), b"").unwrap();
        assert!(claim_device_notices(&dir, std::slice::from_ref(&key)).is_empty());
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
