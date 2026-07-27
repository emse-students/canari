//! Tests for the epoch-monotonic reload invariant (`reload_is_monotonic`, C2): a reloaded snapshot
//! must never regress a live group's epoch, nor make a live group disappear. Native mirror of
//! `swapClientMonotonic` on the WASM/TS side.
use mls_core::MlsManager;

fn make(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).expect("make manager")
}

fn restore(user: &str, dev: &str, snapshot: Vec<u8>) -> MlsManager {
    MlsManager::load_or_create(user, dev, Some(snapshot)).expect("restore manager")
}

#[test]
fn refuses_a_snapshot_that_regresses_a_live_group_epoch() {
    let mut alice = make("rel-alice", "dev1");
    let bob = make("rel-bob", "dev1");
    let gid = "g-reload";
    alice.create_group(gid.to_string()).expect("create");

    // epoch 1: add bob (stage + merge).
    let kp = bob.generate_key_package().expect("kp");
    alice.add_members_bulk(gid, &[&kp]).expect("stage add");
    alice.merge_pending_commit_for(gid).expect("merge add");
    let snapshot_e1 = alice.save_state().expect("snapshot e1");
    assert_eq!(alice.get_epoch(gid).unwrap(), 1);

    // epoch 2: remove bob (stage + merge).
    alice
        .remove_members_for_devices(gid, &["rel-bob:dev1"])
        .expect("stage remove");
    alice.merge_pending_commit_for(gid).expect("merge remove");
    assert_eq!(alice.get_epoch(gid).unwrap(), 2);

    let candidate_e1 = restore("rel-alice", "dev1", snapshot_e1);

    // Live epoch 2 vs candidate epoch 1 -> regression -> refused.
    assert!(
        !alice.reload_is_monotonic(&candidate_e1),
        "an older snapshot (lower epoch) must be refused"
    );
    // The other way round (candidate epoch 1 reloading a live epoch 2) is an advance -> allowed.
    assert!(
        candidate_e1.reload_is_monotonic(&alice),
        "a reload to a higher or equal epoch must be allowed"
    );
}

#[test]
fn refuses_a_snapshot_missing_a_live_group() {
    let mut alice = make("rel-alice2", "dev1");
    let gid = "g-reload2";
    // Snapshot taken BEFORE the group is created (no group at all).
    let snapshot_empty = alice.save_state().expect("empty snapshot");
    alice.create_group(gid.to_string()).expect("create");
    assert_eq!(alice.get_epoch(gid).unwrap(), 0);

    let candidate_empty = restore("rel-alice2", "dev1", snapshot_empty);
    // The live manager holds gid@0; the candidate does not know gid -> disappearance -> refused.
    assert!(
        !alice.reload_is_monotonic(&candidate_empty),
        "a snapshot that loses a live group must be refused"
    );
}

#[test]
fn allows_an_equal_snapshot() {
    let mut alice = make("rel-alice3", "dev1");
    let gid = "g-reload3";
    alice.create_group(gid.to_string()).expect("create");
    let snapshot = alice.save_state().expect("snapshot");
    let candidate = restore("rel-alice3", "dev1", snapshot);
    // Same epoch on both sides -> monotonic (>=) -> allowed.
    assert!(alice.reload_is_monotonic(&candidate));
}
