//! A LEAF FROM A BUILD BEFORE DEVICE IDENTITIES carries a bare `userId` credential, no colon, no
//! device. It names a user and no device: removed with that user, never pinned, never taken for a
//! `user:device` identity - `mls_core::device_trust::canonical_user_of`
//! (docs/wiki/legacy-compatibility.md).

use mls_core::MlsManager;
use mls_core::device_trust::{canonical_identity, canonical_user_of, identity_names};
use openmls::prelude::tls_codec::Serialize as _;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// `alice` joins a group created by a legacy client whose credential is the bare `bare_user`.
fn alice_in_a_group_with_a_bare_leaf(gid: &str, bare_user: &str) -> MlsManager {
    let mut alice = MlsManager::load_or_create("alice", "dev1", None).expect("alice");
    let alice_kp = alice.generate_key_package().expect("kp");

    let provider = OpenMlsRustCrypto::default();
    let signer = SignatureKeyPair::new(CS.signature_algorithm()).expect("keys");
    signer.store(provider.storage()).expect("store");
    let credential = CredentialWithKey {
        credential: BasicCredential::new(bare_user.as_bytes().to_vec()).into(),
        signature_key: signer.public().into(),
    };
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(CS)
        .use_ratchet_tree_extension(true)
        .build();
    let mut legacy = MlsGroup::new_with_group_id(
        &provider,
        &signer,
        &config,
        GroupId::from_slice(gid.as_bytes()),
        credential,
    )
    .expect("legacy group");
    let kp = KeyPackageIn::tls_deserialize_exact_bytes(&alice_kp)
        .expect("decode")
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .expect("valid");
    let (_, welcome, _) = legacy
        .add_members(&provider, &signer, &[kp])
        .expect("add alice");
    legacy.merge_pending_commit(&provider).expect("merge");
    let tree = legacy
        .export_ratchet_tree()
        .tls_serialize_detached()
        .unwrap();
    alice
        .process_welcome(&welcome.tls_serialize_detached().unwrap(), Some(&tree))
        .expect("alice joins");
    alice
}

#[test]
fn a_bare_identity_names_its_user_and_no_device() {
    assert_eq!(canonical_user_of("BoB").as_deref(), Some("bob"));
    assert_eq!(canonical_identity("bob"), None, "no device, so no pin key");
    assert!(!identity_names("bob", "bob:dev1"));
    assert!(!identity_names("bob:dev1", "bob"));
    assert_eq!(canonical_user_of(""), None);
}

#[test]
fn a_bare_leaf_is_removed_by_its_user_id() {
    let gid = "g-bare-remove";
    let mut alice = alice_in_a_group_with_a_bare_leaf(gid, "BOB");
    // The measurement the shim's removal waits on, in every load's composition line.
    assert_eq!(alice.legacy_bare_leaves(), 1);
    assert!(
        alice
            .state_composition_summary()
            .contains("1 legacy bare leaves")
    );
    assert_eq!(
        alice.member_signature_key(gid, "bob:dev1").unwrap(),
        None,
        "a bare leaf never answers for a device"
    );
    alice
        .remove_members_for_users(gid, &["bob"])
        .expect("the bare leaf is bob's");
    alice.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(alice.member_identities(gid).unwrap(), vec!["alice:dev1"]);
    assert_eq!(alice.legacy_bare_leaves(), 0);
}

/// GRAINE'S RUN READS USERS WITH THE SAME READER: a bare leaf is a PRESENT user, so a new device of
/// that user continues the run (`graine_run.rs`, D5) - it is not a malformed leaf naming nobody.
#[test]
fn a_new_device_of_a_bare_leafs_user_continues_the_graine_run() {
    let gid = "g-bare-run";
    let mut alice = alice_in_a_group_with_a_bare_leaf(gid, "bob");
    let run = alice.graine_run(gid).expect("run").run_id;
    let kp = MlsManager::load_or_create("bob", "dev2", None)
        .unwrap()
        .generate_key_package()
        .unwrap();
    alice
        .add_members_bulk_with_base(gid, &[&kp], &["bob:dev2"])
        .expect("stage");
    alice.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(alice.graine_run(gid).expect("run").run_id, run);
}

#[test]
fn a_bare_leaf_is_never_pinned_and_never_removed_as_a_device() {
    let gid = "g-bare-device";
    let mut alice = alice_in_a_group_with_a_bare_leaf(gid, "bob");
    assert!(alice.pinned_signature_keys("bob", "").is_none());
    assert!(
        alice
            .remove_members_for_devices(gid, &["bob:dev1"])
            .is_err()
    );
}
