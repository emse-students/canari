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
//! **They deliberately do not assert that "sealed under another key" and "altered" are told apart,
//! because they are not and cannot be**: an AEAD tag that fails to verify has both explanations and
//! nothing stored beside the blob says which. Separating them needs a key fingerprint in the
//! envelope's own framing, which changes the WRITE format and is therefore a two-release sequence -
//! an older build handed a header would read it as a nonce and report this very failure. See
//! `docs/wiki/backlog.md`. What these tests do assert is that the answer no longer CLAIMS one.

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
    // The Display form is what crosses both FFI boundaries - `JsValue::from_str(&e.to_string())` in
    // `mls-wasm`, `e.to_string()` in the Tauri command - so the code itself is load-bearing and not
    // decoration. `classifyStateLoadFailure` reads exactly this prefix.
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
fn no_state_at_all_is_not_a_failure() {
    // The control. A first launch has no blob, and reading "undecryptable" there would send a new
    // user into a recovery flow for a state that was never written.
    MlsManager::load_with_key(USER, DEVICE, None, &key(1))
        .map(|_| ())
        .expect("a device with no saved state must simply start");
}
