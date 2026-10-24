//! An Add's Welcome still owed to the devices it admits, kept in the state until each is sent.
//!
//! # Why it is state and not a loop
//!
//! A kept Add that a later resubmission finds accepted is merged by the SETTLEMENT, not by the call
//! that staged it - that call is gone - so the settlement also sends its Welcome. It used to merge,
//! send, and leave the checkpoint for later; a reload in between found the Add still staged (the
//! merge had not reached disk), settled it again, and sent every Welcome a second time.
//!
//! So the merge itself writes "this Welcome is owed to these devices" in the same call
//! ([`MlsManager::merge_pending_commit_owing_welcome`]), the client checkpoints, sends, and clears
//! each recipient as it goes ([`MlsManager::welcome_delivered`]). A reload re-sends at most the
//! recipients not yet cleared, never the whole Add, and never re-merges it. The ratchet tree is
//! captured at the merge: the joiner needs the tree of the epoch the Add created, and the group may
//! have moved on by the time a re-send runs.

use std::io::Cursor;

use ciborium::{de::from_reader, ser::into_writer};
use serde::{Deserialize, Serialize};

use crate::pending_submission::PendingSubmissionRead;
use crate::{MlsError, MlsManager};

/// One group's owed Welcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwedWelcome {
    /// The group the Welcome joins. Not persisted inside the record (it is the map key).
    #[serde(skip)]
    pub group_id: String,
    /// The Welcome, as the Add's stage produced it.
    #[serde(with = "crate::byte_compat::bytes")]
    pub welcome: Vec<u8>,
    /// The ratchet tree of the epoch the Add created, exported by the merge.
    #[serde(with = "crate::byte_compat::bytes")]
    pub ratchet_tree: Vec<u8>,
    /// The devices (`userId:deviceId`) not yet sent it.
    pub recipients: Vec<String>,
}

impl MlsManager {
    /// Merges `group_id`'s staged Add - which the commit gate has accepted - and, in the same call,
    /// records its Welcome as owed to `recipients`. Refused, with nothing moved, when the staged
    /// commit carries no recorded Welcome: that commit is merged plainly.
    pub fn merge_pending_commit_owing_welcome(
        &mut self,
        group_id: &str,
        recipients: Vec<String>,
    ) -> Result<(), MlsError> {
        log::debug!(
            "merge_pending_commit_owing_welcome: {group_id} ({} recipients)",
            recipients.len()
        );
        let welcome = match self.pending_submission(group_id) {
            PendingSubmissionRead::Recorded(r) if !r.welcome.is_empty() => r.welcome,
            other => {
                log::warn!(
                    "merge_pending_commit_owing_welcome: {group_id}: no recorded Welcome beside the staged commit ({}) - nothing merged",
                    match other {
                        PendingSubmissionRead::None => "no record",
                        PendingSubmissionRead::Unreadable => "unreadable record",
                        PendingSubmissionRead::Recorded(_) => "not an Add",
                    }
                );
                return Err(MlsError::InvalidData);
            }
        };
        self.merge_pending_commit_for(group_id)?;
        let ratchet_tree = self.export_ratchet_tree_for(group_id)?;
        let owed = OwedWelcome {
            group_id: group_id.to_string(),
            welcome,
            ratchet_tree,
            recipients,
        };
        self.store_owed_welcome(owed);
        Ok(())
    }

    /// Every Welcome still owed, by group (sorted), each with the recipients not yet sent it.
    /// A record that does not decode is said and skipped: its joiners repair by their own welcome
    /// request, and the record is dropped at the next save.
    pub fn owed_welcomes(&self) -> Vec<OwedWelcome> {
        let mut out: Vec<OwedWelcome> = self
            .owed_welcomes
            .iter()
            .filter_map(|(gid, bytes)| {
                match from_reader::<OwedWelcome, _>(Cursor::new(bytes)) {
                    Ok(mut w) => {
                        w.group_id = gid.clone();
                        Some(w)
                    }
                    Err(e) => {
                        log::error!(
                            "owed_welcomes: {gid}: the owed Welcome does not decode ({e}) - its joiners must ask again"
                        );
                        None
                    }
                }
            })
            .collect();
        out.sort_by(|a, b| a.group_id.cmp(&b.group_id));
        out
    }

    /// `recipient` was sent `group_id`'s owed Welcome: it is owed to it no longer.
    pub fn welcome_delivered(&mut self, group_id: &str, recipient: &str) {
        let Some(mut owed) = self
            .owed_welcomes()
            .into_iter()
            .find(|w| w.group_id == group_id)
        else {
            log::debug!("welcome_delivered: {group_id}: nothing owed");
            return;
        };
        owed.recipients.retain(|r| r != recipient);
        log::debug!(
            "welcome_delivered: {group_id} -> {recipient} ({} still owed)",
            owed.recipients.len()
        );
        if owed.recipients.is_empty() {
            self.drop_owed_welcome(group_id);
        } else {
            self.store_owed_welcome(owed);
        }
    }

    fn store_owed_welcome(&mut self, owed: OwedWelcome) {
        let mut bytes = Vec::new();
        if let Err(e) = into_writer(&owed, &mut bytes) {
            // Byte strings and strings into a Vec: not reachable, and said if it ever is.
            log::error!(
                "store_owed_welcome: {}: does not encode ({e}) - its joiners must ask again",
                owed.group_id
            );
            return;
        }
        self.owed_welcomes.insert(owed.group_id.clone(), bytes);
        self.mark_state_dirty();
    }

    /// Drops `group_id`'s owed Welcome: all sent, or the group forgotten.
    pub(crate) fn drop_owed_welcome(&mut self, group_id: &str) {
        if self.owed_welcomes.remove(group_id).is_some() {
            log::debug!("drop_owed_welcome: {group_id}");
            self.mark_state_dirty();
        }
    }
}
