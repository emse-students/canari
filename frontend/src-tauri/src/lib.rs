// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use mls_core::MlsManager;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};

// State wrapper
struct AppState {
    mls_manager: Mutex<Option<MlsManager>>,
}

/// Pool SQLite dédié aux messages MLS en attente (gap du Sender Ratchet).
/// Séparé de tauri-plugin-sql (côté JS) pour rester accessible depuis les commandes Rust.
struct PendingDb(Arc<sqlx::SqlitePool>);

// --- COMMANDS ---

#[tauri::command]
fn initialiser_mls(
    user_id: String,
    device_id: String,
    pin: String,
    encrypted_state: Option<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let manager = MlsManager::load_encrypted(&user_id, &device_id, encrypted_state, &pin)
        .map_err(|e| e.to_string())?;

    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    *lock = Some(manager);

    Ok("MLS Initialized".into())
}

#[tauri::command]
fn sauvegarder_mls(pin: String, state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager.save_encrypted(&pin).map_err(|e| e.to_string())
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
fn generer_key_package(state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager.generate_key_package().map_err(|e| e.to_string())
}

#[tauri::command]
fn generer_key_packages(
    count: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<Vec<u8>>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager
        .generate_key_packages(count)
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
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
            log::error!("recevoir_message_bytes failed: group={} err={}", group_id, err_str);

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
                    .as_millis() as i64;
                let id = format!("{}-{}", group_id, ts);
                sqlx::query(
                    "INSERT OR IGNORE INTO pending_mls_messages \
                     (id, group_id, ciphertext, created_at) VALUES (?, ?, ?, ?)",
                )
                .bind(&id)
                .bind(&group_id)
                .bind(message_bytes.as_slice())
                .bind(ts)
                .execute(&*pending_db.0)
                .await
                .unwrap_or_else(|db_e| {
                    log::warn!("[GAP] DB store failed: {}", db_e);
                    Default::default()
                });
                return Err(format!("GAP_QUEUED:{}", group_id));
            }

            Err(err_str)
        }
    }
}

/// Traite une liste de messages MLS récupérés depuis l'historique serveur (gap fetching).
/// Les messages sont passés dans l'ordre chronologique strict.
/// Après chaque succès, l'état MLS est chiffré et écrit dans mls.bin.
/// Retourne le nombre de messages traités avec succès.
#[tauri::command]
async fn process_gap_messages(
    group_id: String,
    messages: Vec<Vec<u8>>,
    pin: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let mut processed = 0usize;
    for msg_bytes in &messages {
        let result = {
            let mut lock = state
                .mls_manager
                .lock()
                .map_err(|_| "Failed to lock state")?;
            let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
            manager.process_incoming_message(&group_id, msg_bytes)
        };
        match result {
            Ok(_) => {
                // Persister l'état MLS immédiatement après chaque message réussi.
                let enc = {
                    let lock = state
                        .mls_manager
                        .lock()
                        .map_err(|_| "Failed to lock state")?;
                    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
                    manager.save_encrypted(&pin).map_err(|e| e.to_string())?
                };
                let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
                std::fs::write(data_dir.join("mls.bin"), &enc).map_err(|e| e.to_string())?;
                processed += 1;
            }
            Err(e) => {
                log::warn!(
                    "[GAP] process_gap_messages: échec sur message {} pour group={}: {}",
                    processed,
                    group_id,
                    e
                );
                break; // Ordre strict : s'arrêter au premier échec
            }
        }
    }
    log::info!(
        "[GAP] process_gap_messages: {}/{} messages traités pour group={}",
        processed,
        messages.len(),
        group_id
    );
    Ok(processed)
}

/// Lit les messages en attente (is_ready = 0) depuis SQLite pour `group_id`,
/// les passe à OpenMLS dans l'ordre chronologique strict, et après chaque succès :
///   1. Chiffre et écrit mls.bin (état MLS à jour)
///   2. Supprime le message de la table pending
/// Retourne le nombre de messages traités avec succès.
#[tauri::command]
async fn process_pending_mls_messages(
    group_id: String,
    pin: String,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT id, ciphertext FROM pending_mls_messages \
         WHERE group_id = ? ORDER BY created_at ASC",
    )
    .bind(&group_id)
    .fetch_all(&*pending_db.0)
    .await
    .map_err(|e| e.to_string())?;

    log::info!(
        "[PENDING] {} message(s) en attente pour group={}",
        rows.len(),
        group_id
    );

    let mut processed = 0usize;
    for (id, ciphertext) in &rows {
        let result = {
            let mut lock = state
                .mls_manager
                .lock()
                .map_err(|_| "Failed to lock state")?;
            let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
            manager.process_incoming_message(&group_id, ciphertext)
        };
        match result {
            Ok(_) => {
                let enc = {
                    let lock = state
                        .mls_manager
                        .lock()
                        .map_err(|_| "Failed to lock state")?;
                    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
                    manager.save_encrypted(&pin).map_err(|e| e.to_string())?
                };
                let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
                std::fs::write(data_dir.join("mls.bin"), &enc).map_err(|e| e.to_string())?;
                sqlx::query("DELETE FROM pending_mls_messages WHERE id = ?")
                    .bind(id)
                    .execute(&*pending_db.0)
                    .await
                    .unwrap_or_else(|db_e| {
                        log::warn!("[PENDING] DELETE failed for id={}: {}", id, db_e);
                        Default::default()
                    });
                processed += 1;
            }
            Err(e) => {
                log::warn!(
                    "[PENDING] Échec sur message id={} pour group={}: {}",
                    id,
                    group_id,
                    e
                );
                break; // Ordre strict : s'arrêter au premier échec
            }
        }
    }
    log::info!(
        "[PENDING] {}/{} messages traités pour group={}",
        processed,
        rows.len(),
        group_id
    );
    Ok(processed)
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
        let data_dir = app.path().app_data_dir().ok()?;
        let token = std::fs::read_to_string(data_dir.join("fcm_token.txt")).ok()?;
        let token = token.trim().to_string();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

/// Appelée depuis Kotlin via evaluateJavascript → window.__TAURI_INTERNALS__.invoke.
/// Persiste le token dans fcm_token.txt (Android) puis émet un événement Tauri
/// "fcm-token" vers le frontend — remplace le CustomEvent DOM précédent.
#[tauri::command]
fn notify_fcm_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::write(data_dir.join("fcm_token.txt"), &token).map_err(|e| e.to_string())?;
    }
    app.emit("fcm-token", token).map_err(|e| e.to_string())
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

/// Extrait le texte d'un `AppMessage` protobuf déchiffré.
/// - field 1 = TextMsg  (.content = field 1)
/// - field 2 = ReplyMsg (.content = field 1)
/// - field 4 = MediaMsg → texte générique
#[cfg(target_os = "android")]
fn extract_app_message_text(bytes: &[u8]) -> Option<String> {
    // TextMsg
    if let Some(text_msg) = find_length_delimited_field(bytes, 1) {
        if let Some(content) = find_length_delimited_field(&text_msg, 1) {
            if let Ok(s) = String::from_utf8(content) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    // ReplyMsg
    if let Some(reply_msg) = find_length_delimited_field(bytes, 2) {
        if let Some(content) = find_length_delimited_field(&reply_msg, 1) {
            if let Ok(s) = String::from_utf8(content) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    // MediaMsg
    if find_length_delimited_field(bytes, 4).is_some() {
        return Some("📎 Pièce jointe".to_string());
    }
    None
}

// ─── Fonction JNI appelée par CanariFirebaseMessagingService ─────────────────

/// Déchiffre un message MLS et extrait son texte.
/// Appelée directement depuis Kotlin via System.loadLibrary("mines_app_lib").
/// Retourne le texte du message, ou "" si le déchiffrement échoue.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessage<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let text = (|| -> Option<String> {
        let state_vec = env.convert_byte_array(&state_bytes).ok()?;
        let pin_str: String = env.get_string(&pin).ok()?.into();
        let group_id_str: String = env.get_string(&group_id).ok()?.into();
        let cipher_vec = env.convert_byte_array(&ciphertext).ok()?;

        // Crée un MlsManager temporaire depuis l'état sauvegardé (lecture seule du fichier).
        // Ce manager TEMPORAIRE avance son propre ratchet mais n'écrit rien sur disque.
        // Le MlsManager de l'app principale peut donc traiter le même message normalement.
        let mut manager =
            MlsManager::load_encrypted("_push_", "_push_", Some(state_vec), &pin_str).ok()?;

        let plaintext = manager
            .process_incoming_message(&group_id_str, &cipher_vec)
            .ok()??;

        extract_app_message_text(&plaintext)
    })()
    .unwrap_or_default();

    env.new_string(&text)
        .unwrap_or_else(|_| env.new_string("").unwrap())
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("mls.bin"), &data).map_err(|e| e.to_string())
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
    let data_dir = app.path().app_data_dir().ok()?;
    let bytes = std::fs::read(data_dir.join("push_context.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Lit {app_data_dir}/mls.bin et retourne son contenu chiffré.
/// Retourne None si le fichier n'existe pas (première installation).
/// Utilisé au démarrage sur mobile quand localStorage est vide (WebView nettoyé).
#[tauri::command]
fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
    let data_dir = app.path().app_data_dir().ok()?;
    let path = data_dir.join("mls.bin");
    std::fs::read(&path).ok()
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
            mls_manager: Mutex::new(None),
        })
        .setup(move |app| {
            // ── Pool SQLite pour les messages MLS en attente (gap recovery) ────────
            // Initialisé ici avec le chemin appData définitif.
            // block_on est sûr : setup() s'exécute avant le démarrage de l'event loop Tauri.
            let data_dir = app.path().app_data_dir().map_err(|e| format!("{e}"))?;
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
            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS pending_mls_messages (\
                        id         TEXT    PRIMARY KEY,\
                        group_id   TEXT    NOT NULL,\
                        ciphertext BLOB    NOT NULL,\
                        created_at INTEGER NOT NULL\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB schema: {e}"))?;
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
            creer_groupe,
            lister_groupes,
            oublier_groupe,
            obtenir_epoch,
            generer_key_package,
            generer_key_packages,
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
            notify_fcm_token,
            store_push_context,
            load_push_context,
            save_mls_state,
            delete_mls_state,
            load_mls_state,
            store_push_secret,
            clear_app_data,
            process_gap_messages,
            process_pending_mls_messages
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
