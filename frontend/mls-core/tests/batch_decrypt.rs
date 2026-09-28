//! Batch decrypt tests (Phase 3 S5).

use mls_core::MlsManager;

fn make_manager(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("make_manager({user_id}:{device_id}): {e}"))
}

#[test]
fn process_incoming_messages_matches_sequential_decrypt() {
    let mut alice = make_manager("batch-alice", "dev-a");
    let mut bob = make_manager("batch-bob", "dev-b");
    let group_id = "batch-dm";

    alice
        .create_group(group_id.to_string())
        .expect("alice create_group");
    let kp = bob.generate_key_package().expect("bob key_package");
    let (_commit, welcome, _added, _skipped) = alice
        .add_members_bulk(group_id, &[&kp])
        .expect("add_members_bulk");
    // Stage-only add (C7-A): merge as if the server accepted, then export the post-merge tree.
    alice
        .merge_pending_commit_for(group_id)
        .expect("merge add commit");
    let ratchet_tree = alice
        .export_ratchet_tree_for(group_id)
        .expect("export ratchet tree");
    bob.process_welcome(welcome.as_deref().expect("welcome"), Some(&ratchet_tree))
        .expect("bob process_welcome");

    let mut ciphertexts = Vec::new();
    for i in 0..5 {
        let payload = format!("batch-msg-{i}");
        ciphertexts.push(
            bob.send_message(group_id, payload.as_bytes())
                .expect("send_message"),
        );
    }

    let message_refs: Vec<&[u8]> = ciphertexts.iter().map(|c| c.as_slice()).collect();
    let batch = alice.process_incoming_messages(group_id, &message_refs);

    assert_eq!(batch.len(), 5);
    for (i, outcome) in batch.iter().enumerate() {
        let app = outcome
            .as_ref()
            .expect("batch outcome ok")
            .as_ref()
            .expect("app msg");
        assert_eq!(app.plaintext, format!("batch-msg-{i}").as_bytes());
        // The batch carries the sender MLS verified, like the single decrypt: the history
        // catch-up is a path a sender check must not be blind on.
        assert_eq!(app.sender_identity.as_deref(), Some("batch-bob:dev-b"));
    }
}

/// Channel-encryption section 21, WP-G2-1: the sender a client may believe is the one OpenMLS
/// verified the frame against, and it was dropped on the line that returned the plaintext. It is
/// the credential identity exactly as `state.rs` minted it - `userId:deviceId` - and it names the
/// SENDER's device, never the reader's.
#[test]
fn an_application_message_carries_its_verified_sender() {
    let mut alice = make_manager("sender-alice", "dev-a");
    let mut bob = make_manager("sender-bob", "dev-b");
    let group_id = "sender-dm";

    alice.create_group(group_id.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(group_id, &[&kp]).expect("add");
    alice.merge_pending_commit_for(group_id).expect("merge add");
    let rt = alice.export_ratchet_tree_for(group_id).expect("tree");
    bob.process_welcome(welcome.as_deref().expect("w"), Some(&rt))
        .expect("welcome");

    let from_bob = bob.send_message(group_id, b"hello").expect("bob send");
    let app = alice
        .process_incoming_message_with_sender(group_id, &from_bob)
        .expect("decrypt")
        .expect("app msg");
    assert_eq!(app.plaintext, b"hello");
    assert_eq!(app.sender_identity.as_deref(), Some("sender-bob:dev-b"));

    let from_alice = alice.send_message(group_id, b"hi").expect("alice send");
    let app = bob
        .process_incoming_message_with_sender(group_id, &from_alice)
        .expect("decrypt")
        .expect("app msg");
    assert_eq!(app.sender_identity.as_deref(), Some("sender-alice:dev-a"));

    // The projection the cross-version gate reads still answers the plaintext alone.
    let again = bob.send_message(group_id, b"again").expect("bob send");
    assert_eq!(
        alice
            .process_incoming_message(group_id, &again)
            .expect("decrypt"),
        Some(b"again".to_vec())
    );
}

#[test]
fn process_incoming_messages_captures_per_message_errors() {
    let mut alice = make_manager("batch-err-alice", "dev-a");
    let mut bob = make_manager("batch-err-bob", "dev-b");
    let group_id = "batch-err-dm";

    alice.create_group(group_id.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(group_id, &[&kp]).expect("add");
    alice.merge_pending_commit_for(group_id).expect("merge add");
    let rt = alice
        .export_ratchet_tree_for(group_id)
        .expect("export ratchet tree");
    bob.process_welcome(welcome.as_deref().expect("w"), Some(&rt))
        .expect("welcome");

    let good = bob.send_message(group_id, b"ok").expect("send");
    let garbage = vec![0u8; 8];
    let refs = [good.as_slice(), garbage.as_slice()];
    let batch = alice.process_incoming_messages(group_id, &refs);

    assert!(batch[0].is_ok());
    assert!(batch[1].is_err());
}
