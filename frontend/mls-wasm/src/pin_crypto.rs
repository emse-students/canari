// Security Utilities (Encryption at Rest)
// Uses the same logic as MLS Core (Argon2 + ChaCha20Poly1305)

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn encrypt_with_pin(pin: &str, data: &[u8]) -> Result<Vec<u8>, JsValue> {
    // Create an owned copy of the PIN so it can be zeroized after use.
    // The original &str in WASM linear memory remains, but the Rust-side copy is cleared.
    let pin_owned = pin.to_string();
    mls_core::security::encrypt_state_with_pin_owned(pin_owned, data)
        .map_err(|e| JsValue::from_str(&e))
}

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
