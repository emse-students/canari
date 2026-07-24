use openmls_traits::OpenMlsProvider;
use zeroize::Zeroize;

use crate::MlsError;
use crate::security;
use crate::state::MlsManager;

impl MlsManager {
    // --- F. CHIFFREMENT / DÉCHIFFREMENT (Helper) ---

    /// Encrypts a plain CBOR MLS snapshot (Argon2 + ChaCha20). Usable off-thread without a live manager.
    #[allow(deprecated)]
    pub fn encrypt_state_blob(plain_state: &[u8], pin: &str) -> Result<Vec<u8>, MlsError> {
        security::encrypt_state_with_pin(pin, plain_state)
            .map_err(|s| MlsError::OpenMls(format!("encrypt_state_blob: {}", s)))
    }

    #[allow(deprecated)]
    pub fn save_encrypted(&self, pin: &str) -> Result<Vec<u8>, MlsError> {
        let plain_state = self.save_state()?;
        Self::encrypt_state_blob(&plain_state, pin)
    }

    /// Owned variant of [`save_encrypted`] that takes ownership of the PIN [`String`]
    /// and zeroizes it after encryption, preventing the PIN from lingering in memory.
    pub fn save_encrypted_owned(&self, mut pin: String) -> Result<Vec<u8>, MlsError> {
        let result = self.save_encrypted(&pin);
        pin.zeroize();
        result
    }

    #[allow(deprecated)]
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

    /// Owned variant of [`load_encrypted`] that takes ownership of the PIN [`String`]
    /// and zeroizes it after key derivation, preventing the PIN from lingering in memory.
    pub fn load_encrypted_owned(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        mut pin: String,
    ) -> Result<Self, MlsError> {
        let result = Self::load_encrypted(user_id, device_id, encrypted_blob, &pin);
        pin.zeroize();
        result
    }

    // --- Keystore-aware loading ---

    /// Load the MLS manager, trying the platform keystore first for the decryption key.
    ///
    /// If a key is found in the keystore (under alias `mls_device_key_{user_id}_{device_id}`),
    /// it is used directly — no PIN needed. The PIN is only used as a fallback when the
    /// keystore is empty (first launch, app reinstall, or desktop/web where the keystore
    /// is a no-op).
    ///
    /// When the PIN fallback path succeeds, the derived key is automatically stored in the
    /// keystore so that subsequent launches can skip the PIN.
    pub fn load_encrypted_with_keystore(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        pin: Option<String>,
        keystore: &dyn crate::keystore::DeviceKeyStore,
    ) -> Result<Self, MlsError> {
        let alias = format!("mls_device_key_{user_id}_{device_id}");

        // Path A: keystore has a key for this device — use it directly.
        if let Some(key) = keystore.retrieve_device_key(&alias) {
            return Self::load_with_key(user_id, device_id, encrypted_blob, &key);
        }

        // Path B: no keystore key — fall back to PIN.
        match pin {
            Some(pin_str) => {
                // If we have a blob, extract the salt from the header (first 16 bytes)
                // and derive+store the key for next launch.
                if let Some(ref blob) = encrypted_blob
                    && blob.len() >= 16
                {
                    let salt = &blob[..16];
                    let key = crate::security::derive_and_store_device_key(
                        pin_str, salt, &alias, keystore,
                    )
                    .map_err(MlsError::OpenMls)?;
                    // PIN has been zeroized by derive_and_store_device_key.
                    return Self::load_with_key(user_id, device_id, encrypted_blob, &key);
                }
                // No blob or blob too short — load as usual (fresh state or error).
                // PIN will be zeroized by load_encrypted_owned.
                Self::load_encrypted_owned(user_id, device_id, encrypted_blob, pin_str)
            }
            None => Err(MlsError::OpenMls(
                "No keystore key and no PIN provided".into(),
            )),
        }
    }

    /// Internal: load using a pre-derived 32-byte key (no Argon2id needed).
    ///
    /// The encrypted blob format is `[salt 16] [nonce 12 || ciphertext]`.
    /// When the key comes from the keystore, the salt is ignored — the key
    /// was already derived and stored at setup time.
    fn load_with_key(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        key: &[u8; 32],
    ) -> Result<Self, MlsError> {
        let decrypted_state = if let Some(blob) = encrypted_blob {
            if blob.len() < 16 {
                return Err(MlsError::InvalidData);
            }
            // Skip the 16-byte salt — key is pre-derived.
            let (_salt, rest) = blob.split_at(16);
            let plain = crate::security::decrypt_blob(key, rest)
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
