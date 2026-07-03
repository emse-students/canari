//! Tests for `MlsManager` CBOR snapshot cache (Phase 3 S2/S3).

use ciborium::de::from_reader;
use mls_core::{MlsManager, PersistedState};

fn make_manager(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("make_manager({user_id}:{device_id}): {e}"))
}

fn decode_persisted(bytes: &[u8]) -> PersistedState {
    from_reader(bytes).expect("decode persisted MLS state")
}

fn normalized(mut state: PersistedState) -> PersistedState {
    state.group_ids.sort();
    state
}

#[test]
fn save_state_returns_identical_bytes_when_state_unchanged() {
    let mut manager = make_manager("cache-user", "cache-device");
    manager
        .create_group("cache-group".to_string())
        .expect("create_group");

    let first = manager.save_state().expect("first save_state");
    let second = manager.save_state().expect("cached save_state");
    assert_eq!(first, second);
}

#[test]
fn save_state_rebuilds_after_mutation() {
    let mut alice = make_manager("cache-alice", "dev-a");
    let mut bob = make_manager("cache-bob", "dev-b");
    let group_id = "cache-dm";

    alice
        .create_group(group_id.to_string())
        .expect("alice create_group");
    let kp = bob.generate_key_package().expect("bob key_package");
    let (_commit, welcome, _added, _skipped) = alice
        .add_members_bulk(group_id, &[&kp])
        .expect("add_members_bulk");
    // Stage-only add (C7-A): merge as if the server accepted, then export the post-merge tree.
    alice
        .merge_pending_commit_for(group_id)
        .expect("merge add commit");
    let ratchet_tree = alice
        .export_ratchet_tree_for(group_id)
        .expect("export ratchet tree");
    bob.process_welcome(welcome.as_deref().expect("welcome"), Some(&ratchet_tree))
        .expect("bob process_welcome");

    let before = alice.save_state().expect("save before send");
    bob.send_message(group_id, b"hello").expect("send");
    alice
        .process_incoming_message(group_id, &bob.send_message(group_id, b"ping").unwrap())
        .expect("decrypt");

    let after = alice.save_state().expect("save after decrypt");
    assert_ne!(before, after);
}

/// Guards the cache invariant: each kind of mutation must invalidate the snapshot so the
/// next save_state rebuilds. A regression here means a mutation forgot mark_state_dirty.
#[test]
fn each_mutation_invalidates_the_snapshot() {
    let mut manager = make_manager("mut-user", "mut-device");
    manager
        .create_group("mut-group".to_string())
        .expect("create_group");

    // send_message advances the sender ratchet -> snapshot must change.
    let before_send = manager.save_state().expect("save before send");
    manager.send_message("mut-group", b"hello").expect("send");
    let after_send = manager.save_state().expect("save after send");
    assert_ne!(before_send, after_send, "send_message must invalidate");

    // generate_key_package writes a key package bundle to storage.
    let before_kp = after_send;
    manager.generate_key_package().expect("kp");
    let after_kp = manager.save_state().expect("save after kp");
    assert_ne!(before_kp, after_kp, "generate_key_package must invalidate");

    // forget_group records a min-epoch -> mutates forgotten_group_min_epochs.
    let before_forget = after_kp;
    manager.forget_group("mut-group", 0);
    let after_forget = manager.save_state().expect("save after forget");
    assert_ne!(before_forget, after_forget, "forget_group must invalidate");
}

#[test]
fn loaded_state_seeds_cache_without_reserialize() {
    let mut manager = make_manager("seed-user", "seed-device");
    manager
        .create_group("seed-group".to_string())
        .expect("create");
    manager.generate_key_packages(3).expect("generate kps");

    let snapshot = manager.save_state().expect("initial snapshot");
    let restored = MlsManager::load_or_create("seed-user", "seed-device", Some(snapshot.clone()))
        .expect("restore");

    let from_cache = restored.save_state().expect("restored save_state");
    assert_eq!(snapshot, from_cache);
}

#[test]
fn cold_serialize_round_trips_through_load_or_create() {
    let mut manager = make_manager("roundtrip-user", "roundtrip-device");
    manager
        .create_group("roundtrip-group".to_string())
        .expect("create_group");
    manager.generate_key_packages(10).expect("generate kps");

    manager.invalidate_persisted_snapshot();
    let snapshot = manager.save_state().expect("cold save_state");
    let restored = MlsManager::load_or_create("roundtrip-user", "roundtrip-device", Some(snapshot))
        .expect("restore from cold snapshot");

    let mut manager_groups = manager.get_known_groups();
    manager_groups.sort();
    let mut restored_groups = restored.get_known_groups();
    restored_groups.sort();
    assert_eq!(
        manager_groups, restored_groups,
        "group ids must match after round-trip"
    );

    manager.invalidate_persisted_snapshot();
    restored.invalidate_persisted_snapshot();
    assert_eq!(
        normalized(decode_persisted(
            &manager.save_state().expect("manager snapshot")
        )),
        normalized(decode_persisted(
            &restored.save_state().expect("restored snapshot")
        )),
        "rebuilt persisted state must be equivalent after round-trip"
    );
}

#[test]
fn encrypt_state_blob_round_trip() {
    let mut manager = make_manager("enc-user", "enc-device");
    manager
        .create_group("enc-group".to_string())
        .expect("create_group");

    manager.invalidate_persisted_snapshot();
    let plain = manager.save_state().expect("plain snapshot");
    let encrypted = MlsManager::encrypt_state_blob(&plain, "4242").expect("encrypt");
    let restored = MlsManager::load_encrypted("enc-user", "enc-device", Some(encrypted), "4242")
        .expect("load encrypted");

    manager.invalidate_persisted_snapshot();
    restored.invalidate_persisted_snapshot();
    assert_eq!(
        normalized(decode_persisted(&manager.save_state().expect("manager"))),
        normalized(decode_persisted(&restored.save_state().expect("restored"))),
    );
}
