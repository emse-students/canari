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
fn a_reloaded_state_re_encodes_and_preserves_its_content() {
    // This used to assert BYTE equality, on the strength of the loaded snapshot being handed
    // straight back by the cache. That seeding is gone: it would have pinned a legacy-encoded
    // `mls.bin` in place for ever, since the first save would re-persist the very bytes that were
    // just read (WP-ANR-1). A reload now always re-encodes, so what must hold is that the CONTENT
    // survives - and byte equality could not be asserted anyway, because `storage_values` is an
    // unordered HashMap and the CBOR is not deterministic.
    let mut manager = make_manager("seed-user", "seed-device");
    manager
        .create_group("seed-group".to_string())
        .expect("create");
    manager.generate_key_packages(3).expect("generate kps");

    let snapshot = manager.save_state().expect("initial snapshot");
    let restored = MlsManager::load_or_create("seed-user", "seed-device", Some(snapshot.clone()))
        .expect("restore");

    let resaved = restored.save_state().expect("restored save_state");
    assert_eq!(
        normalized(decode_persisted(&snapshot)),
        normalized(decode_persisted(&resaved))
    );
}

/// The legacy on-disk shape: every byte buffer on serde's generic `Vec<u8>` path, which encodes as
/// a CBOR array of integers. This is what every `mls.bin` in the field was written with.
#[derive(serde::Serialize)]
struct LegacyPersistedState {
    identity_bundle: Vec<u8>,
    storage_values: std::collections::HashMap<Vec<u8>, Vec<u8>>,
    group_ids: Vec<Vec<u8>>,
    forgotten_group_min_epochs: std::collections::HashMap<String, u64>,
}

#[test]
fn a_legacy_encoded_state_still_loads_and_is_migrated_on_save() {
    // The whole compatibility contract, end to end at the manager level: if this fails, shipping
    // the encoding change destroys the identity and every group of every existing install. The
    // unit tests in `byte_compat` cover the framing; this covers a REAL snapshot - keypair,
    // credential, OpenMLS keystore and group ids - going out in the old encoding and coming back
    // through `load_or_create`.
    let mut manager = make_manager("legacy-user", "legacy-device");
    manager
        .create_group("legacy-group".to_string())
        .expect("create");
    manager.generate_key_packages(3).expect("generate kps");
    let modern = decode_persisted(&manager.save_state().expect("snapshot"));

    // Re-encode the very same content the way every shipped version wrote it.
    let legacy = LegacyPersistedState {
        identity_bundle: modern.identity_bundle.clone(),
        storage_values: modern.storage_values.clone(),
        group_ids: modern.group_ids.clone(),
        forgotten_group_min_epochs: modern.forgotten_group_min_epochs.clone(),
    };
    let mut legacy_bytes = Vec::new();
    ciborium::ser::into_writer(&legacy, &mut legacy_bytes).expect("legacy encode");
    assert!(
        legacy_bytes.len() > manager.save_state().expect("snapshot").len(),
        "the legacy encoding must be the larger one, or this fixture is not legacy"
    );

    // It loads - the identity check inside `load_or_create` also proves the keypair and credential
    // survived, since a mangled bundle cannot produce a matching identity string.
    let restored = MlsManager::load_or_create("legacy-user", "legacy-device", Some(legacy_bytes))
        .expect("a legacy snapshot must still load");
    assert_eq!(
        restored.get_known_groups(),
        vec!["legacy-group".to_string()]
    );

    // ...and the next save has migrated it, without losing anything.
    let migrated = restored.save_state().expect("save after legacy load");
    assert_eq!(normalized(decode_persisted(&migrated)), normalized(modern));
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

/// Measures the cost this change exists to remove, on a realistically sized state, so the WP-ANR-1
/// claim rests on a number rather than on a stack trace. Ignored because it is a MEASUREMENT, not
/// an assertion - it takes tens of seconds and its result is a ratio, not a pass/fail.
///
/// `cargo test --release --test state_cache -- --ignored --nocapture legacy_decode`
#[test]
#[ignore = "measurement, not an assertion: run explicitly with --release --nocapture"]
fn legacy_decode_cost_against_the_new_one() {
    use std::time::Instant;

    let mut manager = make_manager("bench-user", "bench-device");
    manager
        .create_group("bench-group".to_string())
        .expect("create");
    // The field prod file is ~2.67 MB in the legacy encoding; key package bundles are the bulk of
    // a real keystore, so this is the closest honest stand-in.
    manager.generate_key_packages(400).expect("generate kps");

    let modern_bytes = manager.save_state().expect("snapshot");
    let modern = decode_persisted(&modern_bytes);
    let legacy = LegacyPersistedState {
        identity_bundle: modern.identity_bundle.clone(),
        storage_values: modern.storage_values.clone(),
        group_ids: modern.group_ids.clone(),
        forgotten_group_min_epochs: modern.forgotten_group_min_epochs.clone(),
    };
    let mut legacy_bytes = Vec::new();
    ciborium::ser::into_writer(&legacy, &mut legacy_bytes).expect("legacy encode");

    let t0 = Instant::now();
    let _ = decode_persisted(&legacy_bytes);
    let legacy_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let _ = decode_persisted(&modern_bytes);
    let modern_ms = t1.elapsed().as_secs_f64() * 1000.0;

    println!(
        "legacy: {} bytes, {legacy_ms:.1} ms | new: {} bytes, {modern_ms:.1} ms | \
         size x{:.2}, time x{:.1}",
        legacy_bytes.len(),
        modern_bytes.len(),
        legacy_bytes.len() as f64 / modern_bytes.len() as f64,
        legacy_ms / modern_ms.max(f64::EPSILON),
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
    let key = [42u8; 32];
    let encrypted = MlsManager::encrypt_state_blob_with_key(&plain, &key).expect("encrypt");
    let restored = MlsManager::load_with_key("enc-user", "enc-device", Some(encrypted), &key)
        .expect("load encrypted");

    manager.invalidate_persisted_snapshot();
    restored.invalidate_persisted_snapshot();
    assert_eq!(
        normalized(decode_persisted(&manager.save_state().expect("manager"))),
        normalized(decode_persisted(&restored.save_state().expect("restored"))),
    );
}
