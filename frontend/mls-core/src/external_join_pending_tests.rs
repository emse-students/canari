//! CAN A KEY-GROUP EXTERNAL JOIN BE HELD UNMERGED IN THE PERSISTED STATE, THEN MERGED OR DROPPED
//! WHOLE? Settled against the openmls this crate resolves (0.9.x), through the app's own seal,
//! save and load (`save_encrypted_with_key` / `load_with_key`).
//!
//! In-crate rather than under `tests/` because two of the three branches must look where no public
//! method reaches: the provider's raw storage map (branch B compares it byte for byte) and the
//! `MlsGroup` itself (branch C clears its pending commit WITHOUT the crate's forget).
//!
//! What it established, and what each branch pins:
//! - openmls 0.9 does NOT hold an external join as a pending commit at all.
//!   `ExternalCommitBuilder::finalize` stages the commit and merges it in the same call, so the
//!   group it returns - and the `GroupState` row it writes - is `Operational`, already at
//!   `base + 1`. "Unmerged" exists only in THIS crate, as the `pending_external_joins` marker, which
//!   the sealed state carries (`PersistedState::pending_external_joins`). Branch A pins both halves.
//! - Dropping such a join is `clear_pending_commit_for` -> `forget_group`, and it leaves the
//!   provider's storage byte-identical to before the join (branch B).
//! - Clearing the pending commit in openmls is a no-op on that group (there is none, and openmls
//!   ignores an `External` one too), so a "clear" that keeps the group keeps a group at an epoch the
//!   real group never reached: it cannot read a member's frame, and it blocks the retry (branch C).
use openmls::prelude::GroupId;
use openmls_traits::OpenMlsProvider;

use crate::{DecryptErrorKind, MlsError, MlsManager};

const KEY: [u8; 32] = [7u8; 32];

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// Alice alone in a fresh key group: its id, its epoch, and the GroupInfo the app serves for an
/// external join (`export_group_info` always carries the ratchet tree).
fn alice_group(gid: &str) -> (MlsManager, u64, Vec<u8>) {
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let epoch = alice.get_epoch(gid).expect("alice epoch");
    let info = alice.export_group_info(gid).expect("group info");
    (alice, epoch, info)
}

/// The app's persistence round trip: seal, then open into a FRESH provider.
fn save_and_reload(device: &MlsManager, user_id: &str) -> MlsManager {
    let sealed = device.save_encrypted_with_key(&KEY).expect("save");
    MlsManager::load_with_key(user_id, "dev1", Some(sealed), &KEY).expect("reload")
}

/// Every entry of the provider's storage, ordered, so two snapshots compare byte for byte.
fn storage_snapshot(device: &MlsManager) -> std::collections::BTreeMap<Vec<u8>, Vec<u8>> {
    device
        .provider
        .storage()
        .values
        .read()
        .expect("storage lock")
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// `label entries` per storage owner - the readable half of a failed byte comparison.
fn composition(device: &MlsManager) -> Vec<(String, usize)> {
    let mut rows: Vec<(String, usize)> = device
        .state_composition()
        .expect("composition")
        .into_iter()
        .map(|r| (r.label, r.entries))
        .collect();
    rows.sort();
    rows
}

/// BRANCH A - the join survives a save and a reload unmerged, and merges after it.
///
/// THE ASSUMPTION "openmls holds it as a pending commit" IS REFUTED: the reloaded group has NO
/// pending commit, before and after the reload, and is already at `base + 1`. What IS held across
/// the reload is this crate's marker, and the merge after the reload is what ends it.
#[test]
fn an_unmerged_external_join_survives_a_reload_and_merges_after_it() {
    let gid = "g-ext-pending-a";
    let (mut alice, base, info) = alice_group(gid);
    let mut bob = make_device("bob", "dev1");

    let (joined, commit) = bob.join_by_external_commit(&info).expect("bob joins");
    assert_eq!(joined, gid);

    // openmls merged the commit inside `finalize`: nothing is pending at the engine level.
    assert!(
        !bob.has_pending_commit(gid).expect("bob holds the group"),
        "openmls 0.9 holds NO pending commit for an external join - finalize merged it"
    );
    assert_eq!(bob.get_epoch(gid).expect("epoch"), base + 1);
    assert!(bob.pending_external_joins.contains(gid));

    let mut reloaded = save_and_reload(&bob, "bob");
    drop(bob);

    assert!(
        !reloaded
            .has_pending_commit(gid)
            .expect("the group survives the reload"),
        "the persisted GroupState is Operational: no pending commit comes back from storage"
    );
    assert_eq!(
        reloaded.get_epoch(gid).expect("epoch"),
        base + 1,
        "the reloaded group is already at the epoch its own commit creates"
    );
    assert!(
        reloaded.pending_external_joins.contains(gid),
        "the UNMERGED status survives the reload - as the crate's sealed marker, not as openmls state"
    );

    // The server accepted: the merge after the reload is the crate's - it moves no epoch, and it
    // ends the marker (the tree is pinned here).
    reloaded
        .merge_pending_commit_for(gid)
        .expect("merge after reload");
    assert!(!reloaded.pending_external_joins.contains(gid));
    assert_eq!(reloaded.get_epoch(gid).expect("epoch"), base + 1);

    alice
        .process_incoming_message(gid, &commit)
        .expect("alice processes bob's external commit");
    assert_eq!(alice.get_epoch(gid).expect("alice epoch"), base + 1);

    let to_bob = alice.send_message(gid, b"hello bob").expect("alice sends");
    let read = reloaded
        .process_incoming_message(gid, &to_bob)
        .expect("bob decrypts")
        .expect("application");
    assert_eq!(read, b"hello bob");
    let to_alice = reloaded
        .send_message(gid, b"hello alice")
        .expect("bob sends");
    let read = alice
        .process_incoming_message(gid, &to_alice)
        .expect("alice decrypts")
        .expect("application");
    assert_eq!(read, b"hello alice");
}

/// BRANCH B - dropping the unmerged join leaves the provider exactly as it was before it.
#[test]
fn dropping_an_unmerged_external_join_leaves_the_key_set_byte_identical() {
    let gid = "g-ext-pending-b";
    let (mut alice, _base, info) = alice_group(gid);
    let mut bob = make_device("bob", "dev1");
    let kp_kept = bob
        .generate_key_package()
        .expect("a key package minted before the join");
    bob.generate_key_packages(3).expect("a small pool");

    let storage_before = storage_snapshot(&bob);
    let composition_before = composition(&bob);
    let key_packages_before = bob.key_package_keys().expect("key packages");
    let signature_key_before = bob.keypair.public().to_vec();

    bob.join_by_external_commit(&info).expect("bob joins");
    assert_ne!(
        storage_snapshot(&bob),
        storage_before,
        "control: the join wrote group rows into the provider"
    );
    // The server refused: the app's drop.
    bob.clear_pending_commit_for(gid).expect("drop the join");

    assert!(
        bob.get_known_groups().is_empty(),
        "the group is gone from memory"
    );
    assert!(
        openmls::prelude::MlsGroup::load(
            bob.provider.storage(),
            &GroupId::from_slice(gid.as_bytes())
        )
        .expect("storage read")
        .is_none(),
        "the group is gone from storage"
    );
    assert_eq!(
        composition(&bob),
        composition_before,
        "storage owners and counts after the drop"
    );
    assert!(
        storage_snapshot(&bob) == storage_before,
        "the provider's storage is byte-identical to the snapshot taken before the join"
    );
    assert_eq!(bob.keypair.public(), signature_key_before.as_slice());
    assert_eq!(
        bob.key_package_keys().expect("key packages"),
        key_packages_before
    );

    // And through the app's persistence, since the drop is only real once it is what loads.
    let mut reloaded = save_and_reload(&bob, "bob");
    assert!(
        storage_snapshot(&reloaded) == storage_before,
        "the reloaded storage is byte-identical to the snapshot taken before the join"
    );
    assert_eq!(reloaded.keypair.public(), signature_key_before.as_slice());

    // INTACT means USABLE: a key package minted before the join still opens a Welcome.
    let (_c, welcome, _added, _skipped) =
        alice.add_members_bulk(gid, &[&kp_kept]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    reloaded
        .process_welcome(welcome.as_deref().expect("welcome"), Some(&tree))
        .expect("bob's pre-join key package opens the Welcome");
    let frame = alice.send_message(gid, b"after the drop").expect("send");
    let read = reloaded
        .process_incoming_message(gid, &frame)
        .expect("bob decrypts")
        .expect("application");
    assert_eq!(read, b"after the drop");
}

/// BRANCH C - a clear that keeps the group leaves a group nobody else is in. Why "drop whole".
#[test]
fn clearing_an_external_join_without_dropping_the_group_leaves_it_unusable() {
    let gid = "g-ext-pending-c";
    let (mut alice, base, info) = alice_group(gid);
    let mut bob = make_device("bob", "dev1");
    bob.join_by_external_commit(&info).expect("bob joins");
    // The server refused bob's commit: alice never sees it and stays at `base`.

    // The clear WITHOUT the forget: openmls's own clear on the group, and the crate's marker gone.
    {
        let group = bob.groups.get_mut(gid).expect("bob holds the group");
        group
            .clear_pending_commit(bob.provider.storage())
            .expect("openmls accepts the clear");
        assert!(group.pending_commit().is_none());
        assert_eq!(
            group.epoch().as_u64(),
            base + 1,
            "the clear undid NOTHING: there is no prior epoch for an external joiner to fall back to"
        );
    }
    bob.pending_external_joins.remove(gid);
    // It persists that way, so a restart does not rescue it.
    let mut bob = save_and_reload(&bob, "bob");
    assert_eq!(bob.get_epoch(gid).expect("epoch"), base + 1);

    // 1. A member's frame at the real epoch cannot be read.
    let frame = alice
        .send_message(gid, b"to the real group")
        .expect("alice sends");
    let refused = bob
        .process_incoming_message(gid, &frame)
        .expect_err("bob's group is at an epoch the group never reached");
    assert_eq!(
        refused.decrypt_kind(),
        DecryptErrorKind::PastEpochApplication,
        "{refused:?}"
    );

    // 2. What bob sends, no member can read.
    let from_bob = bob
        .send_message(gid, b"into the void")
        .expect("bob seals at base + 1");
    assert!(
        alice.process_incoming_message(gid, &from_bob).is_err(),
        "alice holds no epoch base + 1"
    );

    // 3. The retry is blocked: a fresh base is refused because the dead group is still held.
    let fresh = alice.export_group_info(gid).expect("fresh base");
    let blocked = bob
        .join_by_external_commit(&fresh)
        .expect_err("the kept group blocks the retry");
    assert!(
        matches!(blocked, MlsError::GroupAlreadyHeld(ref id) if id == gid),
        "{blocked:?}"
    );

    // CONTROL - dropped whole, the same retry converges.
    bob.forget_group(gid, 0);
    let (_, commit) = bob
        .join_by_external_commit(&fresh)
        .expect("the retry after a whole drop");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies the retry");
    bob.merge_pending_commit_for(gid).expect("merge");
    let frame = alice.send_message(gid, b"after the retry").expect("send");
    let read = bob
        .process_incoming_message(gid, &frame)
        .expect("bob decrypts")
        .expect("application");
    assert_eq!(read, b"after the retry");
}
