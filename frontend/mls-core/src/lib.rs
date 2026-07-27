pub mod security;

pub mod crypto;
pub mod group;
pub mod keystore;
pub mod members;
pub mod messaging;
pub mod state;
pub mod welcome;

// Re-export MlsManager at crate root so that `mls_core::MlsManager` continues to work.
pub use state::MlsManager;
pub use state::PersistedState;

// Re-export keystore types for convenience.
pub use keystore::DeviceKeyStore;
pub use keystore::NoopDeviceKeyStore;

use thiserror::Error;

/// Maximum size for incoming MLS messages (1 MiB).
pub const MAX_MLS_MESSAGE_BYTES: usize = 1_048_576;

// --- GESTION DES ERREURS PROPRE ---

#[derive(Error, Debug)]
pub enum MlsError {
    #[error("Erreur Crypto/OpenMLS: {0}")]
    OpenMls(String),
    #[error("CBOR serialization error: {0}")]
    Serialization(String),
    #[error("Group not found: {0}")]
    GroupNotFound(String),
    #[error("Invalid data")]
    InvalidData,
    /// Unrecoverable MLS state: storage corruption, inconsistent state, or
    /// persistent failure after several recovery attempts.
    /// The frontend must trigger a full re-bootstrap of the group.
    #[error("UNRECOVERABLE: {0}")]
    Unrecoverable(String),
    /// All KeyPackages passed to `add_members_bulk` match identities already present in the
    /// group tree ("ghost" member: added locally during a previous attempt whose Welcome
    /// delivery failed). Distinct from validation errors to let the frontend trigger
    /// self-repair (remove then re-add) rather than surfacing a raw error to the user.
    #[error("ALREADY_MEMBER: {0}")]
    AlreadyMember(String),
}

/// Classification d'une erreur de dechiffrement entrant. Source UNIQUE du string-matching natif
/// des erreurs OpenMLS (miroir Rust de `classifyIncomingDecryptError` cote TS), pour eviter la
/// divergence entre `recevoir_message_bytes` et `map_decrypt_outcome` cote `src-tauri`. [[S5]]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptErrorKind {
    /// Cle de ratchet deja consommee (doublon benin) : ACK + drop, ne dechiffrera jamais.
    SecretReuse,
    /// Erreur OpenMLS sur le meme epoch : gap du Sender Ratchet (generation future) -> file/retry.
    SenderRatchetGap,
    /// Etat MLS irrecuperable (corruption/inconsistance) : le frontend doit re-bootstrapper.
    Unrecoverable,
    /// Non classe.
    Other,
}

impl MlsError {
    /// Classe une erreur de dechiffrement entrant a partir de sa variante / de son message OpenMLS.
    /// Centralise ici le matching de sous-chaines auparavant duplique cote `src-tauri`. [[S5]]
    pub fn decrypt_kind(&self) -> DecryptErrorKind {
        match self {
            MlsError::Unrecoverable(_) => DecryptErrorKind::Unrecoverable,
            MlsError::OpenMls(s) if s.contains("SecretReuseError") => DecryptErrorKind::SecretReuse,
            MlsError::OpenMls(s) if s.contains("Process error:") => {
                DecryptErrorKind::SenderRatchetGap
            }
            _ => DecryptErrorKind::Other,
        }
    }
}

/// Result of `add_members_bulk` (stage-only, C7-A unified):
/// `(commit, welcome, added_indices, skipped_indices)`.
///
/// The commit is *staged* (not merged): the caller validates it server-side THEN calls
/// `merge_pending_commit_for` (accepted) or `clear_pending_commit_for` (rejected), so a rejected
/// ADD never leaves the local epoch ahead (no fork). The ratchet tree is exported separately by
/// `export_ratchet_tree_for` AFTER the merge (it requires the post-commit epoch N+1 state the new
/// member joins).
///
/// - `added_indices` gives, in order, the positions (within the input slice `key_packages_bytes`)
///   of the KeyPackages actually included in the commit.
/// - `skipped_indices` gives the positions of KeyPackages that are **invalid or unreadable**
///   (expired, wrong ciphersuite, private key lost on the peer, corrupted bytes). These are
///   potentially recoverable losses (republish a fresh KeyPackage) that the caller must surface
///   instead of letting them disappear silently. [[C5]]
///   Positions matching an **already-present** member are NOT counted here: that is intentional
///   deduplication (the device is already - or ghosted - in the tree), reported globally via
///   `MlsError::AlreadyMember` when nothing else was added.
pub type AddMembersBulkResult = (Vec<u8>, Option<Vec<u8>>, Vec<u32>, Vec<u32>);

/// Result of `add_member`: `(commit, welcome)`. Staged like [`AddMembersBulkResult`].
pub type AddMemberResult = (Vec<u8>, Option<Vec<u8>>);
