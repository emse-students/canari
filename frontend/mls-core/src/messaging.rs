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
            .map_err(|e| MlsError::OpenMls(format!("Encrypt error: {:?}", e)))?;

        self.mark_state_dirty();
        msg_out
            .tls_serialize_detached()
            .map_err(|e| MlsError::Serialization(e.to_string()))
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
