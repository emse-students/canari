//! Reading the tree, and removing by user.
//!
//! A leaf is a DEVICE and its credential identity is `userId:deviceId`. Two consequences are
//! exercised here, both of which a community's key-distribution group depends on:
//!
//! - `member_identities` is the only authority on who can read a group. Server membership rows
//!   answer who the delivery service will ROUTE to, and a distribution group has none of them by
//!   construction, so a reconciliation deciding whether a leaf still belongs has nothing else.
//! - `remove_members_for_users` compared a bare user id with the full identity, so it matched
//!   nothing and could only ever answer "No member found" - the user-level removal path was inert,
//!   and a departed member's leaf therefore stayed in the tree for ever.
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates `gid` and adds every `(user, device)` given, in one commit.
fn group_with(gid: &str, members: &[(&str, &str)]) -> (MlsManager, Vec<MlsManager>) {
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");

    let mut devices: Vec<MlsManager> = members
        .iter()
        .map(|(user, device)| make_device(user, device))
        .collect();
    let key_packages: Vec<Vec<u8>> = devices
        .iter_mut()
        .map(|d| d.generate_key_package().expect("kp"))
        .collect();
    let kp_refs: Vec<&[u8]> = key_packages.iter().map(|kp| kp.as_slice()).collect();

    let (_commit, welcome, _added, _skipped) =
        alice.add_members_bulk(gid, &kp_refs).expect("add members");
    alice.merge_pending_commit_for(gid).expect("merge add");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    for device in devices.iter_mut() {
        device
            .process_welcome(welcome.as_deref().unwrap(), Some(&tree))
            .expect("joins");
    }
    (alice, devices)
}

/// Identities of `gid`'s leaves, sorted so an assertion never depends on leaf order.
fn sorted_identities(manager: &MlsManager, gid: &str) -> Vec<String> {
    let mut identities = manager.member_identities(gid).expect("member_identities");
    identities.sort();
    identities
}

#[test]
fn member_identities_names_every_leaf_as_user_colon_device() {
    let gid = "g-identities";
    let (alice, _others) = group_with(gid, &[("bob", "dev1"), ("bob", "dev2")]);

    assert_eq!(
        sorted_identities(&alice, gid),
        vec!["alice:dev1", "bob:dev1", "bob:dev2"],
        "one entry per DEVICE, each carrying the user it belongs to"
    );
}

#[test]
fn member_identities_refuses_a_group_this_device_does_not_hold() {
    let alice = make_device("alice", "dev1");
    assert!(
        alice.member_identities("g-never-created").is_err(),
        "an unknown group is an error, never an empty tree - the two mean opposite things"
    );
}

#[test]
fn removing_a_user_takes_every_device_they_are_signed_in_on() {
    let gid = "g-remove-user";
    let (mut alice, _others) = group_with(gid, &[("bob", "dev1"), ("bob", "dev2"), ("carol", "d")]);

    alice
        .remove_members_for_users(gid, &["bob"])
        .expect("remove bob - this used to answer 'No member found'");
    alice.merge_pending_commit_for(gid).expect("merge remove");

    assert_eq!(
        sorted_identities(&alice, gid),
        vec!["alice:dev1", "carol:d"],
        "both of bob's leaves are gone, carol's is untouched"
    );
}

#[test]
fn a_user_id_that_prefixes_another_does_not_swallow_it() {
    let gid = "g-prefix";
    let (mut alice, _others) = group_with(gid, &[("bob", "dev1"), ("bobby", "dev1")]);

    alice
        .remove_members_for_users(gid, &["bob"])
        .expect("remove bob");
    alice.merge_pending_commit_for(gid).expect("merge remove");

    assert_eq!(
        sorted_identities(&alice, gid),
        vec!["alice:dev1", "bobby:dev1"],
        "the colon is part of the prefix, so 'bob' never matches 'bobby:dev1'"
    );
}

#[test]
fn removing_a_device_leaves_the_users_other_devices_in_place() {
    let gid = "g-remove-device";
    let (mut alice, _others) = group_with(gid, &[("bob", "dev1"), ("bob", "dev2")]);

    alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("remove one device");
    alice.merge_pending_commit_for(gid).expect("merge remove");

    assert_eq!(
        sorted_identities(&alice, gid),
        vec!["alice:dev1", "bob:dev2"],
        "device-level removal is still exact - it is the whole reason it exists next to the other"
    );
}

#[test]
fn removing_a_user_who_is_not_in_the_tree_is_an_error_not_an_empty_commit() {
    let gid = "g-absent";
    let (mut alice, _others) = group_with(gid, &[("bob", "dev1")]);

    assert!(
        alice.remove_members_for_users(gid, &["dave"]).is_err(),
        "an empty removal must not stage a commit that moves the epoch for nothing"
    );
}
