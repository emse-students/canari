use tauri::{command, AppHandle, Runtime};

#[cfg(target_os = "android")]
use crate::CustomTabsExt;

#[command]
pub(crate) async fn open_custom_tab<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> crate::Result<()> {
    #[cfg(target_os = "android")]
    {
        app.custom_tabs().open_custom_tab(url)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, url);
        Err(crate::Error::Unsupported)
    }
}
