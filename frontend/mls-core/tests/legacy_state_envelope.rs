//! Locks the wire layout of the pre-v0.11.0 at-rest envelope.
//!
//! Snapshots written before v0.11.0 are `[salt (16) || nonce (12) || ciphertext]` sealed with
//! Argon2id(pin, salt); v0.11.x writes `[nonce (12) || ciphertext]` sealed with the PBKDF2 device
//! key. Both the web loader (`migrateLegacyMlsStateBlob`) and the Tauri command
//! (`migrate_legacy_state_blob`) split the legacy blob at 16 bytes and re-derive the key from the
//! PIN, so a change to either half of this format silently breaks the migration and locks every
//! pre-v0.11.0 install out of its own history.

use mls_core::security::{decrypt_blob, derive_key_from_pin_owned, encrypt_blob, generate_salt};

/// Builds a blob in the legacy envelope, exactly as `encrypt_with_pin` did.
fn seal_legacy(pin: &str, plain: &[u8]) -> Vec<u8> {
    let salt = generate_salt();
    let key = derive_key_from_pin_owned(pin.to_string(), &salt).expect("legacy derivation");
    let sealed = encrypt_blob(&key, plain).expect("legacy encryption");
    let mut blob = Vec::with_capacity(16 + sealed.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&sealed);
    blob
}

#[test]
fn legacy_blob_opens_with_the_pin_and_its_embedded_salt() {
    let plain = b"cbor-mls-snapshot".to_vec();
    let blob = seal_legacy("1234", &plain);

    // The salt travels in the blob: no server round-trip is needed to open it.
    let (salt, sealed) = blob.split_at(16);
    let key = derive_key_from_pin_owned("1234".to_string(), salt).expect("re-derivation");

    assert_eq!(
        decrypt_blob(&key, sealed).expect("legacy decryption"),
        plain
    );
}

#[test]
fn legacy_blob_rejects_the_wrong_pin() {
    let blob = seal_legacy("1234", b"cbor-mls-snapshot");
    let (salt, sealed) = blob.split_at(16);
    let key = derive_key_from_pin_owned("9999".to_string(), salt).expect("re-derivation");

    // The migration relies on this failing: a blob it cannot open must fall through to the
    // old-PIN recovery path rather than be reported as migrated.
    assert!(decrypt_blob(&key, sealed).is_err());
}

#[test]
fn a_current_format_blob_is_not_mistaken_for_a_legacy_one() {
    // Sealed the v0.11.x way: no salt prefix. Reading it as legacy consumes 16 bytes of the
    // nonce, so the migration must fail rather than return garbage.
    let key = [7u8; 32];
    let blob = encrypt_blob(&key, b"cbor-mls-snapshot").expect("current encryption");
    assert!(blob.len() >= 16 + 12, "blob long enough to reach the split");

    let (salt, sealed) = blob.split_at(16);
    let legacy_key = derive_key_from_pin_owned("1234".to_string(), salt).expect("re-derivation");
    assert!(decrypt_blob(&legacy_key, sealed).is_err());
}
