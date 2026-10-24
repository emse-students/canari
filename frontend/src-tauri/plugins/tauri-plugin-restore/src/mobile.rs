use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{CreatedRestoreCredential, FoundRestoreCredential};

/// Registers the Kotlin `RestorePlugin` (androidx.credentials). Android only - see `lib.rs`.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Restore<R>> {
    let handle = api.register_android_plugin("app.tauri.restore", "RestorePlugin")?;
    Ok(Restore(handle))
}

/// Access to the Restore Credentials API.
pub struct Restore<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestPayload {
    request_json: String,
}

impl<R: Runtime> Restore<R> {
    /// `CreateRestoreCredentialRequest` with the server's registration options.
    pub fn create(&self, request_json: String) -> crate::Result<CreatedRestoreCredential> {
        self.0
            .run_mobile_plugin("createRestoreCredential", RequestPayload { request_json })
            .map_err(Into::into)
    }

    /// `GetRestoreCredentialOption` with the server's assertion options.
    pub fn get(&self, request_json: String) -> crate::Result<FoundRestoreCredential> {
        self.0
            .run_mobile_plugin("getRestoreCredential", RequestPayload { request_json })
            .map_err(Into::into)
    }

    /// `ClearCredentialStateRequest(TYPE_CLEAR_RESTORE_CREDENTIAL)`.
    pub fn clear(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("clearRestoreCredential", ())
            .map_err(Into::into)
    }
}
