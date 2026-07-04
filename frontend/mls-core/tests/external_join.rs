//! External-commit join (Phase 4): a member lacking local MLS state rejoins a group by building
//! an external commit from a served GroupInfo, WITHOUT waiting for a peer Welcome. This is the
//! self-service replacement for the CAS/successor/reboot dance.
//!
//! Invariants exercised:
//! - `export_group_info` yields a self-contained blob (ratchet tree included) that another device
//!   can consume with nothing else.
//! - `join_by_external_commit` returns a group already at the NEW epoch (unlike add/remove staging,
//!   an external commit is applied to the returned instance immediately); `merge_pending_commit_for`
//!   finalizes it and is required before the group can message. The commit is submitted for server
//!   epoch validation against the GroupInfo's (base) epoch; on reject the group is discarded.
//! - An existing member processes the external commit and both sides converge (messages flow).
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates a group and adds bob (staged then merged). Shared setup.
fn group_with_alice_bob() -> (MlsManager, MlsManager, &'static str) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-external";
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, bob, gid)
}

#[test]
fn external_join_stages_then_merges_and_both_sides_converge() {
    let (mut alice, _bob, gid) = group_with_alice_bob();

    // A member (carol) that never received a Welcome joins via an external commit built from the
    // GroupInfo alice exports.
    let group_info = alice.export_group_info(gid).expect("export group_info");
    let mut carol = make_device("carol", "dev1");

    let alice_epoch_before = alice.get_epoch(gid).expect("alice epoch");
    let (joined_gid, commit) = carol
        .join_by_external_commit(&group_info)
        .expect("carol external-joins");
    assert_eq!(
        joined_gid, gid,
        "derived group id must match the app group id"
    );

    // The returned group is already at the new epoch (base + 1): the external commit is applied to
    // the joiner's instance at once. The server validates against the GroupInfo's base epoch.
    assert_eq!(
        carol.get_epoch(gid).expect("carol epoch"),
        alice_epoch_before + 1,
        "external join instance is at base epoch + 1"
    );

    // Alice (existing member) processes the external commit -> her epoch advances to match.
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice processes external commit");
    assert_eq!(
        alice.get_epoch(gid).expect("alice epoch"),
        alice_epoch_before + 1,
        "processing the external commit advances the existing member's epoch"
    );

    // Server accepted -> carol finalizes the pending commit.
    carol.merge_pending_commit_for(gid).expect("carol merges");
    assert_eq!(
        carol.get_epoch(gid).expect("carol epoch"),
        alice.get_epoch(gid).expect("alice epoch"),
        "both sides are at the same epoch"
    );

    // Convergence check: alice sends, carol decrypts.
    let ciphertext = alice
        .send_message(gid, b"hello carol")
        .expect("alice sends");
    let plaintext = carol
        .process_incoming_message(gid, &ciphertext)
        .expect("carol decrypts")
        .expect("some plaintext");
    assert_eq!(plaintext, b"hello carol");
}

#[test]
fn external_join_refuses_to_clobber_a_live_local_group() {
    let (alice, mut bob, gid) = group_with_alice_bob();

    // Bob already holds the group locally: an external join must refuse rather than overwrite it
    // (a rung-2 caller forgets the group first; this guards accidental clobber).
    let group_info = alice.export_group_info(gid).expect("export group_info");
    let err = bob.join_by_external_commit(&group_info);
    assert!(
        err.is_err(),
        "external join must refuse a group already held locally"
    );
}
