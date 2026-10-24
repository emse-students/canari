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

// The stale ledger is named where `mls.bin`'s deletion sweeps it.
use crate::commands::storage::{BACKGROUND_STAGES_FILE, STALE_WELCOME_LEDGER_FILE};
/// The most groups the stale ledger names. A capacity, not a clock: a full ledger is emptied before
/// the next entry, which costs each forgotten group ONE more refused answer and nothing else.
pub const STALE_WELCOME_LEDGER_CAPACITY: usize = 64;

/// The intent a background Welcome records beside its staged Add - the client's `CommitIntent`
/// (`src/lib/mls-client/commitSubmission.ts`), which the foreground reads to settle the commit
/// when the background could not: `self` is this device; the requester (`userId:deviceId`) is the
/// one device excluded from the commit's fan-out, and its device id names the Add's one key package.
/// Those are the two fields `commitAdmits` reads the device the commit ADMITS from, so a settle that
/// merges it owes that device its Welcome. Pinned on both sides by
/// `src/lib/mls-client/test/fixtures/background-welcome-intent.json`.
fn background_welcome_intent(group_id: &str, self_identity: &str, requester: &str) -> Vec<u8> {
    // A device id never holds ':' (`commitAdmits.ts`, `parseDeviceIdentity`): the LAST one splits.
    let requester_device = requester.rsplit(':').next().unwrap_or(requester);
    serde_json::json!({
        "groupId": group_id,
        "self": self_identity,
        "excludeDeviceIds": [requester],
        "keyPackageDevices": [requester_device],
    })
    .to_string()
    .into_bytes()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Runs `edit` on the stale ledger ([`crate::commands::storage::with_json_ledger`]).
fn with_stale_ledger<R>(
    files_dir: &Path,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> (R, bool),
) -> Result<R, String> {
    crate::commands::storage::with_json_ledger(files_dir, STALE_WELCOME_LEDGER_FILE, edit)
}

/// The digest naming ONE stage in the stages ledger: the commit it staged, so a settle forgets its
/// own stage and never a later one of the same group.
fn stage_digest(commit: &[u8]) -> String {
    hex(&crate::concurrency::mls_bin_digest(commit))
}

/// Records that `group_id`'s Add of `commit` is staged in `mls.bin` from `base_epoch`, so the
/// foreground's next load reports it whoever settles it
/// ([`crate::commands::storage::report_background_stages`]). Runs UNDER the hold of the `mls.bin`
/// write lock that wrote the stage
/// ([`crate::concurrency::background_write_mls_bin_if_unchanged_and_cold_then`]), so a sign-out's
/// sweep removes both or neither.
fn note_stage_left_held(files_dir: &Path, group_id: &str, base_epoch: u64, commit: &[u8]) {
    let noted =
        crate::commands::storage::edit_json_ledger_held(files_dir, BACKGROUND_STAGES_FILE, |map| {
            map.insert(
                group_id.to_string(),
                serde_json::json!({ "baseEpoch": base_epoch, "commit": stage_digest(commit) }),
            );
            ((), true)
        });
    if let Err(e) = noted {
        log::error!(
            "[BG_WELCOME] stage of group={} not noted ({e}) - the foreground settles it, but will not report it",
            group_id.chars().take(8).collect::<String>()
        );
    }
}

/// Forgets `group_id`'s stage of `commit`: this engine settled it (or found it settled), so nothing
/// is left for the foreground to report. ONLY THAT STAGE: an entry naming another commit is a later
/// stage of the same group, which is still owed its report.
fn forget_stage(files_dir: &Path, group_id: &str, commit: &[u8]) {
    let digest = stage_digest(commit);
    let forgot =
        crate::commands::storage::with_json_ledger(files_dir, BACKGROUND_STAGES_FILE, |map| {
            let ours = map
                .get(group_id)
                .and_then(|e| e.get("commit"))
                .and_then(serde_json::Value::as_str)
                == Some(digest.as_str());
            let removed = ours && map.remove(group_id).is_some();
            ((), removed)
        });
    if let Err(e) = forgot {
        log::warn!(
            "[BG_WELCOME] stage of group={} not forgotten ({e}) - the foreground's load reports it settled",
            group_id.chars().take(8).collect::<String>()
        );
    }
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

/// One `welcome_request` this device answers: the group, the device the request was made for
/// (`userId:deviceId`, the requester the push named), and the KeyPackage fetched FOR that device.
pub struct WelcomeRequest<'a> {
    pub group_id: &'a str,
    /// The device the Welcome is for - the identity the KeyPackage's credential must name.
    pub requester: &'a str,
    pub key_package_b64: &'a str,
}

/// Builds the Welcome and the commit that add the request's KeyPackage to its group, and writes
/// `mls.bin` with that Add STAGED - a pending commit and, beside it, its submission record - BEFORE
/// anything goes to the server.
///
/// Answers `{"ok": true, "welcome", "ratchetTree", "commit", "groupInfo", "baseEpoch"}` (base64;
/// `groupInfo` is the external-join base of the epoch the commit creates, published by the route
/// in the advance's own transaction - COMM-22), or
/// `{"ok": false, "reason"}` with one of: `foreground-active`, `warm-process`, `stale-epoch-known`,
/// `commit-pending`, `key-package-unreadable`, `state-unreadable`, `group-not-held`, `newcomer` (the
/// requester's user holds no leaf: a new person, whom only a member's gesture admits),
/// `already-member`, `add-failed`, `stage-failed`, or the [`mls_core::SkippedKeyPackageReason`] wire
/// name the package is refused for (`identity-mismatch`, `signature-key-changed`, `expired`, ...).
///
/// **THE PACKAGE IS BOUND TO THE REQUESTER** as the foreground's Add binds it: the delivery service
/// chose the bytes, so a package whose credential names another device, or the requester under a
/// key this device never pinned for it, is refused before anything is staged
/// ([`mls_core::MlsManager::key_package_verdict`], the check the Add itself then re-runs).
///
/// **THE STAGE IS IN `mls.bin`, SO WHOEVER LOADS THE FILE NEXT CAN SETTLE IT.** The Add is staged
/// with its record in one call (`mls_core::MlsManager::add_members_recorded`, the foreground's
/// recorded stage) and written by compare-and-swap over the very bytes it was built from. The
/// background then merges it on `accepted` or clears it on a refusal
/// ([`settle_background_welcome`]); when it cannot - no answer, a busy lock, a foreground that
/// started meanwhile - nothing is done, and the foreground, at its next load, settles it against the
/// server as it settles its own commits (`settleUnresolvedCommits`): a resubmission of the same
/// bytes answered `duplicate` merges it, a refusal clears it. Nothing waits on that round trip, and
/// a foreground that loads inside it loads the stage.
///
/// **ONE STAGED COMMIT PER GROUP**: a group whose state already holds one is refused
/// (`commit-pending`) - a second stage would replace the first, whose outcome nobody knows yet.
///
/// **IT DOES NOT CATCH UP FIRST, ON PURPOSE.** The background never applies the group's commits to
/// `mls.bin` (the catch-up in [`decrypt_push_message_with_commits_with_key`] is read-only): the
/// foreground's commit replay owns that, with everything it does around a commit. A stale phone's
/// answer is refused by the gate, cleared, and recorded so the same bytes are not offered again.
pub fn prepare_welcome_background_with_key(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    request: &WelcomeRequest,
) -> serde_json::Value {
    let WelcomeRequest {
        group_id,
        requester,
        key_package_b64,
    } = *request;
    let short: String = group_id.chars().take(8).collect();
    log::info!("[BG_WELCOME] prepare group={short} for {requester}");
    // The foreground answers welcome_requests itself, and owns the state while it runs.
    if crate::concurrency::foreground_is_active() {
        return welcome_refused("foreground-active");
    }
    // A WARM PROCESS WOULD ERASE THE STAGE: its live manager, loaded before the stage was written,
    // persists over `mls.bin` at its next resume (`LiveAhead`, `EpochRegression`) or checkpoint
    // while the server holds this device's commit. Nothing is staged or sent; the app's own load
    // answers the request, and the newcomer re-asks every 60 s.
    if crate::concurrency::live_manager_in_process() {
        return welcome_refused("warm-process");
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
    // The events already waiting in the state are not this Add's; only those after them are.
    let events_before = manager.pending_device_events().len();
    let base_epoch = match manager.get_epoch(group_id) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[BG_WELCOME] group={short} not held: {e}");
            return welcome_refused("group-not-held");
        }
    };
    if matches!(manager.has_pending_commit(group_id), Ok(true)) {
        log::warn!(
            "[BG_WELCOME] group={short} holds a staged commit not yet settled - no second one is staged over it"
        );
        return welcome_refused("commit-pending");
    }
    // A NEW PERSON IS NOT ADDED FROM A PUSH. Everything that brought this request here - the roster
    // row, the relayed request, the KeyPackage - is the delivery service's word; this device's tree is
    // not. A requester whose user holds no leaf is a new person, admitted only by a member's own
    // gesture: the foreground raises that approval at its next sweep (`automaticAdmission` in
    // `actions.ts`, the same rule).
    match manager.user_holds_leaf(group_id, requester) {
        Ok(true) => {}
        Ok(false) => {
            log::warn!(
                "[BG_WELCOME] {requester} has no leaf in group={short} - a new person is not added from a push, a member's approval is owed"
            );
            return welcome_refused("newcomer");
        }
        Err(e) => {
            log::warn!("[BG_WELCOME] tree of group={short} unreadable ({e}) - nothing added");
            return welcome_refused("group-not-held");
        }
    }
    // Bound to the requester BEFORE staging, typed: the refusal travels as its wire name. mls-core
    // has already logged a substitution (`identity-mismatch`, `signature-key-changed`) at ERROR.
    match manager.key_package_verdict(&kp_bytes, requester) {
        Ok(trust) => log::debug!(
            "[BG_WELCOME] key package bound to {requester} ({}) group={short}",
            trust.as_str()
        ),
        Err(reason) => {
            log::error!(
                "[BG_WELCOME] key package fetched for {requester} refused ({}) group={short} - nothing staged",
                reason.as_str()
            );
            return welcome_refused(reason.as_str());
        }
    }
    log::debug!(
        "[BG_WELCOME] add_member group={short} kp_len={} base_epoch={base_epoch}",
        kp_bytes.len()
    );
    let intent = background_welcome_intent(group_id, &format!("{user_id}:{device_id}"), requester);
    let record = match manager.add_members_recorded(
        group_id,
        &[kp_bytes.as_slice()],
        &[requester],
        intent,
    ) {
        Ok((record, _)) if !record.welcome.is_empty() => record,
        Ok((_, skipped)) => {
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
    // The STAGED state is sealed first; the tree the newcomer joins is then read from a merge made
    // in memory only, which is never written.
    let staged = match manager.save_encrypted_with_key(&key) {
        Ok(sealed) => sealed,
        Err(e) => {
            log::error!("[BG_WELCOME] staged state not sealed group={short}: {e}");
            return welcome_refused("stage-failed");
        }
    };
    let ratchet_tree = match manager
        .merge_pending_commit_for(group_id)
        .and_then(|()| manager.export_ratchet_tree_for(group_id))
    {
        Ok(tree) => tree,
        Err(e) => {
            log::error!("[BG_WELCOME] post-add tree not exported group={short}: {e}");
            return welcome_refused("stage-failed");
        }
    };
    // Only over the very bytes the Add was built from, and only in a cold process: a foreground
    // write that landed since (a checkpoint, a key change's re-seal), or a foreground manager loaded
    // since, refuses the stage HERE, before the commit goes out. The ledger entry is written under
    // the same hold of the lock as the stage.
    if let Err(reason) = write_stage(files_dir, state_bytes, &staged, || {
        note_stage_left_held(files_dir, group_id, base_epoch, &record.commit)
    }) {
        log::error!("[BG_WELCOME] Add not staged in mls.bin group={short} ({reason})");
        return welcome_refused(reason);
    }
    log::info!(
        "[BG_WELCOME] staged in mls.bin group={short} base_epoch={base_epoch} ({} bytes) - settled on the server's answer, by this engine or the foreground",
        staged.len()
    );
    // The device this Add admitted may be a new device of THIS account - the phone serving its own
    // account's new laptop. Its events ride in the STAGED state, so they reach `mls.bin` (and the
    // app's notices) only with an accepted install, and vanish with a discard. The keys go to the
    // caller for the local notification (`ownDeviceAdded`, as on the decrypt paths), which it raises
    // only once the server ACCEPTED the commit.
    let pending = manager.pending_device_events();
    let added = &pending[events_before.min(pending.len())..];
    let own_alerts = super::device_notice::owner_alert_keys_of(added, user_id, device_id);
    let mut answer = serde_json::json!({
        "ok": true,
        "welcome": STANDARD.encode(&record.welcome),
        "ratchetTree": STANDARD.encode(&ratchet_tree),
        "commit": STANDARD.encode(&record.commit),
        "groupInfo": STANDARD.encode(&record.group_info),
        "baseEpoch": base_epoch,
    });
    if !own_alerts.is_empty() {
        answer["ownDeviceAdded"] = serde_json::json!(own_alerts);
    }
    answer
}

/// Writes the staged state over `loaded` in a COLD process, then `note` under the same hold of the
/// `mls.bin` write lock ([`crate::concurrency::background_write_mls_bin_if_unchanged_and_cold_then`]).
/// A refusal is the token the prepare answers: `warm-process` when a foreground manager was loaded
/// in this process - before the prepare's early check or after it - and `stage-failed` otherwise.
/// Either way `note` did not run and `mls.bin` is untouched.
fn write_stage(
    files_dir: &Path,
    loaded: &[u8],
    staged: &[u8],
    note: impl FnOnce(),
) -> Result<(), &'static str> {
    crate::concurrency::background_write_mls_bin_if_unchanged_and_cold_then(
        &files_dir.join("mls.bin"),
        &crate::concurrency::mls_bin_digest(loaded),
        staged,
        note,
    )
    .map_err(|e| {
        log::error!("[BG_STATE] mls.bin NOT written: {e}");
        // The warm mark is never cleared while the process lives, so reading it now says whether
        // the write was refused for it - a fact, never the error's prose.
        if crate::concurrency::live_manager_in_process() {
            "warm-process"
        } else {
            "stage-failed"
        }
    })
}

/// What a discarded Welcome's refusal leaves in the stale ledger, so the same `mls.bin` bytes do not
/// answer a request the server will refuse again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalMemo<'a> {
    /// A refusal that says nothing about the next request: a racing commit, a removed requester, an
    /// answer that was no typed refusal.
    Nothing,
    /// `epoch_mismatch`: recorded for the whole group, and only when `server_epoch > base_epoch`.
    Stale { base_epoch: u64, server_epoch: u64 },
    /// `welcome_target_unknown` / `welcome_target_not_member`: recorded for this target alone
    /// (`userId:deviceId`).
    TargetRefused { target: &'a str },
}

/// The server's definitive answer to a background Welcome's commit. An answer nobody read is not
/// one: the stage is then left in `mls.bin` for the foreground to settle, and nothing is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WelcomeAnswer<'a> {
    Accepted,
    Refused(RefusalMemo<'a>),
}

/// The staged base epoch the JNI entry was handed, as the `u64` an epoch is. A negative one is the
/// Kotlin side's absent value reaching a call that needs a stage: it is refused as an argument
/// error, never read as epoch 0.
pub fn staged_base_from_jni(base_epoch: i64) -> Result<u64, String> {
    u64::try_from(base_epoch).map_err(|_| {
        log::error!("[BG_WELCOME] settle handed a negative base epoch ({base_epoch}) - refused");
        format!("base epoch {base_epoch}")
    })
}

/// The answer the JNI entry hands [`settle_background_welcome`], from its flat arguments: `accepted`
/// merges; otherwise a refused `target` is recorded for that target alone (it wins over a stale
/// pair), and `stale_base` / `server_epoch` both `>= 0` record a stale base for the group.
pub fn welcome_answer_from_jni(
    accepted: bool,
    stale_base: i64,
    server_epoch: i64,
    target: Option<&str>,
) -> WelcomeAnswer<'_> {
    if accepted {
        return WelcomeAnswer::Accepted;
    }
    WelcomeAnswer::Refused(
        match (
            target,
            u64::try_from(stale_base),
            u64::try_from(server_epoch),
        ) {
            (Some(target), _, _) => RefusalMemo::TargetRefused { target },
            (None, Ok(base_epoch), Ok(server_epoch)) => RefusalMemo::Stale {
                base_epoch,
                server_epoch,
            },
            _ => RefusalMemo::Nothing,
        },
    )
}

/// The background Welcome being settled: its group, the commit as it was submitted (base64), and
/// the epoch it was built on.
pub struct StagedWelcome<'a> {
    pub group_id: &'a str,
    pub commit_b64: &'a str,
    pub base_epoch: u64,
}

/// Settles the Add [`prepare_welcome_background_with_key`] staged in `mls.bin`, on the server's
/// definitive answer: MERGED on `accepted`, CLEARED on a refusal - and written by compare-and-swap
/// over `state_bytes`, the `mls.bin` this call loaded.
///
/// Answers `{"ok": true, "settled": "merged" | "cleared"}`, or `{"ok": false, "reason"}`:
/// - `left-to-foreground`: the write was refused (the foreground started, or wrote, since, or a
///   foreground manager was loaded in this process - the stage is then in the state it loaded), or
///   the merge or clear failed. The stage is still in whatever `mls.bin` now holds, and the foreground
///   settles it against the server at its next load;
/// - `already-settled`: the stage is gone and the group is where the answer puts it - the
///   foreground settled it first;
/// - `accepted-not-held`: the server accepted, and `mls.bin` holds neither the stage nor the epoch
///   it creates. A foreground write that never loaded the stage replaced it
///   (docs/wiki/backlog.md, the blind foreground checkpoint); the foreground's replay meets this
///   device's own commit and recovers through the usual ladder. Said at ERROR;
/// - `commit-unreadable`, `state-unreadable`.
///
/// A refusal is then recorded in the stale ledger against the bytes WRITTEN, which are the bytes
/// the next request is answered from ([`welcome_request_known_refused`]).
pub fn settle_background_welcome(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    staged: &StagedWelcome,
    answer: WelcomeAnswer<'_>,
) -> serde_json::Value {
    let StagedWelcome {
        group_id,
        commit_b64,
        base_epoch,
    } = *staged;
    let short: String = group_id.chars().take(8).collect();
    let verb = match answer {
        WelcomeAnswer::Accepted => "merged",
        WelcomeAnswer::Refused(_) => "cleared",
    };
    log::info!("[BG_WELCOME] settle group={short} base_epoch={base_epoch}: {verb}");
    let Ok(commit) = STANDARD.decode(commit_b64.trim()) else {
        log::error!(
            "[BG_WELCOME] settle group={short}: the commit is not base64 - left to the foreground"
        );
        return refused("commit-unreadable");
    };
    let (mut manager, key) = match load_manager_with_key_b64(
        state_bytes,
        key_b64,
        user_id,
        device_id,
    ) {
        Ok(pair) => pair,
        Err(e) => {
            log::error!(
                    "[BG_WELCOME] settle group={short}: mls.bin unreadable with the device key ({e}) - left to the foreground"
                );
            return refused("state-unreadable");
        }
    };
    let held = matches!(
        manager.pending_submission(group_id),
        mls_core::pending_submission::PendingSubmissionRead::Recorded(ref r) if r.commit == commit
    );
    if !held {
        let epoch = manager.get_epoch(group_id).ok();
        return match (answer, epoch) {
            (WelcomeAnswer::Accepted, Some(e)) if e > base_epoch => {
                log::info!(
                    "[BG_WELCOME] settle group={short}: already merged (epoch {e}) - the foreground settled it first"
                );
                forget_stage(files_dir, group_id, &commit);
                refused("already-settled")
            }
            (WelcomeAnswer::Accepted, _) => {
                log::error!(
                    "[BG_WELCOME] ACCEPTED AND NOT HELD group={short}: mls.bin holds neither the staged Add of base {base_epoch} nor the epoch it creates (epoch {epoch:?}) - a write that never loaded the stage replaced it"
                );
                forget_stage(files_dir, group_id, &commit);
                refused("accepted-not-held")
            }
            (WelcomeAnswer::Refused(_), _) => {
                log::info!(
                    "[BG_WELCOME] settle group={short}: the refused Add is no longer staged - the foreground settled it first"
                );
                forget_stage(files_dir, group_id, &commit);
                refused("already-settled")
            }
        };
    }
    let acted = match answer {
        WelcomeAnswer::Accepted => manager.merge_pending_commit_for(group_id),
        WelcomeAnswer::Refused(_) => manager.clear_pending_commit_for(group_id),
    };
    let sealed = match acted.and_then(|()| manager.save_encrypted_with_key(&key)) {
        Ok(sealed) => sealed,
        Err(e) => {
            log::error!(
                "[BG_WELCOME] settle group={short}: not {verb} ({e}) - the stage stays in mls.bin for the foreground"
            );
            return refused("left-to-foreground");
        }
    };
    // COLD ONLY, as the stage was written: a foreground manager loaded since holds the stage and
    // settles it itself; a settle written under it would be persisted over.
    if let Err(e) = crate::concurrency::background_write_mls_bin_if_unchanged_and_cold(
        &files_dir.join("mls.bin"),
        &crate::concurrency::mls_bin_digest(state_bytes),
        &sealed,
    ) {
        log::warn!(
            "[BG_WELCOME] settle group={short}: {verb} state not written ({e}) - the stage stays in mls.bin, settled by the foreground against the server"
        );
        return refused("left-to-foreground");
    }
    log::info!("[BG_WELCOME] settle group={short}: {verb} and written");
    forget_stage(files_dir, group_id, &commit);
    if let WelcomeAnswer::Refused(memo) = answer {
        record_refusal(files_dir, group_id, &sealed, memo);
    }
    serde_json::json!({ "ok": true, "settled": verb })
}

/// Records what `memo` says against `written`, the `mls.bin` bytes a refusal's clear produced, so
/// those bytes do not answer a request the server would refuse again
/// ([`welcome_request_known_refused`]).
fn record_refusal(files_dir: &Path, group_id: &str, written: &[u8], memo: RefusalMemo<'_>) {
    let short: String = group_id.chars().take(8).collect();
    let digest = hex(&crate::concurrency::mls_bin_digest(written));
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

/// Writes a background engine's new state ONLY over the very `mls.bin` it loaded
/// ([`crate::concurrency::background_write_mls_bin_if_unchanged`]) - the one write every background
/// engine makes.
///
/// **THE FOREGROUND GUARD ALONE LET AN OLD KEY BACK IN.** An engine loads the bytes and the key, then
/// works; the foreground can meanwhile re-seal `mls.bin` under another key (the move to the
/// hardware-held key, a PIN change) and go to the background, which drops the guard at once. A plain
/// write then put back the state under the key that no longer opens it. Any foreground write changes
/// the bytes, so the compare refuses it - under the same lock every `mls.bin` writer takes. The
/// refusal is an error: a send batch is discarded and re-encrypted at the next drain, a Welcome stays
/// for the foreground.
fn write_over_loaded_state(files_dir: &Path, loaded: &[u8], data: &[u8]) -> Result<(), String> {
    crate::concurrency::background_write_mls_bin_if_unchanged(
        &files_dir.join("mls.bin"),
        &crate::concurrency::mls_bin_digest(loaded),
        data,
    )
    .map_err(|e| {
        log::error!("[BG_STATE] mls.bin NOT written: {e}");
        format!("write mls.bin: {e}")
    })
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
    write_over_loaded_state(files_dir, state_bytes, &enc)?;
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
    max_attempts: usize,
) -> Result<serde_json::Value, String> {
    if entries.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "results": [] }));
    }

    // The one load for the whole batch.
    let (mut manager, key) = load_manager_with_key_b64(state_bytes, key_b64, user_id, device_id)?;

    let mut results = Vec::with_capacity(entries.len());
    let mut encrypted = 0usize;
    let mut attempted = 0usize;
    let mut held = 0usize;
    for entry in entries {
        // A GROUP WHOSE STAGED COMMIT IS UNSETTLED takes no slot of the batch: its entries stay
        // queued, and the batch fills from the groups that can seal.
        if matches!(manager.has_pending_commit(&entry.group_id), Ok(true)) {
            held += 1;
            results.push(serde_json::json!({
                "id": entry.id,
                "ok": false,
                "error": "commit-pending: the group's staged commit is not settled - kept queued",
            }));
            continue;
        }
        if attempted >= max_attempts {
            // Not attempted, no result: the caller keeps it queued for the next drain.
            continue;
        }
        attempted += 1;
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

    // NOTHING ATTEMPTED, NOTHING ADVANCED: a batch whose every entry was held (or left) moved no
    // ratchet, so `mls.bin` is not rewritten - a write here would only change the digest the stale
    // ledger and a concurrent engine's compare-and-swap read.
    if attempted == 0 {
        log::info!(
            "[BG_SEND] batch encrypted nothing: {held} held behind a staged commit, {} left for the next drain - mls.bin not rewritten",
            entries.len() - held
        );
        return Ok(serde_json::json!({ "ok": true, "results": results }));
    }

    // The one save for the whole batch - and it happens before any ciphertext leaves this function.
    let enc = manager
        .save_encrypted_with_key(&key)
        .map_err(|e| e.to_string())?;
    write_over_loaded_state(files_dir, state_bytes, &enc)?;
    log::info!(
        "[BG_SEND] batch encrypted {encrypted}/{attempted} attempted, {held} held behind a staged commit, {} left for the next drain (mls.bin {} bytes, 1 load, 1 save)",
        entries.len() - attempted - held,
        enc.len()
    );

    Ok(serde_json::json!({ "ok": true, "results": results }))
}

/// Encrypts a single entry against an already-loaded manager, with its author's signature - the
/// same authored send as the foreground, so a message drained here is as relayable as any other.
/// Split out so the batch loop has one obvious failure boundary per entry. The batch loop has
/// already held back a group whose staged commit is unsettled (a background Welcome's Add whose
/// answer nobody read): the group may be one epoch on, and the foreground holds its own sends the
/// same way - refused natively as `StagedCommitPendingError` and settled, or held as
/// `CommitOutcomeUnknownError` while no answer is read.
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
    /// `send_messages_background_with_key` writes `mls.bin` through `write_over_loaded_state`,
    /// which refuses while the PROCESS-global foreground guard is up - and other modules' tests
    /// raise it. So every test here that sends holds the shared serialiser and clears the guard,
    /// or it fails whenever a foreground test runs beside it.
    fn quiet_foreground() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        crate::concurrency::forget_live_manager_for_test();
        guard
    }

    /// The app opened and then backgrounded again: a foreground manager is loaded in this process,
    /// and the foreground guard has expired.
    fn warm_the_process(dir: &Path) {
        crate::concurrency::foreground_load_mls_bin(&dir.join("mls.bin")).unwrap();
        crate::concurrency::mark_foreground_inactive();
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
        let dir = dir_holding("batch", &state_bytes);

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
            100,
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
            100,
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
        let dir = dir_holding("isolate", &state_bytes);

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
            100,
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

    /// THE OLD KEY NEVER COMES BACK. A drain loaded `mls.bin` under the key the PIN derived; the
    /// foreground then re-sealed it under the hardware-held key (or a new PIN's) and went to the
    /// background, so the foreground guard is down. The drain's write must be refused - it would put
    /// back a state the key now in the keystore does not open - and the re-sealed file must survive.
    #[test]
    fn a_drain_never_writes_over_a_state_re_sealed_since_it_loaded() {
        let _fg = quiet_foreground();
        let (alice, _bob, group_id) = joined_pair("reseal");
        let old_key = decode_base64_to_32_bytes(&key_b64(31)).expect("old key");
        let new_key = decode_base64_to_32_bytes(&key_b64(32)).expect("new key");
        let loaded = alice.save_encrypted_with_key(&old_key).expect("seal old");
        let dir = dir_holding("reseal", &loaded);
        let re_sealed = alice.save_encrypted_with_key(&new_key).expect("seal new");
        std::fs::write(dir.join("mls.bin"), &re_sealed).expect("foreground re-seal");

        let out = send_messages_background_with_key(
            &dir,
            &loaded,
            &key_b64(31),
            "reseal-alice",
            "dev-a",
            &[entry("id-0", &group_id, b"late")],
            100,
        );
        assert!(
            out.is_err(),
            "the drain must not persist over a re-sealed state"
        );
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).expect("mls.bin"),
            re_sealed,
            "the state under the new key survives"
        );
    }

    #[test]
    fn an_empty_batch_writes_nothing_and_returns_no_results() {
        let _fg = quiet_foreground();
        let dir = temp_dir("empty");
        let _ = std::fs::remove_file(dir.join("mls.bin"));
        let out = send_messages_background_with_key(&dir, &[], &key_b64(3), "u", "d", &[], 100)
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
        let dir = dir_holding("graine", &alice_state);

        let seed = [42u8; 32];
        let frame = endorsed_seed_frame(&alice, "graine-alice", "sess-abc", &seed);
        let out = send_messages_background_with_key(
            &dir,
            &alice_state,
            &key_b64(11),
            "graine-alice",
            "dev-a",
            &[entry("seed-1", &group_id, &frame)],
            100,
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
            &dir_holding("graine-ahead", &alice_state),
            &alice_state,
            &key_b64(13),
            "graine-ahead-alice",
            "dev-a",
            &[entry("seed-ahead", &group_id, &frame)],
            100,
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
            &dir_holding(tag, &alice_state),
            &alice_state,
            &key_b64(seed),
            &format!("{tag}-alice"),
            "dev-a",
            &[entry("frame-1", &group_id, frame)],
            100,
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
            &dir_holding(tag, &alice_state),
            &alice_state,
            &key_b64(19),
            &format!("{tag}-alice"),
            "dev-a",
            &[entry("frame-1", &group_id, &frame)],
            100,
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
                &dir_holding(&format!("{tag}-{n}"), &alice_state),
                &alice_state,
                &key_b64(20 + n),
                &alice_id,
                "dev-a",
                &[entry("seed", &group_id, &frame)],
                100,
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

    // --- The background Welcome: staged in mls.bin, settled by whoever answers first --------------

    /// A shut phone (`alice`) in a group that moved on without it: `bob` admitted `dave`, so the
    /// group is one epoch past alice's `mls.bin`. Returns alice's stale sealed state, the commit that
    /// moved the group, the key package of a NEW DEVICE of bob (`dev-c`, asking for a Welcome - a
    /// member's device, the one case a background Add answers) and the group id.
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
        let carol = MlsManager::load_or_create(&format!("{tag}-bob"), "dev-c", None).unwrap();
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

    /// Alice in a group with bob, her sealed state in a directory of its own, and a NEW DEVICE of
    /// bob (`dev-c`, named `carol` below for the device asking) with the key package it asks to be
    /// added with - a member's device, the one case a background Add answers (`newcomer` otherwise).
    fn holder_and_newcomer(
        tag: &str,
        seed: u8,
    ) -> (std::path::PathBuf, Vec<u8>, MlsManager, String, String) {
        let (alice, _bob, gid) = joined_pair(tag);
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(seed)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding(tag, &state);
        let carol = MlsManager::load_or_create(&format!("{tag}-bob"), "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());
        (dir, state, carol, kp, gid)
    }

    /// The background prepare, as the FCM service calls it, for `{tag}-bob:dev-c`.
    fn prepare(
        dir: &Path,
        state: &[u8],
        seed: u8,
        tag: &str,
        gid: &str,
        kp: &str,
    ) -> serde_json::Value {
        prepare_welcome_background_with_key(
            dir,
            state,
            &key_b64(seed),
            &format!("{tag}-alice"),
            "dev-a",
            &WelcomeRequest {
                group_id: gid,
                requester: &format!("{tag}-bob:dev-c"),
                key_package_b64: kp,
            },
        )
    }

    /// The background settlement of `prepared`, from the `mls.bin` on disk NOW - what the FCM
    /// service loads under the state lock once the answer is read.
    fn settle(
        dir: &Path,
        seed: u8,
        tag: &str,
        gid: &str,
        prepared: &serde_json::Value,
        answer: WelcomeAnswer<'_>,
    ) -> serde_json::Value {
        let on_disk = std::fs::read(dir.join("mls.bin")).unwrap();
        settle_from(dir, &on_disk, seed, tag, gid, prepared, answer)
    }

    fn settle_from(
        dir: &Path,
        loaded: &[u8],
        seed: u8,
        tag: &str,
        gid: &str,
        prepared: &serde_json::Value,
        answer: WelcomeAnswer<'_>,
    ) -> serde_json::Value {
        settle_background_welcome(
            dir,
            loaded,
            &key_b64(seed),
            &format!("{tag}-alice"),
            "dev-a",
            &StagedWelcome {
                group_id: gid,
                commit_b64: prepared["commit"].as_str().unwrap(),
                base_epoch: prepared["baseEpoch"].as_u64().unwrap(),
            },
            answer,
        )
    }

    /// The `mls.bin` on disk, loaded as `{tag}-alice` - what the foreground's next load reads.
    fn on_disk(dir: &Path, tag: &str, seed: u8) -> MlsManager {
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(seed)).unwrap();
        MlsManager::load_with_key(
            &format!("{tag}-alice"),
            "dev-a",
            Some(std::fs::read(dir.join("mls.bin")).unwrap()),
            &key,
        )
        .unwrap()
    }

    fn b64(v: &serde_json::Value, field: &str) -> Vec<u8> {
        STANDARD.decode(v[field].as_str().unwrap()).unwrap()
    }

    /// THE STAGE IS IN `mls.bin`, WITH ITS SUBMISSION, BEFORE THE COMMIT LEAVES. Whoever loads the
    /// file next finds a pending commit at the base epoch and the record the foreground settles it
    /// from - the commit and the Welcome byte for byte as submitted, and the intent naming carol.
    #[test]
    fn a_prepared_add_is_staged_in_mls_bin_with_its_submission() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("stage", 60);

        let prepared = prepare(&dir, &state, 60, "stage", &gid, &kp);

        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        let back = on_disk(&dir, "stage", 60);
        assert_eq!(back.get_epoch(&gid).unwrap(), 1, "staged, not merged");
        assert_eq!(back.groups_with_pending_commit(), vec![gid.clone()]);
        let mls_core::pending_submission::PendingSubmissionRead::Recorded(record) =
            back.pending_submission(&gid)
        else {
            panic!("no submission recorded beside the stage");
        };
        assert_eq!(record.commit, b64(&prepared, "commit"));
        assert_eq!(record.welcome, b64(&prepared, "welcome"));
        assert_eq!(record.base_epoch, 1);
        assert_eq!(record.added_indices, vec![0]);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&record.intent).unwrap(),
            serde_json::json!({
                "groupId": gid,
                "self": "stage-alice:dev-a",
                "excludeDeviceIds": ["stage-bob:dev-c"],
                "keyPackageDevices": ["dev-c"],
            })
        );
    }

    /// A WARM PROCESS STAGES NOTHING AND SENDS NOTHING: its live manager would persist over the
    /// stage at its next resume or checkpoint while the server holds the commit. The refusal is the
    /// `warm-process` token, and `mls.bin` and the stages ledger are untouched.
    #[test]
    fn a_warm_process_stages_no_welcome() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("warmprep", 67);
        warm_the_process(&dir);

        let answer = prepare(&dir, &state, 67, "warmprep", &gid, &kp);
        crate::concurrency::forget_live_manager_for_test();

        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["reason"], "warm-process");
        assert!(answer.get("commit").is_none(), "nothing to send");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
        assert!(!dir.join(BACKGROUND_STAGES_FILE).exists());
    }

    /// A MANAGER LOADED BETWEEN THE PREPARE'S EARLY CHECK AND ITS WRITE: the compare-and-swap is the
    /// proof, so the write is refused as `warm-process`, the ledger note never runs, and `mls.bin` is
    /// untouched.
    #[test]
    fn a_manager_loaded_before_the_stage_write_refuses_it_as_warm_process() {
        let _s = quiet_foreground();
        let (dir, state, _carol, _kp, _gid) = holder_and_newcomer("warmcas", 69);
        warm_the_process(&dir);
        let mut noted = false;

        let written = write_stage(&dir, &state, b"staged state", || noted = true);
        crate::concurrency::forget_live_manager_for_test();

        assert_eq!(written, Err("warm-process"));
        assert!(!noted, "the ledger note runs only after a write");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
        assert!(!dir.join(BACKGROUND_STAGES_FILE).exists());

        // The same write in a cold process lands, and notes.
        let written = write_stage(&dir, &state, b"staged state", || noted = true);
        assert_eq!(written, Ok(()));
        assert!(noted);
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), b"staged state");
    }

    /// A PROCESS WARMED INSIDE THE ROUND TRIP: the stage was written cold, then the app opened and
    /// loaded it. The settle is refused (`left-to-foreground`) and writes nothing - the loaded state
    /// holds the stage and settles it itself - and the ledger keeps the stage for its report.
    #[test]
    fn a_process_warmed_inside_the_round_trip_leaves_the_settle_to_the_foreground() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("warmsettle", 68);
        let prepared = prepare(&dir, &state, 68, "warmsettle", &gid, &kp);
        assert_eq!(prepared["ok"], true, "{prepared}");
        let staged = std::fs::read(dir.join("mls.bin")).unwrap();
        warm_the_process(&dir);

        let settled = settle(
            &dir,
            68,
            "warmsettle",
            &gid,
            &prepared,
            WelcomeAnswer::Accepted,
        );
        crate::concurrency::forget_live_manager_for_test();

        assert_eq!(settled["reason"], "left-to-foreground", "{settled}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), staged);
        let ledger: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(BACKGROUND_STAGES_FILE)).unwrap())
                .unwrap();
        assert_eq!(ledger[&gid]["baseEpoch"], 1, "{ledger}");
    }

    /// A SETTLE FORGETS ITS OWN STAGE ONLY: an entry naming another commit of the same group is a
    /// later stage, still owed its report.
    #[test]
    fn a_settle_forgets_only_its_own_stage() {
        let _s = quiet_foreground();
        let dir = dir_holding("forget-own", b"x");
        let gid = "g-forget-own";
        crate::commands::storage::with_json_ledger(&dir, BACKGROUND_STAGES_FILE, |map| {
            map.insert(
                gid.to_string(),
                serde_json::json!({ "baseEpoch": 2, "commit": stage_digest(b"later") }),
            );
            ((), true)
        })
        .unwrap();

        forget_stage(&dir, gid, b"earlier");
        let kept: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(BACKGROUND_STAGES_FILE)).unwrap())
                .unwrap();
        assert_eq!(kept[gid]["baseEpoch"], 2, "a later stage is kept: {kept}");

        forget_stage(&dir, gid, b"later");
        let gone: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(BACKGROUND_STAGES_FILE)).unwrap())
                .unwrap();
        assert!(
            gone.get(gid).is_none(),
            "its own stage is forgotten: {gone}"
        );
    }

    /// The intent is the client's `CommitIntent`, and this fixture is read by BOTH sides: here it
    /// must be what the background writes, and in `commitSubmission.test.ts` what the foreground's
    /// settle reads into the submission it resubmits.
    #[test]
    fn the_recorded_intent_is_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/lib/mls-client/test/fixtures/background-welcome-intent.json"
        ))
        .unwrap();
        let written: serde_json::Value = serde_json::from_slice(&background_welcome_intent(
            "g-fixture",
            "alice:dev-a",
            "carol:dev-c",
        ))
        .unwrap();
        assert_eq!(written, fixture);
    }

    /// The accepted half: the stage is merged, the newcomer joins the state that was written, and
    /// a SECOND copy of the Welcome - the foreground's settle sends one too when it merges a stage
    /// the background could not - leaves the newcomer's group as it was.
    #[test]
    fn an_accepted_add_is_merged_and_a_second_welcome_changes_nothing() {
        let _s = quiet_foreground();
        let (dir, state, mut carol, kp, gid) = holder_and_newcomer("accepted", 42);
        let prepared = prepare(&dir, &state, 42, "accepted", &gid, &kp);
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");

        let settled = settle(
            &dir,
            42,
            "accepted",
            &gid,
            &prepared,
            WelcomeAnswer::Accepted,
        );

        assert_eq!(settled["settled"], "merged", "settled: {settled}");
        let mut back = on_disk(&dir, "accepted", 42);
        assert_eq!(back.get_epoch(&gid).unwrap(), 2, "the add is merged");
        assert!(back.groups_with_pending_commit().is_empty());
        let welcome = b64(&prepared, "welcome");
        let tree = b64(&prepared, "ratchetTree");
        carol
            .process_welcome(&welcome, Some(&tree))
            .expect("carol joins");
        assert!(
            carol.process_welcome(&welcome, Some(&tree)).is_err(),
            "the second copy is refused"
        );
        let hello = back.send_message(&gid, b"welcome carol").unwrap();
        assert_eq!(
            carol.process_incoming_message(&gid, &hello).unwrap(),
            Some(b"welcome carol".to_vec()),
            "the written state and the newcomer's are one epoch, the second copy notwithstanding"
        );
        assert_eq!(
            settle(
                &dir,
                42,
                "accepted",
                &gid,
                &prepared,
                WelcomeAnswer::Accepted
            )["reason"],
            "already-settled",
            "a second settlement finds the epoch the add created"
        );
    }

    /// THE DEFECT READ ON THE MI 9T, 2026-10-22: a phone answering from its old epoch must not keep
    /// an add the gate refused. The refusal CLEARS the stage, and the phone follows its group.
    #[test]
    fn a_refused_background_welcome_leaves_mls_bin_able_to_follow_its_group() {
        let _s = quiet_foreground();
        let (stale, mut bob, moved, kp, gid) = shut_phone_behind_its_group("refused", 41);
        let dir = dir_holding("refused", &stale);
        let prepared = prepare(&dir, &stale, 41, "refused", &gid, &kp);
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        assert_eq!(prepared["baseEpoch"], 1, "built on the stale base");

        let settled = settle(
            &dir,
            41,
            "refused",
            &gid,
            &prepared,
            WelcomeAnswer::Refused(RefusalMemo::Stale {
                base_epoch: 1,
                server_epoch: 2,
            }),
        );

        assert_eq!(settled["settled"], "cleared", "settled: {settled}");
        let mut back = on_disk(&dir, "refused", 41);
        assert!(
            back.groups_with_pending_commit().is_empty(),
            "the stage is cleared"
        );
        back.process_incoming_message(&gid, &moved)
            .expect("the group's commit applies");
        let next = bob.send_message(&gid, b"after").unwrap();
        assert_eq!(
            back.process_incoming_message(&gid, &next)
                .expect("the phone reads the group's next message"),
            Some(b"after".to_vec())
        );
    }

    /// NO ANSWER, AND THE FOREGROUND SETTLES IT. The background read nothing (a transport failure),
    /// so it calls nothing, and the answer that arrives later finds the foreground running: it
    /// writes nothing either. The foreground's load finds the stage and its record, resubmits the
    /// same commit, is answered `duplicate`, and merges - the newcomer, who joined from the
    /// route's Welcome, reads it.
    #[test]
    fn a_stage_the_background_never_settled_is_settled_by_the_foreground() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (dir, state, mut carol, kp, gid) = holder_and_newcomer("nosettle", 61);
        let prepared = prepare(&dir, &state, 61, "nosettle", &gid, &kp);
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        let staged = std::fs::read(dir.join("mls.bin")).unwrap();

        // The user opens the app inside the round trip.
        crate::concurrency::mark_foreground_active();
        let late = settle(
            &dir,
            61,
            "nosettle",
            &gid,
            &prepared,
            WelcomeAnswer::Accepted,
        );
        assert_eq!(late["reason"], "left-to-foreground", "{late}");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            staged,
            "nothing is written under the foreground"
        );

        let mut foreground = on_disk(&dir, "nosettle", 61);
        assert_eq!(foreground.groups_with_pending_commit(), vec![gid.clone()]);
        let mls_core::pending_submission::PendingSubmissionRead::Recorded(record) =
            foreground.pending_submission(&gid)
        else {
            panic!("the foreground finds no record to resubmit");
        };
        assert_eq!(record.commit, b64(&prepared, "commit"), "the same bytes");
        // The gate answers the resubmission `duplicate`: the settle merges.
        foreground.merge_pending_commit_for(&gid).unwrap();
        crate::concurrency::mark_foreground_inactive();

        assert_eq!(foreground.get_epoch(&gid).unwrap(), 2);
        carol
            .process_welcome(
                &b64(&prepared, "welcome"),
                Some(&b64(&prepared, "ratchetTree")),
            )
            .expect("carol joins from the route's Welcome");
        let hello = foreground.send_message(&gid, b"settled").unwrap();
        assert_eq!(
            carol.process_incoming_message(&gid, &hello).unwrap(),
            Some(b"settled".to_vec())
        );
    }

    /// A FOREGROUND THAT RAN INSIDE THE ROUND TRIP LOADED THE STAGE, so its checkpoint writes it
    /// back, and the background's answer - settled from the bytes it reads at that moment - still
    /// merges it. The write that used to lose an accepted add is now the write that carries it.
    #[test]
    fn a_checkpoint_inside_the_round_trip_carries_the_stage() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("carried", 62);
        let prepared = prepare(&dir, &state, 62, "carried", &gid, &kp);
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");

        crate::concurrency::mark_foreground_active();
        let foreground = on_disk(&dir, "carried", 62);
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(62)).unwrap();
        std::fs::write(
            dir.join("mls.bin"),
            foreground.save_encrypted_with_key(&key).unwrap(),
        )
        .unwrap();
        crate::concurrency::mark_foreground_inactive();

        let settled = settle(
            &dir,
            62,
            "carried",
            &gid,
            &prepared,
            WelcomeAnswer::Accepted,
        );

        assert_eq!(settled["settled"], "merged", "settled: {settled}");
        assert_eq!(on_disk(&dir, "carried", 62).get_epoch(&gid).unwrap(), 2);
    }

    /// A write between the settlement's load and its write refuses the write: the stage stays in
    /// whatever `mls.bin` now holds, for the foreground.
    #[test]
    fn a_settlement_does_not_write_over_a_file_that_moved() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("moved", 43);
        let prepared = prepare(&dir, &state, 43, "moved", &gid, &kp);
        assert_eq!(prepared["ok"], true);
        let loaded = std::fs::read(dir.join("mls.bin")).unwrap();

        std::fs::write(dir.join("mls.bin"), b"a newer state").unwrap();
        let settled = settle_from(
            &dir,
            &loaded,
            43,
            "moved",
            &gid,
            &prepared,
            WelcomeAnswer::Accepted,
        );

        assert_eq!(settled["reason"], "left-to-foreground");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            b"a newer state"
        );
    }

    /// An acceptance whose stage a write that never loaded it replaced is said, typed and at ERROR:
    /// the server holds a commit this device does not (docs/wiki/backlog.md, the blind checkpoint).
    #[test]
    fn an_accepted_add_no_longer_in_mls_bin_is_said() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("erased", 63);
        let prepared = prepare(&dir, &state, 63, "erased", &gid, &kp);
        assert_eq!(prepared["ok"], true);

        std::fs::write(dir.join("mls.bin"), &state).unwrap();
        let settled = settle(&dir, 63, "erased", &gid, &prepared, WelcomeAnswer::Accepted);

        assert_eq!(settled["reason"], "accepted-not-held", "{settled}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
    }

    /// One staged commit per group: a second request is not answered over the first, whose outcome
    /// is not known yet.
    #[test]
    fn no_second_add_is_staged_over_an_unsettled_one() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("twice", 64);
        assert_eq!(prepare(&dir, &state, 64, "twice", &gid, &kp)["ok"], true);
        let staged = std::fs::read(dir.join("mls.bin")).unwrap();

        let again = prepare(&dir, &staged, 64, "twice", &gid, &kp);

        assert_eq!(again["reason"], "commit-pending", "{again}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), staged);
    }

    /// The outbox drain seals nothing in a group whose staged Add is unsettled, and keeps it queued.
    #[test]
    fn the_outbox_holds_a_group_whose_add_is_unsettled() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("held", 65);
        assert_eq!(prepare(&dir, &state, 65, "held", &gid, &kp)["ok"], true);
        let staged = std::fs::read(dir.join("mls.bin")).unwrap();
        let entry = OutboxEntry {
            id: "m1".into(),
            group_id: gid.clone(),
            proto: STANDARD.encode(b"hello"),
        };

        let out = send_messages_background_with_key(
            &dir,
            &staged,
            &key_b64(65),
            "held-alice",
            "dev-a",
            &[entry],
            100,
        )
        .unwrap();

        assert_eq!(out["results"][0]["ok"], false, "{out}");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            staged,
            "a batch that attempted nothing does not rewrite mls.bin"
        );
        assert_eq!(on_disk(&dir, "held", 65).get_epoch(&gid).unwrap(), 1);
        assert_eq!(
            on_disk(&dir, "held", 65).groups_with_pending_commit(),
            vec![gid]
        );
    }

    /// A HELD GROUP TAKES NO SLOT OF THE BATCH: its entries stay queued with a result, and the cap
    /// counts only the entries the drain attempted - so a group waiting on its settlement cannot
    /// starve the others of the batch.
    #[test]
    fn a_held_group_takes_no_slot_of_the_batch() {
        let _s = quiet_foreground();
        let (mut alice, _bob, held_gid) = joined_pair("slots");
        let free_gid = "slots-free".to_string();
        alice.create_group(free_gid.clone()).unwrap();
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(66)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("slots", &state);
        let carol = MlsManager::load_or_create("slots-bob", "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());
        assert_eq!(
            prepare(&dir, &state, 66, "slots", &held_gid, &kp)["ok"],
            true
        );
        let staged = std::fs::read(dir.join("mls.bin")).unwrap();

        let out = send_messages_background_with_key(
            &dir,
            &staged,
            &key_b64(66),
            "slots-alice",
            "dev-a",
            &[
                entry("h1", &held_gid, b"a"),
                entry("h2", &held_gid, b"b"),
                entry("f1", &free_gid, b"c"),
                entry("f2", &free_gid, b"d"),
            ],
            1,
        )
        .unwrap();

        let outcome: Vec<(String, bool)> = out["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["id"].as_str().unwrap().to_string(), r["ok"] == true))
            .collect();
        assert_eq!(
            outcome,
            vec![
                ("h1".to_string(), false),
                ("h2".to_string(), false),
                ("f1".to_string(), true),
            ],
            "the held entries are answered without a slot, and the one slot seals f1: {out}"
        );
    }

    /// A REFUSAL THAT FINDS NO STAGE says it was settled first, writes nothing, and forgets the
    /// stage the prepare noted - nothing is left for the foreground to report.
    #[test]
    fn a_refused_settle_that_finds_no_stage_is_already_settled() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("nostage", 67);
        let prepared = prepare(&dir, &state, 67, "nostage", &gid, &kp);
        assert_eq!(prepared["ok"], true, "{prepared}");
        assert!(
            stages_ledger(&dir).contains_key(&gid),
            "the prepare notes the stage"
        );
        std::fs::write(dir.join("mls.bin"), &state).unwrap();

        let settled = settle(
            &dir,
            67,
            "nostage",
            &gid,
            &prepared,
            WelcomeAnswer::Refused(RefusalMemo::Nothing),
        );

        assert_eq!(settled["reason"], "already-settled", "{settled}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
        assert!(stages_ledger(&dir).is_empty(), "the stage is forgotten");
    }

    /// A stage this engine settles is forgotten; one it leaves stays named for the foreground.
    #[test]
    fn a_stage_is_named_until_it_is_settled() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("ledger", 68);
        let prepared = prepare(&dir, &state, 68, "ledger", &gid, &kp);
        assert_eq!(
            stages_ledger(&dir).get(&gid),
            Some(&serde_json::json!({
                "baseEpoch": 1,
                "commit": stage_digest(&b64(&prepared, "commit")),
            }))
        );

        let settled = settle(&dir, 68, "ledger", &gid, &prepared, WelcomeAnswer::Accepted);

        assert_eq!(settled["settled"], "merged", "{settled}");
        assert!(stages_ledger(&dir).is_empty());
    }

    /// The foreground's load reports every stage the background left, by what it finds - and
    /// forgets them, so each is reported once.
    #[test]
    fn the_foregrounds_load_reports_each_stage_it_was_left() {
        use crate::commands::storage::{report_background_stages, StagesReport};
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("report", 69);
        assert_eq!(prepare(&dir, &state, 69, "report", &gid, &kp)["ok"], true);
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(69)).unwrap();
        let note = || {
            std::fs::write(
                dir.join(BACKGROUND_STAGES_FILE),
                serde_json::json!({ gid.clone(): { "baseEpoch": 1 } }).to_string(),
            )
            .unwrap();
        };

        let staged = on_disk(&dir, "report", 69);
        assert_eq!(
            report_background_stages(&dir, &staged),
            StagesReport {
                found: 1,
                merged: 0,
                absent: 0
            }
        );
        assert!(stages_ledger(&dir).is_empty(), "reported once");

        note();
        let mut merged = on_disk(&dir, "report", 69);
        merged.merge_pending_commit_for(&gid).unwrap();
        assert_eq!(
            report_background_stages(&dir, &merged),
            StagesReport {
                found: 0,
                merged: 1,
                absent: 0
            }
        );

        note();
        let without =
            MlsManager::load_with_key("report-alice", "dev-a", Some(state), &key).unwrap();
        assert_eq!(
            report_background_stages(&dir, &without),
            StagesReport {
                found: 0,
                merged: 0,
                absent: 1
            }
        );
    }

    /// What keeping a live state over the file erases is counted: a stage the file holds and the
    /// live state does not, and a group the file holds at a later epoch.
    #[test]
    fn a_live_persist_counts_what_it_erases() {
        use crate::commands::storage::report_what_a_live_persist_erases;
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("erase", 70);
        assert_eq!(prepare(&dir, &state, 70, "erase", &gid, &kp)["ok"], true);
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(70)).unwrap();
        let live = MlsManager::load_with_key("erase-alice", "dev-a", Some(state), &key).unwrap();
        let mut file = on_disk(&dir, "erase", 70);

        assert_eq!(report_what_a_live_persist_erases(&live, &file), (1, 0));
        file.merge_pending_commit_for(&gid).unwrap();
        assert_eq!(report_what_a_live_persist_erases(&live, &file), (0, 1));
        assert_eq!(report_what_a_live_persist_erases(&file, &file), (0, 0));
    }

    /// THE STATE REFUSES A SEND IN A GROUP WITH A STAGED COMMIT, whatever the WebView's index says:
    /// typed, so the send path settles rather than fails.
    #[test]
    fn the_foreground_send_is_refused_while_a_commit_is_staged() {
        use crate::commands::mls::{seal_unless_commit_pending, Scellement};
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("sealrefused", 71);
        assert_eq!(
            prepare(&dir, &state, 71, "sealrefused", &gid, &kp)["ok"],
            true
        );
        let mut staged = on_disk(&dir, "sealrefused", 71);

        assert_eq!(
            seal_unless_commit_pending(&mut staged, &gid, b"hi").unwrap(),
            Scellement::CommitPending
        );
        staged.merge_pending_commit_for(&gid).unwrap();
        assert!(matches!(
            seal_unless_commit_pending(&mut staged, &gid, b"hi").unwrap(),
            Scellement::Sealed { .. }
        ));
    }

    /// The JNI's flat answer: a refused target wins over a stale pair, a stale pair needs both
    /// epochs, and a negative one is the absent value - recorded as nothing.
    #[test]
    fn the_jni_answer_maps_target_over_stale_and_negatives_to_nothing() {
        assert_eq!(
            welcome_answer_from_jni(true, 3, 4, Some("x")),
            WelcomeAnswer::Accepted
        );
        assert_eq!(
            welcome_answer_from_jni(false, 3, 4, Some("x")),
            WelcomeAnswer::Refused(RefusalMemo::TargetRefused { target: "x" })
        );
        assert_eq!(
            welcome_answer_from_jni(false, 3, 4, None),
            WelcomeAnswer::Refused(RefusalMemo::Stale {
                base_epoch: 3,
                server_epoch: 4
            })
        );
        for (base, server) in [(-1, 4), (3, -1), (-1, -1)] {
            assert_eq!(
                welcome_answer_from_jni(false, base, server, None),
                WelcomeAnswer::Refused(RefusalMemo::Nothing)
            );
        }
        assert_eq!(staged_base_from_jni(5), Ok(5));
        assert!(staged_base_from_jni(-1).is_err(), "never read as epoch 0");
    }

    fn stages_ledger(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
        match std::fs::read(dir.join(BACKGROUND_STAGES_FILE)) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
            Err(_) => serde_json::Map::new(),
        }
    }

    /// COMM-22 on the background path: the prepare exports the external-join base of the epoch its
    /// commit creates, so the route publishes it with the advance. Without it the published base
    /// stays one epoch behind and an external joiner is refused as stale.
    #[test]
    fn a_prepared_welcome_carries_the_base_of_the_epoch_it_creates() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("base", 48);
        let prepared = prepare(&dir, &state, 48, "base", &gid, &kp);
        assert_eq!(prepared["ok"], true, "prepared: {prepared}");
        let base = b64(&prepared, "groupInfo");

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

    /// A foreground write that lands between the build and the staging (a checkpoint, a key move's
    /// re-seal) refuses the staging, so the commit never reaches the server.
    #[test]
    fn a_welcome_is_not_staged_over_a_file_that_moved_while_it_was_built() {
        let _s = quiet_foreground();
        let (dir, state, _carol, kp, gid) = holder_and_newcomer("nostage", 55);
        std::fs::write(dir.join("mls.bin"), b"written by the foreground").unwrap();

        let prepared = prepare(&dir, &state, 55, "nostage", &gid, &kp);

        assert_eq!(prepared["reason"], "stage-failed");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            b"written by the foreground"
        );
    }

    /// The settlement of a stale refusal: the bytes the clear WROTE - the ones the next request is
    /// answered from - are not offered again, and any later write lifts it: a proof, not a clock.
    #[test]
    fn a_stale_refusal_is_not_answered_again_from_the_same_bytes() {
        let _s = quiet_foreground();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("ledger", 44);
        let dir = dir_holding("ledger", &stale);
        let first = prepare(&dir, &stale, 44, "ledger", &gid, &kp);
        assert_eq!(first["ok"], true);

        settle(
            &dir,
            44,
            "ledger",
            &gid,
            &first,
            WelcomeAnswer::Refused(RefusalMemo::Stale {
                base_epoch: 1,
                server_epoch: 2,
            }),
        );

        let cleared = std::fs::read(dir.join("mls.bin")).unwrap();
        assert!(welcome_request_known_stale(&dir, &cleared, &gid));
        let again = prepare(&dir, &cleared, 44, "ledger", &gid, &kp);
        assert_eq!(again["reason"], "stale-epoch-known");
        assert!(
            !welcome_request_known_stale(&dir, b"any other mls.bin", &gid),
            "new bytes are answered again"
        );
        assert!(
            !welcome_request_known_stale(&dir, &cleared, "another-group"),
            "and only this group is known stale"
        );
    }

    /// A phone AHEAD of a lagging server counter is not stale: the counter can reach its base, and
    /// a later answer from the same bytes may then be valid. Only `server > base` is recorded.
    #[test]
    fn a_refusal_from_a_base_ahead_of_the_server_records_nothing() {
        let _s = quiet_foreground();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("ahead", 49);
        let dir = dir_holding("ahead", &stale);
        for (base_epoch, server_epoch) in [(3, 2), (2, 2)] {
            let loaded = std::fs::read(dir.join("mls.bin")).unwrap();
            let prepared = prepare(&dir, &loaded, 49, "ahead", &gid, &kp);
            assert_eq!(prepared["ok"], true, "{prepared}");
            let settled = settle(
                &dir,
                49,
                "ahead",
                &gid,
                &prepared,
                WelcomeAnswer::Refused(RefusalMemo::Stale {
                    base_epoch,
                    server_epoch,
                }),
            );
            assert_eq!(settled["settled"], "cleared");
            let cleared = std::fs::read(dir.join("mls.bin")).unwrap();
            assert!(
                !welcome_request_known_stale(&dir, &cleared, &gid),
                "base {base_epoch}, server {server_epoch} is not stale"
            );
        }
    }

    /// A refusal that says nothing about the next request records nothing.
    #[test]
    fn a_racing_or_membership_refusal_records_nothing() {
        let _s = quiet_foreground();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("race", 45);
        let dir = dir_holding("race", &stale);
        let first = prepare(&dir, &stale, 45, "race", &gid, &kp);
        assert_eq!(first["ok"], true);

        let settled = settle(
            &dir,
            45,
            "race",
            &gid,
            &first,
            WelcomeAnswer::Refused(RefusalMemo::Nothing),
        );

        assert_eq!(settled["settled"], "cleared");
        let cleared = std::fs::read(dir.join("mls.bin")).unwrap();
        assert!(!welcome_request_known_stale(&dir, &cleared, &gid));
        assert!(on_disk(&dir, "race", 45)
            .groups_with_pending_commit()
            .is_empty());
    }

    /// A refused TARGET (`welcome_target_unknown` / `welcome_target_not_member`) is remembered like a
    /// stale base, against the bytes the clear wrote: a holder does not commit and get refused again
    /// on each of the newcomer's asks. Keyed to that target alone - another newcomer of the same
    /// group is still answered - and lifted by any write to `mls.bin`.
    #[test]
    fn a_refused_target_is_not_answered_again_from_the_same_bytes() {
        let _s = quiet_foreground();
        let (stale, _bob, _moved, kp, gid) = shut_phone_behind_its_group("target", 51);
        let dir = dir_holding("target", &stale);
        let first = prepare(&dir, &stale, 51, "target", &gid, &kp);
        assert_eq!(first["ok"], true);

        settle(
            &dir,
            51,
            "target",
            &gid,
            &first,
            WelcomeAnswer::Refused(RefusalMemo::TargetRefused {
                target: "carol:phone-c",
            }),
        );

        let cleared = std::fs::read(dir.join("mls.bin")).unwrap();
        assert_eq!(
            welcome_request_known_refused(&dir, &cleared, &gid, "carol:phone-c"),
            Some("target-refused-known")
        );
        assert_eq!(
            welcome_request_known_refused(&dir, &cleared, &gid, "dave:phone-d"),
            None,
            "another target of the same group is still answered"
        );
        assert_eq!(
            welcome_request_known_refused(&dir, b"any other mls.bin", &gid, "carol:phone-c"),
            None,
            "new bytes are answered again"
        );
        assert!(
            !welcome_request_known_stale(&dir, &cleared, &gid),
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
        let out = prepare(&dir, &stale, 46, "fg", &gid, &kp);
        crate::concurrency::mark_foreground_inactive();
        assert_eq!(out["reason"], "foreground-active");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), stale);
    }

    /// A newcomer already in the tree is a typed refusal, never an `add-failed` read from prose.
    #[test]
    fn a_newcomer_already_in_the_tree_is_refused_by_its_type() {
        let _s = quiet_foreground();
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
            &WelcomeRequest {
                group_id: &gid,
                requester: "member-bob:dev-b",
                key_package_b64: &kp,
            },
        );
        assert_eq!(out["reason"], "already-member", "{out}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
    }

    /// The delivery service chooses the KeyPackage the background answer is built from: one whose
    /// credential names another device than the requester is refused, typed, and nothing is staged.
    #[test]
    fn a_substituted_key_package_is_refused_on_the_background_path() {
        let _s = quiet_foreground();
        let (alice, _bob, gid) = joined_pair("subst");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(52)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("subst", &state);
        let mallory = MlsManager::load_or_create("subst-mallory", "dev-m", None).unwrap();
        let kp = STANDARD.encode(mallory.generate_key_package().unwrap());
        let out = prepare(&dir, &state, 52, "subst", &gid, &kp);
        assert_eq!(out["ok"], false, "{out}");
        assert_eq!(out["reason"], "identity-mismatch", "{out}");
        assert_eq!(
            std::fs::read(dir.join("mls.bin")).unwrap(),
            state,
            "nothing is staged"
        );
    }

    /// A NEW PERSON IS NOT ADDED FROM A PUSH. The roster row, the relayed request and the KeyPackage
    /// are the delivery service's word; a requester whose user holds no leaf in this phone's tree is
    /// refused as `newcomer`, and nothing is staged or written - a member's own gesture admits them.
    #[test]
    fn a_new_person_is_not_added_from_a_push() {
        let _s = quiet_foreground();
        let (alice, _bob, gid) = joined_pair("stranger");
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(57)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("stranger", &state);
        let carol = MlsManager::load_or_create("stranger-carol", "dev-c", None).unwrap();
        let kp = STANDARD.encode(carol.generate_key_package().unwrap());
        let out = prepare_welcome_background_with_key(
            &dir,
            &state,
            &key_b64(57),
            "stranger-alice",
            "dev-a",
            &WelcomeRequest {
                group_id: &gid,
                requester: "stranger-carol:dev-c",
                key_package_b64: &kp,
            },
        );
        assert_eq!(out["ok"], false, "{out}");
        assert_eq!(out["reason"], "newcomer", "{out}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
    }

    /// A package naming a device this phone pinned, under ANOTHER signature key, is refused: nothing
    /// proves the change, so the background answer does not re-add it.
    #[test]
    fn a_key_package_under_an_unpinned_key_is_refused_on_the_background_path() {
        let _s = quiet_foreground();
        let (mut alice, bob, gid) = joined_pair("rekey");
        // bob keeps another device, so he is still a member and the request is a member's device -
        // the one case a background Add answers (`newcomer` otherwise) - and the KEY is what refuses.
        let bob_phone = MlsManager::load_or_create("rekey-bob", "dev-b9", None).unwrap();
        alice
            .add_member(&gid, &bob_phone.generate_key_package().unwrap())
            .expect("add bob's phone");
        alice.merge_pending_commit_for(&gid).expect("merge add");
        // bob's dev-b leaves, so the request is a re-add and not an `already-member`.
        alice
            .remove_members_for_devices(&gid, &["rekey-bob:dev-b"])
            .expect("remove bob");
        alice.merge_pending_commit_for(&gid).expect("merge remove");
        drop(bob);
        let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64(53)).unwrap();
        let state = alice.save_encrypted_with_key(&key).unwrap();
        let dir = dir_holding("rekey", &state);
        let impostor = MlsManager::load_or_create("rekey-bob", "dev-b", None).unwrap();
        let kp = STANDARD.encode(impostor.generate_key_package().unwrap());
        let out = prepare_welcome_background_with_key(
            &dir,
            &state,
            &key_b64(53),
            "rekey-alice",
            "dev-a",
            &WelcomeRequest {
                group_id: &gid,
                requester: "rekey-bob:dev-b",
                key_package_b64: &kp,
            },
        );
        assert_eq!(out["reason"], "signature-key-changed", "{out}");
        assert_eq!(std::fs::read(dir.join("mls.bin")).unwrap(), state);
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
            &dir_holding(tag, &alice_state),
            &alice_state,
            &key_b64(23),
            &format!("{tag}-alice"),
            "dev-a",
            &[entry("m-1", &group_id, &frame)],
            100,
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
    /// notification, and the event reaches `mls.bin` - where the app takes it for the in-app alert -
    /// ONLY once the accepted Add is merged: a cleared Add leaves no event for anyone to announce.
    #[test]
    fn a_background_add_of_an_own_device_reaches_the_app_only_once_accepted() {
        let _s = crate::concurrency::test_support::serialise();
        crate::concurrency::mark_foreground_inactive();
        let tag = "own-welcome";
        let (alice, _bob, gid) = joined_pair(tag);
        let key = decode_base64_to_32_bytes(&key_b64(29)).expect("key");
        let state = alice.save_encrypted_with_key(&key).expect("encrypt alice");
        let laptop = MlsManager::load_or_create(&format!("{tag}-alice"), "dev-laptop", None)
            .expect("laptop");
        let kp = STANDARD.encode(laptop.generate_key_package().expect("kp"));
        let requester = format!("{tag}-alice:dev-laptop");
        let prepare = |dir: &Path| {
            prepare_welcome_background_with_key(
                dir,
                &state,
                &key_b64(29),
                &format!("{tag}-alice"),
                "dev-a",
                &WelcomeRequest {
                    group_id: &gid,
                    requester: &requester,
                    key_package_b64: &kp,
                },
            )
        };
        let owner_events = |dir: &Path| {
            let saved = std::fs::read(dir.join("mls.bin")).expect("mls.bin");
            let mut reloaded =
                MlsManager::load_with_key(&format!("{tag}-alice"), "dev-a", Some(saved), &key)
                    .expect("reload");
            reloaded
                .take_device_events()
                .into_iter()
                .filter(|e| e.is_owner_alert(&format!("{tag}-alice"), "dev-a"))
                .count()
        };

        // Refused by the server: cleared, and nothing for the app to announce.
        let refused_dir = dir_holding(&format!("{tag}-refused"), &state);
        let out = prepare(&refused_dir);
        assert_eq!(
            out["ownDeviceAdded"].as_array().map(Vec::len),
            Some(1),
            "{out}"
        );
        assert_eq!(
            settle(
                &refused_dir,
                29,
                tag,
                &gid,
                &out,
                WelcomeAnswer::Refused(RefusalMemo::Nothing)
            )["settled"],
            "cleared"
        );
        assert_eq!(
            owner_events(&refused_dir),
            0,
            "a cleared Add announces nothing"
        );

        // Accepted: merged, and the event is the app's.
        let accepted_dir = dir_holding(&format!("{tag}-accepted"), &state);
        let out = prepare(&accepted_dir);
        let keys = out["ownDeviceAdded"]
            .as_array()
            .expect("named for the notice");
        assert_eq!(keys.len(), 1, "{out}");
        assert!(keys[0]
            .as_str()
            .unwrap()
            .starts_with(&format!("{requester}|")));
        assert_eq!(
            settle(&accepted_dir, 29, tag, &gid, &out, WelcomeAnswer::Accepted)["settled"],
            "merged"
        );
        assert_eq!(owner_events(&accepted_dir), 1, "the merged Add's event");
    }
}
