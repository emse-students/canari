use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::cell::RefCell;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::state::{MlsManager, StateSnapshotCache};
use crate::{MAX_MLS_MESSAGE_BYTES, MlsError};

impl MlsManager {
    // --- D. MESSAGERIE ---

    pub fn send_message(&mut self, group_id: &str, message: &[u8]) -> Result<Vec<u8>, MlsError> {
        let group = self
            .groups
            .get_mut(group_id)
            .ok_or(MlsError::GroupNotFound(group_id.to_string()))?;

        let msg_out = group
            .create_message(&self.provider, &self.keypair, message)
            .map_err(|e| match e {
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

        self.mark_state_dirty();
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
                self.mark_state_dirty();
                return Err(MlsError::OpenMls(format!(
                    "Burn error after {burnt}/{count} generation(s): {e:?}"
                )));
            }
        }

        self.mark_state_dirty();
        log::info!(
            "Burnt {} send generation(s) for group {} - the ratchet is back where the peers left it",
            count,
            group_id.chars().take(8).collect::<String>()
        );
        Ok(count)
    }

    /// Process an incoming MLS message (Handshake or Application)
    /// Returns decoded data if it was an application message
    pub fn process_incoming_message(
        &mut self,
        group_id: &str,
        message_bytes: &[u8],
    ) -> Result<Option<Vec<u8>>, MlsError> {
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
        )
    }

    /// Decrypts `messages` for one group in ratchet order. Per-message errors are returned
    /// in the output vector instead of aborting the batch (history catch-up path).
    pub fn process_incoming_messages(
        &mut self,
        group_id: &str,
        messages: &[&[u8]],
    ) -> Vec<Result<Option<Vec<u8>>, MlsError>> {
        let Some(group) = self.groups.get_mut(group_id) else {
            return messages
                .iter()
                .map(|_| Err(MlsError::GroupNotFound(group_id.to_string())))
                .collect();
        };

        let provider = &self.provider;
        let snapshot = &self.state_snapshot;
        messages
            .iter()
            .map(|bytes| {
                Self::process_incoming_on_group(group, provider, group_id, bytes, snapshot)
            })
            .collect()
    }

    pub(crate) fn process_incoming_on_group(
        group: &mut MlsGroup,
        provider: &OpenMlsRustCrypto,
        group_id: &str,
        message_bytes: &[u8],
        state_snapshot: &RefCell<StateSnapshotCache>,
    ) -> Result<Option<Vec<u8>>, MlsError> {
        if message_bytes.len() > MAX_MLS_MESSAGE_BYTES {
            return Err(MlsError::InvalidData);
        }
        let msg_in = MlsMessageIn::tls_deserialize(&mut &message_bytes[..])
            .map_err(|_| MlsError::InvalidData)?;

        let protocol_message: ProtocolMessage = match msg_in.extract() {
            MlsMessageBodyIn::PublicMessage(m) => m.into(),
            MlsMessageBodyIn::PrivateMessage(m) => m.into(),
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

                // OUR OWN FRAME, READ BACK OUT OF OUR OWN MAILBOX - RFC 9420 WORKING, NOT A
                // FAILURE. A device's history holds everything the group sent INCLUDING what this
                // device sent, so every replay re-offers our own frames and OpenMLS refuses them by
                // design (a member cannot decrypt itself). That is precisely why the sender's
                // optimistic render is the only writer of its own message (WP-ECHO-1).
                //
                // Measured 2026-08-15: opening the DM on two peers with NO send at all produced
                // this line once on each, and opening a channel produced none - so the source is the
                // replay, not a live fanout (`broadcast_to_group_members` already excludes the
                // sender's own devices). It is classified HERE because the arm below is
                // `log::error!`, and an ERROR on the normal path is one its reader learns to skip:
                // the web hid it TWICE by re-matching the marker in the log text (the wasm logger
                // and `mlsWasmLoader`), while native had no such shim - and, worse, `decrypt_kind`
                // had no arm for it either, so it fell through to `SenderRatchetGap` and the phone
                // wrote a row into `pending_mls_messages` for a frame that can never decrypt. Dead
                // weight retried three times before the sweeper reaches it: WP-PENDING-2's exact
                // shape, one classification short.
                //
                // SINCE 2026-08-15 THE REPLAY NO LONGER ASKS. The archive row carries
                // `sender_device_id`, written at `XADD` from the request body, and the replay skips
                // its own rows before offering them - so this arm is reached only by rows older
                // than that deploy, and by a genuinely unexpected live frame. It is not dead code
                // and must not be deleted with the shim: the classification is what every consumer
                // ACKs on. See `docs/wiki/legacy-compatibility.md`.
                //
                // The return stays `Err`, NOT `Ok(None)`: "nothing of ours to read" and "no
                // application payload" are the distinction this function was taught to keep (see the
                // past-epoch arm above). The marker is carried verbatim because it IS the contract
                // across both FFI boundaries - `classifyIncomingDecryptError` and `decrypt_kind`
                // each read it to answer `own-message`, and every consumer then ACKs the frame.
                if err_dbg.contains("CannotDecryptOwnMessage") {
                    log::debug!(
                        "Own frame read back from the mailbox, nothing to decrypt: group={} epoch={}",
                        group_id,
                        group_epoch
                    );
                    return Err(MlsError::OpenMls(format!(
                        "Process error: CannotDecryptOwnMessage [msg_epoch={}, group_epoch={}]",
                        msg_epoch, group_epoch
                    )));
                }

                log::error!(
                    "MLS decryption failed: group={} msg_epoch={} group_epoch={} err={:?}",
                    group_id,
                    msg_epoch,
                    group_epoch,
                    e
                );
                return Err(MlsError::OpenMls(format!(
                    "Process error: {:?} [msg_epoch={}, group_epoch={}]",
                    e, msg_epoch, group_epoch
                )));
            }
        };

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_msg) => {
                state_snapshot.borrow_mut().invalidate();
                Ok(Some(app_msg.into_bytes()))
            }
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group
                    .merge_staged_commit(provider, *staged_commit)
                    .map_err(|e| MlsError::OpenMls(format!("Merge commit error: {:?}", e)))?;
                state_snapshot.borrow_mut().invalidate();
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
        }
    }
}
