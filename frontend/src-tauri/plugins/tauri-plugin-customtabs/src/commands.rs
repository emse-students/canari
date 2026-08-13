use tauri::{command, AppHandle, Runtime};

#[cfg(mobile)]
use crate::CustomTabsExt;

#[command]
pub(crate) async fn open_custom_tab<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> crate::Result<()> {
    #[cfg(mobile)]
    {
        app.custom_tabs().open_custom_tab(url)
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, url);
        Err(crate::Error::Unsupported)
    }
}
