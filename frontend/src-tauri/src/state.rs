//! Shared application state and utility types for the Tauri backend.

use mls_core::MlsManager;
use std::sync::{Arc, Mutex};

/// Application state managed by Tauri, injected into every command.
pub(crate) struct AppState {
    pub mls_manager: Arc<Mutex<Option<MlsManager>>>,
}

/// SQLite pool dedicated to queued MLS messages (Sender Ratchet gap).
/// Separate from tauri-plugin-sql (JS side) so it stays reachable from Rust commands.
pub(crate) struct PendingDb(pub Arc<sqlx::SqlitePool>);

/// Reusable HTTP client (connection pool) for Rust-side gap fetching.
pub(crate) struct HttpClient(pub reqwest::Client);

/// Result of a batch KeyPackage generation.
#[derive(serde::Serialize)]
pub(crate) struct KeyPackageBatchResult {
    pub fallback: Vec<u8>,
    pub pool_packages: Vec<Vec<u8>>,
    pub state: Vec<u8>,
}

/// Per-message outcome for batch MLS decrypt (history catch-up).
#[derive(serde::Serialize, Clone)]
pub(crate) struct BatchDecryptItem {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Maps a single decrypt outcome to a `BatchDecryptItem`.
pub(crate) fn map_decrypt_outcome(
    result: Result<Option<Vec<u8>>, mls_core::MlsError>,
) -> BatchDecryptItem {
    match result {
        Ok(Some(data)) => BatchDecryptItem {
            ok: true,
            data: Some(data),
            error: None,
        },
        Ok(None) => BatchDecryptItem {
            ok: true,
            data: None,
            error: None,
        },
        Err(e) => {
            // SecretReuse = benign duplicate (key already consumed): ACK + drop, realtime parity. [[S5]]
            if e.decrypt_kind() == mls_core::DecryptErrorKind::SecretReuse {
                return BatchDecryptItem {
                    ok: true,
                    data: None,
                    error: None,
                };
            }
            BatchDecryptItem {
                ok: false,
                data: None,
                error: Some(e.to_string()),
            }
        }
    }
}

/// Decrypts an ordered page of ciphertexts under one manager lock (S5 native path).
pub(crate) fn decrypt_messages_batch(
    manager: &mut MlsManager,
    group_id: &str,
    messages: &[Vec<u8>],
) -> Vec<BatchDecryptItem> {
    let refs: Vec<&[u8]> = messages.iter().map(|m| m.as_slice()).collect();
    manager
        .process_incoming_messages(group_id, &refs)
        .into_iter()
        .map(map_decrypt_outcome)
        .collect()
}
