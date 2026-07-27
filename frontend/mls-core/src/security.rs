use argon2::{
    Argon2,
    password_hash::rand_core::{OsRng, RngCore},
};
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit},
};
use zeroize::Zeroize;

/// Derives a 32-byte key from a PIN and salt via Argon2id (default params).
///
/// LEGACY: the device key is no longer derived here. `$lib/crypto/deviceKey` (PBKDF2-SHA256)
/// is the single source of the device key, and it is passed in as raw bytes. This function
/// survives only to read pre-v0.11.0 backup files sealed with the Argon2id + salt-prefix format.
#[deprecated(note = "Use `derive_key_from_pin_owned` to zeroize the PIN after use")]
pub fn derive_key_from_pin(pin: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut output_key = [0u8; 32];
    Argon2::default()
        .hash_password_into(pin.as_bytes(), salt, &mut output_key)
        .map_err(|e| e.to_string())?;

    Ok(output_key)
}

/// Owned variant of [`derive_key_from_pin`] that takes ownership of the PIN [`String`]
/// and zeroizes it after key derivation, preventing the PIN from lingering in memory.
#[allow(deprecated)]
pub fn derive_key_from_pin_owned(mut pin: String, salt: &[u8]) -> Result<[u8; 32], String> {
    let key = derive_key_from_pin(&pin, salt);
    pin.zeroize();
    key
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

/// Generates a random 16-byte salt for the legacy Argon2id format.
/// Only used by the pre-v0.11.0 backup path in `mls-wasm` (`encrypt_with_pin`).
pub fn generate_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    salt
}
