//! A KEY-GROUP FRAME'S PLAINTEXT IS KEPT IN THE SAME MUTATION THAT SPENDS ITS GENERATION.
//!
//! `process_incoming_message_kept` is what the app's key-group route decrypts through
//! (mls-desync-prevention section 11): the seed handler runs after the decrypt, and a handler that
//! threw used to leave a frame MLS refuses on redelivery. These cases pin the three facts the app's
//! crash argument rests on, against two real clients:
//!
//! - the kept value is in the ledgers the moment the call returns, so any later export holds it;
//! - it survives a save and a reload together with the spent generation;
//! - the redelivered bytes are still refused (`SecretReuse`) - which is WHY the app must read the kept
//!   plaintext instead of decrypting again.
use base64::Engine;
use mls_core::{DecryptErrorKind, KEPT_FRAME_PREFIX, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

/// Creates a two-member group (alice creates, bob joins via Welcome), both at epoch 1.
fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("kept-alice", "dev1");
    let mut bob = make_device("kept-bob", "dev1");
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

fn key(gid: &str) -> String {
    format!("{KEPT_FRAME_PREFIX}{gid}:fp1")
}

#[test]
fn the_plaintext_is_kept_with_the_generation_it_spent_and_survives_a_reload() {
    let gid = "g-kept";
    let (mut alice, mut bob) = pair_in_group(gid);
    let ciphertext = alice.send_message(gid, b"a seed").expect("encrypt");

    let app = bob
        .process_incoming_message_kept(gid, &ciphertext, &key(gid))
        .expect("decrypt")
        .expect("an application message");
    assert_eq!(app.plaintext, b"a seed");

    let kept = bob
        .app_ledgers()
        .get(&key(gid))
        .expect("kept at once")
        .clone();
    let expected = format!(
        "{{\"sender\":\"{}\",\"plaintext\":\"{}\"}}",
        app.sender_identity.as_deref().expect("a verified sender"),
        base64::engine::general_purpose::STANDARD.encode(b"a seed")
    );
    assert_eq!(kept, expected, "the app's view builds this exact string");

    // A kill after this export: the reloaded state holds the spent generation AND the plaintext.
    let saved = bob.save_state().expect("save");
    let mut reloaded = MlsManager::load_or_create("kept-bob", "dev1", Some(saved)).expect("reload");
    assert_eq!(reloaded.app_ledgers().get(&key(gid)), Some(&expected));
    let err = reloaded
        .process_incoming_message_with_sender(gid, &ciphertext)
        .expect_err("the redelivered bytes meet a spent generation");
    assert_eq!(err.decrypt_kind(), DecryptErrorKind::SecretReuse);
}

#[test]
fn a_commit_keeps_nothing() {
    let gid = "g-kept-commit";
    let (mut alice, mut bob) = pair_in_group(gid);
    let carol = make_device("kept-carol", "dev1");
    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (commit, _welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_carol])
        .expect("add carol");
    alice.merge_pending_commit_for(gid).expect("merge");

    let out = bob
        .process_incoming_message_kept(gid, &commit, &key(gid))
        .expect("the commit applies");
    assert!(out.is_none());
    assert!(bob.app_ledgers().is_empty());
}

#[test]
fn a_key_outside_the_namespace_is_refused_before_anything_is_decrypted() {
    let gid = "g-kept-refused";
    let (mut alice, mut bob) = pair_in_group(gid);
    let ciphertext = alice.send_message(gid, b"a seed").expect("encrypt");

    assert!(
        bob.process_incoming_message_kept(gid, &ciphertext, "seen:g")
            .is_err()
    );
    assert!(
        bob.process_incoming_message_kept(gid, &ciphertext, KEPT_FRAME_PREFIX)
            .is_err()
    );
    // Nothing was spent: the frame still decrypts.
    assert!(
        bob.process_incoming_message_with_sender(gid, &ciphertext)
            .expect("decrypt")
            .is_some()
    );
}
