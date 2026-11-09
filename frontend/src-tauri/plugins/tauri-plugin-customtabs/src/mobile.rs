use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::OpenCustomTabResponse;

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
    /// Opens `url` in a Chrome Custom Tab (Android) or an ASWebAuthenticationSession (iOS) and
    /// answers how it ended ([`crate::CustomTabOutcome`]).
    ///
    /// ASYNC ON PURPOSE: on iOS the answer comes when the sheet goes away - a sign-in can hold it
    /// for minutes - and the blocking `run_mobile_plugin` would pin a runtime worker that long.
    pub async fn open_custom_tab(&self, url: String) -> crate::Result<OpenCustomTabResponse> {
        self.0
            .run_mobile_plugin_async("openCustomTab", OpenCustomTabPayload { url })
            .await
            .map_err(Into::into)
    }
}
