/// A PrivateMessage whose AEAD-protected body was altered must come back as an ERROR, never a panic.
///
/// The delivery server is not trusted with plaintext but it IS what stores and returns these bytes,
/// so a truncated or bit-flipped row is an input this crate must survive. openmls 0.8.1 put a
/// `debug_assert!(false, "Ciphertext decryption failed")` on that path: a panic in every debug
/// build, and in WASM a panic surfaces as `unreachable`, which the TS classifier reads as `'oom'` and
/// routes to the fatal handler. openmls 0.9.0 dropped the assert and returns
/// `MessageDecryptionError::AeadError`. These tests run in the debug profile on purpose - they are
/// the profile in which the old assert fired - and pin that a tampered frame is an `Err` and that
/// the group still reads the next honest frame.
use mls_core::MlsManager;

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

/// Flips one bit at `offset_from_end` bytes before the end of the frame - inside the AEAD body
/// and its tag, which close the serialized PrivateMessage.
fn flip_near_end(frame: &[u8], offset_from_end: usize) -> Vec<u8> {
    let mut out = frame.to_vec();
    let i = out.len() - offset_from_end;
    out[i] ^= 0x01;
    out
}

#[test]
fn a_bit_flipped_body_is_an_error_and_not_a_panic() {
    let (mut alice, mut bob, gid) = pair_in_group("g-tampered-body");
    let frame = alice.send_message(&gid, b"hello").expect("encrypt");

    for offset in [1, 8, 20] {
        let tampered = flip_near_end(&frame, offset);
        let result = bob.process_incoming_message(&gid, &tampered);
        assert!(
            result.is_err(),
            "a tampered body (bit flipped {offset} bytes from the end) must be refused, got {result:?}"
        );
    }

    // The group survives the refusals: the next honest frame still reads.
    let next = alice.send_message(&gid, b"still here").expect("encrypt");
    let out = bob
        .process_incoming_message(&gid, &next)
        .expect("a later honest frame must decrypt after tampered ones were refused");
    assert_eq!(out.as_deref(), Some(b"still here".as_ref()));
}

#[test]
fn a_truncated_frame_is_an_error_and_not_a_panic() {
    let (mut alice, mut bob, gid) = pair_in_group("g-truncated-body");
    let frame = alice.send_message(&gid, b"hello").expect("encrypt");

    for keep in [frame.len() - 1, frame.len() / 2, 4] {
        let result = bob.process_incoming_message(&gid, &frame[..keep]);
        assert!(
            result.is_err(),
            "a frame truncated to {keep} of {} bytes must be refused, got {result:?}",
            frame.len()
        );
    }
}
