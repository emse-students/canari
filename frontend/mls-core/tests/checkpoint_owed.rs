//! `owes_checkpoint`: the proof a skipped checkpoint rests on.
//!
//! A checkpoint is skipped ONLY when the newest write this manager declared durable holds its
//! current state, so the write it would have made seals and writes the same state again. These tests
//! pin the three ways that claim could be wrong: a mutation it does not see, a mark credited before
//! its write (or to the wrong manager), and an export that never reached the disk.
use mls_core::{CheckpointMark, MlsManager};

fn make_device(user_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, "dev1", None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}': {e}"))
}

fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device(&format!("{gid}-alice"));
    let mut bob = make_device(&format!("{gid}-bob"));
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

/// What a checkpoint does, in the order it must: mark with the export, credit after the write.
fn checkpoint(manager: &MlsManager) {
    let mark = manager.checkpoint_mark();
    let _bytes = manager.save_state().expect("export");
    assert!(manager.note_durable_write(mark), "own mark, reached state");
}

#[test]
fn a_new_and_a_loaded_manager_owe_their_first_write() {
    let fresh = make_device("co-fresh");
    assert!(fresh.owes_checkpoint(), "nothing of it is on disk yet");

    // A loaded manager holds what the file holds, but it has never written it ITSELF: the first
    // checkpoint of a session is what migrates a legacy encoding (`load_or_create`), so it is owed.
    let bytes = fresh.save_state().expect("save");
    let loaded = MlsManager::load_or_create("co-fresh", "dev1", Some(bytes)).expect("reload");
    assert!(loaded.owes_checkpoint());
    checkpoint(&loaded);
    assert!(!loaded.owes_checkpoint());
}

#[test]
fn a_landed_write_of_the_current_state_owes_nothing_until_the_next_mutation() {
    let (mut alice, mut bob) = pair_in_group("co-recv");
    checkpoint(&bob);
    assert!(
        !bob.owes_checkpoint(),
        "a second write would seal the same state again"
    );

    // A DECRYPTED FRAME MOVES THE RECEIVE RATCHET, whatever it carried - a read watermark is an
    // application frame like a message. It is owed, and nothing here can tell the two apart.
    let frame = alice
        .send_message("co-recv", b"read_watermark")
        .expect("send");
    bob.process_incoming_message("co-recv", &frame)
        .expect("decrypt");
    assert!(bob.owes_checkpoint(), "a receive is a mutation");
    checkpoint(&bob);
    assert!(!bob.owes_checkpoint());

    // The sender's own ratchet moved too.
    assert!(alice.owes_checkpoint());
}

#[test]
fn an_export_that_never_reached_the_disk_proves_nothing() {
    let (_alice, bob) = pair_in_group("co-export-only");
    checkpoint(&bob);
    bob.invalidate_persisted_snapshot();
    // A backup, a worker snapshot, a failed write: the bytes were built and never declared durable.
    let _ = bob.save_state().expect("export for some other purpose");
    assert!(
        bob.owes_checkpoint(),
        "serialising is not persisting - only `note_durable_write` may clear it"
    );
}

#[test]
fn a_mutation_between_the_export_and_the_write_stays_owed() {
    // The native checkpoint releases the manager after its export, so a frame can be decrypted
    // while the seal and the write run. The write lands the state BEFORE that frame.
    let (mut alice, mut bob) = pair_in_group("co-mid-write");
    let mark = bob.checkpoint_mark();
    let _bytes = bob.save_state().expect("export");
    let frame = alice
        .send_message("co-mid-write", b"during the seal")
        .expect("send");
    bob.process_incoming_message("co-mid-write", &frame)
        .expect("decrypt");
    assert!(bob.note_durable_write(mark));
    assert!(
        bob.owes_checkpoint(),
        "the file holds the state before the frame, so the frame is still owed"
    );
}

#[test]
fn a_mark_is_credited_only_to_the_manager_that_issued_it_and_never_backwards() {
    let (_alice, bob) = pair_in_group("co-foreign");
    let other = make_device("co-foreign-other");
    let foreign = other.checkpoint_mark();
    let (instance, _) = foreign.parts();
    assert!(
        !bob.note_durable_write(CheckpointMark::from_parts(instance, 0)),
        "a manager that replaced this one while its write ran must not inherit the credit"
    );
    let (own, now) = bob.checkpoint_mark().parts();
    assert!(
        !bob.note_durable_write(CheckpointMark::from_parts(own, now + 1)),
        "a mark naming a state this manager never reached is refused"
    );
    assert!(bob.owes_checkpoint());

    let older = bob.checkpoint_mark();
    bob.invalidate_persisted_snapshot();
    checkpoint(&bob);
    assert!(!bob.owes_checkpoint());
    // A slower write of the older export lands last: it must not un-declare the newer one.
    assert!(bob.note_durable_write(older));
    assert!(!bob.owes_checkpoint());
}
