//! Who may enter a group on their own: the admission policy of one group, and the rule that judges it.
//!
//! # Why the rule exists
//!
//! An external commit adds its own sender, and the delivery service holds every group info, so a
//! service under hostile control can build one for an identity of its choosing and hand it to every
//! member. A CLOSED group's rule names an external commit whose user holds no leaf yet an entry no
//! member made: such a person is meant to enter through a member's own Add (`Sender::Member`), a
//! human decision signed by that member's leaf, which is never judged here.
//!
//! # THE RULE IS DISARMED: it judges, and nothing is refused (owner, 2026-10-31)
//!
//! #2815 refused such a commit unmerged and froze the group. Legitimate paths produce exactly that
//! commit - a peer whose KeyPackage was skipped at creation (a 1:1 included), a user whose only
//! device was revoked so the stray sweep removed its leaf, a user whose only leaf was evicted while
//! the seat stands - and a frozen group dropped every later frame for good. So the verdict is
//! computed and logged, and the commit is MERGED as it always was; the entry is still reported by
//! the device observers (`[UNINVITED_ENTRY]` on the server), the count the fix-forward is read on.
//! What the fix-forward owes before the rule refuses anything again is in
//! `docs/wiki/protocols/mls-protocol.md` ("the admission rule is disarmed").
//!
//! # The rule is a function of the tree and the commit, and nothing else
//!
//! Two honest members at the same epoch hold the same tree (its hash is in the group context and the
//! confirmation tag fails otherwise), so they reach the same verdict whenever each one processes the
//! commit - a member that replays late judges it at the same epoch an up-to-date one did. Nothing
//! else is read: no server roster, no clock, no conversation state. It is judged on the tree BEFORE
//! the commit, where a device rejoining after losing its state still has its old leaf.
//!
//! # Three states, and why "unclassified" exists
//!
//! `mls-core` cannot tell a conversation from a community's key group, whose members enter by
//! external commit by design. The app can (a conversation has a row, a key group never does) and
//! classifies each group it holds ([`MlsManager::set_admission_policy`]). A group nobody classified
//! yet - every group of a state written before this field, until a session classifies it - keeps the
//! behaviour it always had: its external commits are merged. Closing such a group by default would
//! make the background engine refuse every community newcomer right after an update, before the app
//! ever ran. The policy is keyed by group id, not by the group's presence, so it survives a
//! `forget_group` (half of a forget-and-re-Welcome heal) and can be set before the group exists.

use serde::{Deserialize, Serialize};

use crate::device_trust::canonical_user_of;
use crate::state::MlsManager;

/// How a group treats an external commit from a user who holds no leaf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdmissionPolicy {
    /// Such a commit is judged [`AdmissionVerdict::Uninvited`]: a conversation. Merged anyway while
    /// the rule is disarmed (module doc).
    Closed,
    /// Such a commit is merged: a community or salon key group, entered by external commit.
    Open,
}

impl AdmissionPolicy {
    /// The stable wire name, identical in WASM, Tauri and TypeScript.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
        }
    }

    /// The policy a wire name stands for, `None` for any other string (including `unclassified`).
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "closed" => Some(Self::Closed),
            "open" => Some(Self::Open),
            _ => None,
        }
    }
}

impl MlsManager {
    /// Classifies `group_id`. Keyed by id and independent of whether the group is held, so it may be
    /// set before a join and outlives a `forget_group`. Logged, because a policy change is the one
    /// thing that decides whether an entry is refused.
    pub fn set_admission_policy(&mut self, group_id: &str, policy: AdmissionPolicy) {
        let previous = self.admission.insert(group_id.to_string(), policy);
        if previous != Some(policy) {
            // The state is cached between saves and rebuilt only when dirty: without this a policy
            // set after a save would be missing from the next one, and lost at the next restart.
            self.state_snapshot.borrow_mut().invalidate();
            log::info!(
                "[ADMISSION] group {} is now {} (was {})",
                group_id.get(..8).unwrap_or(group_id),
                policy.as_str(),
                previous.map_or("unclassified", AdmissionPolicy::as_str)
            );
        }
    }

    /// The policy `group_id` was classified with, `None` when nobody did (the legacy behaviour).
    pub fn admission_policy(&self, group_id: &str) -> Option<AdmissionPolicy> {
        self.admission.get(group_id).copied()
    }
}

/// Whether `tree` (every leaf's `userId:deviceId`, as the group's members before a commit) holds a
/// leaf of the user `entrant` names - under the one canonical user, so a spelling of a member's id is
/// never taken for a stranger, and a stranger never borrows a member's device id.
pub(crate) fn tree_holds_user(tree: &[String], entrant: &str) -> bool {
    let Some(wanted) = canonical_user_of(entrant) else {
        return false;
    };
    tree.iter()
        .any(|leaf| canonical_user_of(leaf).as_deref() == Some(wanted.as_str()))
}

/// What the admission rule says of one external commit ([`judge_external_commit`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionVerdict {
    /// The group is not closed, or the entrant's user already holds a leaf: nothing to say.
    Admitted,
    /// A CLOSED group, and the entrant's user holds no leaf - no member added them. Carries the
    /// entrant (`userId:deviceId`), `None` when its credential is unreadable. While the rule is
    /// disarmed this is logged and the commit is MERGED anyway (see the module doc).
    Uninvited(Option<String>),
}

/// Judges an EXTERNAL commit on a group's policy and its tree before the commit - a pure function of
/// its arguments, so two honest members at the same epoch reach the same verdict whenever each one
/// processes the commit.
///
/// `entrant` is the commit's verified sender - for an external commit, the joiner itself - `None`
/// when its credential is unreadable, which a closed group cannot vouch for. Only external commits
/// are asked: a member's commit is signed by a leaf already in the tree, and what it adds is that
/// member's decision.
pub fn judge_external_commit(
    policy: Option<AdmissionPolicy>,
    tree_before: &[String],
    entrant: Option<&str>,
) -> AdmissionVerdict {
    if policy != Some(AdmissionPolicy::Closed) {
        return AdmissionVerdict::Admitted;
    }
    match entrant {
        Some(identity) if tree_holds_user(tree_before, identity) => AdmissionVerdict::Admitted,
        other => AdmissionVerdict::Uninvited(other.map(str::to_string)),
    }
}
