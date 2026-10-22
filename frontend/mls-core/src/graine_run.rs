//! The departure tracker Graine's outbound rotation reads: one CLEAN RUN per group.
//!
//! # What a run claims, and why it lives here
//!
//! A run names a chain of epochs of one group instance, every transition of which this manager
//! MERGED ITSELF and none of which removed a leaf or brought in a new user. A Graine session minted
//! inside a run may keep sealing after the epoch moves, as long as the run is still the same: nobody
//! who held its seed has left, and nobody new can open what it sealed before they came
//! (`docs/wiki/protocols/graine-removal-tracker.md`).
//!
//! It is the durable, LOCAL record "a removal was applied since this seed was minted": written by
//! each device for itself, at its own merge, never shared - not the shared "somebody left" marker
//! the old rotation comment refused.
//!
//! The run is kept in the MLS STATE, beside the tree it describes, and not in Graine storage as the
//! first draft of the design had it. Three reasons, each a way the draft could be wrong:
//!
//! - **Every merge goes through this crate.** A received commit (`process_incoming_on_group`, single
//!   and batch) and our own (`merge_pending_commit_for`) are the only two places a group instance
//!   moves to its next epoch, on every platform and in every process - the native background paths
//!   included, since they run this same crate. Feeding a TypeScript tracker from seven call sites is
//!   seven places to forget one.
//! - **One durable slot.** The run is serialised in the same `mls.bin` as the tree, by the same
//!   checkpoint, so "tracker written, state not" and its reverse cannot exist.
//! - **The fingerprint, not the authenticator, leaves the crate.** The epoch authenticator is a
//!   secret meant for out-of-band comparison (RFC 9420 section 8.7). What is compared and stored
//!   outside is a domain-separated hash of it, bound to the group id and the epoch number.
//!
//! # What ends a run: ANY removal, and a new user
//!
//! The identity-set comparison was refused on 2026-10-22: a leaf added and removed between two sends
//! is in neither set. The run is instead ended, at the merge, by the commit itself:
//!
//! - **Any Remove proposal the commit carries**, counted on the staged commit before it is merged -
//!   an external commit's removal of the joiner's own old leaf included. A device that leaves and
//!   comes back under the same identity, even the same key, has still been removed once, and the
//!   run does not try to decide whether its comeback undid that.
//! - **Any `(credential, signature key)` pair the commit took out of the tree**, from a diff of the
//!   tree on both sides of the merge. That covers whatever removes a leaf without a Remove proposal
//!   (an update that swaps a credential or a key), with no list of proposal shapes to keep current.
//! - **A NEW USER**: a leaf whose user had no leaf before the commit ([`ROTATE_ON_NEW_USER`]). Only a
//!   new DEVICE of a user already present continues the run.

use std::collections::HashMap;

use openmls::prelude::*;
use openmls_traits::OpenMlsProvider;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::random::OpenMlsRand;
use openmls_traits::types::HashType;
use serde::{Deserialize, Serialize};
use tls_codec::Serialize as TlsSerialize;

use crate::MlsError;
use crate::members::credential_identity;
use crate::state::MlsManager;

/// Domain separation for [`epoch_fingerprint`], so the hash can collide with no other use of the
/// authenticator.
const FINGERPRINT_DOMAIN: &[u8] = b"canari/graine-run/epoch-fingerprint/v1";

/// **THE ONE RULE FOR AN ADD: a new USER ends the run, a new DEVICE of a user already in the tree
/// does not.** Pending the user's confirmation (decision D5, 2026-10-22).
///
/// Why a new user rotates: a newcomer handed a seed minted before it arrived can derive every index
/// of that session (each message key is derived from the seed, not ratcheted), and the floor that
/// hides the earlier ones is policy, enforced only by an honest client. Rotating on a new user keeps
/// what a newcomer can open to what was sealed after it arrived, under any history setting. A new
/// device of a present user opens nothing that user's other devices could not already open, and
/// device joins are the measured bulk of the rotations (2026-10-21).
///
/// Turning this to `false` makes an Add of anybody continue the run; nothing else reads it.
pub const ROTATE_ON_NEW_USER: bool = true;

/// One group's current clean run, as persisted in the MLS state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraineRun {
    /// Random, 128 bits, hex. Never derived from an epoch, so it cannot alias across group
    /// instances the way an epoch number does.
    pub run_id: String,
    /// [`epoch_fingerprint`] of the last epoch the run covers.
    pub epoch_fingerprint: String,
}

/// What the outbound rotation reads: the run that covers the group's CURRENT epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraineRunReading {
    pub run_id: String,
    pub epoch: u64,
    pub epoch_fingerprint: String,
}

/// What one merged commit did to the tree, built from the tree on both sides of the merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitSummary {
    pub epoch_before: u64,
    pub epoch_after: u64,
    pub fingerprint_before: String,
    pub fingerprint_after: String,
    /// Identities whose `(credential, signature key)` pair the commit took out of the tree and did
    /// not put back. `<unreadable>` for a credential that is not a readable basic credential.
    pub removed: Vec<String>,
    /// Remove proposals the commit carried, whether or not the pair came back in the same commit.
    pub remove_proposals: usize,
    /// Identities whose pair the commit put in and that were not there before.
    pub added: Vec<String>,
    /// Users (the part of an identity before its first `:`) with a leaf after the commit and none
    /// before it. An unreadable credential counts as a new user.
    pub new_users: Vec<String>,
}

impl CommitSummary {
    /// A commit is a departure when it carried any Remove, or took any pair out of the tree.
    pub fn is_departure(&self) -> bool {
        self.remove_proposals > 0 || !self.removed.is_empty()
    }
}

/// The user an identity belongs to, lower-cased, or `None` for one that is not `userId:deviceId`.
/// Split on the FIRST colon and lower-cased exactly as the client's `userIdOfLeaf` reads a leaf, so
/// the two layers cannot disagree on who a user is.
fn user_of(identity: &str) -> Option<String> {
    identity
        .split_once(':')
        .map(|(user, _)| user.to_lowercase())
        .filter(|user| !user.is_empty())
}

fn users(pairs: &LeafPairs) -> std::collections::HashSet<Option<String>> {
    pairs
        .values()
        .map(|(_, identity)| user_of(identity))
        .collect()
}

/// Why a run was replaced, named in the one log line that says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunReset {
    /// The commit carried a Remove or took a pair out of the tree.
    Departure,
    /// The commit added a leaf of a user who had none ([`ROTATE_ON_NEW_USER`]).
    NewUser,
    /// The commit started from an epoch the run did not end on: something moved the group with no
    /// summary (a reload, a re-join, a Welcome, a path that does not use this crate).
    Gap,
    /// No run existed for the group.
    None,
}

impl RunReset {
    fn as_str(self) -> &'static str {
        match self {
            RunReset::Departure => "departure",
            RunReset::NewUser => "new-user",
            RunReset::Gap => "gap",
            RunReset::None => "none",
        }
    }
}

/// A domain-separated hash of a group's epoch authenticator, bound to its id and epoch number.
///
/// Two instances of one group at the same epoch NUMBER (a re-bootstrapped key group) have different
/// authenticators, so they have different fingerprints - which is what lets a session tell "the
/// epoch I was distributed at" from "an epoch with the same number".
pub(crate) fn epoch_fingerprint(
    provider: &impl OpenMlsProvider,
    group: &MlsGroup,
) -> Result<String, MlsError> {
    let epoch = group.epoch().as_u64();
    let group_id = group.group_id().as_slice();
    let mut input = Vec::with_capacity(FINGERPRINT_DOMAIN.len() + 8 + group_id.len() + 8 + 32);
    input.extend_from_slice(FINGERPRINT_DOMAIN);
    input.extend_from_slice(&(group_id.len() as u64).to_be_bytes());
    input.extend_from_slice(group_id);
    input.extend_from_slice(&epoch.to_be_bytes());
    input.extend_from_slice(group.epoch_authenticator().as_slice());
    let digest = provider
        .crypto()
        .hash(HashType::Sha2_256, &input)
        .map_err(|e| MlsError::OpenMls(format!("epoch fingerprint: {e:?}")))?;
    Ok(to_hex(&digest))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Every leaf's `(credential bytes, signature key)` pair, counted, with a readable identity beside
/// it for the summary. Counted rather than collected into a set so the diff stays exact even if a
/// tree ever held one pair twice.
type LeafPairs = HashMap<(Vec<u8>, Vec<u8>), (usize, String)>;

fn leaf_pairs(group: &MlsGroup) -> Result<LeafPairs, MlsError> {
    let mut pairs: LeafPairs = HashMap::new();
    for member in group.members() {
        let credential = member
            .credential
            .tls_serialize_detached()
            .map_err(|e| MlsError::Serialization(format!("leaf credential: {e}")))?;
        let identity =
            credential_identity(&member.credential).unwrap_or_else(|_| "<unreadable>".to_string());
        let entry = pairs
            .entry((credential, member.signature_key))
            .or_insert((0, identity));
        entry.0 += 1;
    }
    Ok(pairs)
}

/// Pairs counted in `from` more times than in `to`, by identity.
fn missing_from(from: &LeafPairs, to: &LeafPairs) -> Vec<String> {
    let mut out = Vec::new();
    for (pair, (count, identity)) in from {
        let kept = to.get(pair).map(|(c, _)| *c).unwrap_or(0);
        for _ in kept..*count {
            out.push(identity.clone());
        }
    }
    out.sort();
    out
}

/// The tree as it was before a merge, held until the merge is done.
pub(crate) struct BeforeMerge {
    epoch: u64,
    fingerprint: String,
    pairs: LeafPairs,
    remove_proposals: usize,
}

impl BeforeMerge {
    /// Read the tree BEFORE the merge, with the commit about to be merged: after it, the leaves a
    /// Remove took are gone, and so is the commit.
    pub(crate) fn read(
        provider: &impl OpenMlsProvider,
        group: &MlsGroup,
        commit: &StagedCommit,
    ) -> Result<Self, MlsError> {
        Ok(Self {
            epoch: group.epoch().as_u64(),
            fingerprint: epoch_fingerprint(provider, group)?,
            pairs: leaf_pairs(group)?,
            remove_proposals: commit.remove_proposals().count(),
        })
    }

    /// The summary of the merge that just happened on `group`.
    pub(crate) fn summarise(
        self,
        provider: &impl OpenMlsProvider,
        group: &MlsGroup,
    ) -> Result<CommitSummary, MlsError> {
        let after = leaf_pairs(group)?;
        let users_before = users(&self.pairs);
        let mut new_users: Vec<String> = users(&after)
            .into_iter()
            .filter(|user| user.is_none() || !users_before.contains(user))
            .map(|user| user.unwrap_or_else(|| "<unreadable>".to_string()))
            .collect();
        new_users.sort();
        Ok(CommitSummary {
            epoch_before: self.epoch,
            epoch_after: group.epoch().as_u64(),
            fingerprint_before: self.fingerprint,
            fingerprint_after: epoch_fingerprint(provider, group)?,
            removed: missing_from(&self.pairs, &after),
            remove_proposals: self.remove_proposals,
            added: missing_from(&after, &self.pairs),
            new_users,
        })
    }
}

fn new_run_id(provider: &impl OpenMlsProvider) -> Result<String, MlsError> {
    let bytes = provider
        .rand()
        .random_vec(16)
        .map_err(|e| MlsError::OpenMls(format!("run id: {e:?}")))?;
    Ok(to_hex(&bytes))
}

/// Applies one merged commit's summary to the group's run.
///
/// The run continues only when the commit started exactly where the run ended, removed nobody and
/// brought in no new user. Anything else - a departure, a new user, a gap, no run - starts a new one
/// at the epoch the commit created.
pub(crate) fn observe_commit(
    runs: &mut HashMap<String, GraineRun>,
    provider: &impl OpenMlsProvider,
    group_id: &str,
    summary: &CommitSummary,
) -> Result<(), MlsError> {
    let short: String = group_id.chars().take(8).collect();
    let reset = match runs.get(group_id) {
        _ if summary.is_departure() => Some(RunReset::Departure),
        _ if ROTATE_ON_NEW_USER && !summary.new_users.is_empty() => Some(RunReset::NewUser),
        Some(run) if run.epoch_fingerprint == summary.fingerprint_before => None,
        Some(_) => Some(RunReset::Gap),
        None => Some(RunReset::None),
    };
    match reset {
        None => {
            let run = runs.get_mut(group_id).expect("matched above");
            run.epoch_fingerprint = summary.fingerprint_after.clone();
            log::debug!(
                "[GRAINE] run {} of {} continues across epoch {}->{} (+{} -0)",
                &run.run_id[..8],
                short,
                summary.epoch_before,
                summary.epoch_after,
                summary.added.len()
            );
        }
        Some(reason) => {
            let run_id = new_run_id(provider)?;
            log::info!(
                "[GRAINE] run reset reason={} group={} epoch {}->{} removes={} pairs_gone={} \
                 added={} new_users={} new run {}",
                reason.as_str(),
                short,
                summary.epoch_before,
                summary.epoch_after,
                summary.remove_proposals,
                summary.removed.len(),
                summary.added.len(),
                summary.new_users.len(),
                &run_id[..8]
            );
            runs.insert(
                group_id.to_string(),
                GraineRun {
                    run_id,
                    epoch_fingerprint: summary.fingerprint_after.clone(),
                },
            );
        }
    }
    Ok(())
}

impl MlsManager {
    /// The clean run covering `group_id`'s CURRENT epoch - what Graine's outbound rotation reads
    /// before it reuses a session across an epoch move.
    ///
    /// A run whose last epoch is not the current one (a reload, a re-join, a Welcome moved the group
    /// with no summary) is replaced here by a NEW run that starts now. That is sound because a run
    /// claims nothing about what happened before it started, and a session minted under the old run
    /// carries the old id, so it can never match the new one.
    pub fn graine_run(&mut self, group_id: &str) -> Result<GraineRunReading, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or_else(|| MlsError::GroupNotFound(group_id.to_string()))?;
        let epoch = group.epoch().as_u64();
        let fingerprint = epoch_fingerprint(&self.provider, group)?;
        if let Some(run) = self.graine_runs.get(group_id)
            && run.epoch_fingerprint == fingerprint
        {
            return Ok(GraineRunReading {
                run_id: run.run_id.clone(),
                epoch,
                epoch_fingerprint: fingerprint,
            });
        }
        let reason = if self.graine_runs.contains_key(group_id) {
            RunReset::Gap
        } else {
            RunReset::None
        };
        let run_id = new_run_id(&self.provider)?;
        log::info!(
            "[GRAINE] run reset reason={} group={} at epoch {} new run {}",
            reason.as_str(),
            group_id.chars().take(8).collect::<String>(),
            epoch,
            &run_id[..8]
        );
        self.graine_runs.insert(
            group_id.to_string(),
            GraineRun {
                run_id: run_id.clone(),
                epoch_fingerprint: fingerprint.clone(),
            },
        );
        self.mark_state_dirty();
        Ok(GraineRunReading {
            run_id,
            epoch,
            epoch_fingerprint: fingerprint,
        })
    }

    /// Our own staged commit merged, WITH the summary of what it did when one could be built.
    /// [`Self::merge_pending_commit_for`] is this with the summary dropped.
    pub fn merge_pending_commit_with_summary(
        &mut self,
        group_id: &str,
    ) -> Result<Option<CommitSummary>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        // No pending commit: openmls merges nothing and the epoch does not move, so there is
        // nothing for the run to observe.
        let before = group
            .pending_commit()
            .map(|commit| BeforeMerge::read(&self.provider, group, commit));
        group
            .merge_pending_commit(&self.provider)
            .map_err(|e| MlsError::OpenMls(format!("Merge pending commit error: {:?}", e)))?;
        self.state_snapshot.borrow_mut().invalidate();
        let Some(before) = before else {
            log::debug!(
                "[GRAINE] merge_pending_commit on {} with nothing pending - the run is untouched",
                group_id.chars().take(8).collect::<String>()
            );
            return Ok(None);
        };
        Ok(observe_merge(
            &mut self.graine_runs,
            &self.provider,
            group_id,
            before,
            group,
        ))
    }

    /// Forgets the run of a group this manager no longer holds, so a later instance of the same id
    /// starts clean instead of carrying a stale entry in the state for ever.
    pub(crate) fn drop_graine_run(&mut self, group_id: &str) {
        if self.graine_runs.remove(group_id).is_some() {
            self.mark_state_dirty();
        }
    }
}

/// Summarises a merge that HAS happened and applies it to the group's run.
///
/// Never fails the merge: the epoch has already moved, and a caller told "error" would believe it
/// had not. A summary that cannot be built DROPS the run instead, which is the fail-safe direction -
/// with no run, the next send rotates exactly as before this tracker existed.
pub(crate) fn observe_merge(
    runs: &mut HashMap<String, GraineRun>,
    provider: &impl OpenMlsProvider,
    group_id: &str,
    before: Result<BeforeMerge, MlsError>,
    group: &MlsGroup,
) -> Option<CommitSummary> {
    let observed = before
        .and_then(|before| before.summarise(provider, group))
        .and_then(|summary| observe_commit(runs, provider, group_id, &summary).map(|()| summary));
    match observed {
        Ok(summary) => Some(summary),
        Err(e) => {
            runs.remove(group_id);
            log::error!(
                "[GRAINE] run dropped for group {}: the merged commit could not be summarised \
                 ({e}) - the next send rotates",
                group_id.chars().take(8).collect::<String>()
            );
            None
        }
    }
}
