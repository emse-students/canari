//! Background MLS operations shared by Android (JNI) and iOS (C FFI).
//!
//! Every entry point here is key-based: callers hold the raw device key (base64) read from
//! `push_context.json`, never the user's PIN. The on-disk `mls.bin` wire format is
//! `[nonce (12) || ciphertext]` (ChaCha20-Poly1305 direct, no Argon2id, no salt prefix) --
//! always load and save through `MlsManager::load_with_key` / `save_encrypted_with_key`
//! so the format stays defined in exactly one place (`mls_core::security`).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use mls_core::crypto::decode_base64_to_32_bytes;
use mls_core::MlsManager;

use super::proto_fields::extract_full_message_info;
use super::push_text::PushLanguage;
use crate::concurrency::background_write_mls_bin;

/// Decodes a base64 device key and loads the MLS manager from the encrypted `mls.bin` bytes.
///
/// Single choke point for the background paths: it keeps the `[nonce || ciphertext]` layout
/// knowledge inside `mls_core` and returns the decoded key so callers can re-encrypt with it.
fn load_manager_with_key_b64(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
) -> Result<(MlsManager, [u8; 32]), String> {
    let key = decode_base64_to_32_bytes(key_b64.trim())?;
    let manager = MlsManager::load_with_key(user_id, device_id, Some(state_bytes.to_vec()), &key)
        .map_err(|e| e.to_string())?;
    Ok((manager, key))
}

/// `Option`-returning wrapper over [`load_manager_with_key_b64`] for the push-decrypt paths,
/// which degrade to a generic notification rather than surfacing an error.
/// A refusal that NAMES ITSELF, for the push-decrypt contract shared by the JNI and the iOS FFI.
///
/// `{"ok": false}` was returned from eleven distinct places - six JNI marshalling faults, an
/// unreadable state, a control frame, an MLS refusal, and an unrenderable plaintext - and every one
/// of them reached the phone's log as the single sentence `decryptProto: ok=false -> decryption
/// failed`. A line that cannot say which of eleven things happened sends its reader nowhere, and it
/// sat in the cross-client campaign's dirt on NOTIF-4 and NOTIF-10 for exactly that reason.
///
/// The reason is a STABLE TOKEN, never prose: the caller decides what to do with it - a control
/// frame is expected and a refused ratchet is not - and a distinction carried in a sentence is a
/// distinction exactly one call site will make.
fn refused(reason: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "reason": reason })
}

/// The refusal an MLS decrypt error becomes, split by the one question the native callers ask of
/// it: can a LATER state of this group read the same bytes?
///
/// `mls-refused` - perhaps: the frame names an epoch ahead of ours (`SenderRatchetGap` carries the
/// gap fast-fail), or nothing classified it. The commit catch-up and the worker are answers to that.
///
/// `mls-refused-for-good` - no: the frame was refused at an epoch this device already holds, so
/// applying commits builds the NEXT epoch and leaves this one's secrets exactly as they were. It
/// used to come back as `mls-refused` too, and the phone paid `fetchCommitsFromBackend` and a
/// `MlsBackgroundWorker` enqueue per message to learn `catchup: no commit to catch up` - learning
/// by failing what `mls-core` had already said (backlog, 2026-09-05).
///
/// The match is exhaustive on purpose: a new kind must be placed on one side, never defaulted.
fn refused_by_mls(error: &mls_core::MlsError) -> serde_json::Value {
    use mls_core::DecryptErrorKind as K;
    let kind = error.decrypt_kind();
    let reason = match kind {
        K::SenderRatchetGap | K::Other => "mls-refused",
        K::SecretReuse
        | K::GenerationTooFarAhead
        | K::PastEpochApplication
        | K::OwnMessage
        | K::Evicted
        | K::SameEpochRefusal
        | K::Unrecoverable => "mls-refused-for-good",
    };
    log::debug!("[PushBG] MLS refusal kind={kind:?} -> {reason}");
    let mut out = refused(reason);
    out["kind"] = serde_json::Value::String(format!("{kind:?}"));
    out
}

fn load_manager_for_push(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
) -> Option<(MlsManager, [u8; 32])> {
    match load_manager_with_key_b64(state_bytes, key_b64, user_id, device_id) {
        Ok(pair) => Some(pair),
        Err(e) => {
            log::error!("[PushBG] load mls.bin with device key failed: {e}");
            None
        }
    }
}

/// Decodes a JSON array of base64-encoded commit bytes (`["b64","b64",...]`, ordered by ascending
/// base epoch as the server returns them) into raw commit byte vectors for the in-memory catch-up.
/// Malformed entries are skipped rather than aborting the whole set. Shared by the Android JNI and
/// iOS FFI wrappers so both platforms decode commits identically.
pub fn decode_commits_b64_json(json: &str) -> Vec<Vec<u8>> {
    let arr: Vec<String> = serde_json::from_str(json).unwrap_or_default();
    arr.iter().filter_map(|s| STANDARD.decode(s).ok()).collect()
}

/// Decrypts a channel-message push (AES-256-GCM) and returns the message metadata JSON.
///
/// Channel messages are NOT MLS: they are AES-256-GCM encrypted with a per-epoch key the client
/// already holds (mirrored to `graine_seeds.json` by the foreground). The push carries the inline
/// ciphertext (`ciphertext||tag`) and 12-byte nonce; the raw 32-byte epoch key is looked up natively
/// so the plaintext never transits Google/FCM. The decrypted bytes are the same encoded AppMessage
/// proto as MLS, so `extract_full_message_info` parses them identically.
pub fn decrypt_channel_message(
    raw_key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    language: PushLanguage,
) -> Option<serde_json::Value> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    if raw_key.len() != 32 {
        log::error!(
            "[ChannelBG] invalid key length: {} (want 32)",
            raw_key.len()
        );
        return None;
    }
    if nonce.len() != 12 {
        log::error!(
            "[ChannelBG] invalid nonce length: {} (want 12)",
            nonce.len()
        );
        return None;
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(raw_key));
    let plaintext = match cipher.decrypt(Nonce::from_slice(nonce), ciphertext) {
        Ok(p) => p,
        Err(e) => {
            log::error!("[ChannelBG] AES-GCM decrypt failed: {e}");
            return None;
        }
    };

    let info = extract_full_message_info(&plaintext, language);
    if info["ok"].as_bool().unwrap_or(false) {
        Some(info)
    } else {
        None
    }
}

/// A salon push as a native service hands it over: the cleartext fields it read off the payload.
///
/// `signature_b64` is empty when the push carried none - a v1 row, or a v2 row the server stripped,
/// which the session's version tells apart.
#[derive(Debug, Clone, Copy)]
pub struct GrainePush<'a> {
    pub channel_id: &'a str,
    pub session_id: &'a str,
    pub index: u32,
    /// The author the server named. Under a v2 session it must be the session's minter.
    pub sender_id: &'a str,
    pub nonce_b64: &'a str,
    pub ciphertext_b64: &'a str,
    pub signature_b64: &'a str,
}

/// Opens a salon push against the seed mirror, and returns the metadata JSON of
/// [`decrypt_channel_message`] or a `refused` with its reason.
///
/// ONE IMPLEMENTATION FOR BOTH PLATFORMS (channel-encryption section 21.5): Android's
/// `nativeOpenGrainePush` and the iOS `canari_native_open_graine_push` hand it the push's fields and
/// the data directory, and every rule the web reader applies to a row is applied here, in the order
/// it applies them:
///
/// - the session is looked up under the push's OWN channel, so a row moved to another salon finds
///   nothing to open with;
/// - an index below the session's floor is refused, as the app refuses it;
/// - under a v2 session the named author must be the minter, the signature must be there, and it
///   must verify against the endorsed session key BEFORE AES-GCM runs with the header as AAD.
///
/// What it cannot do is refuse a REPLAY: a notification path holds no record of the rows it has
/// opened. A replayed push re-shows a banner the device already showed; the app, which does hold
/// that record, shows the row once.
///
/// `language` words what the scanner composes itself ([`PushLanguage`]).
pub fn open_graine_push(
    data_dir: &Path,
    push: &GrainePush<'_>,
    language: PushLanguage,
) -> serde_json::Value {
    let held =
        match crate::commands::push::read_graine_seed(data_dir, push.channel_id, push.session_id) {
            Ok(Some(held)) => held,
            Ok(None) => {
                log::debug!(
                    "[GraineBG] session {} of channel {} is not mirrored",
                    push.session_id,
                    push.channel_id
                );
                return refused("seed-not-mirrored");
            }
            Err(e) => {
                log::error!("[GraineBG] mirror unreadable: {e}");
                return refused("mirror-unreadable");
            }
        };
    if push.index < held.first_index {
        log::warn!(
            "[GraineBG] index {} is below session {}'s floor {} - refused, as the app refuses it",
            push.index,
            push.session_id,
            held.first_index
        );
        return refused("below-floor");
    }
    let decode = |name: &str, b64: &str| {
        let bytes = STANDARD.decode(b64.trim()).ok();
        if bytes.is_none() {
            log::error!("[GraineBG] push field {name} is not base64");
        }
        bytes
    };
    let (Some(seed), Some(nonce), Some(ciphertext)) = (
        decode("seed", &held.seed_b64),
        decode("nonce", push.nonce_b64),
        decode("ciphertext", push.ciphertext_b64),
    ) else {
        return refused("push-field-malformed");
    };

    let Some((minter, signing_pk_b64)) = &held.v2 else {
        return open_graine_push_v1(&seed, push, &nonce, &ciphertext, language);
    };
    if !push.sender_id.eq_ignore_ascii_case(minter) {
        log::error!(
            "[GraineBG] REFUSED: push names {} as the author of session {}, minted by {minter}",
            push.sender_id,
            push.session_id
        );
        return refused("author-mismatch");
    }
    if push.signature_b64.is_empty() {
        log::error!(
            "[GraineBG] REFUSED: a row of v2 session {} carries no signature",
            push.session_id
        );
        return refused("signature-missing");
    }
    let (Some(signature), Some(signing_pk)) = (
        decode("signature", push.signature_b64),
        decode("signingPk", signing_pk_b64),
    ) else {
        return refused("push-field-malformed");
    };
    let header = crate::mobile::graine::GraineHeaderV2 {
        channel_id: push.channel_id,
        session_id: push.session_id,
        minter_user_id: minter,
        index: push.index,
    };
    // `open_graine_message_v2` logs which check refused it.
    let plaintext = match crate::mobile::graine::open_graine_message_v2(
        &seed,
        &header,
        &nonce,
        &ciphertext,
        &signature,
        &signing_pk,
    ) {
        Ok(p) => p,
        Err(crate::mobile::graine::GraineV2Error::Signature(_)) => {
            return refused("signature-refused")
        }
        Err(_) => return refused("graine-open-failed"),
    };
    let info = extract_full_message_info(&plaintext, language);
    if info["ok"].as_bool().unwrap_or(false) {
        info
    } else {
        log::debug!(
            "[GraineBG] v2 row of session {} opened and is not renderable",
            push.session_id
        );
        refused("plaintext-not-renderable")
    }
}

/// The v1 half of [`open_graine_push`]: no author, no signature, no AAD - what v1 is.
fn open_graine_push_v1(
    seed: &[u8],
    push: &GrainePush<'_>,
    nonce: &[u8],
    ciphertext: &[u8],
    language: PushLanguage,
) -> serde_json::Value {
    let key = match crate::mobile::graine::derive_message_key(seed, push.session_id, push.index) {
        Ok(k) => k,
        Err(e) => {
            log::error!(
                "[GraineBG] cannot derive key for session {} index {}: {e:?}",
                push.session_id,
                push.index
            );
            return refused("graine-open-failed");
        }
    };
    decrypt_channel_message(&key, nonce, ciphertext, language)
        .unwrap_or_else(|| refused("graine-open-failed"))
}

/// Decrypts an end-to-end-encrypted media blob (AES-256-GCM) for a notification thumbnail (WP-XP-3).
///
/// The CEK (`raw_key`, 32 bytes) and IV (`iv`, 12 bytes) come from the MLS-decrypted `MediaMsg`
/// (never from the server); `ciphertext` is the opaque `ciphertext||tag` blob the native handler
/// downloaded from the media service by `mediaId`. Identical crypto to the in-app WebCrypto
/// `decryptMediaBuffer` (single-shot GCM, 16-byte tag appended). Returns the plaintext bytes
/// (image/GIF) or None on any validation/decrypt failure.
pub fn decrypt_media_blob(raw_key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    if raw_key.len() != 32 {
        log::error!("[MediaBG] invalid key length: {} (want 32)", raw_key.len());
        return None;
    }
    if iv.len() != 12 {
        log::error!("[MediaBG] invalid iv length: {} (want 12)", iv.len());
        return None;
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(raw_key));
    match cipher.decrypt(Nonce::from_slice(iv), ciphertext) {
        Ok(plaintext) => Some(plaintext),
        Err(e) => {
            log::error!("[MediaBG] AES-GCM decrypt failed: {e}");
            None
        }
    }
}

/// Creates an MLS Welcome for a new device from the background (app may be killed).
/// Key-based variant: uses the pre-derived device key (base64) instead of the PIN.
pub fn create_welcome_background_with_key(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    key_package_b64: &str,
) -> Result<serde_json::Value, String> {
    let kp_bytes = STANDARD
        .decode(key_package_b64.trim())
        .map_err(|e| format!("base64 decode key_package: {e}"))?;

    let (mut manager, key) = load_manager_with_key_b64(state_bytes, key_b64, user_id, device_id)?;
    // The events already waiting in the state are not this Add's; only those after them are.
    let events_before = manager.pending_device_events().len();

    let base_epoch = manager.get_epoch(group_id).map_err(|e| e.to_string())?;

    log::debug!(
        "[BG_WELCOME] add_member group={group_id} kp_len={} base_epoch={base_epoch}",
        kp_bytes.len()
    );
    let (commit, welcome_opt) = manager
        .add_member(group_id, &kp_bytes)
        .map_err(|e| e.to_string())?;

    let welcome = welcome_opt.ok_or_else(|| "add_member returned no welcome bytes".to_string())?;

    // Stage-only add (C7-A). This background path cannot do the interactive validate-then-merge
    // round-trip (the app may be killed); it is serialized by the add-lock like the bootstrap path,
    // so merge immediately and export the post-merge ratchet tree the new member joins with.
    manager
        .merge_pending_commit_for(group_id)
        .map_err(|e| e.to_string())?;
    let ratchet_tree = manager
        .export_ratchet_tree_for(group_id)
        .map_err(|e| e.to_string())?;

    let enc = manager
        .save_encrypted_with_key(&key)
        .map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_WELCOME] mls.bin updated ({} bytes) for group={group_id}",
        enc.len()
    );

    // The device this Add admitted may be a new device of THIS account - the phone serving its own
    // account's new laptop. The events stay in the saved state for the app's notices; the keys go
    // to the caller for the local notification (`ownDeviceAdded`, as on the decrypt paths), which it
    // raises only once the server ACCEPTED the commit. `addedEvents` names this Add's events, so a
    // refusal withdraws them (`device_notice::withdraw_device_events_json`) before the app reads them.
    let pending = manager.pending_device_events();
    let added = &pending[events_before.min(pending.len())..];
    let own_alerts = super::device_notice::owner_alert_keys_of(added, user_id, device_id);
    let added_ids: Vec<String> = added
        .iter()
        .map(super::device_notice::device_event_id)
        .collect();
    let mut answer = serde_json::json!({
        "ok": true,
        "welcome": STANDARD.encode(&welcome),
        "ratchetTree": STANDARD.encode(&ratchet_tree),
        "commit": STANDARD.encode(&commit),
        "baseEpoch": base_epoch,
        "addedEvents": added_ids,
    });
    if !own_alerts.is_empty() {
        answer["ownDeviceAdded"] = serde_json::json!(own_alerts);
    }
    Ok(answer)
}

/// Applies an MLS Welcome received in the background (receiver side).
/// Key-based variant: uses the pre-derived device key (base64) instead of the PIN.
pub fn process_welcome_background_with_key(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    welcome_b64: &str,
    ratchet_tree_b64: &str,
) -> Result<(), String> {
    let welcome_bytes = STANDARD
        .decode(welcome_b64.trim())
        .map_err(|e| format!("base64 decode welcome: {e}"))?;

    let rt_trimmed = ratchet_tree_b64.trim();
    let ratchet_tree_bytes = if rt_trimmed.is_empty() || rt_trimmed == "null" {
        None
    } else {
        Some(
            STANDARD
                .decode(rt_trimmed)
                .map_err(|e| format!("base64 decode ratchet tree: {e}"))?,
        )
    };

    let (mut manager, key) = load_manager_with_key_b64(state_bytes, key_b64, user_id, device_id)?;

    let group_id = manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| format!("process_welcome: {e:?}"))?;

    let enc = manager
        .save_encrypted_with_key(&key)
        .map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_JOIN] joined group via Welcome: {group_id} (mls.bin {} bytes)",
        enc.len()
    );
    Ok(())
}

/// One entry of an outbox drain batch, as the platform mirrors store it. `id` is echoed back
/// untouched so a caller can never mis-zip its own list against the results.
#[derive(serde::Deserialize)]
pub struct OutboxEntry {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "groupId")]
    pub group_id: String,
    /// Base64 plaintext `AppMessage` proto.
    pub proto: String,
}

/// Encrypts a WHOLE batch of queued outbound messages against ONE load of `mls.bin`, then persists
/// it ONCE.
///
/// # Why this is a batch and not a loop over the single-message call
///
/// Both platform drains used to call the single-message entry point per queued message, so `N`
/// messages meant `N` full CBOR decodes of the entire MLS keystore plus `N` re-serialise-and-write
/// cycles - `O(N x |mls.bin|)` work inside a `goAsync()` / background-task deadline the OS enforces
/// at 60 s. That is what ANRed the app from `CanariBootReceiver` after a store update, with the
/// per-byte decode of WP-ANR-1 multiplying it. Loading once makes the drain `O(|mls.bin| + N)`, so
/// it holds for a backlog of any size rather than for backlogs under a cap.
///
/// # Ordering, which is load-bearing
///
/// The state is saved BEFORE any ciphertext is returned, and a save failure discards the entire
/// batch. A frame handed to the caller is a frame the caller will POST, so a ciphertext escaping
/// while the ratchet advance that produced it is not durable is exactly WP-LOSS-1 - the sender
/// rewinds and the peer can never decrypt what follows. Undelivered entries simply stay in the
/// mirror and are re-encrypted at a fresh generation on the next drain, which is harmless.
///
/// A per-entry failure (typically `GroupNotFound`: the group is not joined on this device yet) is
/// isolated and reported in its own result, never allowed to abort the rest of the batch.
pub fn send_messages_background_with_key(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    entries: &[OutboxEntry],
) -> Result<serde_json::Value, String> {
    if entries.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "results": [] }));
    }

    // The one load for the whole batch.
    let (mut manager, key) = load_manager_with_key_b64(state_bytes, key_b64, user_id, device_id)?;

    let mut results = Vec::with_capacity(entries.len());
    let mut encrypted = 0usize;
    for entry in entries {
        match encrypt_one(&mut manager, entry) {
            Ok(ciphertext) => {
                encrypted += 1;
                results.push(serde_json::json!({
                    "id": entry.id,
                    "ok": true,
                    "ciphertext": STANDARD.encode(&ciphertext),
                }));
            }
            Err(e) => {
                // Isolated on purpose: one unjoined group must not strand the rest of the backlog.
                log::warn!(
                    "[BG_SEND] entry skipped group={} : {e}",
                    entry.group_id.chars().take(8).collect::<String>()
                );
                results.push(serde_json::json!({
                    "id": entry.id,
                    "ok": false,
                    "error": e,
                }));
            }
        }
    }

    // The one save for the whole batch - and it happens before any ciphertext leaves this function.
    let enc = manager
        .save_encrypted_with_key(&key)
        .map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_SEND] batch encrypted {encrypted}/{} (mls.bin {} bytes, 1 load, 1 save)",
        entries.len(),
        enc.len()
    );

    Ok(serde_json::json!({ "ok": true, "results": results }))
}

/// Encrypts a single entry against an already-loaded manager. Split out so the batch loop has one
/// obvious failure boundary per entry.
fn encrypt_one(manager: &mut MlsManager, entry: &OutboxEntry) -> Result<Vec<u8>, String> {
    let proto_bytes = STANDARD
        .decode(entry.proto.trim())
        .map_err(|e| format!("base64 decode proto: {e}"))?;
    manager
        .send_message(&entry.group_id, &proto_bytes)
        .map_err(|e| format!("send_message: {e:?}"))
}

/// Parses the batch JSON the platform drains pass across the FFI boundary:
/// `[{"id":"...","groupId":"...","proto":"<b64>"}, ...]`.
pub fn parse_outbox_entries_json(json: &str) -> Result<Vec<OutboxEntry>, String> {
    serde_json::from_str(json).map_err(|e| format!("parse outbox entries: {e}"))
}

/// Prunes `mls_pending.db` (exhausted / expired messages). Mirrors `MlsBackgroundWorker`.
pub fn cleanup_pending_db(files_dir: &Path) -> Result<(), String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let db_path = files_dir.join("mls_pending.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                    .busy_timeout(std::time::Duration::from_secs(5)),
            )
            .await
            .map_err(|e| e.to_string())?;

        let cutoff_attempt_ns: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64
            - 3_600_000_000_000i64;
        let _ = sqlx::query(
            "DELETE FROM pending_mls_messages WHERE attempt_count >= 3 AND created_at < ?",
        )
        .bind(cutoff_attempt_ns)
        .execute(&pool)
        .await;

        let cutoff_ns: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64
            - 7i64 * 24 * 60 * 60 * 1_000_000_000;
        let _ = sqlx::query("DELETE FROM pending_mls_messages WHERE created_at < ?")
            .bind(cutoff_ns)
            .execute(&pool)
            .await;

        Ok::<(), String>(())
    })
}

// --- Read-only push decrypt paths -------------------------------------------
//
// These never persist `mls.bin`: a background decrypt must not advance the on-disk state
// (the foreground owns it), so the loaded manager is discarded after the plaintext is read.

/// One MLS frame a push carried, as the native service read it off the payload.
#[derive(Debug, Clone, Copy)]
pub struct PushFrame<'a> {
    pub group_id: &'a str,
    /// The push's `senderId`. The frame is refused when MLS verified somebody else (WP-G2-1b).
    pub sender_id: &'a str,
    pub ciphertext: &'a [u8],
}

/// Decrypts an MLS push payload for a notification preview, read-only.
///
/// Uses the pre-derived 32-byte device key (base64) from `push_context.json`. Returns the
/// message metadata JSON, or `None` on any failure so the caller falls back to a generic
/// notification.
pub fn decrypt_push_message_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    frame: &PushFrame<'_>,
    language: PushLanguage,
) -> serde_json::Value {
    let Some((mut manager, _key)) = load_manager_for_push(state_bytes, key_b64, user_id, device_id)
    else {
        return refused("state-unreadable");
    };

    let answer = decrypt_loaded(&mut manager, frame, language);
    with_owner_alerts(answer, &mut manager, user_id, device_id)
}

/// Adds `ownDeviceAdded` - the keys of the "a new device was added to your account" alerts the
/// commits this push path merged in memory produced (`device_notice::owner_alert_keys`) - to a
/// push-decrypt answer, WHATEVER the answer is: a control frame, a message, a refusal after the
/// catch-up applied its commits. Absent when there are none. The native caller claims the keys in
/// the shared ledger and raises one local notification for those it claimed.
fn with_owner_alerts(
    mut answer: serde_json::Value,
    manager: &mut MlsManager,
    user_id: &str,
    device_id: &str,
) -> serde_json::Value {
    let keys = super::device_notice::owner_alert_keys(manager, user_id, device_id);
    if !keys.is_empty() {
        if let Some(obj) = answer.as_object_mut() {
            obj.insert("ownDeviceAdded".to_string(), serde_json::json!(keys));
        }
    }
    answer
}

/// The body of [`decrypt_push_message_with_key`] once the state is loaded.
fn decrypt_loaded(
    manager: &mut MlsManager,
    frame: &PushFrame<'_>,
    language: PushLanguage,
) -> serde_json::Value {
    let app = match manager.process_incoming_message_with_sender(frame.group_id, frame.ciphertext) {
        Ok(Some(app)) => app,
        Ok(None) => {
            // NOT A FAILURE, AND THE CALLERS USED TO BE TOLD IT WAS. A commit or a proposal is
            // applied and yields no application message: the state ADVANCED, there is simply
            // nothing to render. It came back as the same bare `{"ok": false}` as a corrupt key,
            // so the Android log said `decryption failed` for work that succeeded - measured on
            // NOTIF-4 and NOTIF-10, 2026-09-07, where it was the whole of the remaining dirt.
            log::debug!("[PushBG] key-based: control frame applied, nothing to render");
            return refused("control-frame");
        }
        Err(e) => {
            log::error!("[PushBG] key-based: process_incoming_message Err({e})");
            return refused_by_mls(&e);
        }
    };

    classify_verified(manager, frame.group_id, frame.sender_id, app, language)
}

/// Refuses a decrypted frame whose envelope names another sender than the one MLS verified, then
/// classifies it - and drops every v2 seed it carries whose endorsement the key group's tree does
/// not bear out (channel-encryption section 21.5).
///
/// The native twin of `verifiedSender.ts` and `endorsement.ts`, in ONE place for both platforms.
/// `envelope_sender` is the push's `senderId`, which the server always sends; a credential the
/// engine cannot read is refused like a mismatch, as the app refuses it.
fn classify_verified(
    manager: &MlsManager,
    group_id: &str,
    envelope_sender: &str,
    app: mls_core::IncomingApplication,
    language: PushLanguage,
) -> serde_json::Value {
    let verified_user = app
        .sender_identity
        .as_deref()
        .map(|identity| identity.split_once(':').map_or(identity, |(user, _)| user));
    if !verified_user.is_some_and(|user| user.eq_ignore_ascii_case(envelope_sender)) {
        log::error!(
            "[PushBG] SENDER MISMATCH group={} envelope={envelope_sender} verified={} - REFUSED, the generic banner is shown",
            group_id.get(..8).unwrap_or(group_id),
            app.sender_identity.as_deref().unwrap_or("unreadable")
        );
        return refused("sender-mismatch");
    }
    let mut out = classify_plaintext(&app.plaintext, language);
    if out["reason"] == "graine-key-material" {
        let seeds = out["seeds"].as_array().cloned().unwrap_or_default();
        let offered = seeds.len();
        // NAMED IN THE ANSWER, because this crate's log reaches no logger in a killed Android app or
        // in the iOS extension: the native callers print it (section 21.7).
        let v1_refused: Vec<serde_json::Value> = seeds
            .iter()
            .filter(|seed| seed["version"].as_u64() != Some(2))
            .map(|seed| seed["sessionId"].clone())
            .collect();
        let kept: Vec<serde_json::Value> = seeds
            .into_iter()
            .filter(|seed| endorsed_by_tree(manager, group_id, seed))
            .collect();
        if kept.len() < offered {
            log::warn!(
                "[PushBG] kept {} of {offered} seed(s) on {}: the rest are refused or wait for the app",
                kept.len(),
                group_id.get(..8).unwrap_or(group_id)
            );
        }
        out["seeds"] = kept.into();
        if !v1_refused.is_empty() {
            out["v1Refused"] = v1_refused.into();
        }
    }
    out
}

/// Whether a seed a key-material frame carried may reach the mirror: a v2 seed only once its
/// endorsement verifies against the minting device's leaf in `group_id`'s tree, and a v1 seed never.
///
/// A v1 seed is refused since `minClientVersion` reached the v2 writer (channel-encryption section
/// 21.7), the native twin of `storeIncomingSeed`. A v1 session the app already holds is mirrored by
/// the app itself (`store_graine_seed`), so dropping its copy here loses nothing.
///
/// NO SERVER HERE, unlike the app: a push handler holds no user session to ask the published keys
/// with. A minter that has left the tree is therefore UNANSWERED, not refused - the seed is not
/// mirrored, the app checks it against the server when it runs, and mirrors it then.
fn endorsed_by_tree(manager: &MlsManager, group_id: &str, seed: &serde_json::Value) -> bool {
    if seed["version"].as_u64() != Some(2) {
        log::warn!(
            "[GRAINE_V2] REFUSED v1 seed {}: a v1 seed is no longer accepted",
            seed["sessionId"].as_str().unwrap_or_default()
        );
        return false;
    }
    let text = |k: &str| seed[k].as_str().unwrap_or_default();
    let bytes = |k: &str| STANDARD.decode(text(k)).unwrap_or_default();
    let (session_id, minter, minter_device) = (
        text("sessionId"),
        text("minterUserId"),
        text("minterDeviceId"),
    );
    let (seed_bytes, signing_pk, endorsement) = (
        bytes("seedB64"),
        bytes("signingPublicKeyB64"),
        bytes("endorsementB64"),
    );
    if minter.is_empty()
        || minter_device.is_empty()
        || signing_pk.is_empty()
        || endorsement.is_empty()
    {
        log::error!(
            "[GRAINE_V2] REFUSED v2 seed {session_id}: its minter, key or endorsement is missing"
        );
        return false;
    }
    let identity = format!("{minter}:{minter_device}");
    let device_key = match manager.member_signature_key(group_id, &identity) {
        Ok(Some(key)) => key,
        Ok(None) => {
            log::warn!(
                "[GRAINE_V2] v2 seed {session_id}: {identity} has left the tree - NOT mirrored, the app checks it against the server"
            );
            return false;
        }
        Err(e) => {
            log::error!("[GRAINE_V2] v2 seed {session_id}: the key group cannot be read ({e})");
            return false;
        }
    };
    let commitment = crate::mobile::graine::seed_commitment(&seed_bytes);
    let descriptor = crate::mobile::graine::GraineEndorsementV2 {
        channel_id: text("channelId"),
        session_id,
        minter_user_id: minter,
        minter_device_id: minter_device,
        signing_public_key: &signing_pk,
        seed_commitment: &commitment,
        created_at: seed["createdAt"].as_i64().unwrap_or(0).max(0) as u64,
    };
    // `verify_endorsement_v2` logs which check refused it.
    match crate::mobile::graine::verify_endorsement_v2(
        &descriptor,
        &seed_bytes,
        &endorsement,
        &device_key,
    ) {
        Ok(()) => true,
        Err(_) => {
            log::error!("[GRAINE_V2] REFUSED v2 seed {session_id}: not endorsed by {identity}");
            false
        }
    }
}

/// What a DECRYPTED push frame is, in the one shape both push decrypt paths return.
///
/// A renderable message comes back as its info (`ok: true`); anything else as a `refused` reason,
/// Graine key material carrying its seeds. SHARED BECAUSE THE CATCH-UP PATH LOST SEEDS WITHOUT IT:
/// `decrypt_push_message_with_commits_with_key` kept only `ok: true`, so a seed sealed one commit
/// ahead of the device was decrypted after the catch-up and then thrown away (NOTIF-19, 2026-09-27).
fn classify_plaintext(plaintext: &[u8], language: PushLanguage) -> serde_json::Value {
    let info = extract_full_message_info(plaintext, language);
    if info["ok"].as_bool().unwrap_or(false) {
        return info;
    }
    // A FRAME THAT RINGS NOBODY MAY STILL HAVE SOMETHING TO SAY. `ok: false` is the notification
    // path's answer and stays exactly that; collapsing it to one refusal also threw away the KIND,
    // and with it the Graine key material the caller is about to write to the mirror. The one
    // reason this function had to know about that: it is the only place holding the plaintext.
    //
    // NAMED AS A `reason`, LIKE EVERY OTHER REFUSAL HERE, so the caller keeps ONE switch. The
    // absorber's vocabulary is this function's `reason` token, not a second dispatch axis a reader
    // would have to know to look for.
    match info["kind"].as_str() {
        Some("graine_key_material") => {
            let count = info["seeds"].as_array().map_or(0, Vec::len);
            log::debug!("[PushBG] key-based: graine key material, seeds={count}");
            let mut out = refused("graine-key-material");
            out["seeds"] = info["seeds"].clone();
            out
        }
        Some("graine_request") => {
            log::debug!("[PushBG] key-based: a peer asks for a seed; the foreground answers those");
            refused("graine-request")
        }
        // A kind this function has not been taught is still not renderable, and saying which one
        // is the difference between a diagnosis and a mystery the next time one is added.
        Some(other) => {
            log::debug!("[PushBG] key-based: nothing to render, kind={other}");
            refused("plaintext-not-renderable")
        }
        None => refused("plaintext-not-renderable"),
    }
}

/// Reads the current MLS epoch of `group_id` from the encrypted state, read-only.
///
/// Used to decide whether the pushed ciphertext belongs to a newer epoch than the one on
/// disk, which is what triggers the commit catch-up path below.
pub fn background_group_epoch_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
) -> Option<u64> {
    let (manager, _key) = load_manager_for_push(state_bytes, key_b64, user_id, device_id)?;
    manager.get_epoch(group_id).ok()
}

/// Decrypts an MLS push payload after applying `commits` in memory, read-only, answering in the
/// same shape as [`decrypt_push_message_with_key`] - key material included.
///
/// `commits` are ordered by ascending base epoch. They are applied to the loaded manager only
/// to reach the sender's epoch; the result is never written back, so the foreground stays the
/// single writer of `mls.bin`.
pub fn decrypt_push_message_with_commits_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    commits: &[Vec<u8>],
    frame: &PushFrame<'_>,
    language: PushLanguage,
) -> serde_json::Value {
    let Some((mut manager, _key)) = load_manager_for_push(state_bytes, key_b64, user_id, device_id)
    else {
        return refused("state-unreadable");
    };

    for commit in commits {
        match manager.process_incoming_message(frame.group_id, commit) {
            Ok(_) => {}
            Err(e) => {
                log::warn!("[PushBG] key-based catch-up: commit apply failed, stopping - {e}");
                break;
            }
        }
    }

    let answer = match manager
        .process_incoming_message_with_sender(frame.group_id, frame.ciphertext)
    {
        Ok(Some(app)) => {
            classify_verified(&manager, frame.group_id, frame.sender_id, app, language)
        }
        Ok(None) => {
            log::debug!("[PushBG] key-based catch-up: control frame applied, nothing to render");
            refused("control-frame")
        }
        Err(e) => {
            log::error!("[PushBG] key-based catch-up decrypt failed: {e}");
            refused_by_mls(&e)
        }
    };
    with_owner_alerts(answer, &mut manager, user_id, device_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A distinct device key per test so no two tests can read the same `mls.bin`.
    fn key_b64(seed: u8) -> String {
        STANDARD.encode([seed; 32])
    }

    /// A temp directory of its own, so the `mls.bin` each test writes is its own.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-bg-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Two real MLS clients in one group: `alice` is the sender under test, `bob` the peer whose
    /// successful decrypt is the only honest proof that the ratchet was used correctly.
    fn joined_pair(tag: &str) -> (MlsManager, MlsManager, String) {
        let group_id = format!("{tag}-group");
        let mut alice = MlsManager::load_or_create(&format!("{tag}-alice"), "dev-a", None)
            .expect("alice load_or_create");
        let mut bob = MlsManager::load_or_create(&format!("{tag}-bob"), "dev-b", None)
            .expect("bob load_or_create");

        alice.create_group(group_id.clone()).expect("create_group");
        let kp = bob.generate_key_package().expect("bob key package");
        let (_commit, welcome, _added, _skipped) = alice
            .add_members_bulk(&group_id, &[&kp])
            .expect("add_members_bulk");
        alice
            .merge_pending_commit_for(&group_id)
            .expect("merge add commit");
        let tree = alice
            .export_ratchet_tree_for(&group_id)
            .expect("export ratchet tree");
        bob.process_welcome(welcome.as_deref().expect("welcome"), Some(&tree))
            .expect("bob process_welcome");

        (alice, bob, group_id)
    }

    fn entry(id: &str, group_id: &str, plaintext: &[u8]) -> OutboxEntry {
        OutboxEntry {
            id: id.to_string(),
            group_id: group_id.to_string(),
            proto: STANDARD.encode(plaintext),
        }
    }

    fn ciphertexts_of(value: &serde_json::Value) -> Vec<Vec<u8>> {
        value["results"]
            .as_array()
            .expect("results array")
            .iter()
            .filter(|r| r["ok"].as_bool() == Some(true))
            .map(|r| {
                STANDARD
                    .decode(r["ciphertext"].as_str().expect("ciphertext"))
                    .expect("base64 ciphertext")
            })
            .collect()
    }

    /// The whole contract of the batch drain, and in particular the WP-LOSS-1 half: the single save
    /// must cover EVERY ratchet advance the batch made. The proof is the 6th message - it is
    /// encrypted by a manager reloaded from the `mls.bin` the batch wrote, so if that file were
    /// behind by even one generation, bob would reject it as a consumed secret rather than decrypt
    /// it. A test that only checked the five would pass with a save that persisted just the first.
    #[test]
    fn one_load_and_one_save_cover_every_advance_in_the_batch() {
        let (alice, mut bob, group_id) = joined_pair("batch");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(7)).expect("key");
        let state_bytes = alice.save_encrypted_with_key(&key).expect("encrypt state");
        let dir = temp_dir("batch");

        let plaintexts: Vec<Vec<u8>> = (0..5).map(|i| format!("msg-{i}").into_bytes()).collect();
        let entries: Vec<OutboxEntry> = plaintexts
            .iter()
            .enumerate()
            .map(|(i, p)| entry(&format!("id-{i}"), &group_id, p))
            .collect();

        let out = send_messages_background_with_key(
            &dir,
            &state_bytes,
            &key_b64(7),
            "batch-alice",
            "dev-a",
            &entries,
        )
        .expect("batch send");

        let results = out["results"].as_array().expect("results");
        assert_eq!(results.len(), 5, "one result per entry, in order");
        for (i, r) in results.iter().enumerate() {
            assert_eq!(r["ok"].as_bool(), Some(true), "entry {i} must encrypt");
            assert_eq!(
                r["id"].as_str(),
                Some(format!("id-{i}").as_str()),
                "id echo"
            );
        }

        let frames = ciphertexts_of(&out);
        for (i, frame) in frames.iter().enumerate() {
            let plain = bob
                .process_incoming_message(&group_id, frame)
                .unwrap_or_else(|e| panic!("bob decrypt {i}: {e:?}"))
                .expect("application message");
            assert_eq!(plain, plaintexts[i]);
        }

        // The saved state must be ahead of all five, not of the first.
        let saved = std::fs::read(dir.join("mls.bin")).expect("mls.bin written");
        let sixth = send_messages_background_with_key(
            &dir,
            &saved,
            &key_b64(7),
            "batch-alice",
            "dev-a",
            &[entry("id-5", &group_id, b"msg-5")],
        )
        .expect("send from the reloaded state");
        let plain = bob
            .process_incoming_message(&group_id, &ciphertexts_of(&sixth)[0])
            .expect("bob decrypt 6th - a rewound save would fail here")
            .expect("application message");
        assert_eq!(plain, b"msg-5");
    }

    /// One unjoined group must not strand the rest of the backlog: the failure is reported in its
    /// own result and the entries around it still encrypt and still decrypt in order.
    #[test]
    fn a_failing_entry_is_isolated_and_the_batch_continues() {
        let (alice, mut bob, group_id) = joined_pair("isolate");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(9)).expect("key");
        let state_bytes = alice.save_encrypted_with_key(&key).expect("encrypt state");
        let dir = temp_dir("isolate");

        let entries = vec![
            entry("ok-1", &group_id, b"first"),
            entry("bad", "a-group-this-device-never-joined", b"doomed"),
            entry("ok-2", &group_id, b"second"),
        ];

        let out = send_messages_background_with_key(
            &dir,
            &state_bytes,
            &key_b64(9),
            "isolate-alice",
            "dev-a",
            &entries,
        )
        .expect("batch send");

        let results = out["results"].as_array().expect("results");
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["ok"].as_bool(), Some(true));
        assert_eq!(results[1]["ok"].as_bool(), Some(false), "unjoined group");
        assert_eq!(results[2]["ok"].as_bool(), Some(true), "not aborted by it");
        assert!(results[1]["error"]
            .as_str()
            .expect("error string")
            .contains("GroupNotFound"));

        let frames = ciphertexts_of(&out);
        assert_eq!(frames.len(), 2);
        assert_eq!(
            bob.process_incoming_message(&group_id, &frames[0])
                .expect("decrypt first")
                .expect("application message"),
            b"first"
        );
        assert_eq!(
            bob.process_incoming_message(&group_id, &frames[1])
                .expect("decrypt second")
                .expect("application message"),
            b"second"
        );
    }

    #[test]
    fn an_empty_batch_writes_nothing_and_returns_no_results() {
        let dir = temp_dir("empty");
        let _ = std::fs::remove_file(dir.join("mls.bin"));
        let out = send_messages_background_with_key(&dir, &[], &key_b64(3), "u", "d", &[])
            .expect("empty batch");
        assert_eq!(out["results"].as_array().expect("results").len(), 0);
        assert!(
            !dir.join("mls.bin").exists(),
            "an empty drain must not touch mls.bin"
        );
    }

    /// A v2 seed frame minted by `minter` on `dev-a` and endorsed by its own leaf - the only kind of
    /// seed the push path mirrors since a v1 seed is refused (channel-encryption section 21.7).
    fn endorsed_seed_frame(
        minter: &MlsManager,
        minter_id: &str,
        session_id: &str,
        seed: &[u8; 32],
    ) -> Vec<u8> {
        use super::super::graine::{encode_endorsement_v2, seed_commitment, GraineEndorsementV2};
        use super::super::proto_fields::{build_graine_v2_app_message, GraineV2Fields};
        let signing_pk = [9u8; 32];
        let created_at = 1_700_000_000_000i64;
        let d = encode_endorsement_v2(&GraineEndorsementV2 {
            channel_id: "ch-salon",
            session_id,
            minter_user_id: minter_id,
            minter_device_id: "dev-a",
            signing_public_key: &signing_pk,
            seed_commitment: &seed_commitment(seed),
            created_at: created_at as u64,
        })
        .expect("descriptor");
        let endorsement = minter.sign_with_device_credential(&d).expect("sign");
        build_graine_v2_app_message(
            "ch-salon",
            session_id,
            seed,
            created_at,
            &GraineV2Fields {
                minter_user_id: minter_id,
                minter_device_id: "dev-a",
                signing_public_key: &signing_pk,
                endorsement: &endorsement,
            },
        )
    }

    /// THE DEFECT, OVER A REAL MLS FRAME AND NOT A HAND-BUILT BUFFER.
    ///
    /// A Graine seed reaches a killed phone as an ordinary silent push. Everything downstream -
    /// the Kotlin absorber, `graine_seeds.json`, `lookupGraineSeed`, the banner text - hangs off
    /// what THIS function answers, and it used to answer `plaintext-not-renderable`: the same
    /// sentence as a corrupt frame, so the seed was dropped and every message of that session
    /// showed the generic fallback until the app was next opened.
    ///
    /// The frame is encrypted by alice and opened by bob through the push path, so the parse runs
    /// on bytes that crossed the ratchet rather than on bytes a test wrote and read back.
    ///
    /// NOTHING HERE ASSERTS THAT `mls.bin` IS UNTOUCHED, because the signature already does: this
    /// function takes an immutable slice and no path, and has nowhere to write. The read-only
    /// invariant is enforced by the type, which is stronger than a test of it.
    #[test]
    fn a_graine_seed_survives_the_push_path_that_used_to_drop_it() {
        let (alice, bob, group_id) = joined_pair("graine");
        let key = decode_base64_to_32_bytes(&key_b64(11)).expect("key");
        let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let dir = temp_dir("graine");

        let seed = [42u8; 32];
        let frame = endorsed_seed_frame(&alice, "graine-alice", "sess-abc", &seed);
        let out = send_messages_background_with_key(
            &dir,
            &alice_state,
            &key_b64(11),
            "graine-alice",
            "dev-a",
            &[entry("seed-1", &group_id, &frame)],
        )
        .expect("alice encrypts the seed frame");
        let ciphertext = &ciphertexts_of(&out)[0];

        // Bob opens it from his own encrypted state, exactly as the push path loads it.
        let bob_state = bob.save_encrypted_with_key(&key).expect("encrypt bob");
        let info = decrypt_push_message_with_key(
            &bob_state,
            &key_b64(11),
            "graine-bob",
            "dev-b",
            &PushFrame {
                group_id: &group_id,
                sender_id: "graine-alice",
                ciphertext,
            },
            PushLanguage::French,
        );

        assert_eq!(info["ok"], false, "key material must still ring nobody");
        assert_eq!(
            info["reason"], "graine-key-material",
            "the token the Kotlin absorber switches on"
        );
        let seeds = info["seeds"]
            .as_array()
            .expect("seeds travel with the reason");
        assert_eq!(seeds.len(), 1);
        assert_eq!(seeds[0]["channelId"], "ch-salon");
        assert_eq!(seeds[0]["sessionId"], "sess-abc");
        assert_eq!(seeds[0]["seedB64"], STANDARD.encode(seed));
    }

    /// NOTIF-19, 2026-09-27: a seed sealed ONE COMMIT AHEAD of the device must come out of the
    /// catch-up as key material. It was decrypted there and then dropped for having no text, so a
    /// shut phone behind its community's key group never received the seed of any new session.
    #[test]
    fn a_graine_seed_sealed_one_commit_ahead_survives_the_catch_up() {
        let (mut alice, bob, group_id) = joined_pair("graine-ahead");
        let key = decode_base64_to_32_bytes(&key_b64(13)).expect("key");
        let bob_behind = bob.save_encrypted_with_key(&key).expect("encrypt bob");

        // A newcomer joins: the commit bob's saved state has never seen.
        let carol = MlsManager::load_or_create("graine-ahead-carol", "dev-c", None)
            .expect("carol load_or_create");
        let kp = carol.generate_key_package().expect("carol key package");
        let (commit, _welcome, _added, _skipped) = alice
            .add_members_bulk(&group_id, &[&kp])
            .expect("add carol");
        alice
            .merge_pending_commit_for(&group_id)
            .expect("merge add commit");

        let seed = [7u8; 32];
        let frame = endorsed_seed_frame(&alice, "graine-ahead-alice", "sess-new", &seed);
        let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let out = send_messages_background_with_key(
            &temp_dir("graine-ahead"),
            &alice_state,
            &key_b64(13),
            "graine-ahead-alice",
            "dev-a",
            &[entry("seed-ahead", &group_id, &frame)],
        )
        .expect("alice encrypts the seed frame");
        let ciphertext = &ciphertexts_of(&out)[0];

        // Without the commit the frame is out of reach, which is what makes this a catch-up case.
        let direct = decrypt_push_message_with_key(
            &bob_behind,
            &key_b64(13),
            "graine-ahead-bob",
            "dev-b",
            &PushFrame {
                group_id: &group_id,
                sender_id: "graine-ahead-alice",
                ciphertext,
            },
            PushLanguage::French,
        );
        assert_eq!(direct["reason"], "mls-refused");

        let info = decrypt_push_message_with_commits_with_key(
            &bob_behind,
            &key_b64(13),
            "graine-ahead-bob",
            "dev-b",
            &[commit],
            &PushFrame {
                group_id: &group_id,
                sender_id: "graine-ahead-alice",
                ciphertext,
            },
            PushLanguage::French,
        );
        assert_eq!(info["ok"], false, "key material must still ring nobody");
        assert_eq!(info["reason"], "graine-key-material");
        let seeds = info["seeds"]
            .as_array()
            .expect("seeds travel with the reason");
        assert_eq!(seeds.len(), 1);
        assert_eq!(seeds[0]["sessionId"], "sess-new");
        assert_eq!(seeds[0]["seedB64"], STANDARD.encode(seed));
    }

    /// Alice seals `frame` for the group; bob's saved state is what the push path loads.
    fn alice_frame_for_bob(tag: &str, seed: u8, frame: &[u8]) -> (Vec<u8>, Vec<u8>, String) {
        let (alice, bob, group_id) = joined_pair(tag);
        let key = decode_base64_to_32_bytes(&key_b64(seed)).expect("key");
        let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let out = send_messages_background_with_key(
            &temp_dir(tag),
            &alice_state,
            &key_b64(seed),
            &format!("{tag}-alice"),
            "dev-a",
            &[entry("frame-1", &group_id, frame)],
        )
        .expect("alice encrypts");
        let ciphertext = ciphertexts_of(&out)[0].clone();
        let bob_state = bob.save_encrypted_with_key(&key).expect("encrypt bob");
        (bob_state, ciphertext, group_id)
    }

    /// WP-G2-1b, natively: a push whose `senderId` is not the sender MLS verified shows nothing of
    /// its text - the web refuses the same frame, and a banner must not say otherwise.
    #[test]
    fn a_push_naming_another_sender_is_refused() {
        let frame =
            super::super::proto_fields::build_text_app_message("m-1", 1_700_000_000_000, "hi");
        let (bob_state, ciphertext, group_id) = alice_frame_for_bob("sender", 17, &frame);
        let open = |envelope: &str| {
            decrypt_push_message_with_key(
                &bob_state,
                &key_b64(17),
                "sender-bob",
                "dev-b",
                &PushFrame {
                    group_id: &group_id,
                    sender_id: envelope,
                    ciphertext: &ciphertext,
                },
                PushLanguage::French,
            )
        };

        assert_eq!(open("mallory")["reason"], "sender-mismatch");
        // The case of an id is not a disagreement: the web compares lowercased too.
        assert_eq!(open("SENDER-ALICE")["ok"], true);
    }

    /// A frame whose generation the saved state already spent is refused FOR GOOD, and says so:
    /// the native callers skip the commit catch-up and the worker on that token, because no later
    /// epoch can read bytes refused at an epoch this device holds. An epoch gap keeps the old
    /// `mls-refused` - see `a_graine_seed_sealed_one_commit_ahead_survives_the_catch_up`.
    #[test]
    fn a_spent_generation_is_refused_for_good_and_not_handed_to_the_catch_up() {
        let tag = "spent";
        let (alice, mut bob, group_id) = joined_pair(tag);
        let key = decode_base64_to_32_bytes(&key_b64(19)).expect("key");
        let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let frame =
            super::super::proto_fields::build_text_app_message("m-1", 1_700_000_000_000, "hi");
        let out = send_messages_background_with_key(
            &temp_dir(tag),
            &alice_state,
            &key_b64(19),
            &format!("{tag}-alice"),
            "dev-a",
            &[entry("frame-1", &group_id, &frame)],
        )
        .expect("alice encrypts");
        let ciphertext = ciphertexts_of(&out)[0].clone();

        // The foreground read it first: the generation is consumed in the state the push loads.
        bob.process_incoming_message(&group_id, &ciphertext)
            .expect("bob reads it in the foreground")
            .expect("application message");
        let bob_state = bob.save_encrypted_with_key(&key).expect("encrypt bob");

        let info = decrypt_push_message_with_key(
            &bob_state,
            &key_b64(19),
            &format!("{tag}-bob"),
            "dev-b",
            &PushFrame {
                group_id: &group_id,
                sender_id: &format!("{tag}-alice"),
                ciphertext: &ciphertext,
            },
            PushLanguage::French,
        );
        assert_eq!(info["ok"], false);
        assert_eq!(info["reason"], "mls-refused-for-good");
        assert_eq!(info["kind"], "SecretReuse");
    }

    /// A NEW v1 seed never reaches the mirror (channel-encryption section 21.7): the frame still
    /// reads as key material, so it rings nobody, but it carries no seed for Kotlin to store.
    #[test]
    fn a_v1_seed_is_refused_by_the_push_path() {
        let frame = super::super::proto_fields::build_graine_app_message(
            "ch-salon",
            "sess-v1",
            &[5u8; 32],
            1_700_000_000_000,
        );
        let (bob_state, ciphertext, group_id) = alice_frame_for_bob("v1-refused", 18, &frame);
        let info = decrypt_push_message_with_key(
            &bob_state,
            &key_b64(18),
            "v1-refused-bob",
            "dev-b",
            &PushFrame {
                group_id: &group_id,
                sender_id: "v1-refused-alice",
                ciphertext: &ciphertext,
            },
            PushLanguage::French,
        );
        assert_eq!(info["ok"], false, "key material must still ring nobody");
        assert_eq!(info["reason"], "graine-key-material");
        assert_eq!(info["seeds"].as_array().expect("seeds").len(), 0);
        // Named for the native callers, whose logs are the only ones a killed app keeps.
        assert_eq!(info["v1Refused"], serde_json::json!(["sess-v1"]));
    }

    /// A v2 seed reaches the mirror only once its minter's leaf endorses it (channel-encryption
    /// section 21.5): forged, or minted by a device the tree does not hold, it waits for the app.
    #[test]
    fn a_v2_seed_is_kept_only_when_the_tree_endorses_it() {
        use super::super::graine::{encode_endorsement_v2, seed_commitment, GraineEndorsementV2};
        use super::super::proto_fields::{build_graine_v2_app_message, GraineV2Fields};

        let tag = "endorse";
        let seed = [3u8; 32];
        let signing_pk = [9u8; 32];
        let created_at = 1_700_000_000_000i64;
        // Each case seals its own frame, so each gets its own group and its own endorsement.
        let case = |n: u8, device: &'static str, sign: &dyn Fn(&MlsManager, &[u8]) -> Vec<u8>| {
            let (alice, bob, group_id) = joined_pair(&format!("{tag}-{n}"));
            let alice_id = format!("{tag}-{n}-alice");
            let d = encode_endorsement_v2(&GraineEndorsementV2 {
                channel_id: "ch-salon",
                session_id: "sess-v2",
                minter_user_id: &alice_id,
                minter_device_id: device,
                signing_public_key: &signing_pk,
                seed_commitment: &seed_commitment(&seed),
                created_at: created_at as u64,
            })
            .expect("descriptor");
            let endorsement = sign(if n == 2 { &bob } else { &alice }, &d);
            let frame = build_graine_v2_app_message(
                "ch-salon",
                "sess-v2",
                &seed,
                created_at,
                &GraineV2Fields {
                    minter_user_id: &alice_id,
                    minter_device_id: device,
                    signing_public_key: &signing_pk,
                    endorsement: &endorsement,
                },
            );
            let key = decode_base64_to_32_bytes(&key_b64(20 + n)).expect("key");
            let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
            let out = send_messages_background_with_key(
                &temp_dir(&format!("{tag}-{n}")),
                &alice_state,
                &key_b64(20 + n),
                &alice_id,
                "dev-a",
                &[entry("seed", &group_id, &frame)],
            )
            .expect("alice encrypts");
            let bob_state = bob.save_encrypted_with_key(&key).expect("encrypt bob");
            let info = decrypt_push_message_with_key(
                &bob_state,
                &key_b64(20 + n),
                &format!("{tag}-{n}-bob"),
                "dev-b",
                &PushFrame {
                    group_id: &group_id,
                    sender_id: &alice_id,
                    ciphertext: &ciphertexts_of(&out)[0],
                },
                PushLanguage::French,
            );
            assert_eq!(info["reason"], "graine-key-material");
            info["seeds"].as_array().expect("seeds").len()
        };
        let by_device = |m: &MlsManager, d: &[u8]| m.sign_with_device_credential(d).expect("sign");

        assert_eq!(
            case(1, "dev-a", &by_device),
            1,
            "endorsed by alice's own leaf"
        );
        assert_eq!(
            case(2, "dev-a", &by_device),
            0,
            "bob signed an endorsement claiming alice"
        );
        assert_eq!(
            case(3, "dev-gone", &by_device),
            0,
            "a device the tree does not hold"
        );
    }

    /// The FFI contract is a string on both platforms and nothing type-checks it, so pin the shape
    /// the Kotlin and ObjC drains actually build.
    #[test]
    fn the_platform_entry_shape_parses() {
        let entries = parse_outbox_entries_json(
            r#"[{"id":"a","groupId":"g1","proto":"AAEC"},{"id":"b","groupId":"g2","proto":""}]"#,
        )
        .expect("parse");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "a");
        assert_eq!(entries[0].group_id, "g1");
        assert_eq!(entries[1].group_id, "g2");

        assert!(parse_outbox_entries_json("not json").is_err());
        assert!(
            parse_outbox_entries_json(r#"[{"groupId":"g"}]"#).is_err(),
            "a missing proto is a malformed entry, not an empty one"
        );
    }

    /// User decision 2026-10-22: the owner's phone is told, even shut, when a device joins the
    /// account. A commit adding one reaches it as a control frame (Android) or inside a catch-up
    /// (both platforms), and BOTH answers carry the alert's key - whatever else they say.
    #[test]
    fn a_commit_adding_an_own_device_carries_the_owner_alert_on_both_push_paths() {
        let tag = "own-device";
        let (mut alice, bob, group_id) = joined_pair(tag);
        let key = decode_base64_to_32_bytes(&key_b64(23)).expect("key");
        let bob_behind = bob.save_encrypted_with_key(&key).expect("encrypt bob");

        // alice serves the welcome request of bob's new laptop.
        let laptop = MlsManager::load_or_create(&format!("{tag}-bob"), "dev-laptop", None)
            .expect("laptop load_or_create");
        let kp = laptop.generate_key_package().expect("laptop key package");
        let (commit, _w, _a, _s) = alice
            .add_members_bulk(&group_id, &[&kp])
            .expect("add the laptop");
        alice.merge_pending_commit_for(&group_id).expect("merge");

        let as_control_frame = decrypt_push_message_with_key(
            &bob_behind,
            &key_b64(23),
            &format!("{tag}-bob"),
            "dev-b",
            &PushFrame {
                group_id: &group_id,
                sender_id: &format!("{tag}-alice"),
                ciphertext: &commit,
            },
            PushLanguage::French,
        );
        assert_eq!(as_control_frame["reason"], "control-frame");
        let keys = as_control_frame["ownDeviceAdded"]
            .as_array()
            .expect("the alert rides on the refusal");
        assert_eq!(keys.len(), 1, "{as_control_frame}");
        assert!(keys[0]
            .as_str()
            .unwrap()
            .starts_with(&format!("{tag}-bob:dev-laptop|")));

        // The catch-up: the commit replayed in memory, then a message decrypted at the new epoch.
        let frame =
            super::super::proto_fields::build_text_app_message("m-1", 1_700_000_000_000, "hi");
        let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let out = send_messages_background_with_key(
            &temp_dir(tag),
            &alice_state,
            &key_b64(23),
            &format!("{tag}-alice"),
            "dev-a",
            &[entry("m-1", &group_id, &frame)],
        )
        .expect("alice encrypts");
        let info = decrypt_push_message_with_commits_with_key(
            &bob_behind,
            &key_b64(23),
            &format!("{tag}-bob"),
            "dev-b",
            &[commit],
            &PushFrame {
                group_id: &group_id,
                sender_id: &format!("{tag}-alice"),
                ciphertext: &ciphertexts_of(&out)[0],
            },
            PushLanguage::French,
        );
        assert_eq!(info["ok"], true, "{info}");
        assert_eq!(info["ownDeviceAdded"], as_control_frame["ownDeviceAdded"]);

        // A contact's phone merging the same commit has no owner alert.
        let contact = decrypt_push_message_with_key(
            &alice_state,
            &key_b64(23),
            &format!("{tag}-alice"),
            "dev-a",
            &PushFrame {
                group_id: &group_id,
                sender_id: &format!("{tag}-alice"),
                ciphertext: &ciphertexts_of(&out)[0],
            },
            PushLanguage::French,
        );
        assert!(contact.get("ownDeviceAdded").is_none(), "{contact}");
    }

    /// The phone serving its own account's new device in the background names it for the local
    /// notification AND leaves the event in `mls.bin`, where the app takes it for the in-app alert.
    #[test]
    fn a_background_add_of_an_own_device_names_it_and_keeps_the_event_for_the_app() {
        let tag = "own-welcome";
        let (alice, _bob, group_id) = joined_pair(tag);
        let key = decode_base64_to_32_bytes(&key_b64(29)).expect("key");
        let alice_state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let laptop = MlsManager::load_or_create(&format!("{tag}-alice"), "dev-laptop", None)
            .expect("laptop");
        let kp = STANDARD.encode(laptop.generate_key_package().expect("kp"));
        let dir = temp_dir(tag);
        let out = create_welcome_background_with_key(
            &dir,
            &alice_state,
            &key_b64(29),
            &format!("{tag}-alice"),
            "dev-a",
            &group_id,
            &kp,
        )
        .expect("background add");
        let keys = out["ownDeviceAdded"]
            .as_array()
            .expect("named for the notice");
        assert_eq!(keys.len(), 1, "{out}");
        // The events this Add recorded, named so a refusal by the server can withdraw them.
        let added = out["addedEvents"].as_array().expect("events named");
        assert_eq!(added.len(), 1, "{out}");
        assert!(
            added[0]
                .as_str()
                .unwrap()
                .ends_with(&format!("|{tag}-alice:dev-laptop")),
            "{out}"
        );
        assert!(added[0]
            .as_str()
            .unwrap()
            .starts_with(&format!("{group_id}|")));

        let saved = std::fs::read(dir.join("mls.bin")).expect("mls.bin written");
        let mut reloaded =
            MlsManager::load_with_key(&format!("{tag}-alice"), "dev-a", Some(saved), &key)
                .expect("reload");
        let pending = reloaded.take_device_events();
        assert!(
            pending
                .iter()
                .any(|e| e.is_owner_alert(&format!("{tag}-alice"), "dev-a")),
            "{pending:?}"
        );
    }
}
