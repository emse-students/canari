//! Shared application state and utility types for the Tauri backend.

use mls_core::MlsManager;
use std::sync::{Arc, Mutex};

/// Application state managed by Tauri, injected into every command.
pub(crate) struct AppState {
    pub mls_manager: Arc<Mutex<Option<MlsManager>>>,
    /// At-rest key of the live MLS session, resolved once by `initialiser_mls`.
    ///
    /// Biometric sessions keep the key in the platform keystore and never hand it to the JS
    /// layer, so every later `sauvegarder_*` / `generer_key_packages_*` call arrives with an
    /// empty `device_key_b64`. Caching the resolved key here is what lets those saves succeed
    /// without firing one BiometricPrompt per save.
    pub device_key: Arc<Mutex<Option<[u8; 32]>>>,
}

/// SQLite pool dedicated to queued MLS messages (Sender Ratchet gap).
/// Separate from tauri-plugin-sql (JS side) so it stays reachable from Rust commands.
pub(crate) struct PendingDb(pub Arc<sqlx::SqlitePool>);

/// Result of a batch KeyPackage generation: the two things the caller publishes, and nothing else.
///
/// IT CARRIED THE WHOLE ENCRYPTED STATE UNTIL 2026-09-16, AND NOTHING EVER READ IT. The command
/// writes the blob itself (`write_mls_state_blob`), so the copy handed back was pure transport:
/// Tauri serialises a `Vec<u8>` as a JSON array of integers, several bytes of wire per byte of
/// state, on every connection. A lived-in profile's state is 7.5 MB and the worst phone measured
/// in the 2026-09 campaign reached 19 548 753 B.
#[derive(serde::Serialize)]
pub(crate) struct KeyPackageBatchResult {
    pub fallback: DatedKeyPackagePayload,
    pub pool_packages: Vec<DatedKeyPackagePayload>,
}

/// A key package and the instant it stops being usable, on its way to the delivery service.
///
/// The expiry crosses this boundary because nothing on the far side can recover it: the server
/// stores an opaque base64 string, the frontend cannot parse an MLS KeyPackage, and a row's age is
/// not evidence for it - the last-resort package is REPUBLISHED unchanged while its row's
/// `createdAt` is reset on every re-registration. See `mls_core::DatedKeyPackage`, which carries
/// the production measurement this was written for.
///
/// `not_after_secs` is seconds since the UNIX epoch, `f64` rather than `u64` because Tauri hands a
/// `u64` to JS as a JSON number anyway and the narrower type says so honestly.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatedKeyPackagePayload {
    pub public: Vec<u8>,
    pub not_after_secs: f64,
}

impl From<mls_core::DatedKeyPackage> for DatedKeyPackagePayload {
    fn from(d: mls_core::DatedKeyPackage) -> Self {
        Self {
            public: d.public,
            not_after_secs: d.not_after as f64,
        }
    }
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
        // Every error is REPORTED, `SecretReuse` included. It used to be mapped to
        // `ok: true, data: None` here, on the argument that a consumed generation during a history
        // REPLAY is expected - which is true, and was still the wrong place to decide it. "This
        // generation is consumed" and "I already have this message" are different facts, and the
        // only evidence that separates them is the frame's own bytes against the seen-frame ledger,
        // which lives in `history.ts` and not here. A layer that cannot make a distinction must not
        // make it: this one answered the question anyway and threw the answer away, which is what
        // let a rewound sender's loss pass for a duplicate for months (WP-PENDING-2). The caller
        // still ACKs; only the diagnosis reaches it now. Mirrored in `mls-wasm`'s batch. [[S5]]
        Err(e) => BatchDecryptItem {
            ok: false,
            data: None,
            error: Some(e.to_string()),
        },
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
