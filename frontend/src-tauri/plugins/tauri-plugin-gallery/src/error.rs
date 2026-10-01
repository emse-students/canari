use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

/// Why a gallery call failed. A REFUSAL by the member is not here: the native side answers it as
/// a `status` (`denied`), because it is an outcome the screen draws, not a failure to report.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("the video was not sent as raw bytes")]
    NotRawBody,
    #[error("the x-gallery-name header is missing or names a path")]
    BadName,
    #[error("the temporary copy could not be written: {0}")]
    Io(#[from] std::io::Error),
    #[error("the app cache directory is unknown: {0}")]
    Path(#[from] tauri::Error),
    #[cfg(not(mobile))]
    #[error("the phone's gallery exists only on Android and iOS")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
