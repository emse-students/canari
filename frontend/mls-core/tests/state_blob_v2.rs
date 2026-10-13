//! THE FRAMED v2 STATE BLOB: WRITTEN BY THE BROWSER, READ HERE - AND A CORRUPT ONE IS NEVER A STATE.
//!
//! The v2 writer is TypeScript (`frontend/src/lib/mls-client/mlsStateSeal.ts`, WebCrypto AES-GCM)
//! and the reader is `mls_core::state_blob`. A corrupt checkpoint is lost MLS state, so these tests
//! answer four questions, each against the WRITER'S OWN BYTES where it matters:
//!
//! 1. **Do the two implementations agree?** `webcrypto-v2-peer-state.bin` was sealed by the
//!    TypeScript module itself (`frontend/scripts/freeze-v2-state-blob-fixture.ts`) over the
//!    v0.14.14 peer state, and it must LOAD here, at the right epoch. The derivation is pinned on
//!    both sides by the same known-answer bytes (`mlsStateSeal.test.ts` asserts the identical hex).
//! 2. **Does the old format still open through the same entry point?** Dual read: legacy blobs are
//!    every installed device's state.
//! 3. **Does every alteration fail - and fail as the right TYPE?** Bit flips in each region,
//!    truncations, a wrong key, a forged fingerprint, a rewritten version byte.
//! 4. **What does a build that predates v2 do with it?** Fails loudly, never loads.

#[path = "cross_version/params.rs"]
mod params;

use mls_core::MlsError;
use mls_core::security::{decrypt_blob, encrypt_blob};
use mls_core::state::MlsManager;
use mls_core::state_blob::{self, Framed, HEADER_LEN, MAGIC, V2_IV_LEN, VERSION_2};
use openmls_traits::OpenMlsProvider;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::AeadType;

/// `state_blob::key_fingerprint([7; 32])`, also asserted by `mlsStateSeal.test.ts`.
const KAT_FINGERPRINT: &str = "aeb248d2a1f6c577";
/// `state_blob::v2_aead_key([7; 32])`, also asserted by `mlsStateSeal.test.ts`.
const KAT_AES_KEY: &str = "fe75bd5d3621ef0d97fe8fa2c1bb53ce3c4121fe57ddb4b841a47692012dacb5";

const WEB_FIXTURE: &str = "webcrypto-v2-peer-state.bin";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(params::FIXTURE_DIR).join(name);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixture {}: {e}. Committed evidence - restore it from git; regenerating it \
             would turn this test into a round trip.",
            path.display()
        )
    })
}

/// Seals a v2 blob in Rust, for the round trips that need a state other than the frozen one. NOT a
/// product writer - `mls-core` exposes none, which is what keeps native builds from writing v2.
fn seal_v2_in_test(device_key: &[u8; 32], plain: &[u8], iv: [u8; V2_IV_LEN]) -> Vec<u8> {
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(&MAGIC);
    header.push(VERSION_2);
    header.extend_from_slice(&state_blob::key_fingerprint(device_key));
    let key = state_blob::v2_aead_key(device_key).expect("derive");
    let provider = openmls_rust_crypto::OpenMlsRustCrypto::default();
    let ct = provider
        .crypto()
        .aead_encrypt(AeadType::Aes256Gcm, &key, plain, &iv, &header)
        .expect("seal");
    let mut out = header;
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    out
}

fn load(blob: Vec<u8>, key: &[u8; 32]) -> Result<MlsManager, MlsError> {
    MlsManager::load_with_key(params::PEER_USER, params::PEER_DEVICE, Some(blob), key)
}

fn expect_undecryptable(blob: Vec<u8>, what: &str) {
    match load(blob, &params::DEVICE_KEY) {
        Err(MlsError::StateUndecryptable(_)) => {}
        Err(other) => panic!("{what}: expected StateUndecryptable, got {other:?}"),
        Ok(_) => panic!("{what}: an altered blob LOADED - that is a corrupt state accepted"),
    }
}

// --- 1. The two implementations agree -------------------------------------------------------

#[test]
fn the_derivation_matches_the_known_answer_the_typescript_writer_also_asserts() {
    assert_eq!(
        hex(&state_blob::key_fingerprint(&params::DEVICE_KEY)),
        KAT_FINGERPRINT
    );
    assert_eq!(
        hex(&state_blob::v2_aead_key(&params::DEVICE_KEY).expect("derive")),
        KAT_AES_KEY
    );
}

#[test]
fn a_state_sealed_by_the_web_writer_loads_here_at_its_epoch() {
    let blob = fixture(WEB_FIXTURE);
    assert!(matches!(state_blob::parse(&blob), Ok(Framed::V2 { .. })));
    let restored = load(blob, &params::DEVICE_KEY).expect("the web writer's v2 blob must load");
    assert_eq!(
        restored.get_epoch(params::GROUP_ID).expect("group"),
        params::EXPECTED_EPOCH
    );
}

#[test]
fn a_live_state_round_trips_through_v2_and_keeps_its_group() {
    let mut me = MlsManager::load_or_create("carol", "dev1", None).expect("create");
    me.create_group("g".to_string()).expect("group");
    let plain = me.save_state().expect("export");
    let blob = seal_v2_in_test(&params::DEVICE_KEY, &plain, [3u8; V2_IV_LEN]);
    let restored = MlsManager::load_with_key("carol", "dev1", Some(blob), &params::DEVICE_KEY)
        .expect("round trip");
    assert_eq!(
        restored.get_epoch("g").expect("group"),
        me.get_epoch("g").expect("group")
    );
}

// --- 2. Dual read: the old format still opens -------------------------------------------------

#[test]
fn the_frozen_legacy_envelope_still_parses_as_legacy_and_opens() {
    // Written by v0.14.14 - bytes, not a round trip.
    let blob = fixture(&format!(
        "{}-{}",
        params::FIXTURE_VERSION,
        params::DEVICE_KEY_ENVELOPE
    ));
    match state_blob::parse(&blob).expect("parse") {
        Framed::Legacy(body) => assert_eq!(
            decrypt_blob(&params::DEVICE_KEY, body).expect("open"),
            params::SEALED_PLAINTEXT
        ),
        other => panic!("a v0.14.14 blob must read as legacy, got {other:?}"),
    }
}

#[test]
fn a_legacy_sealed_state_loads_through_the_same_entry_point_as_v2() {
    let plain = fixture(&format!(
        "{}-{}",
        params::FIXTURE_VERSION,
        params::PEER_STATE
    ));
    let blob = encrypt_blob(&params::DEVICE_KEY, &plain).expect("legacy seal");
    let restored = load(blob, &params::DEVICE_KEY).expect("legacy must still load");
    assert_eq!(
        restored.get_epoch(params::GROUP_ID).expect("group"),
        params::EXPECTED_EPOCH
    );
}

// --- 3. Every alteration fails, as the right type --------------------------------------------

#[test]
fn a_flipped_bit_in_the_body_iv_or_tag_is_undecryptable() {
    let blob = fixture(WEB_FIXTURE);
    let body_start = HEADER_LEN;
    for (what, at) in [
        ("first IV byte", body_start),
        ("last IV byte", body_start + V2_IV_LEN - 1),
        ("first ciphertext byte", body_start + V2_IV_LEN),
        ("middle of the ciphertext", blob.len() / 2),
        ("first tag byte", blob.len() - 16),
        ("last tag byte", blob.len() - 1),
    ] {
        let mut altered = blob.clone();
        altered[at] ^= 0x01;
        expect_undecryptable(altered, what);
    }
}

#[test]
fn a_truncated_v2_blob_is_undecryptable_at_every_length_an_interrupted_write_leaves() {
    let blob = fixture(WEB_FIXTURE);
    for len in [
        0,
        11,
        HEADER_LEN,
        HEADER_LEN + V2_IV_LEN,
        HEADER_LEN + V2_IV_LEN + 15,
        blob.len() / 2,
        blob.len() - 1,
    ] {
        expect_undecryptable(blob[..len].to_vec(), &format!("truncated to {len}"));
    }
}

#[test]
fn a_rewritten_version_byte_never_reaches_a_state() {
    let blob = fixture(WEB_FIXTURE);

    // 2 -> 1: the v1 path, whose fingerprint matches and whose ChaCha tag cannot verify an AES body.
    let mut as_v1 = blob.clone();
    as_v1[MAGIC.len()] = 1;
    expect_undecryptable(as_v1, "version byte rewritten to 1");

    // 2 -> 3: a version this build does not know, named as a downgrade.
    let mut as_v3 = blob.clone();
    as_v3[MAGIC.len()] = 3;
    match load(as_v3, &params::DEVICE_KEY) {
        Err(MlsError::StateUndecryptable(m)) => assert!(m.contains("downgrade"), "{m}"),
        other => panic!("expected a named downgrade, got {:?}", other.err()),
    }

    // A damaged magic: the blob reads as legacy and fails the ChaCha tag.
    let mut no_magic = blob;
    no_magic[0] ^= 0x01;
    expect_undecryptable(no_magic, "magic damaged");
}

#[test]
fn the_wrong_key_is_named_by_the_header_before_any_cipher_runs() {
    let err = load(fixture(WEB_FIXTURE), &[9u8; 32])
        .err()
        .expect("another key must not open it");
    assert!(
        matches!(err, MlsError::StateSealedUnderAnotherKey(_)),
        "a v2 blob opened with another key is a PIN rotation, said by the header: {err:?}"
    );
}

#[test]
fn a_fingerprint_forged_to_match_another_key_still_fails_the_tag() {
    // The header is the AAD, so rewriting it to claim key B cannot make key B's reader accept it.
    let other = [9u8; 32];
    let mut forged = fixture(WEB_FIXTURE);
    forged[MAGIC.len() + 1..HEADER_LEN].copy_from_slice(&state_blob::key_fingerprint(&other));
    match load(forged, &other) {
        Err(MlsError::StateUndecryptable(_)) => {}
        other => panic!("expected StateUndecryptable, got {:?}", other.err()),
    }
}

/// THE KNOWN RESIDUE, PINNED SO NOBODY MISTAKES IT FOR AN OVERSIGHT. The fingerprint is read
/// before the tag, so a corrupted fingerprint byte is reported as a PIN rotation - the wrong cause,
/// and the CORRUPT-1 class in miniature. It is 8 bytes of a multi-megabyte blob (a truncation, the
/// realistic corruption, never reaches it), it is the same in v1, and the recovery it leads to
/// destroys nothing. Changing it means opening the body under the expected fingerprint on a
/// mismatch, which is a decision for the reviewer, not a silent heal.
#[test]
fn a_corrupted_fingerprint_byte_reads_as_another_key_which_is_the_known_residue() {
    let mut blob = fixture(WEB_FIXTURE);
    blob[MAGIC.len() + 1] ^= 0x01;
    assert!(matches!(
        load(blob, &params::DEVICE_KEY),
        Err(MlsError::StateSealedUnderAnotherKey(_))
    ));
}

// --- 4. A build that predates v2 ------------------------------------------------------------

#[test]
fn a_build_older_than_the_header_fails_the_tag_instead_of_loading_anything() {
    // Before the v1 reader (< v0.18.18) every blob was `[nonce || ciphertext]`; such a build hands
    // `CANARIS\x02...` straight to ChaCha20-Poly1305 as a nonce.
    assert!(decrypt_blob(&params::DEVICE_KEY, &fixture(WEB_FIXTURE)).is_err());
}
