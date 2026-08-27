pub mod security;

pub(crate) mod byte_compat;
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

// --- Error handling ---

#[derive(Error, Debug)]
pub enum MlsError {
    #[error("Crypto/OpenMLS error: {0}")]
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
    /// This device is no longer a member: a Remove commit naming its leaf was applied, so the
    /// group is inactive and NOTHING it holds can be sent again. Distinct from every other send
    /// failure because it is PERMANENT and it is not a fault - the group is intact, we are simply
    /// not in it. A caller that reads this as a transient error retries forever against a peer
    /// group that will refuse every attempt (WP-EVICT-1).
    ///
    /// Reaching this on the SEND path is itself a defect: the Remove commit named us when it was
    /// applied, and `is_group_active` reports it from that moment. This variant is the accusing
    /// backstop for a device that never received the commit at all.
    #[error("EVICTED: {0}")]
    Evicted(String),
}

/// Classification of an incoming decryption error. THE single source of native string-matching on
/// OpenMLS errors (Rust mirror of `classifyIncomingDecryptError` on the TS side), so
/// `recevoir_message_bytes` and `map_decrypt_outcome` in `src-tauri` cannot diverge. [[S5]]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptErrorKind {
    /// Ratchet key already consumed. It will never decrypt, so it is always ACKed and never
    /// requeued - but it is NOT necessarily a duplicate: a sender whose ratchet rewound encrypts a
    /// NEW message at a consumed generation. Only the frame's bytes tell the two apart, which is
    /// why this reaches the frontend as an error rather than as "nothing to show".
    SecretReuse,
    /// OpenMLS error on the same epoch: Sender Ratchet gap (future generation) -> queue/retry.
    SenderRatchetGap,
    /// `TooDistantInTheFuture`: the generation is further ahead than OpenMLS will derive forward
    /// (`maximum_forward_distance`), because this device missed a long run of that sender's frames.
    /// Like `SecretReuse` it will NEVER decrypt - queueing it for retry only accumulates dead rows -
    /// but the cause is the opposite end of the ratchet, and only a new epoch clears it.
    GenerationTooFarAhead,
    /// An APPLICATION frame from an epoch older than ours, whose epoch secrets we no longer hold
    /// (`max_past_epochs` is 2, so this is not simply a frame overtaken by a commit - it is a
    /// re-joined group, which starts with no past epochs). Like `SecretReuse` the plaintext is gone
    /// for good and retrying is dead weight, and like it the frame is a REAL MESSAGE rather than
    /// nothing to show - only a member re-sending it at the current epoch recovers it.
    PastEpochApplication,
    /// A frame THIS device sent, re-offered by a history replay of its own mailbox. There is no
    /// plaintext to recover and nothing was lost - the sender's optimistic render already wrote it
    /// (WP-ECHO-1) - so it is ACKed and, unlike `SenderRatchetGap`, never queued: it can never
    /// decrypt, and the queue is for frames a later attempt can still read.
    OwnMessage,
    /// A frame for a group this device has been REMOVED from. Not a failure of any kind: the
    /// Remove commit retired our leaf, and the frame was in flight or routed by a registry the
    /// removal has not finished cleaning. ACKed and dropped - and, unlike every other kind here,
    /// it must NOT trigger recovery: asking to be re-added is asking the server to undo a
    /// moderation action, and the request that follows can only be refused.
    Evicted,
    /// A frame refused at EXACTLY the epoch it names: the residue of the decrypt path, once the
    /// ratchet kinds above have taken what they recognise. Permanent in the strongest sense
    /// available to this layer, and provably so rather than by observation - the epoch pair is
    /// compared before `process_message` is ever called, an epoch's tree never changes afterwards,
    /// and the past-epoch secrets a later attempt would use are the same ones. So the same bytes
    /// are refused identically for ever: never queue it, always ACK it. What recovers the
    /// plaintext, when there is one, is a member re-sending it - never the server handing the
    /// same bytes back.
    SameEpochRefusal,
    /// Unrecoverable MLS state (corruption/inconsistency): the frontend must re-bootstrap.
    Unrecoverable,
    /// Unclassified.
    Other,
}

impl MlsError {
    /// Classifies an incoming decryption error from its variant / its OpenMLS message.
    /// Centralizes the substring matching previously duplicated in `src-tauri`. [[S5]]
    pub fn decrypt_kind(&self) -> DecryptErrorKind {
        match self {
            MlsError::Unrecoverable(_) => DecryptErrorKind::Unrecoverable,
            MlsError::Evicted(_) => DecryptErrorKind::Evicted,
            MlsError::OpenMls(s) if s.contains("SecretReuseError") => DecryptErrorKind::SecretReuse,
            // Before the generic `Process error:` arm: a too-far-ahead generation IS a process
            // error, and reading it as a retryable ratchet gap is what queued a frame that could
            // never decrypt (WP-PENDING-2).
            MlsError::OpenMls(s) if s.contains("TooDistantInTheFuture") => {
                DecryptErrorKind::GenerationTooFarAhead
            }
            // Also before the generic `Process error:` arm, and for the same reason: a past-epoch
            // application frame IS a process error, and reading it as a retryable ratchet gap
            // queues a frame whose epoch secrets are gone - it can never decrypt, however often
            // it is retried.
            MlsError::OpenMls(s) if s.contains("past epoch application frame") => {
                DecryptErrorKind::PastEpochApplication
            }
            // Before the generic `Process error:` arm, and this one is why the rule above is a rule
            // rather than a habit: our own frame IS a process error, and without an arm here it read
            // as a retryable ratchet gap - so native queued a frame it had itself encrypted, then
            // retried it three times before the sweeper removed it. Nothing was lost, but nothing
            // could ever be gained either.
            MlsError::OpenMls(s) if s.contains("CannotDecryptOwnMessage") => {
                DecryptErrorKind::OwnMessage
            }
            // THE LAST SPECIFIC ARM, and the only one whose ORDER is load-bearing rather than
            // merely tidy: `mls-core` emits this marker from the SAME return as
            // `TooDistantInTheFuture` and `SecretReuseError`, so one frame carries two markers and
            // the specific one has to win. It asserts only that the frame's epoch and the group's
            // epoch matched - which is exactly what makes it permanent, and what the generic arm
            // below gets wrong: that one queues the frame in SQLite to be retried against a state
            // that cannot change.
            MlsError::OpenMls(s) if s.contains("same-epoch refusal") => {
                DecryptErrorKind::SameEpochRefusal
            }
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
