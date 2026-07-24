//! Bridge Rust → Keystore natif (Android KeyStore / iOS Keychain).
//!
//! Implements [`mls_core::keystore::DeviceKeyStore`] by delegating to the
//! Tauri keystore plugin, which in turn calls the native Kotlin/Swift
//! implementations. On desktop, the plugin falls back to the OS keyring
//! (keyring crate).

use base64::Engine;
use mls_core::keystore::DeviceKeyStore;
use tauri::Runtime;
use tauri_plugin_keystore::KeystoreExt;

/// Implements `DeviceKeyStore` for mobile and desktop by delegating to the
/// Tauri keystore plugin.
///
/// The `AppHandle` is stored internally so the bridge can be used from any
/// thread (it is `Send + Sync`).
pub struct PluginDeviceKeyStore<R: Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: Runtime> PluginDeviceKeyStore<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
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
        let resp = self
            .app
            .keystore()
            .get_key_bytes(tauri_plugin_keystore::GetKeyBytesRequest {
                alias: alias.to_string(),
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
