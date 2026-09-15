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

/// OUR OWN COMMIT, FANNED BACK BEFORE THE SERVER HAS ANSWERED - and the frame must not decide.
///
/// openmls 0.9.0 added two `ProcessedMessageContent` variants for our own frames, and the upgrade
/// made a claim worth pinning: which of them a fanned-back COMMIT reaches, and what it does to the
/// pending commit on the way through.
///
/// The answer is the wire format. Nothing here sets a policy, so every group takes openmls's
/// default `PURE_CIPHERTEXT` - a commit leaves as a `PrivateMessage` and comes back as one, so
/// `OwnPrivateMessage` claims it on its sender data and `OwnPendingCommit` is never reached at all.
/// The observable outcome is therefore exactly what 0.8.1 produced: the `CannotDecryptOwnMessage`
/// marker, ACKed by every consumer, with nothing merged.
///
/// THE SECOND HALF IS THE ONE THAT WOULD HAVE COST SOMETHING. [[C7]] Option A advances the epoch on
/// the SERVER'S answer and unwinds on its refusal; openmls's own documentation for the new variant
/// says to merge on the frame. These tests state that the echo consumes nothing, so both server
/// answers still apply afterwards - which is what stops a later session from taking that advice.
fn group_with_a_pending_add(gid: &str) -> (MlsManager, String, Vec<u8>) {
    let (mut alice, _bob, gid) = pair_in_group(gid);
    let carol = make_device("carol", "dev1");
    let kp = carol.generate_key_package().expect("kp carol");
    let (commit, _welcome, _added, _skipped) = alice
        .add_members_bulk(&gid, &[&kp])
        .expect("commit adding carol");
    assert_eq!(
        alice.get_epoch(&gid).expect("epoch"),
        1,
        "the commit is staged, not merged"
    );
    (alice, gid, commit)
}

#[test]
fn an_echoed_commit_is_claimed_by_its_wire_format_and_not_by_being_a_commit() {
    let (mut alice, gid, commit) = group_with_a_pending_add("g-own-pending-shape");

    // THE VERY BYTES WE PUBLISHED, handed back by the delivery service. Under PURE_CIPHERTEXT this
    // is an own PrivateMessage first and a commit second, so it classifies exactly as our own
    // application frames do - one classification, one marker, whatever we sent.
    let err = alice
        .process_incoming_message(&gid, &commit)
        .expect_err("our own frame, commit or not");
    assert!(
        err.to_string().contains("CannotDecryptOwnMessage"),
        "a fanned-back commit must carry the same marker as any other frame of ours: {err}"
    );
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::OwnMessage,
        "and the same kind, so no consumer queues it for a retry that can never read it"
    );
}

#[test]
fn an_echoed_pending_commit_leaves_the_epoch_alone_and_the_server_still_decides_to_merge() {
    let (mut alice, gid, commit) = group_with_a_pending_add("g-own-pending-merge");
    let _ = alice.process_incoming_message(&gid, &commit);

    // The staged commit is untouched by the echo: the server's ACCEPT still advances the epoch.
    assert_eq!(
        alice.get_epoch(&gid).expect("epoch"),
        1,
        "the fanout must not have merged anything - that is the server's answer to give"
    );
    alice
        .merge_pending_commit_for(&gid)
        .expect("the server accepted");
    assert_eq!(
        alice.get_epoch(&gid).expect("epoch"),
        2,
        "the pending commit must still have been there for the server's answer to apply"
    );
}

#[test]
fn an_echoed_pending_commit_leaves_the_server_free_to_refuse_it() {
    let (mut alice, gid, commit) = group_with_a_pending_add("g-own-pending-clear");
    let _ = alice.process_incoming_message(&gid, &commit);

    // THE HALF THAT WOULD HAVE FORKED. If anything merged on the strength of the fanout, the
    // rejection below would arrive at a group that had already moved - and Option A's whole
    // promise is that a refused commit leaves the local state exactly where it was.
    alice
        .clear_pending_commit_for(&gid)
        .expect("the server refused");
    assert_eq!(
        alice.get_epoch(&gid).expect("epoch"),
        1,
        "a refused commit must not have advanced anything"
    );
}
