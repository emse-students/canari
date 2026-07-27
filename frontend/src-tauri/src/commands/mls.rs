//! MLS Tauri commands: initialisation, groups, encryption, decryption.

use crate::concurrency::write_mls_state_blob;
use crate::keystore_bridge::PluginDeviceKeyStore;
use crate::state::{
    decrypt_messages_batch, AppState, BatchDecryptItem, KeyPackageBatchResult, PendingDb,
};
use mls_core::{DecryptErrorKind, DeviceKeyStore, MlsManager};

#[tauri::command]
pub(crate) async fn initialiser_mls(
    app: tauri::AppHandle,
    user_id: String,
    device_id: String,
    device_key_b64: String,
    encrypted_state: Option<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let manager_state = state.mls_manager.clone();
    let keystore = PluginDeviceKeyStore::new(app);

    // Empty device_key_b64 → biometric mode: the keystore holds the device key directly.
    // load_encrypted_with_keystore will use Path A (retrieve_device_key) which
    // triggers a single BiometricPrompt on Android/iOS.
    let key_b64_opt = if device_key_b64.is_empty() {
        None
    } else {
        Some(device_key_b64)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let manager = MlsManager::load_encrypted_with_keystore(
            &user_id,
            &device_id,
            encrypted_state,
            key_b64_opt,
            &keystore,
        )
        .map_err(|e| e.to_string())?;

        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        *lock = Some(manager);
        Ok::<String, String>("MLS Initialized".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn sauvegarder_mls(
    device_key_b64: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let key = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"))?;
        let encrypted = manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn sauvegarder_mls_et_persister(
    device_key_b64: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let key = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"))?;
        let encrypted = manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted)?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn creer_groupe(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager.create_group(group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn generer_key_package(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let fallback = manager.generate_key_package().map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(fallback)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn generer_key_packages(
    count: usize,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Vec<u8>>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let generated = manager
            .generate_key_packages(count)
            .map_err(|e| e.to_string())?;
        Ok::<Vec<Vec<u8>>, String>(generated)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn key_package_a_clef_privee(
    key_package_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let has_private = manager
            .key_package_has_private(&key_package_bytes)
            .map_err(|e| e.to_string())?;
        Ok::<bool, String>(has_private)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn generer_key_packages_et_persister(
    device_key_b64: String,
    count: usize,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<KeyPackageBatchResult, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;

        log::debug!(
            "generer_key_packages_et_persister start count={} (batch native path)",
            count
        );
        let fallback = manager.generate_key_package().map_err(|e| e.to_string())?;
        let pool_packages = if count > 0 {
            manager
                .generate_key_packages(count)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let key = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"))?;
        let encrypted_state = manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted_state)?;
        log::debug!(
            "generer_key_packages_et_persister done count={} state_bytes={}",
            count,
            encrypted_state.len()
        );

        Ok::<KeyPackageBatchResult, String>(KeyPackageBatchResult {
            fallback,
            pool_packages,
            state: encrypted_state,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn oublier_groupe(
    group_id: String,
    // u64: same width as the source epoch (Tauri serializes it as a JSON number on the JS side). [[S4]]
    min_epoch: u64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.forget_group(&group_id, min_epoch);
    Ok(())
}

/// Permanent purge of a group (poison pill): memory + OpenMLS storage + epoch lock at MAX.
/// No Welcome will ever be accepted for this groupId after this call.
#[tauri::command]
pub(crate) fn supprimer_groupe(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.drop_group(&group_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn lister_groupes(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.get_known_groups())
}

#[tauri::command]
pub(crate) fn obtenir_epoch(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<u64, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    // u64: no truncation; Tauri serializes it as a JSON number (exact <= 2^53, never reached). [[S4]]
    manager.get_epoch(&group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn ajouter_membres_bulk(
    group_id: String,
    key_packages_bytes: Vec<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<mls_core::AddMembersBulkResult, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    // Stage-only (C7-A): the commit is NOT merged here. The caller validates it server-side then
    // calls confirmer_commit (accepted) / annuler_commit (rejected), and reads the post-merge
    // ratchet tree via exporter_ratchet_tree.
    let refs: Vec<&[u8]> = key_packages_bytes.iter().map(|v| v.as_slice()).collect();
    manager
        .add_members_bulk(&group_id, &refs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn trailer_welcome(
    welcome_bytes: Vec<u8>,
    ratchet_tree_bytes: Option<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| {
            log::error!(
                "[WELCOME] Erreur critique lors du traitement du Welcome MLS: {:?}",
                e
            );
            e.to_string()
        })
}

#[tauri::command]
pub(crate) fn envoyer_message(
    group_id: String,
    message: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .send_message(&group_id, message.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn envoyer_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .send_message(&group_id, &message_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn recevoir_message(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let res = manager
        .process_incoming_message(&group_id, &message_bytes)
        .map_err(|e| {
            log::error!("recevoir_message failed: group={} err={}", group_id, e);
            e.to_string()
        })?;

    match res {
        Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
pub(crate) fn retirer_membres(
    group_id: String,
    user_ids: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = user_ids.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_users(&group_id, &id_slices)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn retirer_membres_par_appareil(
    group_id: String,
    device_identities: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = device_identities.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_devices(&group_id, &id_slices)
        .map_err(|e| e.to_string())
}

/// Confirms (merges) a *staged* commit (ADD or REMOVE) AFTER the server accepts it
/// (`validateCommit`). Advances the local epoch. Counterpart of `annuler_commit`. [[C7]] Option A:
/// validate-then-merge, never a local fork on rejection (unified ADD+REMOVE regime).
///
/// Does NOT persist: the caller chains `persistMlsStateAfterMutation` (which holds the device key,
/// retrieved from the session-level keystore) as for any other mutation - same merge->persist
/// window as before.
#[tauri::command]
pub(crate) fn confirmer_commit(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .merge_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Clears a *staged* commit (ADD or REMOVE) when the server REJECTS it. The local epoch stays
/// unchanged (no fork). No persistence: `mls.bin` is already at the pre-stage state. [[C7]]
#[tauri::command]
pub(crate) fn annuler_commit(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .clear_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exports the group's ratchet tree from the CURRENT state (post-merge) for the Welcome. For an
/// ADD, call it AFTER `confirmer_commit` (the new member joins at epoch N+1). [[C7]]
#[tauri::command]
pub(crate) fn exporter_ratchet_tree(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_ratchet_tree_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exports a self-contained GroupInfo (tree included) for `group_id`, to be stored server-side and
/// served to authorized members joining via an external commit (`rejoindre_par_commit_externe`).
#[tauri::command]
pub(crate) fn exporter_group_info(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_group_info(&group_id)
        .map_err(|e| e.to_string())
}

/// Joins a group via an external commit built from a served GroupInfo. The returned group is at
/// epoch N+1 with the commit *staged*: the caller submits the commit for epoch validation
/// server-side (against the GroupInfo's base epoch), then `confirmer_commit` if accepted, or
/// `oublier_groupe` + retry with a fresher GroupInfo if rejected (an external commit cannot be
/// rolled back). Returns (group_id, commit).
#[tauri::command]
pub(crate) fn rejoindre_par_commit_externe(
    group_info_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(String, Vec<u8>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .join_by_external_commit(&group_info_bytes)
        .map_err(|e| e.to_string())
}

/// Dechiffre un message MLS entrant.
/// If decryption fails with "Process error:" (Sender Ratchet gap: the received generation is
/// higher than the expected one), the message is stored in SQLite via PendingDb and the command
/// returns Err("GAP_QUEUED:<group_id>") so the frontend knows it must fetch the missing messages.
#[tauri::command]
pub(crate) async fn recevoir_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
) -> Result<Option<Vec<u8>>, String> {
    // Chantier 1 : detection proactive de l'epoch gap AVANT tout dechiffrement.
    // The epoch is cleartext in the MLS header -> no ratchet key consumed.
    // The MutexGuard is released in the inner block BEFORE any .await.
    let epoch_gap: Option<(u64, u64)> = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        match lock.as_ref() {
            Some(manager) => {
                let group_epoch = manager.get_epoch(&group_id).ok();
                match (MlsManager::parse_message_epoch(&message_bytes), group_epoch) {
                    (Some(msg_ep), Some(group_ep)) if msg_ep > group_ep => Some((msg_ep, group_ep)),
                    _ => None,
                }
            }
            None => None,
        }
        // lock is released here - no await has happened yet
    };
    if let Some((msg_ep, group_ep)) = epoch_gap {
        log::warn!(
            "[GAP] Epoch gap detecte AVANT dechiffrement : \
             msg_epoch={} > group_epoch={} pour group={}. \
             Mise en attente et declenchement de la resync.",
            msg_ep,
            group_ep,
            group_id
        );
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        let id = format!("{}-epoch-{}", group_id, ts);
        let insert_result = sqlx::query(
            "INSERT OR IGNORE INTO pending_mls_messages \
             (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
        )
        .bind(&id)
        .bind(&group_id)
        .bind(message_bytes.as_slice())
        .bind(ts)
        .execute(&*pending_db.0)
        .await;
        match insert_result {
            Ok(_) => (),
            Err(db_e) => {
                log::error!("[GAP] DB insert (epoch pre-check) failed: {}", db_e);
                return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
            }
        }
        return Err(format!(
            "GAP_QUEUED:{}:msg_epoch={}:group_epoch={}",
            group_id, msg_ep, group_ep
        ));
    }

    // Acquire + release the Mutex BEFORE any async operation, to avoid deadlocks with
    // std::sync::Mutex (non-Send across await points).
    let result = {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        manager.process_incoming_message(&group_id, &message_bytes)
    };

    match result {
        Ok(val) => Ok(val),
        Err(e) => {
            let err_str = e.to_string();
            log::error!(
                "recevoir_message_bytes failed: group={} err={}",
                group_id,
                err_str
            );

            // Classification centralisee cote mls-core (source unique du string-matching). [[S5]]
            match e.decrypt_kind() {
                // Corruption detected by mls-core -> unrecoverable state, trigger a re-bootstrap.
                DecryptErrorKind::Unrecoverable => Err(format!("UNRECOVERABLE:{}", group_id)),

                // SecretReuseError = this message's ratchet key was already consumed (duplicate:
                // realtime delivery + queue, or a requeue after restart). Unlike a FUTURE
                // generation gap, it will NEVER decrypt: queueing it in SQLite would loop forever.
                // Treated as a benign duplicate - Ok(None) -> the frontend ACKs and drops it
                // (parity with the web WASM path).
                DecryptErrorKind::SecretReuse => {
                    log::debug!(
                        "[DUP] SecretReuseError group={} - already-consumed duplicate, silent ACK",
                        group_id
                    );
                    Ok(None)
                }

                // "Process error:" = OpenMLS error on the same epoch -> likely a Sender Ratchet gap
                // (future generation received) -> queued in SQLite for retry.
                DecryptErrorKind::SenderRatchetGap => {
                    log::warn!(
                        "[GAP] Sender Ratchet gap for group={} - message queued in SQLite",
                        group_id
                    );
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as i64;
                    let id = format!("{}-gen-{}", group_id, ts);
                    let insert_result = sqlx::query(
                        "INSERT OR IGNORE INTO pending_mls_messages \
                         (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
                    )
                    .bind(&id)
                    .bind(&group_id)
                    .bind(message_bytes.as_slice())
                    .bind(ts)
                    .execute(&*pending_db.0)
                    .await;
                    if let Err(db_e) = insert_result {
                        log::error!("[GAP] DB store failed: {}", db_e);
                        return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
                    }
                    // Embed the original OpenMLS error so the frontend can log it.
                    Err(format!("GAP_QUEUED:{}:{}", group_id, err_str))
                }

                DecryptErrorKind::Other => Err(err_str),
            }
        }
    }
}

/// Decrypts a page of MLS ciphertexts in one IPC crossing (ratchet order preserved).
#[tauri::command]
pub(crate) async fn recevoir_messages_batch(
    group_id: String,
    messages: Vec<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BatchDecryptItem>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_mut()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        log::debug!(
            "recevoir_messages_batch group={} count={}",
            group_id,
            messages.len()
        );
        Ok::<Vec<BatchDecryptItem>, String>(decrypt_messages_batch(manager, &group_id, &messages))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn exporter_secret(
    group_id: String,
    label: String,
    context: Option<Vec<u8>>,
    key_len: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager
        .export_secret(
            &group_id,
            &label,
            context.as_deref().unwrap_or(&[]),
            key_len,
        )
        .map_err(|e| e.to_string())
}

/// Stores the new deviceKeyB64 straight into the keystore after a PIN change.
/// The derivation (PBKDF2-SHA256, see `$lib/crypto/deviceKey.ts`) already happened on the frontend.
///
/// Decodes the base64 into 32 bytes and stores them under the alias
/// `mls_device_key_{user_id}_{device_id}`. Best-effort: if the keystore is unavailable the error is
/// logged but the command still succeeds (the next PIN login re-derives the key automatically).
#[tauri::command]
pub(crate) async fn actualiser_cle_keystore_avec_devicekey(
    device_key_b64: String,
    user_id: String,
    device_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let alias = format!("mls_device_key_{user_id}_{device_id}");
    let keystore = PluginDeviceKeyStore::new(app);

    let key_bytes = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
        .map_err(|e| format!("invalid device_key_b64: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        keystore.store_device_key(&key_bytes, &alias).map_err(|e| {
            log::warn!("[DEVICEKEY_CHANGE] Failed to refresh keystore key: {e}");
            // Non-fatal: the next login will re-derive and store the key.
            e
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
