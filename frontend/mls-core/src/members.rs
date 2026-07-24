use openmls::prelude::*;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::state::MlsManager;
use crate::{AddMemberResult, AddMembersBulkResult, MlsError};

impl MlsManager {
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
}
