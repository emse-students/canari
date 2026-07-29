use serde::{Deserialize, Serialize};

/// Request to store a raw 32-byte key in the platform keystore.
/// `key_bytes` is base64-encoded.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreKeyBytesRequest {
    pub alias: String,
    pub key_bytes: String,
}

/// Localized text for the system biometric sheet raised by [`GetKeyBytesRequest`].
///
/// The plugin has no locale of its own - it runs in a native process that never sees the app's
/// Paraglide catalogue - so every string is supplied by the caller. Each field is optional and the
/// native side falls back to its own French literal: a missing translation must degrade to the
/// previous wording, never to a failed unlock.
///
/// Platform split: Android's `BiometricPrompt` shows `title`, `subtitle` and `cancel_title`; iOS
/// shows `reason` (`LAContext.localizedReason`) and `cancel_title`
/// (`localizedCancelTitle`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricPromptText {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub cancel_title: Option<String>,
    pub reason: Option<String>,
}

/// Request to retrieve a raw 32-byte key from the platform keystore.
///
/// Reading the key raises a biometric sheet, so the request carries the text for it.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetKeyBytesRequest {
    pub alias: String,
    /// Flattened onto the wire, so the native side reads `title`/`subtitle`/`cancelTitle`/`reason`
    /// as plain siblings of `alias` - one less nesting level to keep in step across four languages.
    #[serde(flatten)]
    pub prompt: BiometricPromptText,
}

/// Response from retrieving a raw key. `key_bytes` is base64-encoded,
/// or `None` if no key was found for the alias.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetKeyBytesResponse {
    pub key_bytes: Option<String>,
}

/// Request to delete a raw key from the platform keystore.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteKeyBytesRequest {
    pub alias: String,
}

/// Request asking whether a raw key exists for an alias.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HasKeyBytesRequest {
    pub alias: String,
}

/// Response of the existence check. `present` is false when the alias holds nothing.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HasKeyBytesResponse {
    pub present: bool,
}
