//! Operations MLS en arriere-plan partagees Android (JNI) et iOS (FFI C).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use mls_core::MlsManager;

use super::proto_fields::extract_full_message_info;
use crate::concurrency::background_write_mls_bin;

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

/// Cree un Welcome MLS pour un nouveau device (background, app tuee).
/// Variante basee sur clef : utilise la clef device pre-derivee (base64) au lieu du PIN.
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

    let key_bytes = STANDARD
        .decode(key_b64.trim())
        .map_err(|e| format!("base64 decode device key: {e}"))?;
    if key_bytes.len() != 32 {
        return Err(format!(
            "invalid device key length: {} (want 32)",
            key_bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    let mut manager =
        MlsManager::load_with_key(user_id, device_id, Some(state_bytes.to_vec()), &key)
            .map_err(|e| e.to_string())?;

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
        "[BG_WELCOME] mls.bin mis a jour ({} octets) pour group={group_id}",
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

/// Applique un Welcome MLS recu en arriere-plan (cote receveur).
/// Variante basee sur clef : utilise la clef device pre-derivee (base64) au lieu du PIN.
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

    let key_bytes = STANDARD
        .decode(key_b64.trim())
        .map_err(|e| format!("base64 decode device key: {e}"))?;
    if key_bytes.len() != 32 {
        return Err(format!(
            "invalid device key length: {} (want 32)",
            key_bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    let mut manager =
        MlsManager::load_with_key(user_id, device_id, Some(state_bytes.to_vec()), &key)
            .map_err(|e| e.to_string())?;

    let group_id = manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| format!("process_welcome: {e:?}"))?;

    let enc = manager
        .save_encrypted_with_key(&key)
        .map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_JOIN] groupe rejoint via Welcome: {group_id} (mls.bin {} octets)",
        enc.len()
    );
    Ok(())
}

/// Chiffre un message sortant en attente et persiste `mls.bin`.
/// Variante basee sur clef : utilise la clef device pre-derivee (base64) au lieu du PIN.
pub fn send_message_background_with_key(
    files_dir: &Path,
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    proto_b64: &str,
) -> Result<serde_json::Value, String> {
    let proto_bytes = STANDARD
        .decode(proto_b64.trim())
        .map_err(|e| format!("base64 decode proto: {e}"))?;

    let key_bytes = STANDARD
        .decode(key_b64.trim())
        .map_err(|e| format!("base64 decode device key: {e}"))?;
    if key_bytes.len() != 32 {
        return Err(format!(
            "invalid device key length: {} (want 32)",
            key_bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    let mut manager =
        MlsManager::load_with_key(user_id, device_id, Some(state_bytes.to_vec()), &key)
            .map_err(|e| e.to_string())?;

    let ciphertext = manager
        .send_message(group_id, &proto_bytes)
        .map_err(|e| format!("send_message: {e:?}"))?;

    let enc = manager
        .save_encrypted_with_key(&key)
        .map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_SEND] message chiffre group={group_id} (ciphertext {} octets, mls.bin {} octets)",
        ciphertext.len(),
        enc.len()
    );

    Ok(serde_json::json!({
        "ok": true,
        "ciphertext": STANDARD.encode(&ciphertext),
    }))
}

/// Nettoie `mls_pending.db` (messages exhausted / perimes). Miroir `MlsBackgroundWorker`.
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

// ─── Key-based variants (biometric mode, no PIN) ───────────────────────────

/// Key-based variant of [`decrypt_push_message`]: uses the pre-derived 32-byte
/// key (base64) from push_context.json instead of the PIN.
pub fn decrypt_push_message_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    ciphertext: &[u8],
) -> Option<serde_json::Value> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let key_bytes = STANDARD.decode(key_b64.trim()).ok()?;
    if key_bytes.len() != 32 {
        log::error!(
            "[PushBG] decrypt_with_key: invalid key length {}",
            key_bytes.len()
        );
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    // We can't use load_encrypted because it derives key from PIN. Use load_with_key.
    // Actually load_encrypted internally calls load_with_key. Let me check...

    // load_encrypted calls security::derive_key_from_pin(pin, salt) then decrypt_blob.
    // We have the raw key already. We need load_with_key which is `fn load_with_key(...)`.
    // But load_with_key is private (pub(crate) in mls-core).
    // Let me make it accessible...

    // For now, derive key from empty PIN (which will fail) and fall back.
    // Actually, the simplest approach: decrypt the blob ourselves and call load_or_create.
    decrypt_with_raw_key(state_bytes, &key, user_id, device_id, group_id, ciphertext)
}

/// Internal: manually decrypt the blob with the raw key, then use load_or_create.
fn decrypt_with_raw_key(
    state_bytes: &[u8],
    key: &[u8; 32],
    user_id: &str,
    device_id: &str,
    group_id: &str,
    ciphertext: &[u8],
) -> Option<serde_json::Value> {
    if state_bytes.len() < 16 {
        return None;
    }
    let (_salt, rest) = state_bytes.split_at(16);
    let plain = mls_core::security::decrypt_blob(key, rest).ok()?;
    let mut manager = mls_core::MlsManager::load_or_create(user_id, device_id, Some(plain)).ok()?;

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

    let info = super::proto_fields::extract_full_message_info(&plaintext);
    if info["ok"].as_bool().unwrap_or(false) {
        Some(info)
    } else {
        None
    }
}

/// Key-based variant of [`background_group_epoch`].
pub fn background_group_epoch_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
) -> Option<u64> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let key_bytes = STANDARD.decode(key_b64.trim()).ok()?;
    if key_bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    if state_bytes.len() < 16 {
        return None;
    }
    let (_salt, rest) = state_bytes.split_at(16);
    let plain = mls_core::security::decrypt_blob(&key, rest).ok()?;
    let manager = mls_core::MlsManager::load_or_create(user_id, device_id, Some(plain)).ok()?;
    manager.get_epoch(group_id).ok()
}

/// Key-based variant of [`decrypt_push_message_with_commits`].
pub fn decrypt_push_message_with_commits_with_key(
    state_bytes: &[u8],
    key_b64: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    commits: &[Vec<u8>],
    ciphertext: &[u8],
) -> Option<serde_json::Value> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let key_bytes = STANDARD.decode(key_b64.trim()).ok()?;
    if key_bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);

    if state_bytes.len() < 16 {
        return None;
    }
    let (_salt, rest) = state_bytes.split_at(16);
    let plain = mls_core::security::decrypt_blob(&key, rest).ok()?;
    let mut manager = mls_core::MlsManager::load_or_create(user_id, device_id, Some(plain)).ok()?;

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

    let info = super::proto_fields::extract_full_message_info(&plaintext);
    if info["ok"].as_bool().unwrap_or(false) {
        Some(info)
    } else {
        None
    }
}
