pub mod security;
use security::{decrypt_blob, derive_key_from_pin};

use ciborium::{de::from_reader, ser::into_writer};
use openmls::prelude::*;
use openmls::treesync::RatchetTreeIn;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_traits::storage::StorageProvider; // Explicit import for write_key_package
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use thiserror::Error;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

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
type AddMembersBulkResult = (Vec<u8>, Option<Vec<u8>>, Vec<u32>, Vec<u32>);
type AddMemberResult = (Vec<u8>, Option<Vec<u8>>);

/// Sender-ratchet tolerance for incoming application messages, shared by group
/// creation and Welcome processing so both decrypt bursts identically.
///
/// OpenMLS defaults to `(out_of_order_tolerance = 5, maximum_forward_distance = 1000)`.
/// A tolerance of 5 is far too small for chat: sending a dozen messages at once, combined
/// with multi-path delivery (realtime publish + pending queue + FCM + native requeue),
/// routinely delivers generations out of order by more than 5. Once the secret tree
/// ratchets past a generation and drops its key, that message yields
/// `SecretTreeError(TooDistantInThePast)` and can NEVER be decrypted - it is then wrongly
/// queued for retry, looping forever. Keeping a wide past window (2000) lets out-of-order
/// bursts decrypt cleanly. `maximum_forward_distance` is bounded (2000) to cap the keys
/// derived when catching up after a real gap. Both values bound memory (~48 B per kept key
/// per sender per epoch, with `max_past_epochs(2)`).
///
/// This is a LOCAL decryption setting: it does not need to match across members and only
/// governs how this device tolerates reordering/replay. It is baked into a group's config
/// at creation/join time, so it only affects groups created or (re)joined after this change.
fn sender_ratchet_config() -> SenderRatchetConfiguration {
    SenderRatchetConfiguration::new(2000, 2000)
}

// --- 1. LE MODÈLE DE PERSISTANCE (DISQUE) ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedState {
    pub identity_bundle: Vec<u8>,
    pub storage_values: HashMap<Vec<u8>, Vec<u8>>,
    pub group_ids: Vec<Vec<u8>>,
    /// Minimum epoch to accept per group after a forget_group() call.
    /// #[serde(default)] ensures compatibility with states saved before this field was added.
    #[serde(default)]
    pub forgotten_group_min_epochs: HashMap<String, u64>,
}

/// Borrowed view of [`PersistedState`] for CBOR encoding without cloning OpenMLS storage.
#[derive(Serialize)]
struct PersistedStateSer<'a> {
    identity_bundle: &'a [u8],
    storage_values: &'a HashMap<Vec<u8>, Vec<u8>>,
    group_ids: &'a [Vec<u8>],
    forgotten_group_min_epochs: &'a HashMap<String, u64>,
}

// Struct request wrapper for serialization
#[derive(Serialize)]
struct IdentityBundleRef<'a> {
    keypair: &'a [u8],    // Serialized bytes
    credential: &'a [u8], // Serialized bytes
}

#[derive(Serialize, Deserialize)]
struct IdentityBundle {
    keypair: Vec<u8>,
    credential: Vec<u8>,
}

// --- 2. LE GESTIONNAIRE (MÉMOIRE VIVE) ---

/// In-memory CBOR snapshot cache for `save_state` / `save_encrypted`.
/// Uses interior mutability so `generate_key_package` (`&self`) can invalidate it.
struct StateSnapshotCache {
    dirty: bool,
    cached_cbor: Option<Vec<u8>>,
}

impl StateSnapshotCache {
    fn new_dirty() -> Self {
        Self {
            dirty: true,
            cached_cbor: None,
        }
    }

    /// Seeds the cache from a freshly loaded plaintext snapshot (no re-serialize on first save).
    fn from_loaded(bytes: Vec<u8>) -> Self {
        Self {
            dirty: false,
            cached_cbor: Some(bytes),
        }
    }

    fn invalidate(&mut self) {
        self.dirty = true;
    }

    fn get_or_build<F>(&mut self, build: F) -> Result<Vec<u8>, MlsError>
    where
        F: FnOnce() -> Result<Vec<u8>, MlsError>,
    {
        if !self.dirty
            && let Some(ref cached) = self.cached_cbor
        {
            log::debug!(
                "save_state: returning cached CBOR snapshot ({} bytes)",
                cached.len()
            );
            return Ok(cached.clone());
        }

        let bytes = build()?;
        log::debug!("save_state: rebuilt CBOR snapshot ({} bytes)", bytes.len());
        self.cached_cbor = Some(bytes.clone());
        self.dirty = false;
        Ok(bytes)
    }
}

pub struct MlsManager {
    // OpenMlsRustCrypto owns the MemoryStorage internally and implements OpenMlsProvider
    provider: OpenMlsRustCrypto,

    keypair: SignatureKeyPair,
    credential: BasicCredential,

    groups: HashMap<String, MlsGroup>,

    /// Minimum epoch required to accept a Welcome (per groupId).
    /// Set by forget_group to prevent a stale Welcome (from a device itself behind on epoch)
    /// from putting this device back on the wrong branch.
    forgotten_group_min_epochs: HashMap<String, u64>,

    state_snapshot: RefCell<StateSnapshotCache>,
}

impl MlsManager {
    /// Marks the CBOR snapshot stale after any MLS state mutation.
    ///
    /// INVARIANT: every method that mutates `self.provider` storage, `self.groups`,
    /// `self.keypair`, or `forgotten_group_min_epochs` MUST call this (or invalidate the
    /// snapshot directly, as `process_incoming_on_group` does). Forgetting it makes
    /// `save_state` persist a stale snapshot - silent state loss / ratchet desync.
    /// Over-invalidating only costs a rebuild and is always safe.
    fn mark_state_dirty(&self) {
        self.state_snapshot.borrow_mut().invalidate();
    }

    /// Invalidates the in-memory CBOR snapshot so the next [`Self::save_state`] rebuilds it.
    /// Exposed for benchmarks and integration tests measuring cold serialization cost.
    pub fn invalidate_persisted_snapshot(&self) {
        self.mark_state_dirty();
    }
    // --- A. INITIALIZATION (Load or Create) ---

    pub fn load_or_create(
        user_id: &str,
        device_id: &str,
        decrypted_state: Option<Vec<u8>>,
    ) -> Result<Self, MlsError> {
        let provider = OpenMlsRustCrypto::default();

        if let Some(state_bytes) = decrypted_state {
            // CAS 1 : Restauration
            let state: PersistedState = from_reader(state_bytes.as_slice())
                .map_err(|e| MlsError::Serialization(e.to_string()))?;

            let bundle: IdentityBundle = from_reader(state.identity_bundle.as_slice())
                .map_err(|e| MlsError::Serialization(e.to_string()))?;

            // Deserialize keypair & credential from bytes
            let keypair = SignatureKeyPair::tls_deserialize(&mut bundle.keypair.as_slice())
                .map_err(|_| MlsError::Serialization("Failed to deserialize keypair".into()))?;

            let credential_enum = Credential::tls_deserialize(&mut bundle.credential.as_slice())
                .map_err(|_| MlsError::Serialization("Failed to deserialize credential".into()))?;

            let credential =
                BasicCredential::try_from(credential_enum).map_err(|_| MlsError::InvalidData)?;

            // Verify that the credential identity matches the expected identity.
            // A corrupted or tampered state could contain a credential for a different user/device.
            let expected_identity = format!("{}:{}", user_id, device_id);
            let loaded_identity = String::from_utf8_lossy(credential.identity()).to_string();
            if loaded_identity != expected_identity {
                log::warn!(
                    "load_or_create: identity mismatch - expected={} loaded={}",
                    expected_identity,
                    loaded_identity
                );
                return Err(MlsError::OpenMls(format!(
                    "Credential identity mismatch: expected {} but state contains {}",
                    expected_identity, loaded_identity
                )));
            }

            // 2. Restore in-memory storage
            {
                let storage = provider.storage();
                let mut lock = storage.values.write().unwrap();
                *lock = state.storage_values;
            }

            // 3. Restaurer les groupes
            let mut groups = HashMap::new();
            for gid_bytes in state.group_ids {
                let group_id = GroupId::from_slice(&gid_bytes);

                // Load using the provider
                if let Some(group) = MlsGroup::load(provider.storage(), &group_id)
                    .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?
                {
                    let group_id_str = String::from_utf8_lossy(&gid_bytes).to_string();
                    groups.insert(group_id_str, group);
                }
            }

            Ok(Self {
                provider,
                keypair,
                credential,
                groups,
                forgotten_group_min_epochs: state.forgotten_group_min_epochs,
                state_snapshot: RefCell::new(StateSnapshotCache::from_loaded(state_bytes)),
            })
        } else {
            // Case 2: First creation
            let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
            let keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
                .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?;

            let credential =
                BasicCredential::new(format!("{}:{}", user_id, device_id).into_bytes());

            Ok(Self {
                provider,
                keypair,
                credential,
                groups: HashMap::new(),
                forgotten_group_min_epochs: HashMap::new(),
                state_snapshot: RefCell::new(StateSnapshotCache::new_dirty()),
            })
        }
    }

    // --- B. CRÉATION DE GROUPE ---

    /// Creates a fresh MLS group with the given ID.
    /// Returns Err("GroupAlreadyExists") if an orphan state is found in OpenMLS storage.
    /// Callers that want a guaranteed-fresh group should use `force_create_group`.
    pub fn create_group(&mut self, group_id_str: String) -> Result<(), MlsError> {
        let group_id = GroupId::from_slice(group_id_str.as_bytes());

        // Align Ciphersuite with generate_key_package
        let group_config = MlsGroupCreateConfig::builder()
            .ciphersuite(Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(2)
            .sender_ratchet_configuration(sender_ratchet_config())
            .build();

        let credential_with_key = CredentialWithKey {
            credential: self.credential.clone().into(),
            signature_key: self.keypair.public().into(),
        };

        // Create the group using the provider and forcing the GROUP ID
        let result = MlsGroup::new_with_group_id(
            &self.provider,
            &self.keypair,
            &group_config,
            group_id.clone(),
            credential_with_key,
        );

        match result {
            Ok(group) => {
                self.groups.insert(group_id_str, group);
                self.mark_state_dirty();
                Ok(())
            }
            Err(e) => {
                let err_str = format!("{:?}", e);
                if err_str.contains("GroupAlreadyExists") {
                    // Orphan state: the group lives in OpenMLS storage (from a previous session)
                    // but was not loaded into self.groups (e.g. after forget_group without a full
                    // save, or a partial state deserialization). Recover it so that send_message
                    // can use it, then signal GroupAlreadyExists so callers can skip re-bootstrap.
                    match MlsGroup::load(self.provider.storage(), &group_id) {
                        Ok(Some(recovered)) => {
                            log::info!(
                                "create_group: {} recovered from orphan OpenMLS storage",
                                group_id_str
                            );
                            self.groups.insert(group_id_str.clone(), recovered);
                            self.mark_state_dirty();
                        }
                        _ => {
                            log::warn!(
                                "create_group: GroupAlreadyExists for {} but load failed",
                                group_id_str
                            );
                        }
                    }
                }
                Err(MlsError::OpenMls(format!("Creation error: {:?}", e)))
            }
        }
    }

    /// Wipes any existing MLS state for `group_id_str` from both the in-memory HashMap
    /// and the OpenMLS storage, then creates a brand-new group.
    /// Use this when re-bootstrapping a phantom group (lost local state) to avoid
    /// recovering a stale-epoch orphan via `create_group`.
    pub fn force_create_group(&mut self, group_id_str: String) -> Result<(), MlsError> {
        self.mark_state_dirty();
        let group_id = GroupId::from_slice(group_id_str.as_bytes());

        // 1. Remove from in-memory map if present.
        self.groups.remove(&group_id_str);
        self.forgotten_group_min_epochs.remove(&group_id_str);

        // 2. Wipe OpenMLS storage for this group if an orphan exists there.
        match MlsGroup::load(self.provider.storage(), &group_id) {
            Ok(Some(mut orphan)) => {
                if let Err(e) = orphan.delete(self.provider.storage()) {
                    log::warn!(
                        "force_create_group: delete orphan {} failed: {:?}",
                        group_id_str,
                        e
                    );
                    // Continue anyway - worst case the create below will hit GroupAlreadyExists
                    // and we fall back to the legacy orphan-recovery path.
                }
            }
            _ => {
                // Nothing in storage - nothing to wipe.
            }
        }

        // 3. Create fresh group.
        self.create_group(group_id_str)
    }

    pub fn get_known_groups(&self) -> Vec<String> {
        self.groups.keys().cloned().collect()
    }

    /// Returns the current MLS epoch of a group (u64).
    pub fn get_epoch(&self, group_id: &str) -> Result<u64, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or_else(|| MlsError::OpenMls(format!("Group {} not found", group_id)))?;
        Ok(group.epoch().as_u64())
    }

    /// Parse the MLS epoch from raw message bytes without decrypting anything.
    /// Both PrivateMessage and PublicMessage carry the epoch in cleartext in their header.
    /// Returns None if the bytes cannot be parsed as a valid MLS message.
    pub fn parse_message_epoch(message_bytes: &[u8]) -> Option<u64> {
        let msg_in = match MlsMessageIn::tls_deserialize(&mut &message_bytes[..]) {
            Ok(m) => m,
            Err(_) => return None,
        };
        let protocol_message: ProtocolMessage = match msg_in.extract() {
            MlsMessageBodyIn::PublicMessage(m) => m.into(),
            MlsMessageBodyIn::PrivateMessage(m) => m.into(),
            _ => return None,
        };
        Some(protocol_message.epoch().as_u64())
    }

    /// Deletes the persistent OpenMLS state for a group from the storage provider (best-effort).
    ///
    /// Required before any re-Welcome on the SAME group_id: without this,
    /// `StagedWelcome::new_from_welcome` reads the storage provider and refuses to overwrite
    /// an already-present group (`GroupAlreadyExists`), permanently blocking the
    /// "forget + re-Welcome" recovery. Does not touch the device's identity or KeyPackages.
    fn delete_group_from_storage(&self, group_id: &str) {
        let group_id_key = GroupId::from_slice(group_id.as_bytes());
        if let Ok(Some(mut orphan)) = MlsGroup::load(self.provider.storage(), &group_id_key)
            && let Err(e) = orphan.delete(self.provider.storage())
        {
            log::warn!(
                "delete_group_from_storage: deletion of {} failed: {:?}",
                group_id,
                e
            );
        }
    }

    /// Forgets the local MLS state of a group: in-memory AND persistent OpenMLS storage.
    /// `min_epoch`: minimum epoch a Welcome must reach to be accepted (protects against a
    /// stale re-Welcome on a diverged branch). Pass 0 to impose no minimum.
    ///
    /// Storage is purged (not just the in-memory HashMap) because OpenMLS rejects a
    /// re-Welcome on a group_id still present in the storage provider (`GroupAlreadyExists`).
    /// Without this purge, the "forget + re-Welcome" recovery never converges.
    pub fn forget_group(&mut self, group_id: &str, min_epoch: u64) {
        self.groups.remove(group_id);
        if min_epoch > 0 {
            self.forgotten_group_min_epochs
                .insert(group_id.to_string(), min_epoch);
        }
        self.delete_group_from_storage(group_id);
        log::info!(
            "forget_group: group {} forgotten (memory + storage, min_epoch={}, re-Welcome expected)",
            group_id,
            min_epoch
        );
        self.mark_state_dirty();
    }

    /// Permanent purge of all local state for a group: in-memory, OpenMLS storage,
    /// and epoch lock set to `u64::MAX` to reject all future Welcomes.
    /// Unlike `forget_group`, there is no way back after this call.
    /// Reserve for the "Poison Pill" policy (unrecoverable group).
    pub fn drop_group(&mut self, group_id: &str) {
        self.groups.remove(group_id);
        // u64::MAX: no Welcome will ever be accepted for this groupId.
        self.forgotten_group_min_epochs
            .insert(group_id.to_string(), u64::MAX);
        self.delete_group_from_storage(group_id);
        log::info!("[POISON_PILL] drop_group: {} permanently purged", group_id);
        self.mark_state_dirty();
    }

    // --- C0. SUPPRESSION DE MEMBRE(S) ---

    /// Remove all leaf nodes whose credential identity matches any of the provided user IDs.
    /// Returns the serialized commit bytes that must be broadcast to all group members.
    pub fn remove_members_for_users(
        &mut self,
        group_id: &str,
        user_ids: &[&str],
    ) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        // Collect the leaf indices of all leaves whose identity matches one of the user IDs.
        let mut leaf_indices: Vec<LeafNodeIndex> = Vec::new();
        for member in group.members() {
            let credential =
                BasicCredential::try_from(member.credential.clone()).map_err(|_| {
                    MlsError::OpenMls(format!("Invalid credential for member {}", member.index))
                })?;
            let identity = credential.identity().to_vec();
            if user_ids
                .iter()
                .any(|uid| uid.as_bytes() == identity.as_slice())
            {
                leaf_indices.push(member.index);
            }
        }

        if leaf_indices.is_empty() {
            return Err(MlsError::OpenMls(format!(
                "No member found for identities: {:?}",
                user_ids
            )));
        }

        let (commit_msg_out, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.keypair, &leaf_indices)
            .map_err(|e| MlsError::OpenMls(format!("RemoveMembers error: {:?}", e)))?;

        // C7-A : on NE merge PAS ici. Le commit n'est que *stage*. L'appelant le valide cote
        // serveur PUIS appelle merge_pending_commit_for (accepte) ou clear_pending_commit_for
        // (rejete) - plus jamais de merge-avant-validation, donc plus de fork local sur rejet.
        self.mark_state_dirty();
        commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))
    }

    /// Remove leaf nodes whose credential identity exactly matches any of the provided
    /// `userId:deviceId` strings. Use this to remove a specific device without
    /// affecting other devices of the same user.
    pub fn remove_members_for_devices(
        &mut self,
        group_id: &str,
        device_identities: &[&str],
    ) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let mut leaf_indices: Vec<LeafNodeIndex> = Vec::new();
        for member in group.members() {
            let credential =
                BasicCredential::try_from(member.credential.clone()).map_err(|_| {
                    MlsError::OpenMls(format!("Invalid credential for member {}", member.index))
                })?;
            let identity = credential.identity().to_vec();
            if device_identities
                .iter()
                .any(|did| did.as_bytes() == identity.as_slice())
            {
                leaf_indices.push(member.index);
            }
        }

        if leaf_indices.is_empty() {
            return Err(MlsError::OpenMls(format!(
                "No member found for identities: {:?}",
                device_identities
            )));
        }

        let (commit_msg_out, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.keypair, &leaf_indices)
            .map_err(|e| MlsError::OpenMls(format!("RemoveMembers error: {:?}", e)))?;

        // C7-A : stage uniquement (cf. remove_members_for_users) - merge/clear par l'appelant
        // apres validation serveur.
        self.mark_state_dirty();
        commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))
    }

    /// Merge le commit en attente (staged) du groupe : a appeler APRES que le serveur a accepte
    /// le commit (`validateCommit`). Avance l'epoch local. Pendant de `clear_pending_commit_for`.
    /// [[C7]] Option A : valider-puis-merger, jamais de fork local sur rejet.
    pub fn merge_pending_commit_for(&mut self, group_id: &str) -> Result<(), MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("Merge pending commit error: {:?}", e)))?;
        self.mark_state_dirty();
        Ok(())
    }

    /// Annule le commit en attente (staged) du groupe : a appeler quand le serveur REJETTE le
    /// commit. L'epoch local reste inchange (aucun fork) et un nouveau commit peut etre genere.
    /// [[C7]] Option A.
    pub fn clear_pending_commit_for(&mut self, group_id: &str) -> Result<(), MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(|e| MlsError::OpenMls(format!("Clear pending commit error: {:?}", e)))?;
        self.mark_state_dirty();
        Ok(())
    }

    /// Export the group's current ratchet tree (TLS-serialised). For an ADD this MUST be called
    /// AFTER `merge_pending_commit_for` so the exported tree reflects the post-commit epoch (N+1)
    /// the newly welcomed member joins, not the stale pre-merge tree. [[C7]]
    pub fn export_ratchet_tree_for(&self, group_id: &str) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group
            .export_ratchet_tree()
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))
    }

    // --- C. AJOUT DE MEMBRE(S) ---

    /// Add a single key package (kept for backward compat, delegates to bulk).
    pub fn add_member(
        &mut self,
        group_id: &str,
        key_package_bytes: &[u8],
    ) -> Result<AddMemberResult, MlsError> {
        let (commit, welcome, _, _) = self.add_members_bulk(group_id, &[key_package_bytes])?;
        Ok((commit, welcome))
    }

    /// Add multiple members in a single commit so all new members share the same epoch.
    /// Returns `(commit, welcome, added_indices, ratchet_tree, skipped_indices)` (see
    /// [`AddMembersBulkResult`]). Key packages that fail validation/deserialisation are skipped
    /// and reported via `skipped_indices` so the caller can surface them ([[C5]]) instead of a
    /// silent member loss. Key packages whose identity is already present in the group's tree are
    /// also skipped but NOT reported in `skipped_indices` (re-adding one would make OpenMLS reject
    /// the *entire* commit with `ProposalValidationError(DuplicateSignatureKey)`); this happens
    /// when a previous add attempt merged its commit locally but failed to deliver the
    /// Welcome/commit over the network, leaving a "ghost" member that the caller should detect via
    /// `MlsError::AlreadyMember` (when nothing else was added) and heal by removing then re-adding
    /// that identity.
    pub fn add_members_bulk(
        &mut self,
        group_id: &str,
        key_packages_bytes: &[&[u8]],
    ) -> Result<AddMembersBulkResult, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let mut known_identities: std::collections::HashSet<Vec<u8>> =
            std::collections::HashSet::new();
        for member in group.members() {
            if let Ok(credential) = BasicCredential::try_from(member.credential.clone()) {
                known_identities.insert(credential.identity().to_vec());
            }
        }

        // Deserialise and validate each key package, skip invalid ones and ones whose
        // identity is already a member (either already in the tree, or a duplicate within
        // this same batch), tracking the original index of each one kept.
        let mut key_packages: Vec<KeyPackage> = Vec::new();
        let mut added_indices: Vec<u32> = Vec::new();
        // Positions des KeyPackages invalides/illisibles, remontees a l'appelant (pas les
        // deja-membres, qui relevent d'une dedup benigne). [[C5]]
        let mut skipped_indices: Vec<u32> = Vec::new();
        let mut any_already_member = false;
        for (idx, kp_bytes) in key_packages_bytes.iter().enumerate() {
            let kp = match KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]) {
                Ok(kp_in) => match kp_in.validate(self.provider.crypto(), ProtocolVersion::Mls10) {
                    Ok(kp) => kp,
                    Err(e) => {
                        log::warn!("Skipping invalid KeyPackage at index {}: {:?}", idx, e);
                        skipped_indices.push(idx as u32);
                        continue;
                    }
                },
                Err(e) => {
                    log::warn!(
                        "Skipping undeserializable KeyPackage at index {}: {:?}",
                        idx,
                        e
                    );
                    skipped_indices.push(idx as u32);
                    continue;
                }
            };

            let identity = BasicCredential::try_from(kp.leaf_node().credential().clone())
                .ok()
                .map(|c| c.identity().to_vec());
            if let Some(identity) = &identity {
                if known_identities.contains(identity) {
                    log::warn!("Skipping KeyPackage already a member of the group");
                    any_already_member = true;
                    continue;
                }
                known_identities.insert(identity.clone());
            }

            added_indices.push(idx as u32);
            key_packages.push(kp);
        }

        if key_packages.is_empty() {
            if any_already_member {
                return Err(MlsError::AlreadyMember(
                    "All KeyPackages already belong to existing group members".to_string(),
                ));
            }
            return Err(MlsError::OpenMls("No valid KeyPackages to add".to_string()));
        }

        let (commit_msg_out, welcome_msg_out, _group_info) = group
            .add_members(&self.provider, &self.keypair, &key_packages)
            .map_err(|e| MlsError::OpenMls(format!("AddMembers error: {:?}", e)))?;

        // C7-A unified: stage only, do NOT merge here. The caller validates the commit server-side
        // then calls merge_pending_commit_for (accepted) or clear_pending_commit_for (rejected), so
        // a server-rejected ADD never leaves the local epoch ahead (no fork). The ratchet tree is
        // exported by export_ratchet_tree_for AFTER the merge (it needs the post-commit epoch N+1
        // state the newly welcomed member joins). [[C7]]
        let commit_bytes = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        let welcome_bytes = welcome_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;

        self.mark_state_dirty();
        Ok((
            commit_bytes,
            Some(welcome_bytes),
            added_indices,
            skipped_indices,
        ))
    }

    // --- C2. REJOINDRE UN GROUPE (Traitement Welcome) ---

    pub fn process_welcome(
        &mut self,
        welcome_bytes: &[u8],
        ratchet_tree_bytes: Option<&[u8]>,
    ) -> Result<String, MlsError> {
        // Attempt to deserialize as MlsMessageIn first (standard), then fallback to raw Welcome
        let welcome = match MlsMessageIn::tls_deserialize(&mut &welcome_bytes[..]) {
            Ok(msg_in) => match msg_in.extract() {
                MlsMessageBodyIn::Welcome(w) => w,
                // If successfully parsed as MlsMessage but not Welcome, it's invalid for this context
                _ => return Err(MlsError::InvalidData),
            },
            Err(_) => {
                // Fallback: Try raw Welcome
                Welcome::tls_deserialize(&mut &welcome_bytes[..])
                    .map_err(|_| MlsError::InvalidData)?
            }
        };

        let group_config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(2)
            .sender_ratchet_configuration(sender_ratchet_config())
            .build();

        // If ratchet tree is provided externally (e.g. via specific server endpoint), deserialize it
        // Otherwise pass None (OpenMLS can often reconstruct or it might be in the Welcome extension)
        let ratchet_tree = if let Some(rt_bytes) = ratchet_tree_bytes {
            // Deserialize the ratchet tree nodes
            Some(
                RatchetTreeIn::tls_deserialize(&mut &rt_bytes[..])
                    .map_err(|_| MlsError::InvalidData)?,
            )
        } else {
            None
        };

        // Important: new_from_welcome consumes the welcome message and initializes the group
        let staged_welcome = StagedWelcome::new_from_welcome(
            &self.provider,
            &group_config,
            welcome.clone(),
            ratchet_tree,
        )
        .map_err(|e| {
            MlsError::OpenMls(format!(
                "Join error (staged): {:?} [n_secrets={}]",
                e,
                welcome.secrets().len()
            ))
        })?;

        // group_id and epoch are readable from the StagedWelcome context WITHOUT writing
        // anything to storage. `into_group` (which persists via .store()) is intentionally
        // deferred until AFTER the guards: a rejected Welcome (parallel or stale) must never
        // leave an orphan group in the storage provider - a group that `self.groups` does not
        // reference, that leaks indefinitely and blocks every future legitimate re-Welcome with
        // `GroupAlreadyExists`. Before this fix, into_group ran before the guards.
        let group_id =
            String::from_utf8_lossy(staged_welcome.group_context().group_id().as_slice())
                .to_string();
        let welcome_epoch = staged_welcome.group_context().epoch().as_u64();

        // ── Guard 1: group already active in memory ────────────────────────────
        //
        // A "parallel" Welcome (two devices commit simultaneously at the same epoch)
        // must NOT overwrite the in-memory state: that would corrupt the key schedule
        // and produce AeadErrors on all subsequent messages.
        //
        // Exception: if the Welcome is at epoch 0, it necessarily comes from a full
        // re-bootstrap (forceCreateGroup). In that case the previous tree is discarded
        // and the new tree is authoritative - replace the state.
        if let Some(existing) = self.groups.get(&group_id) {
            let existing_epoch = existing.epoch().as_u64();
            if welcome_epoch == 0 && existing_epoch > 0 {
                // Legitimate re-bootstrap - overwrite the old state.
                // The min_epoch guard is also cleared: a reset to 0 removes any
                // epoch constraint from a previous recovery.
                log::info!(
                    "process_welcome: re-bootstrap detected for {} (epoch {} -> 0) - replacing state",
                    group_id,
                    existing_epoch
                );
                self.forgotten_group_min_epochs.remove(&group_id);
                // On laisse tomber vers self.groups.insert() ci-dessous.
            } else {
                // Parallel or duplicate Welcome - keep the in-memory state.
                log::info!(
                    "process_welcome: group {} already active (epoch={}) - Welcome ignored (new epoch={})",
                    group_id,
                    existing_epoch,
                    welcome_epoch
                );
                return Ok(group_id);
            }
        }

        // ── Guard 2: min_epoch constraint after a forget_group ─────────────
        //
        // If forgetGroup(groupId, N) was called during an epoch recovery,
        // reject Welcomes with epoch < N (diverged branch).
        // Same exception: epoch 0 = re-bootstrap -> lift the constraint.
        if let Some(&min_ep) = self.forgotten_group_min_epochs.get(&group_id) {
            if welcome_epoch == 0 {
                // Re-bootstrap: the min_epoch constraint is lifted.
                log::info!(
                    "process_welcome: epoch-0 Welcome for {} - clearing min_epoch={} guard",
                    group_id,
                    min_ep
                );
                self.forgotten_group_min_epochs.remove(&group_id);
            } else if welcome_epoch < min_ep {
                log::warn!(
                    "process_welcome: Welcome rejected for {} - epoch {} < minimum expected {}",
                    group_id,
                    welcome_epoch,
                    min_ep
                );
                return Err(MlsError::OpenMls(format!(
                    "Welcome stale: epoch {} < min_epoch {}",
                    welcome_epoch, min_ep
                )));
            } else {
                self.forgotten_group_min_epochs.remove(&group_id);
            }
        }

        // Guards passed - now persist the group (into_group -> store) and register it in memory.
        // This is the only point where the storage provider is written for this Welcome.
        let group = staged_welcome
            .into_group(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("Join error (into_group): {:?}", e)))?;

        self.groups.insert(group_id.clone(), group);
        self.mark_state_dirty();

        Ok(group_id)
    }

    // --- D. MESSAGERIE ---

    pub fn send_message(&mut self, group_id: &str, message: &[u8]) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let msg_out = group
            .create_message(&self.provider, &self.keypair, message)
            .map_err(|e| MlsError::OpenMls(format!("Encrypt error: {:?}", e)))?;

        self.mark_state_dirty();
        msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::Serialization(e.to_string()))
    }

    /// Process an incoming MLS message (Handshake or Application)
    /// Returns decoded data if it was an application message
    pub fn process_incoming_message(
        &mut self,
        group_id: &str,
        message_bytes: &[u8],
    ) -> Result<Option<Vec<u8>>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| MlsError::GroupNotFound(group_id.to_string()))?;
        Self::process_incoming_on_group(
            group,
            &self.provider,
            group_id,
            message_bytes,
            &self.state_snapshot,
        )
    }

    /// Decrypts `messages` for one group in ratchet order. Per-message errors are returned
    /// in the output vector instead of aborting the batch (history catch-up path).
    pub fn process_incoming_messages(
        &mut self,
        group_id: &str,
        messages: &[&[u8]],
    ) -> Vec<Result<Option<Vec<u8>>, MlsError>> {
        let Some(group) = self.groups.get_mut(group_id) else {
            return messages
                .iter()
                .map(|_| Err(MlsError::GroupNotFound(group_id.to_string())))
                .collect();
        };

        let provider = &self.provider;
        let snapshot = &self.state_snapshot;
        messages
            .iter()
            .map(|bytes| {
                Self::process_incoming_on_group(group, provider, group_id, bytes, snapshot)
            })
            .collect()
    }

    fn process_incoming_on_group(
        group: &mut MlsGroup,
        provider: &OpenMlsRustCrypto,
        group_id: &str,
        message_bytes: &[u8],
        state_snapshot: &RefCell<StateSnapshotCache>,
    ) -> Result<Option<Vec<u8>>, MlsError> {
        let msg_in = MlsMessageIn::tls_deserialize(&mut &message_bytes[..])
            .map_err(|_| MlsError::InvalidData)?;

        let protocol_message: ProtocolMessage = match msg_in.extract() {
            MlsMessageBodyIn::PublicMessage(m) => m.into(),
            MlsMessageBodyIn::PrivateMessage(m) => m.into(),
            _ => return Err(MlsError::InvalidData),
        };

        // Both fields are always cleartext in the MLS frame header - safe to read
        // before decryption and invaluable for diagnosing epoch-mismatch errors.
        let msg_epoch = protocol_message.epoch();
        let group_epoch = group.epoch();

        // Epoch-gap fast-fail: a future epoch means we missed at least one commit.
        // Returning early avoids consuming any ratchet key material needlessly and
        // lets the caller queue the message for gap recovery.
        if msg_epoch.as_u64() > group_epoch.as_u64() {
            log::warn!(
                "Gap detected: msg_epoch={} > group_epoch={} for group={}. \
                 Queuing message and triggering resync.",
                msg_epoch,
                group_epoch,
                group_id
            );
            return Err(MlsError::OpenMls(format!(
                "Process error: epoch gap [msg_epoch={}, group_epoch={}]",
                msg_epoch, group_epoch
            )));
        }

        let processed_message = match group.process_message(provider, protocol_message) {
            Ok(pm) => pm,
            Err(e) => {
                // If the message is from a past epoch, it's almost certainly our own
                // echoed commit (already merged via merge_pending_commit) or a stale
                // commit that another device already applied. The decryption keys for
                // commits are consumed during merge, so re-processing always fails with
                // AeadError. Silently succeed so the caller ACKs it on the gateway.
                if msg_epoch.as_u64() < group_epoch.as_u64() {
                    log::debug!(
                        "Stale message ignored: msg_epoch={} < group_epoch={} ({})",
                        msg_epoch,
                        group_epoch,
                        group_id
                    );
                    return Ok(None);
                }

                // Same-epoch sender-ratchet failures are PERMANENT - retrying never helps:
                //  - SecretReuseError    : this generation's key was already consumed
                //                          (duplicate delivery: realtime + queue + FCM).
                //  - TooDistantInThePast : the generation is older than the kept ratchet
                //                          window (out-of-order beyond tolerance). The key
                //                          is gone for good.
                // OpenMLS may surface the latter either raw or wrapped as NoPastEpochData;
                // both Debug strings carry the variant name, so a substring match is robust.
                // Treat them as a benign duplicate/late frame: ACK + drop (Ok(None)). This is
                // the single source of truth so every caller (native, WASM, background worker)
                // stops looping the message through its retry queue. Genuine epoch gaps are
                // handled by the `msg_epoch > group_epoch` fast-fail above, never here.
                let err_dbg = format!("{:?}", e);
                if err_dbg.contains("SecretReuseError")
                    || err_dbg.contains("TooDistantInThePast")
                    || err_dbg.contains("NoPastEpochData")
                {
                    log::debug!(
                        "Benign same-epoch ratchet frame dropped: group={} epoch={} ({})",
                        group_id,
                        group_epoch,
                        err_dbg
                    );
                    return Ok(None);
                }

                log::error!(
                    "MLS decryption failed: group={} msg_epoch={} group_epoch={} err={:?}",
                    group_id,
                    msg_epoch,
                    group_epoch,
                    e
                );
                return Err(MlsError::OpenMls(format!(
                    "Process error: {:?} [msg_epoch={}, group_epoch={}]",
                    e, msg_epoch, group_epoch
                )));
            }
        };

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => {
                state_snapshot.borrow_mut().invalidate();
                Ok(Some(app_msg.into_bytes()))
            }
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group
                    .merge_staged_commit(provider, *staged_commit)
                    .map_err(|e| MlsError::OpenMls(format!("Merge commit error: {:?}", e)))?;
                state_snapshot.borrow_mut().invalidate();
                Ok(None)
            }
            // A standalone (External)Proposal queues a pending proposal in the group state,
            // which is persisted OpenMLS state - invalidate so the next save_state rebuilds.
            ProcessedMessageContent::ProposalMessage(_)
            | ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                state_snapshot.borrow_mut().invalidate();
                Ok(None)
            }
        }
    }

    // --- E. SAVE (CBOR serialization) ---

    pub fn save_state(&self) -> Result<Vec<u8>, MlsError> {
        let mut cache = self.state_snapshot.borrow_mut();
        cache.get_or_build(|| self.serialize_state())
    }

    fn serialize_state(&self) -> Result<Vec<u8>, MlsError> {
        // 1. Serialize the identity (using Ref wrapper to avoid cloning keypair)
        let keypair_bytes = self
            .keypair
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Keypair serialization: {:?}", e)))?;

        // Credential is an enum, we convert BasicCredential to Credential for serialization
        let cred_enum: Credential = self.credential.clone().into();
        let credential_bytes = cred_enum
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Credential serialization: {:?}", e)))?;

        let bundle = IdentityBundleRef {
            keypair: &keypair_bytes,
            credential: &credential_bytes,
        };

        let mut bundle_bytes = Vec::new();
        into_writer(&bundle, &mut bundle_bytes)
            .map_err(|e| MlsError::Serialization(e.to_string()))?;

        // 2. Snapshot OpenMLS storage under a read lock (no HashMap::clone).
        let storage = self.provider.storage();
        let storage_lock = storage.values.read().unwrap();

        // 3. Collect active group IDs (sorted for stable order; note: storage_values is
        //    an unordered HashMap, so the overall CBOR is not deterministic)
        let mut group_ids: Vec<Vec<u8>> = self
            .groups
            .keys()
            .map(|gid_str| gid_str.as_bytes().to_vec())
            .collect();
        group_ids.sort();

        // 4. Encode the global state without copying storage_values
        let persisted = PersistedStateSer {
            identity_bundle: &bundle_bytes,
            storage_values: &storage_lock,
            group_ids: &group_ids,
            forgotten_group_min_epochs: &self.forgotten_group_min_epochs,
        };

        let mut final_bytes = Vec::new();
        into_writer(&persisted, &mut final_bytes)
            .map_err(|e| MlsError::Serialization(e.to_string()))?;

        Ok(final_bytes)
    }

    // --- E. GÉNÉRER MON KEY PACKAGE ---

    pub fn generate_key_package(&self) -> Result<Vec<u8>, MlsError> {
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

        let credential_with_key = CredentialWithKey {
            credential: self.credential.clone().into(),
            signature_key: self.keypair.public().into(),
        };

        let key_package_bundle = KeyPackage::builder()
            .build(
                ciphersuite,
                &self.provider,
                &self.keypair,
                credential_with_key,
            )
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage creation error: {:?}", e)))?;

        // 2. IMPORTANT: Persist the bundle (private key) in the provider's storage
        let key_package = key_package_bundle.key_package();
        let hash_ref = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| MlsError::OpenMls(format!("HashRef error: {:?}", e)))?;

        let _hash_ref_bytes = hash_ref.as_slice();
        // Console log via error or panic? No, we can't easily console log from here without bindings.
        // We will rely on return verification.

        self.provider
            .storage()
            .write_key_package(&hash_ref, &key_package_bundle)
            .map_err(|e| MlsError::OpenMls(format!("Storage error: {:?}", e)))?;

        self.mark_state_dirty();

        // 3. Return the serialized public KeyPackage
        key_package
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Serialization error: {:?}", e)))
    }

    pub fn generate_key_packages(&self, count: usize) -> Result<Vec<Vec<u8>>, MlsError> {
        (0..count).map(|_| self.generate_key_package()).collect()
    }

    /// Checks whether the private key for the provided public KeyPackage is still held locally.
    ///
    /// Recomputes the `hash_ref` of the KeyPackage (the key under which its private bundle
    /// was stored at generation time) then queries the keystore. Lets the client detect
    /// KeyPackages published to the server whose local private key has been lost (state reset
    /// or restored from an older backup) - the root cause of `NoMatchingKeyPackage` loops.
    /// These orphan KeyPackages can then be pruned from the server before a peer consumes them.
    pub fn key_package_has_private(&self, kp_bytes: &[u8]) -> Result<bool, MlsError> {
        let kp_in = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..])
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage deserialize error: {:?}", e)))?;
        let key_package = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage validate error: {:?}", e)))?;
        let hash_ref = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| MlsError::OpenMls(format!("HashRef error: {:?}", e)))?;

        let bundle: Option<KeyPackageBundle> = self
            .provider
            .storage()
            .key_package(&hash_ref)
            .map_err(|e| MlsError::OpenMls(format!("Storage read error: {:?}", e)))?;
        Ok(bundle.is_some())
    }

    // --- F. CHIFFREMENT / DÉCHIFFREMENT (Helper) ---

    /// Encrypts a plain CBOR MLS snapshot (Argon2 + ChaCha20). Usable off-thread without a live manager.
    pub fn encrypt_state_blob(plain_state: &[u8], pin: &str) -> Result<Vec<u8>, MlsError> {
        security::encrypt_state_with_pin(pin, plain_state)
            .map_err(|s| MlsError::OpenMls(format!("encrypt_state_blob: {}", s)))
    }

    pub fn save_encrypted(&self, pin: &str) -> Result<Vec<u8>, MlsError> {
        let plain_state = self.save_state()?;
        Self::encrypt_state_blob(&plain_state, pin)
    }

    pub fn load_encrypted(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        pin: &str,
    ) -> Result<Self, MlsError> {
        let decrypted_state = if let Some(blob) = encrypted_blob {
            if blob.len() < 16 {
                return Err(MlsError::InvalidData);
            }

            let (salt, rest) = blob.split_at(16);

            let key = derive_key_from_pin(pin, salt)
                .map_err(|s| MlsError::OpenMls(format!("Key derivation: {}", s)))?;

            let plain = decrypt_blob(&key, rest)
                .map_err(|s| MlsError::OpenMls(format!("Decryption: {}", s)))?;

            Some(plain)
        } else {
            None
        };

        Self::load_or_create(user_id, device_id, decrypted_state)
    }

    // --- G. EXPORT SECRET (WebRTC / Call) ---

    pub fn export_secret(
        &self,
        group_id: &str,
        label: &str,
        context: &[u8],
        key_len: usize,
    ) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        group
            .export_secret(self.provider.crypto(), label, context, key_len)
            .map_err(|e| MlsError::OpenMls(format!("Export secret error: {:?}", e)))
    }
}
