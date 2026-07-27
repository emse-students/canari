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

// --- Keystore integration ---

/// Derives a 32-byte key from a PIN and best-effort stores it in the platform
/// keystore.
///
/// The PIN is zeroized after derivation. The derived key is stored under the
/// given alias for future retrieval without PIN re-entry.
///
/// If the keystore is unavailable (no biometrics configured, user cancelled the
/// prompt, desktop/web keystore not supported, etc.), the error is logged and
/// the function still returns the derived key. The caller will need to re-enter
/// the PIN on the next launch.
pub fn derive_and_store_device_key(
    pin: String,
    salt: &[u8],
    alias: &str,
    keystore: &dyn crate::keystore::DeviceKeyStore,
) -> Result<[u8; 32], String> {
    let key = derive_key_from_pin_owned(pin, salt)?;
    // PIN has been zeroized by derive_key_from_pin_owned.
    // Best-effort store: if the keystore rejects the write (e.g. Android
    // UserNotAuthenticatedException when no biometric was performed), we
    // continue without storing — the user will need to enter their PIN again.
    if let Err(e) = keystore.store_device_key(&key, alias) {
        log::warn!(
            "Failed to store device key in keystore (non-fatal, will fall back to PIN on next launch): {e}"
        );
    }
    Ok(key)
}

/// Generates a random 16-byte salt for key derivation.
/// Used when `mls.bin` does not exist yet (first login).
pub fn generate_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    salt
}
