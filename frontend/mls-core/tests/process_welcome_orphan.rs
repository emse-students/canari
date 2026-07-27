/// Verifies that `process_welcome` leaves NO orphan state in storage when a guard rejects the
/// Welcome (stale epoch < the min_epoch imposed by an earlier `forget_group`).
///
/// Context: `into_group` persists the group in the storage provider. Before the C4 fix it was
/// called BEFORE the guards were evaluated: a rejected Welcome still wrote the group to storage
/// without registering it in `self.groups`. That orphan leaked and blocked every future legitimate
/// re-Welcome with `GroupAlreadyExists` (raised by `new_from_welcome` when the group_id is already
/// present in storage). The guards must therefore be evaluated on the `StagedWelcome` (in memory)
/// BEFORE `into_group`.
use mls_core::{MlsError, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

#[test]
fn rejected_stale_welcome_leaves_no_orphan_blocking_a_fresh_welcome() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-orphan-1";

    alice.create_group(gid.to_string()).expect("create_group");

    // Two distinct (unconsumed) KeyPackages, so we can produce two Welcomes at different epochs
    // for the SAME group without bob ever having joined one.
    let kp_bob1 = bob.generate_key_package().expect("kp bob 1");
    let kp_bob2 = bob.generate_key_package().expect("kp bob 2");

    // Welcome v1: add bob -> epoch 1.
    let (_, welcome_v1, _, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob1])
        .expect("add bob v1");
    // Stage-only add (C7-A): confirm to reach epoch 1, then export the post-merge tree.
    alice
        .merge_pending_commit_for(gid)
        .expect("confirm add bob v1");
    let welcome_v1 = welcome_v1.expect("welcome v1");
    let rt_v1 = alice.export_ratchet_tree_for(gid).expect("ratchet tree v1");

    // Remove bob (epoch 2) then re-add via kp_bob2 (epoch 3) -> Welcome v2 at epoch 3.
    // The removal STAGES the commit (C7 Option A): confirm it so bob really leaves the tree before
    // the re-add (otherwise kp_bob2 would be rejected as AlreadyMember).
    alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("remove bob");
    alice
        .merge_pending_commit_for(gid)
        .expect("confirm remove bob");
    let (_, welcome_v2, _, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob2])
        .expect("add bob v2");
    // Stage-only add (C7-A): confirm to reach epoch 3, then export the post-merge tree.
    alice
        .merge_pending_commit_for(gid)
        .expect("confirm add bob v2");
    let welcome_v2 = welcome_v2.expect("welcome v2");
    let rt_v2 = alice.export_ratchet_tree_for(gid).expect("ratchet tree v2");

    // bob forgets the group, imposing min_epoch=3 (he expects an up-to-date re-Welcome).
    bob.forget_group(gid, 3);

    // Welcome v1 (epoch 1) is stale: it must be rejected.
    let stale = bob.process_welcome(&welcome_v1, Some(&rt_v1));
    assert!(
        matches!(&stale, Err(MlsError::OpenMls(m)) if m.contains("stale")),
        "the stale Welcome must be rejected, got: {stale:?}"
    );

    // Heart of the test: Welcome v2 (epoch 3 >= min 3) must succeed. Had the previous rejection
    // left an orphan in storage, new_from_welcome would fail here with GroupAlreadyExists.
    let joined = bob
        .process_welcome(&welcome_v2, Some(&rt_v2))
        .expect("the up-to-date Welcome must succeed (no storage orphan)");
    assert_eq!(joined, gid);
    assert!(bob.get_known_groups().contains(&gid.to_string()));
}
