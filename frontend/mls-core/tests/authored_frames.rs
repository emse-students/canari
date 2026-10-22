//! An application frame carries its AUTHOR'S SIGNATURE inside the plaintext, so that a copy of the
//! message relayed later - a history bundle, which any member can write - can still be checked
//! against the author's key long after MLS has forgotten the epoch it was sent in.
//!
//! MLS proves the sender of a frame while the frame is live. Once a member has decrypted it, the
//! plaintext is just bytes in a local store, and the proof travels with them: `author_descriptor` binds the group,
//! the author's `userId:deviceId` and the SHA-256 of the exact bytes the author sent (which hold the
//! message id, the author's timestamp and the content), and the author's MLS credential key signs it.
//!
//! What these tests hold: the sender appends the proof, the receiver keeps it only when it verifies
//! against the leaf MLS just authenticated the frame with, and strips it - loudly - otherwise, so a
//! proof that reaches the application is one this device has checked.
//!
//! Protocol: `docs/wiki/protocols/history-reconciliation.md`, "Restored history carries its author's
//! signature".

use mls_core::MlsManager;
use mls_core::authorship::{
    AuthorProof, AuthorVerdict, append_author_proof, author_descriptor, encode_author_proof,
    split_author_proof,
};
use mls_core::graine_signature::{GraineSignatureError, verify_graine_signature};

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

/// `AppMessage { text: TextMsg { content: "hi" }, message_id: "m-1", sent_at: 1700000000000 }`,
/// written by hand so the test does not depend on a protobuf generator the crate does not have.
fn app_message_bytes() -> Vec<u8> {
    let mut out = vec![0x0a, 0x04, 0x0a, 0x02, b'h', b'i'];
    out.extend_from_slice(&[0x32, 0x03, b'm', b'-', b'1']);
    // field 8, varint 1_700_000_000_000
    out.push(0x40);
    let mut v: u64 = 1_700_000_000_000;
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
    out
}

#[test]
fn an_authored_frame_reaches_the_receiver_with_a_proof_that_verifies() {
    let gid = "g-authored";
    let (mut alice, mut bob) = pair_in_group(gid);
    let body = app_message_bytes();

    let sent = alice.send_authored_message(gid, &body).expect("send");
    let received = bob
        .process_incoming_message_with_sender(gid, &sent.ciphertext)
        .expect("decrypt")
        .expect("an application message");

    assert_eq!(received.author, AuthorVerdict::Verified);
    let (body_len, proof) =
        split_author_proof(&received.plaintext).expect("the proof travelled at the end");
    assert_eq!(
        &received.plaintext[..body_len],
        &body[..],
        "the bytes before the proof are exactly the bytes the author signed"
    );
    assert_eq!(proof.author, "alice:dev1");
    assert_eq!(proof.version, 1);

    // The proof is checkable by anyone holding alice's key - which is the point: a member reading
    // it out of a history bundle has no MLS frame left to lean on.
    let alice_key = bob
        .member_signature_key(gid, "alice:dev1")
        .expect("tree read")
        .expect("alice is a leaf");
    let descriptor = author_descriptor(gid, "alice:dev1", &body);
    assert_eq!(
        verify_graine_signature(&alice_key, &descriptor, &proof.signature),
        Ok(())
    );

    // And the sender holds the very same proof for its own copy, without asking anybody.
    assert_eq!(
        sent.author_proof,
        encode_author_proof(&proof),
        "the proof the sender keeps is the one on the wire, byte for byte"
    );
}

#[test]
fn a_proof_does_not_verify_in_another_group_nor_over_other_bytes() {
    let gid = "g-authored-replay";
    let (alice, bob) = pair_in_group(gid);
    let body = app_message_bytes();
    let proof_inner = alice.author_proof_for(gid, &body).expect("proof");
    let plaintext = append_author_proof(&body, &proof_inner);
    let (_, proof) = split_author_proof(&plaintext).expect("parses");
    let alice_key = bob
        .member_signature_key(gid, "alice:dev1")
        .unwrap()
        .unwrap();

    // REPLAYED INTO ANOTHER GROUP: the group id is inside what was signed.
    let elsewhere = author_descriptor("g-other", "alice:dev1", &body);
    assert_eq!(
        verify_graine_signature(&alice_key, &elsewhere, &proof.signature),
        Err(GraineSignatureError::Invalid)
    );
    // A TIMESTAMP OR A BODY CHANGED: the hash of the exact bytes is inside what was signed.
    let mut altered = body.clone();
    let last = altered.len() - 1;
    altered[last] ^= 0x01;
    let moved = author_descriptor(gid, "alice:dev1", &altered);
    assert_eq!(
        verify_graine_signature(&alice_key, &moved, &proof.signature),
        Err(GraineSignatureError::Invalid)
    );
    // RE-ATTRIBUTED to another device of the same key holder: the identity is signed too.
    let other_device = author_descriptor(gid, "alice:dev2", &body);
    assert_eq!(
        verify_graine_signature(&alice_key, &other_device, &proof.signature),
        Err(GraineSignatureError::Invalid)
    );
    drop(alice);
}

#[test]
fn a_proof_naming_someone_other_than_the_mls_sender_is_stripped() {
    let gid = "g-authored-impostor";
    let (mut alice, mut bob) = pair_in_group(gid);
    let body = app_message_bytes();
    // Alice signs a descriptor naming carol, with her own key - the signature is "valid" for what it
    // says, and what it says is a lie about who sent the frame.
    let descriptor = author_descriptor(gid, "carol:dev1", &body);
    let signature = alice
        .sign_with_device_credential(&descriptor)
        .expect("sign");
    let forged = encode_author_proof(&AuthorProof {
        version: 1,
        author: "carol:dev1".to_string(),
        signature,
    });
    let ciphertext = alice
        .send_message(gid, &append_author_proof(&body, &forged))
        .expect("send");

    let received = bob
        .process_incoming_message_with_sender(gid, &ciphertext)
        .expect("decrypt")
        .expect("application");
    assert!(
        matches!(received.author, AuthorVerdict::Refused(_)),
        "got {:?}",
        received.author
    );
    assert_eq!(
        received.plaintext, body,
        "a proof this device refused never reaches the application, so it can never be relayed"
    );
    assert_eq!(received.sender_identity.as_deref(), Some("alice:dev1"));
}

#[test]
fn a_proof_whose_signature_does_not_verify_is_stripped() {
    let gid = "g-authored-tampered";
    let (mut alice, mut bob) = pair_in_group(gid);
    let body = app_message_bytes();
    let inner = alice.author_proof_for(gid, &body).expect("proof");
    let plaintext = append_author_proof(&body, &inner);
    let (_, mut proof) = split_author_proof(&plaintext).unwrap();
    proof.signature[0] ^= 0xff;
    let tampered = append_author_proof(&body, &encode_author_proof(&proof));
    let ciphertext = alice.send_message(gid, &tampered).expect("send");

    let received = bob
        .process_incoming_message_with_sender(gid, &ciphertext)
        .expect("decrypt")
        .expect("application");
    assert!(matches!(received.author, AuthorVerdict::Refused(_)));
    assert_eq!(received.plaintext, body);
}

#[test]
fn an_unsigned_frame_from_an_older_build_is_returned_untouched() {
    let gid = "g-authored-legacy";
    let (mut alice, mut bob) = pair_in_group(gid);
    let body = app_message_bytes();
    let ciphertext = alice.send_message(gid, &body).expect("send");

    let received = bob
        .process_incoming_message_with_sender(gid, &ciphertext)
        .expect("decrypt")
        .expect("application");
    assert_eq!(received.author, AuthorVerdict::Unsigned);
    assert_eq!(received.plaintext, body);
}

#[test]
fn a_proof_is_only_read_as_the_last_field() {
    let body = app_message_bytes();
    let inner = encode_author_proof(&AuthorProof {
        version: 1,
        author: "alice:dev1".to_string(),
        signature: vec![7u8; 64],
    });
    let signed = append_author_proof(&body, &inner);
    // Something after the proof: it is no longer the trailer the sender appended.
    let mut moved = signed.clone();
    moved.extend_from_slice(&[0x0a, 0x00]);
    assert!(split_author_proof(&moved).is_none());
    // Not protobuf at all (a test plaintext): no proof, no panic.
    assert!(split_author_proof(b"read after the checkpoint").is_none());
    assert!(split_author_proof(&[]).is_none());
    // The trailer alone, with nothing before it, is a proof over zero bytes.
    let (len, _) = split_author_proof(&append_author_proof(&[], &inner)).expect("parses");
    assert_eq!(len, 0);
}

/// What the signature and the fork claim COST on the wire, measured rather than assumed: the push
/// path inlines a frame's base64 only under a fixed budget (`inlineProtoBudget`), so the growth per
/// frame is the number the budget has to be read against. Printed with `--nocapture`.
#[test]
fn an_authored_frame_grows_by_a_bounded_amount() {
    let gid = "g-cost";
    let (mut alice, _bob) = pair_in_group(gid);
    for text_len in [2usize, 500, 2000] {
        let mut body = vec![0x0a];
        let text = vec![b'x'; text_len];
        // TextMsg { content } inside AppMessage.text, lengths as 2-byte varints at most.
        let mut inner = vec![0x0a];
        push_varint(&mut inner, text_len as u64);
        inner.extend_from_slice(&text);
        push_varint(&mut body, inner.len() as u64);
        body.extend_from_slice(&inner);
        let sent = alice.send_authored_message(gid, &body).expect("send");
        let trailer = append_author_proof(&body, &sent.author_proof).len() - body.len();
        let overhead = sent.ciphertext.len() - body.len();
        println!(
            "[cost] body={}B ciphertext={}B overhead={}B of which proof trailer={}B",
            body.len(),
            sent.ciphertext.len(),
            overhead,
            trailer
        );
        // Signature (64) + the proof's fields + the AAD's claim (identity, 16-byte fp, 64-byte sig).
        assert!(
            trailer < 120,
            "the proof trailer stays under 120 B, was {trailer}"
        );
    }
}

fn push_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

/// The descriptor is rebuilt by `frontend/src/lib/crypto/messageAuthorship.ts`, which checks the
/// proofs a history bundle relays. These bytes are the contract between the two: the TS test
/// asserts the same hex.
#[test]
fn the_descriptor_matches_the_shared_vector() {
    let d = author_descriptor("group-1", "alice:dev-a", b"body");
    let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, SHARED_DESCRIPTOR_HEX);
}

const SHARED_DESCRIPTOR_HEX: &str = concat!(
    "00000014",
    "63616e6172692d6d6c732d617574686f722d7631", // lp("canari-mls-author-v1")
    "00000007",
    "67726f75702d31", // lp("group-1")
    "0000000b",
    "616c6963653a6465762d61", // lp("alice:dev-a")
    "00000020",
    "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5" // lp(SHA-256("body"))
);
