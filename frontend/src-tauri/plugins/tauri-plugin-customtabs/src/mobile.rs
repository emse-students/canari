use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

/// Registers the Kotlin plugin class. Android only - there is no iOS counterpart in this crate.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<CustomTabs<R>> {
    let handle = api.register_android_plugin("app.tauri.customtabs", "CustomTabsPlugin")?;
    Ok(CustomTabs(handle))
}

/// Access to the Custom Tabs API.
pub struct CustomTabs<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct OpenCustomTabPayload {
    url: String,
}

impl<R: Runtime> CustomTabs<R> {
    /// Opens `url` in a Chrome Custom Tab bound to the launching Activity's task, so the OS
    /// closes it automatically when the app resumes to the foreground.
    pub fn open_custom_tab(&self, url: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("openCustomTab", OpenCustomTabPayload { url })
            .map_err(Into::into)
    }
}
