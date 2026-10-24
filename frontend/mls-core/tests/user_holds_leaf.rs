//! `user_holds_leaf`: the question an AUTOMATIC Add asks before it brings a device in - is this a
//! device of a user already in the tree (a member's), or of a user absent from it (a new person,
//! whom only a member's own gesture admits)? Read on the canonical user, so a member's new device is
//! never taken for a stranger and a stranger never borrows a member's device id. The TypeScript twin
//! is `treeHoldsUser` (`leafIdentity.ts`), held to the same cases.
use mls_core::MlsManager;

fn device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

fn alice_with_bob(gid: &str) -> MlsManager {
    let mut alice = device("alice", "dev1");
    let bob = device("bob", "phone");
    alice.create_group(gid.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    alice.add_members_bulk(gid, &[&kp]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge");
    alice
}

#[test]
fn a_new_device_of_a_member_is_a_members_device_under_any_spelling_of_the_user() {
    let alice = alice_with_bob("g-holds-1");
    assert!(alice.user_holds_leaf("g-holds-1", "bob:laptop").unwrap());
    assert!(alice.user_holds_leaf("g-holds-1", "BOB:laptop").unwrap());
}

#[test]
fn a_stranger_holds_nothing_even_under_a_members_device_id() {
    let alice = alice_with_bob("g-holds-2");
    assert!(!alice.user_holds_leaf("g-holds-2", "carol:phone").unwrap());
}

#[test]
fn an_identity_naming_nobody_holds_nothing_and_an_unheld_group_is_an_error() {
    let alice = alice_with_bob("g-holds-3");
    assert!(!alice.user_holds_leaf("g-holds-3", "bob:a:b").unwrap());
    assert!(alice.user_holds_leaf("not-held", "bob:laptop").is_err());
}
