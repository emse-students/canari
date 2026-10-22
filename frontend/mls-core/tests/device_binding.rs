//! A KeyPackage is checked against the device it was fetched for, device keys are pinned on first
//! sight, and every device a merged commit admits is recorded - `mls_core::device_trust`.
//!
//! The delivery service chooses the bytes an Add is built from, so the client must not take them on
//! trust: a package whose credential names another device, or the right device under a key this
//! client never saw it with, is refused. These pin the refusals, the legitimate paths that must stay
//! open (a re-add under the SAME key, a state saved and reloaded, a state from before pins existed),
//! and the record a "a device was added" line will be built from.

use ciborium::{de::from_reader, ser::into_writer};
use mls_core::{
    DeviceEvent, LeafTrust, MlsError, MlsManager, PersistedState, SkippedKeyPackage,
    SkippedKeyPackageReason,
};

fn device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("cannot create device '{user_id}:{device_id}': {e}"))
}

/// `committer` adds `kp` as `expected`, merges as if the server accepted, and `joiner` processes the
/// Welcome. Returns the commit, for the other members to merge.
fn add_and_join(
    committer: &mut MlsManager,
    joiner: &mut MlsManager,
    gid: &str,
    kp: &[u8],
    expected: &str,
) -> Vec<u8> {
    let ((commit, welcome, added, skipped), _base) = committer
        .add_members_bulk_with_base(gid, &[kp], &[expected])
        .expect("stage add");
    assert_eq!(added, vec![0], "skipped: {skipped:?}");
    committer.merge_pending_commit_for(gid).expect("merge add");
    let tree = committer.export_ratchet_tree_for(gid).expect("tree");
    joiner
        .process_welcome(welcome.as_deref().unwrap(), Some(&tree))
        .expect("join");
    commit
}

/// `committer` removes `identity` and merges. Returns the commit.
fn remove(committer: &mut MlsManager, gid: &str, identity: &str) -> Vec<u8> {
    let (commit, _base) = committer
        .remove_members_for_devices(gid, &[identity])
        .expect("stage remove");
    committer
        .merge_pending_commit_for(gid)
        .expect("merge remove");
    commit
}

#[test]
fn a_key_package_whose_credential_names_another_device_is_refused() {
    let mut alice = device("alice", "dev1");
    let mallory = device("mallory", "dev1");
    let gid = "g-binding-1";
    alice.create_group(gid.into()).expect("create");

    let kp = mallory.generate_key_package().expect("kp");
    assert_eq!(alice.vet_key_package(&kp, "bob:dev1"), "identity-mismatch");
    let err = alice
        .add_members_bulk_with_base(gid, &[&kp], &["bob:dev1"])
        .expect_err("a package for somebody else must add nobody");
    assert!(matches!(err, MlsError::OpenMls(_)), "{err:?}");
    assert_eq!(alice.get_epoch(gid).unwrap(), 0, "nothing was staged");

    // The other half of the same identity: the right user, another of their devices.
    let bob_dev2 = device("bob", "dev2");
    let kp2 = bob_dev2.generate_key_package().expect("kp2");
    assert_eq!(alice.vet_key_package(&kp2, "bob:dev1"), "identity-mismatch");
}

#[test]
fn a_mismatch_in_a_batch_skips_that_package_and_adds_the_rest() {
    let mut alice = device("alice", "dev1");
    let mallory = device("mallory", "dev1");
    let carol = device("carol", "dev1");
    let gid = "g-binding-2";
    alice.create_group(gid.into()).expect("create");

    let kp_m = mallory.generate_key_package().expect("kp m");
    let kp_c = carol.generate_key_package().expect("kp c");
    let ((_c, _w, added, skipped), _base) = alice
        .add_members_bulk_with_base(gid, &[&kp_m, &kp_c], &["bob:dev1", "carol:dev1"])
        .expect("carol is still added");
    assert_eq!(added, vec![1]);
    assert_eq!(
        skipped,
        vec![SkippedKeyPackage {
            index: 0,
            reason: SkippedKeyPackageReason::IdentityMismatch
        }]
    );
}

#[test]
fn the_user_half_of_the_expectation_ignores_case() {
    let mut alice = device("alice", "dev1");
    let bob = device("bob", "dev1");
    let gid = "g-binding-3";
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    assert_eq!(alice.vet_key_package(&kp, "BOB:dev1"), "first-sight");
    assert_eq!(alice.vet_key_package(&kp, "bob:DEV1"), "identity-mismatch");
}

#[test]
fn the_slices_must_pair_one_expectation_with_each_package() {
    let mut alice = device("alice", "dev1");
    let bob = device("bob", "dev1");
    let gid = "g-binding-4";
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    assert!(alice.add_members_bulk_with_base(gid, &[&kp], &[]).is_err());
}

/// The replace path: a device's leaf is removed and a package for the same name is added back.
/// Under the key it was first seen with, that is the ordinary re-add of a device that lost a group
/// (rung 2) and it must keep working; under any other key it is a replacement nothing proves, and it
/// is refused - BEFORE the removal, through `vet_key_package`, and again by the Add itself.
#[test]
fn a_re_add_under_the_pinned_key_passes_and_under_another_key_is_refused() {
    let gid = "g-pin-1";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");

    // The same device, the same key: a fresh package from the same manager is `pinned`.
    let same_key = bob.generate_key_package().expect("kp same key");
    assert_eq!(alice.vet_key_package(&same_key, "bob:dev1"), "pinned");

    // A NEW manager under the SAME name - a lost state re-created under the old id, or a server
    // minting a device it controls under that name. Refused before any removal is made...
    let impostor = device("bob", "dev1");
    let other_key = impostor.generate_key_package().expect("kp other key");
    assert_eq!(
        alice.vet_key_package(&other_key, "bob:dev1"),
        "signature-key-changed"
    );

    // ...and by the Add, even once the old leaf is gone.
    remove(&mut alice, gid, "bob:dev1");
    let err = alice
        .add_members_bulk_with_base(gid, &[&other_key], &["bob:dev1"])
        .expect_err("a changed key adds nobody");
    assert!(matches!(err, MlsError::OpenMls(_)), "{err:?}");

    // The genuine device, same key, is re-added.
    let ((_c, _w, added, _s), _b) = alice
        .add_members_bulk_with_base(gid, &[&same_key], &["bob:dev1"])
        .expect("the pinned key is re-added");
    assert_eq!(added, vec![0]);
}

#[test]
fn pins_survive_a_save_and_a_reload() {
    let gid = "g-pin-2";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    remove(&mut alice, gid, "bob:dev1");

    let saved = alice.save_state().expect("save");
    let reloaded = MlsManager::load_or_create("alice", "dev1", Some(saved)).expect("reload");
    // The leaf is gone from every tree, so only the persisted pin can answer.
    let impostor = device("bob", "dev1");
    assert_eq!(
        reloaded.vet_key_package(&impostor.generate_key_package().unwrap(), "bob:dev1"),
        "signature-key-changed"
    );
    assert_eq!(
        reloaded.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "pinned"
    );
}

/// A state written before pins existed holds trees and no pins: the load pins every leaf it holds,
/// which is first sight, so a device already in a conversation keeps being recognised.
#[test]
fn a_state_from_before_pins_existed_is_pinned_from_its_trees_at_load() {
    let gid = "g-pin-3";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");

    let mut state: PersistedState = from_reader(alice.save_state().unwrap().as_slice()).unwrap();
    state.device_pins.clear();
    state.device_events.clear();
    let mut legacy = Vec::new();
    into_writer(&state, &mut legacy).unwrap();

    let reloaded = MlsManager::load_or_create("alice", "dev1", Some(legacy)).expect("reload");
    let impostor = device("bob", "dev1");
    assert_eq!(
        reloaded.vet_key_package(&impostor.generate_key_package().unwrap(), "bob:dev1"),
        "signature-key-changed"
    );
    assert_eq!(
        reloaded.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "pinned"
    );
}

/// Every device a merged commit admits is recorded, by the committer and by every member that
/// merges it - and a commit admitting a pinned identity under another key is MERGED (the group did)
/// but recorded as `key-changed`, and does not move the pin.
#[test]
fn every_merged_admission_is_recorded_and_a_changed_key_is_named() {
    let gid = "g-events-1";
    let mut alice = device("alice", "dev1");
    let mut carol = device("carol", "dev1");
    let mut bob = device("bob", "dev1");
    let mut dave = device("dave", "dev1");
    alice.create_group(gid.into()).expect("create");
    {
        let kp = carol.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut carol, gid, &kp, "carol:dev1")
    };
    alice.take_device_events();
    carol.take_device_events();

    // alice adds bob: alice records her own Add, carol records it when she merges.
    let commit = {
        let kp = bob.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1")
    };
    assert_eq!(carol.process_incoming_message(gid, &commit).unwrap(), None);
    for (who, events) in [
        ("alice", alice.take_device_events()),
        ("carol", carol.take_device_events()),
    ] {
        assert_eq!(events.len(), 1, "{who}: {events:?}");
        let DeviceEvent {
            identity,
            trust,
            added_by,
            epoch,
            group_id,
            ..
        } = &events[0];
        assert_eq!(identity, "bob:dev1", "{who}");
        assert_eq!(*trust, LeafTrust::FirstSight, "{who}");
        assert_eq!(added_by.as_deref(), Some("alice:dev1"), "{who}");
        assert_eq!(*epoch, 2, "{who}");
        assert_eq!(group_id, gid, "{who}");
    }
    assert!(carol.take_device_events().is_empty(), "taken means taken");

    // bob is removed; dave joins AFTER, so dave never saw bob's key and pins nothing for him.
    let removal = remove(&mut alice, gid, "bob:dev1");
    carol.process_incoming_message(gid, &removal).unwrap();
    let dave_in = {
        let kp = dave.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut dave, gid, &kp, "dave:dev1")
    };
    carol.process_incoming_message(gid, &dave_in).unwrap();
    carol.take_device_events();

    // dave adds "bob:dev1" under a key nobody else ever saw it with.
    let impostor = device("bob", "dev1");
    let ((swap, _w, added, _s), _b) = dave
        .add_members_bulk_with_base(
            gid,
            &[&impostor.generate_key_package().unwrap()],
            &["bob:dev1"],
        )
        .expect("dave pinned nothing for bob, so his Add goes through");
    assert_eq!(added, vec![0]);
    dave.merge_pending_commit_for(gid).unwrap();

    // carol MERGES it - refusing would fork her out of the group - and names it.
    assert_eq!(carol.process_incoming_message(gid, &swap).unwrap(), None);
    let events = carol.take_device_events();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].identity, "bob:dev1");
    assert_eq!(events[0].trust, LeafTrust::KeyChanged);
    assert_eq!(events[0].added_by.as_deref(), Some("dave:dev1"));

    // The pin did not move: carol still refuses that key, and still accepts bob's real one.
    assert_eq!(
        carol.vet_key_package(&impostor.generate_key_package().unwrap(), "bob:dev1"),
        "signature-key-changed"
    );
    assert_eq!(
        carol.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "pinned"
    );
}

#[test]
fn pending_events_survive_a_save_and_a_reload() {
    let gid = "g-events-2";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    {
        let kp = bob.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1")
    };
    let saved = alice.save_state().unwrap();
    let mut reloaded = MlsManager::load_or_create("alice", "dev1", Some(saved)).unwrap();
    let events = reloaded.take_device_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].identity, "bob:dev1");
}

/// A HEAL IS NOT A NEW DEVICE. A device removed and re-added under the key it was pinned with - the
/// kick + re-add that repairs a lost Welcome - is the same device: nothing is recorded, so no
/// "added a device" line follows a repair.
#[test]
fn a_re_add_under_the_pinned_key_records_nothing() {
    let gid = "g-events-heal";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    {
        let kp = bob.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1")
    };
    assert_eq!(
        alice.take_device_events().len(),
        1,
        "the first admission is news"
    );

    remove(&mut alice, gid, "bob:dev1");
    bob.forget_group(gid, 0);
    {
        let kp = bob.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1")
    };

    assert!(
        alice.take_device_events().is_empty(),
        "a re-add under the pinned key is a repair, not a new device"
    );
}

/// AN EXTERNAL JOIN PINS NOTHING UNTIL THE SERVER ACCEPTED IT. The tree comes from a GroupInfo the
/// server served; a join the server then refuses (the commit is discarded and the group forgotten)
/// must leave no pin behind.
#[test]
fn an_external_join_pins_its_tree_only_once_merged() {
    let gid = "g-ext-pin";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let bob_kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &bob_kp, "bob:dev1");
    let info = alice.export_group_info(gid).expect("group info");

    // Refused by the server: carol forgets the group, and must have pinned nothing from it.
    let mut carol = device("carol", "dev1");
    carol.join_by_external_commit(&info).expect("stage join");
    carol.forget_group(gid, 0);
    assert_eq!(
        carol.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "first-sight",
        "a refused join must not have pinned the tree it was built on"
    );

    // Accepted: the merge pins the tree.
    carol
        .join_by_external_commit(&info)
        .expect("stage join again");
    carol.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(
        carol.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "pinned"
    );
    assert!(
        carol.take_device_events().is_empty(),
        "joining a tree is not a device being added"
    );
}

/// What a notice is built from (user decision 2026-10-22): a device NEW to a user who was ALREADY in
/// the conversation is "X added a device"; a user joining with their devices is not - that is the
/// member-added line, and announcing each of their devices would turn every new conversation into
/// a list of somebody's phones.
#[test]
fn a_device_joining_its_users_conversation_is_announced_and_a_new_member_is_not() {
    let gid = "g-notice-1";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut bob2 = device("bob", "dev2");
    alice.create_group(gid.into()).expect("create");

    // bob joins the conversation: a new member, not a new device of a member.
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let joined = alice.take_device_events();
    assert_eq!(joined.len(), 1, "{joined:?}");
    assert!(!joined[0].member_already_present, "{joined:?}");
    assert!(!joined[0].announces_new_device(), "{joined:?}");
    bob.take_device_events();

    // bob adds his second device: alice merges it and announces it, and so does bob's first device.
    let kp2 = bob2.generate_key_package().unwrap();
    let commit = add_and_join(&mut bob, &mut bob2, gid, &kp2, "bob:dev2");
    assert_eq!(alice.process_incoming_message(gid, &commit).unwrap(), None);
    let events = alice.take_device_events();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].identity, "bob:dev2");
    assert!(events[0].member_already_present);
    assert!(events[0].announces_new_device());
    assert!(
        !events[0].is_owner_alert("alice", "dev1"),
        "a contact's device"
    );
    let own = bob.take_device_events();
    assert_eq!(own.len(), 1, "{own:?}");
    assert!(
        own[0].is_owner_alert("BOB", "dev1"),
        "bob's own account, any case"
    );
    assert!(
        !own[0].is_owner_alert("bob", "dev2"),
        "the added device never alerts itself about itself"
    );
    assert_eq!(
        own[0].notice_key(),
        format!("bob:dev2|{}", own[0].key_fingerprint)
    );
}

/// A device re-added under the key it was pinned with through the bulk replace path is not a new
/// device either, and no notice can be built from it.
#[test]
fn a_re_add_under_the_pinned_key_is_not_announced() {
    let gid = "g-notice-2";
    let mut alice = device("alice", "dev1");
    let mut carol = device("carol", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = carol.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut carol, gid, &kp, "carol:dev1");
    let kp = bob.generate_key_package().unwrap();
    let c = add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    carol.process_incoming_message(gid, &c).unwrap();
    let r = remove(&mut alice, gid, "bob:dev1");
    carol.process_incoming_message(gid, &r).unwrap();
    carol.take_device_events();

    let same = bob.generate_key_package().unwrap();
    let ((readd, _w, added, _s), _b) = alice
        .add_members_bulk_with_base(gid, &[&same], &["bob:dev1"])
        .unwrap();
    assert_eq!(added, vec![0]);
    alice.merge_pending_commit_for(gid).unwrap();
    carol.process_incoming_message(gid, &readd).unwrap();
    let events = carol.take_device_events();
    assert!(
        events.is_empty(),
        "a re-add under the pinned key announces nothing: {events:?}"
    );
}
