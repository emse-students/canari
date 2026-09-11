//! ONE MEMBER'S ELAPSED LEAF MUST NOT CLOSE A GROUP TO EVERYBODY ELSE.
//!
//! A leaf node carries a `Lifetime` only while it still is the one built from the member's
//! KeyPackage - nothing in this product ever updates a leaf - and ours last 84 days. RFC 9420 7.3
//! recommends checking those lifetimes when a ratchet tree is IMPORTED, and openmls did so on both
//! paths out of "I have no state for this group": `join_by_external_commit` and `process_welcome`.
//!
//! So on day 85 a member who merely stopped running - a device wiped, reinstalled or abandoned -
//! refused BOTH paths, for every other member, permanently, with an error naming a leaf the joiner
//! has no power over. Measured on prod 2026-09-11: `Lifetime { not_before: 1781347172, not_after:
//! 1788608372 }`, expired six days earlier, on a conversation whose other participants were all
//! present and healthy.
//!
//! What this file pins is the pair, because the two halves are only correct together:
//!
//! - an elapsed leaf ALREADY IN THE TREE no longer refuses a join, on either path, and
//! - an elapsed KeyPackage is still refused AT ADMISSION, which is the check that actually decides
//!   whether stale key material may enter a group. Dropping the tree check re-litigates nothing:
//!   it declines to re-take, against a clock that has moved, a decision the group took epochs ago.
//!
//! THE CLOCK IS PART OF THE SUBJECT HERE, so it is read rather than asserted on: the test chooses
//! a lifetime that ends a known number of seconds after the add, and waits for exactly that. The
//! only wall-clock claim made is the one openmls itself makes.
use mls_core::MlsManager;
use openmls::prelude::tls_codec::Serialize as _;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

/// Seconds a ghost's leaf stays valid after it is minted - long enough for an in-memory add,
/// short enough that waiting for it to elapse costs the suite a couple of seconds.
const GHOST_GRACE_SECS: u64 = 2;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the UNIX epoch")
        .as_secs()
}

/// Blocks until the wall clock has passed `deadline`, and no longer.
fn wait_until(deadline: u64) {
    loop {
        let now = unix_now();
        if now > deadline {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(
            (deadline - now) * 1000 + 100,
        ));
    }
}

/// A KeyPackage for a member that exists ONLY as a leaf: nothing here ever holds its private
/// state, joins, or answers.
///
/// That is the whole point. The member this stands for is a device that stopped running, and the
/// defect is that its leaf outlives its owner's participation while nothing can update it. Built
/// with openmls directly because `MlsManager` mints with the default 84-day lifetime, and a test
/// that waited 84 days would not be a test.
fn ghost_key_package(identity: &str, not_before: u64, not_after: u64) -> Vec<u8> {
    let provider = OpenMlsRustCrypto::default();
    let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    let keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm()).expect("ghost signer");
    let credential_with_key = CredentialWithKey {
        credential: BasicCredential::new(identity.as_bytes().to_vec()).into(),
        signature_key: keypair.public().into(),
    };
    KeyPackage::builder()
        .key_package_lifetime(Lifetime::init(not_before, not_after))
        .build(ciphersuite, &provider, &keypair, credential_with_key)
        .expect("ghost key package")
        .key_package()
        .tls_serialize_detached()
        .expect("serialize ghost key package")
}

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice's group, holding one leaf whose lifetime has ELAPSED since it was admitted.
///
/// Returns alice. The ghost was a perfectly valid member at the epoch that added it, which is
/// exactly the situation the product reaches by doing nothing wrong.
fn group_with_an_elapsed_leaf(gid: &str) -> MlsManager {
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");

    let minted_at = unix_now();
    let ghost = ghost_key_package("ghost:dev1", minted_at - 3600, minted_at + GHOST_GRACE_SECS);
    let (_c, _welcome, added, skipped) = alice
        .add_members_bulk(gid, &[&ghost])
        .expect("add the ghost");
    assert_eq!(
        (added.as_slice(), skipped.as_slice()),
        (&[0u32][..], &[][..]),
        "the ghost must be admitted while its lifetime is still valid - if it is skipped here, \
         GHOST_GRACE_SECS is too short for this machine and the rest of the test proves nothing"
    );
    alice
        .merge_pending_commit_for(gid)
        .expect("merge the ghost");

    wait_until(minted_at + GHOST_GRACE_SECS);
    alice
}

#[test]
fn an_elapsed_leaf_in_the_tree_does_not_refuse_an_external_join() {
    let gid = "g-elapsed-external";
    let mut alice = group_with_an_elapsed_leaf(gid);

    // carol has no state for this group and takes the self-service path. The GroupInfo she is
    // served carries the ratchet tree, ghost leaf included.
    let group_info = alice.export_group_info(gid).expect("export group_info");
    let mut carol = make_device("carol", "dev1");
    let (joined_gid, commit) = carol
        .join_by_external_commit(&group_info)
        .expect("an elapsed leaf belonging to somebody else must not refuse carol the group");
    assert_eq!(joined_gid, gid);

    // And the join is real, not merely accepted: the existing member processes it and converges.
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice processes carol's external commit");
    assert_eq!(
        alice.get_epoch(gid).expect("alice epoch"),
        carol.get_epoch(gid).expect("carol epoch"),
        "both sides sit at the same epoch after the external join"
    );
}

#[test]
fn an_elapsed_leaf_in_the_tree_does_not_refuse_a_welcome() {
    let gid = "g-elapsed-welcome";
    let mut alice = group_with_an_elapsed_leaf(gid);

    // The OTHER path out of a missing group. A Welcome carries the same tree and used to be
    // validated the same way, so the same elapsed leaf refused the Welcome sent to REPAIR the
    // external join it had already refused - both doors, closed by one member who stopped running.
    let mut dave = make_device("dave", "dev1");
    let kp_dave = dave.generate_key_package().expect("kp dave");
    let (_c, welcome, added, skipped) = alice.add_members_bulk(gid, &[&kp_dave]).expect("add dave");
    assert_eq!(
        (added.as_slice(), skipped.as_slice()),
        (&[0u32][..], &[][..])
    );
    alice.merge_pending_commit_for(gid).expect("merge dave");

    let rt = alice.export_ratchet_tree_for(gid).expect("ratchet tree");
    dave.process_welcome(welcome.as_deref().expect("welcome"), Some(&rt))
        .expect("an elapsed leaf belonging to somebody else must not refuse dave the Welcome");
    assert_eq!(
        dave.get_epoch(gid).expect("dave epoch"),
        alice.get_epoch(gid).expect("alice epoch"),
        "dave joins at alice's epoch"
    );
}

#[test]
fn admission_still_refuses_an_already_elapsed_key_package() {
    // The check that decides whether stale key material may ENTER a group is untouched, and this
    // is the half that would make the fix above a hole rather than a repair. `add_members_bulk`
    // validates every KeyPackage it is handed and reports the refusals BY INDEX rather than
    // failing the batch, so the stale one is offered beside a good one: that distinguishes "the
    // expired package was refused" from "the batch fell over", which a lone bad package could not.
    let gid = "g-elapsed-admission";
    let mut alice = make_device("alice", "dev2");
    alice.create_group(gid.to_string()).expect("create_group");

    let now = unix_now();
    let stale = ghost_key_package("stale:dev1", now - 7200, now - 3600);
    let erin = make_device("erin", "dev1");
    let kp_erin = erin.generate_key_package().expect("kp erin");

    let (_c, _welcome, added, skipped) = alice
        .add_members_bulk(gid, &[&stale, &kp_erin])
        .expect("the batch reports the refusal rather than failing");

    assert_eq!(
        skipped,
        vec![0u32],
        "an expired KeyPackage must still be refused at admission"
    );
    assert_eq!(
        added,
        vec![1u32],
        "and the refusal is that package's alone - the good one beside it still joins"
    );
}
