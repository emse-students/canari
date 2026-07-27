use openmls_traits::OpenMlsProvider;

use crate::MlsError;
use crate::security;
use crate::state::MlsManager;

impl MlsManager {
    // --- F. CHIFFREMENT / DÉCHIFFREMENT (Helper) ---

    /// Encrypts a plain CBOR MLS snapshot with a pre-derived 32-byte key (ChaCha20-Poly1305 direct, no Argon2id).
    /// Wire format: `[nonce (12) || ciphertext]` — no salt prefix.
    pub fn encrypt_state_blob_with_key(
        plain_state: &[u8],
        key: &[u8; 32],
    ) -> Result<Vec<u8>, MlsError> {
        security::encrypt_blob(key, plain_state)
            .map_err(|s| MlsError::OpenMls(format!("encrypt_state_blob_with_key: {}", s)))
    }

    /// Save the MLS state encrypted with a pre-derived 32-byte key (no Argon2id needed).
    ///
    /// Wire format: `[nonce (12) || ciphertext]`. No salt prefix.
    /// Used by background push handlers (Android JNI / iOS FFI) that hold the raw device
    /// key from `push_context.json` instead of the user's PIN.
    pub fn save_encrypted_with_key(&self, key: &[u8; 32]) -> Result<Vec<u8>, MlsError> {
        let plain_state = self.save_state()?;
        security::encrypt_blob(key, &plain_state)
            .map_err(|s| MlsError::OpenMls(format!("save_encrypted_with_key: {}", s)))
    }

    // --- Keystore-aware loading ---

    /// Load the MLS manager. When `device_key_b64` is provided, the key is decoded from base64
    /// and used directly for decryption (no Argon2id).
    ///
    /// When `device_key_b64` is `None` (biometric mode), the key is retrieved from the platform
    /// keystore (under alias `mls_device_key_{user_id}_{device_id}`) and used directly.
    pub fn load_encrypted_with_keystore(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        device_key_b64: Option<String>,
        keystore: &dyn crate::keystore::DeviceKeyStore,
    ) -> Result<Self, MlsError> {
        let alias = format!("mls_device_key_{user_id}_{device_id}");

        // Path B: device_key_b64 provided (C3 first login or C4/C5 with PinVault).
        // Decode the base64 key directly — no Argon2id needed.
        if let Some(key_b64) = device_key_b64 {
            let key = decode_base64_to_32_bytes(&key_b64)
                .map_err(|e| MlsError::OpenMls(format!("invalid device_key_b64: {e}")))?;
            return Self::load_with_key(user_id, device_id, encrypted_blob, &key);
        }

        // Path A (no device_key_b64 — biometric mode): retrieve key from platform keystore.
        if let Some(key) = keystore.retrieve_device_key(&alias) {
            // Quick validation: can the key actually decrypt the blob?
            // If not (PIN changed, blob re-encrypted with a new key), delete the
            // stale keystore entry so the user is prompted for the new PIN.
            let key_valid = match &encrypted_blob {
                Some(blob) if blob.len() >= 12 => crate::security::decrypt_blob(&key, blob).is_ok(),
                _ => true, // No blob yet (first launch) — key is valid by definition.
            };
            if key_valid {
                return Self::load_with_key(user_id, device_id, encrypted_blob, &key);
            }
            // Stale key — delete it.
            let _ = keystore.delete_device_key(&alias);
            log::warn!("[MLS] Keystore key failed to decrypt blob — key deleted.");
        }

        // No device_key_b64 and no keystore key — nothing we can do.
        Err(MlsError::OpenMls(
            "No keystore key and no device_key_b64 provided".into(),
        ))
    }

    /// Load using a pre-derived 32-byte key (no Argon2id needed).
    ///
    /// The encrypted blob format is `[nonce (12) || ciphertext]`.
    /// The key is used directly for ChaCha20-Poly1305 decryption.
    pub fn load_with_key(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        key: &[u8; 32],
    ) -> Result<Self, MlsError> {
        let decrypted_state = if let Some(blob) = encrypted_blob {
            if blob.len() < 12 {
                return Err(MlsError::InvalidData);
            }
            let plain = crate::security::decrypt_blob(key, &blob)
                .map_err(|s| MlsError::OpenMls(format!("Decryption: {}", s)))?;
            Some(plain)
        } else {
            None
        };

        Self::load_or_create(user_id, device_id, decrypted_state)
    }

    // --- G. EXPORT SECRET (WebRTC / Call) ---

    pub fn export_secret(
        &self,
        group_id: &str,
        label: &str,
        context: &[u8],
        key_len: usize,
    ) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        group
            .export_secret(self.provider.crypto(), label, context, key_len)
            .map_err(|e| MlsError::OpenMls(format!("Export secret error: {:?}", e)))
    }
}

/// Decodes a base64-encoded string into a 32-byte array.
/// Used to convert `deviceKeyB64` from the frontend into a raw key for ChaCha20-Poly1305.
pub fn decode_base64_to_32_bytes(b64: &str) -> Result<[u8; 32], String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "deviceKeyB64 must decode to 32 bytes, got {}",
            bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}
