use tauri::{command, ipc::Request, AppHandle, Runtime};

#[cfg(mobile)]
use crate::GalleryExt;

/// What `save_video` answers: `saved`, or `denied` when the member refused gallery access.
#[derive(serde::Serialize)]
pub struct SaveVideoAnswer {
    pub status: String,
}

/// The header carrying the file name: the body is the video itself.
const NAME_HEADER: &str = "x-gallery-name";

/// Saves the raw request body (an MP4) into the phone's gallery under the name in
/// `x-gallery-name`. The bytes go through a file in the app cache because both platforms import a
/// FILE (`MediaStore` copies a stream, `PHAssetCreationRequest` reads a URL); the copy is removed
/// whatever the outcome.
#[command]
pub(crate) async fn save_video<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> crate::Result<SaveVideoAnswer> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(crate::Error::NotRawBody);
    };
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|n| !n.is_empty() && !n.contains(['/', '\\']))
        .ok_or(crate::Error::BadName)?
        .to_string();
    log::debug!("[gallery] save_video {name}: {} bytes", bytes.len());
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let dir = app.path().app_cache_dir()?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("gallery-{name}"));
        std::fs::write(&path, bytes)?;
        let outcome = app
            .gallery()
            .save_video(path.to_string_lossy().into_owned(), name);
        // Removed on every path: a cached copy of a decrypted reel must not outlive the save.
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("[gallery] the temporary copy {} was not removed: {e}", path.display());
        }
        outcome.map(|o| SaveVideoAnswer { status: o.status })
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, bytes, name);
        Err(crate::Error::Unsupported)
    }
}

/// Opens this app's page in the system settings.
#[command]
pub(crate) async fn open_app_settings<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    log::debug!("[gallery] open_app_settings");
    #[cfg(mobile)]
    {
        app.gallery().open_app_settings()
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Err(crate::Error::Unsupported)
    }
}
