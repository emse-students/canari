//! Commandes Tauri pour le contexte push (FCM, VOIP, cache, outbox mirror).

use tauri::Manager;

/// Retourne le token FCM stocke par CanariFirebaseMessagingService.
/// Verifie que le Keystore Android peut lire le push secret (flag ecrit par CanariApplication).
/// Retourne `{"ok":true}` ou `{"ok":false,"reason":"no_context"|"no_secret"}`.
/// Sur desktop/web, toujours OK (pas de Keystore Android).
#[tauri::command]
pub(crate) fn check_push_secret_health(app: tauri::AppHandle) -> serde_json::Value {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(_) => return serde_json::json!({"ok": false, "reason": "no_context"}),
        };
        // Si push_context.json absent -> utilisateur non encore authentifie, situation normale.
        if !data_dir.join("push_context.json").exists() {
            return serde_json::json!({"ok": true});
        }
        // keystore_ok.flag ecrit par CanariApplication.checkKeystoreHealth() au demarrage.
        if data_dir.join("keystore_ok.flag").exists() {
            return serde_json::json!({"ok": true});
        }
        // pending_push_secret.txt -> migration en attente ; le service FCM peut dechiffrer
        // en fallback et le Keystore sera restaure au prochain demarrage de l'app.
        if data_dir.join("pending_push_secret.txt").exists() {
            log::info!("[PushHealth] pending_push_secret.txt present -> migration en attente, push fonctionnel");
            return serde_json::json!({"ok": true});
        }
        log::warn!(
            "[PushHealth] keystore_ok.flag et pending_push_secret.txt absents -> Keystore perdu"
        );
        serde_json::json!({"ok": false, "reason": "no_secret"})
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        serde_json::json!({"ok": true})
    }
}

/// Lit {app_data_dir}/fcm_token.txt (ecrit par le code natif Android/iOS).
#[tauri::command]
pub(crate) fn get_fcm_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[FCM] app_data_dir() failed: {e}");
                return None;
            }
        };
        match std::fs::read_to_string(data_dir.join("fcm_token.txt")) {
            Ok(token) => {
                let token = token.trim().to_string();
                if token.is_empty() {
                    log::warn!("[FCM] fcm_token.txt is empty");
                    None
                } else {
                    Some(token)
                }
            }
            Err(e) => {
                log::warn!("[FCM] read fcm_token.txt: {e}");
                None
            }
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        None
    }
}

/// Reads {app_data_dir}/voip_token.txt (written by the native iOS PushKit callback, WP-XP-5).
/// The frontend includes it in POST /api/mls/push/register so CallKit rings work from the very
/// first login (the native refresh-token path only covers later launches). Always None outside
/// iOS - Android has no PushKit.
#[tauri::command]
pub(crate) fn get_voip_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "ios")]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[VOIP] app_data_dir() failed: {e}");
                return None;
            }
        };
        match std::fs::read_to_string(data_dir.join("voip_token.txt")) {
            Ok(token) => {
                let token = token.trim().to_string();
                if token.is_empty() {
                    None
                } else {
                    Some(token)
                }
            }
            Err(_) => None,
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        None
    }
}

/// Lit {app_data_dir}/fcm_message_cache.ndjson, efface le fichier et retourne les entrees.
/// Appele au boot juste apres login pour pre-injecter les messages deja dechiffres
/// lors de la reception FCM - evite d'attendre la sync MLS complete (~10s).
#[tauri::command]
pub(crate) fn read_and_clear_fcm_cache(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[FCM_CACHE] app_data_dir() failed: {e}");
            return vec![];
        }
    };
    let path = data_dir.join("fcm_message_cache.ndjson");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => {
            log::warn!("[FCM_CACHE] lecture: {e}");
            return vec![];
        }
    };
    // Effacer immediatement pour eviter les doublons au prochain boot
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[FCM_CACHE] suppression: {e}");
    }
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    log::info!("[FCM_CACHE] {} entree(s) lue(s)", entries.len());
    entries
}

/// Reecrit {app_data_dir}/outbox_pending.ndjson depuis l'instantanse courant de l'outbox.
/// Chaque entree porte le proto AppMessage *en clair* (base64) que le service Android chiffrera
/// contre l'epoch vivant via `nativeSendMessageBackground`. Fichier app-prive en clair, coherent
/// avec push_context.json / fcm_message_cache.ndjson. Reecriture complete (pas d'append).
#[tauri::command]
pub(crate) fn store_outbox_mirror(
    app: tauri::AppHandle,
    entries: Vec<serde_json::Value>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("outbox_pending.ndjson");
    // File vide -> supprimer le fichier pour que le natif voie "rien en attente" sans le parser.
    if entries.is_empty() {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("[OUTBOX_MIRROR] suppression: {e}");
            }
        }
        return Ok(());
    }
    let body = entries
        .iter()
        .map(|e| e.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, body + "\n").map_err(|e| e.to_string())?;
    log::debug!("[OUTBOX_MIRROR] {} entree(s) ecrite(s)", entries.len());
    Ok(())
}

/// Merges one channel epoch key into {app_data_dir}/channel_keys.json so the Android background
/// service can AES-256-GCM-decrypt channel-message pushes (app killed). The file is a JSON map
/// `channelId -> { keyVersion -> base64(rawKey) }`; the raw 32-byte epoch key never leaves the
/// device. App-private plaintext storage, consistent with push_context.json / mls.bin.
#[tauri::command]
pub(crate) fn store_channel_key(
    app: tauri::AppHandle,
    channel_id: String,
    key_version: u32,
    key_b64: String,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("channel_keys.json");

    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_else(|_| serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(format!("read channel_keys.json: {e}")),
    };

    let map = root
        .as_object_mut()
        .ok_or("channel_keys.json is not an object")?;
    let channel_entry = map
        .entry(channel_id)
        .or_insert_with(|| serde_json::json!({}));
    if let Some(versions) = channel_entry.as_object_mut() {
        versions.insert(key_version.to_string(), serde_json::Value::String(key_b64));
    }

    std::fs::write(&path, root.to_string()).map_err(|e| e.to_string())?;
    log::debug!("[CHANNEL_KEYS] stored epoch key (version {key_version})");
    Ok(())
}

/// Lit {app_data_dir}/outbox_sent.ndjson (un messageId par ligne, ecrit par le service Android
/// apres un envoi background reussi), efface le fichier et retourne les ids. Appele au login pour
/// supprimer de l'outbox les messages deja livres en arriere-plan.
#[tauri::command]
pub(crate) fn read_and_clear_outbox_sent(app: tauri::AppHandle) -> Vec<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[OUTBOX_MIRROR] app_data_dir() failed: {e}");
            return vec![];
        }
    };
    let path = data_dir.join("outbox_sent.ndjson");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => {
            log::warn!("[OUTBOX_MIRROR] lecture sent: {e}");
            return vec![];
        }
    };
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[OUTBOX_MIRROR] suppression sent: {e}");
    }
    let ids: Vec<String> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    log::info!(
        "[OUTBOX_MIRROR] {} envoi(s) background a reconcilier",
        ids.len()
    );
    ids
}

/// Reads {app_data_dir}/pending_call_accept.json (written by the native iOS CallKit answer
/// handler while the webview may be locked/not yet running), deletes it and returns the raw
/// JSON string ({"groupId","callId","hasVideo","acceptedAt"}). The frontend polls this at
/// resume/login to auto-accept the call the user already answered on the system UI (WP-XP-5).
/// Returns null when there is no pending accept.
#[tauri::command]
pub(crate) fn read_and_clear_pending_call_accept(app: tauri::AppHandle) -> Option<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[CALL_ACCEPT] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join("pending_call_accept.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[CALL_ACCEPT] read failed: {e}");
            return None;
        }
    };
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[CALL_ACCEPT] delete failed: {e}");
    }
    log::info!("[CALL_ACCEPT] pending CallKit accept found");
    Some(content)
}

/// Sauvegarde le PIN et le contexte de session dans {app_data_dir}/push_context.json
/// pour que CanariFirebaseMessagingService puisse dechiffrer les notifications push.
/// `push_token` est un Bearer token long-lived (ou vide sur desktop) utilise par le
/// service Kotlin pour fetcher le proto MLS quand il n'est pas inclus inline dans FCM.
#[tauri::command]
pub(crate) fn store_push_context(
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

/// Lit {app_data_dir}/push_context.json et retourne son contenu.
/// Utilise pour restaurer le device ID quand localStorage est vide (reinstall Android).
#[tauri::command]
pub(crate) fn load_push_context(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[PushCtx] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join("push_context.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[PushCtx] read push_context.json: {e}");
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("[PushCtx] parse push_context.json: {e}");
            None
        }
    }
}

/// Ecrit le pushSecret recu du backend dans {app_data_dir}/pending_push_secret.txt.
/// CanariApplication.processPendingPushSecret() le lit au prochain demarrage,
/// le chiffre dans Android Keystore, puis supprime le fichier.
#[tauri::command]
pub(crate) fn store_push_secret(secret: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        std::fs::write(data_dir.join("pending_push_secret.txt"), &secret)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (secret, app);
    }
    Ok(())
}
