// Security Utilities (Encryption at Rest)
// Uses the same logic as MLS Core (ChaCha20Poly1305, key-based).
//
// New API: encrypt_with_key / decrypt_with_key — receive a base64-encoded 32-byte
// key directly (no Argon2id derivation). The caller is responsible for providing
// the correct key (derived once from the PIN at first login via Argon2id, then
// stored as deviceKeyB64).
//
// Legacy API: encrypt_with_pin / decrypt_with_pin — kept for backward compatibility
// with existing backup files that use the Argon2id + salt format.

use wasm_bindgen::prelude::*;

/// Encrypts `data` with a base64-encoded 32-byte key (ChaCha20-Poly1305 direct, no Argon2id).
/// Wire format: `[nonce (12) || ciphertext]` — no salt prefix.
#[wasm_bindgen]
pub fn encrypt_with_key(key_b64: &str, data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let key =
        mls_core::crypto::decode_base64_to_32_bytes(key_b64).map_err(|e| JsValue::from_str(&e))?;
    mls_core::security::encrypt_blob(&key, data).map_err(|e| JsValue::from_str(&e))
}

/// Decrypts `encrypted_data` (produced by `encrypt_with_key`) with a base64-encoded
/// 32-byte key. Wire format: `[nonce (12) || ciphertext]` — no salt prefix.
#[wasm_bindgen]
pub fn decrypt_with_key(key_b64: &str, encrypted_data: &[u8]) -> Result<Vec<u8>, JsValue> {
    if encrypted_data.len() < 12 {
        return Err(JsValue::from_str("Invalid encrypted data length"));
    }

    let key =
        mls_core::crypto::decode_base64_to_32_bytes(key_b64).map_err(|e| JsValue::from_str(&e))?;

    mls_core::security::decrypt_blob(&key, encrypted_data).map_err(|e| JsValue::from_str(&e))
}

// ── Legacy API (Argon2id + salt, kept for backward compatibility) ──────────────

/// @deprecated Use `encrypt_with_key` instead.
#[wasm_bindgen]
pub fn encrypt_with_pin(pin: &str, data: &[u8]) -> Result<Vec<u8>, JsValue> {
    // Create an owned copy of the PIN so it can be zeroized after use.
    // The original &str in WASM linear memory remains, but the Rust-side copy is cleared.
    let pin_owned = pin.to_string();
    // Still uses the old salt-prefix format for backward compatibility.
    // generate_salt + encrypt_state_with_pin logic inline:
    let salt = mls_core::security::generate_salt();
    let key = mls_core::security::derive_key_from_pin_owned(pin_owned, &salt)
        .map_err(|e| JsValue::from_str(&e))?;
    let ct = mls_core::security::encrypt_blob(&key, data).map_err(|e| JsValue::from_str(&e))?;
    // Legacy format: [salt (16) || nonce (12) || ciphertext]
    let mut result = Vec::with_capacity(16 + ct.len());
    result.extend_from_slice(&salt);
    result.extend_from_slice(&ct);
    Ok(result)
}

/// @deprecated Use `decrypt_with_key` instead.
#[wasm_bindgen]
pub fn decrypt_with_pin(pin: &str, encrypted_data: &[u8]) -> Result<Vec<u8>, JsValue> {
    if encrypted_data.len() < 16 + 12 {
        return Err(JsValue::from_str("Invalid encrypted data length"));
    }

    let (salt, rest) = encrypted_data.split_at(16);

    // Create an owned copy of the PIN so it can be zeroized after use.
    let pin_owned = pin.to_string();
    let key = mls_core::security::derive_key_from_pin_owned(pin_owned, salt)
        .map_err(|e| JsValue::from_str(&e))?;

    let plaintext =
        mls_core::security::decrypt_blob(&key, rest).map_err(|e| JsValue::from_str(&e))?;

    Ok(plaintext)
}
