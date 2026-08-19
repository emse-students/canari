use openmls::prelude::*;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::state::MlsManager;
use crate::{AddMemberResult, AddMembersBulkResult, MlsError};

/// The credential identity carried by one leaf, as the UTF-8 string it was built from.
///
/// Identities are minted in exactly one place (`state.rs`, `userId:deviceId`), so this is the
/// inverse of that and the only place the bytes are turned back into a string.
fn leaf_identity(member: &Member) -> Result<String, MlsError> {
    let credential = BasicCredential::try_from(member.credential.clone()).map_err(|_| {
        MlsError::OpenMls(format!("Invalid credential for member {}", member.index))
    })?;
    String::from_utf8(credential.identity().to_vec())
        .map_err(|_| MlsError::OpenMls(format!("Non-UTF8 credential for member {}", member.index)))
}

/// Leaf indices whose identity satisfies `matches`.
///
/// Factored out of the two removal paths, which differ ONLY in that predicate: one names devices,
/// the other names users, and the walk over the tree is the same walk.
fn leaf_indices_where(
    group: &MlsGroup,
    matches: impl Fn(&str) -> bool,
) -> Result<Vec<LeafNodeIndex>, MlsError> {
    let mut leaf_indices: Vec<LeafNodeIndex> = Vec::new();
    for member in group.members() {
        let identity = leaf_identity(&member)?;
        if matches(&identity) {
            leaf_indices.push(member.index);
        }
    }
    Ok(leaf_indices)
}

impl MlsManager {
    // --- C0. SUPPRESSION DE MEMBRE(S) ---

    /// Every leaf's credential identity (`userId:deviceId`) in `group_id`, in leaf order.
    ///
    /// THE TREE IS THE ONLY AUTHORITY ON WHO CAN READ IT. Server-side membership rows answer a
    /// different question - who the delivery service will route to - and can be empty for a group
    /// whose tree is full (a device fresh-start clears them). A reconciliation deciding whether a
    /// leaf still belongs must read this, never the routing table.
    pub fn member_identities(&self, group_id: &str) -> Result<Vec<String>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group.members().map(|m| leaf_identity(&m)).collect()
    }

    /// Remove all leaf nodes whose credential identity matches any of the provided user IDs.
    /// Returns the serialized commit bytes that must be broadcast to all group members.
    ///
    /// A LEAF IS A DEVICE, AND A USER IS ITS PREFIX. Identities are `userId:deviceId`, so an
    /// exact comparison against a bare user id matched nothing at all and this function could only
    /// ever answer "No member found" - the whole user-level removal path was inert. Matching the
    /// `userId:` prefix is what makes "remove this person, wherever they are signed in" mean what
    /// it says; the colon is part of the prefix so one user id can never swallow another's.
    pub fn remove_members_for_users(
        &mut self,
        group_id: &str,
        user_ids: &[&str],
    ) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let leaf_indices = leaf_indices_where(group, |identity| {
            user_ids
                .iter()
                .any(|uid| identity == *uid || identity.starts_with(&format!("{}:", uid)))
        })?;

        if leaf_indices.is_empty() {
            return Err(MlsError::OpenMls(format!(
                "No member found for identities: {:?}",
                user_ids
            )));
        }

        let (commit_msg_out, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.keypair, &leaf_indices)
            .map_err(|e| MlsError::OpenMls(format!("RemoveMembers error: {:?}", e)))?;

        // C7-A: do NOT merge here. The commit is only *staged*. The caller validates it
        // server-side THEN calls merge_pending_commit_for (accepted) or clear_pending_commit_for
        // (rejected) - never merge-before-validation again, hence no local fork on rejection.
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

        let leaf_indices =
            leaf_indices_where(group, |identity| device_identities.contains(&identity))?;

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

    /// Merges the group's pending (staged) commit: call AFTER the server accepted the commit
    /// (`validateCommit`). Advances the local epoch. Counterpart of `clear_pending_commit_for`.
    /// [[C7]] Option A: validate-then-merge, never a local fork on rejection.
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

    /// Clears the group's pending (staged) commit: call when the server REJECTS the commit.
    /// The local epoch stays unchanged (no fork) and a new commit can be generated.
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
        // Positions of invalid/unreadable KeyPackages, reported back to the caller (not the
        // already-members, which are a benign dedup). [[C5]]
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
