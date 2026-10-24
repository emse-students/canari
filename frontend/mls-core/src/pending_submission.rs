//! The submission of a staged commit, kept in the SAME state as the commit it describes, and
//! written by the SAME mutation that stages it.
//!
//! # Why it lives here and nowhere else
//!
//! A staged commit is submitted to the server's epoch gate and then merged or cleared. When the
//! submission gets no answer, the outcome is unknown, and the only definitive way to learn it is to
//! submit the SAME bytes again (the gate answers an already-accepted commit as a duplicate). Those
//! bytes - the commit, its successor base, its Welcome, and the client's own description of whom it
//! admits and removes - are not recoverable from openmls's pending commit, so they are kept beside it.
//!
//! Beside it IN THIS STATE, never in a second store: a record kept elsewhere can disagree with
//! `mls.bin`, and a pending commit nothing can settle is the very block this exists to remove.
//!
//! # Why the stage and the record are ONE call
//!
//! They used to be two: the client staged, then recorded. A checkpoint running between the two
//! exported a staged commit with no submission; the device then recorded, sent, and was killed
//! before the next checkpoint, and the reload read "no submission" as "never sent" and cleared a
//! commit the server had accepted. No ordering of the client's awaits closes that window - a
//! checkpoint does not take the MLS lock. So every `*_recorded` stage here builds the record from
//! its own output inside the same `&mut self` call, and an exported state holds a staged commit
//! together with its submission, or neither.
//!
//! The plain stages (`stage_self_update`, `remove_members_for_*`, `add_members_bulk*`,
//! `replace_device_with_base`) stay for the
//! callers that merge at once and never submit through the gate; a commit staged by one of them has
//! no submission and, if it is found pending after a restart, was never sent.
//!
//! # What this crate knows of the record
//!
//! The `intent` is the client's (who is excluded, whom it removes, which device each key package
//! is); this crate stores it opaquely and ties its lifetime to the pending commit: dropped by any new
//! stage, by the merge, by the clear and by a forget, and never served or persisted for a group
//! whose pending commit is gone (another member's commit, processed, clears ours).

use std::io::Cursor;

use ciborium::{de::from_reader, ser::into_writer};
use serde::{Deserialize, Serialize};

use crate::{MlsError, MlsManager, SkippedKeyPackage};

/// What a staged commit is submitted with, recorded by the stage itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingSubmission {
    /// The client's description of the commit (opaque here).
    #[serde(with = "crate::byte_compat::bytes")]
    pub intent: Vec<u8>,
    /// The epoch the commit was staged on - the one it moves the group FROM.
    pub base_epoch: u64,
    /// The commit, as sent.
    #[serde(with = "crate::byte_compat::bytes")]
    pub commit: Vec<u8>,
    /// The external-join base for the epoch the commit creates.
    #[serde(with = "crate::byte_compat::bytes")]
    pub group_info: Vec<u8>,
    /// An Add's Welcome; empty for any other commit.
    #[serde(with = "crate::byte_compat::bytes")]
    pub welcome: Vec<u8>,
    /// For an Add, the positions of the key packages actually included.
    pub added_indices: Vec<u32>,
}

/// What a group's state says about the submission of its staged commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingSubmissionRead {
    /// No staged commit, or one staged by a plain stage: never submitted through the gate.
    None,
    /// A record exists and cannot be decoded: the outcome of the commit is NOT known from it.
    Unreadable,
    /// The record, as the stage wrote it.
    Recorded(PendingSubmission),
}

impl MlsManager {
    /// Whether `group_id` holds a staged commit not yet merged or cleared.
    pub fn has_pending_commit(&self, group_id: &str) -> Result<bool, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        Ok(group.pending_commit().is_some())
    }

    /// Stages a refresh of this device's own leaf ([`Self::stage_self_update`]) and records its
    /// submission in the same call.
    pub fn stage_self_update_recorded(
        &mut self,
        group_id: &str,
        intent: Vec<u8>,
    ) -> Result<PendingSubmission, MlsError> {
        log::debug!("stage_self_update_recorded: {group_id}");
        let base_epoch = self.get_epoch(group_id)?;
        let (commit, group_info) = self.stage_self_update(group_id)?;
        self.record_staged(
            group_id,
            intent,
            base_epoch,
            commit,
            group_info,
            None,
            Vec::new(),
        )
    }

    /// Stages the removal of every device of `user_ids` ([`Self::remove_members_for_users`]) and
    /// records its submission in the same call.
    pub fn remove_members_for_users_recorded(
        &mut self,
        group_id: &str,
        user_ids: &[&str],
        intent: Vec<u8>,
    ) -> Result<PendingSubmission, MlsError> {
        log::debug!("remove_members_for_users_recorded: {group_id}");
        let base_epoch = self.get_epoch(group_id)?;
        let (commit, group_info) = self.remove_members_for_users(group_id, user_ids)?;
        self.record_staged(
            group_id,
            intent,
            base_epoch,
            commit,
            group_info,
            None,
            Vec::new(),
        )
    }

    /// Stages the removal of `device_identities` ([`Self::remove_members_for_devices`]) and records
    /// its submission in the same call.
    pub fn remove_members_for_devices_recorded(
        &mut self,
        group_id: &str,
        device_identities: &[&str],
        intent: Vec<u8>,
    ) -> Result<PendingSubmission, MlsError> {
        log::debug!("remove_members_for_devices_recorded: {group_id}");
        let base_epoch = self.get_epoch(group_id)?;
        let (commit, group_info) = self.remove_members_for_devices(group_id, device_identities)?;
        self.record_staged(
            group_id,
            intent,
            base_epoch,
            commit,
            group_info,
            None,
            Vec::new(),
        )
    }

    /// Stages an Add of `key_packages_bytes` ([`Self::add_members_bulk_with_base`]) and records its
    /// submission in the same call. The skipped key packages come back beside the record.
    /// `expected_identities[i]` is the device `key_packages_bytes[i]` was fetched for, checked as
    /// [`Self::add_members_bulk_with_base`] checks it.
    pub fn add_members_recorded(
        &mut self,
        group_id: &str,
        key_packages_bytes: &[&[u8]],
        expected_identities: &[&str],
        intent: Vec<u8>,
    ) -> Result<(PendingSubmission, Vec<SkippedKeyPackage>), MlsError> {
        log::debug!(
            "add_members_recorded: {group_id} ({} key packages)",
            key_packages_bytes.len()
        );
        let base_epoch = self.get_epoch(group_id)?;
        let ((commit, welcome, added_indices, skipped), group_info) =
            self.add_members_bulk_with_base(group_id, key_packages_bytes, expected_identities)?;
        let record = self.record_staged(
            group_id,
            intent,
            base_epoch,
            commit,
            group_info,
            welcome,
            added_indices,
        )?;
        Ok((record, skipped))
    }

    /// Stages the replacement of the device `identity` ([`Self::replace_device_with_base`]) and
    /// records its submission in the same call. Its Welcome is recorded like an Add's, so a settled
    /// replacement owes it to the device it re-admits; it adds no position of a key-package list.
    pub fn replace_device_recorded(
        &mut self,
        group_id: &str,
        identity: &str,
        key_package_bytes: &[u8],
        intent: Vec<u8>,
    ) -> Result<PendingSubmission, MlsError> {
        log::debug!("replace_device_recorded: {group_id}");
        let base_epoch = self.get_epoch(group_id)?;
        let (commit, welcome, group_info) =
            self.replace_device_with_base(group_id, identity, key_package_bytes)?;
        self.record_staged(
            group_id,
            intent,
            base_epoch,
            commit,
            group_info,
            Some(welcome),
            Vec::new(),
        )
    }

    /// Writes the record of the commit `group_id` just staged. Encoding cannot fail on these plain
    /// fields; if it ever did, the staged commit is cleared before the error returns, so nothing
    /// staged is left without its submission.
    #[allow(clippy::too_many_arguments)]
    fn record_staged(
        &mut self,
        group_id: &str,
        intent: Vec<u8>,
        base_epoch: u64,
        commit: Vec<u8>,
        group_info: Vec<u8>,
        welcome: Option<Vec<u8>>,
        added_indices: Vec<u32>,
    ) -> Result<PendingSubmission, MlsError> {
        let record = PendingSubmission {
            intent,
            base_epoch,
            commit,
            group_info,
            welcome: welcome.unwrap_or_default(),
            added_indices,
        };
        let mut bytes = Vec::new();
        if let Err(e) = into_writer(&record, &mut bytes) {
            log::error!(
                "record_staged: {group_id}: the record does not encode ({e}) - clearing the staged commit"
            );
            self.clear_pending_commit_for(group_id)?;
            return Err(MlsError::Serialization(format!("pending submission: {e}")));
        }
        log::debug!(
            "record_staged: {group_id} at epoch {base_epoch} ({} bytes)",
            bytes.len()
        );
        self.pending_submissions.insert(group_id.to_string(), bytes);
        self.mark_state_dirty();
        Ok(record)
    }

    /// The submission of `group_id`'s staged commit. See [`PendingSubmissionRead`].
    pub fn pending_submission(&self, group_id: &str) -> PendingSubmissionRead {
        if !matches!(self.has_pending_commit(group_id), Ok(true)) {
            return PendingSubmissionRead::None;
        }
        let Some(bytes) = self.pending_submissions.get(group_id) else {
            return PendingSubmissionRead::None;
        };
        match from_reader::<PendingSubmission, _>(Cursor::new(bytes)) {
            Ok(record) => PendingSubmissionRead::Recorded(record),
            Err(e) => {
                log::error!(
                    "pending_submission: {group_id}: the record of the staged commit does not decode ({e}) - its outcome cannot be learnt from it"
                );
                PendingSubmissionRead::Unreadable
            }
        }
    }

    /// Every group holding a staged commit, sorted - the ones a load must settle.
    pub fn groups_with_pending_commit(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .groups
            .iter()
            .filter(|(_, g)| g.pending_commit().is_some())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Drops `group_id`'s submission: its staged commit was merged, cleared, replaced or forgotten.
    pub(crate) fn drop_pending_submission(&mut self, group_id: &str) {
        if self.pending_submissions.remove(group_id).is_some() {
            log::debug!("drop_pending_submission: {}", group_id);
            self.mark_state_dirty();
        }
    }

    /// The submissions worth persisting: only those whose group still holds the staged commit.
    pub(crate) fn live_pending_submissions(&self) -> std::collections::HashMap<Vec<u8>, Vec<u8>> {
        self.pending_submissions
            .iter()
            .filter(|(id, _)| matches!(self.has_pending_commit(id), Ok(true)))
            .map(|(id, s)| (id.as_bytes().to_vec(), s.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_that_does_not_decode_is_unreadable_never_absent() {
        // "No record" proves the commit was never submitted; a record that cannot be read proves
        // nothing, so the two must never collapse into one answer.
        let mut alice = MlsManager::load_or_create("alice", "dev1", None).expect("alice");
        alice.create_group("g".to_string()).expect("group");
        alice
            .stage_self_update_recorded("g", b"{}".to_vec())
            .expect("stage");
        alice
            .pending_submissions
            .insert("g".to_string(), b"not cbor at all \xff".to_vec());
        assert_eq!(
            alice.pending_submission("g"),
            PendingSubmissionRead::Unreadable
        );
    }
}
