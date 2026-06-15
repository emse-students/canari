use argon2::{
    Argon2,
    password_hash::rand_core::{OsRng, RngCore},
};
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit},
};

/// Derives a 32-byte key from a PIN and salt via Argon2id (default params).
pub fn derive_key_from_pin(pin: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut output_key = [0u8; 32];
    Argon2::default()
        .hash_password_into(pin.as_bytes(), salt, &mut output_key)
        .map_err(|e| e.to_string())?;

    Ok(output_key)
}

pub fn encrypt_blob(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, data).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    result.extend_from_slice(nonce);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

pub fn decrypt_blob(key: &[u8; 32], encrypted_data: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted_data.len() < 12 {
        return Err("Invalid encrypted data".to_string());
    }
    let cipher = ChaCha20Poly1305::new(key.into());
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|e| e.to_string())
}

/// Encrypts a plain MLS CBOR snapshot with Argon2id + ChaCha20-Poly1305.
/// Wire format: `[salt (16)] [nonce (12) || ciphertext]`.
pub fn encrypt_state_with_pin(pin: &str, plain_state: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);

    let key = derive_key_from_pin(pin, &salt)?;
    let ciphertext = encrypt_blob(&key, plain_state)?;

    let mut result = Vec::with_capacity(salt.len() + ciphertext.len());
    result.extend_from_slice(&salt);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}
