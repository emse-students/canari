//! The submission of a staged commit, kept in the SAME state as the commit it describes.
//!
//! # Why it lives here and nowhere else
//!
//! A staged commit is submitted to the server's epoch gate and then merged or cleared. When the
//! submission gets no answer, the outcome is unknown, and the only definitive way to learn it is to
//! submit the SAME bytes again (the gate answers an already-accepted commit as a duplicate). Those
//! bytes - the commit, its successor base, whom it admits and removes, its Welcome - are not
//! recoverable from openmls's pending commit, so they are kept beside it.
//!
//! Beside it IN THIS STATE, never in a second store: a record kept elsewhere can disagree with
//! `mls.bin` (a crash between the two writes leaves a pending commit nothing can settle, which is
//! the very block this exists to remove). Here both are one snapshot, so a persisted pending commit
//! either carries its submission or never had one.
//!
//! # The invariant the caller keeps
//!
//! The submission is recorded BEFORE the first request is sent. So a pending commit found WITHOUT a
//! submission was never sent, and clearing it is definitive - not a guess.
//!
//! The submission itself is opaque here (the client's own encoding); this crate only ties its
//! lifetime to the pending commit: recorded on a staged commit, dropped by any new stage, by the
//! merge, by the clear and by a forget, and never served or persisted for a group whose pending
//! commit is gone (another member's commit, processed, clears ours).

use crate::{MlsError, MlsManager};

impl MlsManager {
    /// Whether `group_id` holds a staged commit not yet merged or cleared.
    pub fn has_pending_commit(&self, group_id: &str) -> Result<bool, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        Ok(group.pending_commit().is_some())
    }

    /// Records the submission of `group_id`'s staged commit (see the module docs: BEFORE the first
    /// request). Refused when the group holds no staged commit - a submission belongs to one.
    pub fn record_pending_submission(
        &mut self,
        group_id: &str,
        submission: Vec<u8>,
    ) -> Result<(), MlsError> {
        if !self.has_pending_commit(group_id)? {
            log::warn!(
                "record_pending_submission: {} holds no staged commit - nothing to attach it to",
                group_id
            );
            return Err(MlsError::InvalidData);
        }
        log::debug!(
            "record_pending_submission: {} ({} bytes)",
            group_id,
            submission.len()
        );
        self.pending_submissions
            .insert(group_id.to_string(), submission);
        self.mark_state_dirty();
        Ok(())
    }

    /// The submission of `group_id`'s staged commit, or `None` when it has no staged commit or the
    /// staged commit was never submitted.
    pub fn pending_submission(&self, group_id: &str) -> Option<Vec<u8>> {
        if !matches!(self.has_pending_commit(group_id), Ok(true)) {
            return None;
        }
        self.pending_submissions.get(group_id).cloned()
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
