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
    pub fn store(&self, payload: StoreRequest) -> crate::Result<()> {
        let entry = keyring::Entry::new("com.impierce.identity-wallet", "tester")?;
        entry.set_password(&payload.value)?;
        Ok(())
    }

    pub fn retrieve(&self, payload: RetrieveRequest) -> crate::Result<RetrieveResponse> {
        let entry = keyring::Entry::new(&payload.service, &payload.user)?;
        let password = entry.get_password()?;
        Ok(RetrieveResponse {
            value: Some(password),
        })
    }

    pub fn remove(&self, payload: RemoveRequest) -> crate::Result<()> {
        let entry = keyring::Entry::new(&payload.service, &payload.user)?;
        entry.delete_credential()?;
        Ok(())
    }

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
}
