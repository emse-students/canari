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

/// The code every MLS command answers when no manager is installed - never initialised in this
/// process, or ended by [`crate::concurrency::end_native_session`] (a sign-out, an account switch, a
/// failed `initialiser_mls`, a state sweep).
///
/// **IT IS THE CONTRACT THAT CROSSES THE TAURI BOUNDARY, NOT THE SENTENCE AFTER IT.** A command's error
/// is a string on the bridge, so the TypeScript side reads this code (`isMlsManagerAbsent`) the way it
/// reads `KEYSTORE_KEY_UNAVAILABLE`, and never the prose. A command waiting on the manager mutex while a
/// teardown holds it receives this once the teardown releases it - it never acts on the previous
/// account's manager and never waits for a new one.
pub(crate) const MLS_MANAGER_ABSENT: &str = "MLS_MANAGER_ABSENT";

/// The error string of [`MLS_MANAGER_ABSENT`], built in one place so every command says it the same way.
pub(crate) fn manager_absent_error() -> String {
    format!("{MLS_MANAGER_ABSENT}: no MLS session is installed in this process")
}

/// The installed manager, or the [`MLS_MANAGER_ABSENT`] refusal. Read access.
pub(crate) fn live_manager(slot: &Option<MlsManager>) -> Result<&MlsManager, String> {
    slot.as_ref().ok_or_else(manager_absent_error)
}

/// The installed manager, or the [`MLS_MANAGER_ABSENT`] refusal. Write access.
pub(crate) fn live_manager_mut(slot: &mut Option<MlsManager>) -> Result<&mut MlsManager, String> {
    slot.as_mut().ok_or_else(manager_absent_error)
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

/// An authored frame as `envoyer_message_bytes` hands it to TypeScript:
/// `{ ciphertext: number[], authorProof: number[] }` (`mls_core::authorship`), inside the
/// `sealed` outcome of `Scellement`.
#[derive(Debug, PartialEq, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthoredFramePayload {
    pub ciphertext: Vec<u8>,
    pub author_proof: Vec<u8>,
}

impl From<mls_core::authorship::AuthoredFrame> for AuthoredFramePayload {
    fn from(f: mls_core::authorship::AuthoredFrame) -> Self {
        Self {
            ciphertext: f.ciphertext,
            author_proof: f.author_proof,
        }
    }
}

/// One fork finding as `prendre_constats_fork` hands it to TypeScript
/// (`{ kind, groupId, epoch, peer, detail }`, `mls_core::fork_check`).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForkFindingPayload {
    pub kind: &'static str,
    pub group_id: String,
    pub epoch: f64,
    pub peer: String,
    pub detail: String,
}

impl From<mls_core::fork_check::ForkFinding> for ForkFindingPayload {
    fn from(f: mls_core::fork_check::ForkFinding) -> Self {
        Self {
            kind: f.kind.code(),
            group_id: f.group_id,
            epoch: f.epoch as f64,
            peer: f.peer,
            detail: f.detail,
        }
    }
}

/// One decrypted application message as the foreground decrypt hands it to TypeScript:
/// `{ data: number[], sender: string | null, author: 'unsigned' | 'verified' | 'refused' }`.
/// `sender` is the identity OpenMLS verified the frame against (`userId:deviceId`), the one sender
/// a client may believe (channel-encryption section 21); `author` is the author-proof verdict, and
/// a proof stays at the end of `data` only when it is `verified`.
#[derive(serde::Serialize, Clone)]
pub(crate) struct DecryptedFrame {
    pub data: Vec<u8>,
    pub sender: Option<String>,
    pub author: &'static str,
}

impl From<mls_core::IncomingApplication> for DecryptedFrame {
    fn from(app: mls_core::IncomingApplication) -> Self {
        Self {
            data: app.plaintext,
            sender: app.sender_identity,
            author: app.author.code(),
        }
    }
}

/// Per-message outcome for batch MLS decrypt (history catch-up).
#[derive(serde::Serialize, Clone)]
pub(crate) struct BatchDecryptItem {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    /// The sender OpenMLS verified the frame against (`userId:deviceId`), beside `data` and
    /// only with it - the one sender a client may believe (channel-encryption section 21).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    /// The author-proof verdict (`unsigned`, `verified`, `refused`), beside `data` and only with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Maps a single decrypt outcome to a `BatchDecryptItem`.
pub(crate) fn map_decrypt_outcome(
    result: Result<Option<mls_core::IncomingApplication>, mls_core::MlsError>,
) -> BatchDecryptItem {
    match result {
        Ok(Some(app)) => BatchDecryptItem {
            ok: true,
            data: Some(app.plaintext),
            sender: app.sender_identity,
            author: Some(app.author.code()),
            error: None,
        },
        Ok(None) => BatchDecryptItem {
            ok: true,
            data: None,
            sender: None,
            author: None,
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
            sender: None,
            author: None,
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
