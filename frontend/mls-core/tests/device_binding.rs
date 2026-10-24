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

/// THE KEY A VERIFIER MAY TRUST IS THE ONE THIS DEVICE SAW IN A SIGNED TREE. `pinned_signature_keys`
/// answers from the pins alone: the key a merged Add admitted, under any spelling of the user half,
/// and `None` for a device never seen or an identity that is not one - which a verifier reads as
/// "unverified", never as "forged".
#[test]
fn the_pinned_signature_key_is_the_one_a_signed_tree_carried() {
    let gid = "g-pinned-key";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");

    assert_eq!(
        alice.pinned_signature_keys("bob", "dev1"),
        None,
        "never seen"
    );

    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let admitted = alice.take_device_events();
    assert_eq!(admitted.len(), 1);

    let keys = alice
        .pinned_signature_keys("bob", "dev1")
        .expect("a device admitted by a merged commit is pinned");
    assert_eq!(keys.keys.len(), 1);
    assert!(keys.anchored, "a first sight is anchored");
    assert_eq!(
        mls_core::device_trust::key_fingerprint(&keys.keys[0]),
        admitted[0].key_fingerprint,
        "the pinned key is the leaf's key"
    );
    assert_eq!(
        alice.pinned_signature_keys("BOB", "dev1"),
        Some(keys.clone()),
        "the user half ignores case, as the binding does"
    );
    assert_eq!(
        alice.pinned_signature_keys("bob", "DEV1"),
        None,
        "the device half is exact"
    );
    assert_eq!(
        alice.pinned_signature_keys("bob", "dev1:x"),
        None,
        "not an identity"
    );
    // The joiner pinned the tree it joined: the creator's key is known to it, once.
    let alice_from_bob = bob
        .pinned_signature_keys("alice", "dev1")
        .expect("the joiner pins the tree it joined");
    assert_eq!(alice_from_bob.keys.len(), 1);
}

/// A CHECKPOINT BETWEEN AN EXTERNAL JOIN AND ITS MERGE PINS NOTHING AT RELOAD: the marker is in the
/// sealed state, so the load does not seed the tree the server served, and the merge still pins it.
#[test]
fn an_external_join_checkpointed_before_its_merge_pins_nothing_at_reload() {
    let gid = "g-ext-restart";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let info = alice.export_group_info(gid).expect("group info");

    let mut carol = device("carol", "dev1");
    carol.join_by_external_commit(&info).expect("stage join");
    let saved = carol.save_state().expect("checkpoint");
    let state: PersistedState = from_reader(saved.as_slice()).unwrap();
    assert_eq!(state.pending_external_joins, vec![gid.to_string()]);

    let mut reloaded = MlsManager::load_or_create("carol", "dev1", Some(saved)).expect("reload");
    assert_eq!(
        reloaded.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "first-sight",
        "a reload must not pin the tree of a join not yet accepted"
    );
    reloaded.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(
        reloaded.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "pinned"
    );
}

/// CLEARING AN EXTERNAL JOIN'S COMMIT DROPS THE MARKER AND THE GROUP: nothing of a refused join is
/// left for a later load to pin.
#[test]
fn clearing_an_external_join_leaves_no_marker_and_nothing_to_pin() {
    let gid = "g-ext-clear";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let info = alice.export_group_info(gid).expect("group info");

    let mut carol = device("carol", "dev1");
    carol.join_by_external_commit(&info).expect("stage join");
    carol.clear_pending_commit_for(gid).expect("clear");
    assert!(carol.get_epoch(gid).is_err(), "the group is gone");

    let saved = carol.save_state().expect("save");
    let state: PersistedState = from_reader(saved.as_slice()).unwrap();
    assert!(state.pending_external_joins.is_empty());
    let reloaded = MlsManager::load_or_create("carol", "dev1", Some(saved)).expect("reload");
    assert_eq!(
        reloaded.vet_key_package(&bob.generate_key_package().unwrap(), "bob:dev1"),
        "first-sight"
    );
}

/// A COMMIT A DEVICE SIGNED REAFFIRMS ITS PIN: the count a refusal caused by one forged KeyPackage
/// is lifted by (`refusedDevices.ts`).
#[test]
fn a_commit_signed_by_a_pinned_device_reaffirms_its_pin() {
    let gid = "g-reaffirm";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut carol = device("carol", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let before = alice
        .pinned_signature_keys("bob", "dev1")
        .unwrap()
        .reaffirmations;

    let kp = carol.generate_key_package().unwrap();
    let by_bob = add_and_join(&mut bob, &mut carol, gid, &kp, "carol:dev1");
    alice.process_incoming_message(gid, &by_bob).unwrap();

    assert_eq!(
        alice
            .pinned_signature_keys("bob", "dev1")
            .unwrap()
            .reaffirmations,
        before + 1
    );
    let saved = alice.save_state().unwrap();
    let reloaded = MlsManager::load_or_create("alice", "dev1", Some(saved)).unwrap();
    assert_eq!(
        reloaded
            .pinned_signature_keys("bob", "dev1")
            .unwrap()
            .reaffirmations,
        before + 1,
        "persisted"
    );
}

/// A MERGE WITH NOTHING PENDING PROVES NOTHING: no commit was signed, so no pin is reaffirmed - our
/// own included - and the trust state is not touched.
#[test]
fn a_merge_with_nothing_pending_reaffirms_no_pin() {
    let gid = "g-noop-merge";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let own = alice
        .pinned_signature_keys("alice", "dev1")
        .expect("own pin")
        .reaffirmations;
    let others = alice
        .pinned_signature_keys("bob", "dev1")
        .unwrap()
        .reaffirmations;
    alice.take_device_events();

    alice.merge_pending_commit_for(gid).expect("no-op merge");

    let after = |user: &str| {
        alice
            .pinned_signature_keys(user, "dev1")
            .unwrap()
            .reaffirmations
    };
    assert_eq!(after("alice"), own, "own pin untouched");
    assert_eq!(after("bob"), others, "member pin untouched");
    assert!(alice.take_device_events().is_empty());
}

/// A DEPARTURE IS RECORDED AT MERGE TIME, so a device that never saw the tree between a kick and a
/// re-add - it caught up on both commits later - records the removal all the same, in the sealed
/// state, and as no device event.
#[test]
fn a_kick_then_a_re_add_seen_only_by_catch_up_still_records_the_departure() {
    let gid = "g-departure-catchup";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut carol = device("carol", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = carol.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut carol, gid, &kp, "carol:dev1");
    let kp = bob.generate_key_package().unwrap();
    let bob_in = add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    carol.process_incoming_message(gid, &bob_in).unwrap();
    carol.take_device_events();

    // carol is away: bob is kicked, then re-added, in two commits.
    let kick = remove(&mut alice, gid, "bob:dev1");
    let removed_at = alice.get_epoch(gid).unwrap();
    bob.forget_group(gid, 0);
    let kp = bob.generate_key_package().unwrap();
    let re_add = add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    assert_eq!(alice.removal_epochs(gid, "bob"), vec![removed_at]);

    // carol catches up, in order, and only ever holds the tree before and after both.
    carol.process_incoming_message(gid, &kick).unwrap();
    carol.process_incoming_message(gid, &re_add).unwrap();
    assert_eq!(carol.removal_epochs(gid, "bob"), vec![removed_at]);
    assert_eq!(
        carol.removal_epochs(gid, "BOB"),
        vec![removed_at],
        "the user half ignores case"
    );
    assert!(carol.removal_epochs(gid, "carol").is_empty());
    assert!(
        carol.take_device_events().is_empty(),
        "a departure is never a device event"
    );

    let saved = carol.save_state().expect("save");
    let reloaded = MlsManager::load_or_create("carol", "dev1", Some(saved)).expect("reload");
    assert_eq!(
        reloaded.removal_epochs(gid, "bob"),
        vec![removed_at],
        "kept in the sealed state"
    );
}

/// A HEAL IS NOT A DEPARTURE: a resync that swaps a device's leaf in ONE commit (an external rejoin
/// under the same key, whose commit removes the old leaf) and the removal of one device among
/// several leave the user in the tree, and record nothing.
#[test]
fn a_resync_or_the_removal_of_one_device_among_several_records_no_departure() {
    let gid = "g-departure-heal";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut bob2 = device("bob", "dev2");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");

    // bob lost the group and rejoins by external commit: one commit, old leaf out, new leaf in.
    bob.forget_group(gid, 0);
    let info = alice.export_group_info(gid).expect("group info");
    let (_gid, rejoin) = bob.join_by_external_commit(&info).expect("rejoin");
    bob.merge_pending_commit_for(gid).expect("merge rejoin");
    let before = alice.get_epoch(gid).unwrap();
    alice.process_incoming_message(gid, &rejoin).unwrap();
    assert_eq!(
        alice.get_epoch(gid).unwrap(),
        before + 1,
        "the rejoin merged"
    );
    assert!(
        alice.removal_epochs(gid, "bob").is_empty(),
        "a resync is not a departure"
    );

    // bob's second device joins, then the first is removed: bob is still in the tree.
    let kp = bob2.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob2, gid, &kp, "bob:dev2");
    remove(&mut alice, gid, "bob:dev1");
    assert!(
        alice.removal_epochs(gid, "bob").is_empty(),
        "one device among several leaving is not the user leaving"
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
        Some(format!("bob:dev2|{}", own[0].key_fingerprint))
    );
}

/// AN ENTRY NO MEMBER MADE, as the record shows it - the contract `entersUninvited` (TypeScript)
/// reads: an external commit is signed by the very leaf it admits (`added_by == identity`), and a
/// new user's arrives with `member_already_present == false`. A member's Add of a new user is signed
/// by the member, so the two never look alike.
#[test]
fn an_external_commit_by_a_new_user_is_recorded_as_signed_by_the_device_it_admits() {
    let gid = "g-uninvited-1";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    alice.take_device_events();

    let mut carol = device("carol", "dev1");
    let info = alice.export_group_info(gid).expect("group info");
    let (_gid, commit) = carol
        .join_by_external_commit(&info)
        .expect("external commit");
    assert_eq!(alice.process_incoming_message(gid, &commit).unwrap(), None);
    assert_eq!(bob.process_incoming_message(gid, &commit).unwrap(), None);
    bob.take_device_events();

    let events = alice.take_device_events();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].identity, "carol:dev1");
    assert_eq!(events[0].added_by.as_deref(), Some("carol:dev1"));
    assert!(!events[0].member_already_present, "{events:?}");

    // The control: a member adding a new user signs the commit themselves.
    let mut dave = device("dave", "dev1");
    let kp = dave.generate_key_package().unwrap();
    let commit = add_and_join(&mut alice, &mut dave, gid, &kp, "dave:dev1");
    assert_eq!(bob.process_incoming_message(gid, &commit).unwrap(), None);
    let added = bob
        .take_device_events()
        .into_iter()
        .find(|e| e.identity == "dave:dev1")
        .expect("dave recorded");
    assert_eq!(added.added_by.as_deref(), Some("alice:dev1"));
    assert!(!added.member_already_present);
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

/// THE REPAIR IS ONE COMMIT: a device asking to be re-added while its leaf is still in the tree is
/// removed and added back by a single commit, so no epoch has the user out of the tree and no
/// departure is recorded - neither by the committer, nor live by a member, nor by one catching up.
/// The Welcome reaches the re-added device, which lands at the same epoch.
#[test]
fn a_repair_in_one_commit_records_no_departure_live_or_on_catch_up() {
    let gid = "g-repair-one-commit";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut carol = device("carol", "dev1");
    let mut dave = device("dave", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = carol.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut carol, gid, &kp, "carol:dev1");
    let kp = dave.generate_key_package().unwrap();
    let dave_in = add_and_join(&mut alice, &mut dave, gid, &kp, "dave:dev1");
    carol.process_incoming_message(gid, &dave_in).unwrap();
    let kp = bob.generate_key_package().unwrap();
    let bob_in = add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    carol.process_incoming_message(gid, &bob_in).unwrap();
    dave.process_incoming_message(gid, &bob_in).unwrap();
    for m in [&mut alice, &mut carol, &mut dave] {
        m.take_device_events();
    }

    // bob lost the group but kept its key: alice repairs it in ONE commit.
    bob.forget_group(gid, 0);
    let kp = bob.generate_key_package().unwrap();
    let (repair, welcome, _base) = alice
        .replace_device_with_base(gid, "bob:dev1", &kp)
        .expect("one commit removes and re-adds the same identity");
    alice.merge_pending_commit_for(gid).expect("merge");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(&welcome, Some(&tree))
        .expect("the Welcome reaches the re-added device");
    assert_eq!(bob.get_epoch(gid).unwrap(), alice.get_epoch(gid).unwrap());

    // carol merges it live; dave catches up on it after one more commit.
    carol.process_incoming_message(gid, &repair).unwrap();
    let later = remove(&mut alice, gid, "carol:dev1");
    dave.process_incoming_message(gid, &repair).unwrap();
    dave.process_incoming_message(gid, &later).unwrap();

    assert!(alice.removal_epochs(gid, "bob").is_empty(), "committer");
    assert!(carol.removal_epochs(gid, "bob").is_empty(), "live");
    assert!(dave.removal_epochs(gid, "bob").is_empty(), "catch-up");
    assert!(
        !dave.removal_epochs(gid, "carol").is_empty(),
        "a real removal still is one"
    );
    for (who, m) in [("alice", &mut alice), ("carol", &mut carol)] {
        assert!(
            m.take_device_events().is_empty(),
            "{who}: a repair under the pinned key is no new device"
        );
    }
}

/// A repair whose package carries a key never pinned for the device stages nothing.
#[test]
fn a_repair_refuses_an_unpinned_key_and_stages_nothing() {
    let gid = "g-repair-refused";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let epoch = alice.get_epoch(gid).unwrap();

    let impostor = device("bob", "dev1");
    let forged = impostor.generate_key_package().unwrap();
    assert!(
        alice
            .replace_device_with_base(gid, "bob:dev1", &forged)
            .is_err()
    );
    assert_eq!(alice.get_epoch(gid).unwrap(), epoch);
    assert!(
        alice
            .replace_device_with_base(gid, "nobody:dev1", &bob.generate_key_package().unwrap())
            .is_err(),
        "nothing to replace is not an add"
    );
}

/// THE DUPLICATE-KEY CASE IS THE SAME REPAIR. A device that kept its key but lost the group offers a
/// package whose key a leaf already carries: the plain Add does not put it beside that leaf, and the
/// replacement of the same identity is one commit that records no departure, live or committed.
#[test]
fn a_duplicate_key_is_repaired_in_one_commit_with_no_departure() {
    let gid = "g-repair-duplicate";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut carol = device("carol", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = carol.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut carol, gid, &kp, "carol:dev1");
    let kp = bob.generate_key_package().unwrap();
    let bob_in = add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    carol.process_incoming_message(gid, &bob_in).unwrap();
    let epoch = alice.get_epoch(gid).unwrap();

    bob.forget_group(gid, 0);
    let kp = bob.generate_key_package().unwrap();
    match alice.add_members_bulk_with_base(gid, &[&kp], &["bob:dev1"]) {
        Err(_) => {}
        Ok(((_, _, added, _), _)) => assert!(added.is_empty(), "never beside the live leaf"),
    }
    assert_eq!(alice.get_epoch(gid).unwrap(), epoch, "nothing merged");
    alice.clear_pending_commit_for(gid).expect("clear");

    let (repair, welcome, _base) = alice
        .replace_device_with_base(gid, "bob:dev1", &kp)
        .expect("the same identity is replaced in one commit");
    alice.merge_pending_commit_for(gid).expect("merge");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(&welcome, Some(&tree))
        .expect("the Welcome reaches the re-added device");
    carol.process_incoming_message(gid, &repair).unwrap();
    assert!(alice.removal_epochs(gid, "bob").is_empty(), "committer");
    assert!(carol.removal_epochs(gid, "bob").is_empty(), "live");
}

/// ONE CANONICAL IDENTITY FOR THE PINS AND THE BINDING. The binding reads the user half without
/// case, so the pin store and every lookup must too: a spelling the binding accepts as the pinned
/// device IS that device, and another key under it is a changed key - for an Add, for a replace, and
/// for a member merging somebody else's commit.
#[test]
fn a_spelling_of_a_pinned_device_is_that_device_everywhere() {
    let gid = "g-canonical";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let mut carol = device("carol", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = carol.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut carol, gid, &kp, "carol:dev1");
    let kp = bob.generate_key_package().unwrap();
    let bob_in = add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    carol.process_incoming_message(gid, &bob_in).unwrap();
    carol.take_device_events();

    let mut other = device("BOB", "dev1");
    let kp = other.generate_key_package().unwrap();
    assert_eq!(
        alice.vet_key_package(&kp, "bob:dev1"),
        "signature-key-changed"
    );
    let epoch = alice.get_epoch(gid).unwrap();
    assert!(
        alice
            .add_members_bulk_with_base(gid, &[&kp], &["bob:dev1"])
            .is_err(),
        "an Add of that package alone adds nobody"
    );
    assert_eq!(alice.get_epoch(gid).unwrap(), epoch);
    assert!(
        alice
            .replace_device_with_base(gid, "bob:dev1", &kp)
            .is_err()
    );

    // Admitted by a commit carol only merges: it is a key change for her, never a first sight.
    let info = alice.export_group_info(gid).expect("group info");
    let (_g, join) = other.join_by_external_commit(&info).expect("join");
    carol.process_incoming_message(gid, &join).unwrap();
    let events = carol.take_device_events();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].trust, LeafTrust::KeyChanged);
}

/// A PERSISTED PIN IS NEVER MERGED INTO ANOTHER: every pin this code writes is keyed canonically, so
/// a record under another spelling is not this device's pin and lends it no key - a key conflict
/// between two records must stay a conflict, never become trust.
#[test]
fn a_persisted_pin_under_another_spelling_lends_its_key_to_nobody() {
    let gid = "g-no-merge-at-load";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");

    // The impostor's key, read from a group that pinned it.
    let impostor = device("bob", "dev1");
    let impostor_kp = impostor.generate_key_package().unwrap();
    let mut observer = device("zed", "dev1");
    observer.create_group("g-observer".into()).expect("create");
    observer
        .add_members_bulk_with_base("g-observer", &[&impostor_kp], &["bob:dev1"])
        .expect("stage");
    observer
        .merge_pending_commit_for("g-observer")
        .expect("merge");
    let impostor_key = observer
        .pinned_signature_keys("bob", "dev1")
        .expect("pinned")
        .keys;

    let mut state: PersistedState = from_reader(alice.save_state().unwrap().as_slice()).unwrap();
    state
        .device_pins
        .push(mls_core::device_trust::PersistedPin {
            identity: "BOB:dev1".into(),
            keys: impostor_key,
            anchored: true,
            reaffirmations: 0,
        });
    let mut bytes = Vec::new();
    into_writer(&state, &mut bytes).unwrap();
    let reloaded = MlsManager::load_or_create("alice", "dev1", Some(bytes)).expect("reload");
    assert_eq!(
        reloaded.vet_key_package(&impostor_kp, "bob:dev1"),
        "signature-key-changed"
    );
}

/// A DUPLICATE KEY IS ATTRIBUTED FROM THE TREE: the leaf carrying a KeyPackage's signature key is
/// named, so a caller never assumes the duplicate is the identity it asked for.
#[test]
fn the_leaf_holding_a_key_packages_key_is_named() {
    let gid = "g-key-holder";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");

    let again = bob.generate_key_package().unwrap();
    assert_eq!(
        alice.leaf_holding_key_of(gid, &again).unwrap().as_deref(),
        Some("bob:dev1")
    );
    let stranger = device("carol", "dev1").generate_key_package().unwrap();
    assert_eq!(alice.leaf_holding_key_of(gid, &stranger).unwrap(), None);
    assert!(alice.leaf_holding_key_of(gid, b"not a package").is_err());
}

/// A GRAINE MINTER IS FOUND IN THE TREE UNDER ANY SPELLING THE BINDING ACCEPTS: a seed naming a
/// device that IS a leaf is judged against that leaf's key, never against the server's published
/// keys - which a different spelling missing the leaf would fall back to.
#[test]
fn a_spelling_of_a_device_in_the_tree_finds_its_leaf_key() {
    let gid = "g-canonical-minter";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");

    let leaf = alice
        .member_signature_key(gid, "bob:dev1")
        .unwrap()
        .expect("bob is a leaf");
    assert_eq!(
        alice.member_signature_key(gid, "BOB:dev1").unwrap(),
        Some(leaf)
    );
    assert_eq!(
        alice.member_signature_key(gid, "bob:DEV1").unwrap(),
        None,
        "the device half is exact"
    );
}

/// A LEAF WHOSE CREDENTIAL SPELLS THE USER HALF IN CAPITALS IS REMOVED by the roster's lower-cased
/// user id, and by its device identity - the removal paths match as the binding admits.
#[test]
fn a_leaf_spelt_in_capitals_is_removed_by_the_canonical_ids() {
    for by_user in [true, false] {
        let gid = if by_user { "g-rm-user" } else { "g-rm-device" };
        let mut alice = device("alice", "dev1");
        let mut bob = device("BOB", "dev1");
        alice.create_group(gid.into()).expect("create");
        let kp = bob.generate_key_package().unwrap();
        add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
        let staged = if by_user {
            alice.remove_members_for_users(gid, &["bob"])
        } else {
            alice.remove_members_for_devices(gid, &["bob:dev1"])
        };
        staged.expect("the capitalised leaf is the device the roster names");
        alice.merge_pending_commit_for(gid).expect("merge");
        assert_eq!(alice.member_identities(gid).unwrap(), vec!["alice:dev1"]);
    }
}

/// ONE BATCH MAY NOT ADD TWO LEAVES FOR ONE CANONICAL DEVICE: the dedupe reads identities as the
/// binding does.
#[test]
fn one_batch_adds_one_leaf_per_canonical_device() {
    let gid = "g-batch-dedupe";
    let mut alice = device("alice", "dev1");
    alice.create_group(gid.into()).expect("create");
    let one = device("carol", "dev1").generate_key_package().unwrap();
    let two = device("CAROL", "dev1").generate_key_package().unwrap();
    let ((_, _, added, _), _) = alice
        .add_members_bulk_with_base(gid, &[&one, &two], &["carol:dev1", "carol:dev1"])
        .expect("stage");
    assert_eq!(added, vec![0]);
}

/// A COMMIT ON A GROUP WHOSE EXTERNAL JOIN IS STILL PENDING IS NOT MERGED, so nothing is seeded from
/// the tree the server served. Both commits were built on the same epoch and the joiner's group
/// already stands at the epoch its own join creates, so the member's commit is dropped as a past
/// handshake (`Ok(None)`), not refused with an error.
#[test]
fn a_members_commit_before_the_join_merges_is_not_merged_and_pins_nothing() {
    let gid = "g-ext-pending-commit";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let info = alice.export_group_info(gid).expect("group info");

    let mut carol = device("carol", "dev1");
    carol.join_by_external_commit(&info).expect("stage join");
    let commit = remove(&mut alice, gid, "bob:dev1");
    let epoch = carol.get_epoch(gid).unwrap();
    let outcome = carol.process_incoming_message(gid, &commit);
    assert!(
        matches!(outcome, Ok(None)),
        "dropped as a past handshake: {outcome:?}"
    );
    assert_eq!(carol.get_epoch(gid).unwrap(), epoch, "nothing merged");
    assert_eq!(
        carol.vet_key_package(
            &device("bob", "dev1").generate_key_package().unwrap(),
            "bob:dev1"
        ),
        "first-sight",
        "nothing pinned from the served tree"
    );
}

/// `alice` holding `gid` with bob in it, reloaded from a state with NO pins and a commit staged -
/// the group the load does not seed.
fn unpinned_with_a_staged_commit(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    let carol = device("carol", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    add_and_join(&mut alice, &mut bob, gid, &kp, "bob:dev1");
    let kp = carol.generate_key_package().unwrap();
    alice
        .add_members_bulk_with_base(gid, &[&kp], &["carol:dev1"])
        .expect("stage");
    let mut state: PersistedState = from_reader(alice.save_state().unwrap().as_slice()).unwrap();
    state.device_pins.clear();
    let mut bytes = Vec::new();
    into_writer(&state, &mut bytes).unwrap();
    let reloaded = MlsManager::load_or_create("alice", "dev1", Some(bytes)).expect("reload");
    assert_eq!(
        reloaded.vet_key_package(
            &device("bob", "dev1").generate_key_package().unwrap(),
            "bob:dev1"
        ),
        "first-sight",
        "the load did not seed a group with a staged commit"
    );
    (reloaded, bob)
}

/// A REPLACE PROVES ITSELF WITH THE TREE, NOT ONLY WITH A PIN: the new key must be the one the leaf
/// it removes carries, so a device with no pin for it still refuses another key.
#[test]
fn a_replace_requires_the_key_of_the_leaf_it_removes_even_without_a_pin() {
    let gid = "g-replace-unpinned";
    let (mut alice, bob) = unpinned_with_a_staged_commit(gid);
    alice.clear_pending_commit_for(gid).expect("clear");
    let epoch = alice.get_epoch(gid).unwrap();

    let other = device("bob", "dev1");
    assert!(
        alice
            .replace_device_with_base(gid, "bob:dev1", &other.generate_key_package().unwrap())
            .is_err(),
        "another key than the leaf's is no repair"
    );
    assert_eq!(alice.get_epoch(gid).unwrap(), epoch);
    alice
        .replace_device_with_base(gid, "bob:dev1", &bob.generate_key_package().unwrap())
        .expect("the leaf's own key is");
}

/// A GROUP THE LOAD DID NOT SEED IS SEEDED ONCE ITS COMMIT MERGES: the tree it had is one this
/// device accepted, so its members are pinned from then on.
#[test]
fn a_group_left_unseeded_by_a_staged_commit_is_seeded_at_its_merge() {
    let gid = "g-seed-at-merge";
    let (mut alice, _bob) = unpinned_with_a_staged_commit(gid);
    alice.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(
        alice.vet_key_package(
            &device("bob", "dev1").generate_key_package().unwrap(),
            "bob:dev1"
        ),
        "signature-key-changed"
    );
}

/// AND WHEN ITS STAGED COMMIT IS REFUSED: the tree it falls back to is the one this device held
/// before staging, so it is seeded then - not left unpinned until the next load.
#[test]
fn a_group_left_unseeded_by_a_staged_commit_is_seeded_when_the_commit_is_cleared() {
    let gid = "g-seed-at-clear";
    let (mut alice, _bob) = unpinned_with_a_staged_commit(gid);
    alice.clear_pending_commit_for(gid).expect("clear");
    assert_eq!(
        alice.vet_key_package(
            &device("bob", "dev1").generate_key_package().unwrap(),
            "bob:dev1"
        ),
        "signature-key-changed"
    );
}
