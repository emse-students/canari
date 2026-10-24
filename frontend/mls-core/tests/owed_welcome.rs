//! An Add's Welcome owed after a settlement is durable state (`owed_welcome.rs`), and a joiner that
//! receives the same Welcome twice ignores the second one.
//!
//! A settlement merges a kept Add the gate accepted and then sends its Welcome. A reload between
//! the send and the next checkpoint would settle the Add again and send the Welcome again, so the
//! owed Welcome is written into the state BY THE MERGE, checkpointed, sent, and only then cleared:
//! a reload re-sends at most what was not yet cleared, and the joiner must take a second copy of a
//! Welcome it already processed as a no-op.
use mls_core::MlsManager;
use mls_core::pending_submission::PendingSubmissionRead;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

fn restart(m: &MlsManager, user: &str) -> MlsManager {
    let saved = m.save_state().expect("save");
    MlsManager::load_or_create(user, "dev1", Some(saved)).expect("reload")
}

/// The client never hands the core a Welcome for a group it holds: `setupMessageHandler` answers
/// it as a redelivery first, with a log line, on both the conversation and the key-group path
/// (`setupMessageHandler.test.ts`, "Welcome redelivered for already-held group" and "a redelivery
/// for a held, live key group"). This pins the floor under that gate: should a second copy reach
/// the core anyway, it is refused - its key package was spent by the first - and the group is left
/// exactly as it was.
#[test]
fn a_second_copy_of_a_processed_welcome_leaves_the_joiners_group_untouched() {
    let gid = "g-twice";
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    let (_c, welcome, _a, _s) = alice.add_members_bulk(gid, &[&kp]).expect("add");
    alice.merge_pending_commit_for(gid).expect("merge");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    let welcome = welcome.expect("welcome");

    assert_eq!(
        bob.process_welcome(&welcome, Some(&tree)).expect("first"),
        gid
    );
    let epoch = bob.get_epoch(gid).expect("epoch");
    let before = bob.save_state().expect("save");
    assert!(bob.process_welcome(&welcome, Some(&tree)).is_err());
    assert_eq!(bob.get_epoch(gid).expect("epoch"), epoch);
    assert!(bob.is_group_active(gid).expect("active"));

    // ...and the same after a restart, where nothing in memory remembers the first one.
    let mut bob = MlsManager::load_or_create("bob", "dev1", Some(before)).expect("reload");
    assert!(bob.process_welcome(&welcome, Some(&tree)).is_err());
    assert_eq!(bob.get_epoch(gid).expect("epoch"), epoch);

    // Still a working member: it reads what alice sends at that epoch.
    let frame = alice.send_message(gid, b"hello").expect("send");
    assert!(bob.process_incoming_message(gid, &frame).is_ok());
}

#[test]
fn the_merge_of_a_settled_add_writes_the_owed_welcome_and_a_delivery_clears_it() {
    let gid = "g-owed";
    let mut alice = make_device("alice", "dev1");
    let bob = make_device("bob", "dev1");
    let carol = make_device("carol", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    let kp_b = bob.generate_key_package().expect("kp b");
    let kp_c = carol.generate_key_package().expect("kp c");
    let (staged, _skipped) = alice
        .add_members_recorded(
            gid,
            &[&kp_b, &kp_c],
            &["bob:dev1", "carol:dev1"],
            b"intent".to_vec(),
        )
        .expect("stage");

    alice
        .merge_pending_commit_owing_welcome(
            gid,
            vec!["bob:dev1".to_string(), "carol:dev1".to_string()],
        )
        .expect("merge owing the Welcome");
    assert_eq!(alice.get_epoch(gid).expect("epoch"), 1);
    assert_eq!(alice.pending_submission(gid), PendingSubmissionRead::None);

    // Durable: a restart before any delivery still owes both.
    let mut alice = restart(&alice, "alice");
    let owed = alice.owed_welcomes();
    assert_eq!(owed.len(), 1);
    assert_eq!(owed[0].group_id, gid);
    assert_eq!(owed[0].welcome, staged.welcome);
    assert_eq!(
        owed[0].ratchet_tree,
        alice.export_ratchet_tree_for(gid).expect("tree")
    );
    assert_eq!(owed[0].recipients, vec!["bob:dev1", "carol:dev1"]);

    alice.welcome_delivered(gid, "bob:dev1");
    let alice = restart(&alice, "alice");
    assert_eq!(alice.owed_welcomes()[0].recipients, vec!["carol:dev1"]);

    let mut alice = alice;
    alice.welcome_delivered(gid, "carol:dev1");
    assert!(alice.owed_welcomes().is_empty());
    assert!(restart(&alice, "alice").owed_welcomes().is_empty());
}

#[test]
fn a_merge_owing_a_welcome_needs_a_recorded_add() {
    let gid = "g-no-add";
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    alice
        .stage_self_update_recorded(gid, b"x".to_vec())
        .expect("stage");
    assert!(
        alice
            .merge_pending_commit_owing_welcome(gid, vec!["bob:dev1".to_string()])
            .is_err()
    );
    // Refused BEFORE anything moved: the commit is still staged, to be merged plainly.
    assert_eq!(alice.groups_with_pending_commit(), vec![gid.to_string()]);
    assert!(alice.owed_welcomes().is_empty());
}

#[test]
fn a_forgotten_group_owes_no_welcome() {
    let gid = "g-forget";
    let mut alice = make_device("alice", "dev1");
    let bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    alice
        .add_members_recorded(gid, &[&kp], &["bob:dev1"], Vec::new())
        .expect("stage");
    alice
        .merge_pending_commit_owing_welcome(gid, vec!["bob:dev1".to_string()])
        .expect("merge");
    alice.forget_group(gid, 0);
    assert!(alice.owed_welcomes().is_empty());
}
