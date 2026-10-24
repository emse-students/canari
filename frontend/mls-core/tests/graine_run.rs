//! Graine's departure tracker: one clean run per group, ended by a departure and by nothing else
//! (`src/graine_run.rs`, `docs/wiki/protocols/graine-removal-tracker.md`).
//!
//! The run is what lets an outbound Graine session outlive an Add and never a Remove. Every case
//! here is a way the rule could reuse a seed a departed leaf holds - or a way it could keep
//! rotating on an Add, which is the production cost (one session per two messages, 2026-10-21).
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates `gid` and adds bob; both hold the group at epoch 1.
fn alice_and_bob(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _a, _s) = alice.add_members_bulk(gid, &[&kp]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&tree))
        .expect("bob joins");
    (alice, bob)
}

/// `committer` adds a fresh device of `user`; returns the commit and the joined device.
fn add_device(
    committer: &mut MlsManager,
    gid: &str,
    user: &str,
    device: &str,
) -> (Vec<u8>, MlsManager) {
    let mut joiner = make_device(user, device);
    let kp = joiner.generate_key_package().expect("kp");
    let (commit, welcome, _a, _s) = committer.add_members_bulk(gid, &[&kp]).expect("add");
    committer.merge_pending_commit_for(gid).expect("merge add");
    let tree = committer.export_ratchet_tree_for(gid).expect("tree");
    joiner
        .process_welcome(welcome.as_deref().unwrap(), Some(&tree))
        .expect("joiner joins");
    (commit, joiner)
}

/// `committer` removes the device `identity`; returns the commit.
fn remove_device(committer: &mut MlsManager, gid: &str, identity: &str) -> Vec<u8> {
    let (commit, _base) = committer
        .remove_members_for_devices(gid, &[identity])
        .expect("remove");
    committer
        .merge_pending_commit_for(gid)
        .expect("merge remove");
    commit
}

fn run_id(manager: &mut MlsManager, gid: &str) -> String {
    manager.graine_run(gid).expect("graine_run").run_id
}

/// THE SAVING: a new device of a user already in the group is the measured bulk of the rotations.
#[test]
fn a_new_device_of_a_present_user_continues_the_run_on_the_committer_and_on_a_receiver() {
    let gid = "g-run-add";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let alice_run = run_id(&mut alice, gid);
    let bob_run = run_id(&mut bob, gid);

    let (commit, _bob2) = add_device(&mut alice, gid, "bob", "dev2");
    bob.process_incoming_message(gid, &commit)
        .expect("bob applies the add");

    assert_eq!(
        run_id(&mut alice, gid),
        alice_run,
        "an Add the committer merged removes nobody and brings no new user: the run continues"
    );
    assert_eq!(
        run_id(&mut bob, gid),
        bob_run,
        "the same Add merged by a receiver: the run continues"
    );
}

/// A NEW USER ends the run (`ROTATE_ON_NEW_USER`, decision D5): a newcomer must not be handed a
/// seed whose earlier indices it can derive.
#[test]
fn a_new_user_ends_the_run_on_the_committer_and_on_a_receiver() {
    let gid = "g-run-new-user";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let alice_run = run_id(&mut alice, gid);
    let bob_run = run_id(&mut bob, gid);

    let (commit, _carol) = add_device(&mut alice, gid, "carol", "dev1");
    bob.process_incoming_message(gid, &commit)
        .expect("bob applies the add");

    assert_ne!(run_id(&mut alice, gid), alice_run);
    assert_ne!(run_id(&mut bob, gid), bob_run);
}

#[test]
fn a_remove_ends_the_run_on_the_committer_and_on_a_receiver() {
    let gid = "g-run-remove";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let (add, _carol) = add_device(&mut alice, gid, "carol", "dev1");
    bob.process_incoming_message(gid, &add).expect("bob: add");
    let alice_run = run_id(&mut alice, gid);
    let bob_run = run_id(&mut bob, gid);

    let remove = remove_device(&mut alice, gid, "carol:dev1");
    bob.process_incoming_message(gid, &remove)
        .expect("bob applies the remove");

    assert_ne!(
        run_id(&mut alice, gid),
        alice_run,
        "the committer's run ends"
    );
    assert_ne!(run_id(&mut bob, gid), bob_run, "a receiver's run ends");
}

/// THE CASE THE IDENTITY-SET COMPARISON MISSED (refused 2026-10-22): a device added and removed
/// between two sends is in neither the set at the first send nor the set at the second.
#[test]
fn a_device_added_then_removed_between_two_reads_ends_the_run() {
    let gid = "g-run-add-remove";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let before = run_id(&mut bob, gid);
    let members_before = bob.member_identities(gid).expect("members");

    let (add, _phone) = add_device(&mut alice, gid, "bob", "lost-phone");
    let remove = remove_device(&mut alice, gid, "bob:lost-phone");
    bob.process_incoming_message(gid, &add).expect("add");
    bob.process_incoming_message(gid, &remove).expect("remove");

    assert_eq!(
        bob.member_identities(gid).expect("members"),
        members_before,
        "the tree is back to what it was - which is exactly why a set comparison sees nothing"
    );
    assert_ne!(
        run_id(&mut bob, gid),
        before,
        "the run saw the Remove go past, so it ends"
    );
}

/// The offline catch-up: a device that was away applies the commits it missed as one batch.
#[test]
fn a_batch_with_a_departure_in_its_middle_ends_the_run_and_one_without_does_not() {
    let gid = "g-run-batch";
    let (mut alice, mut bob) = alice_and_bob(gid);

    let (add1, _c) = add_device(&mut alice, gid, "bob", "dev2");
    let (add2, _d) = add_device(&mut alice, gid, "alice", "dev2");
    let before = run_id(&mut bob, gid);
    let results = bob.process_incoming_messages(gid, &[&add1, &add2]);
    assert!(results.iter().all(|r| r.is_ok()), "{results:?}");
    assert_eq!(
        run_id(&mut bob, gid),
        before,
        "two new devices of present users: the run continues"
    );

    let remove = remove_device(&mut alice, gid, "bob:dev2");
    let (add3, _e) = add_device(&mut alice, gid, "bob", "dev3");
    let results = bob.process_incoming_messages(gid, &[&remove, &add3]);
    assert!(results.iter().all(|r| r.is_ok()), "{results:?}");
    assert_ne!(
        run_id(&mut bob, gid),
        before,
        "a Remove followed by an Add: the departure is not hidden by what came after it"
    );
}

/// One device of a user leaving is a departure even though the user stays.
#[test]
fn removing_one_device_of_a_user_who_keeps_another_is_a_departure() {
    let gid = "g-run-device";
    let (mut alice, _bob) = alice_and_bob(gid);
    let (_add, _bob2) = add_device(&mut alice, gid, "bob", "dev2");
    let before = run_id(&mut alice, gid);
    remove_device(&mut alice, gid, "bob:dev2");
    assert_ne!(run_id(&mut alice, gid), before);
}

/// A device rejoining by external commit removes its own leaf and puts the SAME (credential,
/// signature key) back. The tree before and after looks unchanged at that leaf - which is exactly
/// the blind spot of any identity or pair comparison - but a Remove was applied, so the run ends.
#[test]
fn an_external_rejoin_with_the_same_key_still_ends_the_run() {
    let gid = "g-run-rejoin";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let before = run_id(&mut alice, gid);

    let group_info = alice.export_group_info(gid).expect("group info");
    bob.forget_group(gid, 0);
    let (_gid, commit) = bob
        .join_by_external_commit(&group_info)
        .expect("bob rejoins");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies the rejoin");
    assert_eq!(
        alice.member_identities(gid).expect("members").len(),
        2,
        "bob's old leaf went and his new one came"
    );
    assert_ne!(
        run_id(&mut alice, gid),
        before,
        "a removal was applied, whatever came back in the same commit"
    );
}

/// A device that comes back with a NEW key (a reinstall keeps the device id, never the key) is a
/// departure: the old key material is no longer a member.
#[test]
fn a_rejoin_under_a_new_key_is_a_departure() {
    let gid = "g-run-reinstall";
    let (mut alice, _bob) = alice_and_bob(gid);

    // Same identity, fresh manager: a new signature key. Its external commit cannot replace bob's
    // old leaf (that is matched on the KEY), so the old leaf stays until somebody removes it, and
    // the tree briefly holds both.
    let mut reinstalled = make_device("bob", "dev1");
    let group_info = alice.export_group_info(gid).expect("group info");
    let (_gid, commit) = reinstalled
        .join_by_external_commit(&group_info)
        .expect("reinstalled device joins");
    alice.process_incoming_message(gid, &commit).expect("join");
    let after_join = run_id(&mut alice, gid);
    remove_device(&mut alice, gid, "bob:dev1");
    assert_ne!(
        run_id(&mut alice, gid),
        after_join,
        "removing the old key's leaf is a departure, though a leaf named bob:dev1 remains"
    );
}

/// A device `user:device` joins `gid` by EXTERNAL commit; alice and bob apply it. Returns whether
/// each one's run continued.
fn external_join_continues(gid: &str, user: &str, device: &str) -> (bool, bool) {
    let (mut alice, mut bob) = alice_and_bob(gid);
    let alice_run = run_id(&mut alice, gid);
    let bob_run = run_id(&mut bob, gid);

    let mut joiner = make_device(user, device);
    let group_info = alice.export_group_info(gid).expect("group info");
    let (_gid, commit) = joiner
        .join_by_external_commit(&group_info)
        .expect("external join");
    alice.process_incoming_message(gid, &commit).expect("alice");
    bob.process_incoming_message(gid, &commit).expect("bob");

    (
        run_id(&mut alice, gid) == alice_run,
        run_id(&mut bob, gid) == bob_run,
    )
}

/// D5 ON THE EXTERNAL ROUTE: a new device of a user who already has a leaf continues the run, as on
/// an Add - key groups are joined this way, so this is where the saving is.
#[test]
fn an_external_join_of_a_present_users_new_device_continues_the_run() {
    assert_eq!(
        external_join_continues("g-run-external-device", "bob", "dev2"),
        (true, true)
    );
}

/// An external join by a user with no leaf in the group ends the run.
#[test]
fn an_external_join_of_a_new_user_ends_the_run() {
    assert_eq!(
        external_join_continues("g-run-external-user", "carol", "dev1"),
        (false, false)
    );
}

/// The user half is canonical (ASCII-lowercased, as device trust reads it): `BOB` is bob.
#[test]
fn an_external_join_judges_the_user_by_its_canonical_lowercase_half() {
    assert_eq!(
        external_join_continues("g-run-external-case", "BOB", "dev2"),
        (true, true)
    );
}

/// A credential that is not exactly `user:device` names no user, so it ends the run.
#[test]
fn an_external_join_whose_leaf_is_not_a_well_formed_identity_ends_the_run() {
    assert_eq!(
        external_join_continues("g-run-external-malformed", "bob", "dev2:x"),
        (false, false)
    );
}

/// The JOINER of an external commit has nothing pending: openmls 0.9 merges the commit inside
/// `finalize`, so the caller's `merge_pending_commit_for` is the debug-logged no-op - never the
/// `run dropped` ERROR - and the joiner's run starts at its first read, at the epoch it joined.
#[test]
fn the_joiners_merge_of_its_own_external_commit_is_a_no_op_not_a_dropped_run() {
    let gid = "g-run-joiner";
    let (alice, _bob) = alice_and_bob(gid);
    let mut carol = make_device("carol", "dev1");
    let group_info = alice.export_group_info(gid).expect("group info");
    carol
        .join_by_external_commit(&group_info)
        .expect("external join");
    assert_eq!(
        carol.merge_pending_commit_with_summary(gid).expect("merge"),
        None,
        "nothing pending, so nothing to summarise and nothing dropped"
    );
    let first = carol.graine_run(gid).expect("first read");
    assert_eq!(
        first.epoch, 2,
        "the run starts at the epoch the join created"
    );
    assert_eq!(carol.graine_run(gid).expect("second read"), first);
}

/// The run is persisted WITH the tree, so a reload neither loses it nor desynchronises from it.
#[test]
fn the_run_survives_a_save_and_reload() {
    let gid = "g-run-persist";
    let (mut alice, _bob) = alice_and_bob(gid);
    let before = run_id(&mut alice, gid);
    let (_add, _bob2) = add_device(&mut alice, gid, "bob", "dev2");

    let saved = alice.save_state().expect("save");
    let mut reloaded = MlsManager::load_or_create("alice", "dev1", Some(saved)).expect("reload");
    assert_eq!(
        run_id(&mut reloaded, gid),
        before,
        "the Add's continuation was checkpointed with the epoch it produced"
    );
}

/// A reload of an OLDER state - a backup, a resume reload - carries the run as of that state; the
/// next commit applied on top of it is observed like any other.
#[test]
fn a_state_saved_before_a_departure_and_caught_up_afterwards_ends_the_run() {
    let gid = "g-run-rollback";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let before = run_id(&mut bob, gid);
    let snapshot = bob.save_state().expect("save");

    let (add, _carol) = add_device(&mut alice, gid, "carol", "dev1");
    let remove = remove_device(&mut alice, gid, "carol:dev1");

    let mut restored = MlsManager::load_or_create("bob", "dev1", Some(snapshot)).expect("restore");
    assert_eq!(
        run_id(&mut restored, gid),
        before,
        "the restored run is the one saved"
    );
    restored.process_incoming_message(gid, &add).expect("add");
    restored
        .process_incoming_message(gid, &remove)
        .expect("remove");
    assert_ne!(run_id(&mut restored, gid), before);
}

/// A group instance replaced without a summary (forgotten, then re-joined by Welcome) never
/// continues the old run, even though it carries the same group id.
#[test]
fn a_replaced_group_instance_starts_a_new_run() {
    let gid = "g-run-replaced";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let before = run_id(&mut bob, gid);

    bob.forget_group(gid, 0);
    let group_info = alice.export_group_info(gid).expect("group info");
    let (_gid, commit) = bob.join_by_external_commit(&group_info).expect("rejoin");
    bob.merge_pending_commit_for(gid).expect("merge");
    alice.process_incoming_message(gid, &commit).expect("alice");
    assert_ne!(run_id(&mut bob, gid), before);
}

/// An epoch NUMBER is not an epoch: two instances of one group id at the same number (a
/// re-bootstrapped key group) have different fingerprints.
#[test]
fn two_instances_of_one_group_at_the_same_epoch_have_different_fingerprints() {
    let gid = "g-run-alias";
    let mut first = make_device("alice", "dev1");
    let mut second = make_device("alice", "dev1");
    first.create_group(gid.to_string()).expect("first");
    second.create_group(gid.to_string()).expect("second");
    let a = first.graine_run(gid).expect("a");
    let b = second.graine_run(gid).expect("b");
    assert_eq!(a.epoch, b.epoch);
    assert_ne!(a.epoch_fingerprint, b.epoch_fingerprint);
    assert_ne!(a.run_id, b.run_id);
}

/// The commit summary itself, read where it is built: what each kind of merge reports.
#[test]
fn the_commit_summary_names_what_the_commit_removed_and_added() {
    let gid = "g-run-summary";
    let (mut alice, _bob) = alice_and_bob(gid);

    let carol = make_device("carol", "dev1");
    let kp = carol.generate_key_package().expect("kp");
    alice.add_members_bulk(gid, &[&kp]).expect("stage add");
    let add = alice
        .merge_pending_commit_with_summary(gid)
        .expect("merge")
        .expect("summary");
    assert_eq!(add.added, vec!["carol:dev1".to_string()]);
    assert_eq!(add.new_users, vec!["carol".to_string()]);
    assert!(add.removed.is_empty() && !add.is_departure());
    assert_eq!(add.epoch_after, add.epoch_before + 1);
    assert_ne!(add.fingerprint_after, add.fingerprint_before);

    alice
        .remove_members_for_devices(gid, &["carol:dev1", "bob:dev1"])
        .expect("stage remove");
    let remove = alice
        .merge_pending_commit_with_summary(gid)
        .expect("merge")
        .expect("summary");
    assert_eq!(
        remove.removed,
        vec!["bob:dev1".to_string(), "carol:dev1".to_string()],
        "several Removes in one commit are each named"
    );
    assert_eq!(remove.remove_proposals, 2);
    assert!(remove.is_departure());
    assert!(remove.new_users.is_empty());
}

/// No run is minted before somebody asks, and a state written before the field loads with none.
#[test]
fn a_fresh_manager_starts_its_run_at_the_first_read() {
    let gid = "g-run-fresh";
    let (mut alice, _bob) = alice_and_bob(gid);
    let first = alice.graine_run(gid).expect("first");
    let second = alice.graine_run(gid).expect("second");
    assert_eq!(
        first, second,
        "a read with nothing in between is the same run"
    );
    assert!(alice.graine_run("g-unknown").is_err());
}
