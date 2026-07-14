//! Validates the load-bearing mechanism behind the background push commit catch-up
//! (`mobile::background::decrypt_push_message_with_commits` in src-tauri): a member that is behind
//! by one add-commit can apply that commit in order and then decrypt a message emitted at the newer
//! epoch. This is the crypto path the read-only in-memory catch-up relies on to turn an
//! otherwise-undecryptable push (epoch gap) into a real notification, without ever persisting.

use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("cannot create device '{user_id}:{device_id}': {e}"))
}

/// alice creates the group and adds bob via Welcome; both land at epoch 1.
fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_, welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("add bob to group");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, bob)
}

#[test]
fn member_behind_an_add_commit_catches_up_then_decrypts() {
    let gid = "g-catchup";
    let (mut alice, mut bob) = pair_in_group(gid);
    let mut carol = make_device("carol", "dev1");

    // alice adds carol: this commit advances alice+carol to epoch 2. bob does NOT apply it yet
    // (simulating a never-opened mobile that only saw the plain read-only push decrypt).
    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (add_commit, welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_carol])
        .expect("add carol");
    alice
        .merge_pending_commit_for(gid)
        .expect("merge add carol");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree epoch 2");
    carol
        .process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("carol joins at epoch 2");

    // carol sends the first message at the NEW epoch.
    let ciphertext = carol.send_message(gid, b"hi from carol").expect("encrypt");

    // Without catch-up, bob (still at epoch 1) cannot decrypt the epoch-2 message: it is a gap.
    assert!(
        bob.process_incoming_message(gid, &ciphertext).is_err(),
        "message from a newer epoch must fail before catch-up"
    );

    // Catch-up: bob applies the add-commit in order, reaching epoch 2 (Ok(None) - a control message).
    assert_eq!(
        bob.process_incoming_message(gid, &add_commit)
            .expect("apply add-commit"),
        None,
        "applying a commit yields no plaintext"
    );

    // Now the epoch-2 message decrypts.
    let plaintext = bob
        .process_incoming_message(gid, &ciphertext)
        .expect("decrypt after catch-up");
    assert_eq!(plaintext.as_deref(), Some(b"hi from carol".as_ref()));
}

#[test]
fn re_applying_an_already_merged_commit_is_a_benign_skip() {
    // The catch-up loop tolerates an over-broad commit range: a commit the group already merged is a
    // stale (past-epoch) frame and must be a benign Ok(None), never an error that aborts the loop.
    let gid = "g-catchup-stale";
    let (mut alice, mut bob) = pair_in_group(gid);
    let carol = make_device("carol", "dev1");

    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (add_commit, _welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_carol])
        .expect("add carol");
    alice
        .merge_pending_commit_for(gid)
        .expect("merge add carol");

    // bob applies it once (epoch 1 -> 2).
    bob.process_incoming_message(gid, &add_commit)
        .expect("first apply");

    // Re-applying the same commit (now a past-epoch frame) is a benign drop, not an error.
    assert_eq!(
        bob.process_incoming_message(gid, &add_commit)
            .expect("stale commit must not error"),
        None,
    );
}
