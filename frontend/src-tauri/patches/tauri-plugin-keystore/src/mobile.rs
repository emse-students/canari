use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_keystore);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Keystore<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.tauri.keystore", "KeystorePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_keystore)?;
    Ok(Keystore(handle))
}

/// Access to the keystore APIs.
pub struct Keystore<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Keystore<R> {
    pub fn store(&self, payload: StoreRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("store", payload)
            .map_err(Into::into)
    }

    pub fn retrieve(&self, payload: RetrieveRequest) -> crate::Result<RetrieveResponse> {
        self.0
            .run_mobile_plugin("retrieve", payload)
            .map_err(Into::into)
    }

    pub fn remove(&self, payload: RemoveRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("remove", payload)
            .map_err(Into::into)
    }

    /// Store a raw 32-byte key (base64-encoded) in the platform keystore.
    /// Triggers biometric authentication on mobile before writing.
    pub fn store_key_bytes(&self, payload: StoreKeyBytesRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("storeKeyBytes", payload)
            .map_err(Into::into)
    }

    /// Retrieve a raw 32-byte key by alias. Returns `None` if not found.
    /// Triggers biometric authentication on mobile before returning.
    pub fn get_key_bytes(
        &self,
        payload: GetKeyBytesRequest,
    ) -> crate::Result<GetKeyBytesResponse> {
        self.0
            .run_mobile_plugin("getKeyBytes", payload)
            .map_err(Into::into)
    }

    /// Delete a raw key by alias from the platform keystore.
    pub fn delete_key_bytes(&self, payload: DeleteKeyBytesRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("deleteKeyBytes", payload)
            .map_err(Into::into)
    }
}
