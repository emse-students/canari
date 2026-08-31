use argon2::Argon2;
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit},
};
use rand::{TryRng, rngs::SysRng};
use zeroize::Zeroize;

/// Fills `dst` from the operating system's random source.
///
/// The OS is the source rather than a userspace CSPRNG because every caller here produces a value
/// whose UNIQUENESS is the security property: a ChaCha20-Poly1305 nonce that must never repeat
/// under one key, and an Argon2id salt.
///
/// It is a function rather than two call sites because rand 0.10 changed both halves of the old
/// `password_hash::rand_core::OsRng` at once - the type is now `SysRng`, and drawing from it is
/// FALLIBLE where `fill_bytes` used to panic. The failure is returned rather than unwrapped: a
/// panic inside the WASM module is a dead tab with no message, and both callers already carry a
/// `Result`.
fn fill_from_os(dst: &mut [u8]) -> Result<(), String> {
    SysRng
        .try_fill_bytes(dst)
        .map_err(|e| format!("OS random source unavailable: {e}"))
}

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
    fill_from_os(&mut nonce_bytes)?;
    // `from` rather than the deprecated `from_slice`: the buffer is a fixed `[u8; 12]`, so the
    // conversion cannot fail and no error path has to be invented for it.
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher.encrypt(&nonce, data).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    result.extend_from_slice(&nonce);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

pub fn decrypt_blob(key: &[u8; 32], encrypted_data: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted_data.len() < 12 {
        return Err("Invalid encrypted data".to_string());
    }
    let cipher = ChaCha20Poly1305::new(key.into());
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(12);
    // The length check above is what makes this infallible, and `try_from` is where that stops
    // being an assumption: the guard and the conversion now agree in the type system rather than
    // by a reader noticing they match.
    let nonce = Nonce::try_from(nonce_bytes).map_err(|e| e.to_string())?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|e| e.to_string())
}

/// Generates a random 16-byte salt for the legacy Argon2id format.
/// Only used by the pre-v0.11.0 backup path in `mls-wasm` (`encrypt_with_pin`).
pub fn generate_salt() -> Result<[u8; 16], String> {
    let mut salt = [0u8; 16];
    fill_from_os(&mut salt)?;
    Ok(salt)
}
