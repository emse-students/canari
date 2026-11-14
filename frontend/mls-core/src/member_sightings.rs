//! Who THIS DEVICE has seen hold a leaf in each group's tree, and from which epoch - the evidence
//! the uninvited-entry classifier reads to call an entrant a member coming back (owner, 2026-11-14:
//! *"Preuve sur l'appareil"*).
//!
//! # Why the device keeps its own record
//!
//! A user who enters a conversation by their own external commit while holding no leaf is either a
//! member coming back (every leaf of theirs went: a revoked device swept, a lost state, a new device)
//! or a person nobody admitted. The delivery service's roster cannot separate the two against the
//! party that question watches: a server that lets an outsider in can seat them on the roster it
//! serves. What a device CAN state on its own authority is what it saw in trees it verified itself -
//! a tree is accepted only through a Welcome or GroupInfo signed by a member's leaf, or a commit a
//! member signed and this device merged. So every tree that enters this device writes, per group and
//! per USER, the FIRST epoch at which that user held a leaf here. A user seen at an epoch before the
//! entering commit was a member of this group, whatever happened between.
//!
//! # Per user, never per device
//!
//! The record is keyed by the user half of the identity ([`canonical_user_of`]), so a member's new
//! device, a reinstall and a new key are all the same member: the evidence is that THE PERSON held a
//! leaf, never that one key did.
//!
//! # What it cannot know, and what that costs
//!
//! It holds only trees THIS device accepted. A device that joined after the person's every leaf left
//! has no sighting of them, and the classifier then calls the entry NOT PROVEN - never `returning` on
//! anybody's word. The failure direction is a line that accuses a member (noise, measured through the
//! report's `watchedFrom`), never a silent pass. `watched_from` names the first epoch this device's
//! record covers for a group, so a report separates "this device was not there yet" from "this device
//! watched the whole time and never saw them".
//!
//! # Retired is not proven (owner, 2026-11-14)
//!
//! A user whose EVERY leaf a commit removes, when that commit was made by ANOTHER user, loses their
//! sighting: an entry of theirs afterwards, with no member's Add, is not proven. A commit by the
//! user's own device removing their own leaves cancels nothing. In MLS a commit never removes its
//! own sender, so the user's LAST leaf always goes through another member's commit: the
//! own-device case keeps the sighting only while one of the user's devices stays in the tree.
//!
//! # Scoped to the lineage this device holds (review of #3519)
//!
//! Epochs are compared within ONE chain of trees: the one this device has held since it last
//! joined the group. A sighting from an earlier copy of the group is dropped when that copy goes
//! (`forget_group`) and when a fresh tree is joined (a Welcome, an external join of ours), because a
//! credential is self-asserted: a server that once handed this device a fabricated tree of the same
//! group id (signed by a leaf it made) could otherwise plant a sighting that a later heal into the
//! real group would carry over. The cost is more accusations after a heal - the failure direction
//! the design accepts, and measured.
//!
//! # Where it lives, and its bound
//!
//! Inside [`crate::device_trust::DeviceTrust`], persisted in the same sealed CBOR snapshot as the
//! MLS state (`PersistedState::member_sightings`), so it follows the account's state through a
//! restart, the native background engine, a backup restore and an account switch (each account has
//! its own state). A key group (classified `Open`) records nothing: every member enters it by
//! external commit by design, and its membership is the largest the device holds. The record is
//! bounded by the membership history of the conversations this device holds: past
//! [`SIGHTINGS_PRUNE_THRESHOLD`] the groups no longer held are dropped at load, and a held group's
//! sightings are NEVER evicted - an evicted sighting is a member accused later.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::device_trust::{LeafKey, canonical_user_of};

/// One user seen holding a leaf of one group's tree, as it is persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSighting {
    pub group_id: String,
    /// The user half of the identity, ASCII-lowercased ([`canonical_user_of`]).
    pub user_id: String,
    /// The FIRST epoch at which this device saw the user hold a leaf of the group's tree.
    pub epoch: u64,
}

/// Past this many sightings, the load drops those of groups no longer held. A held group's are kept
/// whatever the count, and the load says so at WARN.
pub const SIGHTINGS_PRUNE_THRESHOLD: usize = 65_536;

/// What this device can prove about one user in one group - [`MemberSightings::evidence`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipEvidence {
    /// The first epoch at which this device saw the user hold a leaf of the group, `None` when it
    /// never did. A sighting BEFORE an entering commit's epoch proves the entrant was a member.
    pub first_seen_epoch: Option<u64>,
    /// The first epoch this device's record covers for the group, `None` when it holds none. Never a
    /// verdict - the evidence a report carries so "not there yet" and "never saw them" are told apart.
    pub watched_from_epoch: Option<u64>,
}

/// The JSON the WASM binding hands TypeScript: `{ firstSeenEpoch, watchedFromEpoch }`.
pub fn evidence_json(evidence: &MembershipEvidence) -> Result<String, crate::MlsError> {
    serde_json::to_string(evidence).map_err(|e| crate::MlsError::Serialization(e.to_string()))
}

/// group id -> user -> first epoch seen.
#[derive(Debug, Default)]
pub struct MemberSightings {
    groups: HashMap<String, HashMap<String, u64>>,
}

impl MemberSightings {
    /// Rebuilds the record from its persisted form; a user named twice keeps the earlier epoch.
    pub(crate) fn from_persisted(sightings: Vec<MemberSighting>) -> Self {
        let mut out = Self::default();
        for s in sightings {
            out.note(&s.group_id, &s.user_id, s.epoch);
        }
        out
    }

    /// The persisted form, sorted so two saves of one record are byte-identical.
    pub(crate) fn persisted(&self) -> Vec<MemberSighting> {
        let sorted: BTreeMap<(&String, &String), u64> = self
            .groups
            .iter()
            .flat_map(|(g, users)| users.iter().map(move |(u, e)| ((g, u), *e)))
            .collect();
        sorted
            .into_iter()
            .map(|((group_id, user_id), epoch)| MemberSighting {
                group_id: group_id.clone(),
                user_id: user_id.clone(),
                epoch,
            })
            .collect()
    }

    /// How many sightings are held, over every group.
    pub fn len(&self) -> usize {
        self.groups.values().map(HashMap::len).sum()
    }

    /// Whether nothing is held.
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    /// Keeps the earlier of `epoch` and what is held for `(group_id, user_id)`.
    ///
    /// @returns whether the record changed.
    fn note(&mut self, group_id: &str, user_id: &str, epoch: u64) -> bool {
        let users = self.groups.entry(group_id.to_string()).or_default();
        match users.get_mut(user_id) {
            Some(held) if *held <= epoch => false,
            Some(held) => {
                *held = epoch;
                true
            }
            None => {
                users.insert(user_id.to_string(), epoch);
                true
            }
        }
    }

    /// Records every user holding a leaf of `leaves`, a tree of `group_id` this device accepted at
    /// `epoch`. Idempotent: a user already seen at an earlier epoch is left alone.
    ///
    /// @returns whether anything was written.
    pub(crate) fn record_tree(&mut self, group_id: &str, epoch: u64, leaves: &[LeafKey]) -> bool {
        let mut wrote = false;
        let mut fresh = 0usize;
        for (_, identity, _) in leaves {
            let Some(user) = canonical_user_of(identity) else {
                continue;
            };
            let was_new = !self
                .groups
                .get(group_id)
                .is_some_and(|users| users.contains_key(&user));
            if self.note(group_id, &user, epoch) {
                wrote = true;
                fresh += usize::from(was_new);
            }
        }
        if fresh > 0 {
            log::debug!(
                "[SIGHTINGS] {} epoch {epoch}: {fresh} user(s) seen in its tree for the first time",
                group_id.get(..8).unwrap_or(group_id)
            );
        }
        wrote
    }

    /// Cancels the sighting of `user_id` in `group_id`: the user was RETIRED - every leaf of theirs
    /// removed by another member's commit at `epoch` (owner, 2026-11-14: *"Retire = non prouve"*).
    /// An entry of theirs afterwards is not proven unless a tree shows them again (a member's Add).
    ///
    /// @returns whether a sighting was held.
    pub(crate) fn retire(&mut self, group_id: &str, user_id: &str, epoch: u64) -> bool {
        let Some(users) = self.groups.get_mut(group_id) else {
            return false;
        };
        let held = users.remove(user_id).is_some();
        if held {
            log::info!(
                "[SIGHTINGS] {} epoch {epoch}: {} retired by another member's commit - no longer proven a member",
                group_id.get(..8).unwrap_or(group_id),
                user_id.get(..8).unwrap_or(user_id)
            );
        }
        held
    }

    /// Forgets every sighting of `group_id`: the tree this device held is gone (`why`), and a
    /// sighting is evidence only within the LINEAGE it was seen in (module doc).
    ///
    /// @returns whether anything was dropped.
    pub(crate) fn forget_group(&mut self, group_id: &str, why: &str) -> bool {
        match self.groups.remove(group_id) {
            Some(users) => {
                log::info!(
                    "[SIGHTINGS] {}: {} sighting(s) dropped - {why}",
                    group_id.get(..8).unwrap_or(group_id),
                    users.len()
                );
                true
            }
            None => false,
        }
    }

    /// Past [`SIGHTINGS_PRUNE_THRESHOLD`], drops the sightings of groups not in `held_groups`; a held
    /// group's are kept whatever the count, and a record still past the threshold says so at WARN.
    ///
    /// @returns how many sightings were dropped.
    pub(crate) fn prune(&mut self, held_groups: &HashSet<&str>) -> usize {
        let before = self.len();
        if before <= SIGHTINGS_PRUNE_THRESHOLD {
            return 0;
        }
        self.groups
            .retain(|group_id, _| held_groups.contains(group_id.as_str()));
        let after = self.len();
        log::info!(
            "[SIGHTINGS] {} sighting(s) of groups this device no longer holds dropped ({after} kept, threshold {SIGHTINGS_PRUNE_THRESHOLD})",
            before - after
        );
        if after > SIGHTINGS_PRUNE_THRESHOLD {
            // Kept: an evicted sighting is a member accused at their next entry. The size is the
            // membership history of the conversations held, and this line is how it is watched.
            log::warn!(
                "[SIGHTINGS] {after} sightings in groups this device still holds - past the threshold \
                 ({SIGHTINGS_PRUNE_THRESHOLD}) and all kept"
            );
        }
        before - after
    }

    /// The first epoch at which `user_id` was seen in `group_id`, and the first epoch the record
    /// covers for the group.
    pub(crate) fn evidence(&self, group_id: &str, user_id: &str) -> MembershipEvidence {
        let user = user_id.to_ascii_lowercase();
        let users = self.groups.get(group_id);
        MembershipEvidence {
            first_seen_epoch: users.and_then(|u| u.get(&user).copied()),
            watched_from_epoch: users.and_then(|u| u.values().copied().min()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(identity: &str) -> LeafKey {
        (0, identity.to_string(), vec![1])
    }

    #[test]
    fn a_user_is_recorded_per_user_at_the_first_epoch_seen() {
        let mut s = MemberSightings::default();
        assert!(s.record_tree("g", 5, &[leaf("Alice:d1"), leaf("bob:d1"), leaf("bob:d2")]));
        // A later tree, a new device of the same user: nothing new.
        assert!(!s.record_tree("g", 9, &[leaf("alice:d3")]));
        assert_eq!(s.evidence("g", "ALICE").first_seen_epoch, Some(5));
        assert_eq!(s.evidence("g", "bob").first_seen_epoch, Some(5));
        assert_eq!(s.evidence("g", "carol").first_seen_epoch, None);
        assert_eq!(s.evidence("g", "carol").watched_from_epoch, Some(5));
        assert_eq!(
            s.evidence("other", "alice"),
            MembershipEvidence {
                first_seen_epoch: None,
                watched_from_epoch: None
            }
        );
    }

    #[test]
    fn an_earlier_tree_lowers_the_epoch_and_a_later_one_never_raises_it() {
        let mut s = MemberSightings::default();
        s.record_tree("g", 9, &[leaf("alice:d1")]);
        assert!(s.record_tree("g", 4, &[leaf("alice:d1")]));
        assert!(!s.record_tree("g", 12, &[leaf("alice:d1")]));
        assert_eq!(s.evidence("g", "alice").first_seen_epoch, Some(4));
    }

    #[test]
    fn the_persisted_form_round_trips_sorted() {
        let mut s = MemberSightings::default();
        s.record_tree("g2", 3, &[leaf("b:d")]);
        s.record_tree("g1", 1, &[leaf("z:d"), leaf("a:d")]);
        let persisted = s.persisted();
        let order: Vec<_> = persisted
            .iter()
            .map(|p| (p.group_id.as_str(), p.user_id.as_str()))
            .collect();
        assert_eq!(order, vec![("g1", "a"), ("g1", "z"), ("g2", "b")]);
        let back = MemberSightings::from_persisted(persisted.clone());
        assert_eq!(back.persisted(), persisted);
    }

    #[test]
    fn a_retired_user_is_no_longer_seen_and_a_later_tree_records_them_again() {
        let mut s = MemberSightings::default();
        s.record_tree("g", 2, &[leaf("bob:d1"), leaf("alice:d")]);
        assert!(s.retire("g", "bob", 5));
        assert!(!s.retire("g", "bob", 5));
        assert_eq!(s.evidence("g", "bob").first_seen_epoch, None);
        assert_eq!(s.evidence("g", "bob").watched_from_epoch, Some(2));
        // A member's Add shows bob again: seen from that epoch.
        s.record_tree("g", 9, &[leaf("bob:d2")]);
        assert_eq!(s.evidence("g", "bob").first_seen_epoch, Some(9));
        let back = MemberSightings::from_persisted(s.persisted());
        assert_eq!(back.evidence("g", "bob").first_seen_epoch, Some(9));
    }

    #[test]
    fn a_forgotten_group_is_dropped_whole() {
        let mut s = MemberSightings::default();
        s.record_tree("g", 1, &[leaf("a:d")]);
        assert!(!s.is_empty());
        assert!(s.forget_group("g", "test"));
        assert!(!s.forget_group("g", "test"));
        assert!(s.is_empty());
    }

    #[test]
    fn the_prune_drops_only_groups_no_longer_held_and_only_past_the_threshold() {
        let mut s = MemberSightings::default();
        s.record_tree("held", 1, &[leaf("a:d")]);
        s.record_tree("gone", 1, &[leaf("a:d")]);
        let held: HashSet<&str> = ["held"].into_iter().collect();
        assert_eq!(s.prune(&held), 0, "under the threshold nothing goes");
        for i in 0..SIGHTINGS_PRUNE_THRESHOLD {
            s.note("gone", &format!("u{i}"), 1);
        }
        assert_eq!(s.prune(&held), SIGHTINGS_PRUNE_THRESHOLD + 1);
        assert_eq!(s.evidence("held", "a").first_seen_epoch, Some(1));
        assert_eq!(s.evidence("gone", "a").first_seen_epoch, None);
    }
}
