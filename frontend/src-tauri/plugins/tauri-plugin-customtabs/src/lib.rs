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
use mobile::CustomTabs;

/// Extension to access the Custom Tabs / ASWebAuthenticationSession API. Mobile only (Android
/// Chrome Custom Tabs, iOS ASWebAuthenticationSession) - there is no desktop implementation
/// (see `commands::open_custom_tab` for that platform).
#[cfg(mobile)]
pub trait CustomTabsExt<R: Runtime> {
    fn custom_tabs(&self) -> &CustomTabs<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: Manager<R>> CustomTabsExt<R> for T {
    fn custom_tabs(&self) -> &CustomTabs<R> {
        self.state::<CustomTabs<R>>().inner()
    }
}

/// Initializes the plugin. Registering it on desktop is harmless: `open_custom_tab` just
/// rejects with `Error::Unsupported` there, since the frontend already gates the call to mobile
/// (`isMobileTauriRuntime()`, see `auth.ts`) and this is the belt on top of that brace.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("customtabs")
        .invoke_handler(tauri::generate_handler![commands::open_custom_tab])
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                let custom_tabs = mobile::init(_app, _api)?;
                _app.manage(custom_tabs);
            }
            Ok(())
        })
        .build()
}
