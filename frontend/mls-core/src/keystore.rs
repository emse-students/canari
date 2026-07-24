//! Platform-agnostic device key storage trait.
//!
//! On desktop/web, the default implementation is a no-op (the PIN is
//! re-derived from Argon2id at each launch). On mobile (Android/iOS),
//! the `canari` crate provides a platform-specific implementation that
//! stores the key in the hardware-backed Keystore/Keychain.
//!
//! ## Security model
//!
//! - **Desktop/Web**: `NoopDeviceKeyStore` — PIN re-derived at each launch (current
//!   behavior, unchanged).
//! - **Android**: AES-256 key in `AndroidKeyStore` (TEE/StrongBox), ciphertext in
//!   SharedPreferences, biometric authentication required.
//! - **iOS**: 32-byte key in Keychain (`kSecClassGenericPassword` with
//!   `SecAccessControl.userPresence`), biometric/device-passcode authentication.
//!
//! ## Format compatibility
//!
//! The encrypted MLS blob format is versioned with a magic byte:
//!
//! ```text
//! Version 0 (PIN, current): [0x00] [salt 16] [nonce 12 || ciphertext]
//! Version 1 (Keystore):     [0x01] [nonce 12 || ciphertext]   // no salt needed
//! ```
//!
//! This allows seamless fallback: if the keystore is empty, the PIN path still works.

/// Trait for storing/retrieving the 32-byte MLS device encryption key.
///
/// Implementations must be `Send + Sync` so they can be stored in a
/// `tauri::State` / `Arc` and accessed from async command handlers.
pub trait DeviceKeyStore: Send + Sync {
    /// Store a 32-byte key under the given alias.
    ///
    /// On platforms with hardware-backed storage (Android/iOS), this
    /// triggers biometric authentication before writing.
    fn store_device_key(&self, key: &[u8; 32], alias: &str) -> Result<(), String>;

    /// Retrieve a 32-byte key by alias, or `None` if not found.
    ///
    /// On platforms with biometric protection, this triggers a biometric
    /// prompt (Face ID / fingerprint) before returning the key.
    fn retrieve_device_key(&self, alias: &str) -> Option<[u8; 32]>;

    /// Delete a key by alias.
    fn delete_device_key(&self, alias: &str) -> Result<(), String>;
}

/// No-op implementation for desktop/web platforms.
///
/// On these platforms, the PIN is always re-derived via Argon2id at each
/// launch — the keystore is not available and is not needed.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopDeviceKeyStore;

impl DeviceKeyStore for NoopDeviceKeyStore {
    fn store_device_key(&self, _key: &[u8; 32], _alias: &str) -> Result<(), String> {
        Ok(())
    }

    fn retrieve_device_key(&self, _alias: &str) -> Option<[u8; 32]> {
        None
    }

    fn delete_device_key(&self, _alias: &str) -> Result<(), String> {
        Ok(())
    }
}

/// In-memory keystore for tests — not for production use.
///
/// Stores keys in a `Vec<(String, [u8; 32])>` behind a `Mutex`.
/// Useful for unit tests that exercise the keystore integration path
/// without depending on a real platform keystore.
#[cfg(feature = "test-keystore")]
pub mod testing {
    use super::DeviceKeyStore;
    use std::sync::Mutex;

    pub struct MemoryDeviceKeyStore {
        entries: Mutex<Vec<(String, [u8; 32])>>,
    }

    impl MemoryDeviceKeyStore {
        pub fn new() -> Self {
            Self {
                entries: Mutex::new(Vec::new()),
            }
        }
    }

    impl DeviceKeyStore for MemoryDeviceKeyStore {
        fn store_device_key(&self, key: &[u8; 32], alias: &str) -> Result<(), String> {
            let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
            entries.retain(|(a, _)| a != alias);
            entries.push((alias.to_string(), *key));
            Ok(())
        }

        fn retrieve_device_key(&self, alias: &str) -> Option<[u8; 32]> {
            let entries = self.entries.lock().ok()?;
            entries.iter().find(|(a, _)| a == alias).map(|(_, k)| *k)
        }

        fn delete_device_key(&self, alias: &str) -> Result<(), String> {
            let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
            entries.retain(|(a, _)| a != alias);
            Ok(())
        }
    }
}
