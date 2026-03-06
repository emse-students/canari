use argon2::{
    Argon2,
    password_hash::rand_core::{OsRng, RngCore},
};
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit},
};

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
