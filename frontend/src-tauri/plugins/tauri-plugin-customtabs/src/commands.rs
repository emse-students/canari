use tauri::{command, AppHandle, Runtime};

#[cfg(mobile)]
use crate::CustomTabsExt;
use crate::OpenCustomTabResponse;

/// Presents `url` in the platform's in-app browser surface and answers once the native side knows
/// how it ended (see [`crate::CustomTabOutcome`]) - on iOS that is when the sheet goes away, which
/// can be minutes after the call.
#[command]
pub(crate) async fn open_custom_tab<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> crate::Result<OpenCustomTabResponse> {
    #[cfg(mobile)]
    {
        app.custom_tabs().open_custom_tab(url).await
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, url);
        Err(crate::Error::Unsupported)
    }
}
