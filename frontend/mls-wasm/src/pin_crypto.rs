// Security Utilities (Encryption at Rest)
// Uses the same logic as MLS Core (Argon2 + ChaCha20Poly1305)

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn encrypt_with_pin(pin: &str, data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let key =
        mls_core::security::derive_key_from_pin(pin, &salt).map_err(|e| JsValue::from_str(&e))?;

    let nonce_ciphertext =
        mls_core::security::encrypt_blob(&key, data).map_err(|e| JsValue::from_str(&e))?;

    let mut result = Vec::new();
    result.extend_from_slice(&salt);
    result.extend_from_slice(&nonce_ciphertext);
    Ok(result)
}

#[wasm_bindgen]
pub fn decrypt_with_pin(pin: &str, encrypted_data: &[u8]) -> Result<Vec<u8>, JsValue> {
    if encrypted_data.len() < 16 + 12 {
        return Err(JsValue::from_str("Invalid encrypted data length"));
    }

    let (salt, rest) = encrypted_data.split_at(16);

    let key =
        mls_core::security::derive_key_from_pin(pin, salt).map_err(|e| JsValue::from_str(&e))?;

    let plaintext =
        mls_core::security::decrypt_blob(&key, rest).map_err(|e| JsValue::from_str(&e))?;

    Ok(plaintext)
}
