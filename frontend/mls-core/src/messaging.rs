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

        // Both fields are always cleartext in the MLS frame header - safe to read
        // before decryption and invaluable for diagnosing epoch-mismatch errors.
        let msg_epoch = protocol_message.epoch();
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
                // If the message is from a past epoch, it's almost certainly our own
                // echoed commit (already merged via merge_pending_commit) or a stale
                // commit that another device already applied. The decryption keys for
                // commits are consumed during merge, so re-processing always fails with
                // AeadError. Silently succeed so the caller ACKs it on the gateway.
                if msg_epoch.as_u64() < group_epoch.as_u64() {
                    log::debug!(
                        "Stale message ignored: msg_epoch={} < group_epoch={} ({})",
                        msg_epoch,
                        group_epoch,
                        group_id
                    );
                    return Ok(None);
                }

                // Same-epoch sender-ratchet failures are PERMANENT - retrying never helps:
                //  - SecretReuseError    : this generation's key was already consumed
                //                          (duplicate delivery: realtime + queue + FCM).
                //  - TooDistantInThePast : the generation is older than the kept ratchet
                //                          window (out-of-order beyond tolerance). The key
                //                          is gone for good.
                // OpenMLS may surface the latter either raw or wrapped as NoPastEpochData;
                // both Debug strings carry the variant name, so a substring match is robust.
                // Treat them as a benign duplicate/late frame: ACK + drop (Ok(None)). This is
                // the single source of truth so every caller (native, WASM, background worker)
                // stops looping the message through its retry queue. Genuine epoch gaps are
                // handled by the `msg_epoch > group_epoch` fast-fail above, never here.
                let err_dbg = format!("{:?}", e);
                if err_dbg.contains("SecretReuseError")
                    || err_dbg.contains("TooDistantInThePast")
                    || err_dbg.contains("NoPastEpochData")
                {
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
