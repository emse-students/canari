//! An Add's Welcome still owed to the devices it admits, kept in the state until each is sent.
//!
//! # Why it is state and not a loop
//!
//! EVERY accepted Add is merged by a call that records "this Welcome is owed to these devices"
//! ([`MlsManager::merge_pending_commit_owing_welcome`]) - the transaction that got the accept as well
//! as a later settlement of a kept Add. The Welcome is a SEPARATE request made after the accept, so
//! a merge that left the obligation in memory lost it to any reload before the send: the group was
//! merged on disk, nothing owed the Welcome, and only the invitee's own repair let it in (DUP-7,
//! 2026-10-25). The client sends, and clears each recipient as its send is answered
//! ([`MlsManager::welcome_delivered`]); a reload re-sends at most the recipients not yet cleared,
//! never the whole Add, and never re-merges it. The ratchet tree is captured at the merge: the
//! joiner needs the tree of the epoch the Add created, and the group may have moved on by then.
//!
//! # Several Adds of one group
//!
//! A group can owe the Welcomes of SEVERAL Adds (a send that failed, then another Add that merged),
//! so a group's record is a list, one entry per Add. A later Add that admits a device an earlier
//! entry still names SUPERSEDES that recipient - the earlier leaf was replaced, its Welcome opens
//! nothing - so a device is named by at most one entry of its group, and "this device was sent its
//! Welcome" is unambiguous. A record written by a build before the list (one entry, bare) still
//! reads.

use std::io::Cursor;

use ciborium::{de::from_reader, ser::into_writer};
use serde::{Deserialize, Serialize};

use crate::pending_submission::PendingSubmissionRead;
use crate::{MlsError, MlsManager};

/// One Add's owed Welcome.
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

/// A group's record, as stored: a list of entries (the bare-entry shape of earlier builds reads too).
fn decode_entries(group_id: &str, bytes: &[u8]) -> Result<Vec<OwedWelcome>, String> {
    let mut entries = match from_reader::<Vec<OwedWelcome>, _>(Cursor::new(bytes)) {
        Ok(list) => list,
        // LEGACY: one bare entry per group, written by builds before the list (legacy-compatibility.md).
        Err(list_err) => match from_reader::<OwedWelcome, _>(Cursor::new(bytes)) {
            Ok(one) => vec![one],
            Err(e) => return Err(format!("{list_err} / {e}")),
        },
    };
    for w in &mut entries {
        w.group_id = group_id.to_string();
    }
    Ok(entries)
}

impl MlsManager {
    /// Merges `group_id`'s staged Add - which the commit gate has accepted - and, in the same call,
    /// records its Welcome as owed to `recipients`, beside any Welcome of an earlier Add the group
    /// still owes (a recipient this Add admits again is owed only this one). Refused, with nothing
    /// moved, when the staged commit carries no recorded Welcome: that commit is merged plainly.
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
        // THE MERGE HAS HAPPENED, SO THE OBLIGATION IS RECORDED WHATEVER THE EXPORT SAYS: an error
        // here would leave a merged Add owing nothing. A tree that cannot be exported is recorded
        // empty and the Welcome goes without one - the joiner then needs its own repair, which is
        // what nothing owed would have cost too, and it is said at the level that accuses.
        let ratchet_tree = self.export_ratchet_tree_for(group_id).unwrap_or_else(|e| {
            log::error!(
                "merge_pending_commit_owing_welcome: {group_id}: the ratchet tree of the merged Add could not be exported ({e}) - the Welcome is owed without it"
            );
            Vec::new()
        });
        let mut entries = self.owed_entries(group_id);
        for earlier in &mut entries {
            let before = earlier.recipients.len();
            earlier.recipients.retain(|r| !recipients.contains(r));
            if earlier.recipients.len() < before {
                log::warn!(
                    "merge_pending_commit_owing_welcome: {group_id}: {} recipient(s) of an earlier owed Welcome admitted again - superseded",
                    before - earlier.recipients.len()
                );
            }
        }
        entries.retain(|w| !w.recipients.is_empty());
        entries.push(OwedWelcome {
            group_id: group_id.to_string(),
            welcome,
            ratchet_tree,
            recipients,
        });
        self.store_owed_entries(group_id, entries);
        Ok(())
    }

    /// Every Welcome still owed, by group (sorted; a group's Adds in the order they merged), each
    /// with the recipients not yet sent it. A record that does not decode is said and skipped: its
    /// joiners repair by their own welcome request, and the record is dropped at the next save.
    pub fn owed_welcomes(&self) -> Vec<OwedWelcome> {
        let mut groups: Vec<&String> = self.owed_welcomes.keys().collect();
        groups.sort();
        groups
            .into_iter()
            .flat_map(|gid| self.owed_entries(gid))
            .collect()
    }

    /// `recipient` was answered for THE `welcome` it was sent in `group_id`: the entry carrying
    /// those bytes owes it no longer. Matched by the bytes, never by the device alone: a send of an
    /// older Welcome that completes after a re-admission merged a newer one must not clear the newer
    /// one (the merge already superseded the older entry's recipient, so it clears nothing).
    pub fn welcome_delivered(&mut self, group_id: &str, recipient: &str, welcome: &[u8]) {
        let mut entries = self.owed_entries(group_id);
        let Some(entry) = entries
            .iter_mut()
            .find(|w| w.welcome == welcome && w.recipients.iter().any(|r| r == recipient))
        else {
            log::debug!(
                "welcome_delivered: {group_id} -> {recipient}: nothing owed for that Welcome"
            );
            return;
        };
        entry.recipients.retain(|r| r != recipient);
        entries.retain(|w| !w.recipients.is_empty());
        log::debug!(
            "welcome_delivered: {group_id} -> {recipient} ({} recipient(s) still owed)",
            entries.iter().map(|w| w.recipients.len()).sum::<usize>()
        );
        self.store_owed_entries(group_id, entries);
    }

    /// `group_id`'s entries; a record that does not decode is said and read as none.
    fn owed_entries(&self, group_id: &str) -> Vec<OwedWelcome> {
        let Some(bytes) = self.owed_welcomes.get(group_id) else {
            return Vec::new();
        };
        decode_entries(group_id, bytes).unwrap_or_else(|e| {
            log::error!(
                "owed_welcomes: {group_id}: the owed Welcome does not decode ({e}) - its joiners must ask again"
            );
            Vec::new()
        })
    }

    fn store_owed_entries(&mut self, group_id: &str, entries: Vec<OwedWelcome>) {
        if entries.is_empty() {
            self.drop_owed_welcome(group_id);
            return;
        }
        let mut bytes = Vec::new();
        if let Err(e) = into_writer(&entries, &mut bytes) {
            // Byte strings and strings into a Vec: not reachable, and said if it ever is.
            log::error!(
                "store_owed_entries: {group_id}: does not encode ({e}) - its joiners must ask again"
            );
            return;
        }
        self.owed_welcomes.insert(group_id.to_string(), bytes);
        self.mark_state_dirty();
    }

    /// Drops `group_id`'s owed Welcomes: all sent, or the group forgotten.
    pub(crate) fn drop_owed_welcome(&mut self, group_id: &str) {
        if self.owed_welcomes.remove(group_id).is_some() {
            log::debug!("drop_owed_welcome: {group_id}");
            self.mark_state_dirty();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(recipient: &str) -> OwedWelcome {
        OwedWelcome {
            group_id: String::new(),
            welcome: vec![3],
            ratchet_tree: vec![7],
            recipients: vec![recipient.to_string()],
        }
    }

    #[test]
    fn a_bare_entry_written_before_the_list_still_reads() {
        let mut legacy = Vec::new();
        into_writer(&entry("bob:dev1"), &mut legacy).expect("encode");
        let read = decode_entries("g", &legacy).expect("legacy decodes");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].group_id, "g");
        assert_eq!(read[0].recipients, vec!["bob:dev1"]);
    }

    #[test]
    fn a_list_reads_back_in_order() {
        let mut bytes = Vec::new();
        into_writer(&vec![entry("bob:dev1"), entry("carol:dev1")], &mut bytes).expect("encode");
        let read = decode_entries("g", &bytes).expect("list decodes");
        let names: Vec<_> = read.iter().map(|w| w.recipients[0].as_str()).collect();
        assert_eq!(names, vec!["bob:dev1", "carol:dev1"]);
    }

    #[test]
    fn bytes_that_are_neither_shape_are_refused() {
        assert!(decode_entries("g", &[0xff, 0x00]).is_err());
    }
}
