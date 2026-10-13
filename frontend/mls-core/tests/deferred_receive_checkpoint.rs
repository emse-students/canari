//! What a crash costs when the file is BEHIND by received application frames only.
//!
//! The question `docs/wiki/open-questions.md` parks: today every drain ends with a full encrypted
//! checkpoint, even a drain of ONE application frame (about 100x that frame's decrypt on the Mi 9T at
//! 7.7 MB, `heavy_state_checkpoint.rs`). Deferring it means a process death can leave `mls.bin`
//! behind the live manager by the frames it received since the last checkpoint. This file pins what
//! the MLS layer then does, so the decision is taken on facts rather than fears:
//!
//! - the frames read before the crash DECRYPT AGAIN from the restored state - a re-read, never a
//!   loss (a server re-delivery or an archive replay recovers a row the crash also lost);
//! - frames after the crash still decrypt, and so does this device's next send for its peers;
//! - the bound is the sender ratchet window: within `maximum_forward_distance` (2000, `group.rs`)
//!   nothing is lost.
//!
//! What it does NOT cover, and the open question carries: the app-side ledgers that must agree with
//! the state (the seen-cipher fingerprints of TAB-3b), and a commit, which is checkpointed at once
//! (`persistNow`) whatever the drain policy.
use mls_core::MlsManager;

fn make_device(user_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, "dev1", None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}': {e}"))
}

fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("drc-alice");
    let mut bob = make_device("drc-bob");
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

/// Bob reads `lag` frames after his last checkpoint, then "dies": the restored manager is the file.
fn crash_after_reading(gid: &str, lag: usize) -> (MlsManager, MlsManager, Vec<Vec<u8>>) {
    let (mut alice, mut bob) = pair_in_group(gid);
    let on_disk = bob.save_state().expect("the last checkpoint");
    let mut frames = Vec::with_capacity(lag);
    for i in 0..lag {
        let frame = alice
            .send_message(gid, format!("m{i}").as_bytes())
            .expect("send");
        let read = bob
            .process_incoming_message(gid, &frame)
            .expect("live read");
        assert_eq!(read.as_deref(), Some(format!("m{i}").as_bytes()));
        frames.push(frame);
    }
    assert!(bob.has_unsaved_ratchet_advance());
    let restored = MlsManager::load_or_create("drc-bob", "dev1", Some(on_disk)).expect("restore");
    (alice, restored, frames)
}

#[test]
fn frames_read_before_the_crash_are_read_again_never_lost() {
    let gid = "g-drc-reread";
    let (_alice, mut bob, frames) = crash_after_reading(gid, 50);
    for (i, frame) in frames.iter().enumerate() {
        let again = bob
            .process_incoming_message(gid, frame)
            .unwrap_or_else(|e| {
                panic!("frame {i} must decrypt again from the restored state: {e}")
            });
        assert_eq!(again.as_deref(), Some(format!("m{i}").as_bytes()));
    }
}

#[test]
fn the_conversation_goes_on_after_the_crash_in_both_directions() {
    let gid = "g-drc-goes-on";
    let (mut alice, mut bob, _frames) = crash_after_reading(gid, 50);

    // The next frame is 50 generations ahead of the restored ratchet: a forward jump, inside the window.
    let next = alice.send_message(gid, b"after").expect("send");
    assert_eq!(
        bob.process_incoming_message(gid, &next)
            .expect("the next frame decrypts")
            .as_deref(),
        Some(b"after".as_ref())
    );
    // Bob's SEND ratchet is untouched by what he received, so his peers read him.
    let reply = bob.send_message(gid, b"reply").expect("bob sends");
    assert_eq!(
        alice
            .process_incoming_message(gid, &reply)
            .expect("alice reads bob")
            .as_deref(),
        Some(b"reply".as_ref())
    );
}

#[test]
fn the_bound_is_the_sender_ratchet_window_not_the_crash() {
    // 1990 unsaved receives, then the next frame: still inside `maximum_forward_distance` (2000).
    let gid = "g-drc-window";
    let (mut alice, mut bob, frames) = crash_after_reading(gid, 1990);
    let next = alice.send_message(gid, b"edge").expect("send");
    assert!(bob.process_incoming_message(gid, &next).is_ok());
    // And the oldest frame of the lost run still decrypts out of order.
    assert!(bob.process_incoming_message(gid, &frames[0]).is_ok());
}
