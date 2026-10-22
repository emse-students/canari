//! The periodic leaf refresh: an empty commit WITH a path, for post-compromise security.
//!
//! **WHY IT EXISTS.** MLS heals a compromised leaf only when that leaf is replaced. Until 2026-10-22
//! nothing in this product ever replaced one - a device kept the HPKE key it was admitted with for
//! as long as it stayed in the group - so a device whose leaf secrets leaked once stayed readable to
//! whoever held the copy, epoch after epoch. A refresh draws a fresh leaf key and fresh path secrets
//! from this device to the root, and every epoch after it is out of reach of the old copy.
//!
//! **WHAT IT IS NOT.** It does not rotate the signature key: one key signs this device's leaves in
//! every group and its published KeyPackages, so rotating it per group would split the device's
//! identity. A stolen signature key is answered by removing the device (revocation), not by this.
//!
//! **WHEN** is the caller's decision (`frontend/src/lib/mls-client/leafRefresh.ts`); this module only
//! stages the commit and reports how old the current leaf is. See
//! `docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh`.
use openmls::prelude::*;
use openmls::treesync::LeafNodeSource;
use tls_codec::Serialize as TlsSerialize;

use crate::state::MlsManager;
use crate::{MlsError, StagedRemovalResult};

/// OpenMLS backdates a KeyPackage's `not_before` by this much for clock skew
/// (`DEFAULT_KEY_PACKAGE_LIFETIME_MARGIN_SECONDS`, private in openmls 0.9.1). Every package this crate
/// mints takes the default lifetime, so adding it back gives the instant the key material was made.
const KEY_PACKAGE_LIFETIME_MARGIN_SECONDS: u64 = 60 * 60;

/// Result of [`MlsManager::stage_self_update`]: `(commit, group_info)`, under the same rule as
/// [`StagedRemovalResult`] - the base describes the epoch the commit CREATES and travels with it.
pub type StagedSelfUpdateResult = StagedRemovalResult;

impl MlsManager {
    /// Stages a refresh of this device's own leaf in `group_id`: a commit carrying an UpdatePath and
    /// NO proposal. Returns the commit and the external-join base for the epoch it creates.
    ///
    /// **STAGED, NEVER MERGED HERE** ([[C7]] Option A, like every commit in this crate): the caller
    /// submits it, then `merge_pending_commit_for` on the server's accept or
    /// `clear_pending_commit_for` on its refusal - a refused refresh leaves no fork.
    ///
    /// **THE PROPOSAL STORE IS NOT CONSUMED.** `MlsGroup::self_update` commits every queued proposal
    /// along with the update, and a queued proposal can be an external one this device never
    /// decided on - an Add among them would make a routine refresh admit somebody. So the commit is
    /// built with `consume_proposal_store(false)` and `force_self_update(true)`: it replaces this
    /// leaf and changes nothing else, which is what lets every consumer treat it as neither a
    /// departure nor an arrival.
    ///
    /// Refused while another commit is pending: staging a second would overwrite the first's
    /// pending state, and the server's answer would then merge the wrong one.
    pub fn stage_self_update(
        &mut self,
        group_id: &str,
    ) -> Result<StagedSelfUpdateResult, MlsError> {
        log::debug!("[LEAF_REFRESH] staging a self-update on {group_id}");
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        if group.pending_commit().is_some() {
            log::warn!(
                "[LEAF_REFRESH] {group_id}: another commit is pending - the refresh is not staged"
            );
            return Err(MlsError::OpenMls(format!(
                "self-update refused on {group_id}: a commit is already pending"
            )));
        }

        let bundle = group
            .commit_builder()
            .consume_proposal_store(false)
            .force_self_update(true)
            .load_psks(self.provider.storage())
            .map_err(|e| MlsError::OpenMls(format!("SelfUpdate psks error: {e:?}")))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.keypair,
                |_| true,
            )
            .map_err(|e| MlsError::OpenMls(format!("SelfUpdate build error: {e:?}")))?
            .stage_commit(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("SelfUpdate stage error: {e:?}")))?;

        self.mark_state_dirty();
        let (commit_out, _welcome, group_info) = bundle.into_contents();
        let commit = commit_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(e.to_string()))?;
        let base = crate::members::successor_base(group_info, group_id)?;
        log::info!("[LEAF_REFRESH] {group_id}: self-update staged, awaiting the server's answer");
        Ok((commit, base))
    }

    /// When this device's leaf in `group_id` was minted, in Unix seconds - or `None` once the leaf
    /// has been replaced by a commit (a refresh, or an external join).
    ///
    /// A leaf ADMITTED from a KeyPackage keeps that package's lifetime, and its `not_before` (less
    /// the openmls skew margin) is the instant the key material was made: the age of the leaf is
    /// read from the TREE, so it survives any loss of the caller's own bookkeeping. A leaf produced
    /// by a commit carries no lifetime at all, so for those the caller keeps the date itself.
    pub fn own_leaf_minted_at(&self, group_id: &str) -> Result<Option<u64>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        let Some(leaf) = group.own_leaf_node() else {
            log::warn!("[LEAF_REFRESH] {group_id}: no own leaf in the tree - nothing to date");
            return Ok(None);
        };
        Ok(match leaf.leaf_node_source() {
            LeafNodeSource::KeyPackage(lifetime) => Some(
                lifetime
                    .not_before()
                    .saturating_add(KEY_PACKAGE_LIFETIME_MARGIN_SECONDS),
            ),
            LeafNodeSource::Update | LeafNodeSource::Commit(_) => None,
        })
    }
}
