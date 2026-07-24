pub mod security;

pub mod crypto;
pub mod group;
pub mod members;
pub mod messaging;
pub mod state;
pub mod welcome;

// Re-export MlsManager at crate root so that `mls_core::MlsManager` continues to work.
pub use state::MlsManager;
pub use state::PersistedState;

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

/// Resultat de `add_members_bulk` (stage-only, C7-A unified) :
/// `(commit, welcome, added_indices, skipped_indices)`.
/// Le commit est *stage* (non merge) : l'appelant le valide cote serveur PUIS appelle
/// `merge_pending_commit_for` (accepte) ou `clear_pending_commit_for` (rejete), donc un ADD
/// rejete ne laisse jamais l'epoch local en avance (aucun fork). Le ratchet tree est exporte
/// separement par `export_ratchet_tree_for` APRES le merge (il exige l'etat post-commit
/// epoch N+1 que le nouveau membre rejoint).
/// - `added_indices` donne, dans l'ordre, les positions (dans le slice d'entree
///   `key_packages_bytes`) des KeyPackages effectivement inclus dans le commit.
/// - `skipped_indices` donne les positions des KeyPackages **invalides ou illisibles**
///   (expiration, mauvaise ciphersuite, cle privee perdue chez le pair, bytes corrompus).
///   Ce sont des pertes potentiellement recuperables (republication d'un KeyPackage frais)
///   que l'appelant doit remonter au lieu de les laisser disparaitre silencieusement. [[C5]]
///   Les positions correspondant a un membre **deja present** ne sont PAS comptees ici :
///   c'est une deduplication intentionnelle (le device est deja - ou fantome - dans l'arbre),
///   signalee globalement par `MlsError::AlreadyMember` quand rien d'autre n'a ete ajoute.
pub(crate) type AddMembersBulkResult = (Vec<u8>, Option<Vec<u8>>, Vec<u32>, Vec<u32>);
pub(crate) type AddMemberResult = (Vec<u8>, Option<Vec<u8>>);
