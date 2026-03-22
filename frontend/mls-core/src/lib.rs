pub mod security;
use security::{decrypt_blob, derive_key_from_pin, encrypt_blob};

use ciborium::{de::from_reader, ser::into_writer};
use openmls::prelude::*;
use openmls::treesync::RatchetTreeIn;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_traits::storage::StorageProvider; // Explicit import for write_key_package
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

// --- GESTION DES ERREURS PROPRE ---

#[derive(Error, Debug)]
pub enum MlsError {
    #[error("Erreur Crypto/OpenMLS: {0}")]
    OpenMls(String),
    #[error("Erreur de Sérialisation CBOR: {0}")]
    Serialization(String),
    #[error("Groupe introuvable: {0}")]
    GroupNotFound(String),
    #[error("Données invalides")]
    InvalidData,
}

type AddMembersBulkResult = (Vec<u8>, Option<Vec<u8>>, usize, Option<Vec<u8>>);
type AddMemberResult = (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>);

// --- 1. LE MODÈLE DE PERSISTANCE (DISQUE) ---

#[derive(Serialize, Deserialize)]
pub struct PersistedState {
    pub identity_bundle: Vec<u8>,
    pub storage_values: HashMap<Vec<u8>, Vec<u8>>,
    pub group_ids: Vec<Vec<u8>>,
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

pub struct MlsManager {
    // OpenMlsRustCrypto owns the MemoryStorage internally and implements OpenMlsProvider
    provider: OpenMlsRustCrypto,

    keypair: SignatureKeyPair,
    credential: BasicCredential,

    groups: HashMap<String, MlsGroup>,
}

impl MlsManager {
    // --- A. INITIALISATION (Chargement ou Création) ---

    pub fn load_or_create(
        user_id: &str,
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

            // 2. Restaurer le stockage mémoire
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
            })
        } else {
            // CAS 2 : Première création
            let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
            let keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
                .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?;

            let credential = BasicCredential::new(user_id.as_bytes().to_vec());

            Ok(Self {
                provider,
                keypair,
                credential,
                groups: HashMap::new(),
            })
        }
    }

    // --- B. CRÉATION DE GROUPE ---

    pub fn create_group(&mut self, group_id_str: String) -> Result<(), MlsError> {
        let group_id = GroupId::from_slice(group_id_str.as_bytes());

        // Align Ciphersuite with generate_key_package
        let group_config = MlsGroupCreateConfig::builder()
            .ciphersuite(Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519)
            .use_ratchet_tree_extension(true)
            .build();

        let credential_with_key = CredentialWithKey {
            credential: self.credential.clone().into(),
            signature_key: self.keypair.public().into(),
        };

        // Create the group using the provider and forcing the GROUP ID
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.keypair, // <--- SIGNER
            &group_config,
            group_id,
            credential_with_key,
        )
        .map_err(|e| MlsError::OpenMls(format!("Creation error: {:?}", e)))?;

        self.groups.insert(group_id_str, group);
        Ok(())
    }

    pub fn get_known_groups(&self) -> Vec<String> {
        self.groups.keys().cloned().collect()
    }

    // --- C. AJOUT DE MEMBRE(S) ---

    /// Add a single key package (kept for backward compat, delegates to bulk).
    pub fn add_member(
        &mut self,
        group_id: &str,
        key_package_bytes: &[u8],
    ) -> Result<AddMemberResult, MlsError> {
        let (commit, welcome, _, ratchet_tree) =
            self.add_members_bulk(group_id, &[key_package_bytes])?;
        Ok((commit, welcome, ratchet_tree))
    }

    /// Add multiple members in a single commit so all new members share the same epoch.
    /// Returns (commit_bytes, welcome_bytes, count_added).
    /// Silently skips key packages that fail validation.
    pub fn add_members_bulk(
        &mut self,
        group_id: &str,
        key_packages_bytes: &[&[u8]],
    ) -> Result<AddMembersBulkResult, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        // Deserialise and validate each key package, skip invalid ones
        let mut key_packages: Vec<KeyPackage> = Vec::new();
        for kp_bytes in key_packages_bytes {
            match KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]) {
                Ok(kp_in) => match kp_in.validate(self.provider.crypto(), ProtocolVersion::Mls10) {
                    Ok(kp) => key_packages.push(kp),
                    Err(e) => log::warn!("Skipping invalid KeyPackage: {:?}", e),
                },
                Err(e) => log::warn!("Skipping undeserializable KeyPackage: {:?}", e),
            }
        }

        if key_packages.is_empty() {
            return Err(MlsError::OpenMls("No valid KeyPackages to add".to_string()));
        }

        let count = key_packages.len();

        let (commit_msg_out, welcome_msg_out, _group_info) = group
            .add_members(&self.provider, &self.keypair, &key_packages)
            .map_err(|e| MlsError::OpenMls(format!("AddMembers error: {:?}", e)))?;

        group
            .merge_pending_commit(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("Merge error: {:?}", e)))?;

        let commit_bytes = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        let welcome_bytes = welcome_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        let ratchet_tree_bytes = group
            .export_ratchet_tree()
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;

        Ok((
            commit_bytes,
            Some(welcome_bytes),
            count,
            Some(ratchet_tree_bytes),
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
        let staged_welcome =
            StagedWelcome::new_from_welcome(&self.provider, &group_config, welcome.clone(), ratchet_tree)
                .map_err(|e| {
                     // DEBUG: Check storage for keys
                    let storage = self.provider.storage();
                    let lock = storage.values.read().unwrap();
                    let keys: Vec<String> = lock.keys()
                        .map(|k| {
                            let hex_str = k.iter().map(|b| format!("{:02x}", b)).collect::<String>();
                             if let Ok(s) = String::from_utf8(k.clone()) {
                                 format!("(utf8){} [hex:{}]", s, hex_str)
                             } else {
                                 format!("(hex){}", hex_str)
                             }
                        })
                        .collect();

                    // Try to inspect secrets from welcome
                    let requested_refs: Vec<String> = welcome.secrets().iter().map(|s| {
                        // Just debug format the struct, we don't know the fields easily without docs
                        let new_member = s.new_member(); // This returns KeyPackageRef (which is HashReference)
                        let bytes = new_member.as_slice();
                        let hex = bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();
                        format!("Ref: {}", hex)
                    }).collect();

                    MlsError::OpenMls(format!("Join error (staged): {:?}. \nWanted Refs (len={}): {:?}. \nStorage keys (len={}): {:?}", e, welcome.secrets().len(), requested_refs, keys.len(), keys))
                })?;

        let group = staged_welcome
            .into_group(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("Join error (into_group): {:?}", e)))?;

        let group_id = String::from_utf8_lossy(group.group_id().as_slice()).to_string();

        // Save to our map
        self.groups.insert(group_id.clone(), group);

        // Save to storage immediately to persist the join
        // (Optional: usually explicit save is better, but safe for now)

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
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let msg_in = MlsMessageIn::tls_deserialize(&mut &message_bytes[..])
            .map_err(|_| MlsError::InvalidData)?;

        let protocol_message: ProtocolMessage = match msg_in.extract() {
            MlsMessageBodyIn::PublicMessage(m) => m.into(),
            MlsMessageBodyIn::PrivateMessage(m) => m.into(),
            _ => return Err(MlsError::InvalidData),
        };

        let processed_message = group
            .process_message(&self.provider, protocol_message)
            .map_err(|e| MlsError::OpenMls(format!("Process error: {:?}", e)))?;

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => {
                // Return validity and data
                Ok(Some(app_msg.into_bytes()))
            }
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group
                    .merge_staged_commit(&self.provider, *staged_commit)
                    .map_err(|e| MlsError::OpenMls(format!("Merge commit error: {:?}", e)))?;
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    // --- E. SAUVEGARDE (Sérialisation CBOR) ---

    pub fn save_state(&self) -> Result<Vec<u8>, MlsError> {
        // 1. Sérialiser l'identité (using Ref wrapper to avoid cloning keypair)
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

        // 2. Extraire le stockage brut de MemoryStorage du provider
        let storage = self.provider.storage();
        let storage_lock = storage.values.read().unwrap();
        let storage_values = storage_lock.clone();

        // 3. Collecter les IDs des groupes actifs
        let mut group_ids = Vec::new();
        for gid_str in self.groups.keys() {
            group_ids.push(gid_str.as_bytes().to_vec());
        }

        // 4. Créer l'état global
        let persisted = PersistedState {
            identity_bundle: bundle_bytes,
            storage_values,
            group_ids,
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

        // 2. IMPORTANT: Persister le bundle (clé privée) dans le stockage du provider
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

        // 3. Retourner le KeyPackage public sérialisé
        key_package
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Serialization error: {:?}", e)))
    }

    // --- F. CHIFFREMENT / DÉCHIFFREMENT (Helper) ---

    pub fn save_encrypted(&self, pin: &str) -> Result<Vec<u8>, MlsError> {
        let plain_state = self.save_state()?;

        // Generate a random salt for Argon2
        let salt = self
            .provider
            .rand()
            .random_array::<16>() // Use const generic N=16
            .map_err(|e| MlsError::OpenMls(format!("Rng error: {:?}", e)))?;

        // Derive key
        let key = derive_key_from_pin(pin, &salt)
            .map_err(|s| MlsError::OpenMls(format!("Key derivation: {}", s)))?;

        // Encrypt (encrypt_blob handles the nonce)
        let ciphertext = encrypt_blob(&key, &plain_state)
            .map_err(|s| MlsError::OpenMls(format!("Encryption: {}", s)))?;

        // Prepend salt to the result: [salt (16) || nonce (12, inside ciphertext) || ciphertext]
        let mut result = Vec::with_capacity(salt.len() + ciphertext.len());
        result.extend_from_slice(&salt);
        result.extend_from_slice(&ciphertext);

        Ok(result)
    }

    pub fn load_encrypted(
        user_id: &str,
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

        Self::load_or_create(user_id, decrypted_state)
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
