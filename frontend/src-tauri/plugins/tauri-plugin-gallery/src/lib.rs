//! The phone's own gallery, for CanaReels (decision C6): a member saves their reel before the
//! server deletes it, and the camera's "denied" state opens the app's settings page it names.
//!
//! The decrypted video is STAGED into the app cache in base64 chunks (`append_video_chunk`) - on
//! Android every IPC call is JSON through `postMessage`, so neither a raw body nor one huge argument
//! is an option - then `save_video` hands that file to the platform (`MediaStore` in `Movies/Canari`
//! on Android, `PHPhotoLibrary` in add-only mode on iOS) and removes it; `discard_video` removes it
//! when the save stops before that. `open_app_settings` opens this app's page in the system
//! settings, where a refused camera, microphone or photo permission is given back.
#[cfg(mobile)]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
mod mobile;

mod commands;
mod error;

pub use error::{Error, Result};

#[cfg(mobile)]
use mobile::Gallery;

/// Access to the platform half of the plugin. Mobile only.
#[cfg(mobile)]
pub trait GalleryExt<R: Runtime> {
    fn gallery(&self) -> &Gallery<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: Manager<R>> GalleryExt<R> for T {
    fn gallery(&self) -> &Gallery<R> {
        self.state::<Gallery<R>>().inner()
    }
}

/// Initializes the plugin. Registered on desktop too, where saving and the settings page reject
/// with `Error::Unsupported`: the frontend reaches them only on a phone (`isMobileTauriRuntime()`).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gallery")
        .invoke_handler(tauri::generate_handler![
            commands::append_video_chunk,
            commands::save_video,
            commands::discard_video,
            commands::open_app_settings
        ])
        .setup(|_app, _api| {
            commands::sweep_staged(_app);
            #[cfg(mobile)]
            {
                let gallery = mobile::init(_app, _api)?;
                _app.manage(gallery);
            }
            Ok(())
        })
        .build()
}
