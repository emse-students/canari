use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_customtabs);

/// Registers the platform plugin class: Kotlin `CustomTabsPlugin` (Chrome Custom Tabs) on
/// Android, Swift `CustomTabsPlugin` (`ASWebAuthenticationSession`) on iOS.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<CustomTabs<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.tauri.customtabs", "CustomTabsPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_customtabs)?;
    Ok(CustomTabs(handle))
}

/// Access to the Custom Tabs / ASWebAuthenticationSession API.
pub struct CustomTabs<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct OpenCustomTabPayload {
    url: String,
}

impl<R: Runtime> CustomTabs<R> {
    /// Opens `url` in a Chrome Custom Tab (Android) or an ASWebAuthenticationSession (iOS).
    /// Both close automatically once the OIDC deep-link callback brings the app back to the
    /// foreground - the OS does it for the Custom Tab, the plugin re-dispatches the callback
    /// URL through the app's own URL scheme for the session (see the Swift implementation).
    pub fn open_custom_tab(&self, url: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("openCustomTab", OpenCustomTabPayload { url })
            .map_err(Into::into)
    }
}
