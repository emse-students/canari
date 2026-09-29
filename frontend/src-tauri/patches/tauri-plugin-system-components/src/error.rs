use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// The command exists but has no implementation on this platform.
    /// The JS API documents this rejection as the platform-detection
    /// contract: tab-bar commands reject on desktop, window-glass
    /// commands reject on iOS.
    #[error("unsupported on this platform: {0}")]
    Unsupported(&'static str),
    #[error("{0}")]
    WindowHandle(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
