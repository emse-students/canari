//! THE REPAIR FOR A SNAPSHOT RESTORED BEHIND ITS OWN SENDS.
//!
//! A checkpoint is not awaited on the send path - it costs 1.7 s on a phone - so a reload inside
//! that window restores an `mls.bin` that predates frames this device has already put on the wire.
//! The peer has consumed those generations; the next frame re-issues one, the peer answers
//! `SecretReuseError`, and a message that was never lost is reported as one and repaired by a full
//! history reconciliation.
//!
//! `skip_send_generations` moves the restored ratchet back to where the peer already believes it is.
//! Both halves are asserted here against two real clients rather than against a reading of OpenMLS:
//! the fault WITHOUT the burn, so the test would still fail if the defect were fixed elsewhere and
//! this became dead weight, and the repair WITH it.
//!
//! The third case is the one the whole design leans on. Burning MORE than was spent must be free,
//! because the count that drives it is read before a checkpoint and committed after, which
//! deliberately over-counts a send that lands during the write. If over-shooting ever stops being
//! safe, the ledger's ordering rule becomes a defect and this test is what says so.
use mls_core::{DecryptErrorKind, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

/// Creates a two-member group (alice creates, bob joins via Welcome), both at epoch 1.
fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("burn-alice", "dev1");
    let mut bob = make_device("burn-bob", "dev1");
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

/// Restores alice on a given snapshot, as a reload of the app would.
fn reload(snapshot: Vec<u8>) -> MlsManager {
    MlsManager::load_or_create("burn-alice", "dev1", Some(snapshot)).expect("reload alice")
}

#[test]
fn a_snapshot_restored_behind_its_own_sends_re_issues_a_spent_generation() {
    let gid = "g-burn-fault";
    let (mut alice, mut bob) = pair_in_group(gid);

    // What a checkpoint taken BEFORE the two sends below would hold.
    let stale = alice.save_state().expect("snapshot");

    for i in 0..2u32 {
        let ciphertext = alice
            .send_message(gid, format!("sent{i}").as_bytes())
            .expect("encrypt");
        bob.process_incoming_message(gid, &ciphertext)
            .expect("bob consumes the generation");
    }

    // The reload lands on the state that predates them, and the next frame re-uses generation 0.
    let mut reloaded = reload(stale);
    let doomed = reloaded.send_message(gid, b"doomed").expect("encrypt");

    let err = bob
        .process_incoming_message(gid, &doomed)
        .expect_err("a rewound sender must be refused, or there is nothing here to repair");
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::SecretReuse,
        "the peer's diagnosis is what names this fault: {err}"
    );
}

#[test]
fn burning_the_spent_generations_makes_the_next_frame_decrypt() {
    let gid = "g-burn-repair";
    let (mut alice, mut bob) = pair_in_group(gid);

    let stale = alice.save_state().expect("snapshot");
    for i in 0..2u32 {
        let ciphertext = alice
            .send_message(gid, format!("sent{i}").as_bytes())
            .expect("encrypt");
        bob.process_incoming_message(gid, &ciphertext)
            .expect("bob consumes the generation");
    }

    let mut repaired = reload(stale);
    assert_eq!(
        repaired.skip_send_generations(gid, 2).expect("burn"),
        2,
        "the burn reports what it actually spent"
    );

    let ciphertext = repaired
        .send_message(gid, b"after the burn")
        .expect("encrypt");
    let out = bob
        .process_incoming_message(gid, &ciphertext)
        .expect("the repaired ratchet must produce a frame the peer can read");
    assert_eq!(out.as_deref(), Some(b"after the burn".as_ref()));
}

#[test]
fn burning_more_than_was_spent_is_free() {
    let gid = "g-burn-overshoot";
    let (mut alice, mut bob) = pair_in_group(gid);

    let stale = alice.save_state().expect("snapshot");
    for i in 0..2u32 {
        let ciphertext = alice
            .send_message(gid, format!("sent{i}").as_bytes())
            .expect("encrypt");
        bob.process_incoming_message(gid, &ciphertext)
            .expect("bob consumes the generation");
    }

    // Five burnt where two were spent: the peer ratchets forward over the three that never existed
    // and keeps their keys, which is what makes the ledger allowed to over-count.
    let mut repaired = reload(stale);
    repaired.skip_send_generations(gid, 5).expect("burn");

    let ciphertext = repaired.send_message(gid, b"overshot").expect("encrypt");
    let out = bob
        .process_incoming_message(gid, &ciphertext)
        .expect("a forward gap is ordinary out-of-order delivery, not an error");
    assert_eq!(out.as_deref(), Some(b"overshot".as_ref()));
}

/// The reload of a STAGE (the checkpoint awaited before a commit's first request), after the merge
/// and two frames in the epoch it created: the settle merges the same staged commit again, and that
/// epoch's ratchet starts at generation 0 a second time. The frames spent there are owed THERE -
/// burnt before the merge they move a ratchet nobody reads, and the peer refuses the next frame.
/// `BaseMlsService.sendRatchet.test.ts` models exactly this; these are its premises, on real clients.
#[test]
fn frames_sent_after_a_merge_are_owed_in_the_epoch_it_created_not_the_restored_one() {
    let gid = "g-burn-after-merge";
    let (mut alice, mut bob) = pair_in_group(gid);

    let (commit, _base) = alice.stage_self_update(gid).expect("stage");
    let stage = alice
        .save_state()
        .expect("the checkpoint before the first request");
    alice.merge_pending_commit_for(gid).expect("merge");
    bob.process_incoming_message(gid, &commit)
        .expect("bob applies the commit");
    for i in 0..2u32 {
        let ciphertext = alice
            .send_message(gid, format!("after{i}").as_bytes())
            .expect("encrypt");
        bob.process_incoming_message(gid, &ciphertext)
            .expect("bob consumes the generation");
    }

    // Burnt in the restored epoch, then merged: the merged epoch re-issues generation 0.
    let mut wrong = reload(stage.clone());
    wrong.skip_send_generations(gid, 2).expect("burn");
    wrong.merge_pending_commit_for(gid).expect("settle merges");
    let doomed = wrong.send_message(gid, b"doomed").expect("encrypt");
    let err = bob
        .process_incoming_message(gid, &doomed)
        .expect_err("a burn in the wrong epoch repairs nothing");
    assert_eq!(err.decrypt_kind(), DecryptErrorKind::SecretReuse, "{err}");

    // Merged, then burnt in the epoch the frames were sent in: the next frame decrypts.
    let mut right = reload(stage);
    right.merge_pending_commit_for(gid).expect("settle merges");
    right.skip_send_generations(gid, 2).expect("burn");
    let frame = right.send_message(gid, b"repaired").expect("encrypt");
    let out = bob
        .process_incoming_message(gid, &frame)
        .expect("the burn in the merged epoch is the repair");
    assert_eq!(out.as_deref(), Some(b"repaired".as_ref()));
}

/// `sealedFrameEpoch.ts` reads a sealed frame's epoch WITHOUT openmls: two `uint16`s (version,
/// wire format), `group_id<V>` with RFC 9420's variable-length prefix, then the `uint64` epoch.
/// Pinned here against openmls's own reading of a real application frame, at an epoch past 255 so
/// a wrong byte order could not pass by luck.
#[test]
fn a_sealed_frame_carries_its_epoch_where_the_web_reader_looks_for_it() {
    let gid = "g-frame-epoch-layout";
    let (mut alice, mut bob) = pair_in_group(gid);
    for _ in 0..300 {
        let (commit, _base) = alice.stage_self_update(gid).expect("stage");
        alice.merge_pending_commit_for(gid).expect("merge");
        bob.process_incoming_message(gid, &commit)
            .expect("bob follows");
    }
    let frame = alice
        .send_message(gid, b"where is my epoch")
        .expect("encrypt");

    assert_eq!(&frame[0..2], &[0, 1], "version mls10");
    assert_eq!(&frame[2..4], &[0, 2], "wire format: private message");
    let first = frame[4];
    let prefix = 1usize << (first >> 6);
    let mut length = (first & 0x3f) as usize;
    for i in 1..prefix {
        length = length * 256 + frame[4 + i] as usize;
    }
    assert_eq!(length, gid.len(), "the group id's length");
    let at = 4 + prefix + length;
    let epoch = u64::from_be_bytes(frame[at..at + 8].try_into().expect("8 bytes"));
    assert_eq!(Some(epoch), MlsManager::parse_message_epoch(&frame));
    assert_eq!(epoch, alice.get_epoch(gid).expect("epoch"));
    assert!(epoch > 255);
}

#[test]
fn burning_zero_does_nothing_and_an_unknown_group_is_refused() {
    let gid = "g-burn-edges";
    let (mut alice, _bob) = pair_in_group(gid);

    assert_eq!(alice.skip_send_generations(gid, 0).expect("no-op"), 0);
    assert!(
        alice.skip_send_generations("g-never-joined", 1).is_err(),
        "a group this device does not hold must be reported, so the caller can isolate it"
    );
}
