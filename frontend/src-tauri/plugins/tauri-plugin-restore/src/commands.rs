use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Runtime};

#[cfg(target_os = "android")]
use crate::RestoreExt;

/// What `create_restore_credential` answers: the WebAuthn registration response, and whether the
/// key went into the cloud backup (`false` is the second path, taken when the phone cannot
/// encrypt its backup end to end - the Kotlin side logs it as the error it is).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRestoreCredential {
    pub response_json: String,
    pub cloud_backup: bool,
}

/// What `get_restore_credential` answers: the WebAuthn assertion, or `absent` when this phone
/// holds no restore key (a fresh install with nothing restored - an answer, not a failure).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundRestoreCredential {
    pub absent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_json: Option<String>,
}

/// Creates (or replaces) this install's restore key from the server's registration options.
#[command]
pub(crate) async fn create_restore_credential<R: Runtime>(
    app: AppHandle<R>,
    request_json: String,
) -> crate::Result<CreatedRestoreCredential> {
    #[cfg(target_os = "android")]
    {
        app.restore().create(request_json)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request_json);
        Err(crate::Error::Unsupported)
    }
}

/// Signs the server's assertion options with the restored key, if this phone holds one.
#[command]
pub(crate) async fn get_restore_credential<R: Runtime>(
    app: AppHandle<R>,
    request_json: String,
) -> crate::Result<FoundRestoreCredential> {
    #[cfg(target_os = "android")]
    {
        app.restore().get(request_json)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request_json);
        Err(crate::Error::Unsupported)
    }
}

/// Deletes this install's restore key (a sign-out, a session the server ended).
#[command]
pub(crate) async fn clear_restore_credential<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    #[cfg(target_os = "android")]
    {
        app.restore().clear()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(crate::Error::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shapes the Kotlin side resolves (`RestorePlugin.kt`) and the frontend reads
    // (`restoreCredentialNative.ts`): a renamed field compiles on every side and reads `undefined`
    // at runtime, so the wire names are pinned here.
    #[test]
    fn created_reads_the_kotlin_shape() {
        let v: CreatedRestoreCredential =
            serde_json::from_str(r#"{"responseJson":"{}","cloudBackup":false}"#).unwrap();
        assert_eq!(
            v,
            CreatedRestoreCredential {
                response_json: "{}".into(),
                cloud_backup: false
            }
        );
    }

    #[test]
    fn found_reads_absent_without_a_response() {
        let v: FoundRestoreCredential = serde_json::from_str(r#"{"absent":true}"#).unwrap();
        assert!(v.absent);
        assert_eq!(v.response_json, None);
        assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"absent":true}"#);
    }

    #[test]
    fn found_reads_a_response() {
        let v: FoundRestoreCredential =
            serde_json::from_str(r#"{"absent":false,"responseJson":"{\"id\":\"k\"}"}"#).unwrap();
        assert!(!v.absent);
        assert_eq!(v.response_json.as_deref(), Some(r#"{"id":"k"}"#));
    }
}
