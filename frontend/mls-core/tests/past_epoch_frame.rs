/// A frame from a PAST epoch is two different events, and only its content type separates them.
///
/// The layer used to answer `Ok(None)` for every frame whose epoch was behind the group's, on the
/// reasoning that such a frame is "almost certainly our own echoed commit". For a handshake that is
/// right. For an APPLICATION frame it is a message somebody sent, and `Ok(None)` says "no
/// application payload" - the same thing a commit echo says - so the caller's entire recovery
/// ladder was unreachable from a value asserting nothing had failed. Measured on production
/// 2026-08-11 (HEAL-W2): a message was ACKed off the server and dropped with no `LOST frame`, no
/// durable marker and no history solicitation.
///
/// Three facts are pinned here, and the middle one is why the first is not simply "past epoch =
/// error": `max_past_epochs` is 2, so a frame merely overtaken by a commit still decrypts, and
/// reporting a loss there would cry wolf on ordinary traffic.
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

/// Advances the group by one epoch (alice adds a newcomer) and returns the commit bytes.
/// The newcomer never joins - only the epoch change matters here.
fn advance_one_epoch(alice: &mut MlsManager, gid: &str, newcomer: &str) -> Vec<u8> {
    let joiner = make_device(newcomer, "dev1");
    let kp = joiner.generate_key_package().expect("kp newcomer");
    let (commit, _welcome, _added, _skipped) =
        alice.add_members_bulk(gid, &[&kp]).expect("add newcomer");
    alice.merge_pending_commit_for(gid).expect("merge add");
    commit
}

#[test]
fn past_epoch_application_frame_is_reported_not_swallowed() {
    let (mut alice, mut bob, gid) = pair_in_group("g-past-epoch-app");

    // Encrypted at epoch 1 and never delivered - the shape of a frame that was in flight, or was
    // sitting in the server queue, while the receiver moved on.
    let stranded = alice
        .send_message(&gid, b"a message somebody sent")
        .expect("encrypt");

    // Three commits, so epoch 1 falls out of bob's two-epoch past window. This is what a re-joined
    // group has for EVERY frame predating its join: no past epoch secrets at all.
    for newcomer in ["charlie", "dave", "erin"] {
        let commit = advance_one_epoch(&mut alice, &gid, newcomer);
        bob.process_incoming_message(&gid, &commit)
            .expect("bob applies the commit");
    }

    let err = bob
        .process_incoming_message(&gid, &stranded)
        .expect_err("a message whose epoch secrets are gone must not read as 'nothing to show'");

    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::PastEpochApplication,
        "the caller cannot apply the right policy without the right kind: got {err:?}"
    );
    // The marker the two shared classifiers match on. Asserted literally because it IS the
    // contract across the FFI boundary - the TS side sees only this string.
    assert!(
        err.to_string().contains("past epoch application frame"),
        "the error must carry its own marker: {err}"
    );
    // And ONLY its own. A wrapper carrying a second marker (`WrongEpoch`, an Aead failure) would
    // make the ORDER of the classifier's arms a decision rather than a fact.
    let s = err.to_string();
    assert!(
        !s.contains("WrongEpoch") && !s.contains("SecretReuse") && !s.contains("TooDistant"),
        "the underlying OpenMLS error must not leak its markers into the wrapper: {s}"
    );
}

#[test]
fn a_frame_merely_overtaken_by_a_commit_still_decrypts() {
    let (mut alice, mut bob, gid) = pair_in_group("g-past-epoch-tolerated");

    let stranded = alice.send_message(&gid, b"overtaken").expect("encrypt");

    // One commit: the frame's epoch is behind, but inside `max_past_epochs`. This is ordinary
    // traffic - a message in flight when someone is invited - and it must NOT be reported as a
    // loss, or every invitation would manufacture phantom gaps.
    let commit = advance_one_epoch(&mut alice, &gid, "charlie");
    bob.process_incoming_message(&gid, &commit)
        .expect("bob applies the commit");

    let out = bob
        .process_incoming_message(&gid, &stranded)
        .expect("a frame within the past-epoch window must still decrypt");
    assert_eq!(out.as_deref(), Some(b"overtaken".as_ref()));
}

#[test]
fn a_stale_handshake_stays_silent() {
    let (mut alice, mut bob, gid) = pair_in_group("g-past-epoch-handshake");

    let commit = advance_one_epoch(&mut alice, &gid, "charlie");
    bob.process_incoming_message(&gid, &commit)
        .expect("bob applies the commit");

    // The same commit delivered twice (realtime publish plus the queue) is the benign case this
    // branch exists for: its keys were consumed by the merge, nothing is lost, and the caller must
    // ACK it without a word.
    let again = bob
        .process_incoming_message(&gid, &commit)
        .expect("a re-delivered commit is not an error");
    assert_eq!(
        again, None,
        "a stale handshake has no payload and no diagnosis"
    );
}
