use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Keystore<R>> {
    Ok(Keystore(app.clone()))
}

/// Access to the keystore APIs.
pub struct Keystore<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Keystore<R> {
    /// Store a raw key (base64-encoded) in the OS keyring under a namespaced alias.
    pub fn store_key_bytes(&self, payload: StoreKeyBytesRequest) -> crate::Result<()> {
        let entry = keyring::Entry::new("fr.emse.canari", &format!("mls_key_{}", payload.alias))?;
        entry.set_password(&payload.key_bytes)?;
        Ok(())
    }

    /// Retrieve a raw key from the OS keyring. Returns `None` if not found.
    pub fn get_key_bytes(
        &self,
        payload: GetKeyBytesRequest,
    ) -> crate::Result<GetKeyBytesResponse> {
        let entry = keyring::Entry::new("fr.emse.canari", &format!("mls_key_{}", payload.alias))?;
        match entry.get_password() {
            Ok(key_bytes) => Ok(GetKeyBytesResponse {
                key_bytes: Some(key_bytes),
            }),
            Err(keyring::Error::NoEntry) => Ok(GetKeyBytesResponse { key_bytes: None }),
            Err(e) => Err(e.into()),
        }
    }

    /// Delete a raw key from the OS keyring. Does not error if the entry doesn't exist.
    pub fn delete_key_bytes(&self, payload: DeleteKeyBytesRequest) -> crate::Result<()> {
        let entry = keyring::Entry::new("fr.emse.canari", &format!("mls_key_{}", payload.alias))?;
        let _ = entry.delete_credential();
        Ok(())
    }

    /// Report whether a raw key exists for an alias. A missing entry is `present: false`,
    /// never an error - the caller uses this to decide whether to offer biometric unlock.
    pub fn has_key_bytes(&self, payload: HasKeyBytesRequest) -> crate::Result<HasKeyBytesResponse> {
        let entry = keyring::Entry::new("fr.emse.canari", &format!("mls_key_{}", payload.alias))?;
        match entry.get_password() {
            Ok(_) => Ok(HasKeyBytesResponse { present: true }),
            Err(keyring::Error::NoEntry) => Ok(HasKeyBytesResponse { present: false }),
            Err(e) => Err(e.into()),
        }
    }
}
