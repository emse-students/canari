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
        let key = event.notice_key();
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

/// The marker file name of `key`: its bytes in hex, so `:` and `|` never reach a path.
fn marker_name(key: &str) -> String {
    key.bytes().map(|b| format!("{b:02x}")).collect()
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
            Err(e) => {
                log::error!("[DEVICE_NOTICE] marker for {key} not written, not announced: {e}")
            }
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

/// The name prefix of a WITHDRAWN-event marker in the ledger directory - kept apart from the claim
/// markers, which never carry it (their names are hex).
const WITHDRAWN_PREFIX: &str = "w-";

/// The id an event is withdrawn by: the group, the epoch the commit created, and the device - one
/// commit, one admission. The app builds the same id (`deviceEventId`).
pub fn device_event_id(event: &mls_core::DeviceEvent) -> String {
    format!("{}|{}|{}", event.group_id, event.epoch, event.identity)
}

/// WITHDRAWS the events a background Add recorded when the server then REFUSED its commit: nobody
/// merged it, so it admitted nobody, and the app must not announce what it recorded. One marker per
/// id beside the claim ledger; the app takes them ([`take_withdrawn_device_events`]) before it
/// announces anything. Returns how many were written; a payload that is not an array of strings
/// writes nothing, logged.
pub fn withdraw_device_events_json(data_dir: &Path, ids_json: &str) -> usize {
    let ids: Vec<String> = match serde_json::from_str(ids_json) {
        Ok(ids) => ids,
        Err(e) => {
            log::error!("[DEVICE_NOTICE] withdrawal payload is not a JSON array of strings: {e}");
            return 0;
        }
    };
    let dir = data_dir.join(DEVICE_NOTICES_DIR);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!(
            "[DEVICE_NOTICE] ledger directory unavailable, {} event(s) NOT withdrawn: {e}",
            ids.len()
        );
        return 0;
    }
    let mut written = 0;
    for id in &ids {
        match std::fs::write(
            dir.join(format!("{WITHDRAWN_PREFIX}{}", marker_name(id))),
            b"",
        ) {
            Ok(()) => written += 1,
            Err(e) => log::error!("[DEVICE_NOTICE] event {id} NOT withdrawn: {e}"),
        }
    }
    log::info!("[DEVICE_NOTICE] {written} event(s) of a refused Add withdrawn");
    prune(&dir, true);
    written
}

/// Takes every withdrawn event id (and removes its marker): the app reads them once, before it
/// announces anything from the events the background Add left in the state.
pub fn take_withdrawn_device_events(data_dir: &Path) -> Vec<String> {
    let dir = data_dir.join(DEVICE_NOTICES_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(hex) = name.strip_prefix(WITHDRAWN_PREFIX) else {
            continue;
        };
        let bytes: Option<Vec<u8>> = (0..hex.len())
            .step_by(2)
            .map(|i| {
                hex.get(i..i + 2)
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
            })
            .collect();
        match bytes.and_then(|b| String::from_utf8(b).ok()) {
            Some(id) => ids.push(id),
            None => log::error!("[DEVICE_NOTICE] unreadable withdrawal marker {name} dropped"),
        }
        if let Err(e) = std::fs::remove_file(entry.path()) {
            log::warn!("[DEVICE_NOTICE] withdrawal marker {name} not removed: {e}");
        }
    }
    if !ids.is_empty() {
        log::info!("[DEVICE_NOTICE] {} withdrawn event(s) taken", ids.len());
    }
    ids
}

/// Keeps the newest [`MAX_DEVICE_NOTICE_MARKERS`] claim markers.
fn prune_markers(dir: &Path) {
    prune(dir, false);
}

/// Keeps the newest [`MAX_DEVICE_NOTICE_MARKERS`] markers of one kind - withdrawals or claims - so
/// neither bound ever removes the other kind.
fn prune(dir: &Path, withdrawals: bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut markers: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(WITHDRAWN_PREFIX)
                == withdrawals
        })
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

    /// An Add the server REFUSED admitted nobody: the events it recorded are withdrawn, and the app
    /// takes each withdrawal once - apart from the claim ledger and its bound.
    #[test]
    fn a_withdrawn_event_is_taken_once_and_never_counts_as_a_claim() {
        let dir = temp_dir("withdraw");
        let ids = vec!["g|4|alice:laptop".to_string(), "g|4|bob:web".to_string()];
        assert_eq!(
            withdraw_device_events_json(&dir, &serde_json::to_string(&ids).unwrap()),
            2
        );
        let keys: Vec<String> = (0..MAX_DEVICE_NOTICE_MARKERS)
            .map(|i| format!("u:d{i}|ff"))
            .collect();
        claim_device_notices(&dir, &keys);
        let mut taken = take_withdrawn_device_events(&dir);
        taken.sort();
        assert_eq!(taken, ids, "the claim bound pruned no withdrawal");
        assert!(take_withdrawn_device_events(&dir).is_empty());
        assert_eq!(
            claim_device_notices(&dir, &["u:d0|ff".to_string()]),
            Vec::<String>::new(),
            "a withdrawal never removed a claim"
        );
        assert_eq!(withdraw_device_events_json(&dir, "{}"), 0);
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
