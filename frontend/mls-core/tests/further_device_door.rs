//! The door an external join takes, and the member's verdict on the commit it makes, read off ONE
//! tree (2026-10-27): `external_join_is_a_further_device` on the joiner, and
//! `DeviceEvent::enters_as_unvouched_device` on a member merging the commit. They must agree - an
//! honest device that took its own door is never said to have let itself in.
use mls_core::MlsManager;

fn device(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).unwrap_or_else(|e| panic!("{user}:{dev}: {e}"))
}

/// alice:dev1 and bob:dev1 in one conversation.
fn conversation(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    let (_c, welcome, _a, _s) = alice.add_members_bulk(gid, &[&kp]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    alice.take_device_events();
    (alice, bob)
}

/// The door `joiner` reads off alice's GroupInfo, and whether alice, merging the external commit
/// `joiner` builds on that same GroupInfo, says it let itself in unvouched.
fn door_and_verdict(alice: &mut MlsManager, joiner: &mut MlsManager, gid: &str) -> (bool, bool) {
    let info = alice.export_group_info(gid).expect("group info");
    let further = joiner
        .external_join_is_a_further_device(&info)
        .expect("door");
    let (_g, commit) = joiner
        .join_by_external_commit(&info)
        .expect("external join");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice merges");
    let unvouched = alice
        .take_device_events()
        .iter()
        .any(|e| e.enters_as_unvouched_device());
    (further, unvouched)
}

#[test]
fn a_further_device_of_a_member_is_told_to_ask_and_its_own_entry_would_be_said() {
    let (mut alice, _bob) = conversation("g-further");
    let mut phone = device("bob", "dev2");
    assert_eq!(
        door_and_verdict(&mut alice, &mut phone, "g-further"),
        (true, true),
        "the door asks a member exactly where the member would say the entry"
    );
}

#[test]
fn a_device_whose_own_leaf_is_in_the_tree_takes_its_own_door_and_is_never_said() {
    // State lost, same id: the external commit replaces its own leaf.
    let (mut alice, _bob) = conversation("g-back");
    let mut bob_again = device("bob", "dev1");
    assert_eq!(
        door_and_verdict(&mut alice, &mut bob_again, "g-back"),
        (false, false)
    );
}

#[test]
fn a_user_with_no_leaf_is_not_a_further_device_and_is_never_said_as_one() {
    let (mut alice, _bob) = conversation("g-person");
    let mut carol = device("carol", "dev1");
    assert_eq!(
        door_and_verdict(&mut alice, &mut carol, "g-person"),
        (false, false)
    );
}
