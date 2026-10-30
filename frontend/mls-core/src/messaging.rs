use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::cell::RefCell;
use std::collections::HashMap;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::authorship::{AuthorVerdict, vet_author_proof};
use crate::device_trust::{DeviceTrust, leaf_keys};
use crate::fork_check::{ForkFindings, ForkVerdict, judge_fork_claim, record_fork_verdict};
use crate::graine_run::{BeforeMerge, GraineRun, observe_merge};
use crate::members::credential_identity;
use crate::state::{MlsManager, StateSnapshotCache};
use crate::{MAX_MLS_MESSAGE_BYTES, MlsError};

/// An application message this device decrypted, and who sent it.
///
/// `sender_identity` is the credential OpenMLS verified the frame's signature against -
/// `userId:deviceId`, minted in `state.rs` - and the only sender a client may believe. The delivery
/// server's envelope names a sender too, and that one is a claim (channel-encryption section 21).
/// `None` only when the credential is not a readable basic credential, which is logged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingApplication {
    /// The decrypted bytes. An author proof is still at their end ONLY when `author` is
    /// `Verified`; a refused one has been cut off, so the application never relays it.
    pub plaintext: Vec<u8>,
    pub sender_identity: Option<String>,
    /// Whether the frame carried its author's signature, and whether it held (`authorship.rs`).
    pub author: AuthorVerdict,
}

/// Everything a merged commit must be shown to, besides the group itself: the device record
/// (`crate::device_trust`, with this device's own identity and key) and Graine's departure tracker
/// (`crate::graine_run`). One value, so every merge path feeds both or neither.
pub(crate) struct MergeObservers<'a> {
    pub(crate) trust: &'a mut DeviceTrust,
    /// This device's credential identity and signature key.
    pub(crate) own: (&'a [u8], &'a [u8]),
    pub(crate) graine_runs: &'a mut HashMap<String, GraineRun>,
}

impl MlsManager {
    // --- D. MESSAGERIE ---

    /// Encrypts `message` for `group_id`, with this device's signed epoch fingerprint in the frame's
    /// cleartext authenticated data (`fork_check.rs`) - every application frame is a fork witness.
    pub fn send_message(&mut self, group_id: &str, message: &[u8]) -> Result<Vec<u8>, MlsError> {
        let fork_aad = self.fork_aad_for(group_id)?;
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        // openmls clears the AAD after a frame it BUILDS, and leaves it set when it refuses
        // (`application.rs`) - so it is cleared here on a refusal, or the next commit would carry
        // a claim about an epoch it is about to leave.
        group.set_aad(fork_aad);
        let built = group.create_message(&self.provider, &self.keypair, message);
        if built.is_err() {
            group.set_aad(Vec::new());
        }
        let msg_out = built.map_err(|e| match e {
            // Classified HERE, on the variant, rather than by matching `UseAfterEviction` out
            // of a Debug string downstream: eviction is permanent and every other encrypt
            // failure is not, so the two must not reach a caller as the same `OpenMls(String)`.
            // The outbox read them as one and retried an evicted group on a backoff ladder for
            // as long as the entry lived.
            CreateMessageError::GroupStateError(MlsGroupStateError::UseAfterEviction) => {
                log::error!(
                    "Send refused: this device was evicted from group {} and did not learn it \
                         from the Remove commit - the commit was never received, or its \
                         `is_group_active` check did not run",
                    group_id
                );
                MlsError::Evicted(group_id.to_string())
            }
            other => MlsError::OpenMls(format!("Encrypt error: {:?}", other)),
        })?;

        self.mark_ratchet_advanced();
        msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::Serialization(e.to_string()))
    }

    /// Advances this device's send ratchet by `count` generations WITHOUT emitting anything.
    ///
    /// # Why this exists
    ///
    /// A checkpoint is not awaited on the send path (it costs 1.7 s on a phone), so a reload can
    /// restore a state that predates frames this device has already put on the wire. The peers have
    /// consumed those generations; re-issuing one is `SecretReuseError` and the frame is refused.
    /// The repair is to move the ratchet back to where the peers already believe it is - which is
    /// what this does, from a count kept outside the snapshot (`sendRatchetLedger.ts`).
    ///
    /// # Why it encrypts instead of setting a number
    ///
    /// There is no other way. In `openmls` the encryption ratchet's `ratchet_forward` is
    /// `pub(crate)` and `RatchetSecret::set_generation` is `#[cfg(test)]`, so the only public means
    /// of advancing a generation is to produce a frame. The ciphertext is dropped on the floor here;
    /// the cost is three key derivations and one AEAD per generation.
    ///
    /// # Why over-shooting is safe
    ///
    /// A receiver ratchets FORWARD on demand: `DecryptionRatchet::secret_for_decryption` derives
    /// every generation between its head and the one asked for and keeps each in `past_secrets`, so
    /// generations burnt here and never sent cost the peer a few unused 48-byte keys, and a frame
    /// still in flight during the burn decrypts afterwards out of that same window. Both bounds are
    /// 2000 for every group this client creates or joins (`group::sender_ratchet_config`), which is
    /// why the caller may err on the high side and must never err on the low one.
    ///
    /// Returns the number of generations actually burnt.
    pub fn skip_send_generations(&mut self, group_id: &str, count: u32) -> Result<u32, MlsError> {
        if count == 0 {
            return Ok(0);
        }
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        for burnt in 0..count {
            // The frame is built and dropped; only the ratchet advance it caused is kept. A failure
            // part-way is reported WITH what was already burnt, because those generations are spent
            // whatever the caller decides next - reporting `count` or `0` would both be lies.
            if let Err(e) = group.create_message(&self.provider, &self.keypair, &[]) {
                self.mark_ratchet_advanced();
                return Err(MlsError::OpenMls(format!(
                    "Burn error after {burnt}/{count} generation(s): {e:?}"
                )));
            }
        }

        self.mark_ratchet_advanced();
        log::info!(
            "Burnt {} send generation(s) for group {} - the ratchet is back where the peers left it",
            count,
            group_id.chars().take(8).collect::<String>()
        );
        Ok(count)
    }

    /// Process an incoming MLS message (Handshake or Application)
    /// Returns decoded data if it was an application message
    ///
    /// **The plaintext ALONE, and kept for exactly one reader**: `mls-cross-version` compiles the
    /// same `main.rs` against an OLD `mls-core` tag, so this signature is the one both sides share.
    /// Every app path reads [`Self::process_incoming_message_with_sender`], which carries the
    /// verified sender this projection drops.
    pub fn process_incoming_message(
        &mut self,
        group_id: &str,
        message_bytes: &[u8],
    ) -> Result<Option<Vec<u8>>, MlsError> {
        self.process_incoming_message_with_sender(group_id, message_bytes)
            .map(|app| app.map(|app| app.plaintext))
    }

    /// Process an incoming MLS message, returning an application message's plaintext WITH the
    /// sender MLS verified it against (`userId:deviceId`).
    pub fn process_incoming_message_with_sender(
        &mut self,
        group_id: &str,
        message_bytes: &[u8],
    ) -> Result<Option<IncomingApplication>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or_else(|| MlsError::GroupNotFound(group_id.to_string()))?;
        Self::process_incoming_on_group(
            group,
            &self.provider,
            group_id,
            message_bytes,
            &self.state_snapshot,
            &self.fork_findings,
            &mut MergeObservers {
                trust: &mut self.device_trust,
                own: (self.credential.identity(), self.keypair.public()),
                graine_runs: &mut self.graine_runs,
            },
        )
    }

    /// Decrypts `messages` for one group in ratchet order. Per-message errors are returned
    /// in the output vector instead of aborting the batch (history catch-up path).
    pub fn process_incoming_messages(
        &mut self,
        group_id: &str,
        messages: &[&[u8]],
    ) -> Vec<Result<Option<IncomingApplication>, MlsError>> {
        let Some(group) = self.groups.get_mut(group_id) else {
            return messages
                .iter()
                .map(|_| Err(MlsError::GroupNotFound(group_id.to_string())))
                .collect();
        };

        let provider = &self.provider;
        let snapshot = &self.state_snapshot;
        let fork_findings = &self.fork_findings;
        // Every commit of the batch is observed by the departure tracker IN ORDER, one merge at a
        // time - a departure in the middle of a batch ends the run like any other.
        let mut observers = MergeObservers {
            trust: &mut self.device_trust,
            own: (self.credential.identity(), self.keypair.public()),
            graine_runs: &mut self.graine_runs,
        };
        messages
            .iter()
            .map(|bytes| {
                Self::process_incoming_on_group(
                    group,
                    provider,
                    group_id,
                    bytes,
                    snapshot,
                    fork_findings,
                    &mut observers,
                )
            })
            .collect()
    }

    pub(crate) fn process_incoming_on_group(
        group: &mut MlsGroup,
        provider: &OpenMlsRustCrypto,
        group_id: &str,
        message_bytes: &[u8],
        state_snapshot: &RefCell<StateSnapshotCache>,
        fork_findings: &RefCell<ForkFindings>,
        observers: &mut MergeObservers<'_>,
    ) -> Result<Option<IncomingApplication>, MlsError> {
        if message_bytes.len() > MAX_MLS_MESSAGE_BYTES {
            return Err(MlsError::InvalidData);
        }
        let msg_in = MlsMessageIn::tls_deserialize(&mut &message_bytes[..])
            .map_err(|_| MlsError::InvalidData)?;

        // The fork claim (`fork_check.rs`) is the frame's cleartext AAD, copied out HERE because a
        // refusal is exactly where it is needed and `process_message` consumes the frame first.
        let mut claim_aad: Vec<u8> = Vec::new();
        let protocol_message: ProtocolMessage = match msg_in.extract() {
            MlsMessageBodyIn::PublicMessage(m) => m.into(),
            MlsMessageBodyIn::PrivateMessage(m) => {
                claim_aad = m.aad().to_vec();
                m.into()
            }
            _ => return Err(MlsError::InvalidData),
        };

        // All three are always cleartext in the MLS frame header - safe to read before decryption
        // and invaluable for diagnosing epoch-mismatch errors. The content type is read HERE rather
        // than where it is used because `process_message` consumes the frame, and a diagnosis that
        // needs it is only ever made after that call has failed.
        let msg_epoch = protocol_message.epoch();
        let msg_content_type = protocol_message.content_type();
        let group_epoch = group.epoch();

        // A FRAME FOR A GROUP WE HAVE BEEN REMOVED FROM. Not a decryption failure and not a broken
        // state: the Remove commit retired our leaf, and everything still arriving was either in
        // flight or routed by a server registry the removal has not finished cleaning. There is no
        // plaintext to recover, and nothing to repair.
        //
        // It is decided BEFORE the epoch gap below, because an evicted device is the commonest way
        // to hold a future-epoch frame: the group keeps committing after the removal, so every
        // frame that follows is ahead of the epoch this device is frozen at, and the gap arm would
        // claim all of them. Carried as a gap - or as an unclassified `Process error:` - it reached
        // the frontend as "out of sync", which asked to be re-added to a group we were deliberately
        // removed from, then requested that group's commits and learnt from a 403 what this very
        // frame already proved. `is_active()` is local state, not a guess: the discriminator is read
        // where the decision is made, from where it was already known. The caller ACKs either way;
        // only the diagnosis changes.
        if !group.is_active() {
            log::warn!(
                "Frame for group {} arrived after this device was evicted - ACKed and \
                 dropped, no repair is owed: msg_epoch={} group_epoch={}",
                group_id,
                msg_epoch,
                group_epoch
            );
            return Err(MlsError::Evicted(group_id.to_string()));
        }

        // Epoch-gap fast-fail: a future epoch means we missed at least one commit.
        // Returning early avoids consuming any ratchet key material needlessly and
        // lets the caller queue the message for gap recovery.
        if msg_epoch.as_u64() > group_epoch.as_u64() {
            log::warn!(
                "Gap detected: msg_epoch={} > group_epoch={} for group={}. \
                 Queuing message and triggering resync.",
                msg_epoch,
                group_epoch,
                group_id
            );
            return Err(MlsError::OpenMls(format!(
                "Process error: epoch gap [msg_epoch={}, group_epoch={}]",
                msg_epoch, group_epoch
            )));
        }

        let processed_message = match group.process_message(provider, protocol_message) {
            Ok(pm) => pm,
            Err(e) => {
                // A frame from a PAST epoch is two different events, and `content_type` - which is
                // cleartext in the frame header, exactly like `epoch` - is what tells them apart.
                //
                // A HANDSHAKE frame is our own echoed commit (already merged via
                // merge_pending_commit) or a stale commit another device applied. The decryption
                // keys for commits are consumed during the merge, so re-processing always fails
                // with AeadError. Nothing is lost: succeed silently so the caller ACKs it.
                //
                // An APPLICATION frame is a MESSAGE SOMEBODY SENT, and it is gone. `max_past_epochs`
                // is 2, so a frame merely overtaken by a commit still decrypts; reaching here means
                // the secrets for its epoch are absent - typically after a re-join, whose group
                // state starts with no past epochs at all. This branch answered `Ok(None)` for it
                // too, i.e. "no application payload", and the whole recovery ladder above it is
                // unreachable from a value that says nothing failed: measured on prod 2026-08-11
                // (HEAL-W2, group HGRPjws28), a message was ACKed off the server and dropped with
                // no `LOST frame`, no marker and no history solicitation - the loss left one
                // `[MLS] No application payload` line, which is what a commit echo also prints.
                // Same shape as `SecretReuseError` below: the layer that CAN make a distinction
                // must make it, and the caller decides the policy.
                if msg_epoch.as_u64() < group_epoch.as_u64() {
                    if msg_content_type != ContentType::Application {
                        log::debug!(
                            "Stale handshake ignored: msg_epoch={} < group_epoch={} ({})",
                            msg_epoch,
                            group_epoch,
                            group_id
                        );
                        return Ok(None);
                    }
                    log::warn!(
                        "Past-epoch application frame, unreadable for good: msg_epoch={} \
                         group_epoch={} group={} err={:?}",
                        msg_epoch,
                        group_epoch,
                        group_id,
                        e
                    );
                    // The underlying OpenMLS error is deliberately NOT embedded: it carries markers
                    // (`WrongEpoch`, an Aead failure) that the shared classifiers test for, and a
                    // wrapper holding two markers makes their ORDER a decision rather than a fact.
                    return Err(MlsError::OpenMls(format!(
                        "Process error: past epoch application frame [msg_epoch={}, group_epoch={}]",
                        msg_epoch, group_epoch
                    )));
                }

                // `TooDistantInThePast` (raw, or wrapped as NoPastEpochData): the generation is
                // older than the kept ratchet window, so the key is gone for good. Retrying never
                // helps, and no peer can re-send at a generation we can still read - so it is
                // dropped with an ACK, and this is the single source of truth that stops every
                // caller (native, WASM, background worker) looping it through a retry queue.
                // Genuine epoch gaps are handled by the `msg_epoch > group_epoch` fast-fail above.
                //
                // `SecretReuseError` is DELIBERATELY NOT in this set, though it is equally
                // permanent. "This generation is consumed" is not "I already have this message":
                // a sender whose ratchet rewound (WP-LOSS-1) encrypts a NEW message at a
                // generation we consumed for a different one, and only the frame's own bytes tell
                // the two apart - which this layer cannot see, but the shared frontend ledger can.
                // Answering Ok(None) here threw that diagnosis away before any caller could make
                // it: `recevoir_message_bytes` and `map_decrypt_outcome` both classify
                // `DecryptErrorKind::SecretReuse` and were unreachable, and the web only ever
                // reached its classifier through a log-sniffing shim. Measured on production
                // 2026-08-10: a phone dropped six rewound frames without one line of diagnosis,
                // held no marker as a result, and was then elected to answer a peer's history
                // request - where being unaware of its own gap is exactly what entitled it to
                // certify the conversation complete, ending the repair (see cross-client-testing
                // 7.1). The error is surfaced; callers still ACK, only the diagnosis changes.
                let err_dbg = format!("{:?}", e);
                if err_dbg.contains("TooDistantInThePast") || err_dbg.contains("NoPastEpochData") {
                    log::debug!(
                        "Benign same-epoch ratchet frame dropped: group={} epoch={} ({})",
                        group_id,
                        group_epoch,
                        err_dbg
                    );
                    return Ok(None);
                }

                // EVERY ERROR REACHING HERE IS A SAME-EPOCH REFUSAL, and that is a proof rather
                // than an observation: the arms above return for `msg_epoch > group_epoch` (the
                // gap fast-fail) and for `msg_epoch < group_epoch` (the past-epoch arm, for both
                // content types), so the frame was processed against exactly the epoch it names.
                // An epoch's ratchet tree is immutable once it exists - a commit builds the NEXT
                // one - and OpenMLS keeps `max_past_epochs` of secrets, so a later attempt from a
                // later epoch reads the same key material and is refused identically. THE SAME
                // BYTES CAN NEVER SUCCEED, whatever arrives in between.
                //
                // That is the entire content of the marker, and it is the one thing every caller
                // needs: refusing to acknowledge a frame is right while it may still become
                // readable, and it is an INFINITE REDELIVERY LOOP for one that never will.
                // Measured on prod 2026-08-26 (COMM-1): a `ValidationError(InvalidSignature)` at
                // msg_epoch=0 on two key-distribution groups classified `unknown`, was never
                // acknowledged, and came back on every connection for ever - one defect dirtying
                // eleven cells of a rung. The epoch pair was printed on the line below all along,
                // so the diagnosis was never missing; what was missing was carrying it as a TYPE
                // instead of leaving each consumer to re-derive it from prose.
                //
                // The OpenMLS error stays EMBEDDED, unlike the past-epoch arm above which drops
                // it: `TooDistantInTheFuture` and `SecretReuseError` both reach the callers
                // through this very return, and both classifiers key on those markers. So a frame
                // can carry two, and the order is fixed on both sides - a specific marker names
                // the ratchet position, this one names only what is left when none of them does.
                // A SPENT GENERATION IS NOT A DAMAGED FRAME, AND IT IS NOT A FORK QUESTION EITHER -
                // classified HERE, at the throw, from the error's type. OpenMLS reaches
                // `SecretReuseError` only AFTER it opened the frame's sender data with this epoch's
                // `sender_data_secret` and found the sender's ratchet position already consumed: the
                // frame was sealed under OUR copy of this epoch (a forked one fails earlier, at the
                // sender data) and its bytes are intact. What is left is the question the caller's
                // ledger answers from the bytes - the same frame read twice (a live delivery and a
                // re-fetch of the row it had not acknowledged yet, after a Welcome), or a rewound
                // sender (WP-LOSS-1). So no fork verdict is judged, no "damaged" line is written,
                // and the error still reaches every caller with its marker.
                //
                // Measured on DUP-2 (2026-10-25, a joiner re-fetching after its Welcome): the
                // re-fetched copy of a frame live delivery had just read logged `[FORK] not a fork
                // ... the frame itself is damaged` at WARN, and the pipeline then ACKed it as the
                // duplicate it was. Both halves of that line were false.
                if is_spent_generation(&e) {
                    log::debug!(
                        "Spent generation at our own epoch: group={} epoch={} - the frame was \
                         sealed under this tree and its key is already consumed (a re-delivery, or \
                         a rewound sender); the caller's frame ledger tells which",
                        group_id,
                        msg_epoch
                    );
                    return Err(MlsError::OpenMls(format!(
                        "Process error: same-epoch refusal {:?} [msg_epoch={}, group_epoch={}]",
                        e, msg_epoch, group_epoch
                    )));
                }

                // AND THE ONE PLACE A FORK CAN BE SEEN: a frame from the other side of a fork is
                // this very refusal. Its claim says whether the sender's copy of this epoch is ours
                // (`Agrees`: the bytes are bad) or another one (`fork_check.rs`).
                match judge_fork_claim(group, group_id, &claim_aad, msg_epoch.as_u64(), false) {
                    ForkVerdict::Agrees => log::warn!(
                        "[FORK] not a fork: the refused frame on group {} claims our own epoch \
                         fingerprint at epoch {} - the frame itself is damaged",
                        group_id,
                        msg_epoch
                    ),
                    verdict => record_fork_verdict(verdict, fork_findings),
                }
                log::error!(
                    "MLS decryption failed at exactly its own epoch, so no redelivery can help:                      group={} msg_epoch={} group_epoch={} err={:?}",
                    group_id,
                    msg_epoch,
                    group_epoch,
                    e
                );
                return Err(MlsError::OpenMls(format!(
                    "Process error: same-epoch refusal {:?} [msg_epoch={}, group_epoch={}]",
                    e, msg_epoch, group_epoch
                )));
            }
        };

        // WHO SENT IT, AS MLS PROVED IT - read here because `into_content` consumes the message.
        // OpenMLS has verified the frame's signature against this credential; until 2026-09-28 it
        // was dropped on this line, so every consumer named the sender the DELIVERY SERVER's
        // envelope claimed (channel-encryption section 21, WP-G2-1).
        let sender_identity = match credential_identity(processed_message.credential()) {
            Ok(identity) => Some(identity),
            Err(why) => {
                log::warn!(
                    "Verified sender of a frame on group {} is unreadable ({why}) - the frame is \
                     processed, and its sender cannot be checked",
                    group_id
                );
                None
            }
        };

        // The key of the leaf MLS just verified the frame with - the only key an author proof inside
        // it may be checked against (`authorship.rs`).
        let sender_key = match processed_message.sender() {
            Sender::Member(index) => group.member_at(*index).map(|m| m.signature_key),
            _ => None,
        };
        // Whether the verified sender is `new_member_commit` travels to the departure tracker,
        // which reports it beside each run reset (`graine_run.rs`).
        let external_commit = matches!(processed_message.sender(), Sender::NewMemberCommit);

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => {
                state_snapshot.borrow_mut().invalidate_ratchet();
                // A frame MLS authenticated at OUR epoch must claim our fingerprint; a past-epoch
                // frame is compared with nothing, since only the current authenticator is held.
                if msg_epoch == group_epoch {
                    let verdict =
                        judge_fork_claim(group, group_id, &claim_aad, msg_epoch.as_u64(), true);
                    record_fork_verdict(verdict, fork_findings);
                }
                let (plaintext, author) = vet_author_proof(
                    app_msg.into_bytes(),
                    group_id,
                    sender_identity.as_deref(),
                    sender_key.as_deref(),
                );
                Ok(Some(IncomingApplication {
                    plaintext,
                    sender_identity,
                    author,
                }))
            }
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                // RFC 9420 12.4.3.2, BEFORE ANYTHING IS MERGED: an external commit removes only
                // the joiner's own prior leaf. OpenMLS leaves this check to the application.
                if external_commit {
                    refuse_foreign_external_remove(
                        group,
                        group_id,
                        &staged_commit,
                        sender_identity.as_deref(),
                    )?;
                }
                // The leaves BEFORE the merge, for the device record (`crate::device_trust`).
                let leaves_before = leaf_keys(group);
                // The tree BEFORE the merge, for Graine's departure tracker: after it, the leaves a
                // Remove took are gone (`graine_run.rs`).
                let before = BeforeMerge::read(provider, group, &staged_commit, external_commit);
                group
                    .merge_staged_commit(provider, *staged_commit)
                    .map_err(|e| MlsError::OpenMls(format!("Merge commit error: {:?}", e)))?;
                state_snapshot.borrow_mut().invalidate();
                // EVERY DEVICE THIS COMMIT ADMITTED, read from the signed tree it produced - the one
                // place every merged commit passes, live, replayed or in a batch (crate::device_trust).
                // Merged whatever it admits: refusing a commit the group merged forks this device out.
                let own_identity = String::from_utf8_lossy(observers.own.0).to_string();
                observers.trust.observe_merged_commit(
                    group_id,
                    group.epoch().as_u64(),
                    &leaves_before,
                    &leaf_keys(group),
                    sender_identity.as_deref(),
                    (&own_identity, observers.own.1),
                );
                observe_merge(observers.graine_runs, provider, group_id, before, group);
                // A Remove commit naming OUR leaf leaves the group inactive, and this is the
                // instant that becomes true. Before this line the fact was thrown away and the
                // caller got the same `Ok(None)` as any other applied commit - so the client only
                // ever discovered its own eviction by attempting a send and being refused, which
                // is learning by failing what the commit had already stated. Callers read it back
                // through `is_group_active`; the WARN is what makes it visible on every boundary,
                // including the two (native background, batch replay) that do not.
                if !group.is_active() {
                    log::warn!(
                        "Evicted from group {}: a Remove commit naming this device was applied at \
                         epoch {} - the group is now inactive and nothing further can be sent",
                        group_id,
                        group.epoch()
                    );
                }
                Ok(None)
            }
            // A standalone (External)Proposal queues a pending proposal in the group state,
            // which is persisted OpenMLS state - invalidate so the next save_state rebuilds.
            ProcessedMessageContent::ProposalMessage(_)
            | ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                state_snapshot.borrow_mut().invalidate();
                Ok(None)
            }
            // OUR OWN COMMIT, FANNED BACK WHILE OUR PENDING COMMIT IS STILL PENDING - AND THIS
            // ESTATE CANNOT REACH IT. `create_group` and both join paths set no wire format
            // policy, so every group here takes openmls's default, `PURE_CIPHERTEXT`: a commit
            // leaves as a `PrivateMessage`, comes back as one, and the arm below claims it on its
            // sender data before the content is ever named. Measured, not assumed - feeding
            // `add_members_bulk`'s own bytes back lands in `OwnPrivateMessage`, which is what
            // `an_echoed_commit_is_claimed_by_its_wire_format` pins.
            //
            // It is therefore written as a SIGNAL, not a path: reaching it means the wire format
            // policy changed under us, and that is worth a line that accuses rather than one a
            // reader learns to skip.
            //
            // AND IF IT EVER DOES BECOME REACHABLE, IT STILL MUST NOT MERGE. openmls's own
            // documentation says to apply this variant with `merge_pending_commit()`; [[C7]]
            // Option A says the epoch advances on the SERVER'S answer (`merge_pending_commit_for`)
            // or unwinds on its refusal (`clear_pending_commit_for`). A frame proves the delivery
            // service fanned the commit out; it says nothing about the validation the sender is
            // still waiting on, and merging on it would make the fanout a second writer of one
            // epoch transition - the local fork Option A exists to delete. So it ends the way the
            // past-epoch handshake echo does one screen up: nothing merged, `Ok(None)`, and the
            // caller ACKs the frame so no redelivery loop starts.
            ProcessedMessageContent::OwnPendingCommit => {
                log::error!(
                    "Own pending commit arrived as a PUBLIC message, which no group here should                      produce - the wire format policy has changed: group={} epoch={}. Nothing                      merged: the epoch follows the server's answer, never the fanout.",
                    group_id,
                    group_epoch
                );
                Ok(None)
            }
            // OUR OWN FRAME, READ BACK OUT OF OUR OWN MAILBOX - RFC 9420 WORKING, NOT A FAILURE.
            // A device's history holds everything the group sent INCLUDING what this device sent,
            // so every replay re-offers our own frames, and a member cannot decrypt itself. That is
            // precisely why the sender's optimistic render is the only writer of its own message
            // (WP-ECHO-1).
            //
            // Measured 2026-08-15: opening the DM on two peers with NO send at all produced this
            // once on each, and opening a channel produced none - so the source is the replay, not
            // a live fanout (`broadcast_to_group_members` already excludes the sender's own
            // devices). SINCE 2026-08-15 THE REPLAY NO LONGER ASKS: the archive row carries
            // `sender_device_id`, written at `XADD` from the request body, and the replay skips its
            // own rows before offering them - so this is reached only by rows older than that
            // deploy, and by a genuinely unexpected live frame. It is not dead and must not be
            // deleted with the shim (`docs/wiki/legacy-compatibility.md`).
            //
            // UNDER 0.8.1 THIS WAS AN ERROR AND THE ARM LIVED ABOVE, among the decryption failures;
            // 0.9.0 processes the frame successfully and NAMES it, so the classification moved here
            // with it and the string-matching arm was deleted - openmls 0.9.0 contains no
            // `CannotDecryptOwnMessage` at all, so keeping it would have been a branch no input can
            // reach. The MARKER is what did not move, because it IS the contract across both FFI
            // boundaries: `classifyIncomingDecryptError` and `decrypt_kind` each read that exact
            // text to answer `own-message`, and every consumer ACKs on it.
            //
            // The return stays `Err`, NOT `Ok(None)`, for the same reason it always did: "nothing
            // of ours to read" and "no application payload" are the distinction this function was
            // taught to keep, and collapsing them is what left `decrypt_kind` classifying these as
            // `SenderRatchetGap` - the phone then wrote a row into `pending_mls_messages` for a
            // frame that can never decrypt, retried three times before the sweeper reached it.
            // WP-PENDING-2's exact shape, one classification short.
            ProcessedMessageContent::OwnPrivateMessage => {
                log::debug!(
                    "Own frame read back from the mailbox, nothing to decrypt: group={} epoch={}",
                    group_id,
                    group_epoch
                );
                Err(MlsError::OpenMls(format!(
                    "Process error: CannotDecryptOwnMessage [msg_epoch={}, group_epoch={}]",
                    msg_epoch, group_epoch
                )))
            }
        }
    }
}

/// Refuses an external commit whose Remove proposals reach beyond the joiner's own prior leaf.
///
/// RFC 9420 section 12.4.3.2: an external commit may carry at most one Remove, and only for "an old
/// version of" the joiner - the resync case. OpenMLS 0.9 validates the proposal list's SHAPE (one
/// ExternalInit; ExternalInit, Remove and PreSharedKey inline) and states, at that check, that the
/// identity half "MUST be checked by the application" (`public_group/validation.rs`). This is that
/// check, and it runs on the staged commit, so a refusal merges nothing.
///
/// THE IDENTITY IS THE DEVICE (`userId:deviceId`, compared through `same_identity`), not the user.
/// The one Remove this estate's joins carry is the one OpenMLS's external-commit builder adds itself:
/// the leaf holding the joiner's own signature key, which is a key one device holds under one
/// credential (`welcome.rs`). A device of the same user is a sibling, not a prior self, and a
/// further device enters beside its siblings, never in place of one (`further_device_door.rs`).
///
/// `joiner` is the credential MLS verified the commit against - the new leaf's. An unreadable one
/// cannot be compared, so a commit that removes anything under it is refused too.
fn refuse_foreign_external_remove(
    group: &MlsGroup,
    group_id: &str,
    staged_commit: &StagedCommit,
    joiner: Option<&str>,
) -> Result<(), MlsError> {
    let removed: Vec<LeafNodeIndex> = staged_commit
        .remove_proposals()
        .map(|p| p.remove_proposal().removed())
        .collect();
    if removed.is_empty() {
        return Ok(());
    }
    let joiner_name = joiner.unwrap_or("<unreadable>");
    if removed.len() > 1 {
        log::error!(
            "[EXTERNAL_COMMIT] REFUSED on group {group_id}: an external commit by {joiner_name} \
             carries {} Remove proposals, and RFC 9420 allows at most one (the joiner's own prior \
             leaf) - nothing merged",
            removed.len()
        );
        return Err(MlsError::ForeignExternalRemove(format!(
            "group={group_id} joiner={joiner_name} removes={}",
            removed.len()
        )));
    }
    let index = removed[0];
    let target = group
        .member_at(index)
        .map(|m| credential_identity(&m.credential).map_err(|why| why.to_string()))
        .unwrap_or_else(|| Err("no leaf at that index".to_string()));
    let own_prior_leaf = matches!(
        (&target, joiner),
        (Ok(target), Some(joiner)) if crate::device_trust::same_identity(target, joiner)
    );
    if own_prior_leaf {
        log::debug!(
            "[EXTERNAL_COMMIT] group {group_id}: {joiner_name} replaces its own prior leaf {index:?}"
        );
        return Ok(());
    }
    log::error!(
        "[EXTERNAL_COMMIT] REFUSED on group {group_id}: an external commit by {joiner_name} \
         removes leaf {index:?} ({target:?}), which is not the joiner's own prior leaf \
         (RFC 9420 12.4.3.2) - nothing merged"
    );
    Err(MlsError::ForeignExternalRemove(format!(
        "group={group_id} joiner={joiner_name} removed_leaf={} removed={target:?}",
        index.u32()
    )))
}

/// Whether OpenMLS refused a frame because its sender's ratchet generation is already CONSUMED here.
///
/// Read from the error's TYPE, never from its `Debug` text: this is the one refusal that proves the
/// frame was sealed under this device's copy of the epoch (the sender data opened), so it decides
/// that no fork verdict is judged and no "damaged frame" line is written. A rewording upstream must
/// not be able to move a frame from one answer to the other.
fn is_spent_generation<S>(error: &ProcessMessageError<S>) -> bool {
    use openmls::framing::errors::{MessageDecryptionError, SecretTreeError};
    matches!(
        error,
        ProcessMessageError::ValidationError(ValidationError::UnableToDecrypt(
            MessageDecryptionError::SecretTreeError(SecretTreeError::SecretReuseError)
        ))
    )
}
