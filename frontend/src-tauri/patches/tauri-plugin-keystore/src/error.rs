use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
  #[error(transparent)]
  Io(#[from] std::io::Error),
  #[cfg(mobile)]
  #[error(transparent)]
  PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
  #[cfg(desktop)]
  #[error(transparent)]
  Keyring(#[from] keyring::Error),
}

impl Error {
  /// The code a mobile plugin rejected the call with (`invoke.reject(message, code)`), if any: the
  /// one way a caller branches on WHY a call was refused without reading its message.
  pub fn rejection_code(&self) -> Option<&str> {
    match self {
      #[cfg(mobile)]
      Error::PluginInvoke(tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r)) => {
        r.code.as_deref()
      }
      _ => None,
    }
  }
}

impl Serialize for Error {
  fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
  where
    S: Serializer,
  {
    serializer.serialize_str(self.to_string().as_ref())
  }
}
