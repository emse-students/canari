/// A frame REFUSED AT EXACTLY THE EPOCH IT NAMES is the residue of the decrypt path, and it used to
/// be the only thing there with no name at all.
///
/// Every other kind is classified at its throw - a spent generation, one too far ahead, an epoch
/// whose secrets are gone, our own frame, an evicted group. Everything else was returned as a bare
/// `Process error:` and read downstream as `unknown`, which every consumer treats as "may still
/// become readable". For a key-distribution frame that means REFUSING TO ACKNOWLEDGE IT, so the
/// server hands the same bytes back on every connection, for ever: measured on prod 2026-08-26,
/// where one refusal at epoch 0 on two distribution groups dirtied eleven cells of the COMM rung by
/// itself.
///
/// What makes the residue nameable is a fact `mls-core` holds and nobody downstream can recover:
/// the frame's epoch was compared with the group's BEFORE `process_message` was called, and neither
/// arm that could have returned did. So the epochs matched, and the state they were compared
/// against is the one an epoch fixes for good.
///
/// The producer here is the production shape rather than a corrupted byte: TWO MEMBERS COMMITTING
/// AT THE SAME EPOCH. Each merges its own, both land on epoch 2, and their trees differ - so the
/// next commit either of them sends is refused by the other at an epoch both of them agree on.
use mls_core::{DecryptErrorKind, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

/// Creates a two-member group (alice creates, bob joins via Welcome), both at epoch 1.
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

/// Commits an Add on `who` and merges it, without delivering anything to anybody.
/// The newcomer never joins - only the epoch change and the new tree matter here.
fn commit_alone(who: &mut MlsManager, gid: &str, newcomer: &str) -> Vec<u8> {
    let joiner = make_device(newcomer, "dev1");
    let kp = joiner.generate_key_package().expect("kp newcomer");
    let (commit, _welcome, _added, _skipped) =
        who.add_members_bulk(gid, &[&kp]).expect("add newcomer");
    who.merge_pending_commit_for(gid).expect("merge add");
    commit
}

/// Drives alice and bob into DIFFERENT trees at the SAME epoch, and returns a frame alice sends
/// from hers. This is the state a concurrent commit leaves when neither side sees the other's.
fn frame_from_a_divergent_tree(gid: &str) -> (MlsManager, Vec<u8>) {
    let (mut alice, mut bob) = pair_in_group(gid);
    commit_alone(&mut alice, gid, "charlie");
    commit_alone(&mut bob, gid, "dave");
    let frame = commit_alone(&mut alice, gid, "erin");
    (bob, frame)
}

#[test]
fn a_frame_refused_at_its_own_epoch_carries_the_fact() {
    let (mut bob, frame) = frame_from_a_divergent_tree("g-same-epoch-refusal");

    let err = bob
        .process_incoming_message("g-same-epoch-refusal", &frame)
        .expect_err("a frame from a tree we do not share must not read as a payload");

    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::SameEpochRefusal,
        "the caller cannot ACK what it cannot classify, and an unACKed frame is redelivered for \
         ever: got {err:?}"
    );
    // The marker both shared classifiers match on. Asserted literally because it IS the contract
    // across both FFI boundaries - the TS side and `src-tauri` see only this string.
    let s = err.to_string();
    assert!(
        s.contains("same-epoch refusal"),
        "the error must carry its own marker: {s}"
    );
    // And the evidence for it, which is the whole reason the fact is knowable here: the epoch pair
    // was read from the cleartext header before anything was attempted, and the two matched.
    assert!(
        s.contains("msg_epoch=2, group_epoch=2"),
        "the marker asserts the epochs matched, so it must show them: {s}"
    );
    // NOT a gap, at either end of the ratchet. Those three are classified above this one and would
    // send the frame to a commit replay, a re-Welcome or a retry queue - none of which can read it.
    assert!(
        !s.contains("epoch gap") && !s.contains("TooDistant") && !s.contains("SecretReuse"),
        "a permanent refusal must not carry a recoverable kind's marker: {s}"
    );
}

#[test]
fn a_redelivery_of_the_same_bytes_is_refused_identically() {
    let (mut bob, frame) = frame_from_a_divergent_tree("g-same-epoch-refusal-redelivered");

    let first = bob
        .process_incoming_message("g-same-epoch-refusal-redelivered", &frame)
        .expect_err("refused once");
    let again = bob
        .process_incoming_message("g-same-epoch-refusal-redelivered", &frame)
        .expect_err("and refused again");

    // THE LOOP THE ACK CLOSES, MEASURED RATHER THAN ARGUED. A redelivery is exactly this: the
    // server hands the same bytes back while nothing here has changed, and the refusal is
    // byte-identical - kind, marker and epoch pair. There is no state in which the caller learns
    // something new by asking again, which is what entitles it to acknowledge the first refusal
    // instead of holding the frame queued for the life of the account.
    assert_eq!(
        first.to_string(),
        again.to_string(),
        "a second attempt that answers something else would mean the refusal was not about the \
         epoch after all"
    );
    assert_eq!(again.decrypt_kind(), DecryptErrorKind::SameEpochRefusal);
}

#[test]
fn a_future_epoch_frame_is_still_a_gap() {
    let gid = "g-same-epoch-refusal-not-a-gap";
    let (mut alice, mut bob) = pair_in_group(gid);

    // Alice commits and moves on; bob does not apply it, then receives a frame from there. He is
    // BEHIND, which the fast-fail answers before `process_message` is ever called - and that path
    // must stay untouched, because replaying the commit genuinely repairs it.
    commit_alone(&mut alice, gid, "charlie");
    let ahead = alice
        .send_message(gid, b"from the next epoch")
        .expect("encrypt");

    let err = bob
        .process_incoming_message(gid, &ahead)
        .expect_err("a frame from an epoch we have not reached is a gap");
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::SenderRatchetGap,
        "the gap fast-fail must not be swallowed by the residue arm: got {err:?}"
    );
    assert!(
        !err.to_string().contains("same-epoch refusal"),
        "the epochs did NOT match here, and claiming they did would ACK a recoverable frame off \
         the server: {err}"
    );
}
