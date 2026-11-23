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

/// What `signing_origins` answers: the WebAuthn origin(s) Credential Manager names this APK by
/// (`android:apk-key-hash:<base64url SHA-256 of the signing certificate>`), so the frontend knows,
/// before it mints a key, whether the estate's accepted origins include this build.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SigningOrigins {
    pub origins: Vec<String>,
    /// The package that installed this APK (`com.android.vending` for Play), or `None` for `adb`
    /// / `pm install`: only a non-Play install may skip registration on the origins alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer: Option<String>,
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

/// Reads the origin(s) of the certificate signing this APK (see [`SigningOrigins`]).
#[command]
pub(crate) async fn signing_origins<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<SigningOrigins> {
    #[cfg(target_os = "android")]
    {
        app.restore().signing_origins()
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
    fn signing_origins_reads_the_kotlin_shape() {
        let v: SigningOrigins =
            serde_json::from_str(r#"{"origins":["android:apk-key-hash:abc"]}"#).unwrap();
        assert_eq!(v.origins, vec!["android:apk-key-hash:abc".to_string()]);
        // A sideload: Kotlin puts no `installer` key at all.
        assert_eq!(v.installer, None);
        let v: SigningOrigins =
            serde_json::from_str(r#"{"origins":[],"installer":"com.android.vending"}"#).unwrap();
        assert_eq!(v.installer.as_deref(), Some("com.android.vending"));
    }

    #[test]
    fn found_reads_a_response() {
        let v: FoundRestoreCredential =
            serde_json::from_str(r#"{"absent":false,"responseJson":"{\"id\":\"k\"}"}"#).unwrap();
        assert!(!v.absent);
        assert_eq!(v.response_json.as_deref(), Some(r#"{"id":"k"}"#));
    }
}
