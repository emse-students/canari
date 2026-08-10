/// Sender Ratchet robustness tests at the same epoch (bursts + duplicate delivery).
///
/// Context: sending several messages at once, combined with multi-path delivery (realtime
/// publish, queue, FCM, native requeue), regularly delivers generations out of order or twice.
/// With the default OpenMLS tolerance (5), a generation arriving too late fell outside the window
/// -> `SecretTreeError(TooDistantInThePast)`, and a duplicate -> `SecretReuseError`. Both errors
/// are PERMANENT: requeueing them looped forever (retry storm, plus repeated state
/// decrypt/persist on mobile).
///
/// Two guarantees verified here:
///  1. A consumed generation is REPORTED (`SecretReuse`), because this layer cannot tell a
///     duplicate from a message lost to a rewound sender and must not decide for the caller.
///  2. An out-of-order burst still decrypts thanks to the widened window.
///
/// The third rule of this file - a frame older than the retained window (`TooDistantInThePast`)
/// stays a silent `Ok(None)` - is deliberately NOT tested: `out_of_order_tolerance` is 2000, so
/// producing one costs 2000 sends, and a test that cannot reach its own path is worse than none.
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
    // Stage-only add (C7-A): merge as if the server accepted, then export the post-merge tree.
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, bob, gid.to_string())
}

#[test]
fn consumed_generation_is_reported_as_secret_reuse_not_swallowed() {
    let (mut alice, mut bob, gid) = pair_in_group("g-same-epoch-dup");

    let ciphertext = alice.send_message(&gid, b"hello").expect("encrypt");

    let first = bob
        .process_incoming_message(&gid, &ciphertext)
        .expect("first decrypt must succeed");
    assert_eq!(first.as_deref(), Some(b"hello".as_ref()));

    // Re-delivering the same ciphertext is indistinguishable, HERE, from a rewound sender
    // encrypting a brand-new message at this consumed generation - the two differ only in the
    // frame's bytes, which the caller holds and this layer does not. So the outcome must carry the
    // diagnosis rather than an `Ok(None)` that reads as "nothing to show": answering the benign
    // case for both is what let a device drop real messages in silence, and then certify a peer's
    // conversation complete because it had recorded no gap of its own (measured 2026-08-10).
    //
    // Requeueing is still forbidden - the frame can never decrypt - but that is the CALLER's
    // decision, and both native callers already classify `SecretReuse` and ACK without queueing
    // (`recevoir_message_bytes`, `map_decrypt_outcome`); each was unreachable until this changed.
    let err = bob
        .process_incoming_message(&gid, &ciphertext)
        .expect_err("a consumed generation must reach the caller, not be swallowed as Ok(None)");
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::SecretReuse,
        "the caller classifies on this kind: {err}"
    );
}

#[test]
fn out_of_order_burst_decrypts_with_widened_tolerance() {
    let (mut alice, mut bob, gid) = pair_in_group("g-same-epoch-burst");

    // Alice sends a burst at the same epoch: generations 0..=29.
    let mut ciphertexts = Vec::new();
    for i in 0..30u32 {
        ciphertexts.push(
            alice
                .send_message(&gid, format!("m{i}").as_bytes())
                .expect("encrypt burst message"),
        );
    }

    // Deliver the LAST generation first (jump ahead, store skipped keys), then 0..=28 in order.
    // With the default out_of_order_tolerance of 5 the early generations would be dropped as
    // TooDistantInThePast; the widened window must let every one of them decrypt cleanly.
    let last = bob
        .process_incoming_message(&gid, &ciphertexts[29])
        .expect("decrypt last generation");
    assert_eq!(last.as_deref(), Some(b"m29".as_ref()));

    for (i, ciphertext) in ciphertexts.iter().enumerate().take(29) {
        let out = bob
            .process_incoming_message(&gid, ciphertext)
            .unwrap_or_else(|e| panic!("decrypt of out-of-order generation {i} failed: {e}"));
        assert_eq!(
            out.as_deref(),
            Some(format!("m{i}").as_bytes()),
            "out-of-order generation {i} should decrypt within tolerance"
        );
    }
}
