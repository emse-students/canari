//! Tests for the validate-then-merge flow (C7 Option A) on the unified ADD + REMOVE regime.
//!
//! `add_members_bulk` and `remove_members_for_*` now *stage* the commit without merging it. The
//! caller confirms it (`merge_pending_commit_for`) once the server accepts, or clears it
//! (`clear_pending_commit_for`) on rejection. Invariant: while the commit is unconfirmed the local
//! epoch does not advance - so a server rejection never leaves the device on a forked branch
//! (neither for an ADD nor for a REMOVE).
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates a group and adds bob to it (stage-only add C7-A, then merge). Shared setup.
fn group_with_alice_bob() -> (MlsManager, &'static str) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-pending";
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, gid)
}

#[test]
fn remove_stages_without_advancing_epoch_then_confirm_merges() {
    let (mut alice, gid) = group_with_alice_bob();
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    // Stage bob's removal: the local epoch MUST NOT advance (commit not merged).
    let _commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage remove");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "staging must not advance the epoch (validate-then-merge)"
    );

    // Confirm (the server accepted): the epoch finally advances by exactly 1.
    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before + 1,
        "confirming must advance the epoch by exactly 1"
    );
}

#[test]
fn remove_abort_keeps_epoch_and_allows_a_fresh_commit() {
    let (mut alice, gid) = group_with_alice_bob();
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    // Stage then CLEAR (the server rejected): no fork, epoch unchanged.
    let _commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage remove");
    alice.clear_pending_commit_for(gid).expect("abort");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "aborting must leave the epoch unchanged (no fork)"
    );

    // After an abort no pending commit blocks anything: we can re-stage then confirm.
    let _commit2 = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("re-stage remove after abort");
    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before + 1,
        "a commit confirmed after an abort must advance the epoch normally"
    );
}

#[test]
fn remove_by_device_stage_confirm_advances_epoch() {
    let (mut alice, gid) = group_with_alice_bob();
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    let _commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage remove device");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "staging a per-device removal must not advance the epoch"
    );

    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(alice.get_epoch(gid).expect("epoch"), epoch_before + 1);
}

#[test]
fn add_stages_without_advancing_epoch_then_confirm_merges() {
    let mut alice = make_device("alice-add", "dev1");
    let bob = make_device("bob-add", "dev1");
    let gid = "g-pending-add";
    alice.create_group(gid.to_string()).expect("create_group");
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    // Stage bob's addition: the local epoch MUST NOT advance (commit not merged).
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let _staged = alice.add_members_bulk(gid, &[&kp_bob]).expect("stage add");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "staging an add must not advance the epoch (validate-then-merge)"
    );

    // Confirm (the server accepted): the epoch finally advances by exactly 1.
    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before + 1,
        "confirming must advance the epoch by exactly 1"
    );
}

#[test]
fn add_abort_keeps_epoch_and_allows_a_fresh_commit() {
    let mut alice = make_device("alice-add2", "dev1");
    let bob = make_device("bob-add2", "dev1");
    let gid = "g-pending-add-abort";
    alice.create_group(gid.to_string()).expect("create_group");
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    // Stage then CLEAR (the server rejected): no fork, epoch unchanged.
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let _staged = alice.add_members_bulk(gid, &[&kp_bob]).expect("stage add");
    alice.clear_pending_commit_for(gid).expect("abort");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "aborting must leave the epoch unchanged (no fork)"
    );

    // After an abort a new add can be staged then confirmed normally.
    let kp_bob2 = bob.generate_key_package().expect("kp bob 2");
    let _staged2 = alice
        .add_members_bulk(gid, &[&kp_bob2])
        .expect("re-stage add");
    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before + 1,
        "an add confirmed after an abort must advance the epoch normally"
    );
}
