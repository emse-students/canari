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
use mls_core::device_trust::{canonical_user_id, canonical_user_of};
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
/// `language` words what the scanner composes itself ([`PushLanguage`]). `cache_key` is the
/// install's native cache key the platform read (`native_cache`), which opens the sealed mirror;
/// `None` reads only an older build's plaintext mirror and refuses a sealed one as unreadable.
pub fn open_graine_push(
    data_dir: &Path,
    cache_key: Option<&crate::native_cache::CacheKey>,
    push: &GrainePush<'_>,
    language: PushLanguage,
) -> serde_json::Value {
    let held = match crate::commands::push::read_graine_seed(
        data_dir,
        cache_key,
        push.channel_id,
        push.session_id,
    ) {
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
    if canonical_user_id(push.sender_id) != canonical_user_id(minter) {
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

// The staged-state prefix and the stale ledger are named where `mls.bin`'s deletion sweeps them.
use crate::commands::storage::{STAGED_WELCOME_PREFIX, STALE_WELCOME_LEDGER_FILE};
/// The most groups the stale ledger names. A capacity, not a clock: a full ledger is emptied before
/// the next entry, which costs each forgotten group ONE more refused answer and nothing else.
pub const STALE_WELCOME_LEDGER_CAPACITY: usize = 64;

/// The file a prepared Welcome stages its post-add state in, beside `mls.bin`, one per group so two
/// requests for two groups answered at once never install each other's state:
/// `digest of the loaded mls.bin (32) || sealed post-add state`.
fn staged_welcome_path(files_dir: &Path, group_id: &str) -> std::path::PathBuf {
    let tag = hex(&crate::concurrency::mls_bin_digest(group_id.as_bytes())[..8]);
    files_dir.join(format!("{STAGED_WELCOME_PREFIX}{tag}"))
}

/// Writes a staged file by rename from a temporary of ITS OWN name, so two groups staged at once
/// never share a temporary.
fn write_staged(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, data).map_err(|e| format!("write staged state: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename staged state: {e}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Runs `edit` on the stale ledger under the process-wide `mls.bin` write lock (every FCM thread
/// shares that process), writing it back by rename when `edit` says it changed. An absent or
/// unparsable ledger reads as empty, and the unparsable one is said.
fn with_stale_ledger<R>(
    files_dir: &Path,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> (R, bool),
) -> Result<R, String> {
    let _guard = crate::concurrency::mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let path = files_dir.join(STALE_WELCOME_LEDGER_FILE);
    let mut map = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => {
                log::warn!("[BG_WELCOME] stale ledger unparsable - read as empty");
                serde_json::Map::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("read {STALE_WELCOME_LEDGER_FILE}: {e}")),
    };
    let (result, changed) = edit(&mut map);
    if changed {
        let tmp = files_dir.join(format!("{STALE_WELCOME_LEDGER_FILE}.tmp"));
        std::fs::write(&tmp, serde_json::Value::Object(map).to_string())
            .map_err(|e| format!("write {STALE_WELCOME_LEDGER_FILE}: {e}"))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("rename {STALE_WELCOME_LEDGER_FILE}: {e}"))?;
    }
    Ok(result)
}

/// Whether the server already refused, as stale, a Welcome for `group_id` built from THESE
/// `mls.bin` bytes - and so whether answering again could only be refused again.
///
/// A PROOF, NOT A CLOCK. The gate's answer is a function of the base the commit was built on and
/// of the group's epoch, and the server's epoch only moves forward: the same bytes build a commit on
/// the same base, which the gate refuses again. Any write to `mls.bin` - the foreground's
/// checkpoint, a background Welcome received, an outbox drain - changes the digest and lifts the
/// entry, so the device answers again as soon as it holds anything new. Until then the newcomer's
/// re-ask cadence (`requestReAdd`, every 60 s while its app is open) costs this phone one file read
/// per ask instead of an add-lock, a key-package fetch, a load, a commit and a refusal.
pub fn welcome_request_known_stale(files_dir: &Path, state_bytes: &[u8], group_id: &str) -> bool {
    let digest = hex(&crate::concurrency::mls_bin_digest(state_bytes));
    let known = with_stale_ledger(files_dir, |map| {
        let known = map
            .get(group_id)
            .and_then(|e| e.get("digest"))
            .and_then(|d| d.as_str())
            == Some(digest.as_str());
        (known, false)
    });
    match known {
        Ok(known) => known,
        Err(e) => {
            log::warn!("[BG_WELCOME] stale ledger unreadable ({e}) - answered as not known");
            false
        }
    }
}

/// The ledger key of a refused TARGET of `group_id`, beside the group's own (stale) entry.
fn refused_target_key(group_id: &str, target: &str) -> String {
    format!("{group_id}|{target}")
}

/// Whether a Welcome for `target` (`userId:deviceId`) in `group_id`, built from THESE `mls.bin`
/// bytes, was already refused - and if so the token saying why: `stale-epoch-known` (the base was
/// behind the server, whoever the target) or `target-refused-known` (the server refused this
/// target: `welcome_target_unknown` / `welcome_target_not_member`).
///
/// The same proof as [`welcome_request_known_stale`]: any write to `mls.bin` lifts both. A target
/// the server admits after the refusal - a grant, a re-registration - is answered from the next
/// bytes this phone holds, or by any other holder or the foreground, which keep no such memo.
pub fn welcome_request_known_refused(
    files_dir: &Path,
    state_bytes: &[u8],
    group_id: &str,
    target: &str,
) -> Option<&'static str> {
    if welcome_request_known_stale(files_dir, state_bytes, group_id) {
        return Some("stale-epoch-known");
    }
    let digest = hex(&crate::concurrency::mls_bin_digest(state_bytes));
    let key = refused_target_key(group_id, target);
    let known = with_stale_ledger(files_dir, |map| {
        let known = map
            .get(&key)
            .and_then(|e| e.get("digest"))
            .and_then(|d| d.as_str())
            == Some(digest.as_str());
        (known, false)
    });
    match known {
        Ok(true) => Some("target-refused-known"),
        Ok(false) => None,
        Err(e) => {
            log::warn!("[BG_WELCOME] stale ledger unreadable ({e}) - answered as not known");
            None
        }
    }
}

/// A refusal of [`prepare_welcome_background_with_key`], as the token the native callers branch on.
fn welcome_refused(reason: &str) -> serde_json::Value {
    log::warn!("[BG_WELCOME] prepare refused reason={reason}");
    refused(reason)
}

/// Builds the Welcome and the commit that add `key_package_b64` to `group_id`, and STAGES the state
/// they produce beside `mls.bin`. Nothing is written to `mls.bin` here.
///
/// Answers `{"ok": true, "welcome", "ratchetTree", "commit", "groupInfo", "baseEpoch"}` (base64;
/// `groupInfo` is the external-join base of the epoch the commit creates, published by the route
/// in the advance's own transaction - COMM-22), or
/// `{"ok": false, "reason"}` with one of: `foreground-active`, `stale-epoch-known`,
/// `key-package-unreadable`, `state-unreadable`, `group-not-held`, `already-member`, `add-failed`,
/// `stage-failed`.
///
/// **THE ADD IS INSTALLED ONLY ONCE THE SERVER ACCEPTS IT** ([`install_staged_welcome`]), the order
/// the foreground has followed since C7 (stage, submit, merge on accept). This path used to merge and
/// write first: a phone killed while its group moved on answered from its old epoch, the gate refused
/// the commit as `epoch_mismatch`, and `mls.bin` was left holding an add nobody else applied - an
/// epoch of its own, from which it could read no further message of the group, and a tree in which
/// the newcomer already sat (`ALREADY_MEMBER` on the next request). Read on the Mi 9T, 2026-10-22.
///
/// **IT DOES NOT CATCH UP FIRST, ON PURPOSE.** The background never applies the group's commits to
/// `mls.bin` (the catch-up in [`decrypt_push_message_with_commits_with_key`] is read-only): the
/// foreground's commit replay owns that, with everything it does around a commit. A stale phone's
/// answer is refused by the gate, discarded, and recorded so the same bytes are not offered again
/// ([`discard_staged_welcome`]).
pub fn prepare_welcome_background_with_key(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    key_package_b64: &str,
) -> serde_json::Value {
    let short: String = group_id.chars().take(8).collect();
    log::info!("[BG_WELCOME] prepare group={short}");
    // The foreground answers welcome_requests itself, and owns the state while it runs.
    if crate::concurrency::foreground_is_active() {
        return welcome_refused("foreground-active");
    }
    if welcome_request_known_stale(files_dir, state_bytes, group_id) {
        return welcome_refused("stale-epoch-known");
    }
    let Ok(kp_bytes) = STANDARD.decode(key_package_b64.trim()) else {
        return welcome_refused("key-package-unreadable");
    };
    let (mut manager, key) =
        match load_manager_with_key_b64(state_bytes, key_b64, user_id, device_id) {
            Ok(pair) => pair,
            Err(e) => {
                log::error!("[BG_WELCOME] mls.bin unreadable with the device key: {e}");
                return welcome_refused("state-unreadable");
            }
        };
    let base_epoch = match manager.get_epoch(group_id) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[BG_WELCOME] group={short} not held: {e}");
            return welcome_refused("group-not-held");
        }
    };
    log::debug!(
        "[BG_WELCOME] add_member group={short} kp_len={} base_epoch={base_epoch}",
        kp_bytes.len()
    );
    // `_with_base`: the external-join base of the epoch this commit CREATES travels with it, as the
    // foreground's does (COMM-22) - only the committer can export it, and only now.
    let (commit, welcome, group_info) =
        match manager.add_members_bulk_with_base(group_id, &[kp_bytes.as_slice()]) {
            Ok(((commit, Some(welcome), _, _), group_info)) => (commit, welcome, group_info),
            Ok(((_, None, _, skipped), _)) => {
                log::error!(
                    "[BG_WELCOME] add produced no welcome group={short} skipped={}",
                    skipped.len()
                );
                return welcome_refused("add-failed");
            }
            Err(mls_core::MlsError::AlreadyMember(who)) => {
                log::warn!("[BG_WELCOME] {who} already sits in the tree of group={short}");
                return welcome_refused("already-member");
            }
            Err(e) => {
                log::error!("[BG_WELCOME] add_member failed group={short}: {e}");
                return welcome_refused("add-failed");
            }
        };
    // The post-add state the new member joins: merged IN MEMORY, sealed, and staged.
    let staged = manager
        .merge_pending_commit_for(group_id)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            manager
                .export_ratchet_tree_for(group_id)
                .map_err(|e| e.to_string())
        })
        .and_then(|tree| {
            manager
                .save_encrypted_with_key(&key)
                .map(|sealed| (tree, sealed))
                .map_err(|e| e.to_string())
        });
    let (ratchet_tree, sealed) = match staged {
        Ok(pair) => pair,
        Err(e) => {
            log::error!("[BG_WELCOME] post-add state not sealed group={short}: {e}");
            return welcome_refused("stage-failed");
        }
    };
    let mut file = Vec::with_capacity(32 + sealed.len());
    file.extend_from_slice(&crate::concurrency::mls_bin_digest(state_bytes));
    file.extend_from_slice(&sealed);
    if let Err(e) = write_staged(&staged_welcome_path(files_dir, group_id), &file) {
        log::error!("[BG_WELCOME] post-add state not staged group={short}: {e}");
        return welcome_refused("stage-failed");
    }
    log::info!(
        "[BG_WELCOME] staged group={short} base_epoch={base_epoch} ({} bytes) - mls.bin untouched until the server accepts",
        sealed.len()
    );
    serde_json::json!({
        "ok": true,
        "welcome": STANDARD.encode(&welcome),
        "ratchetTree": STANDARD.encode(&ratchet_tree),
        "commit": STANDARD.encode(&commit),
        "groupInfo": STANDARD.encode(&group_info),
        "baseEpoch": base_epoch,
    })
}

/// Installs the state [`prepare_welcome_background_with_key`] staged for `group_id` - called ONLY
/// after the server answered `accepted` - and deletes the staged file whatever happens.
///
/// Installed only over the very `mls.bin` it was built from
/// ([`crate::concurrency::background_write_mls_bin_if_unchanged`]). Answers `{"ok": true}`, or
/// `{"ok": false, "reason": "not-staged" | "install-refused"}`. The second means the server holds a
/// commit this device does not, and the caller must say so loudly: the foreground's replay will meet
/// this device's own commit, and the device recovers through the usual ladder.
pub fn install_staged_welcome(files_dir: &Path, group_id: &str) -> serde_json::Value {
    let short: String = group_id.chars().take(8).collect();
    let path = staged_welcome_path(files_dir, group_id);
    let file = match std::fs::read(&path) {
        Ok(f) if f.len() > 32 => f,
        Ok(_) => {
            log::error!("[BG_WELCOME] install group={short}: staged state truncated");
            let _ = std::fs::remove_file(&path);
            return refused("not-staged");
        }
        Err(e) => {
            log::error!("[BG_WELCOME] install group={short}: no staged state ({e})");
            return refused("not-staged");
        }
    };
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[BG_WELCOME] staged state of group={short} not deleted: {e}");
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&file[..32]);
    match crate::concurrency::background_write_mls_bin_if_unchanged(
        &files_dir.join("mls.bin"),
        &digest,
        &file[32..],
    ) {
        Ok(()) => {
            log::info!(
                "[BG_WELCOME] installed group={short} ({} bytes)",
                file.len() - 32
            );
            serde_json::json!({ "ok": true })
        }
        Err(e) => {
            log::error!("[BG_WELCOME] ACCEPTED AND NOT INSTALLED group={short}: {e}");
            let mut out = refused("install-refused");
            out["error"] = serde_json::Value::String(e);
            out
        }
    }
}

/// What a discarded Welcome's refusal leaves in the stale ledger, so the same `mls.bin` bytes do not
/// answer a request the server will refuse again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalMemo<'a> {
    /// A refusal that says nothing about the next request: a racing commit, a removed requester, an
    /// answer nobody read.
    Nothing,
    /// `epoch_mismatch`: recorded for the whole group, and only when `server_epoch > base_epoch`.
    Stale { base_epoch: u64, server_epoch: u64 },
    /// `welcome_target_unknown` / `welcome_target_not_member`: recorded for this target alone
    /// (`userId:deviceId`).
    TargetRefused { target: &'a str },
}

/// Deletes the state staged for `group_id` - the server refused the commit, or its answer was not
/// an acceptance - and records what `memo` says against the bytes the commit was built from, so they
/// are not offered again ([`welcome_request_known_refused`]).
pub fn discard_staged_welcome(files_dir: &Path, group_id: &str, memo: RefusalMemo<'_>) {
    let short: String = group_id.chars().take(8).collect();
    let path = staged_welcome_path(files_dir, group_id);
    let digest = std::fs::read(&path)
        .ok()
        .filter(|f| f.len() > 32)
        .map(|f| hex(&f[..32]));
    match std::fs::remove_file(&path) {
        Ok(()) => log::info!("[BG_WELCOME] discarded the staged state of group={short}"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::warn!("[BG_WELCOME] discard group={short}: nothing was staged")
        }
        Err(e) => log::warn!("[BG_WELCOME] staged state of group={short} not deleted: {e}"),
    }
    let Some(digest) = digest else {
        return;
    };
    let (key, entry, said) = match memo {
        RefusalMemo::Nothing => return,
        RefusalMemo::Stale {
            base_epoch,
            server_epoch,
        } => {
            // ONLY A BASE BEHIND THE SERVER IS STALE. A base at or ahead of the server's counter (a
            // phone ahead of a lagging counter) is a refusal the same bytes may not meet again, so it
            // is not remembered: the memo must never hold back an answer that could later be valid.
            if server_epoch <= base_epoch {
                log::warn!(
                    "[BG_WELCOME] group={short} refused at base {base_epoch} with the server at {server_epoch} - not behind, not recorded"
                );
                return;
            }
            (
                group_id.to_string(),
                serde_json::json!({ "digest": digest, "baseEpoch": base_epoch, "serverEpoch": server_epoch }),
                format!("stale: base {base_epoch}, server {server_epoch}"),
            )
        }
        RefusalMemo::TargetRefused { target } => (
            refused_target_key(group_id, target),
            serde_json::json!({ "digest": digest, "targetRefused": true }),
            "its target refused".to_string(),
        ),
    };
    let recorded = with_stale_ledger(files_dir, |map| {
        if !map.contains_key(&key) && map.len() >= STALE_WELCOME_LEDGER_CAPACITY {
            log::warn!(
                "[BG_WELCOME] stale ledger full ({STALE_WELCOME_LEDGER_CAPACITY}) - emptied before recording group={short}"
            );
            map.clear();
        }
        map.insert(key, entry);
        ((), true)
    });
    match recorded {
        Ok(()) => log::info!(
            "[BG_WELCOME] group={short} recorded {said} - not answered again from these bytes"
        ),
        Err(e) => log::warn!("[BG_WELCOME] stale ledger not written for group={short}: {e}"),
    }
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
            Ok(frame) => {
                encrypted += 1;
                // `authorProof` rides along for a reader that keeps the sender's own copy; the
                // native drains read `ciphertext` alone today (history-reconciliation, "Restored
                // history carries its author's signature").
                results.push(serde_json::json!({
                    "id": entry.id,
                    "ok": true,
                    "ciphertext": STANDARD.encode(&frame.ciphertext),
                    "authorProof": STANDARD.encode(&frame.author_proof),
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

/// Encrypts a single entry against an already-loaded manager, with its author's signature - the
/// same authored send as the foreground, so a message drained here is as relayable as any other.
/// Split out so the batch loop has one obvious failure boundary per entry.
fn encrypt_one(
    manager: &mut MlsManager,
    entry: &OutboxEntry,
) -> Result<mls_core::authorship::AuthoredFrame, String> {
    let proto_bytes = STANDARD
        .decode(entry.proto.trim())
        .map_err(|e| format!("base64 decode proto: {e}"))?;
    manager
        .send_authored_message(&entry.group_id, &proto_bytes)
        .map_err(|e| format!("send_authored_message: {e:?}"))
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

    classify_verified(&manager, frame.group_id, frame.sender_id, app, language)
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
    // The user half of the ONE canonical identity the binding reads; a credential that is not a
    // well-formed `user:device` names no user and is refused like a mismatch.
    let verified_user = app.sender_identity.as_deref().and_then(canonical_user_of);
    if verified_user != Some(canonical_user_id(envelope_sender)) {
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

    let app = match manager.process_incoming_message_with_sender(frame.group_id, frame.ciphertext) {
        Ok(Some(app)) => app,
        Ok(None) => {
            log::debug!("[PushBG] key-based catch-up: control frame applied, nothing to render");
            return refused("control-frame");
        }
        Err(e) => {
            log::error!("[PushBG] key-based catch-up decrypt failed: {e}");
            return refused_by_mls(&e);
        }
    };

    classify_verified(&manager, frame.group_id, frame.sender_id, app, language)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A distinct device key per test so no two tests can read the same `mls.bin`.
    fn key_b64(seed: u8) -> String {
        STANDARD.encode([seed; 32])
    }

    /// A temp directory of its own, so the `mls.bin` each test writes is its own.
    /// `send_messages_background_with_key` writes `mls.bin` through `background_write_mls_bin`,
    /// which refuses while the PROCESS-global foreground guard is up - and other modules' tests
    /// raise it. So every test here that sends holds the shared serialiser and clears the guard,
    /// or it fails whenever a foreground test runs beside it.
    fn quiet_foreground() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        guard
    }

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
        let _fg = quiet_foreground();
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
            assert_authored(&plain, &plaintexts[i]);
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
        assert_authored(&plain, b"msg-5");
    }

    /// One unjoined group must not strand the rest of the backlog: the failure is reported in its
    /// own result and the entries around it still encrypt and still decrypt in order.
    #[test]
    fn a_failing_entry_is_isolated_and_the_batch_continues() {
        let _fg = quiet_foreground();
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
        let first = bob
            .process_incoming_message(&group_id, &frames[0])
            .expect("decrypt first")
            .expect("application message");
        assert_authored(&first, b"first");
        let second = bob
            .process_incoming_message(&group_id, &frames[1])
            .expect("decrypt second")
            .expect("application message");
        assert_authored(&second, b"second");
    }

    /// A background send is AUTHORED: its plaintext is `body` followed by the author proof mls-core
    /// appended as field 14. These test bodies are not protobuf, so the body is matched by prefix and
    /// what follows it must be exactly one proof field.
    fn assert_authored(plain: &[u8], body: &[u8]) {
        assert!(plain.starts_with(body), "the body leads the plaintext");
        let trailer = &plain[body.len()..];
        assert!(
            matches!(
                mls_core::authorship::split_author_proof(trailer),
                Some((0, _))
            ),
            "exactly one author proof follows the body"
        );
    }

    #[test]
    fn an_empty_batch_writes_nothing_and_returns_no_results() {
        let _fg = quiet_foreground();
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
        let _fg = quiet_foreground();
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
        let _fg = quiet_foreground();
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

    /// A LEGACY BARE CREDENTIAL (`userId`, no device - builds before device identities) names its
    /// user: a push it signed is that user's, as it was before the canonical reader. A credential
    /// naming nobody (two separators) is still refused.
    #[test]
    fn a_push_from_a_bare_legacy_leaf_is_its_users() {
        let manager = MlsManager::load_or_create("me", "dev-m", None).expect("manager");
        let frame =
            super::super::proto_fields::build_text_app_message("m-1", 1_700_000_000_000, "hi");
        let classify = |sender: &str, envelope: &str| {
            super::classify_verified(
                &manager,
                "group-legacy",
                envelope,
                mls_core::IncomingApplication {
                    plaintext: frame.clone(),
                    sender_identity: Some(sender.to_string()),
                    author: mls_core::authorship::AuthorVerdict::Unsigned,
                },
                PushLanguage::French,
            )
        };

        assert_eq!(classify("Legacy-User", "legacy-user")["ok"], true);
        assert_eq!(
            classify("legacy-user", "mallory")["reason"],
            "sender-mismatch"
        );
        assert_eq!(
            classify("legacy-user:a:b", "legacy-user")["reason"],
            "sender-mismatch"
        );
    }

    /// A frame whose generation the saved state already spent is refused FOR GOOD, and says so:
    /// the native callers skip the commit catch-up and the worker on that token, because no later
    /// epoch can read bytes refused at an epoch this device holds. An epoch gap keeps the old
    /// `mls-refused` - see `a_graine_seed_sealed_one_commit_ahead_survives_the_catch_up`.
    #[test]
    fn a_spent_generation_is_refused_for_good_and_not_handed_to_the_catch_up() {
        let _fg = quiet_foreground();
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
        let _fg = quiet_foreground();
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

    // --- The background Welcome: staged, installed on acceptance, discarded on refusal ------------

    /// A shut phone (`alice`) in a group that moved on without it: `bob` admitted `dave`, so the
    /// group is one epoch past alice's `mls.bin`. Returns alice's stale sealed state, the commit that
    /// moved the group, carol's key package (the newcomer asking for a Welcome) and the group id.
    fn shut_phone_behind_its_group(
        tag: &str,
        key_seed: u8,
    ) -> (Vec<u8>, MlsManager, Vec<u8>, String, String) {
        let (alice, mut bob, gid) = joined_pair(tag);
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(key_seed)).expect("key");
        let stale = alice.save_encrypted_with_key(&key).expect("seal alice");
        let dave = MlsManager::load_or_create(&format!("{tag}-dave"), "dev-d", None).unwrap();
        let (moved, _) = bob
            .add_member(&gid, &dave.generate_key_package().unwrap())
            .expect("bob adds dave");
        bob.merge_pending_commit_for(&gid).expect("bob merges");
        let carol = MlsManager::load_or_create(&format!("{tag}-carol"), "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());
        (stale, bob, moved, kp, gid)
    }

    /// A data directory holding `state` as its `mls.bin`, as the phone's would.
    fn dir_holding(name: &str, state: &[u8]) -> std::path::PathBuf {
        let dir = temp_dir(name);
        for entry in std::fs::read_dir(&dir).expect("read temp dir").flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
        std::fs::write(dir.join("mls.bin"), state).expect("write mls.bin");
        dir
    }

    /// THE DEFECT READ ON THE MI 9T, 2026-10-22. The phone answered from its old epoch and the gate
    /// refused the commit - and `mls.bin` already held the add, merged before the answer. The group's
    /// next message was then unreadable (`same-epoch refusal`): the phone had made an epoch of its
    /// own. Against the function this replaced, the last assertion fails.
    #[test]
    fn a_refused_background_welcome_leaves_mls_bin_able_to_follow_its_group() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (stale, mut bob, moved, kp, gid) = shut_phone_behind_its_group("refused", 41);
        let dir = dir_holding("refused", &stale);

        let prepared = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(41),
            "refused-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        assert_eq!(prepared["baseEpoch"], 1, "built on the stale base");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            stale,
            "nothing is written to mls.bin before the server answers"
        );

        // The server refused it as stale (epoch_mismatch, server at 2).
        discard_staged_welcome(
            &dir,
            &gid,
            RefusalMemo::Stale {
                base_epoch: 1,
                server_epoch: 2,
            },
        );

        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(41)).unwrap();
        let on_disk = std::fs::read(dir.join("mls.bin")).unwrap();
        let mut back =
            MlsManager::load_with_key("refused-alice", "dev-a", Some(on_disk), &key).unwrap();
        back.process_incoming_message(&gid, &moved)
            .expect("the group's commit applies");
        let next = bob.send_message(&gid, b"after").unwrap();
        assert_eq!(
            back.process_incoming_message(&gid, &next)
                .expect("the phone reads the group's next message"),
            Some(b"after".to_vec())
        );
    }

    /// The accepted half: the staged state is installed, and it is the state the newcomer joined.
    #[test]
    fn an_accepted_background_welcome_installs_the_state_the_newcomer_joined() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (alice, _bob, gid) = joined_pair("accepted");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(42)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("accepted", &state);
        let mut carol = MlsManager::load_or_create("accepted-carol", "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());

        let prepared = prepare_welcome_background_with_key(
            &dir,
            &state,
            &key_b64(42),
            "accepted-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        let installed = install_staged_welcome(&dir, &gid);
        assert_eq!(installed["ok"], true, "installed: {installed}");

        let mut back = MlsManager::load_with_key(
            "accepted-alice",
            "dev-a",
            Some(std::fs::read(dir.join("mls.bin")).unwrap()),
            &key,
        )
        .unwrap();
        assert_eq!(back.get_epoch(&gid).unwrap(), 2, "the add is installed");
        let welcome = STANDARD
            .decode(prepared["welcome"].as_str().unwrap())
            .unwrap();
        let tree = STANDARD
            .decode(prepared["ratchetTree"].as_str().unwrap())
            .unwrap();
        carol
            .process_welcome(&welcome, Some(&tree))
            .expect("carol joins");
        let hello = back.send_message(&gid, b"welcome carol").unwrap();
        assert_eq!(
            carol.process_incoming_message(&gid, &hello).unwrap(),
            Some(b"welcome carol".to_vec()),
            "the installed state and the newcomer's are one epoch"
        );
        assert!(
            install_staged_welcome(&dir, &gid)["reason"] == "not-staged",
            "the staged file is consumed by its install"
        );
    }

    /// COMM-22 on the background path: the prepare exports the external-join base of the epoch its
    /// commit creates, so the route publishes it with the advance. Without it the published base
    /// stays one epoch behind and an external joiner is refused as stale.
    #[test]
    fn a_prepared_welcome_carries_the_base_of_the_epoch_it_creates() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (alice, _bob, gid) = joined_pair("base");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(48)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("base", &state);
        let carol = MlsManager::load_or_create("base-carol", "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());

        let prepared = prepare_welcome_background_with_key(
            &dir,
            &state,
            &key_b64(48),
            "base-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        let base = STANDARD
            .decode(
                prepared["groupInfo"]
                    .as_str()
                    .expect("the base travels with the commit"),
            )
            .unwrap();

        let mut erin = MlsManager::load_or_create("base-erin", "dev-e", None).unwrap();
        let (joined, _commit) = erin
            .join_by_external_commit(&base)
            .expect("an external joiner builds on the published base");
        assert_eq!(joined, gid);
        assert_eq!(
            erin.get_epoch(&gid).unwrap(),
            3,
            "the base is the epoch the add creates (2), and the join moves it to 3"
        );
    }

    /// An acceptance that arrives after `mls.bin` moved installs nothing over the newer file.
    #[test]
    fn an_install_refuses_an_mls_bin_that_moved_since_it_was_loaded() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (alice, _bob, gid) = joined_pair("moved");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(43)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("moved", &state);
        let carol = MlsManager::load_or_create("moved-carol", "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());
        let prepared = prepare_welcome_background_with_key(
            &dir,
            &state,
            &key_b64(43),
            "moved-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(prepared["ok"], true);

        std::fs::write(dir.join("mls.bin"), b"a newer state").unwrap();
        let installed = install_staged_welcome(&dir, &gid);

        assert_eq!(installed["reason"], "install-refused");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            b"a newer state"
        );
    }

    /// The settlement of a stale refusal: the same bytes are not offered again, and any write to
    /// `mls.bin` lifts it - a proof, not a clock.
    #[test]
    fn a_stale_refusal_is_not_answered_again_from_the_same_bytes() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("ledger", 44);
        let dir = dir_holding("ledger", &stale);

        let first = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(44),
            "ledger-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(first["ok"], true);
        assert!(!welcome_request_known_stale(&dir, &stale, &gid));
        discard_staged_welcome(
            &dir,
            &gid,
            RefusalMemo::Stale {
                base_epoch: 1,
                server_epoch: 2,
            },
        );
        assert!(welcome_request_known_stale(&dir, &stale, &gid));

        let again = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(44),
            "ledger-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(again["reason"], "stale-epoch-known");
        assert!(
            !welcome_request_known_stale(&dir, b"any other mls.bin", &gid),
            "new bytes are answered again"
        );
        assert!(
            !welcome_request_known_stale(&dir, &stale, "another-group"),
            "and only this group is known stale"
        );
    }

    /// A phone AHEAD of a lagging server counter is not stale: the counter can reach its base, and
    /// a later answer from the same bytes may then be valid. Only `server > base` is recorded.
    #[test]
    fn a_refusal_from_a_base_ahead_of_the_server_records_nothing() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("ahead", 49);
        let dir = dir_holding("ahead", &stale);
        let first = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(49),
            "ahead-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(first["ok"], true);
        discard_staged_welcome(
            &dir,
            &gid,
            RefusalMemo::Stale {
                base_epoch: 3,
                server_epoch: 2,
            },
        );
        assert!(!welcome_request_known_stale(&dir, &stale, &gid));
        discard_staged_welcome(
            &dir,
            &gid,
            RefusalMemo::Stale {
                base_epoch: 2,
                server_epoch: 2,
            },
        );
        assert!(
            !welcome_request_known_stale(&dir, &stale, &gid),
            "equal is not stale either"
        );
    }

    /// A refusal that says nothing about the next request records nothing.
    #[test]
    fn a_racing_or_membership_refusal_records_nothing() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("race", 45);
        let dir = dir_holding("race", &stale);
        let first = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(45),
            "race-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(first["ok"], true);
        discard_staged_welcome(&dir, &gid, RefusalMemo::Nothing);
        assert!(!welcome_request_known_stale(&dir, &stale, &gid));
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), stale);
    }

    /// A refused TARGET (`welcome_target_unknown` / `welcome_target_not_member`) is remembered like a
    /// stale base, against the bytes the refused commit was built from: a holder does not commit and
    /// get refused again on each of the newcomer's asks. Keyed to that target alone - another
    /// newcomer of the same group is still answered - and lifted by any write to `mls.bin`.
    #[test]
    fn a_refused_target_is_not_answered_again_from_the_same_bytes() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("target", 51);
        let dir = dir_holding("target", &stale);
        let first = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(51),
            "target-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(first["ok"], true);
        assert_eq!(
            welcome_request_known_refused(&dir, &stale, &gid, "carol:phone-c"),
            None
        );

        discard_staged_welcome(
            &dir,
            &gid,
            RefusalMemo::TargetRefused {
                target: "carol:phone-c",
            },
        );

        assert_eq!(
            welcome_request_known_refused(&dir, &stale, &gid, "carol:phone-c"),
            Some("target-refused-known")
        );
        assert_eq!(
            welcome_request_known_refused(&dir, &stale, &gid, "dave:phone-d"),
            None,
            "another target of the same group is still answered"
        );
        assert_eq!(
            welcome_request_known_refused(&dir, b"any other mls.bin", &gid, "carol:phone-c"),
            None,
            "new bytes are answered again"
        );
        assert!(
            !welcome_request_known_stale(&dir, &stale, &gid),
            "a refused target says nothing about the group's epoch"
        );
    }

    /// The foreground answers welcome_requests itself and owns the state while it runs.
    #[test]
    fn no_welcome_is_prepared_while_the_foreground_runs() {
        let _s = crate::concurrency::test_support::serialise();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("fg", 46);
        let dir = dir_holding("fg", &stale);
        crate::concurrency::mark_foreground_active();
        let out = prepare_welcome_background_with_key(
            &dir,
            &stale,
            &key_b64(46),
            "fg-alice",
            "dev-a",
            &gid,
            &kp,
        );
        crate::concurrency::mark_foreground_inactive();
        assert_eq!(out["reason"], "foreground-active");
    }

    /// A newcomer already in the tree is a typed refusal, never an `add-failed` read from prose.
    #[test]
    fn a_newcomer_already_in_the_tree_is_refused_by_its_type() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (alice, bob, gid) = joined_pair("member");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(47)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("member", &state);
        let kp = STANDARD.encode(bob.generate_key_package().unwrap());
        let out = prepare_welcome_background_with_key(
            &dir,
            &state,
            &key_b64(47),
            "member-alice",
            "dev-a",
            &gid,
            &kp,
        );
        assert_eq!(out["reason"], "already-member", "{out}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
    }
}
