use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRequest {
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveRequest {
    pub service: String,
    pub user: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveResponse {
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRequest {
    pub service: String,
    pub user: String,
}

// --- Key-bytes (binary key storage for MLS device key) ---

/// Request to store a raw 32-byte key in the platform keystore.
/// `key_bytes` is base64-encoded.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreKeyBytesRequest {
    pub alias: String,
    pub key_bytes: String,
}

/// Request to retrieve a raw 32-byte key from the platform keystore.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetKeyBytesRequest {
    pub alias: String,
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
