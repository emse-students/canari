/// A device's OWN frame, handed back to it by a replay of its own mailbox.
///
/// The server stores every frame a group produced, this device's included, so every history replay
/// re-offers what we sent. OpenMLS refuses those by design - a member cannot decrypt itself - and
/// that refusal is the protocol working, not a failure: the sender's optimistic render already
/// wrote the message (WP-ECHO-1) and there is no plaintext left to recover.
///
/// It was nonetheless classified as a SENDER RATCHET GAP, because `decrypt_kind` had no arm for it
/// and the wrapper says `Process error:` like every other same-epoch failure. Native therefore
/// queued the frame in `pending_mls_messages` and retried it three times before the sweeper removed
/// it - the exact dead-weight shape WP-PENDING-2 was about, one classification short of being
/// caught. This file pins the kind, the marker that carries it across both FFI boundaries, and the
/// fact that our refusal says nothing about the frame itself.
use mls_core::{DecryptErrorKind, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

/// Creates a two-member group (alice creates, bob joins via Welcome), both at epoch 1.
fn pair_in_group(gid: &str) -> (MlsManager, MlsManager, String) {
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
    (alice, bob, gid.to_string())
}

#[test]
fn a_devices_own_frame_is_classified_as_such_and_never_as_a_ratchet_gap() {
    let (mut alice, _bob, gid) = pair_in_group("g-own-message");

    let ciphertext = alice.send_message(&gid, b"mine").expect("encrypt");

    let err = alice
        .process_incoming_message(&gid, &ciphertext)
        .expect_err("MLS forbids decrypting our own application frame");

    // The whole point: NOT `SenderRatchetGap`. That kind means "a later attempt can read this",
    // which is what earns a row in the native retry queue - and no later attempt will ever read a
    // frame we encrypted ourselves.
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::OwnMessage,
        "a frame we sent is not a gap to be retried: got {err:?}"
    );

    // The marker the two shared classifiers match on, asserted literally because it IS the contract
    // across the FFI boundary - the TS side sees only this string.
    assert!(
        err.to_string().contains("CannotDecryptOwnMessage"),
        "the error must carry its own marker: {err}"
    );
    // And only its own, so the ORDER of the classifiers' arms stays a fact rather than a decision.
    let s = err.to_string();
    assert!(
        !s.contains("SecretReuse") && !s.contains("WrongEpoch") && !s.contains("TooDistant"),
        "the underlying OpenMLS error must not leak other markers into the wrapper: {s}"
    );
}

#[test]
fn the_same_frame_still_decrypts_for_the_member_it_was_meant_for() {
    let (mut alice, mut bob, gid) = pair_in_group("g-own-message-peer");

    let ciphertext = alice.send_message(&gid, b"mine").expect("encrypt");

    // Our refusal above is about WHO IS READING, not about the frame. Without this the first test
    // would still pass if the ciphertext were malformed, and the classification would be right for
    // the wrong reason.
    let out = bob
        .process_incoming_message(&gid, &ciphertext)
        .expect("the recipient must read the very frame its sender cannot");
    assert_eq!(out.as_deref(), Some(b"mine".as_ref()));
}
