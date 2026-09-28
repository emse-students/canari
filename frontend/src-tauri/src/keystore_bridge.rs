//! Rust bridge to the native keystore (Android KeyStore / iOS Keychain).
//!
//! Implements [`mls_core::keystore::DeviceKeyStore`] by delegating to the
//! Tauri keystore plugin, which in turn calls the native Kotlin/Swift
//! implementations. On desktop, the plugin falls back to the OS keyring
//! (keyring crate).

use base64::Engine;
use mls_core::keystore::DeviceKeyStore;
use tauri::Runtime;
use tauri_plugin_keystore::{BiometricPromptText, KeystoreExt};

/// Implements `DeviceKeyStore` for mobile and desktop by delegating to the
/// Tauri keystore plugin.
///
/// The `AppHandle` is stored internally so the bridge can be used from any
/// thread (it is `Send + Sync`).
pub struct PluginDeviceKeyStore<R: Runtime> {
    app: tauri::AppHandle<R>,
    /// Text for the biometric sheet that reading the key raises. Only `retrieve_device_key`
    /// prompts, so the two store-only call sites leave this empty and the native fallback applies.
    prompt: BiometricPromptText,
    /// When set, `retrieve_device_key` reads with NO biometric sheet (the "every 12h" cadence).
    unattended: bool,
}

impl<R: Runtime> PluginDeviceKeyStore<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self {
            app,
            prompt: BiometricPromptText::default(),
            unattended: false,
        }
    }

    /// Makes [`DeviceKeyStore::retrieve_device_key`] skip the biometric sheet.
    ///
    /// The frontend decides this, from the unlock cadence the user picked and the time of the last
    /// PROMPTED unlock - this process has neither. On iOS it also changes WHICH item is read: the
    /// `.userPresence` one cannot be read without a sheet, so the background copy is used instead.
    pub fn unattended(mut self, unattended: bool) -> Self {
        self.unattended = unattended;
        self
    }

    /// Attaches the localized text used by [`DeviceKeyStore::retrieve_device_key`].
    ///
    /// The frontend owns the locale, so the strings travel down with the call that needs them
    /// rather than being resolved here - nothing in this process knows which language to pick.
    pub fn with_prompt(mut self, prompt: BiometricPromptText) -> Self {
        self.prompt = prompt;
        self
    }
}

impl<R: Runtime> DeviceKeyStore for PluginDeviceKeyStore<R> {
    fn store_device_key(&self, key: &[u8; 32], alias: &str) -> Result<(), String> {
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
        self.app
            .keystore()
            .store_key_bytes(tauri_plugin_keystore::StoreKeyBytesRequest {
                alias: alias.to_string(),
                key_bytes: key_b64,
            })
            .map_err(|e| e.to_string())
    }

    fn retrieve_device_key(&self, alias: &str) -> Option<[u8; 32]> {
        let keystore = self.app.keystore();
        let read = if self.unattended {
            log::debug!("[KEYSTORE] retrieve_device_key: unattended read (no biometric sheet)");
            keystore.get_key_bytes_unattended(tauri_plugin_keystore::GetKeyBytesUnattendedRequest {
                alias: alias.to_string(),
            })
        } else {
            keystore.get_key_bytes(tauri_plugin_keystore::GetKeyBytesRequest {
                alias: alias.to_string(),
                prompt: self.prompt.clone(),
            })
        };
        let resp = read
            // Info, not warn: a user cancelling the sheet lands here too, and that is not a defect.
            .map_err(|e| {
                log::info!(
                    "[KEYSTORE] retrieve_device_key refused (unattended={}): {e}",
                    self.unattended
                )
            })
            .ok()?;

        let b64 = resp.key_bytes?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .ok()?;

        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Some(key)
        } else {
            None
        }
    }

    fn delete_device_key(&self, alias: &str) -> Result<(), String> {
        self.app
            .keystore()
            .delete_key_bytes(tauri_plugin_keystore::DeleteKeyBytesRequest {
                alias: alias.to_string(),
            })
            .map_err(|e| e.to_string())
    }
}
