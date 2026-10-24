//! The restore key of WP-RESTORE-1 (docs/wiki/account-restore.md): Android's Restore Credentials
//! API, which keeps a WebAuthn key in the phone's Google backup so that the SAME app on a NEW
//! phone can prove it holds the key the old session registered.
//!
//! Android only. The platform plugin is registered on Android alone; everywhere else each command
//! answers [`Error::Unsupported`] - there is no iOS implementation, and the frontend asks only on
//! Android.

#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
mod mobile;

mod commands;
mod error;

pub use commands::{CreatedRestoreCredential, FoundRestoreCredential};
pub use error::{Error, Result};

#[cfg(target_os = "android")]
use mobile::Restore;

/// Access to the Android plugin from a command.
#[cfg(target_os = "android")]
pub trait RestoreExt<R: Runtime> {
    fn restore(&self) -> &Restore<R>;
}

#[cfg(target_os = "android")]
impl<R: Runtime, T: Manager<R>> RestoreExt<R> for T {
    fn restore(&self) -> &Restore<R> {
        self.state::<Restore<R>>().inner()
    }
}

/// Initializes the plugin. The app registers it for every mobile target; only Android gets a
/// platform half.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("restore")
        .invoke_handler(tauri::generate_handler![
            commands::create_restore_credential,
            commands::get_restore_credential,
            commands::clear_restore_credential
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let restore = mobile::init(_app, _api)?;
                _app.manage(restore);
            }
            Ok(())
        })
        .build()
}
