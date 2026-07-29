use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::KeystoreExt;

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

#[command]
pub(crate) async fn has_key_bytes<R: Runtime>(
    app: AppHandle<R>,
    payload: HasKeyBytesRequest,
) -> crate::Result<HasKeyBytesResponse> {
    app.keystore().has_key_bytes(payload)
}
