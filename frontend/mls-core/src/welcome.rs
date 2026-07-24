use openmls::prelude::*;
use openmls::treesync::RatchetTreeIn;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::MlsError;
use crate::group::sender_ratchet_config;
use crate::state::MlsManager;

impl MlsManager {
    /// Export a self-contained GroupInfo (WITH the ratchet tree extension) for `group_id`, in the
    /// standard `MlsMessageOut` wire form. The delivery service stores the latest one per group and
    /// serves it - only to authorized members - so a member lacking local MLS state can rejoin via
    /// an external commit (see [[Self::join_by_external_commit]]) without waiting for a peer Welcome.
    /// Because `with_ratchet_tree=true`, the joiner needs nothing but this blob.
    pub fn export_group_info(&self, group_id: &str) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        group
            .export_group_info(self.provider.crypto(), &self.keypair, true)
            .map_err(|e| MlsError::OpenMls(format!("export_group_info: {:?}", e)))?
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))
    }

    /// Join a group via an external commit, using a GroupInfo served by the delivery service. Builds
    /// the external commit (which adds THIS device's own leaf) and inserts the resulting group
    /// locally with the commit STAGED. Mirrors the staged-commit regime: the caller submits the
    /// returned commit for server epoch validation, then calls `merge_pending_commit_for` on accept.
    /// An external commit CANNOT be cleared, so on reject the caller must `forget_group` and rebuild
    /// from a fresher GroupInfo (self-service retry - this is what replaces the CAS/successor dance).
    /// Returns `(group_id, commit_bytes)`. Refuses to clobber a group already held locally (a
    /// concurrent Welcome may have landed first); rung-2 callers `forget_group` before calling.
    pub fn join_by_external_commit(
        &mut self,
        group_info_bytes: &[u8],
    ) -> Result<(String, Vec<u8>), MlsError> {
        // The served GroupInfo is an MlsMessageOut wire blob -> parse back to a VerifiableGroupInfo.
        let verifiable_group_info = match MlsMessageIn::tls_deserialize(&mut &group_info_bytes[..])
        {
            Ok(msg_in) => match msg_in.extract() {
                MlsMessageBodyIn::GroupInfo(gi) => gi,
                _ => return Err(MlsError::InvalidData),
            },
            Err(_) => return Err(MlsError::InvalidData),
        };

        let group_config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(2)
            .sender_ratchet_configuration(sender_ratchet_config())
            .build();

        let credential_with_key = CredentialWithKey {
            credential: self.credential.clone().into(),
            signature_key: self.keypair.public().into(),
        };

        // The ratchet tree travels inside the GroupInfo (exported with_ratchet_tree=true) -> no
        // explicit ratchet_tree needed. The builder API replaces the deprecated
        // join_by_external_commit (OpenMLS >= 0.7.1).
        let leaf_node_parameters = LeafNodeParameters::builder()
            .with_capabilities(Capabilities::default())
            .with_extensions(Extensions::default())
            .build();

        let (group, commit_message_bundle) = MlsGroup::external_commit_builder()
            .with_aad(b"".to_vec())
            .with_config(group_config.clone())
            .build_group(&self.provider, verifiable_group_info, credential_with_key)
            .map_err(|e| MlsError::OpenMls(format!("join_by_external_commit: {:?}", e)))?
            .leaf_node_parameters(leaf_node_parameters)
            .load_psks(self.provider.storage())
            .map_err(|e| MlsError::OpenMls(format!("join_by_external_commit load_psks: {:?}", e)))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.keypair,
                |_| true,
            )
            .map_err(|e| MlsError::OpenMls(format!("join_by_external_commit build: {:?}", e)))?
            .finalize(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("join_by_external_commit finalize: {:?}", e)))?;

        let (commit_msg_out, _welcome, _group_info) = commit_message_bundle.into_contents();

        let group_id = String::from_utf8_lossy(group.group_id().as_slice()).to_string();

        // Guard: never overwrite a live group we already hold (concurrent Welcome).
        if self.groups.contains_key(&group_id) {
            return Err(MlsError::OpenMls(format!(
                "join_by_external_commit: group {} already present locally",
                group_id
            )));
        }

        let commit = commit_msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;

        self.groups.insert(group_id.clone(), group);
        self.mark_state_dirty();
        Ok((group_id, commit))
    }

    /// Epoch-monotonic reload guard - the strictest invariant, shared by every context that
    /// replaces the live manager with one rebuilt from a persisted snapshot (native foreground
    /// resume, background engines). The mirror of the TS `swapClientMonotonic` (WebMlsService):
    /// a reload is only safe if every group the LIVE manager (`self`) holds is still present in
    /// `candidate` at an epoch >= the live one. Returns false (keep the live state) if any live
    /// group would disappear or move to a LOWER epoch, so a stale snapshot can never regress the
    /// epoch - the root-cause-1 invariant enforced at the reload boundary. [[C2]]
    pub fn reload_is_monotonic(&self, candidate: &MlsManager) -> bool {
        for gid in self.get_known_groups() {
            let Ok(live_epoch) = self.get_epoch(&gid) else {
                continue;
            };
            let ok = matches!(candidate.get_epoch(&gid), Ok(cand) if cand >= live_epoch);
            if !ok {
                log::warn!(
                    "[RELOAD] refused: group {}... would regress (live epoch={}, candidate absent-or-lower) - keeping live state",
                    gid.chars().take(8).collect::<String>(),
                    live_epoch
                );
                return false;
            }
        }
        true
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
}
