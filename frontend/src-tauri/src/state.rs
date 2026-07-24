//! Shared application state and utility types for the Tauri backend.

use mls_core::MlsManager;
use std::sync::{Arc, Mutex};

/// Application state managed by Tauri, injected into every command.
pub(crate) struct AppState {
    pub mls_manager: Arc<Mutex<Option<MlsManager>>>,
}

/// Pool SQLite dédié aux messages MLS en attente (gap du Sender Ratchet).
/// Séparé de tauri-plugin-sql (côté JS) pour rester accessible depuis les commandes Rust.
pub(crate) struct PendingDb(pub Arc<sqlx::SqlitePool>);

/// Client HTTP réutilisable (pool de connexions) pour le gap fetching côté Rust.
pub(crate) struct HttpClient(pub reqwest::Client);

/// Résultat d'une génération de KeyPackage par lot.
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
            // SecretReuse = doublon benin (cle deja consommee) : ACK + drop, parite temps-reel. [[S5]]
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
