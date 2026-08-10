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
/// already holds (mirrored to `channel_keys.json` by the foreground). The push carries the inline
/// ciphertext (`ciphertext||tag`) and 12-byte nonce; the raw 32-byte epoch key is looked up natively
/// so the plaintext never transits Google/FCM. The decrypted bytes are the same encoded AppMessage
/// proto as MLS, so `extract_full_message_info` parses them identically.
pub fn decrypt_channel_message(
    raw_key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
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

    let info = extract_full_message_info(&plaintext);
    if info["ok"].as_bool().unwrap_or(false) {
        Some(info)
    } else {
        None
    }
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

    Ok(serde_json::json!({
        "ok": true,
        "welcome": STANDARD.encode(&welcome),
        "ratchetTree": STANDARD.encode(&ratchet_tree),
        "commit": STANDARD.encode(&commit),
        "baseEpoch": base_epoch,
    }))
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
    group_id: &str,
    ciphertext: &[u8],
) -> Option<serde_json::Value> {
    let (mut manager, _key) = load_manager_for_push(state_bytes, key_b64, user_id, device_id)?;

    let plaintext = match manager.process_incoming_message(group_id, ciphertext) {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::warn!("[PushBG] key-based: process_incoming_message Ok(None) - control message");
            return None;
        }
        Err(e) => {
            log::error!("[PushBG] key-based: process_incoming_message Err({e})");
            return None;
        }
    };

    let info = extract_full_message_info(&plaintext);
    if info["ok"].as_bool().unwrap_or(false) {
        Some(info)
    } else {
        None
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

/// Decrypts an MLS push payload after applying `commits` in memory, read-only.
///
/// `commits` are ordered by ascending base epoch. They are applied to the loaded manager only
/// to reach the sender's epoch; the result is never written back, so the foreground stays the
/// single writer of `mls.bin`.
pub fn decrypt_push_message_with_commits_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    commits: &[Vec<u8>],
    ciphertext: &[u8],
) -> Option<serde_json::Value> {
    let (mut manager, _key) = load_manager_for_push(state_bytes, key_b64, user_id, device_id)?;

    for commit in commits {
        match manager.process_incoming_message(group_id, commit) {
            Ok(_) => {}
            Err(e) => {
                log::warn!("[PushBG] key-based catch-up: commit apply failed, stopping - {e}");
                break;
            }
        }
    }

    let plaintext = match manager.process_incoming_message(group_id, ciphertext) {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::warn!("[PushBG] key-based catch-up decrypt: Ok(None)");
            return None;
        }
        Err(e) => {
            log::error!("[PushBG] key-based catch-up decrypt failed: {e}");
            return None;
        }
    };

    let info = extract_full_message_info(&plaintext);
    if info["ok"].as_bool().unwrap_or(false) {
        Some(info)
    } else {
        None
    }
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
}
