//! Operations MLS en arriere-plan partagees Android (JNI) et iOS (FFI C).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use mls_core::MlsManager;

use super::proto_fields::extract_full_message_info;

/// Dechiffre un message MLS recu en push background et retourne les metadonnees JSON.
pub fn decrypt_push_message(
    state_bytes: &[u8],
    pin: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    ciphertext: &[u8],
) -> Option<serde_json::Value> {
    let mut manager =
        MlsManager::load_encrypted(user_id, device_id, Some(state_bytes.to_vec()), pin).ok()?;

    let plaintext = match manager.process_incoming_message(group_id, ciphertext) {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::warn!("[PushBG] process_incoming_message: Ok(None) - message de controle MLS");
            return None;
        }
        Err(e) => {
            log::error!("[PushBG] process_incoming_message: Err({e}) - group={group_id}");
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

/// Cree un Welcome MLS pour un nouveau device (background, app tuee).
pub fn create_welcome_background(
    files_dir: &Path,
    state_bytes: &[u8],
    pin: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    key_package_b64: &str,
) -> Result<serde_json::Value, String> {
    let kp_bytes = STANDARD
        .decode(key_package_b64.trim())
        .map_err(|e| format!("base64 decode key_package: {e}"))?;

    let mut manager =
        MlsManager::load_encrypted(user_id, device_id, Some(state_bytes.to_vec()), pin)
            .map_err(|e| e.to_string())?;

    let base_epoch = manager.get_epoch(group_id).map_err(|e| e.to_string())?;

    log::debug!(
        "[BG_WELCOME] add_member group={group_id} kp_len={} base_epoch={base_epoch}",
        kp_bytes.len()
    );
    let (commit, welcome_opt, ratchet_tree_opt) = manager
        .add_member(group_id, &kp_bytes)
        .map_err(|e| e.to_string())?;

    let welcome = welcome_opt.ok_or_else(|| "add_member returned no welcome bytes".to_string())?;

    let enc = manager.save_encrypted(pin).map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    crate::background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_WELCOME] mls.bin mis a jour ({} octets) pour group={group_id}",
        enc.len()
    );

    Ok(serde_json::json!({
        "ok": true,
        "welcome": STANDARD.encode(&welcome),
        "ratchetTree": ratchet_tree_opt.as_deref().map(|rt| STANDARD.encode(rt)),
        "commit": STANDARD.encode(&commit),
        "baseEpoch": base_epoch,
    }))
}

/// Applique un Welcome MLS recu en arriere-plan (cote receveur).
pub fn process_welcome_background(
    files_dir: &Path,
    state_bytes: &[u8],
    pin: &str,
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

    let mut manager =
        MlsManager::load_encrypted(user_id, device_id, Some(state_bytes.to_vec()), pin)
            .map_err(|e| e.to_string())?;

    let group_id = manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| format!("process_welcome: {e:?}"))?;

    let enc = manager.save_encrypted(pin).map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    crate::background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
    log::info!(
        "[BG_JOIN] groupe rejoint via Welcome: {group_id} (mls.bin {} octets)",
        enc.len()
    );
    Ok(())
}

/// Chiffre un message sortant en attente et persiste `mls.bin`.
pub fn send_message_background(
    files_dir: &Path,
    state_bytes: &[u8],
    pin: &str,
    user_id: &str,
    device_id: &str,
    group_id: &str,
    proto_b64: &str,
) -> Result<serde_json::Value, String> {
    let proto_bytes = STANDARD
        .decode(proto_b64.trim())
        .map_err(|e| format!("base64 decode proto: {e}"))?;

    let mut manager =
        MlsManager::load_encrypted(user_id, device_id, Some(state_bytes.to_vec()), pin)
            .map_err(|e| e.to_string())?;

    let ciphertext = manager
        .send_message(group_id, &proto_bytes)
        .map_err(|e| format!("send_message: {e:?}"))?;

    let enc = manager.save_encrypted(pin).map_err(|e| e.to_string())?;
    let mls_path = files_dir.join("mls.bin");
    crate::background_write_mls_bin(&mls_path, &enc).map_err(|e| format!("write mls.bin: {e}"))?;
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
