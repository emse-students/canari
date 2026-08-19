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

/// Reads {app_data_dir}/outbox_pending.ndjson WITHOUT clearing it, so the frontend can adopt back
/// into its own outbox any entry the native side queued on its own (a notification quick reply
/// that did not deliver). Not clearing is deliberate: the file is authoritative for the background
/// service until the next `store_outbox_mirror`, which rewrites it from the adopted TS queue.
#[tauri::command]
pub(crate) fn read_outbox_mirror(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[OUTBOX_MIRROR] app_data_dir() failed: {e}");
            return vec![];
        }
    };
    let path = data_dir.join("outbox_pending.ndjson");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => {
            log::warn!("[OUTBOX_MIRROR] mirror read failed: {e}");
            return vec![];
        }
    };
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    log::debug!(
        "[OUTBOX_MIRROR] {} mirror entry/entries read",
        entries.len()
    );
    entries
}

/// How many Graine sessions per channel the mirror keeps. Mirrors
/// `GRAINE_NATIVE_MIRROR_SESSIONS_PER_CHANNEL` in `graineConstants.ts`.
const GRAINE_MIRROR_SESSIONS_PER_CHANNEL: usize = 20;

/// Merges one Graine seed into {app_data_dir}/graine_seeds.json so the background push service can
/// derive a message key with the app killed. The file is a JSON map
/// `channelId -> { sessionId -> { seed: base64, createdAt: epochMs } }`.
///
/// **Bounded, unlike the epoch mirror it replaced.** Epoch keys were few and a whole channel's
/// worth could be kept; seeds accumulate for ever, in a file rewritten on every rotation, which is
/// unbounded growth waiting for a year to pass. Only the newest
/// [`GRAINE_MIRROR_SESSIONS_PER_CHANNEL`] are kept, because this file has exactly one job -
/// decrypting an INCOMING push - while the durable set lives in the local store. A seed too old to
/// be mirrored is not a failure: the notification degrades to a generic "new message", which is the
/// existing behaviour and the correct one.
///
/// App-private plaintext storage, consistent with push_context.json / mls.bin.
#[tauri::command]
pub(crate) fn store_graine_seed(
    app: tauri::AppHandle,
    channel_id: String,
    session_id: String,
    seed_b64: String,
    created_at: i64,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("graine_seeds.json");

    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_else(|_| serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(format!("read graine_seeds.json: {e}")),
    };

    let map = root
        .as_object_mut()
        .ok_or("graine_seeds.json is not an object")?;
    let channel_entry = map
        .entry(channel_id)
        .or_insert_with(|| serde_json::json!({}));
    let sessions = channel_entry
        .as_object_mut()
        .ok_or("channel entry is not an object")?;
    sessions.insert(
        session_id,
        serde_json::json!({ "seed": seed_b64, "createdAt": created_at }),
    );

    let dropped = prune_graine_sessions(sessions);

    std::fs::write(&path, root.to_string()).map_err(|e| e.to_string())?;
    log::debug!("[GRAINE_MIRROR] stored seed, dropped {dropped} older session(s)");
    Ok(())
}

/// Keeps the newest [`GRAINE_MIRROR_SESSIONS_PER_CHANNEL`] sessions, returning how many were
/// dropped. Ordered by `createdAt`, and a session missing one sorts oldest: a malformed entry is
/// the first thing to go, never something that survives a bound it cannot be measured against.
fn prune_graine_sessions(sessions: &mut serde_json::Map<String, serde_json::Value>) -> usize {
    if sessions.len() <= GRAINE_MIRROR_SESSIONS_PER_CHANNEL {
        return 0;
    }
    let mut by_age: Vec<(String, i64)> = sessions
        .iter()
        .map(|(id, entry)| {
            let created = entry.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            (id.clone(), created)
        })
        .collect();
    // Newest first, ties broken by id so the outcome is the same on every device.
    by_age.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let doomed: Vec<String> = by_age
        .split_off(GRAINE_MIRROR_SESSIONS_PER_CHANNEL)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    for id in &doomed {
        sessions.remove(id);
    }
    doomed.len()
}

/// Drops one channel's whole entry from {app_data_dir}/graine_seeds.json.
///
/// Called when a community leaves this device - the member left it, was removed from it, or it was
/// deleted. The durable store is purged at the same moment; without this the mirror would keep
/// plaintext seeds for salons the device can no longer even list, and the bound that trims the file
/// only ever runs on a channel something is still being WRITTEN to.
///
/// Absent file or absent channel is success, not an error: there is nothing to forget, which is the
/// state the caller asked for.
#[tauri::command]
pub(crate) fn forget_graine_channel(
    app: tauri::AppHandle,
    channel_id: String,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("graine_seeds.json");

    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_else(|_| serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read graine_seeds.json: {e}")),
    };

    let map = root
        .as_object_mut()
        .ok_or("graine_seeds.json is not an object")?;
    if map.remove(&channel_id).is_none() {
        return Ok(());
    }

    std::fs::write(&path, root.to_string()).map_err(|e| e.to_string())?;
    log::debug!("[GRAINE_MIRROR] forgot every seed of one channel");
    Ok(())
}

/// Drops the named Graine sessions from {app_data_dir}/graine_seeds.json, wherever they sit.
///
/// Called by the retention sweep, which works one SESSION at a time in channels the device is still
/// a member of - so `forget_graine_channel` is the wrong shape here, and the per-channel bound that
/// trims this file is not a substitute: it only ever runs on a channel something is still being
/// WRITTEN to, so a quiet salon keeps up to twenty plaintext seeds for messages the server deleted
/// a year ago.
///
/// A channel left with no sessions has its entry removed too, so the file shrinks to nothing rather
/// than to a map of empty objects.
///
/// Absent file, absent session: success. The caller asked for an end state and that is the state.
#[tauri::command]
pub(crate) fn forget_graine_sessions(
    app: tauri::AppHandle,
    session_ids: Vec<String>,
) -> Result<usize, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("graine_seeds.json");

    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_else(|_| serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read graine_seeds.json: {e}")),
    };

    let map = root
        .as_object_mut()
        .ok_or("graine_seeds.json is not an object")?;

    let (removed, emptied) = remove_graine_sessions(map, &session_ids);
    if removed == 0 && emptied == 0 {
        return Ok(0);
    }
    std::fs::write(&path, root.to_string()).map_err(|e| e.to_string())?;
    log::debug!(
        "[GRAINE_MIRROR] forgot {removed} expired session(s), {emptied} channel(s) dropped"
    );
    Ok(removed)
}

/// Removes the named sessions from every channel entry, dropping channels left with none.
///
/// Split out of the command because that is the whole decision: the command around it only reads a
/// file, writes it back, and cannot be reached without a running Tauri app.
///
/// @returns how many sessions went, and how many channel entries were dropped for being empty.
fn remove_graine_sessions(
    map: &mut serde_json::Map<String, serde_json::Value>,
    session_ids: &[String],
) -> (usize, usize) {
    let doomed: std::collections::HashSet<&str> = session_ids.iter().map(String::as_str).collect();
    let mut removed = 0usize;
    let mut emptied: Vec<String> = Vec::new();
    for (channel_id, entry) in map.iter_mut() {
        let Some(sessions) = entry.as_object_mut() else {
            // A malformed entry is left exactly as it is: nothing here can tell whether it holds
            // seeds, and guessing either way is worse than leaving it for the next writer.
            continue;
        };
        let before = sessions.len();
        sessions.retain(|session_id, _| !doomed.contains(session_id.as_str()));
        removed += before - sessions.len();
        if sessions.is_empty() {
            emptied.push(channel_id.clone());
        }
    }
    for channel_id in &emptied {
        map.remove(channel_id);
    }
    (removed, emptied.len())
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
            log::warn!("[OUTBOX_MIRROR] sent read failed: {e}");
            return vec![];
        }
    };
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[OUTBOX_MIRROR] sent delete failed: {e}");
    }
    let ids: Vec<String> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    log::info!(
        "[OUTBOX_MIRROR] {} background send(s) to reconcile",
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
    // The language CHOSEN IN THE APP, not the one the OS is set to. Every notification the native
    // side composes while the app is closed is written in it - see `set_push_context_locale` for
    // why it is mirrored here rather than read from the platform.
    locale: Option<String>,
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

    // This call REPLACES the file, so a locale already mirrored must survive a caller that does not
    // know one - otherwise a device-key refresh silently reverts every background notification to
    // the default language until the user next changes it by hand.
    let locale = locale
        .filter(|l| !l.trim().is_empty())
        .or_else(|| read_push_context_locale(&data_dir))
        .unwrap_or_else(|| DEFAULT_PUSH_LOCALE.to_string());

    let json = serde_json::json!({
        "userId": user_id,
        "deviceId": device_id,
        "baseUrl": base_url,
        "pushToken": push_token.unwrap_or_default(),
        "locale": locale,
    });
    std::fs::write(data_dir.join("push_context.json"), json.to_string()).map_err(|e| e.to_string())
}

/// The language a background notification falls back to when nothing has been mirrored yet.
/// Matches Paraglide's `baseLocale`.
const DEFAULT_PUSH_LOCALE: &str = "fr";

/// Reads just the mirrored locale out of `push_context.json`, or `None` when the file is absent,
/// unreadable or carries no locale (every device before this field existed).
fn read_push_context_locale(data_dir: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(data_dir.join("push_context.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let locale = value.get("locale")?.as_str()?.trim().to_string();
    (!locale.is_empty()).then_some(locale)
}

/// Mirrors the app's CHOSEN language so the native background side can write a notification in it.
///
/// WHY A MIRROR AT ALL. Android's `R.string` resolves against the OS locale and iOS's
/// `preferredLocalizations` against the bundle's - neither is the Français/English choice made
/// inside the app, so a French phone running the app in English produced French notifications.
/// The app's choice lives in the WebView, which is not running when a push arrives; the only way
/// the native side can honour it is if it was written down while the app was open. This is the
/// same posture as `graine_seeds.json`: the WebView is the source of truth, the file is what
/// survives it being closed.
///
/// Patches one key rather than rewriting the file: the locale changes on a settings toggle, which
/// knows nothing about the device key, the push token or the base URL.
#[tauri::command]
pub(crate) fn set_push_context_locale(locale: String, app: tauri::AppHandle) -> Result<(), String> {
    let locale = locale.trim().to_string();
    if locale.is_empty() {
        return Err("locale is empty".to_string());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("push_context.json");

    // Absent file: the user changed language before ever logging in. Writing a lone locale here
    // would be a push context with no device key, which every reader treats as unusable - so this
    // is not an error, and `store_push_context` picks the value up at login through the read above.
    let mut ctx: serde_json::Map<String, serde_json::Value> = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => return Ok(()),
    };
    ctx.insert("locale".to_string(), serde_json::Value::String(locale));
    std::fs::write(&path, serde_json::Value::Object(ctx).to_string()).map_err(|e| e.to_string())
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

#[cfg(test)]
mod graine_mirror_tests {
    use super::{
        prune_graine_sessions, remove_graine_sessions, GRAINE_MIRROR_SESSIONS_PER_CHANNEL,
    };

    fn seed(created_at: i64) -> serde_json::Value {
        serde_json::json!({ "seed": "c2VlZA==", "createdAt": created_at })
    }

    #[test]
    fn forgets_named_sessions_across_channels_and_drops_empty_ones() {
        let mut root = serde_json::json!({
            "chan-a": { "s-1": seed(1), "s-2": seed(2) },
            "chan-b": { "s-3": seed(3) },
        });
        let map = root.as_object_mut().unwrap();

        // The sweep names sessions, not channels: they sit wherever they sit.
        let (removed, emptied) =
            remove_graine_sessions(map, &["s-1".to_string(), "s-3".to_string()]);

        assert_eq!(removed, 2);
        assert_eq!(emptied, 1);
        // chan-b held nothing else, so the entry goes rather than staying as an empty object.
        assert!(!map.contains_key("chan-b"));
        assert_eq!(map["chan-a"].as_object().unwrap().len(), 1);
        assert!(map["chan-a"].get("s-2").is_some());
    }

    #[test]
    fn an_id_naming_nothing_changes_nothing() {
        let mut root = serde_json::json!({ "chan-a": { "s-1": seed(1) } });
        let map = root.as_object_mut().unwrap();

        let (removed, emptied) = remove_graine_sessions(map, &["ghost".to_string()]);

        assert_eq!((removed, emptied), (0, 0));
        assert!(map["chan-a"].get("s-1").is_some());
    }

    #[test]
    fn keeps_the_newest_and_drops_a_session_with_no_date_first() {
        let mut sessions = serde_json::Map::new();
        for i in 0..GRAINE_MIRROR_SESSIONS_PER_CHANNEL {
            sessions.insert(format!("s-{i}"), seed(1_000 + i as i64));
        }
        // Undated, so it sorts oldest: a malformed entry is the first thing to go, never something
        // that survives a bound it cannot be measured against.
        sessions.insert(
            "s-undated".to_string(),
            serde_json::json!({ "seed": "c2VlZA==" }),
        );

        let dropped = prune_graine_sessions(&mut sessions);

        assert_eq!(dropped, 1);
        assert_eq!(sessions.len(), GRAINE_MIRROR_SESSIONS_PER_CHANNEL);
        assert!(!sessions.contains_key("s-undated"));
    }
}
