//! The door an external join takes, and the member's notice of the commit it makes, read off ONE
//! tree (2026-10-27): `external_join_is_a_further_device` on the joiner, and
//! `DeviceEvent::announces_new_device` on a member merging the commit. A further device of a member
//! entering by its own commit is announced exactly like one a member added (owner, 2026-10-31): a
//! first-sight new device, the owner's other devices alerted - never anything else.
use mls_core::{DeviceEvent, LeafTrust, MlsManager};

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

/// The door `joiner` reads off alice's GroupInfo, and the event alice ANNOUNCES on merging the
/// external commit `joiner` builds on that same GroupInfo, if any.
fn door_and_notice(
    alice: &mut MlsManager,
    joiner: &mut MlsManager,
    gid: &str,
) -> (bool, Option<DeviceEvent>) {
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
    let announced = alice
        .take_device_events()
        .into_iter()
        .find(DeviceEvent::announces_new_device);
    (further, announced)
}

#[test]
fn a_further_device_of_a_member_is_announced_like_an_added_one() {
    let (mut alice, _bob) = conversation("g-further");
    let mut phone = device("bob", "dev2");
    let (further, notice) = door_and_notice(&mut alice, &mut phone, "g-further");
    assert!(further, "the door sees a further device");
    let notice = notice.expect("the entry is announced");
    assert_eq!(notice.trust, LeafTrust::FirstSight);
    assert!(notice.member_already_present);
    assert!(
        notice.is_owner_alert("bob", "dev1"),
        "the owner's other device is alerted"
    );
    assert!(
        !notice.is_owner_alert("bob", "dev2"),
        "never the device itself"
    );
    assert!(
        !notice.is_owner_alert("alice", "dev1"),
        "a contact gets the line, not the alert"
    );
}

#[test]
fn a_device_whose_own_leaf_is_in_the_tree_takes_its_own_door() {
    // State lost, same id: the external commit replaces its own leaf under a new key - announced as
    // the changed key it is, as it always was.
    let (mut alice, _bob) = conversation("g-back");
    let mut bob_again = device("bob", "dev1");
    let (further, notice) = door_and_notice(&mut alice, &mut bob_again, "g-back");
    assert!(!further);
    assert_eq!(notice.map(|e| e.trust), Some(LeafTrust::KeyChanged));
}

#[test]
fn a_user_with_no_leaf_is_not_a_further_device_and_is_never_announced_as_one() {
    let (mut alice, _bob) = conversation("g-person");
    let mut carol = device("carol", "dev1");
    let (further, notice) = door_and_notice(&mut alice, &mut carol, "g-person");
    assert!(!further);
    assert!(
        notice.is_none(),
        "a new person is the uninvited-entry rule's"
    );
}

#[test]
fn a_device_that_left_is_a_further_device_again() {
    // bob:dev2 was in the group and alice saw it removed. Coming back, the door reads only the tree
    // (its user is there, it is not); a fresh install carries a new key, announced as a changed one.
    let (mut alice, _bob) = conversation("g-left");
    let mut dev2 = device("bob", "dev2");
    let kp = dev2.generate_key_package().expect("kp");
    let (_c, welcome, _a, _s) = alice.add_members_bulk("g-left", &[&kp]).expect("add dev2");
    alice.merge_pending_commit_for("g-left").expect("merge");
    let rt = alice.export_ratchet_tree_for("g-left").expect("tree");
    dev2.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("dev2 joins");
    alice
        .remove_members_for_devices("g-left", &["bob:dev2"])
        .expect("remove dev2");
    alice
        .merge_pending_commit_for("g-left")
        .expect("merge removal");
    alice.take_device_events();
    let mut dev2_again = device("bob", "dev2");
    let (further, notice) = door_and_notice(&mut alice, &mut dev2_again, "g-left");
    assert!(further);
    assert_eq!(notice.map(|e| e.trust), Some(LeafTrust::KeyChanged));
}

#[test]
fn a_further_device_spelling_its_user_in_another_case_is_still_a_further_device() {
    // The user half of an identity compares ignoring ASCII case, on both sides.
    let (mut alice, _bob) = conversation("g-case");
    let mut phone = device("BOB", "dev2");
    let (further, notice) = door_and_notice(&mut alice, &mut phone, "g-case");
    assert!(further);
    assert_eq!(notice.map(|e| e.trust), Some(LeafTrust::FirstSight));
}

// ---- D1: the self-join and a member's Add, built on the same epoch (owner, 2026-10-31) ----------
//
// A further device that found no member online joins by itself; a member coming online at that very
// moment may Add it from the ask the server stored. Both commits are built on epoch E, and the strict
// epoch gate accepts exactly ONE. The loser rebuilds - the member clears its staged Add, or the device
// drops the group its refused join built and takes the Welcome - and the group converges with ONE
// leaf for the device. Never two doors opened on one seat.

/// How many leaves of `identity` the tree of `gid` holds on `m`.
fn leaves_of(m: &MlsManager, gid: &str, identity: &str) -> usize {
    m.member_identities(gid)
        .expect("members")
        .iter()
        .filter(|leaf| leaf.as_str() == identity)
        .count()
}

/// Both sides of the race, built on epoch `epoch`.
struct Race {
    alice: MlsManager,
    bob: MlsManager,
    phone: MlsManager,
    add: Vec<u8>,
    welcome: Option<Vec<u8>>,
    join: Vec<u8>,
    epoch: u64,
}

/// alice stages the Add of bob:dev2 while bob:dev2 builds its own external commit, both on epoch E.
fn the_race(gid: &str) -> Race {
    let (mut alice, bob) = conversation(gid);
    let mut phone = device("bob", "dev2");
    let epoch = alice.get_epoch(gid).expect("epoch");
    let info = alice.export_group_info(gid).expect("base at E");
    let kp = phone.generate_key_package().expect("kp");
    let (add, welcome, _a, _s) = alice.add_members_bulk(gid, &[&kp]).expect("stage the Add");
    let (_g, join) = phone
        .join_by_external_commit(&info)
        .expect("self-join on E");
    Race {
        alice,
        bob,
        phone,
        add,
        welcome,
        join,
        epoch,
    }
}

fn converged_with_one_leaf(r: &Race, gid: &str) {
    for (name, m) in [("alice", &r.alice), ("bob", &r.bob), ("phone", &r.phone)] {
        assert_eq!(
            m.get_epoch(gid).expect("epoch"),
            r.epoch + 1,
            "{name} at E+1"
        );
        assert_eq!(leaves_of(m, gid, "bob:dev2"), 1, "{name} sees one leaf");
    }
}

#[test]
fn the_self_join_accepted_first_the_member_clears_its_add_and_one_leaf_stands() {
    let gid = "g-race-join";
    let mut r = the_race(gid);
    // The gate accepted the join: the device merges it, and the member's Add at E is refused.
    r.phone
        .merge_pending_commit_for(gid)
        .expect("the join is accepted");
    r.alice
        .clear_pending_commit_for(gid)
        .expect("the refused Add is cleared");
    r.alice
        .process_incoming_message(gid, &r.join)
        .expect("alice merges the join");
    r.bob
        .process_incoming_message(gid, &r.join)
        .expect("bob merges the join");
    converged_with_one_leaf(&r, gid);
}

#[test]
fn the_add_accepted_first_the_device_drops_its_join_and_takes_the_welcome() {
    let gid = "g-race-add";
    let mut r = the_race(gid);
    // The gate accepted the Add: the member merges it, and the join at E is refused by every member.
    r.alice
        .merge_pending_commit_for(gid)
        .expect("the Add is accepted");
    r.bob
        .process_incoming_message(gid, &r.add)
        .expect("bob merges the Add");
    // A commit built on a left epoch changes nothing on a member - the engine discards it, whatever
    // it answers - so the tree and the epoch are what is asserted.
    let _ = r.alice.process_incoming_message(gid, &r.join);
    assert_eq!(r.alice.get_epoch(gid).expect("epoch"), r.epoch + 1);
    assert_eq!(
        leaves_of(&r.alice, gid, "bob:dev2"),
        1,
        "the late join added no leaf"
    );
    // The loser rebuilds: the refused join leaves nothing behind, and the Welcome is its door.
    r.phone
        .clear_pending_commit_for(gid)
        .expect("the refused join is dropped");
    let rt = r.alice.export_ratchet_tree_for(gid).expect("tree");
    let welcome = r.welcome.take().expect("welcome");
    r.phone
        .process_welcome(&welcome, Some(&rt))
        .expect("the device takes the Welcome");
    converged_with_one_leaf(&r, gid);
}
