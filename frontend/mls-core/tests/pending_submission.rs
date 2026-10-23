//! The submission of a staged commit lives in the SAME state as the commit and is written by the
//! SAME call that stages it (`pending_submission.rs`).
//!
//! A commit whose submission got no answer is settled only by resubmitting the same bytes, so
//! those bytes must survive a restart exactly as long as the staged commit does - and never longer,
//! or a later commit would be resubmitted as an earlier one. These pin: no exported state ever
//! holds a recorded stage without its record, the record round-trips, and every way the staged
//! commit ends takes its record with it.
use mls_core::MlsManager;
use mls_core::pending_submission::{PendingSubmission, PendingSubmissionRead};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates `gid` and adds bob; both end at epoch 1.
fn alice_and_bob(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, bob)
}

/// A checkpoint: the bytes a persister would write now.
fn checkpoint(m: &MlsManager) -> Vec<u8> {
    m.save_state().expect("save")
}

/// A crash and a restart from the last checkpoint.
fn restart(saved: Vec<u8>, user: &str) -> MlsManager {
    MlsManager::load_or_create(user, "dev1", Some(saved)).expect("reload")
}

fn recorded(m: &MlsManager, gid: &str) -> PendingSubmission {
    match m.pending_submission(gid) {
        PendingSubmissionRead::Recorded(r) => r,
        other => panic!("expected a recorded submission for {gid}, got {other:?}"),
    }
}

#[test]
fn checkpoint_then_record_then_send_then_crash_resubmits_the_commit_that_was_sent() {
    // THE WINDOW THIS FILE EXISTS FOR. A checkpoint runs while the commit is being staged and
    // submitted; the device sends and is killed before the next checkpoint. Whatever that
    // checkpoint caught, the restarted device must NOT conclude "never sent" about a commit that
    // was: the stage and its record are one call, so every checkpoint that holds the staged commit
    // holds the bytes that were sent with it.
    let gid = "g-window";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let epoch = bob.get_epoch(gid).expect("epoch");

    let before = checkpoint(&bob);
    let sent = bob
        .stage_self_update_recorded(gid, b"intent".to_vec())
        .expect("stage + record");
    let during = checkpoint(&bob);
    // ...the request carrying `sent` leaves, the gate accepts it, and alice applies it...
    alice
        .process_incoming_message(gid, &sent.commit)
        .expect("alice applies bob's commit");
    // ...and bob is killed before any later checkpoint.

    // Restarted from the checkpoint taken during the commit: the staged commit is there WITH the
    // bytes that were sent, so resubmitting them gets the duplicate answer and the merge follows.
    let mut restarted = restart(during, "bob");
    assert_eq!(
        restarted.groups_with_pending_commit(),
        vec![gid.to_string()]
    );
    let again = recorded(&restarted, gid);
    assert_eq!(again, sent, "the record is exactly what was sent");
    assert_eq!(again.base_epoch, epoch);
    assert_eq!(again.intent, b"intent".to_vec());
    restarted
        .merge_pending_commit_for(gid)
        .expect("the accepted commit merges");
    assert_eq!(
        restarted.get_epoch(gid).expect("epoch"),
        alice.get_epoch(gid).expect("alice epoch")
    );

    // Restarted from the checkpoint taken BEFORE the stage: there is no staged commit at all -
    // never one without its record.
    let earlier = restart(before, "bob");
    assert!(earlier.groups_with_pending_commit().is_empty());
    assert_eq!(earlier.pending_submission(gid), PendingSubmissionRead::None);
}

#[test]
fn a_plain_stage_has_no_record_and_reads_as_never_submitted() {
    // The plain stages are for callers that merge at once and never go through the gate.
    let gid = "g-plain";
    let (_alice, mut bob) = alice_and_bob(gid);
    let epoch = bob.get_epoch(gid).expect("epoch");
    bob.stage_self_update(gid).expect("stage");

    let mut restarted = restart(checkpoint(&bob), "bob");
    assert_eq!(
        restarted.groups_with_pending_commit(),
        vec![gid.to_string()]
    );
    assert_eq!(
        restarted.pending_submission(gid),
        PendingSubmissionRead::None
    );
    restarted.clear_pending_commit_for(gid).expect("clear");
    assert_eq!(restarted.get_epoch(gid).expect("epoch"), epoch);
    restarted
        .stage_self_update_recorded(gid, Vec::new())
        .expect("the group takes a commit again");
}

#[test]
fn every_recorded_stage_records_what_it_staged() {
    let gid = "g-kinds";
    let (alice, mut bob) = alice_and_bob(gid);
    let carol = make_device("carol", "dev1");
    let kp = carol.generate_key_package().expect("kp carol");

    let (add, skipped) = bob
        .add_members_recorded(
            gid,
            &[b"garbage", &kp],
            &["carol:dev0", "carol:dev1"],
            b"add".to_vec(),
        )
        .expect("add");
    assert_eq!(add.added_indices, vec![1]);
    assert_eq!(skipped.len(), 1);
    assert!(
        !add.welcome.is_empty(),
        "an Add's record carries its Welcome"
    );
    assert_eq!(recorded(&bob, gid), add);
    bob.clear_pending_commit_for(gid).expect("clear add");

    let by_user = bob
        .remove_members_for_users_recorded(gid, &["alice"], b"ru".to_vec())
        .expect("remove user");
    assert!(by_user.welcome.is_empty());
    assert_eq!(recorded(&bob, gid), by_user);
    bob.clear_pending_commit_for(gid).expect("clear");

    let by_device = bob
        .remove_members_for_devices_recorded(gid, &["alice:dev1"], b"rd".to_vec())
        .expect("remove device");
    assert_eq!(recorded(&bob, gid), by_device);
    bob.clear_pending_commit_for(gid).expect("clear");

    // A replacement goes through the gate like any commit, so it is recorded like one - with its
    // Welcome, which a settled replacement owes the device it re-admits - and survives a restart.
    let kp_alice = alice.generate_key_package().expect("kp alice");
    let replace = bob
        .replace_device_recorded(gid, "alice:dev1", &kp_alice, b"rp".to_vec())
        .expect("replace");
    assert!(
        !replace.welcome.is_empty(),
        "a replacement's record carries its Welcome"
    );
    assert!(replace.added_indices.is_empty());
    assert_eq!(recorded(&bob, gid), replace);
    assert_eq!(recorded(&restart(checkpoint(&bob), "bob"), gid), replace);
}

#[test]
fn a_refused_stage_records_nothing() {
    let gid = "g-refused";
    let (_alice, mut bob) = alice_and_bob(gid);
    assert!(
        bob.remove_members_for_devices_recorded(gid, &["nobody:dev"], b"x".to_vec())
            .is_err()
    );
    assert!(bob.groups_with_pending_commit().is_empty());
    assert_eq!(bob.pending_submission(gid), PendingSubmissionRead::None);
}

#[test]
fn the_merge_and_the_clear_each_take_the_record_with_the_commit() {
    let gid = "g-ends";
    let (_alice, mut bob) = alice_and_bob(gid);

    bob.stage_self_update_recorded(gid, b"one".to_vec())
        .expect("stage");
    bob.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(bob.pending_submission(gid), PendingSubmissionRead::None);

    bob.stage_self_update(gid).expect("plain stage");
    assert_eq!(
        bob.pending_submission(gid),
        PendingSubmissionRead::None,
        "a new staged commit never inherits an earlier record"
    );
    bob.clear_pending_commit_for(gid).expect("clear plain");

    bob.stage_self_update_recorded(gid, b"two".to_vec())
        .expect("stage");
    bob.clear_pending_commit_for(gid).expect("clear");
    assert_eq!(bob.pending_submission(gid), PendingSubmissionRead::None);
    assert_eq!(
        restart(checkpoint(&bob), "bob").pending_submission(gid),
        PendingSubmissionRead::None
    );
}

#[test]
fn another_members_commit_ends_ours_and_its_record_is_neither_served_nor_saved() {
    // alice's commit at the same epoch took it: processing it clears bob's staged commit, so the
    // record describes a commit that no longer exists.
    let gid = "g-lost";
    let (mut alice, mut bob) = alice_and_bob(gid);
    bob.stage_self_update_recorded(gid, b"bob's".to_vec())
        .expect("bob stages");
    let (alice_commit, _base) = alice.stage_self_update(gid).expect("alice stages");
    alice.merge_pending_commit_for(gid).expect("alice merges");
    bob.process_incoming_message(gid, &alice_commit)
        .expect("bob applies alice's commit");

    assert!(bob.groups_with_pending_commit().is_empty());
    assert_eq!(bob.pending_submission(gid), PendingSubmissionRead::None);
    assert_eq!(
        restart(checkpoint(&bob), "bob").pending_submission(gid),
        PendingSubmissionRead::None
    );
}

#[test]
fn a_forgotten_group_leaves_no_record() {
    let gid = "g-forget";
    let (_alice, mut bob) = alice_and_bob(gid);
    bob.stage_self_update_recorded(gid, b"s".to_vec())
        .expect("stage");
    bob.forget_group(gid, 0);
    assert!(bob.groups_with_pending_commit().is_empty());
    assert_eq!(bob.pending_submission(gid), PendingSubmissionRead::None);
}
