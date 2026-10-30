//! RFC 9420 section 12.4.3.2: an external commit may carry a Remove proposal ONLY for the joiner's
//! own prior leaf - the resync case. OpenMLS 0.9 validates the proposal list's SHAPE (one
//! ExternalInit, inline Remove allowed) and leaves the identity half to the application
//! (`public_group/validation.rs`, "This MUST be checked by the application"), so a member's
//! processing path is where it is enforced (`messaging.rs`, `refuse_foreign_external_remove`).
//!
//! The commit that breaks the rule is built here with the stock OpenMLS builder: its automatic
//! Remove picks the leaf holding the SIGNATURE KEY the joiner presents, so a joiner presenting
//! bob's key under another credential produces exactly the frame a receiver has to refuse - a
//! Remove of a leaf whose identity is not the joiner's.
use mls_core::{MlsError, MlsManager};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn device(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).unwrap_or_else(|e| panic!("{user}:{dev}: {e}"))
}

/// A member whose signer the test holds: bob:dev1 enters through a KeyPackage built here.
struct RawMember {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
}

impl RawMember {
    fn new() -> Self {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).expect("signer");
        signer.store(provider.storage()).expect("store signer");
        Self { provider, signer }
    }

    fn credential_with_key(&self, identity: &str) -> CredentialWithKey {
        CredentialWithKey {
            credential: BasicCredential::new(identity.as_bytes().to_vec()).into(),
            signature_key: self.signer.public().into(),
        }
    }

    fn key_package(&self, identity: &str) -> Vec<u8> {
        KeyPackage::builder()
            .build(
                SUITE,
                &self.provider,
                &self.signer,
                self.credential_with_key(identity),
            )
            .expect("key package")
            .key_package()
            .tls_serialize_detached()
            .expect("serialize key package")
    }
}

/// alice:dev1 creates `gid`, adds bob:dev1 (signer held by the test) and carol:dev1.
fn group(gid: &str) -> (MlsManager, MlsManager, RawMember) {
    let mut alice = device("alice", "dev1");
    let mut carol = device("carol", "dev1");
    let bob = RawMember::new();
    alice.create_group(gid.to_string()).expect("create");
    let kp_bob = bob.key_package("bob:dev1");
    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (_c, welcome, _a, _s) = alice
        .add_members_bulk(gid, &[&kp_bob, &kp_carol])
        .expect("add bob and carol");
    alice.merge_pending_commit_for(gid).expect("merge");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    carol
        .process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("carol joins");
    (alice, carol, bob)
}

/// An external commit built on `group_info` whose new leaf carries `identity`, presenting (and
/// signing with) `key_holder`'s signature key - so the builder adds a Remove of the leaf holding
/// that key.
fn external_commit_presenting_key_of(
    key_holder: &RawMember,
    identity: &str,
    group_info: &[u8],
) -> Vec<u8> {
    let joiner = OpenMlsRustCrypto::default();
    let info = match MlsMessageIn::tls_deserialize(&mut &group_info[..])
        .expect("group info")
        .extract()
    {
        MlsMessageBodyIn::GroupInfo(gi) => gi,
        _ => panic!("not a GroupInfo"),
    };
    let (_group, bundle) = MlsGroup::external_commit_builder()
        .with_config(
            MlsGroupJoinConfig::builder()
                .use_ratchet_tree_extension(true)
                .build(),
        )
        .build_group(&joiner, info, key_holder.credential_with_key(identity))
        .expect("build group")
        .load_psks(joiner.storage())
        .expect("psks")
        .build(joiner.rand(), joiner.crypto(), &key_holder.signer, |_| true)
        .expect("build commit")
        .finalize(&joiner)
        .expect("finalize");
    let (commit, _w, _gi) = bundle.into_contents();
    commit.tls_serialize_detached().expect("serialize commit")
}

fn has(identities: &[String], identity: &str) -> bool {
    identities.iter().any(|i| i == identity)
}

/// Every marker `classifyIncomingDecryptError` (web) matches BEFORE `same-epoch refusal`, and the
/// native gap wrapper: a refusal whose text carried one of them would be read as that kind instead.
const EARLIER_MARKERS: [&str; 8] = [
    "EVICTED:",
    "CannotDecryptOwnMessage",
    "SecretReuseError",
    "out of memory",
    "unreachable",
    "TooDistantInTheFuture",
    "past epoch application frame",
    "GAP_QUEUED",
];

#[test]
fn a_refusal_carries_no_committer_text_so_a_hostile_credential_cannot_reclassify_it() {
    for hostile in [
        "x:unreachable",
        "EVICTED:x",
        "x:out of memory SecretReuseError",
    ] {
        let gid = "g-hostile-credential";
        let (mut alice, _carol, bob) = group(gid);
        let info = alice.export_group_info(gid).expect("group info");
        let commit = external_commit_presenting_key_of(&bob, hostile, &info);

        let err = alice
            .process_incoming_message(gid, &commit)
            .expect_err("refused");
        assert!(matches!(err, MlsError::ForeignExternalRemove(_)), "{err:?}");
        assert_eq!(
            err.decrypt_kind(),
            mls_core::DecryptErrorKind::SameEpochRefusal
        );
        let text = err.to_string();
        assert!(text.contains("same-epoch refusal"), "{text}");
        for marker in EARLIER_MARKERS {
            assert!(
                !text.contains(marker),
                "the refusal of a {hostile:?} credential reads {marker:?}: {text}"
            );
        }
        assert!(!text.contains("bob:dev1"), "{text}");
    }
}

#[test]
fn an_external_commit_removing_another_members_leaf_is_refused_before_it_merges() {
    let gid = "g-foreign-remove";
    let (mut alice, mut carol, bob) = group(gid);
    let epoch = alice.get_epoch(gid).expect("epoch");
    let info = alice.export_group_info(gid).expect("group info");

    let commit = external_commit_presenting_key_of(&bob, "mallory:dev1", &info);

    for (name, member) in [("alice", &mut alice), ("carol", &mut carol)] {
        let refused = member.process_incoming_message(gid, &commit);
        assert!(
            matches!(refused, Err(MlsError::ForeignExternalRemove(_))),
            "{name} must refuse an external commit removing a leaf that is not the joiner's, got {refused:?}"
        );
        assert_eq!(
            member.get_epoch(gid).expect("epoch"),
            epoch,
            "{name}: nothing merged"
        );
        let members = member.member_identities(gid).expect("members");
        assert!(
            has(&members, "bob:dev1"),
            "{name}: bob's leaf is still there"
        );
        assert!(
            !has(&members, "mallory:dev1"),
            "{name}: the joiner did not enter"
        );
    }

    // The group still works for everyone in it.
    let ciphertext = alice.send_message(gid, b"still here").expect("alice sends");
    assert_eq!(
        carol
            .process_incoming_message(gid, &ciphertext)
            .expect("carol reads")
            .expect("plaintext"),
        b"still here"
    );
}

#[test]
fn the_resync_that_replaces_the_joiners_own_prior_leaf_still_merges() {
    // bob:dev1 lost its group but kept its key: its external commit removes ITS OWN prior leaf.
    let gid = "g-resync";
    let (mut alice, mut carol, bob) = group(gid);
    let epoch = alice.get_epoch(gid).expect("epoch");
    let info = alice.export_group_info(gid).expect("group info");

    let commit = external_commit_presenting_key_of(&bob, "bob:dev1", &info);

    for (name, member) in [("alice", &mut alice), ("carol", &mut carol)] {
        member
            .process_incoming_message(gid, &commit)
            .unwrap_or_else(|e| panic!("{name} merges the resync: {e}"));
        assert_eq!(member.get_epoch(gid).expect("epoch"), epoch + 1);
        let members = member.member_identities(gid).expect("members");
        assert_eq!(
            members.iter().filter(|i| *i == "bob:dev1").count(),
            1,
            "{name}: bob's prior leaf was replaced, not doubled"
        );
    }
}

#[test]
fn an_mls_manager_rejoining_with_its_own_key_replaces_its_leaf_and_merges() {
    // The production path end to end: carol forgets the group, keeps her key, and rejoins through
    // `join_by_external_commit`, which carries a Remove of her prior leaf.
    let gid = "g-rejoin";
    let (mut alice, mut carol, _bob) = group(gid);
    let epoch = alice.get_epoch(gid).expect("epoch");
    let info = alice.export_group_info(gid).expect("group info");
    carol.forget_group(gid, 0);
    let (_g, commit) = carol.join_by_external_commit(&info).expect("carol rejoins");

    alice
        .process_incoming_message(gid, &commit)
        .expect("alice merges carol's resync");
    carol.merge_pending_commit_for(gid).expect("carol merges");
    assert_eq!(alice.get_epoch(gid).expect("epoch"), epoch + 1);
    let members = alice.member_identities(gid).expect("members");
    assert_eq!(members.iter().filter(|i| *i == "carol:dev1").count(), 1);
    assert!(has(&members, "bob:dev1"));

    let ciphertext = alice.send_message(gid, b"welcome back").expect("send");
    assert_eq!(
        carol
            .process_incoming_message(gid, &ciphertext)
            .expect("carol reads")
            .expect("plaintext"),
        b"welcome back"
    );
}

#[test]
fn a_fresh_external_join_carries_no_remove_and_merges() {
    let gid = "g-fresh";
    let (mut alice, mut carol, _bob) = group(gid);
    let info = alice.export_group_info(gid).expect("group info");
    let mut dave = device("dave", "dev1");
    let (_g, commit) = dave.join_by_external_commit(&info).expect("dave joins");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice merges");
    carol
        .process_incoming_message(gid, &commit)
        .expect("carol merges");
    assert!(has(
        &alice.member_identities(gid).expect("members"),
        "dave:dev1"
    ));
}
