//! The phone's own gallery, for CanaReels (decision C6): a member saves their reel before the
//! server deletes it, and the camera's "denied" state opens the app's settings page it names.
//!
//! Two commands. `save_video` takes the decrypted video as the RAW IPC body - tens of megabytes,
//! which a JSON argument would inflate by a third and copy twice - writes it to the app cache, hands
//! that file to the platform (`MediaStore` in `Movies/Canari` on Android, `PHPhotoLibrary` in add-only
//! mode on iOS) and removes the copy. `open_app_settings` opens this app's page in the system
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

/// Initializes the plugin. Registered on desktop too, where both commands reject with
/// `Error::Unsupported`: the frontend reaches them only on a phone (`isMobileTauriRuntime()`).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gallery")
        .invoke_handler(tauri::generate_handler![
            commands::save_video,
            commands::open_app_settings
        ])
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                let gallery = mobile::init(_app, _api)?;
                _app.manage(gallery);
            }
            Ok(())
        })
        .build()
}
