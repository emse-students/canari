use openmls::prelude::*;
use tls_codec::Deserialize as TlsDeserialize;

use crate::MlsError;
use crate::state::MlsManager;

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
pub(crate) fn sender_ratchet_config() -> SenderRatchetConfiguration {
    SenderRatchetConfiguration::new(2000, 2000)
}

impl MlsManager {
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
    pub(crate) fn delete_group_from_storage(&self, group_id: &str) {
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
}
