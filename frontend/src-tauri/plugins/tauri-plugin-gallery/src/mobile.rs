use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::commands::{DocumentWritten, PublishAnswer, ShareTarget};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_gallery);

/// Registers the platform class: Kotlin `GalleryPlugin` (MediaStore, sharing shortcuts) on Android,
/// Swift `GalleryPlugin` (PHPhotoLibrary, `INSendMessageIntent` donations) on iOS.
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
    mime: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareTextPayload {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareFilePayload {
    path: String,
    mime: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteDocumentPayload {
    path: String,
    uri: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishShareTargetsPayload {
    targets: Vec<ShareTarget>,
}

/// How many suggestions were removed (`clear_share_targets`).
#[derive(Serialize, Deserialize)]
pub struct ClearOutcome {
    pub removed: u32,
}

/// What the platform answered: `saved`, or `denied` when the member refused the gallery access iOS
/// asks for. Android needs no permission to ADD to the gallery (API 29+, and `WRITE_EXTERNAL_STORAGE`
/// on 28), so it never answers `denied`.
#[derive(Serialize, Deserialize)]
pub struct SaveOutcome {
    pub status: String,
}

impl<R: Runtime> Gallery<R> {
    pub fn save_video(
        &self,
        path: String,
        name: String,
        mime: String,
    ) -> crate::Result<SaveOutcome> {
        self.0
            .run_mobile_plugin("saveVideo", SaveVideoPayload { path, name, mime })
            .map_err(Into::into)
    }

    pub fn share_text(&self, text: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("shareText", ShareTextPayload { text })
            .map_err(Into::into)
    }

    pub fn share_file(&self, path: String, mime: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("shareFile", ShareFilePayload { path, mime })
            .map_err(Into::into)
    }

    /// Android only: copies the file at `path` into the document `uri` through the provider's own
    /// stream (`write_staged_document`).
    pub fn write_document(&self, path: String, uri: String) -> crate::Result<DocumentWritten> {
        self.0
            .run_mobile_plugin("writeDocument", WriteDocumentPayload { path, uri })
            .map_err(Into::into)
    }

    pub fn publish_share_targets(&self, targets: Vec<ShareTarget>) -> crate::Result<PublishAnswer> {
        self.0
            .run_mobile_plugin(
                "publishShareTargets",
                PublishShareTargetsPayload { targets },
            )
            .map_err(Into::into)
    }

    pub fn clear_share_targets(&self) -> crate::Result<ClearOutcome> {
        self.0
            .run_mobile_plugin("clearShareTargets", ())
            .map_err(Into::into)
    }

    pub fn clear_conversation_shortcuts(&self) -> crate::Result<ClearOutcome> {
        self.0
            .run_mobile_plugin("clearConversationShortcuts", ())
            .map_err(Into::into)
    }

    pub fn open_app_settings(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("openAppSettings", ())
            .map_err(Into::into)
    }
}
