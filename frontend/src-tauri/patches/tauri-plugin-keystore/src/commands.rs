use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::KeystoreExt;

#[command]
pub(crate) async fn store<R: Runtime>(
    app: AppHandle<R>,
    payload: StoreRequest,
) -> crate::Result<()> {
    app.keystore().store(payload)
}

#[command]
pub(crate) async fn retrieve<R: Runtime>(
    app: AppHandle<R>,
    payload: RetrieveRequest,
) -> crate::Result<RetrieveResponse> {
    app.keystore().retrieve(payload)
}

#[command]
pub(crate) async fn remove<R: Runtime>(
    app: AppHandle<R>,
    payload: RemoveRequest,
) -> crate::Result<()> {
    app.keystore().remove(payload)
}

// --- Key-bytes commands (MLS device key storage) ---

#[command]
pub(crate) async fn store_key_bytes<R: Runtime>(
    app: AppHandle<R>,
    payload: StoreKeyBytesRequest,
) -> crate::Result<()> {
    app.keystore().store_key_bytes(payload)
}

#[command]
pub(crate) async fn get_key_bytes<R: Runtime>(
    app: AppHandle<R>,
    payload: GetKeyBytesRequest,
) -> crate::Result<GetKeyBytesResponse> {
    app.keystore().get_key_bytes(payload)
}

#[command]
pub(crate) async fn delete_key_bytes<R: Runtime>(
    app: AppHandle<R>,
    payload: DeleteKeyBytesRequest,
) -> crate::Result<()> {
    app.keystore().delete_key_bytes(payload)
}
