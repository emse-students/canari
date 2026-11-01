//! A saved state that will not load says WHY as a variant, not as a sentence.
//!
//! `MlsManager::load_with_key` used to answer `OpenMls("Decryption: ..")` for a failed AEAD tag and
//! `InvalidData` for a blob too short to be an envelope, and `load_or_create` answered
//! `OpenMls("Credential identity mismatch: ..")` for a state belonging to another device. All three
//! reached the TypeScript that has to ACT on them as prose, and the classifier there matched two
//! needles for the mismatch and defaulted everything else - a flipped byte included - to "your PIN
//! was changed on another device", offering a recovery that cannot work and refusing the PIN the
//! user actually held. Measured on 2026-09-08 as CORRUPT-2 (one byte XORed in an 18.4 MB state) and
//! CORRUPT-1 (the state truncated to half its length, which is what an interrupted flush leaves).
//!
//! These tests pin the two outcomes a caller must be able to tell apart, at the layer that KNOWS
//! them. A reworded message keeps compiling; a removed variant does not.
//!
//! **On a LEGACY blob they deliberately do not assert that "sealed under another key" and "altered"
//! are told apart, because they cannot be**: an AEAD tag that fails to verify has both explanations
//! and nothing in those bytes says which. What they assert there is that the answer CLAIMS neither.
//! The FRAMED blob every save writes since step 2 (2026-10-17) carries the key fingerprint that does
//! separate them, and the tests at the bottom pin both verdicts on it.

use mls_core::MlsError;
use mls_core::security::encrypt_blob;
use mls_core::state::MlsManager;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const DEVICE: &str = "web-test-device";

/// A key that is not the one anything here was sealed with, and a second distinct one.
fn key(byte: u8) -> [u8; 32] {
    [byte; 32]
}

#[test]
fn a_blob_whose_tag_does_not_verify_is_state_undecryptable() {
    // Sealed under one key, opened with another: the shape of a PIN rotated on another device, and
    // byte-for-byte indistinguishable from corruption, which is the whole point of the variant.
    let sealed = encrypt_blob(&key(1), b"cbor-mls-snapshot").expect("seal");

    let err = MlsManager::load_with_key(USER, DEVICE, Some(sealed), &key(2))
        .err()
        .expect("opening with the wrong key must fail");

    assert!(
        matches!(err, MlsError::StateUndecryptable(_)),
        "expected StateUndecryptable, got {err:?}"
    );
    // The code crosses both FFI boundaries as a FIELD (`StateLoadRefusal`, pinned below); the
    // Display prefix is the same word, for a reader of the logs.
    assert!(
        err.to_string().starts_with("STATE_UNDECRYPTABLE: "),
        "the code must lead the message: {err}"
    );
}

#[test]
fn an_altered_ciphertext_is_state_undecryptable_too() {
    // CORRUPT-2 in miniature: one byte flipped, length and shape intact. There is no way to tell
    // this from the case above, and the point is that neither is described as a PIN rotation.
    let mut sealed = encrypt_blob(&key(1), b"cbor-mls-snapshot").expect("seal");
    let mid = sealed.len() / 2;
    sealed[mid] ^= 0xff;

    let err = MlsManager::load_with_key(USER, DEVICE, Some(sealed), &key(1))
        .err()
        .expect("a flipped byte must fail the tag");

    assert!(
        matches!(err, MlsError::StateUndecryptable(_)),
        "expected StateUndecryptable, got {err:?}"
    );
}

#[test]
fn a_blob_too_short_to_hold_a_nonce_is_state_undecryptable_and_not_invalid_data() {
    // CORRUPT-1's shape taken to its limit - an interrupted flush, a full disk, a killed tab. It
    // used to answer `InvalidData`, a name shared with unrelated parse failures and one the
    // classifier could not act on, so it acquired the default diagnosis like everything else.
    for len in [0usize, 1, 11] {
        let err = MlsManager::load_with_key(USER, DEVICE, Some(vec![0u8; len]), &key(1))
            .err()
            .unwrap_or_else(|| panic!("a {len}-byte state cannot be an envelope"));

        assert!(
            matches!(err, MlsError::StateUndecryptable(_)),
            "expected StateUndecryptable for {len} bytes, got {err:?}"
        );
        // The length is IN the message: "too short" without a number leaves the reader unable to
        // tell a truncated write from an empty file.
        assert!(
            err.to_string().contains(&len.to_string()),
            "the message must say how short: {err}"
        );
    }
}

#[test]
fn a_keystore_that_hands_back_no_key_is_its_own_variant_and_never_a_state_verdict() {
    // Biometric mode with nothing to read - a cancelled sheet, a finger the sensor refused, a wiped
    // entry. No blob was opened, so the answer must not be one of the three the state classifier
    // routes to a rotation or an old-PIN recovery, and the caller reads the CODE, not the sentence.
    let sealed = encrypt_blob(&key(1), b"cbor-mls-snapshot").expect("seal");
    let err = MlsManager::resolve_at_rest_key(
        USER,
        DEVICE,
        Some(&sealed),
        None,
        &mls_core::keystore::NoopDeviceKeyStore,
    )
    .expect_err("no key in hand and none in the keystore must fail");

    assert!(
        matches!(err, MlsError::KeystoreKeyUnavailable(_)),
        "expected KeystoreKeyUnavailable, got {err:?}"
    );
    assert!(
        err.to_string().starts_with("KEYSTORE_KEY_UNAVAILABLE: "),
        "the code must lead the message: {err}"
    );
}

/// A keystore whose entry holds a key that does not open the blob, and whose delete is REFUSED -
/// the app's at-rest guard keeping the only copy of a hardware-held key.
struct GuardedStaleEntry {
    held: [u8; 32],
    deletes: std::sync::atomic::AtomicU32,
}

impl mls_core::keystore::DeviceKeyStore for GuardedStaleEntry {
    fn store_device_key(&self, _key: &[u8; 32], _alias: &str) -> Result<(), String> {
        Ok(())
    }
    fn retrieve_device_key(&self, _alias: &str) -> Option<[u8; 32]> {
        Some(self.held)
    }
    fn delete_device_key(&self, _alias: &str) -> Result<(), String> {
        self.deletes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err("refused by the at-rest guard".into())
    }
}

#[test]
fn a_stale_keystore_key_whose_delete_is_refused_is_kept_and_the_failure_stays_typed() {
    let sealed = encrypt_blob(&key(1), b"cbor-mls-snapshot").expect("seal");
    let store = GuardedStaleEntry {
        held: key(2),
        deletes: std::sync::atomic::AtomicU32::new(0),
    };
    let err = MlsManager::resolve_at_rest_key(USER, DEVICE, Some(&sealed), None, &store)
        .expect_err("a key that does not open the blob is not handed back");
    // The delete was ASKED and refused; the probe neither panics nor claims a deletion.
    assert_eq!(store.deletes.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(
        matches!(err, MlsError::KeystoreKeyUnavailable(_)),
        "expected KeystoreKeyUnavailable, got {err:?}"
    );
}

#[test]
fn no_state_at_all_is_not_a_failure() {
    // The control. A first launch has no blob, and reading "undecryptable" there would send a new
    // user into a recovery flow for a state that was never written.
    MlsManager::load_with_key(USER, DEVICE, None, &key(1))
        .map(|_| ())
        .expect("a device with no saved state must simply start");
}

// ── The framed shape, which every save writes since step 2 (2026-10-17) ───────────────────────
//
// `encrypt_state_blob_with_key` frames, so these are the shapes the field now holds. The header is
// what finally separates the two causes the tests above can only name together.

#[test]
fn every_save_is_framed_and_names_the_key_that_sealed_it() {
    let k = key(3);
    let manager = MlsManager::load_or_create(USER, DEVICE, None).expect("make");
    let blob = manager.save_encrypted_with_key(&k).expect("seal");

    // STEP 2 ITSELF. Before the flip this was a bare `[nonce || ciphertext]` and read as legacy.
    match mls_core::state_blob::parse(&blob).expect("a saved state must parse") {
        mls_core::state_blob::Framed::V1 {
            key_fingerprint, ..
        } => assert_eq!(key_fingerprint, mls_core::state_blob::key_fingerprint(&k)),
        other => panic!("a save must write the v1 frame, got {other:?}"),
    }

    MlsManager::load_with_key(USER, DEVICE, Some(blob), &k)
        .map(|_| ())
        .expect("a framed state must open with its own key");
}

#[test]
fn a_framed_state_sealed_under_another_key_is_named_a_rotation_and_never_corruption() {
    let sealing_key = key(4);
    let key_in_hand = key(5);
    let manager = MlsManager::load_or_create(USER, DEVICE, None).expect("make");
    let framed = manager.save_encrypted_with_key(&sealing_key).expect("seal");

    let err = MlsManager::load_with_key(USER, DEVICE, Some(framed.clone()), &key_in_hand)
        .map(|_| ())
        .expect_err("the wrong key must be refused");

    // THE WHOLE POINT OF THE HEADER. Without it these bytes answer `StateUndecryptable`, which is
    // the observation shared with a flipped byte - and the product then tells a user whose PIN was
    // genuinely rotated the same thing it tells one whose disk filled up. Here the cause is a FACT
    // read out of the envelope, not an inference from a failed tag.
    assert!(
        matches!(err, MlsError::StateSealedUnderAnotherKey(_)),
        "expected StateSealedUnderAnotherKey, got {err:?}"
    );

    // And the legacy shape of the very same ciphertext still cannot be told apart - what every blob
    // an older build wrote looks like until its first rewrite.
    let legacy = framed[mls_core::state_blob::HEADER_LEN..].to_vec();
    let err_legacy = MlsManager::load_with_key(USER, DEVICE, Some(legacy), &key_in_hand)
        .map(|_| ())
        .expect_err("the unframed blob must also be refused");
    assert!(
        matches!(err_legacy, MlsError::StateUndecryptable(_)),
        "an unframed blob carries no discriminator, so it can only be the observation: {err_legacy:?}"
    );
}

/// CORRUPT-2 and CORRUPT-1 on the shape the field now holds: one byte flipped in the body, and the
/// body cut to half its length. The header names the key in hand, so the tag failing is ALTERATION,
/// and the variant says so - the old PIN is irrelevant and the caller must not ask for it.
#[test]
fn a_framed_state_altered_under_the_key_in_hand_is_named_altered_and_never_a_rotation() {
    let k = key(6);
    let manager = MlsManager::load_or_create(USER, DEVICE, None).expect("make");
    let framed = manager.save_encrypted_with_key(&k).expect("seal");

    let mut flipped = framed.clone();
    let mid =
        mls_core::state_blob::HEADER_LEN + (flipped.len() - mls_core::state_blob::HEADER_LEN) / 2;
    flipped[mid] ^= 0xff;

    let mut cut = framed.clone();
    cut.truncate(
        mls_core::state_blob::HEADER_LEN + (framed.len() - mls_core::state_blob::HEADER_LEN) / 2,
    );

    for (name, blob) in [("one flipped byte", flipped), ("cut to half", cut)] {
        let err = MlsManager::load_with_key(USER, DEVICE, Some(blob), &k)
            .map(|_| ())
            .expect_err("an altered state must not load");
        assert!(
            matches!(err, MlsError::StateAltered(_)),
            "{name}: expected StateAltered, got {err:?}"
        );
        assert!(
            err.to_string().starts_with("STATE_ALTERED: "),
            "{name}: the code must lead the message, the same word the boundaries carry: {err}"
        );
    }
}

/// The web asks THIS reader for a verdict when WebCrypto refused a v2 blob, and it must be able to
/// tell a verdict from anything else WITHOUT reading the message: `state_verdict_code` is that
/// classification, on the variant. Each code is also the prefix the variant's `Display` writes, so
/// a log line and the typed field name a verdict with the same word.
#[test]
fn every_verdict_about_the_bytes_carries_its_code_and_nothing_else_does() {
    let verdicts = [
        (MlsError::StateAltered("x".into()), "STATE_ALTERED"),
        (
            MlsError::StateSealedUnderAnotherKey("x".into()),
            "STATE_KEY_MISMATCH",
        ),
        (
            MlsError::StateUndecryptable("x".into()),
            "STATE_UNDECRYPTABLE",
        ),
        (
            MlsError::StateIdentityMismatch("x".into()),
            "IDENTITY_MISMATCH",
        ),
    ];
    for (err, code) in verdicts {
        assert_eq!(err.state_verdict_code(), Some(code), "{err:?}");
        assert!(
            err.to_string().starts_with(&format!("{code}: ")),
            "the code must be the Display prefix too: {err}"
        );
    }
    // Not a verdict about the bytes: an engine or codec failure must stay "unknown" to the caller,
    // never acquire a recovery.
    for err in [
        MlsError::InvalidData,
        MlsError::KeystoreKeyUnavailable("x".into()),
        MlsError::OpenMls("x".into()),
    ] {
        assert_eq!(err.state_verdict_code(), None, "{err:?}");
    }

    // And on real bytes: the altered framed state answers its code through the same accessor.
    let k = key(8);
    let manager = MlsManager::load_or_create(USER, DEVICE, None).expect("make");
    let mut framed = manager.save_encrypted_with_key(&k).expect("seal");
    let last = framed.len() - 1;
    framed[last] ^= 1;
    let err = MlsManager::load_with_key(USER, DEVICE, Some(framed), &k)
        .map(|_| ())
        .expect_err("an altered state must not load");
    assert_eq!(err.state_verdict_code(), Some("STATE_ALTERED"));
}

/// What a state LOAD hands a frontend - the Tauri `initialiser_mls` rejection and the WASM
/// constructor's - is `StateLoadRefusal { code, message }`, and the frontend builds its typed error
/// from `code` ALONE. The closed set is the four verdicts plus an empty keystore; everything else is
/// `None`, however its text reads.
#[test]
fn a_state_load_refusal_carries_its_code_from_the_variant_and_never_from_the_text() {
    use mls_core::StateLoadRefusal;
    for (err, code) in [
        (MlsError::StateAltered("x".into()), "STATE_ALTERED"),
        (
            MlsError::StateSealedUnderAnotherKey("x".into()),
            "STATE_KEY_MISMATCH",
        ),
        (
            MlsError::StateUndecryptable("x".into()),
            "STATE_UNDECRYPTABLE",
        ),
        (
            MlsError::StateIdentityMismatch("x".into()),
            "IDENTITY_MISMATCH",
        ),
        (
            MlsError::KeystoreKeyUnavailable("x".into()),
            "KEYSTORE_KEY_UNAVAILABLE",
        ),
    ] {
        assert_eq!(err.state_load_code(), Some(code), "{err:?}");
        // The message is the DETAIL alone: the code is the field, and the frontend's typed error
        // leads with it - carried in both, it was printed twice (`STATE_ALTERED: STATE_ALTERED: x`).
        assert_eq!(
            StateLoadRefusal::from(err),
            StateLoadRefusal {
                code: Some(code),
                message: "x".to_string()
            }
        );
    }
    // A message that NAMES a code is not one.
    let prose = MlsError::OpenMls("STATE_ALTERED: in a sentence".into());
    assert_eq!(prose.state_load_code(), None);
    assert_eq!(StateLoadRefusal::from(prose).code, None);
    // The empty keystore is told apart by its CODE, never by text that names it.
    assert!(
        StateLoadRefusal::from(MlsError::KeystoreKeyUnavailable("x".into()))
            .is_keystore_key_unavailable()
    );
    assert!(
        !StateLoadRefusal::from(MlsError::StateAltered("x".into())).is_keystore_key_unavailable()
    );
    assert!(
        !StateLoadRefusal::from("KEYSTORE_KEY_UNAVAILABLE: a String".to_string())
            .is_keystore_key_unavailable()
    );
    // The old-PIN state too: by its CODE, never by text naming it.
    assert!(
        StateLoadRefusal::from(MlsError::StateSealedUnderAnotherKey("x".into()))
            .is_sealed_under_another_key()
    );
    assert!(
        !StateLoadRefusal::from(MlsError::StateAltered("x".into())).is_sealed_under_another_key()
    );
    assert!(
        !StateLoadRefusal::from("STATE_KEY_MISMATCH: a String".to_string())
            .is_sealed_under_another_key()
    );
    // An untyped refusal keeps its whole `Display`: it has no code field to lead its log line.
    let untyped = MlsError::OpenMls("a codec error".into());
    let shown = untyped.to_string();
    assert_eq!(StateLoadRefusal::from(untyped).message, shown);
    assert_eq!(
        StateLoadRefusal::from("IDENTITY_MISMATCH: a String".to_string()).code,
        None
    );
}
