//! Tauri commands for the push context (FCM, VoIP, cache, outbox mirror).

use mls_core::DeviceKeyStore;
use tauri::Manager;

use crate::keystore_bridge::PluginDeviceKeyStore;

/// Checks that the Android Keystore can read the push secret (flag written by CanariApplication).
/// Returns `{"ok":true}` or `{"ok":false,"reason":"no_context"|"no_secret"}`.
/// Always OK on desktop/web (no Android Keystore).
#[tauri::command]
pub(crate) fn check_push_secret_health(app: tauri::AppHandle) -> serde_json::Value {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(_) => return serde_json::json!({"ok": false, "reason": "no_context"}),
        };
        // No push_context.json -> user not authenticated yet, which is normal.
        if !data_dir.join("push_context.json").exists() {
            return serde_json::json!({"ok": true});
        }
        // keystore_ok.flag is written by the native health check at startup
        // (Android: CanariApplication.checkKeystoreHealth, iOS: CanariCheckKeystoreHealth).
        // It probes the push secret, not the device key, but the failure mode it detects -
        // the platform keystore losing its entries - takes both down together, so the flag
        // stands in for either. WP-SEC-1 removed the device key from push_context.json, so
        // there is no longer a JSON field to cross-check here.
        if data_dir.join("keystore_ok.flag").exists() {
            return serde_json::json!({"ok": true});
        }
        // pending_push_secret.txt -> migration pending; the FCM service can still decrypt and the
        // Keystore is restored at the next app startup.
        if data_dir.join("pending_push_secret.txt").exists() {
            log::info!(
                "[PushHealth] pending_push_secret.txt present -> migration pending, push still works"
            );
            return serde_json::json!({"ok": true});
        }
        log::warn!(
            "[PushHealth] neither keystore_ok.flag nor pending_push_secret.txt -> Keystore lost"
        );
        serde_json::json!({"ok": false, "reason": "no_secret"})
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        serde_json::json!({"ok": true})
    }
}

/// Reads {app_data_dir}/fcm_token.txt (written by the native Android/iOS code).
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

/// Reads {app_data_dir}/fcm_message_cache.ndjson, clears the file and returns the entries.
/// Called at boot right after login to pre-inject messages already decrypted when the FCM push
/// arrived - avoids waiting for the full MLS sync (~10s).
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
            log::warn!("[FCM_CACHE] read failed: {e}");
            return vec![];
        }
    };
    // Clear immediately so the next boot does not replay the same entries.
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[FCM_CACHE] delete failed: {e}");
    }
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    log::info!("[FCM_CACHE] {} entry/entries read", entries.len());
    entries
}

/// Rewrites {app_data_dir}/outbox_pending.ndjson from the current outbox snapshot.
/// Each entry carries the AppMessage proto *in the clear* (base64), which the Android service
/// encrypts against the live epoch via `nativeSendMessageBackground`. App-private plaintext file,
/// consistent with push_context.json / fcm_message_cache.ndjson. Full rewrite, never an append.
#[tauri::command]
pub(crate) fn store_outbox_mirror(
    app: tauri::AppHandle,
    entries: Vec<serde_json::Value>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("outbox_pending.ndjson");
    // Empty queue -> delete the file so the native side sees "nothing pending" without parsing it.
    if entries.is_empty() {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("[OUTBOX_MIRROR] delete failed: {e}");
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
    log::debug!("[OUTBOX_MIRROR] {} entry/entries written", entries.len());
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

/// Reads {app_data_dir}/outbox_sent.ndjson (one messageId per line, written by the Android service
/// after a successful background send), clears the file and returns the ids. Called at login to
/// drop from the outbox the messages already delivered in the background.
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

/// Writes the session context to `{app_data_dir}/push_context.json` so the native background
/// handlers (Android `CanariFirebaseMessagingService`, iOS NSE) can decrypt push notifications.
/// `push_token` is a long-lived Bearer token (empty on desktop) the native side uses to fetch
/// the MLS proto when FCM did not carry it inline.
///
/// The PIN is never seen here. `device_key_b64` is the already-derived 32-byte device key
/// (see `$lib/crypto/deviceKey`), which is the ONLY value that can decrypt `mls.bin`
/// (`[nonce (12) || ciphertext]`, ChaCha20-Poly1305 direct).
///
/// The key is also mirrored into the platform keystore under
/// `mls_device_key_{user_id}_{device_id}` so the biometric login path
/// (`load_encrypted_with_keystore` path A) can retrieve it without the PIN. That write is
/// best-effort: if the keystore rejects it, push still works from the JSON file.
#[tauri::command]
pub(crate) fn store_push_context(
    device_key_b64: String,
    user_id: String,
    device_id: String,
    base_url: String,
    push_token: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    // Validate before writing: a malformed key would poison the keystore,
    // and the failure would only surface much later as an undecryptable notification.
    let key_bytes = mls_core::crypto::decode_base64_to_32_bytes(device_key_b64.trim())
        .map_err(|e| format!("invalid device_key_b64: {e}"))?;

    let alias = format!("mls_device_key_{user_id}_{device_id}");
    let keystore = PluginDeviceKeyStore::new(app.clone());
    // WP-SEC-1: the keystore is now the ONLY copy of the device key (no JSON fallback).
    // A failed write means background decrypt is dead — return Err, do not log::warn!.
    keystore
        .store_device_key(&key_bytes, &alias)
        .map_err(|e| format!("keystore write failed (background decrypt will not work): {e}"))?;

    let json = serde_json::json!({
        "userId": user_id,
        "deviceId": device_id,
        "baseUrl": base_url,
        "pushToken": push_token.unwrap_or_default(),
    });
    std::fs::write(data_dir.join("push_context.json"), json.to_string()).map_err(|e| e.to_string())
}

/// Reads {app_data_dir}/push_context.json and returns its contents.
/// Used to restore the device ID when localStorage is empty (Android reinstall).
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

/// Writes the pushSecret received from the backend to {app_data_dir}/pending_push_secret.txt.
/// CanariApplication.processPendingPushSecret() reads it at the next startup, encrypts it into the
/// Android Keystore, then deletes the file.
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
