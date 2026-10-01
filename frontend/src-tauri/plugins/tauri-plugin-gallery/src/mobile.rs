use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_gallery);

/// Registers the platform class: Kotlin `GalleryPlugin` (MediaStore) on Android, Swift
/// `GalleryPlugin` (PHPhotoLibrary) on iOS.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Gallery<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.tauri.gallery", "GalleryPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_gallery)?;
    Ok(Gallery(handle))
}

pub struct Gallery<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveVideoPayload {
    path: String,
    name: String,
}

/// What the platform answered: `saved`, or `denied` when the member refused the gallery access iOS
/// asks for. Android needs no permission to ADD to the gallery (API 29+, and `WRITE_EXTERNAL_STORAGE`
/// on 28), so it never answers `denied`.
#[derive(Serialize, Deserialize)]
pub struct SaveOutcome {
    pub status: String,
}

impl<R: Runtime> Gallery<R> {
    pub fn save_video(&self, path: String, name: String) -> crate::Result<SaveOutcome> {
        self.0
            .run_mobile_plugin("saveVideo", SaveVideoPayload { path, name })
            .map_err(Into::into)
    }

    pub fn open_app_settings(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("openAppSettings", ())
            .map_err(Into::into)
    }
}
