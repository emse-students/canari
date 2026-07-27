/// Tests for the anti-duplicate guard in `add_members_bulk`.
///
/// Context: if a device adds another device in bulk, merges the commit locally, then fails to
/// deliver the Welcome/commit over the network, that device stays a "ghost member" in the local
/// MLS tree without ever being notified. Re-inviting the same device then failed the whole commit
/// with `ProposalValidationError(DuplicateSignatureKey)` on the OpenMLS side, blocking the other
/// invitees of the same batch too. `add_members_bulk` must now filter those duplicates up front and
/// report the "every member of the batch is already in" case via `MlsError::AlreadyMember`.
use mls_core::{MlsError, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

#[test]
fn add_members_bulk_rejects_keypackage_of_an_existing_member() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-dedup-1";

    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");

    // First add: must succeed and include bob at index 0.
    let (_, welcome, added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("first add should succeed");
    assert_eq!(added, vec![0]);
    // Stage-only add (C7-A): merge as if the server accepted, then export the post-merge tree.
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");

    // bob is now a real member of alice's local tree. Had an earlier attempt merged a similar
    // commit without ever delivering the Welcome, alice would be in the same state: bob present in
    // the tree, re-invitation required.
    let kp_bob_again = bob.generate_key_package().expect("kp bob again");
    let err = alice
        .add_members_bulk(gid, &[&kp_bob_again])
        .expect_err("re-adding an existing member must fail distinctly");
    assert!(
        matches!(err, MlsError::AlreadyMember(_)),
        "expected AlreadyMember, got {err:?}"
    );
}

#[test]
fn add_members_bulk_skips_existing_member_but_adds_the_rest_of_the_batch() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let mut carol = make_device("carol", "dev1");
    let gid = "g-dedup-2";

    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_, welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("bob joins first");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");

    // Mixed batch: bob (already a member - must be skipped) + carol (new - must be added).
    let kp_bob_stale = bob.generate_key_package().expect("kp bob stale");
    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (_, welcome2, added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob_stale, &kp_carol])
        .expect("mixed batch should still add carol");

    // Only index 1 (carol) must be marked as added.
    assert_eq!(added, vec![1]);
    alice
        .merge_pending_commit_for(gid)
        .expect("merge add carol");
    let rt2 = alice.export_ratchet_tree_for(gid).expect("tree");
    carol
        .process_welcome(welcome2.as_deref().unwrap(), Some(&rt2))
        .expect("carol joins");
}

/// [[C5]] An invalid/unreadable KeyPackage must not vanish silently: its index must be reported in
/// `skipped_indices` (and NOT in `added_indices`), while the valid KeyPackages of the same batch
/// are added normally.
#[test]
fn add_members_bulk_reports_invalid_keypackage_in_skipped_indices() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-skip-1";

    alice.create_group(gid.to_string()).expect("create_group");

    // Index 0: corrupted bytes (deserialization failure) -> must be marked skipped.
    let garbage: Vec<u8> = vec![0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03];
    // Index 1: bob's valid KeyPackage -> must be added.
    let kp_bob = bob.generate_key_package().expect("kp bob");

    let (_, welcome, added, skipped) = alice
        .add_members_bulk(gid, &[&garbage, &kp_bob])
        .expect("batch with one invalid KP still adds the valid one");

    assert_eq!(added, vec![1], "only bob (index 1) must be added");
    assert_eq!(
        skipped,
        vec![0],
        "the corrupted KeyPackage (index 0) must be reported in skipped_indices"
    );

    // The valid member does join despite the invalid KP in the batch.
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins despite the skipped invalid KP");
}
