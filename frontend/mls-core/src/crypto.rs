use openmls_traits::OpenMlsProvider;

use crate::MlsError;
use crate::security;
use crate::state::MlsManager;

impl MlsManager {
    // --- F. CHIFFREMENT / DÉCHIFFREMENT (Helper) ---

    /// Encrypts a plain CBOR MLS snapshot (Argon2 + ChaCha20). Usable off-thread without a live manager.
    pub fn encrypt_state_blob(plain_state: &[u8], pin: &str) -> Result<Vec<u8>, MlsError> {
        security::encrypt_state_with_pin(pin, plain_state)
            .map_err(|s| MlsError::OpenMls(format!("encrypt_state_blob: {}", s)))
    }

    pub fn save_encrypted(&self, pin: &str) -> Result<Vec<u8>, MlsError> {
        let plain_state = self.save_state()?;
        Self::encrypt_state_blob(&plain_state, pin)
    }

    pub fn load_encrypted(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        pin: &str,
    ) -> Result<Self, MlsError> {
        let decrypted_state = if let Some(blob) = encrypted_blob {
            if blob.len() < 16 {
                return Err(MlsError::InvalidData);
            }

            let (salt, rest) = blob.split_at(16);

            let key = security::derive_key_from_pin(pin, salt)
                .map_err(|s| MlsError::OpenMls(format!("Key derivation: {}", s)))?;

            let plain = security::decrypt_blob(&key, rest)
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
