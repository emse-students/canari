//! A fork check that can actually fire: an epoch fingerprint in the frame's CLEARTEXT authenticated
//! data, signed by the sender's credential key, read where a decrypt fails.
//!
//! **Why not inside the ciphertext.** The obvious design - every message carries the sender's epoch
//! authenticator, receivers compare - cannot detect anything: a member able to decrypt a frame
//! shares the epoch secret it was sealed under, and the authenticator is derived from that secret,
//! so inside the encryption the two always agree. A fork (two trees at one epoch number, which a
//! commit gate accepting two commits for one epoch produces) shows up as exactly one event: a frame
//! from the other tree that this device CANNOT open, the `same-epoch refusal` of `messaging.rs`.
//! The fingerprint lets that refusal tell "my copy of this epoch differs from the sender's" from
//! "these bytes are damaged".
//!
//! **What travels.** `AAD = version(1) lp(identity) fp(16) signature(64)`, where `fp` is the first 16
//! bytes of `SHA-256(lp("canari-mls-epoch-fp-v1") lp(epoch_authenticator))` and the signature is the
//! sender's credential key over `lp("canari-mls-fork-v1") lp(groupId) be64(epoch) lp(fp)
//! lp(identity)`. The epoch authenticator is the RFC 9420 value meant for out-of-band comparison, and
//! a truncated hash of it reveals no secret. The server can strip or garble the AAD of a frame (the
//! frame then fails for every member) and can withhold a frame altogether - so a server choosing to
//! hide a fork still can. What it can no longer do is FORGE one: a claim it writes does not verify.
//!
//! **What the receiver concludes**, on a same-epoch refusal, against its own authenticator:
//!
//! | The claim | Verdict | Line |
//! | --- | --- | --- |
//! | none (a build older than this, or a commit) | no finding | - |
//! | agrees with ours | not a fork: the bytes are bad | warn |
//! | differs, signed by that sender's key in OUR tree | `Fork` | ERROR, recorded |
//! | differs, not verifiable here | `Unproven` | warn, recorded |
//!
//! On a frame that DID decrypt at our epoch the claim must agree, since MLS just authenticated it;
//! one that does not is a sender computing it wrong or lying (`Contradiction`, ERROR, recorded).
//!
//! Findings are kept, bounded, until a caller takes them (`take_fork_findings`), so the frontend can
//! record and report them without this crate knowing anything about either.
//!
//! Protocol: `docs/wiki/protocols/mls-protocol.md`, "Fork detection".

use std::cell::RefCell;

use openmls::prelude::*;
use openmls_traits::signatures::Signer;

use crate::MlsError;
use crate::authorship::{lp, sha256};
use crate::graine_signature::verify_graine_signature;
use crate::members::credential_identity;
use crate::state::MlsManager;

/// The only AAD layout this build writes or reads.
pub const FORK_AAD_VERSION: u8 = 1;
/// The fingerprint's length - enough to make a collision between two real trees irrelevant.
pub const FORK_FINGERPRINT_BYTES: usize = 16;
const FINGERPRINT_LABEL: &str = "canari-mls-epoch-fp-v1";
const FORK_CLAIM_LABEL: &str = "canari-mls-fork-v1";
const SIGNATURE_BYTES: usize = 64;
/// How many findings are kept for a caller that has not taken them yet. A fork produces one per
/// frame that crosses it, and the caller takes them after each refusal; the bound only matters for
/// a caller that never does.
const MAX_KEPT_FINDINGS: usize = 64;

/// What kind of disagreement a finding records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForkFindingKind {
    /// A frame this device could not open carries a signed fingerprint, from a member of this tree,
    /// for this epoch, that differs from ours: the two hold different trees at one epoch number.
    Fork,
    /// The fingerprint differs and cannot be verified here (sender not in our tree, a signature that
    /// does not verify). Worth reading, not an accusation.
    Unproven,
    /// A frame that DID decrypt at our epoch carries a fingerprint that is not ours.
    Contradiction,
}

impl ForkFindingKind {
    /// A stable name for the JS side and the log, never a sentence.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Fork => "fork",
            Self::Unproven => "unproven",
            Self::Contradiction => "contradiction",
        }
    }
}

/// One disagreement, kept until taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkFinding {
    pub kind: ForkFindingKind,
    pub group_id: String,
    pub epoch: u64,
    /// `userId:deviceId` the claim names.
    pub peer: String,
    /// Why an `Unproven` finding could not be proven; empty otherwise.
    pub detail: String,
}

/// The findings not yet taken, with a count of those dropped past the bound.
#[derive(Debug, Default)]
pub struct ForkFindings {
    pub(crate) kept: Vec<ForkFinding>,
    pub(crate) dropped: usize,
}

impl ForkFindings {
    pub(crate) fn push(&mut self, finding: ForkFinding) {
        if self.kept.len() >= MAX_KEPT_FINDINGS {
            self.kept.remove(0);
            self.dropped += 1;
        }
        self.kept.push(finding);
    }
}

/// A claim as read from a frame's AAD.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkClaim {
    pub identity: String,
    pub fingerprint: Vec<u8>,
    pub signature: Vec<u8>,
}

/// The fingerprint of an epoch authenticator.
pub fn epoch_fingerprint(authenticator: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(8 + FINGERPRINT_LABEL.len() + authenticator.len());
    lp(&mut input, FINGERPRINT_LABEL.as_bytes());
    lp(&mut input, authenticator);
    let mut digest = sha256(&input);
    digest.truncate(FORK_FINGERPRINT_BYTES);
    digest
}

/// The bytes a sender signs for its claim.
pub fn fork_claim_descriptor(
    group_id: &str,
    epoch: u64,
    fingerprint: &[u8],
    identity: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + group_id.len() + identity.len());
    lp(&mut out, FORK_CLAIM_LABEL.as_bytes());
    lp(&mut out, group_id.as_bytes());
    out.extend_from_slice(&epoch.to_be_bytes());
    lp(&mut out, fingerprint);
    lp(&mut out, identity.as_bytes());
    out
}

/// Encodes a claim as AAD.
pub fn encode_fork_aad(claim: &ForkClaim) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 4 + claim.identity.len() + 16 + 64);
    out.push(FORK_AAD_VERSION);
    lp(&mut out, claim.identity.as_bytes());
    out.extend_from_slice(&claim.fingerprint);
    out.extend_from_slice(&claim.signature);
    out
}

/// Reads a claim out of an AAD, or `None` for an empty AAD, another version, or a malformed one.
pub fn decode_fork_aad(aad: &[u8]) -> Option<ForkClaim> {
    if aad.first() != Some(&FORK_AAD_VERSION) {
        return None;
    }
    let len_bytes: [u8; 4] = aad.get(1..5)?.try_into().ok()?;
    let id_len = u32::from_be_bytes(len_bytes) as usize;
    let id_end = 5usize.checked_add(id_len)?;
    let identity = String::from_utf8(aad.get(5..id_end)?.to_vec()).ok()?;
    let fp_end = id_end + FORK_FINGERPRINT_BYTES;
    let fingerprint = aad.get(id_end..fp_end)?.to_vec();
    let signature = aad.get(fp_end..)?.to_vec();
    if signature.len() != SIGNATURE_BYTES {
        return None;
    }
    Some(ForkClaim {
        identity,
        fingerprint,
        signature,
    })
}

/// What one frame's claim established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ForkVerdict {
    NoClaim,
    Agrees,
    Finding(ForkFinding),
}

/// The signature key of the leaf `identity` in `group`, or `None`.
fn leaf_key(group: &MlsGroup, identity: &str) -> Option<Vec<u8>> {
    group
        .members()
        .find(|m| credential_identity(&m.credential).ok().as_deref() == Some(identity))
        .map(|m| m.signature_key)
}

/// Judges the claim of a frame at `msg_epoch` against `group`'s own epoch, which the caller has
/// established are EQUAL. `decrypted` says whether MLS authenticated the frame - in which case the
/// claim is authenticated too and only its agreement matters.
pub(crate) fn judge_fork_claim(
    group: &MlsGroup,
    group_id: &str,
    aad: &[u8],
    msg_epoch: u64,
    decrypted: bool,
) -> ForkVerdict {
    let Some(claim) = decode_fork_aad(aad) else {
        return ForkVerdict::NoClaim;
    };
    let ours = epoch_fingerprint(group.epoch_authenticator().as_slice());
    if claim.fingerprint == ours {
        return ForkVerdict::Agrees;
    }
    let finding = |kind, detail: &str| {
        ForkVerdict::Finding(ForkFinding {
            kind,
            group_id: group_id.to_string(),
            epoch: msg_epoch,
            peer: claim.identity.clone(),
            detail: detail.to_string(),
        })
    };
    if decrypted {
        return finding(ForkFindingKind::Contradiction, "");
    }
    let Some(key) = leaf_key(group, &claim.identity) else {
        return finding(
            ForkFindingKind::Unproven,
            "the claimed sender is not in our tree",
        );
    };
    let descriptor =
        fork_claim_descriptor(group_id, msg_epoch, &claim.fingerprint, &claim.identity);
    match verify_graine_signature(&key, &descriptor, &claim.signature) {
        Ok(()) => finding(ForkFindingKind::Fork, ""),
        Err(e) => finding(
            ForkFindingKind::Unproven,
            &format!(
                "the claim does not verify under that leaf's key ({})",
                e.code()
            ),
        ),
    }
}

/// Records and reports a verdict - the ONE place a fork line is written, for both paths.
pub(crate) fn record_fork_verdict(verdict: ForkVerdict, findings: &RefCell<ForkFindings>) {
    let ForkVerdict::Finding(f) = verdict else {
        return;
    };
    match f.kind {
        ForkFindingKind::Fork => log::error!(
            "[FORK] group {} at epoch {}: {} signed an epoch fingerprint that is not ours - two \
             trees hold this epoch number, and the frame from the other one cannot be read here",
            f.group_id,
            f.epoch,
            f.peer
        ),
        ForkFindingKind::Contradiction => log::error!(
            "[FORK] group {} at epoch {}: a frame from {} decrypted under our epoch and claims \
             another fingerprint - its sender computed it wrong or lied",
            f.group_id,
            f.epoch,
            f.peer
        ),
        ForkFindingKind::Unproven => log::warn!(
            "[FORK] group {} at epoch {}: a frame naming {} claims another fingerprint, and the \
             claim cannot be proven here: {}",
            f.group_id,
            f.epoch,
            f.peer,
            f.detail
        ),
    }
    findings.borrow_mut().push(f);
}

impl MlsManager {
    /// The signed fingerprint claim this device attaches to its next frame in `group_id`.
    pub(crate) fn fork_aad_for(&self, group_id: &str) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;
        let identity = self.own_identity();
        let fingerprint = epoch_fingerprint(group.epoch_authenticator().as_slice());
        let epoch = group.epoch().as_u64();
        let descriptor = fork_claim_descriptor(group_id, epoch, &fingerprint, &identity);
        let signature = self.keypair.sign(&descriptor).map_err(|e| {
            log::error!("[FORK] could not sign the epoch fingerprint for {group_id}: {e:?}");
            MlsError::OpenMls(format!("fork_aad_for: {e:?}"))
        })?;
        Ok(encode_fork_aad(&ForkClaim {
            identity,
            fingerprint,
            signature,
        }))
    }

    /// Hands over every finding recorded since the last call, and forgets them.
    pub fn take_fork_findings(&self) -> Vec<ForkFinding> {
        let mut findings = self.fork_findings.borrow_mut();
        if findings.dropped > 0 {
            log::warn!(
                "[FORK] {} finding(s) were dropped past the bound before anybody took them",
                findings.dropped
            );
            findings.dropped = 0;
        }
        std::mem::take(&mut findings.kept)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_round_trips() {
        let claim = ForkClaim {
            identity: "alice:dev-a".into(),
            fingerprint: vec![3u8; 16],
            signature: vec![5u8; 64],
        };
        assert_eq!(decode_fork_aad(&encode_fork_aad(&claim)), Some(claim));
    }

    #[test]
    fn an_empty_or_foreign_aad_is_no_claim() {
        assert_eq!(decode_fork_aad(&[]), None);
        assert_eq!(decode_fork_aad(&[2, 0, 0, 0, 0]), None);
        // Truncated signature.
        let mut aad = encode_fork_aad(&ForkClaim {
            identity: "a:b".into(),
            fingerprint: vec![0; 16],
            signature: vec![0; 64],
        });
        aad.pop();
        assert_eq!(decode_fork_aad(&aad), None);
    }

    #[test]
    fn the_bound_keeps_the_newest() {
        let mut f = ForkFindings::default();
        for epoch in 0..(MAX_KEPT_FINDINGS as u64 + 3) {
            f.push(ForkFinding {
                kind: ForkFindingKind::Fork,
                group_id: "g".into(),
                epoch,
                peer: "p".into(),
                detail: String::new(),
            });
        }
        assert_eq!(f.kept.len(), MAX_KEPT_FINDINGS);
        assert_eq!(f.dropped, 3);
        assert_eq!(f.kept[0].epoch, 3);
    }
}
