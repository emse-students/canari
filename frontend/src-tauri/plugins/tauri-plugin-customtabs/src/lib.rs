use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
mod mobile;

mod commands;
mod error;

pub use error::{Error, Result};

#[cfg(target_os = "android")]
use mobile::CustomTabs;

/// Extension to access the Custom Tabs API. Android only - there is no desktop or iOS
/// implementation in this crate (see `commands::open_custom_tab` for the other platforms).
#[cfg(target_os = "android")]
pub trait CustomTabsExt<R: Runtime> {
    fn custom_tabs(&self) -> &CustomTabs<R>;
}

#[cfg(target_os = "android")]
impl<R: Runtime, T: Manager<R>> CustomTabsExt<R> for T {
    fn custom_tabs(&self) -> &CustomTabs<R> {
        self.state::<CustomTabs<R>>().inner()
    }
}

/// Initializes the plugin. Registering it on iOS/desktop is harmless: `open_custom_tab` just
/// rejects with `Error::Unsupported` there, since the frontend already gates the call to
/// Android (`isAndroidTauriRuntime()`, see `auth.ts`) and this is the belt on top of that brace.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("customtabs")
        .invoke_handler(tauri::generate_handler![commands::open_custom_tab])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let custom_tabs = mobile::init(_app, _api)?;
                _app.manage(custom_tabs);
            }
            Ok(())
        })
        .build()
}
