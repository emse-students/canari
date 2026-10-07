//! `has_unsaved_ratchet_advance`: the question a resume reload must ask and the epoch cannot answer.
//!
//! A snapshot older than the live manager by a few messages holds every group at the SAME epoch, so
//! `reload_is_monotonic` accepts it and the secret tree goes back - measured on the Mi 9T on
//! 2026-09-08 (generations 45 and 46 derived again 112 ms after a resume reload). The old guard
//! counted SENDS in the WebView; a decrypted application frame moved nothing it could see.
use mls_core::MlsManager;

fn make_device(user_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, "dev1", None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}': {e}"))
}

fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("ua-alice");
    let mut bob = make_device("ua-bob");
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

#[test]
fn a_freshly_loaded_manager_is_not_ahead_of_the_file_it_was_loaded_from() {
    // Its snapshot cache is empty (so it is "dirty" for serialisation) but it holds exactly what is
    // on disk. Reading that as "ahead" would refuse every reload after the first and lose the
    // background advance the reload exists to rescue.
    let manager = make_device("ua-fresh");
    assert!(!manager.has_unsaved_ratchet_advance());
    let bytes = manager.save_state().expect("save");
    let reloaded = MlsManager::load_or_create("ua-fresh", "dev1", Some(bytes)).expect("reload");
    assert!(!reloaded.has_unsaved_ratchet_advance());
}

#[test]
fn a_decrypted_application_frame_is_an_unsaved_advance_until_serialised() {
    let (mut alice, mut bob) = pair_in_group("g-unsaved-recv");
    let _ = bob.save_state().expect("checkpoint after joining");
    assert!(!bob.has_unsaved_ratchet_advance());

    let frame = alice.send_message("g-unsaved-recv", b"hi").expect("send");
    bob.process_incoming_message("g-unsaved-recv", &frame)
        .expect("decrypt");

    assert!(
        bob.has_unsaved_ratchet_advance(),
        "a RECEIVE consumes a generation; the epoch is unchanged, so only this flag can see it"
    );
    bob.save_state().expect("checkpoint");
    assert!(!bob.has_unsaved_ratchet_advance());
}

#[test]
fn a_send_and_a_burn_are_unsaved_advances_until_serialised() {
    let (mut alice, _bob) = pair_in_group("g-unsaved-send");
    let _ = alice.save_state().expect("checkpoint");
    assert!(!alice.has_unsaved_ratchet_advance());

    alice.send_message("g-unsaved-send", b"x").expect("send");
    assert!(alice.has_unsaved_ratchet_advance());
    alice.save_state().expect("checkpoint");
    assert!(!alice.has_unsaved_ratchet_advance());

    alice
        .skip_send_generations("g-unsaved-send", 2)
        .expect("burn");
    assert!(alice.has_unsaved_ratchet_advance());
}

/// THE DEFECT ITSELF, WITHOUT A PHONE: the older snapshot passes the epoch guard, installing it
/// derives the SAME generation a second time, and only the flag distinguishes the two managers.
#[test]
fn the_epoch_guard_accepts_the_snapshot_that_rewinds_the_receive_ratchet_and_the_flag_names_it() {
    let gid = "g-unsaved-rewind";
    let (mut alice, mut bob) = pair_in_group(gid);
    let behind = bob.save_state().expect("the checkpoint on disk");

    let frame = alice.send_message(gid, b"spent").expect("send");
    bob.process_incoming_message(gid, &frame)
        .expect("read once");

    let mut candidate =
        MlsManager::load_or_create("ua-bob", "dev1", Some(behind)).expect("restore");
    assert!(
        bob.reload_is_monotonic(&candidate),
        "same epoch: the epoch guard cannot see a generation that moved inside it"
    );
    assert!(
        bob.has_unsaved_ratchet_advance(),
        "the live manager is ahead of that file, and says so"
    );
    // What installing it would do: the spent generation decrypts AGAIN.
    let again = candidate
        .process_incoming_message(gid, &frame)
        .expect("the rewound ratchet accepts a frame the live one already spent");
    assert_eq!(again.as_deref(), Some(b"spent".as_ref()));
    assert!(
        bob.process_incoming_message(gid, &frame).is_err(),
        "the live ratchet is the one that refuses the replay"
    );
}
