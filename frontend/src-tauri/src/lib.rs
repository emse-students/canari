// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD, Engine as _};
use mls_core::MlsManager;
use std::sync::{Arc, Mutex};

use tauri::Manager;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};

// State wrapper
struct AppState {
    mls_manager: Arc<Mutex<Option<MlsManager>>>,
}

/// Pool SQLite dédié aux messages MLS en attente (gap du Sender Ratchet).
/// Séparé de tauri-plugin-sql (côté JS) pour rester accessible depuis les commandes Rust.
struct PendingDb(Arc<sqlx::SqlitePool>);

/// Client HTTP réutilisable (pool de connexions) pour le gap fetching côté Rust.
struct HttpClient(reqwest::Client);

#[derive(serde::Serialize)]
struct KeyPackageBatchResult {
    fallback: Vec<u8>,
    pool_packages: Vec<Vec<u8>>,
    state: Vec<u8>,
}

fn write_mls_state_blob(app: &tauri::AppHandle, data: &[u8]) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("mls.bin"), data).map_err(|e| e.to_string())
}

// --- COMMANDS ---

#[tauri::command]
async fn initialiser_mls(
    user_id: String,
    device_id: String,
    pin: String,
    encrypted_state: Option<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = MlsManager::load_encrypted(&user_id, &device_id, encrypted_state, &pin)
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
async fn sauvegarder_mls(
    pin: String,
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
        let encrypted = manager.save_encrypted(&pin).map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sauvegarder_mls_et_persister(
    pin: String,
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
        let encrypted = manager.save_encrypted(&pin).map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted)?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn creer_groupe(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager.create_group(group_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn generer_key_package(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
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
async fn generer_key_packages(
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
        let generated = manager.generate_key_packages(count).map_err(|e| e.to_string())?;
        Ok::<Vec<Vec<u8>>, String>(generated)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn generer_key_packages_et_persister(
    pin: String,
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
            manager.generate_key_packages(count).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let encrypted_state = manager.save_encrypted(&pin).map_err(|e| e.to_string())?;
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
fn oublier_groupe(
    group_id: String,
    min_epoch: u32,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.forget_group(&group_id, min_epoch as u64);
    Ok(())
}

/// Purge définitive d'un groupe (Poison Pill) : mémoire + stockage OpenMLS + verrou
/// d'epoch à MAX. Aucun Welcome ne sera jamais accepté pour ce groupId après cet appel.
#[tauri::command]
fn supprimer_groupe(
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
fn lister_groupes(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.get_known_groups())
}

#[tauri::command]
fn obtenir_epoch(group_id: String, state: tauri::State<AppState>) -> Result<u32, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    let epoch = manager.get_epoch(&group_id).map_err(|e| e.to_string())?;
    Ok(epoch as u32)
}

#[tauri::command]
fn ajouter_membre(
    group_id: String,
    key_package_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .add_member(&group_id, &key_package_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ajouter_membres_bulk(
    group_id: String,
    key_packages_bytes: Vec<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<(Vec<u8>, Option<Vec<u8>>, usize, Option<Vec<u8>>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let refs: Vec<&[u8]> = key_packages_bytes.iter().map(|v| v.as_slice()).collect();
    manager
        .add_members_bulk(&group_id, &refs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn trailer_welcome(
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
            log::error!("[WELCOME] Erreur critique lors du traitement du Welcome MLS: {:?}", e);
            e.to_string()
        })
}

#[tauri::command]
fn envoyer_message(
    group_id: String,
    message: String, // Assume string for simplicity
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
fn envoyer_message_bytes(
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
fn recevoir_message(
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
fn retirer_membres(
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
fn retirer_membres_par_appareil(
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

/// Déchiffre un message MLS entrant.
/// Si le déchiffrement échoue avec "Process error:" (gap du Sender Ratchet : la
/// génération reçue est supérieure à celle attendue), le message est stocké dans
/// SQLite via PendingDb et la commande retourne Err("GAP_QUEUED:<group_id>") pour
/// que le frontend sache qu'il doit aller chercher les messages manquants.
#[tauri::command]
async fn recevoir_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
) -> Result<Option<Vec<u8>>, String> {
    // Chantier 1 : détection proactive de l'epoch gap AVANT tout déchiffrement.
    // L'epoch est en clair dans l'en-tête MLS → aucune clé de ratchet consommée.
    // Le MutexGuard est libéré dans le bloc intérieur AVANT tout .await.
    let epoch_gap: Option<(u64, u64)> = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        match lock.as_ref() {
            Some(manager) => {
                let group_epoch = match manager.get_epoch(&group_id) {
                    Ok(epoch) => Some(epoch),
                    Err(_) => None,
                };
                match (MlsManager::parse_message_epoch(&message_bytes), group_epoch) {
                    (Some(msg_ep), Some(group_ep)) if msg_ep > group_ep => Some((msg_ep, group_ep)),
                    _ => None,
                }
            }
            None => None,
        }
        // lock est libéré ici — aucun await n'a encore eu lieu
    };
    if let Some((msg_ep, group_ep)) = epoch_gap {
        log::warn!(
            "[GAP] Epoch gap détecté AVANT déchiffrement : \
             msg_epoch={} > group_epoch={} pour group={}. \
             Mise en attente et déclenchement de la resync.",
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

    // Acquiert + libère le Mutex AVANT toute opération async pour éviter les
    // deadlocks avec std::sync::Mutex (non-Send across await points).
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

            // Corruption détectée par mls-core → état irrécupérable, déclencher re-bootstrap.
            if err_str.starts_with("UNRECOVERABLE:") {
                return Err(format!("UNRECOVERABLE:{}", group_id));
            }

            // "Process error:" indique une erreur OpenMLS sur le même epoch →
            // probable gap du Sender Ratchet (génération future reçue).
            if err_str.contains("Process error:") {
                log::warn!(
                    "[GAP] Sender Ratchet gap pour group={} — message mis en file SQLite",
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
                match insert_result {
                    Ok(_) => (),
                    Err(db_e) => {
                        log::error!("[GAP] DB store failed: {}", db_e);
                        return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
                    }
                }
                // Embed the original OpenMLS error so the frontend can log it.
                return Err(format!("GAP_QUEUED:{}:{}", group_id, err_str));
            }

            Err(err_str)
        }
    }
}

// ─── Re-Bootstrap (Fail-Safe) ─────────────────────────────────────────────────

/// Résultat du bootstrap retourné au frontend TypeScript.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BootstrapOutcome {
    /// Bootstrap réussi : le frontend doit envoyer les Welcome + le commit.
    Success {
        commit: Vec<u8>,
        welcome: Option<Vec<u8>>,
        added_device_ids: Vec<String>,
        ratchet_tree: Option<Vec<u8>>,
        new_bootstrap_version: u32,
    },
    /// Race condition : un autre device a déjà bootstrappé le groupe.
    /// Le frontend doit ignorer et attendre le Welcome entrant.
    Conflict,
    /// Aucun device tiers à inviter (groupe solo ou tous hors-ligne).
    NoMembers,
}

#[derive(serde::Deserialize)]
struct DeviceEntry {
    #[serde(rename = "keyPackage")]
    key_package: String, // base64
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(serde::Deserialize)]
struct ClaimBootstrapResponse {
    #[serde(rename = "bootstrapVersion")]
    bootstrap_version: u32,
}

/// Fail-Safe universel : recrée un groupe MLS mort de zéro.
///
/// Séquence atomique du point de vue du réseau :
///   1. Acquiert le verrou optimiste côté serveur (`claim-bootstrap`).
///      Si 409 → un autre device a gagné la course → retourne Conflict.
///   2. Remet l'epoch serveur à 0 (`reset-epoch`).
///   3. Crée un état MLS frais en local (`force_create_group`).
///   4. Récupère les KeyPackages de tous les membres via l'API.
///   5. Ajoute tous les devices en bulk (`add_members_bulk`).
///   6. Sauvegarde l'état MLS chiffré (mls.bin + checkpoint SQLite).
///   7. Remet à zéro le compteur de défaillances consécutives.
///
/// La complétion (envoi du Welcome + commit) est laissée au frontend TypeScript
/// car elle implique de multiples appels réseau et de la logique applicative.
#[tauri::command]
async fn bootstrap_dead_conversation(
    conversation_id: String,
    member_user_ids: Vec<String>,
    expected_bootstrap_version: u32,
    auth_token: String,
    base_url: String,
    pin: String,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
    http_client: tauri::State<'_, HttpClient>,
    app: tauri::AppHandle,
) -> Result<BootstrapOutcome, String> {
    // ── Étape 1 : Acquérir le verrou optimiste ────────────────────────────────
    let base = base_url.trim_end_matches('/');
    let claim_url = format!(
        "{}/api/mls/groups/{}/claim-bootstrap",
        base, conversation_id
    );
    let claim_resp = http_client
        .0
        .post(&claim_url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"expectedVersion":{}}}"#, expected_bootstrap_version))
        .send()
        .await
        .map_err(|e| format!("claim-bootstrap HTTP error: {}", e))?;

    if claim_resp.status() == 409 {
        log::warn!(
            "[BOOTSTRAP] Race condition détectée pour group={} — un autre device a déjà bootstrappé.",
            conversation_id
        );
        return Ok(BootstrapOutcome::Conflict);
    }
    if !claim_resp.status().is_success() {
        return Err(format!(
            "claim-bootstrap failed: {}",
            claim_resp.status()
        ));
    }
    let claim_body: ClaimBootstrapResponse = claim_resp
        .json()
        .await
        .map_err(|e| format!("claim-bootstrap response parse error: {}", e))?;
    let new_bootstrap_version = claim_body.bootstrap_version;

    // ── Étape 2 : Reset de l'epoch serveur à 0 ───────────────────────────────
    let reset_url = format!(
        "{}/api/mls/groups/{}/reset-epoch",
        base, conversation_id
    );
    let reset_resp = http_client
        .0
        .post(&reset_url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .send()
        .await
        .map_err(|e| format!("reset-epoch HTTP error: {}", e))?;
    if !reset_resp.status().is_success() {
        log::warn!(
            "[BOOTSTRAP] reset-epoch failed ({}) — on continue quand même.",
            reset_resp.status()
        );
    }

    // ── Étape 3 : Créer un état MLS frais en local ───────────────────────────
    {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        manager
            .force_create_group(conversation_id.clone())
            .map_err(|e| e.to_string())?;
    }

    // ── Étape 4 : Récupérer les KeyPackages de chaque membre ─────────────────
    // Tous les appels HTTP se font HORS du Mutex (pas d'await sous lock).
    let mut all_key_packages: Vec<Vec<u8>> = Vec::new();
    let mut added_device_ids: Vec<String> = Vec::new();

    for user_id in &member_user_ids {
        let devices_url = format!("{}/api/mls/devices/{}", base, user_id);
        let resp = match http_client
            .0
            .get(&devices_url)
            .header("Authorization", format!("Bearer {}", auth_token))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                log::warn!(
                    "[BOOTSTRAP] fetchUserDevices({}) → {}",
                    user_id,
                    r.status()
                );
                continue;
            }
            Err(e) => {
                log::warn!("[BOOTSTRAP] fetchUserDevices({}) network error: {}", user_id, e);
                continue;
            }
        };

        let devices: Vec<DeviceEntry> = match resp.json().await {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[BOOTSTRAP] fetchUserDevices({}) parse error: {}", user_id, e);
                continue;
            }
        };

        for device in devices {
            match base64::engine::general_purpose::STANDARD.decode(&device.key_package) {
                Ok(kp_bytes) => {
                    all_key_packages.push(kp_bytes);
                    added_device_ids.push(device.device_id);
                }
                Err(e) => {
                    log::warn!(
                        "[BOOTSTRAP] base64 decode failed for device {}: {}",
                        device.device_id,
                        e
                    );
                }
            }
        }
    }

    if all_key_packages.is_empty() {
        log::warn!(
            "[BOOTSTRAP] Aucun KeyPackage valide pour group={} — bootstrap annulé.",
            conversation_id
        );
        return Ok(BootstrapOutcome::NoMembers);
    }

    // ── Étape 5 : Ajouter tous les devices en bulk ───────────────────────────
    let (commit, welcome, ratchet_tree) = {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        let refs: Vec<&[u8]> = all_key_packages.iter().map(|v| v.as_slice()).collect();
        let (commit_b, welcome_b, _count, rt_b) = manager
            .add_members_bulk(&conversation_id, &refs)
            .map_err(|e| e.to_string())?;
        (commit_b, welcome_b, rt_b)
    };

    // ── Étape 6 : Sauvegarder l'état MLS ────────────────────────────────────
    let enc = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
        manager.save_encrypted(&pin).map_err(|e| e.to_string())?
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let mut tx = pending_db.0.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT OR REPLACE INTO mls_state_checkpoint (id, state, saved_at) VALUES (1, ?, ?)",
    )
    .bind(enc.as_slice())
    .bind(ts)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("mls.bin"), &enc).map_err(|e| e.to_string())?;

    log::info!(
        "[BOOTSTRAP] Groupe {} re-bootstrappé avec succès ({} devices).",
        conversation_id,
        added_device_ids.len()
    );

    Ok(BootstrapOutcome::Success {
        commit,
        welcome,
        added_device_ids,
        ratchet_tree,
        new_bootstrap_version,
    })
}

#[tauri::command]
fn exporter_secret(
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

/// Retourne le token FCM stocké par CanariFirebaseMessagingService.
/// Sur Android, lit {app_data_dir}/fcm_token.txt (écrit par onNewToken).
/// Sur desktop/iOS, retourne None (pas de FCM).
#[tauri::command]
fn get_fcm_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => { log::warn!("[FCM] app_data_dir() failed: {e}"); return None; }
        };
        match std::fs::read_to_string(data_dir.join("fcm_token.txt")) {
            Ok(token) => {
                let token = token.trim().to_string();
                if token.is_empty() { log::warn!("[FCM] fcm_token.txt is empty"); None }
                else { Some(token) }
            }
            Err(e) => { log::warn!("[FCM] read fcm_token.txt: {e}"); None }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}


// ─── Protobuf minimal helpers (pas de dépendance externe) ────────────────────

/// Lit un varint protobuf depuis `bytes` à la position `pos`.
/// Retourne (valeur, position_suivante) ou None si invalide.
#[cfg(target_os = "android")]
fn read_varint(bytes: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut cur = pos;
    loop {
        if cur >= bytes.len() || shift >= 64 {
            return None;
        }
        let byte = bytes[cur] as u64;
        result |= (byte & 0x7f) << shift;
        cur += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Some((result, cur))
}

/// Cherche le premier champ `field_num` de wire type 2 (LEN) dans `bytes`.
/// Retourne les octets du payload de ce champ, ou None si absent.
#[cfg(target_os = "android")]
fn find_length_delimited_field(bytes: &[u8], field_num: u32) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (tag, after_tag) = read_varint(bytes, pos)?;
        let wire_type = tag & 0x7;
        let field = (tag >> 3) as u32;
        pos = after_tag;
        match wire_type {
            0 => {
                let (_, next) = read_varint(bytes, pos)?;
                pos = next;
            }
            1 => {
                if pos + 8 > bytes.len() {
                    return None;
                }
                pos += 8;
            }
            2 => {
                let (len, after_len) = read_varint(bytes, pos)?;
                pos = after_len;
                let end = pos + len as usize;
                if end > bytes.len() {
                    return None;
                }
                if field == field_num {
                    return Some(bytes[pos..end].to_vec());
                }
                pos = end;
            }
            5 => {
                if pos + 4 > bytes.len() {
                    return None;
                }
                pos += 4;
            }
            _ => return None,
        }
    }
    None
}

/// Cherche le premier champ `field_num` de wire type 0 (varint) dans `bytes`.
/// Utilisé pour extraire `sent_at` (int64, field 8) et les enums depuis un AppMessage.
#[cfg(target_os = "android")]
fn find_varint_field(bytes: &[u8], field_num: u32) -> Option<u64> {
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (tag, after_tag) = read_varint(bytes, pos)?;
        let wire_type = tag & 0x7;
        let field = (tag >> 3) as u32;
        pos = after_tag;
        match wire_type {
            0 => {
                let (value, next) = read_varint(bytes, pos)?;
                if field == field_num {
                    return Some(value);
                }
                pos = next;
            }
            1 => {
                if pos + 8 > bytes.len() { return None; }
                pos += 8;
            }
            2 => {
                let (len, after_len) = read_varint(bytes, pos)?;
                pos = after_len;
                let end = pos + len as usize;
                if end > bytes.len() { return None; }
                pos = end;
            }
            5 => {
                if pos + 4 > bytes.len() { return None; }
                pos += 4;
            }
            _ => return None,
        }
    }
    None
}

/// Extrait les métadonnées complètes d'un `AppMessage` protobuf déchiffré.
///
/// Champs AppMessage parsés :
///   field 1 = TextMsg  (content = field 1)
///   field 2 = ReplyMsg (content = field 1, replyTo/ReplyRef = field 2)
///   field 4 = MediaMsg (kind = field 1 enum, caption = field 8)
///   field 6 = message_id (string)
///   field 8 = sent_at (int64 varint, ms epoch)
///
/// Retourne {"ok":true,"text":"...","messageId":"...","sentAt":0,"type":"text|reply|media","replyTo":null,"mediaKind":null}
/// ou {"ok":false} si le message n'est pas affichable (réaction, système, etc.).
#[cfg(target_os = "android")]
fn extract_full_message_info(bytes: &[u8]) -> serde_json::Value {
    let message_id = find_length_delimited_field(bytes, 6)
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();
    let sent_at = find_varint_field(bytes, 8).map(|v| v as i64).unwrap_or(0);

    // TextMsg : field 1
    if let Some(text_msg) = find_length_delimited_field(bytes, 1) {
        if let Some(content_bytes) = find_length_delimited_field(&text_msg, 1) {
            if let Ok(text) = String::from_utf8(content_bytes) {
                if !text.is_empty() {
                    return serde_json::json!({
                        "ok": true, "text": text, "messageId": message_id,
                        "sentAt": sent_at, "type": "text", "replyTo": null, "mediaKind": null
                    });
                }
            }
        }
    }

    // ReplyMsg : field 2 (content = field 1, ReplyRef = field 2)
    if let Some(reply_msg) = find_length_delimited_field(bytes, 2) {
        let content = find_length_delimited_field(&reply_msg, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        if !content.is_empty() {
            let reply_to = find_length_delimited_field(&reply_msg, 2).map(|ref_bytes| {
                let id = find_length_delimited_field(&ref_bytes, 1)
                    .and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
                let sender_id = find_length_delimited_field(&ref_bytes, 2)
                    .and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
                let preview = find_length_delimited_field(&ref_bytes, 3)
                    .and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
                serde_json::json!({ "id": id, "senderId": sender_id, "preview": preview })
            });
            return serde_json::json!({
                "ok": true, "text": content, "messageId": message_id,
                "sentAt": sent_at, "type": "reply", "replyTo": reply_to, "mediaKind": null
            });
        }
    }

    // MediaMsg : field 4 (kind enum = field 1, caption = field 8)
    if let Some(media_msg) = find_length_delimited_field(bytes, 4) {
        let kind_str = match find_varint_field(&media_msg, 1) {
            Some(1) => "image",
            Some(2) => "video",
            Some(3) => "audio",
            _       => "file",
        };
        let caption = find_length_delimited_field(&media_msg, 8)
            .and_then(|b| String::from_utf8(b).ok())
            .filter(|s| !s.is_empty());
        let display_text = caption.unwrap_or_else(|| match kind_str {
            "image" => "📷 Photo".to_string(),
            "video" => "🎥 Vidéo".to_string(),
            "audio" => "🎤 Audio".to_string(),
            _       => "📎 Pièce jointe".to_string(),
        });
        return serde_json::json!({
            "ok": true, "text": display_text, "messageId": message_id,
            "sentAt": sent_at, "type": "media", "replyTo": null, "mediaKind": kind_str
        });
    }

    serde_json::json!({ "ok": false })
}

// ─── Fonction JNI appelée par CanariFirebaseMessagingService ─────────────────

/// Déchiffre un message MLS et retourne ses métadonnées complètes en JSON.
/// Format retourné : {"ok":true,"text":"...","messageId":"...","sentAt":123,"type":"text|reply|media","replyTo":null,"mediaKind":null}
/// Sur échec : {"ok":false}
/// Appelée directement depuis Kotlin via System.loadLibrary("mines_app_lib").
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessage<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Option<serde_json::Value> {
        let state_vec = env.convert_byte_array(&state_bytes).ok()?;
        let pin_str: String = env.get_string(&pin).ok()?.into();
        let user_id_str: String = env.get_string(&user_id).ok()?.into();
        let device_id_str: String = env.get_string(&device_id).ok()?.into();
        let group_id_str: String = env.get_string(&group_id).ok()?.into();
        let cipher_vec = env.convert_byte_array(&ciphertext).ok()?;

        // Manager temporaire : avance son propre ratchet, n'écrit rien sur disque.
        // Le MlsManager principal peut traiter le même message normalement au boot.
        let mut manager =
            MlsManager::load_encrypted(&user_id_str, &device_id_str, Some(state_vec), &pin_str).ok()?;

        let plaintext = match manager.process_incoming_message(&group_id_str, &cipher_vec) {
            Ok(Some(p)) => p,
            Ok(None) => {
                log::warn!("[FCM] process_incoming_message: Ok(None) — message de contrôle MLS");
                return None;
            }
            Err(e) => {
                log::error!("[FCM] process_incoming_message: Err({e}) — group={group_id_str}");
                return None;
            }
        };

        let info = extract_full_message_info(&plaintext);
        if info["ok"].as_bool().unwrap_or(false) { Some(info) } else { None }
    })()
    .unwrap_or_else(|| serde_json::json!({ "ok": false }));

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

// ─── Commande Tauri : cache FCM ───────────────────────────────────────────────

/// Lit {app_data_dir}/fcm_message_cache.ndjson, efface le fichier et retourne les entrées.
/// Appelé au boot juste après login pour pré-injecter les messages déjà déchiffrés
/// lors de la réception FCM — évite d'attendre la sync MLS complète (~10s).
#[tauri::command]
fn read_and_clear_fcm_cache(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => { log::warn!("[FCM_CACHE] app_data_dir() failed: {e}"); return vec![]; }
    };
    let path = data_dir.join("fcm_message_cache.ndjson");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => { log::warn!("[FCM_CACHE] lecture: {e}"); return vec![]; }
    };
    // Effacer immédiatement pour éviter les doublons au prochain boot
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[FCM_CACHE] suppression: {e}");
    }
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    log::info!("[FCM_CACHE] {} entrée(s) lue(s)", entries.len());
    entries
}

// ─── Commandes Tauri : contexte push ─────────────────────────────────────────

/// Sauvegarde le PIN et le contexte de session dans {app_data_dir}/push_context.json
/// pour que CanariFirebaseMessagingService puisse déchiffrer les notifications push.
/// `push_token` est un Bearer token long-lived (ou vide sur desktop) utilisé par le
/// service Kotlin pour fetcher le proto MLS quand il n'est pas inclus inline dans FCM.
#[tauri::command]
fn store_push_context(
    pin: String,
    user_id: String,
    device_id: String,
    base_url: String,
    push_token: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::json!({
        "pin": pin,
        "userId": user_id,
        "deviceId": device_id,
        "baseUrl": base_url,
        "pushToken": push_token.unwrap_or_default()
    });
    std::fs::write(data_dir.join("push_context.json"), json.to_string()).map_err(|e| e.to_string())
}

/// Write an already-encrypted MLS state blob into {app_data_dir}/mls.bin.
/// Accepts the encrypted bytes (as number[] from JS) and writes them verbatim.
/// This is used by the frontend when it already holds an encrypted state and
/// wants to persist it to the native app data directory (avoid WebView eviction).
#[tauri::command]
fn save_mls_state(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    write_mls_state_blob(&app, &data)
}

#[tauri::command]
fn delete_mls_state(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("mls.bin");
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Lit {app_data_dir}/push_context.json et retourne son contenu.
/// Utilisé pour restaurer le device ID quand localStorage est vide (réinstall Android).
#[tauri::command]
fn load_push_context(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => { log::warn!("[PushCtx] app_data_dir() failed: {e}"); return None; }
    };
    let path = data_dir.join("push_context.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => { log::warn!("[PushCtx] read push_context.json: {e}"); return None; }
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => { log::warn!("[PushCtx] parse push_context.json: {e}"); None }
    }
}

/// Lit {app_data_dir}/mls.bin et retourne son contenu chiffré.
/// Retourne None si le fichier n'existe pas (première installation).
/// Utilisé au démarrage sur mobile quand localStorage est vide (WebView nettoyé).
#[tauri::command]
fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => { log::warn!("[MLS] app_data_dir() failed: {e}"); return None; }
    };
    let path = data_dir.join("mls.bin");
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => { log::warn!("[MLS] read mls.bin: {e}"); None }
    }
}

// Supprime tous les fichiers .db dans le dossier de l'app
#[tauri::command]
fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if data_dir.exists() {
        for entry in std::fs::read_dir(data_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("db") {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Écrit le pushSecret reçu du backend dans {app_data_dir}/pending_push_secret.txt.
/// CanariApplication.processPendingPushSecret() le lit au prochain démarrage,
/// le chiffre dans Android Keystore, puis supprime le fichier.
#[tauri::command]
fn store_push_secret(secret: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        std::fs::write(data_dir.join("pending_push_secret.txt"), &secret)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (secret, app);
    }
    Ok(())
}

/// Stores a boolean flag in {app_data_dir}/native_flags.json.
/// Used to persist UI flags (e.g. biometric enrollment) outside the WebView
/// storage layer, which MIUI and other aggressive OEMs may clear between sessions.
#[tauri::command]
fn set_native_flag(key: String, value: bool, app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("native_flags.json");
    let mut flags: serde_json::Map<String, serde_json::Value> = if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    flags.insert(key, serde_json::Value::Bool(value));
    std::fs::write(&path, serde_json::Value::Object(flags).to_string())
        .map_err(|e| e.to_string())
}

/// Reads all boolean flags from {app_data_dir}/native_flags.json.
/// Returns an empty object if the file does not exist yet.
#[tauri::command]
fn get_native_flags(app: tauri::AppHandle) -> serde_json::Value {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => { log::warn!("[Flags] app_data_dir() failed: {e}"); return serde_json::Value::Object(serde_json::Map::new()); }
    };
    let path = data_dir.join("native_flags.json");
    if !path.exists() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Android: installe un hook de panic pour loguer le message AVANT le SIGABRT.
    // tauri-plugin-log gère seul l'initialisation du logger global (y compris logcat).
    #[cfg(target_os = "android")]
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log::error!("PANIC: {info}");
            prev(info);
        }));
    }

    // In production desktop builds, `tauri://` scheme redirects are blocked by
    // WebKitGTK. We serve app assets via a local HTTP server instead, so the
    // OIDC redirect URI stays http://, which WebKitGTK accepts without complaint.
    #[cfg(all(desktop, not(dev)))]
    let port: u16 = 1421;

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_websocket::init());

    #[cfg(all(desktop, not(dev)))]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keystore::init())
        .plugin(tauri_plugin_deep_link::init());

    builder
        .manage(AppState {
            mls_manager: Arc::new(Mutex::new(None)),
        })
        .manage(HttpClient(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("Failed to build reqwest client"),
        ))
        .setup(move |app| {
            // ── Pool SQLite pour les messages MLS en attente (gap recovery) ────────
            // Initialisé ici avec le chemin appData définitif.
            // block_on est sûr : setup() s'exécute avant le démarrage de l'event loop Tauri.
            let data_dir = app.path().app_data_dir().map_err(|e| format!("{e}"))?;
            log::info!("[Path] app_data_dir = {}", data_dir.display());
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("mls_pending.db");
            let pending_pool = tauri::async_runtime::block_on(async {
                sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(4)
                    .connect_with(
                        sqlx::sqlite::SqliteConnectOptions::new()
                            .filename(&db_path)
                            .create_if_missing(true)
                            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
                    )
                    .await
                    .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB init: {e}"))?;

            // Chantier 1/3 : table pending avec colonne is_ready + migration pour installs existantes.
            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS pending_mls_messages (\
                        id         TEXT    PRIMARY KEY,\
                        group_id   TEXT    NOT NULL,\
                        ciphertext BLOB    NOT NULL,\
                        created_at INTEGER NOT NULL,\
                        is_ready   INTEGER NOT NULL DEFAULT 0\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB schema: {e}"))?;
            // Migration silencieuse : ajoute is_ready sur installs existantes (ignore si déjà présent).
            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await; // duplicate column → erreur ignorée volontairement
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration: {e}"))?;

            // Chantier 3 : table de checkpoint d'état MLS (singleton row id=1).
            // Permet une sauvegarde atomique (même transaction que is_ready=1).
            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS mls_state_checkpoint (\
                        id       INTEGER PRIMARY KEY CHECK (id = 1),\
                        state    BLOB    NOT NULL,\
                        saved_at INTEGER NOT NULL\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB checkpoint schema: {e}"))?;

            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE INDEX IF NOT EXISTS idx_pmm_group \
                     ON pending_mls_messages(group_id, created_at)",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB index: {e}"))?;

            app.manage(PendingDb(Arc::new(pending_pool)));
            // ── Create main window on desktop ────────────────────────────────────
            // In dev mode: use the Vite dev server (already HTTP, no issues).
            // In production: use tauri-plugin-localhost so assets are served over
            // http://localhost:<port>. This means the OIDC redirect URI is HTTP,
            // and WebKitGTK won't block it with its "non-HTTP(S) scheme" error.
            #[cfg(desktop)]
            {
                #[cfg(dev)]
                let url = tauri::WebviewUrl::App(std::path::PathBuf::from("/"));

                #[cfg(not(dev))]
                let url = {
                    let localhost_url: tauri::Url =
                        format!("http://localhost:{}", port).parse().unwrap();
                    // Grant all app permissions to the localhost-served window.
                    app.add_capability(
                        tauri::ipc::CapabilityBuilder::new("localhost-cap")
                            .permission("core:default")
                            .permission("core:window:allow-show")
                            .permission("core:window:allow-hide")
                            .permission("core:window:allow-set-focus")
                            .permission("core:window:allow-unminimize")
                            .permission("core:window:allow-is-visible")
                            .permission("core:window:allow-close")
                            .permission("core:window:allow-destroy")
                            .permission("core:tray:default")
                            .permission("opener:default")
                            .permission("notification:default")
                            .permission("sql:default")
                            .permission("sql:allow-execute")
                            .remote(localhost_url.to_string())
                            .window("main"),
                    )?;
                    tauri::WebviewUrl::External(localhost_url)
                };

                tauri::WebviewWindowBuilder::from_config(
                    app.handle(),
                    &app.config().app.windows[0],
                )?
                .build()?;
            }

            // ── Create main window on mobile ─────────────────────────────────────
            // On mobile tauri.conf.json uses "create": false (desktop-only builder
            // path above handles desktop). We build the window explicitly here so
            // the WebView actually loads instead of showing a blank screen.
            #[cfg(mobile)]
            tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App(std::path::PathBuf::from("/")),
            )
            .build()?;

            // Open devtools automatically in debug mode
            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }

            // Paramètre utilisé uniquement sur desktop (system tray).
            #[cfg(mobile)]
            let _ = app;
            // ── System tray (desktop only) ──────────────────────────────
            #[cfg(desktop)]
            {
                let show_item = MenuItemBuilder::with_id("show", "Afficher Canari").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "Quitter").build(app)?;
                let menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .separator()
                    .item(&quit_item)
                    .build()?;

                let icon = Image::from_path("icons/icon.png")
                    .or_else(|_| Image::from_path("icons/32x32.png"))
                    .unwrap_or_else(|_| {
                        app.default_window_icon().cloned().expect("no default icon")
                    });

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Canari")
                    .on_menu_event(|app_handle, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                            if button == tauri::tray::MouseButton::Left {
                                let app_handle = tray.app_handle();
                                if let Some(win) = app_handle.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        // Intercept window close → hide to tray on desktop
        .on_window_event(|window, event| {
            #[cfg(mobile)]
            let _ = (window, event);
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide the window instead of closing it
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            initialiser_mls,
            sauvegarder_mls,
            sauvegarder_mls_et_persister,
            creer_groupe,
            lister_groupes,
            oublier_groupe,
            supprimer_groupe,
            obtenir_epoch,
            generer_key_package,
            generer_key_packages,
            generer_key_packages_et_persister,
            ajouter_membre,
            ajouter_membres_bulk,
            retirer_membres,
            retirer_membres_par_appareil,
            trailer_welcome,
            envoyer_message,
            envoyer_message_bytes,
            recevoir_message,
            recevoir_message_bytes,
            exporter_secret,
            get_fcm_token,
            store_push_context,
            load_push_context,
            save_mls_state,
            delete_mls_state,
            load_mls_state,
            store_push_secret,
            clear_app_data,
            bootstrap_dead_conversation,
            set_native_flag,
            get_native_flags,
            read_and_clear_fcm_cache
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Sur Android, log::error! est routé vers logcat (tag "CanariRust")
            // avant que le panic ne provoque le SIGABRT visible dans le crash log.
            #[cfg(target_os = "android")]
            log::error!("Tauri failed to start: {e:?}");
            panic!("error while running tauri application: {e:?}");
        });
}

// Point d'entrée JNI pour le Worker en arrière-plan
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_MlsBackgroundWorker_nativeProcessBackgroundTasks(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    files_dir: jni::objects::JString,
    state_bytes: jni::objects::JByteArray,
    pin: jni::objects::JString,
    user_id: jni::objects::JString,
    device_id: jni::objects::JString,
) -> jni::sys::jboolean {

    let files_dir_str: String = match env.get_string(&files_dir) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let state_vec = match env.convert_byte_array(state_bytes) {
        Ok(v) => v,
        Err(_) => return 0,
    };

    let pin_str: String = match env.get_string(&pin) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let user_id_str: String = match env.get_string(&user_id) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let device_id_str: String = match env.get_string(&device_id) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(_) => return 0,
    };

    let result = rt.block_on(async {
        let db_path = std::path::Path::new(&files_dir_str).join("mls_pending.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .map_err(|e| e.to_string())?;

        let mut manager = MlsManager::load_encrypted(&user_id_str, &device_id_str, Some(state_vec), &pin_str).map_err(|e| e.to_string())?;

        // 1. Fetch distinct group_ids that have pending tasks
        let group_ids: Vec<String> = sqlx::query_scalar("SELECT DISTINCT group_id FROM pending_mls_messages WHERE is_ready = 0")
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;

        for group_id in group_ids {
            let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
                "SELECT id, ciphertext FROM pending_mls_messages WHERE group_id = ? AND is_ready = 0 ORDER BY created_at ASC",
            )
            .bind(&group_id)
            .fetch_all(&pool)
            .await
            .map_err(|e| e.to_string())?;

            for (id, ciphertext) in &rows {
                if manager.process_incoming_message(&group_id, ciphertext).is_ok() {
                    if let Ok(enc) = manager.save_encrypted(&pin_str) {
                        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
                        sqlx::query("UPDATE pending_mls_messages SET is_ready = 1 WHERE id = ?")
                            .bind(id)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                        
                        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                        sqlx::query("INSERT OR REPLACE INTO mls_state_checkpoint (id, state, saved_at) VALUES (1, ?, ?)")
                            .bind(enc.as_slice())
                            .bind(ts)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| e.to_string())?;
                        
                        if tx.commit().await.is_ok() {
                            let _ = std::fs::write(std::path::Path::new(&files_dir_str).join("mls.bin"), &enc);
                        }
                    }
                } else {
                    break;
                }
            }
            
            let _ = sqlx::query("DELETE FROM pending_mls_messages WHERE group_id = ? AND is_ready = 1")
                .bind(&group_id)
                .execute(&pool)
                .await;
        }

        Ok::<(), String>(())
    });

    if result.is_ok() {
        log::info!("Background Worker exécuté avec succès !");
        1
    } else {
        log::error!("Background Worker échoué: {:?}", result.err());
        0
    }
}

/// Crée un paquet Welcome MLS pour un nouveau device (background service, app tuée).
///
/// Appelé depuis `CanariFirebaseMessagingService` lors de la réception d'un
/// `welcome_request_pending` FCM quand l'app n'est pas en premier plan.
///
/// - Charge l'état MLS depuis `state_bytes`.
/// - Appelle `add_member` avec le `key_package_b64` du requester.
/// - Sauvegarde l'état MLS mis à jour dans `{files_dir}/mls.bin`.
/// - Retourne un JSON : `{"ok":true,"welcome":"<b64>","ratchetTree":"<b64>|null","commit":"<b64>"}`
///   ou `{"ok":false,"error":"..."}` en cas d'échec.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeCreateWelcomeBackground<'a>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    key_package_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env.get_string(&files_dir).map_err(|e| e.to_string())?.into();
        let state_vec = env.convert_byte_array(&state_bytes).map_err(|e| e.to_string())?;
        let pin_str: String = env.get_string(&pin).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env.get_string(&device_id).map_err(|e| e.to_string())?.into();
        let group_id_str: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let kp_b64: String = env.get_string(&key_package_b64).map_err(|e| e.to_string())?.into();

        let kp_bytes = STANDARD
            .decode(&kp_b64)
            .map_err(|e| format!("base64 decode key_package: {}", e))?;

        let mut manager =
            MlsManager::load_encrypted(&user_id_str, &device_id_str, Some(state_vec), &pin_str)
                .map_err(|e| e.to_string())?;

        log::debug!(
            "[BG_WELCOME] add_member group={} kp_len={}",
            group_id_str,
            kp_bytes.len()
        );
        let (commit, welcome_opt, ratchet_tree_opt) = manager
            .add_member(&group_id_str, &kp_bytes)
            .map_err(|e| e.to_string())?;

        let welcome = welcome_opt
            .ok_or_else(|| "add_member returned no welcome bytes".to_string())?;

        // Sauvegarde atomique de l'état MLS mis à jour.
        let enc = manager.save_encrypted(&pin_str).map_err(|e| e.to_string())?;
        let mls_path = std::path::Path::new(&files_dir_str).join("mls.bin");
        std::fs::write(&mls_path, &enc)
            .map_err(|e| format!("write mls.bin: {}", e))?;
        log::info!(
            "[BG_WELCOME] mls.bin mis à jour ({} octets) pour group={}",
            enc.len(),
            group_id_str
        );

        Ok(serde_json::json!({
            "ok": true,
            "welcome": STANDARD.encode(&welcome),
            "ratchetTree": ratchet_tree_opt.as_deref().map(|rt| STANDARD.encode(rt)),
            "commit": STANDARD.encode(&commit),
        }))
    })();

    let json_str = match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            log::error!("[BG_WELCOME] nativeCreateWelcomeBackground failed: {}", e);
            format!("{{\"ok\":false,\"error\":{:?}}}", e)
        }
    };

    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}
