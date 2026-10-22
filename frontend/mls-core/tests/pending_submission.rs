//! The submission of a staged commit lives in the SAME state as the commit (`pending_submission.rs`).
//!
//! A commit whose submission got no answer is settled only by resubmitting the same bytes, so
//! those bytes must survive a restart exactly as long as the staged commit does - and never longer,
//! or a later commit would be resubmitted as an earlier one. One snapshot holds both, which is what
//! these pin: the pair round-trips, a pending commit with no submission reads as never sent, and
//! every way the staged commit ends takes its submission with it.
use mls_core::{MlsError, MlsManager};

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

fn reload(m: &MlsManager, user: &str) -> MlsManager {
    let saved = m.save_state().expect("save");
    MlsManager::load_or_create(user, "dev1", Some(saved)).expect("reload")
}

#[test]
fn a_submission_needs_a_staged_commit_to_belong_to() {
    let (_alice, mut bob) = alice_and_bob("g-none");
    assert!(matches!(
        bob.record_pending_submission("g-none", b"s".to_vec()),
        Err(MlsError::InvalidData)
    ));
    assert!(matches!(
        bob.record_pending_submission("nope", b"s".to_vec()),
        Err(MlsError::GroupNotFound(_))
    ));
    assert_eq!(bob.pending_submission("g-none"), None);
}

#[test]
fn the_staged_commit_and_its_submission_survive_a_restart_together() {
    let gid = "g-pair";
    let (_alice, mut bob) = alice_and_bob(gid);
    bob.stage_self_update(gid).expect("stage");
    bob.record_pending_submission(gid, b"submission".to_vec())
        .expect("record");

    let reloaded = reload(&bob, "bob");
    assert_eq!(reloaded.groups_with_pending_commit(), vec![gid.to_string()]);
    assert_eq!(
        reloaded.pending_submission(gid).as_deref(),
        Some(&b"submission"[..])
    );
}

#[test]
fn a_restart_between_the_checkpoint_and_the_record_finds_a_commit_that_was_never_sent() {
    // The checkpoint landed after the stage and before the submission was recorded - which the
    // client does BEFORE its first request. So the reloaded device holds a staged commit with no
    // submission, which means it never left: clearing it is the definitive answer, and the group
    // takes commits again.
    let gid = "g-crash";
    let (_alice, mut bob) = alice_and_bob(gid);
    let epoch = bob.get_epoch(gid).expect("epoch");
    bob.stage_self_update(gid).expect("stage");

    let mut reloaded = reload(&bob, "bob");
    assert_eq!(reloaded.groups_with_pending_commit(), vec![gid.to_string()]);
    assert_eq!(reloaded.pending_submission(gid), None);
    reloaded.clear_pending_commit_for(gid).expect("clear");
    assert!(reloaded.groups_with_pending_commit().is_empty());
    assert_eq!(reloaded.get_epoch(gid).expect("epoch"), epoch);
    reloaded
        .stage_self_update(gid)
        .expect("the group takes a commit again");
}

#[test]
fn the_merge_and_the_clear_each_take_the_submission_with_the_commit() {
    let gid = "g-ends";
    let (_alice, mut bob) = alice_and_bob(gid);

    bob.stage_self_update(gid).expect("stage");
    bob.record_pending_submission(gid, b"one".to_vec())
        .expect("record");
    bob.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(bob.pending_submission(gid), None);

    bob.stage_self_update(gid).expect("stage again");
    assert_eq!(
        bob.pending_submission(gid),
        None,
        "a new staged commit never inherits an earlier submission"
    );
    bob.record_pending_submission(gid, b"two".to_vec())
        .expect("record");
    bob.clear_pending_commit_for(gid).expect("clear");
    assert_eq!(bob.pending_submission(gid), None);
    assert_eq!(reload(&bob, "bob").pending_submission(gid), None);
}

#[test]
fn another_members_commit_ends_ours_and_its_submission_is_neither_served_nor_saved() {
    // alice's commit at the same epoch took it: processing it clears bob's staged commit, so the
    // submission describes a commit that no longer exists.
    let gid = "g-lost";
    let (mut alice, mut bob) = alice_and_bob(gid);
    bob.stage_self_update(gid).expect("bob stages");
    bob.record_pending_submission(gid, b"bob's".to_vec())
        .expect("record");
    let (alice_commit, _base) = alice.stage_self_update(gid).expect("alice stages");
    alice.merge_pending_commit_for(gid).expect("alice merges");
    bob.process_incoming_message(gid, &alice_commit)
        .expect("bob applies alice's commit");

    assert!(bob.groups_with_pending_commit().is_empty());
    assert_eq!(bob.pending_submission(gid), None);
    let reloaded = reload(&bob, "bob");
    assert_eq!(reloaded.pending_submission(gid), None);
}

#[test]
fn a_forgotten_group_leaves_no_submission() {
    let gid = "g-forget";
    let (_alice, mut bob) = alice_and_bob(gid);
    bob.stage_self_update(gid).expect("stage");
    bob.record_pending_submission(gid, b"s".to_vec())
        .expect("record");
    bob.forget_group(gid, 0);
    assert!(bob.groups_with_pending_commit().is_empty());
    assert_eq!(bob.pending_submission(gid), None);
}
