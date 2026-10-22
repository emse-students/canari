//! A FORK IS TWO TREES AT ONE EPOCH NUMBER, AND THE FRAME THAT CROSSES BETWEEN THEM IS THE ONLY
//! WITNESS ANYBODY EVER GETS.
//!
//! The obvious check - "put my epoch authenticator in every message and compare" - proves nothing
//! from INSIDE the ciphertext: a member that can decrypt a frame shares the epoch secret it was
//! sealed under, and the authenticator is derived from that secret, so the two always agree. The
//! only frame that can disagree is one this device CANNOT open: the same-epoch refusal. So the
//! fingerprint travels in the MLS frame's cleartext authenticated data, signed by the sender's
//! credential key, and the receiver reads it exactly where the decrypt fails.
//!
//! The producer is the production shape (`same_epoch_refusal.rs`): two members committing at the
//! same epoch, each merging its own.

use mls_core::MlsManager;
use mls_core::fork_check::ForkFindingKind;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

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

fn commit_alone(who: &mut MlsManager, gid: &str, newcomer: &str) {
    let joiner = make_device(newcomer, "dev1");
    let kp = joiner.generate_key_package().expect("kp newcomer");
    who.add_members_bulk(gid, &[&kp]).expect("add newcomer");
    who.merge_pending_commit_for(gid).expect("merge add");
}

#[test]
fn a_message_from_the_other_side_of_a_fork_is_reported_as_one() {
    let gid = "g-fork";
    let (mut alice, mut bob) = pair_in_group(gid);
    // Both commit at epoch 1 and merge their own: two trees, both at epoch 2.
    commit_alone(&mut alice, gid, "charlie");
    commit_alone(&mut bob, gid, "dave");
    assert_eq!(alice.get_epoch(gid).unwrap(), bob.get_epoch(gid).unwrap());

    let frame = alice
        .send_message(gid, b"hello from my tree")
        .expect("send");
    let refused = bob.process_incoming_message(gid, &frame);
    assert!(refused.is_err(), "a fork's frame cannot be read across it");

    let findings = bob.take_fork_findings();
    assert_eq!(findings.len(), 1, "one frame, one finding: {findings:?}");
    let f = &findings[0];
    assert_eq!(f.kind, ForkFindingKind::Fork);
    assert_eq!(f.group_id, gid);
    assert_eq!(f.epoch, 2);
    assert_eq!(f.peer, "alice:dev1");
    // Taken means taken: a second read is empty, so a caller never records one fork twice.
    assert!(bob.take_fork_findings().is_empty());
}

#[test]
fn members_on_one_tree_report_nothing() {
    let gid = "g-no-fork";
    let (mut alice, mut bob) = pair_in_group(gid);
    let frame = alice.send_message(gid, b"same tree").expect("send");
    let plaintext = bob
        .process_incoming_message(gid, &frame)
        .expect("decrypt")
        .expect("application");
    assert_eq!(
        plaintext, b"same tree",
        "the fingerprint never touches the plaintext"
    );
    assert!(bob.take_fork_findings().is_empty());
}

#[test]
fn a_corrupt_frame_at_the_same_epoch_on_the_same_tree_is_not_called_a_fork() {
    // The refusal that is NOT a fork: same tree, a ciphertext byte flipped in transit. The claim in
    // the cleartext still agrees with ours, and that agreement is the discriminator the refusal
    // never had - "my copy of this epoch differs from the sender's" against "these bytes are bad".
    let gid = "g-corrupt-not-fork";
    let (mut alice, mut bob) = pair_in_group(gid);
    let mut frame = alice.send_message(gid, b"to be damaged").expect("send");
    let last = frame.len() - 1;
    frame[last] ^= 0x55;
    assert!(bob.process_incoming_message(gid, &frame).is_err());
    let findings = bob.take_fork_findings();
    assert!(
        findings.iter().all(|f| f.kind != ForkFindingKind::Fork),
        "a damaged frame from our own tree is not a fork: {findings:?}"
    );
}
