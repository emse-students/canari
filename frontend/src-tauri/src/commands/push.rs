//! Tauri commands for the push context (FCM, VoIP, cache, outbox mirror).

use tauri::Manager;

use crate::commands::at_rest_key::GuardRefusal;
use crate::keystore_bridge::{KeyEntryError, PluginDeviceKeyStore};
use crate::native_cache::{open_file, open_line, seal_file, CacheKey, Opened, Purpose};

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

/// Reads {app_data_dir}/push_diagnostic.txt - the native layer's own account of WHY it has no
/// push token to hand over.
///
/// `get_fcm_token` returning None says only that there is no token, and that single word covers
/// causes needing opposite fixes (see canari_push.mm): APNs never answering at all, versus APNs
/// answering and FCM refusing. The native side knows which and writes it here, so the report the
/// client sends to the server names the cause rather than the symptom. None on the platforms with
/// nothing finer to say, and None in the ordinary case where nothing has failed.
#[tauri::command]
pub(crate) fn get_push_diagnostic(app: tauri::AppHandle) -> Option<String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[FCM] app_data_dir() failed: {e}");
                return None;
            }
        };
        match std::fs::read_to_string(data_dir.join("push_diagnostic.txt")) {
            Ok(reason) => {
                let reason = reason.trim().to_string();
                if reason.is_empty() {
                    log::warn!("[FCM] push_diagnostic.txt is empty");
                    None
                } else {
                    log::debug!("[FCM] push diagnostic: {reason}");
                    Some(reason)
                }
            }
            // Absent is the ordinary case: the native layer writes this file only when it fails
            // to obtain a token, and deletes it the moment one arrives. Anything else is not.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                log::warn!("[FCM] read push_diagnostic.txt: {e}");
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

/// Reads an app-private NDJSON hand-off file, DELETES it, and returns its parsed lines.
///
/// The native notification paths (Android service, iOS NSE and app extension) leave facts for the
/// frontend in app-private NDJSON files, and every one of them wants the same three properties:
/// an absent file is "nothing to say" and not an error, a line that will not parse is dropped
/// rather than failing the batch, and the file is REMOVED before the caller is answered so no boot
/// can replay it. Two readers spelled that out separately; a third was about to.
///
/// `tag` names the caller in the logs, and is the only thing that differs between them.
fn take_ndjson_handoff(
    app: &tauri::AppHandle,
    file_name: &str,
    tag: &str,
) -> Vec<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[{tag}] app_data_dir() failed: {e}");
            return vec![];
        }
    };
    let path = data_dir.join(file_name);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => {
            log::warn!("[{tag}] read failed: {e}");
            return vec![];
        }
    };
    // Clear immediately so the next boot does not replay the same entries.
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[{tag}] delete failed: {e}");
    }
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    log::info!("[{tag}] {} entry/entries read", entries.len());
    entries
}

/// The file the native push paths write (Android `appendFcmCacheEntry`, iOS `canari_push.mm`).
const FCM_CACHE_FILE: &str = "fcm_message_cache.ndjson";
/// What [`take_fcm_cache_in`] moved aside is `<prefix><generation>.ndjson`, kept until the
/// frontend has persisted it ([`ack_fcm_cache_in`]). One file per take, never appended to.
pub(crate) const FCM_CACHE_TAKEN_PREFIX: &str = "fcm_message_cache.taken.";

/// One taken file, as the ack must find it again: its name, and its size when it was read.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FcmTakenFile {
    name: String,
    bytes: u64,
}

/// What [`take_fcm_cache_in`] hands over: the entries, and the files they were read from.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FcmCacheTake {
    entries: Vec<serde_json::Value>,
    files: Vec<FcmTakenFile>,
}

/// The generation in a taken file's name, or `None` for any other file.
fn taken_generation(name: &str) -> Option<u64> {
    name.strip_prefix(FCM_CACHE_TAKEN_PREFIX)?
        .strip_suffix(".ndjson")?
        .parse()
        .ok()
}

/// Every taken file in `dir`, oldest generation first.
fn taken_files(dir: &std::path::Path) -> Vec<(u64, String)> {
    let mut found: Vec<(u64, String)> = match std::fs::read_dir(dir) {
        Ok(it) => it
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                taken_generation(&name).map(|g| (g, name))
            })
            .collect(),
        Err(e) => {
            log::warn!("[FCM_CACHE] cannot list the data directory: {e}");
            vec![]
        }
    };
    found.sort();
    found
}

/// TAKES the push cache WITHOUT deleting it: the live file is RENAMED to a new taken generation and
/// every taken file is read; they are deleted only by [`ack_fcm_cache_in`], once the frontend has
/// written what they held.
///
/// WHY TWO STEPS. This used to delete the file before answering, so a process death between that
/// delete and the frontend's `saveMessage` lost the entries for good - and for a notification quick
/// reply the cache is the ONLY local record of a message this device sent
/// (`CanariNotificationActionReceiver.handleReply`).
///
/// WHY A RENAME AND NEVER A COPY. The native writers keep writing the live path (Android rewrites
/// it whole, iOS drains its App Group into it). A rename is atomic: a write lands either in the
/// renamed file or in the next live one. A write still finishing into the renamed inode after it was
/// read makes that file LARGER than the size handed over, and the ack then keeps it for the next
/// take - nothing is read and then deleted unread.
///
/// A taken file older than this take's own is a take that was never acknowledged - the process died
/// before the frontend persisted it: it is handed over again, first. Replaying one is harmless:
/// `consumeFcmCache` never downgrades a row and its writes are puts by id. The frontend runs one take
/// at a time, so that is the only way such a file exists.
///
/// SEALED LINES (`native_cache`, since 2026-10-22). Each line the native writers append is sealed
/// under the install's cache key; a line an older build wrote is plain JSON, read as such, and the
/// take-then-ack above is its migration: it is consumed into the frontend's sealed store and the
/// file deleted. A sealed line the key does not open is dropped and counted - the key never rotates,
/// so no later take would open it. With no key, a file holding a sealed line is NOT handed over, so
/// not acknowledged: it waits for a take that can read it.
pub(crate) fn take_fcm_cache_in(dir: &std::path::Path, key: Option<&CacheKey>) -> FcmCacheTake {
    let existing = taken_files(dir);
    let next = existing.last().map_or(0, |(g, _)| g + 1);
    let own = format!("{FCM_CACHE_TAKEN_PREFIX}{next}.ndjson");
    match std::fs::rename(dir.join(FCM_CACHE_FILE), dir.join(&own)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[FCM_CACHE] could not move the live cache aside: {e}"),
    }
    if !existing.is_empty() {
        log::warn!(
            "[FCM_CACHE] {} taken file(s) were never acknowledged - the process died before the \
             frontend persisted them; handed over again",
            existing.len()
        );
    }
    let mut entries = Vec::new();
    let mut files = Vec::new();
    for (_, name) in taken_files(dir) {
        let bytes = match std::fs::read(dir.join(&name)) {
            Ok(b) => b,
            Err(e) => {
                // Not handed over, so not acknowledged: it stays for the next take.
                log::warn!("[FCM_CACHE] taken file {name} unreadable, kept: {e}");
                continue;
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let Some(key) = key else {
            if lines
                .iter()
                .any(|l| l.starts_with(crate::native_cache::LINE_PREFIX))
            {
                log::error!("[FCM_CACHE] taken file {name} holds sealed lines and no cache key was read - kept");
                continue;
            }
            entries.extend(
                lines
                    .iter()
                    .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()),
            );
            files.push(FcmTakenFile {
                name,
                bytes: bytes.len() as u64,
            });
            continue;
        };
        let mut unopenable = 0usize;
        for line in lines {
            match open_line(key, Purpose::PushCache, line) {
                Ok(opened) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&opened.into_inner()) {
                        entries.push(v);
                    }
                }
                Err(_) => unopenable += 1,
            }
        }
        if unopenable > 0 {
            log::error!(
                "[FCM_CACHE] taken file {name}: {unopenable} sealed line(s) this install's key does \
                 not open, dropped"
            );
        }
        files.push(FcmTakenFile {
            name,
            bytes: bytes.len() as u64,
        });
    }
    if !files.is_empty() {
        log::info!(
            "[FCM_CACHE] {} entry/entries taken from {} file(s), deleted only once acknowledged",
            entries.len(),
            files.len()
        );
    }
    FcmCacheTake { entries, files }
}

/// Deletes each taken file the frontend persisted - but only while it is still exactly the size it
/// was read at. A larger one received a native write after it was read; it is kept, and the next
/// take hands it over again (harmless) rather than deleting a line nobody read. A name that is not
/// a taken file is refused: this deletes nothing else.
///
/// Returns how many files were deleted.
pub(crate) fn ack_fcm_cache_in(dir: &std::path::Path, files: &[FcmTakenFile]) -> usize {
    let mut deleted = 0;
    for f in files {
        if taken_generation(&f.name).is_none() {
            log::error!("[FCM_CACHE] ack refused for a name that is not a taken file");
            continue;
        }
        let path = dir.join(&f.name);
        match std::fs::metadata(&path) {
            Ok(m) if m.len() == f.bytes => match std::fs::remove_file(&path) {
                Ok(()) => deleted += 1,
                Err(e) => log::warn!("[FCM_CACHE] taken file {} delete failed: {e}", f.name),
            },
            Ok(m) => log::warn!(
                "[FCM_CACHE] taken file {} kept: {} bytes, read at {} - a native write landed after \
                 the read, the next take hands it over",
                f.name,
                m.len(),
                f.bytes
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[FCM_CACHE] taken file {} stat failed: {e}", f.name),
        }
    }
    log::info!(
        "[FCM_CACHE] acknowledged: {deleted} of {} taken file(s) deleted",
        files.len()
    );
    deleted
}

/// [`take_fcm_cache_in`] on the app's data directory. Called at boot right after login to
/// pre-inject messages already decrypted when the FCM push arrived - avoids waiting for the full
/// MLS sync (~10s).
///
/// Async because the cache key is a keystore plugin read, which must not run on the main thread.
/// It is also where the plaintext files an older build left are sealed, once per process
/// (`native_cache::migrate_legacy_files`): the first thing the app does after login.
#[tauri::command]
pub(crate) async fn take_fcm_cache(app: tauri::AppHandle) -> FcmCacheTake {
    let empty = || FcmCacheTake {
        entries: vec![],
        files: vec![],
    };
    let taken = tauri::async_runtime::spawn_blocking(move || {
        let dir = match app.path().app_data_dir() {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("[FCM_CACHE] app_data_dir() failed: {e}");
                return None;
            }
        };
        #[cfg(mobile)]
        let key = match crate::native_cache::app_cache_key(&app) {
            Ok(key) => {
                crate::native_cache::migrate_legacy_files(&dir, &key);
                Some(key)
            }
            // Logged by `app_cache_key`; plaintext lines are still taken, sealed ones wait.
            Err(_) => None,
        };
        #[cfg(not(mobile))]
        let key: Option<CacheKey> = None;
        Some(take_fcm_cache_in(&dir, key.as_ref()))
    })
    .await;
    match taken {
        Ok(Some(t)) => t,
        Ok(None) => empty(),
        Err(e) => {
            log::error!("[FCM_CACHE] take task failed: {e}");
            empty()
        }
    }
}

/// [`ack_fcm_cache_in`] on the app's data directory, called by `consumeFcmCache` once the entries
/// it was handed have been written.
#[tauri::command]
pub(crate) fn ack_fcm_cache(app: tauri::AppHandle, files: Vec<FcmTakenFile>) -> usize {
    match app.path().app_data_dir() {
        Ok(dir) => ack_fcm_cache_in(&dir, &files),
        Err(e) => {
            log::warn!("[FCM_CACHE] app_data_dir() failed: {e}");
            0
        }
    }
}

/// Reads {app_data_dir}/read_watermarks.ndjson, clears the file and returns the entries.
///
/// WHAT THIS CHANNEL EXISTS FOR. Marking a conversation read from the notification shade is two
/// separate facts, and only one of them travelled: the `read_watermark` frame reaches PEERS and
/// our other devices through the outbox, but nothing told THIS device's own database, whose
/// conversation row is what draws the badge. So the user acknowledged a conversation from the
/// shade, opened the app, and found it unread again - which is indistinguishable from the action
/// having done nothing at all.
///
/// Each line is `{"groupId": "...", "at": <ms>}`, written by the Android action receiver and the
/// iOS notification-response handler at the instant they queue the frame, and merged into the
/// conversations at the next login by `consumeNativeReadWatermarks` (readWatermarkCache.ts). The
/// merge is `max`, so replaying one is harmless - but the file is cleared here anyway, because a
/// hand-off that accumulates is a hand-off that eventually costs a boot.
#[tauri::command]
pub(crate) fn read_and_clear_read_watermarks(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    take_ndjson_handoff(&app, "read_watermarks.ndjson", "READ_WATERMARK")
}

/// Takes the ledger of key-group joins the push service attempted while the app was shut, and
/// deletes it (channel-encryption section 26, `mobile::key_group_join`).
///
/// Called once at start-up, BEFORE the key-group registry is restored and before the drain: a group
/// joined from a push is in `mls.bin` and in no registry row, and a key group the registry does not
/// name has its backlog refused as `absent-conversation` (section 22). The `joined` entries carry the
/// scope the server named, which is what the frontend writes into the registry. From this call on,
/// every group in the ledger is the app's own join's to own - which is why the whole file goes.
///
/// Empty on desktop, where no push service exists to join anything, and on iOS, whose notification
/// extension never joins (it writes no `mls.bin` of the app's).
#[tauri::command]
pub(crate) fn take_key_group_push_joins(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[KG_PUSH_JOIN] app_data_dir() failed: {e}");
                return vec![];
            }
        };
        // The ledger is sealed under the install's cache key: without it, it stays where it is for
        // a start that can read it (`app_cache_key` has logged the absence).
        let Ok(key) = crate::native_cache::app_cache_key(&app) else {
            // Only an accusation when there IS a ledger to take (never on iOS, which writes none).
            if data_dir
                .join(crate::mobile::key_group_join::LEDGER_FILE)
                .exists()
            {
                log::error!("[KG_PUSH_JOIN] ledger not taken: the native cache key is unreadable");
            }
            return vec![];
        };
        match crate::mobile::key_group_join::take_all(&data_dir, &key) {
            Ok(taken) => {
                log::info!("[KG_PUSH_JOIN] ledger taken: {} entry/entries", taken.len());
                taken
                    .into_iter()
                    .filter_map(|t| serde_json::to_value(t).ok())
                    .collect()
            }
            Err(e) => {
                log::error!("[KG_PUSH_JOIN] ledger not taken: {e}");
                vec![]
            }
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        vec![]
    }
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

/// An exclusive OS lock on `file`, held until it is closed.
///
/// `flock` directly on every Unix, NOT `File::lock`: std implements that for Linux and the Apple
/// targets but returns `Unsupported` on Android, whose target is not in its list. It shipped that
/// way for one run - every seed write in a killed app failed, `stored 0 seed(s)` on a frame that
/// carried one, and the Rust error went to no logger (NOTIF-20 RED, 2026-09-27). Windows keeps
/// std's, which is implemented there and is what a host `cargo test` runs.
#[cfg(unix)]
pub(crate) fn lock_exclusive(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: the descriptor is owned by `file`, which outlives the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
pub(crate) fn lock_exclusive(file: &std::fs::File) -> std::io::Result<()> {
    file.lock()
}

/// Reads the seed mirror, hands its map to `edit`, and writes it back SEALED when `edit` says it
/// changed.
///
/// **THE ONE WAY THIS FILE IS WRITTEN, AND IT IS SERIALISED ACROSS PROCESSES.** Several writers
/// share the file and nothing ordered them: the foreground command, the MLS push lane absorbing a
/// seed push, and - since channel-encryption section 19 - the salon push opening the seed frame a
/// message carries, often for the SAME seed within the same second. On iOS the notification
/// extension is another PROCESS. Each read the map, added its session and wrote the whole file
/// back, so the later of two overlapping writers erased the earlier one's seed: a banner that
/// decrypted, and a later one of the same session that did not.
///
/// So every edit holds an exclusive lock on `graine_seeds.lock` (`lock_exclusive`, an OS file lock:
/// it orders threads and processes alike, and the OS releases it if the holder dies), and writes
/// through a temporary file renamed over the old one: `fs::write` truncates in place, and a
/// reader could open a half-written file and read a present seed as absent.
///
/// **SEALED AT REST since 2026-10-22** (`native_cache`): the file is read with the install's cache
/// key and always written sealed. A mirror an older build wrote in the clear is read as such and
/// sealed by the first write - and by [`reseal_graine_mirror`] when nothing writes. An absent or
/// unparsable map reads as an empty one, as it always has; so does a sealed file the key does not
/// open, and that is not a guess: the key never rotates, so no reader on this install will ever
/// open it either, and the mirror is a bounded cache of seeds the durable store holds.
///
/// `edit` returns its result and whether the map changed; nothing is written when it did not.
fn with_graine_mirror<R>(
    data_dir: &std::path::Path,
    key: &CacheKey,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(R, bool), String>,
) -> Result<R, String> {
    with_graine_mirror_inner(data_dir, key, false, edit).map(|(r, _)| r)
}

/// [`with_graine_mirror`], optionally writing back a plaintext mirror even when `edit` changed
/// nothing - which is how [`reseal_graine_mirror`] seals one. Also returns whether it wrote.
fn with_graine_mirror_inner<R>(
    data_dir: &std::path::Path,
    key: &CacheKey,
    seal_plaintext: bool,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(R, bool), String>,
) -> Result<(R, bool), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("graine_seeds.lock"))
        .map_err(|e| format!("open graine_seeds.lock: {e}"))?;
    // Released when `lock` is dropped at the end of this function, on every return path.
    lock_exclusive(&lock).map_err(|e| format!("lock graine_seeds.lock: {e}"))?;
    let path = data_dir.join("graine_seeds.json");
    let (mut root, was_plaintext) = match std::fs::read(&path) {
        Ok(bytes) => match open_file(key, Purpose::SeedMirror, &bytes) {
            Ok(opened) => {
                let was_plaintext = matches!(opened, Opened::Plaintext(_));
                let parsed = serde_json::from_slice(&opened.into_inner()).unwrap_or_else(|e| {
                    log::warn!("[GRAINE_MIRROR] mirror unparsable, rebuilt from empty: {e}");
                    serde_json::json!({})
                });
                (parsed, was_plaintext)
            }
            Err(e) => {
                log::error!(
                    "[GRAINE_MIRROR] mirror rebuilt from empty: {e} - this install's key will never \
                     open it, so its sessions show the generic banner until they are mirrored again"
                );
                (serde_json::json!({}), false)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (serde_json::json!({}), false),
        Err(e) => return Err(format!("read graine_seeds.json: {e}")),
    };
    let map = root
        .as_object_mut()
        .ok_or("graine_seeds.json is not an object")?;
    let (result, changed) = edit(map)?;
    let write = changed || (seal_plaintext && was_plaintext);
    if write {
        let tmp = data_dir.join("graine_seeds.json.tmp");
        std::fs::write(
            &tmp,
            seal_file(key, Purpose::SeedMirror, root.to_string().as_bytes()),
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        // After the rename: the new inode does not carry the old one's flag.
        crate::native_cache::exclude_from_backup(&path);
    }
    Ok((result, write))
}

/// Seals a mirror an older build left in the clear, changing nothing in it. Returns whether it
/// wrote. See `native_cache::seal_legacy_seed_mirror`, its one caller.
#[cfg(any(mobile, test))]
pub(crate) fn reseal_graine_mirror(
    data_dir: &std::path::Path,
    key: &CacheKey,
) -> Result<bool, String> {
    with_graine_mirror_inner(data_dir, key, true, |_| Ok(((), false))).map(|(_, wrote)| wrote)
}

/// Reads the whole mirror, or `None` when there is none. `key` may be absent only while the file is
/// still the older build's plaintext: a sealed mirror with no key to open it is an error, never an
/// empty map, because "I could not look" is not "there is nothing".
#[cfg(any(mobile, test, feature = "bench-observables"))]
pub(crate) fn read_graine_mirror(
    data_dir: &std::path::Path,
    key: Option<&CacheKey>,
) -> Result<Option<serde_json::Value>, String> {
    let bytes = match std::fs::read(data_dir.join("graine_seeds.json")) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read graine_seeds.json: {e}")),
    };
    let plain = match key {
        Some(key) => open_file(key, Purpose::SeedMirror, &bytes)
            .map_err(|e| format!("graine_seeds.json: {e}"))?
            .into_inner(),
        None if crate::native_cache::is_sealed_file(&bytes) => {
            return Err("graine_seeds.json is sealed and no cache key was handed over".into())
        }
        None => bytes,
    };
    serde_json::from_slice(&plain)
        .map(Some)
        .map_err(|e| format!("graine_seeds.json unparsable: {e}"))
}

/// Writes the seeds a background decrypt found in a key-material frame - the `seeds` array of a
/// `graine-key-material` refusal - into the mirror, and says how many it kept.
///
/// ONE IMPLEMENTATION FOR BOTH PUSH PATHS: the Android JNI (`nativeStoreGraineSeeds`) and the iOS
/// extension (`canari_native_store_graine_seeds`) hand it the same JSON, so the per-seed skip and
/// the count cannot drift between the platforms.
///
/// Returns -1 when the payload is not a JSON array at all, or when no cache key was handed over:
/// different facts from "zero seeds were usable", which must not read as the same one.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn store_graine_seeds_json(
    data_dir: &std::path::Path,
    key: Option<&CacheKey>,
    json: &str,
) -> i32 {
    let Ok(seeds) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        log::error!("[GRAINE_PUSH] seeds payload is not a JSON array");
        return -1;
    };
    // NEVER IN THE CLEAR: with no key the mirror is not written at all. The app writes the same
    // seeds from its durable store when it next runs.
    let Some(key) = key else {
        log::error!(
            "[GRAINE_PUSH] no native cache key - {} seed(s) not mirrored",
            seeds.len()
        );
        return -1;
    };

    let mut stored = 0i32;
    let mut left_to_the_app = 0usize;
    for seed in &seeds {
        let Some(entry) = MirrorSeed::from_extracted(seed) else {
            log::warn!("[GRAINE_PUSH] incomplete seed entry skipped");
            continue;
        };
        // A RELAYED SEED (a bundle's) ONLY FOR A SALON THIS DEVICE ALREADY READS. Native code does
        // not know which salons are private, nor which key group carried the frame, so it cannot make
        // the app's scope check (`storeIncomingSeed`); a salon the mirror already holds a session of
        // is one the app admitted seeds for. Any other is left to the app, which reads the same
        // answer from its durable queue at its next start and checks it fully.
        if seed["relayed"].as_bool() == Some(true)
            && !mirror_holds_channel(data_dir, key, entry.channel_id)
        {
            left_to_the_app += 1;
            continue;
        }
        // PER SEED, so a bundle does not lose its tail to its first bad entry.
        match merge_graine_seed(data_dir, key, &entry) {
            Ok(_) => stored += 1,
            Err(e) => log::error!(
                "[GRAINE_PUSH] merge failed for session {}: {e}",
                entry.session_id
            ),
        }
    }
    if left_to_the_app > 0 {
        log::info!(
            "[GRAINE_PUSH] {left_to_the_app} relayed seed(s) for salon(s) this device has never read - not mirrored, left to the app"
        );
    }
    log::debug!("[GRAINE_PUSH] stored {stored}/{} seed(s)", seeds.len());
    stored
}

/// Whether the mirror holds at least one session of `channel_id` - a salon whose seeds the app has
/// admitted. Read without the lock, as [`read_graine_seed`] reads: every writer renames a whole
/// file over the old one.
///
/// THE MIRROR IS SEALED, so it is opened with `key` through [`read_graine_mirror`], the one reader -
/// a plain-text parse fails on every sealed file, and every relayed seed would then be left to the
/// app. An absent file holds nothing; an unreadable one holds nothing either, and says so at ERROR,
/// because a mirror this device wrote and cannot open is not an expected state.
#[cfg(any(target_os = "android", target_os = "ios", test))]
fn mirror_holds_channel(data_dir: &std::path::Path, key: &CacheKey, channel_id: &str) -> bool {
    match read_graine_mirror(data_dir, Some(key)) {
        Ok(Some(root)) => root[channel_id]
            .as_object()
            .is_some_and(|sessions| !sessions.is_empty()),
        Ok(None) => false,
        Err(e) => {
            log::error!("[GRAINE_PUSH] mirror unreadable while checking salon {channel_id}: {e}");
            false
        }
    }
}

/// One session as the mirror HOLDS it, read back for a push to be opened against.
#[cfg(any(target_os = "android", target_os = "ios", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeldGraineSeed {
    pub seed_b64: String,
    pub first_index: u32,
    /// `(minterUserId, signingPk base64)` for a v2 session, `None` for a v1 one.
    pub v2: Option<(String, String)>,
}

/// Reads one session from the mirror, without the lock: every writer renames a whole file over the
/// old one ([`with_graine_mirror`]), so a reader sees one version or the other, never half of one.
///
/// `Ok(None)` is a session the mirror does not hold - expected for an old one, since the mirror is
/// bounded. `Err` is a file that exists and cannot be read (or is sealed and `key` is absent), which
/// is a different fact. A v2 entry missing its minter or key is refused as unreadable rather than
/// opened as v1: that would be the downgrade a session's version exists to make impossible.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn read_graine_seed(
    data_dir: &std::path::Path,
    key: Option<&CacheKey>,
    channel_id: &str,
    session_id: &str,
) -> Result<Option<HeldGraineSeed>, String> {
    let Some(root) = read_graine_mirror(data_dir, key)? else {
        return Ok(None);
    };
    let entry = &root[channel_id][session_id];
    let Some(seed_b64) = entry["seed"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let v2 = match held_v2(entry) {
        Some((minter, pk)) if !minter.is_empty() && !pk.is_empty() => {
            Some((minter.to_string(), pk.to_string()))
        }
        Some(_) => {
            return Err(format!(
                "v2 session {session_id} held without its minter or key"
            ))
        }
        None => None,
    };
    Ok(Some(HeldGraineSeed {
        seed_b64: seed_b64.to_string(),
        first_index: entry["firstIndex"].as_u64().unwrap_or(0) as u32,
        v2,
    }))
}

/// Whether the mirror holds a session: `1` yes, `0` no, `-1` the mirror cannot be read. What the
/// native push paths ask before choosing between the mirror and the seed frame - the seed itself
/// never has to leave Rust for that.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn graine_seed_held(
    data_dir: &std::path::Path,
    key: Option<&CacheKey>,
    channel_id: &str,
    session_id: &str,
) -> i32 {
    if session_id.is_empty() {
        return 0;
    }
    match read_graine_seed(data_dir, key, channel_id, session_id) {
        Ok(Some(_)) => 1,
        Ok(None) => 0,
        Err(e) => {
            log::error!("[GRAINE_MIRROR] mirror unreadable: {e}");
            -1
        }
    }
}

/// How many Graine sessions per channel the mirror keeps. Mirrors
/// `GRAINE_NATIVE_MIRROR_SESSIONS_PER_CHANNEL` in `graineConstants.ts`.
const GRAINE_MIRROR_SESSIONS_PER_CHANNEL: usize = 20;

/// Merges one Graine seed into {app_data_dir}/graine_seeds.json so the background push service can
/// derive a message key with the app killed. The file is a JSON map
/// `channelId -> { sessionId -> { seed, createdAt, firstIndex, [version, minterUserId, signingPk] } }`.
///
/// **Bounded, unlike the epoch mirror it replaced.** Epoch keys were few and a whole channel's
/// worth could be kept; seeds accumulate for ever, in a file rewritten on every rotation, which is
/// unbounded growth waiting for a year to pass. Only the newest
/// [`GRAINE_MIRROR_SESSIONS_PER_CHANNEL`] are kept, because this file has exactly one job -
/// decrypting an INCOMING push - while the durable set lives in the local store. A seed too old to
/// be mirrored is not a failure: the notification degrades to a generic "new message", which is the
/// existing behaviour and the correct one.
///
/// Sealed at rest under the install's cache key (`native_cache`). Async because reading that key is
/// a keystore plugin call, which must not run on the main thread a synchronous command runs on.
#[tauri::command]
pub(crate) async fn store_graine_seed(
    app: tauri::AppHandle,
    seed: MirrorSeedInput,
) -> Result<(), String> {
    with_app_mirror(app, move |dir, key| {
        merge_graine_seed(dir, key, &seed.as_mirror_seed()).map(|_| ())
    })
    .await
}

/// Runs a mirror edit for a foreground command: the app data directory, the install's cache key, off
/// the main thread.
///
/// ON A DESKTOP THERE IS NOTHING TO MIRROR, and saying so is the whole branch: the mirror exists for
/// a notification service that decrypts a push with the app shut, and a desktop build has none - no
/// reader of this file was ever compiled there. So nothing is written, and a plaintext copy an older
/// desktop build left is deleted rather than sealed for a reader that does not exist.
async fn with_app_mirror<T: Send + Default + 'static>(
    app: tauri::AppHandle,
    edit: impl FnOnce(&std::path::Path, &CacheKey) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        #[cfg(mobile)]
        {
            let key = crate::native_cache::app_cache_key(&app)?;
            edit(&data_dir, &key)
        }
        #[cfg(not(mobile))]
        {
            let _ = edit;
            match std::fs::remove_file(data_dir.join("graine_seeds.json")) {
                Ok(()) => {
                    log::info!("[GRAINE_MIRROR] desktop: removed a plaintext mirror no reader uses")
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::error!("[GRAINE_MIRROR] desktop: plaintext mirror not removed: {e}"),
            }
            log::debug!("[GRAINE_MIRROR] desktop: no background reader - nothing mirrored");
            Ok(T::default())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the foreground hands [`store_graine_seed`]: `graineMirror.ts` builds it from a stored
/// session that has already passed every check the app makes.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MirrorSeedInput {
    channel_id: String,
    session_id: String,
    seed_b64: String,
    created_at: i64,
    first_index: u32,
    /// Both set on a v2 session, both null on a v1 one.
    minter_user_id: Option<String>,
    signing_public_key_b64: Option<String>,
}

impl MirrorSeedInput {
    fn as_mirror_seed(&self) -> MirrorSeed<'_> {
        MirrorSeed {
            channel_id: &self.channel_id,
            session_id: &self.session_id,
            seed_b64: &self.seed_b64,
            created_at: self.created_at,
            first_index: self.first_index,
            v2: match (&self.minter_user_id, &self.signing_public_key_b64) {
                (Some(minter), Some(pk)) => Some(MirrorSeedV2 {
                    minter_user_id: minter,
                    signing_public_key_b64: pk,
                }),
                _ => None,
            },
        }
    }
}

/// One seed as the mirror holds it, whichever path wrote it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MirrorSeed<'a> {
    pub channel_id: &'a str,
    pub session_id: &'a str,
    pub seed_b64: &'a str,
    pub created_at: i64,
    /// The lowest index a push may be opened at - the app's floor, honoured natively too.
    pub first_index: u32,
    /// What a v2 push is verified against; `None` is a v1 session.
    pub v2: Option<MirrorSeedV2<'a>>,
}

/// The v2 half of a mirrored seed: the author its rows must name and the key that signs them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MirrorSeedV2<'a> {
    pub minter_user_id: &'a str,
    pub signing_public_key_b64: &'a str,
}

impl<'a> MirrorSeed<'a> {
    /// Reads one entry of the push path's extraction (`proto_fields::graine_seeds`), or `None` when
    /// it lacks what a key derivation needs. A v2 entry without its two fields is refused rather than
    /// mirrored as v1 - the downgrade a session's version exists to make impossible.
    #[cfg(any(target_os = "android", target_os = "ios", test))]
    fn from_extracted(seed: &'a serde_json::Value) -> Option<Self> {
        let channel_id = seed["channelId"].as_str().unwrap_or_default();
        let session_id = seed["sessionId"].as_str().unwrap_or_default();
        let seed_b64 = seed["seedB64"].as_str().unwrap_or_default();
        if channel_id.is_empty() || session_id.is_empty() || seed_b64.is_empty() {
            return None;
        }
        let v2 = if seed["version"].as_u64() == Some(2) {
            let minter_user_id = seed["minterUserId"].as_str().unwrap_or_default();
            let signing_public_key_b64 = seed["signingPublicKeyB64"].as_str().unwrap_or_default();
            if minter_user_id.is_empty() || signing_public_key_b64.is_empty() {
                log::error!(
                    "[GRAINE_PUSH] v2 seed {session_id} without its minter or key - refused, not mirrored as v1"
                );
                return None;
            }
            Some(MirrorSeedV2 {
                minter_user_id,
                signing_public_key_b64,
            })
        } else {
            None
        };
        Some(Self {
            channel_id,
            session_id,
            seed_b64,
            created_at: seed["createdAt"].as_i64().unwrap_or(0),
            first_index: seed["firstIndex"].as_u64().unwrap_or(0) as u32,
            v2,
        })
    }

    /// The entry written into the file.
    fn to_entry(self) -> serde_json::Value {
        let mut entry = serde_json::json!({
            "seed": self.seed_b64,
            "createdAt": self.created_at,
            "firstIndex": self.first_index,
        });
        if let Some(v2) = self.v2 {
            entry["version"] = 2.into();
            entry["minterUserId"] = v2.minter_user_id.into();
            entry["signingPk"] = v2.signing_public_key_b64.into();
        }
        entry
    }
}

/// The v2 half of an entry already in the file, for the replacement check.
fn held_v2(entry: &serde_json::Value) -> Option<(&str, &str)> {
    (entry["version"].as_u64() == Some(2)).then(|| {
        (
            entry["minterUserId"].as_str().unwrap_or_default(),
            entry["signingPk"].as_str().unwrap_or_default(),
        )
    })
}

/// The merge itself, without a `tauri::AppHandle` - so the BACKGROUND PUSH PATH can reach it.
///
/// A seed arriving while the app is shut has no WebView to invoke the command above and no
/// `AppHandle` to resolve the data directory, but it is the same write, under the same bound, into
/// the same file: a second implementation would be a second bound, and the one that drifted would
/// be the one nobody reads. The caller supplies the directory because that is the ONLY thing the
/// two paths do not share - the foreground asks Tauri, the push service is handed it by Kotlin.
///
/// Returns how many older sessions the bound dropped.
pub(crate) fn merge_graine_seed(
    data_dir: &std::path::Path,
    key: &CacheKey,
    seed: &MirrorSeed<'_>,
) -> Result<usize, String> {
    let session_id = seed.session_id;
    let channel_id = seed.channel_id;
    let dropped = with_graine_mirror(data_dir, key, |map| {
        // A SESSION ID NAMES ONE SEED IN ONE SALON, FOR EVER - the rule `storeIncomingSeed` holds for
        // the durable store, held here for the file the push path decrypts from. Searched across
        // EVERY channel, since the map is keyed by salon and a replacement may name another one.
        let held = map
            .iter()
            .find_map(|(ch, sessions)| sessions.get(session_id).map(|h| (ch.clone(), h.clone())));
        if let Some((held_channel, held)) = held {
            let held_seed = held["seed"].as_str().unwrap_or_default();
            let incoming_v2 = seed
                .v2
                .map(|v| (v.minter_user_id, v.signing_public_key_b64));
            // v2 is part of what a session IS: a copy that adds it, drops it or names another
            // minter or key is a different session wearing a held id.
            if held_channel != channel_id
                || !same_seed(held_seed, seed.seed_b64)
                || held_v2(&held) != incoming_v2
            {
                log::error!(
                    "[GRAINE_MIRROR] REFUSED seed replacement: session {session_id} is held for channel {held_channel}, a frame re-sent it for channel {channel_id} (same seed: {}, same v2: {})",
                    same_seed(held_seed, seed.seed_b64),
                    held_v2(&held) == incoming_v2
                );
                return Err(format!(
                    "session {session_id} is already held with another seed, salon or endorsement"
                ));
            }
            // THE FLOOR IS THE ONLY THING A SECOND COPY MAY MOVE, and only down - the durable
            // store's rule. An entry written before the floor was mirrored has none, and reads as 0.
            let held_floor = held["firstIndex"].as_u64().unwrap_or(0) as u32;
            if seed.first_index < held_floor {
                map[held_channel.as_str()][session_id]["firstIndex"] = seed.first_index.into();
                return Ok((0, true));
            }
            // The same seed again: nothing to write, and the bound has nothing new to trim.
            return Ok((0, false));
        }
        let channel_entry = map
            .entry(channel_id.to_string())
            .or_insert_with(|| serde_json::json!({}));
        let sessions = channel_entry
            .as_object_mut()
            .ok_or("channel entry is not an object")?;
        sessions.insert(session_id.to_string(), seed.to_entry());
        Ok((prune_graine_sessions(sessions), true))
    })?;
    log::debug!("[GRAINE_MIRROR] stored seed, dropped {dropped} older session(s)");
    Ok(dropped)
}

/// Whether two base64 spellings carry the same seed. Compared as BYTES, because the foreground
/// (`toBase64`) and the push path (the proto extraction) each encode their own, and a padding or
/// alphabet difference between two writers must not read as a replacement.
fn same_seed(a: &str, b: &str) -> bool {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    match (engine.decode(a), engine.decode(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
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
pub(crate) async fn forget_graine_channel(
    app: tauri::AppHandle,
    channel_id: String,
) -> Result<(), String> {
    let forgot = with_app_mirror(app, move |dir, key| {
        with_graine_mirror(dir, key, |map| {
            let forgot = map.remove(&channel_id).is_some();
            Ok((forgot, forgot))
        })
    })
    .await?;
    if forgot {
        log::debug!("[GRAINE_MIRROR] forgot every seed of one channel");
    }
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
pub(crate) async fn forget_graine_sessions(
    app: tauri::AppHandle,
    session_ids: Vec<String>,
) -> Result<usize, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let (removed, emptied) = with_app_mirror(app, move |dir, key| {
        with_graine_mirror(dir, key, |map| {
            let (removed, emptied) = remove_graine_sessions(map, &session_ids);
            Ok(((removed, emptied), removed > 0 || emptied > 0))
        })
    })
    .await?;
    if removed > 0 || emptied > 0 {
        log::debug!(
            "[GRAINE_MIRROR] forgot {removed} expired session(s), {emptied} channel(s) dropped"
        );
    }
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
    crate::commands::handoff::read_and_clear_app_data_file(
        &app,
        "pending_call_accept.json",
        "CALL_ACCEPT",
    )
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
/// The key goes into the platform keystore under `mls_device_key_{user_id}_{device_id}`, never
/// into the JSON (WP-SEC-1): the background push and the biometric login path
/// (`load_encrypted_with_keystore` path A) read it there, so a failed write is returned.
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

    let alias = crate::commands::at_rest_key::device_key_alias(&user_id, &device_id);
    // Through the at-rest guard (`store_guarded`): on a migrated phone the entry already holds this
    // key and is not rewritten; during a re-key the session's OLD key is refused, because rows already
    // sit under the new one whose only copy is this entry. A refusal is not an error here: the push
    // context is still written, and the entry holds the key the background push needs once the
    // re-key ends.
    match PluginDeviceKeyStore::new(app.clone()).store_guarded(&key_bytes, &alias) {
        Ok(_) => {}
        // The expected answer during and after a re-key: the entry holds the key of record.
        Err(KeyEntryError::Refused(why @ GuardRefusal::HeldKey(_))) => {
            log::info!("[AT_REST_KEY] store_push_context: keystore left as it is - {why}")
        }
        // NOT expected: a marker nobody can read blocks every keystore write until a reset, and the
        // background push of a new session may be left on an older key.
        Err(KeyEntryError::Refused(why @ GuardRefusal::Unreadable(_))) => {
            log::error!("[AT_REST_KEY] store_push_context: keystore write refused - {why}")
        }
        // WP-SEC-1: the keystore is the ONLY copy of the device key (no JSON fallback). A failed
        // write means background decrypt is dead - returned, not logged and swallowed.
        Err(e @ KeyEntryError::Failed(_)) => {
            return Err(format!(
                "keystore write failed (background decrypt will not work): {e}"
            ))
        }
    }

    write_session_push_context(
        &data_dir,
        &user_id,
        &device_id,
        &base_url,
        &push_token.unwrap_or_default(),
        locale,
    )
}

/// Orders every edit of `push_context.json` made in this process: the three writers
/// (`store_push_context`, `store_device_identity`, `set_push_context_locale`) and the deletion's
/// read-check-delete ([`remove_user_push_files`]).
///
/// WHY. The deletion reads the file to PROVE the deleted account owns it, then removes it. A new
/// sign-in's `store_push_context` landing between the two was deleted on the strength of a proof
/// about the PREVIOUS bytes, leaving that session with no push context until it was stored again
/// (fourth review of #2023). A Tauri command without `async` is not serialised by the runtime: the
/// IPC custom protocol calls it on whatever thread the WebView hands the request to.
static PUSH_CONTEXT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Takes [`PUSH_CONTEXT_LOCK`]. The lock guards an ORDER, not a value: a holder that panicked
/// leaves no half-built data behind it, so a poisoned lock is taken as it is.
pub(crate) fn push_context_guard() -> std::sync::MutexGuard<'static, ()> {
    PUSH_CONTEXT_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The file half of [`store_push_context`], under [`PUSH_CONTEXT_LOCK`]: replaces
/// `push_context.json` with this session's context.
fn write_session_push_context(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    base_url: &str,
    push_token: &str,
    locale: Option<String>,
) -> Result<(), String> {
    let _guard = push_context_guard();
    // This call REPLACES the file, so a locale already mirrored must survive a caller that does not
    // know one - otherwise a device-key refresh silently reverts every background notification to
    // the default language until the user next changes it by hand.
    let locale = locale
        .filter(|l| !l.trim().is_empty())
        .or_else(|| read_push_context_locale(data_dir))
        .unwrap_or_else(|| DEFAULT_PUSH_LOCALE.to_string());

    let json = serde_json::json!({
        "userId": user_id,
        "deviceId": device_id,
        "baseUrl": base_url,
        "pushToken": push_token,
        "locale": locale,
    });
    std::fs::write(data_dir.join(PUSH_CONTEXT_FILE), json.to_string()).map_err(|e| e.to_string())
}

/// Mirrors THIS DEVICE'S IDENTITY, and nothing else, so it survives the WebView losing
/// `localStorage` (Android eviction under storage pressure, a reinstall, a cleared site data).
///
/// WHY IT IS NOT A PART OF `store_push_context`. The MLS credential is `user_id:device_id`, so
/// losing the id does not degrade a feature - it makes this a DIFFERENT device, orphaning the leaf
/// it holds in every group's ratchet tree and forcing a re-enrolment no peer asked for. Its only
/// durable copy was this same file, written exclusively by `store_push_context`, which requires a
/// derived device key, a platform-keystore write that succeeds, and - at its JS call site - an
/// auth-token refresh already back from the network. Not one of those three is a fact about
/// identity, and each of them failing quietly minted a new device: on production (2026-09-12) 138
/// of 361 accounts carried ONE device name under several ids, 40% of iOS accounts and 38% of
/// Android against 12% Windows and 9% macOS - the gap is mobile, which is where eviction happens.
///
/// So this has NO precondition and patches two keys rather than rewriting the file, the way
/// `set_push_context_locale` does for the language. It differs from that one on the absent-file
/// case: a lone locale is a context no reader can use, but a lone identity is precisely what
/// `load_push_context` exists to hand back, so the file IS created here. That costs nothing to the
/// three background readers - `MlsContextLoader.loadPushContext`, the Swift NSE's and the ObjC
/// one all require a non-empty `baseUrl` and return nil without it, exactly as for an absent file.
///
/// `pushToken` is dropped when the user changes. Despite its name it is the AUTH BEARER token (see
/// `store_push_context`), so it is scoped to a user; leaving the previous one beside a new
/// `userId` would let a background fetch authenticate as the account that just signed out.
#[tauri::command]
pub(crate) fn store_device_identity(
    user_id: String,
    device_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let user_id = user_id.trim().to_string();
    let device_id = device_id.trim().to_string();
    if user_id.is_empty() || device_id.is_empty() {
        return Err("user_id and device_id are both required".to_string());
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("push_context.json");

    let _guard = push_context_guard();
    let mut ctx: serde_json::Map<String, serde_json::Value> = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    };

    let same_user = ctx.get("userId").and_then(serde_json::Value::as_str) == Some(user_id.as_str());
    if !same_user {
        ctx.remove("pushToken");
    }

    ctx.insert("userId".to_string(), serde_json::Value::String(user_id));
    ctx.insert("deviceId".to_string(), serde_json::Value::String(device_id));
    std::fs::write(&path, serde_json::Value::Object(ctx).to_string()).map_err(|e| e.to_string())
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
    let _guard = push_context_guard();
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

/// The per-install files that hold ONE account's data in the clear and die with that account when it
/// is DELETED: unsent `AppMessage` protos (`store_outbox_mirror`), messages decrypted by a push
/// (`take_fcm_cache`; what a take moved aside, `FCM_CACHE_TAKEN_PREFIX*`, goes with them), the read
/// marks and sent ids the background side handed over, and the device-notice ledger (one marker per
/// announced device, named by `userId:deviceId`). Not `mls.bin`, `graine_seeds.json` or the push
/// secret - kept by this command on purpose.
const ACCOUNT_PUSH_FILES: [&str; 5] = [
    "outbox_pending.ndjson",
    FCM_CACHE_FILE,
    "read_watermarks.ndjson",
    "outbox_sent.ndjson",
    DEVICE_NOTICES_DIR,
];

/// The directory of the device-notice ledger (`mobile::device_notice`), in the app data directory on
/// Android and in the App Group container on iOS - where the app and its background engine both
/// reach it.
pub(crate) const DEVICE_NOTICES_DIR: &str = "device_notices";

/// Claims, in the device-notice ledger the background engines share, the keys of the "a new device
/// was added to your account" alerts the app has just shown - so a push that later replays the same
/// commit raises no local notification for them - and returns the keys nobody had announced yet.
///
/// Phones only: the ledger exists because a background engine may see the commit first, and only
/// a phone has one. The app calls it from `nativeDeviceNotices.ts` on Android and iOS alone.
#[tauri::command]
pub(crate) fn claim_device_notices(
    app: tauri::AppHandle,
    keys: Vec<String>,
) -> Result<Vec<String>, String> {
    log::debug!("[DEVICE_NOTICE] app claims {} key(s)", keys.len());
    #[cfg(target_os = "ios")]
    {
        let _ = &app;
        let dir = crate::app_group::app_group_dir()?;
        Ok(crate::mobile::device_notice::claim_device_notices(
            &dir, &keys,
        ))
    }
    #[cfg(target_os = "android")]
    {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(crate::mobile::device_notice::claim_device_notices(
            &dir, &keys,
        ))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, keys);
        Err("the device-notice ledger exists on a phone only".to_string())
    }
}

/// The file that NAMES whose the files above are - removed last, since it is the proof.
pub(crate) const PUSH_CONTEXT_FILE: &str = "push_context.json";

/// Deletes the push-side files of a DELETED account (WP-DEL-LOCAL) - see [`remove_user_push_files`].
///
/// On iOS the App Group container is part of the deletion: `CanariMirrorPushStateToAppGroup`
/// copies `push_context.json` there and the notification extension writes its decrypted
/// `fcm_message_cache.ndjson` there, and neither writer ever deletes. With no container the
/// app's own files still go and the error is returned: the mirror resolves the container through
/// the same entitlement, so a container this call cannot reach is one nothing was copied into.
///
/// A SYNCHRONOUS command: on iOS it runs inline in WebKit's URL-scheme callback (wry 0.57 and
/// tauri 2.12 add no thread hop for a sync command), which is the main thread - the thread the
/// mirror runs on at `didBecomeActive` / `willResignActive` - so a mirror cannot copy the context
/// back between this deletion's proof and its removals. Making it `async` would reopen that window.
/// Read from source, not observed on a device.
#[tauri::command]
pub(crate) fn delete_user_push_files(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<usize, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    #[cfg(target_os = "ios")]
    {
        let group = crate::app_group::app_group_dir();
        let removed =
            remove_account_push_and_name_files(&data_dir, group.as_deref().ok(), &user_id);
        if let Err(e) = &group {
            log::error!(
                "[DEL-LOCAL] no App Group container - the extension's copies were not reached: {e}"
            );
        }
        if let Err(e) = &removed {
            log::error!("[DEL-LOCAL] the account's push files were not all removed: {e}");
        }
        let removed = removed?;
        group?;
        Ok(removed)
    }
    #[cfg(not(target_os = "ios"))]
    remove_account_push_and_name_files(&data_dir, None, &user_id)
}

/// The body of [`delete_user_push_files`]: the mirrored names (`display_names.json`, in the data
/// directory and in `group`, the iOS App Group), then [`remove_user_push_files`].
///
/// The names carry their own owner, so they are removed on THEIR proof, not the context's. A
/// failure there is LOGGED AND CARRIED, never a `?`: an early return would leave
/// `push_context.json` and the outbox - the files the deletion exists for - on the disk of a
/// deleted account. Everything is attempted, then the first error is returned.
pub(crate) fn remove_account_push_and_name_files(
    data_dir: &std::path::Path,
    group: Option<&std::path::Path>,
    user_id: &str,
) -> Result<usize, String> {
    let mut names_error: Option<String> = None;
    for dir in std::iter::once(data_dir).chain(group) {
        if let Err(e) = crate::commands::display_names::remove_display_names_of(dir, user_id) {
            log::error!("[DEL-LOCAL] names copy not removed, the other push files still are: {e}");
            names_error.get_or_insert(e);
        }
    }
    let removed = remove_user_push_files(data_dir, group, user_id)?;
    match names_error {
        Some(e) => Err(format!(
            "{removed} push file(s) removed, but the names copy was not: {e}"
        )),
        None => Ok(removed),
    }
}

/// The names in [`ACCOUNT_PUSH_FILES`] plus `push_context.json` that can also exist in the iOS App
/// Group container: the extension's own `fcm_message_cache.ndjson` and the mirrored context. The
/// whole account list is swept there, so a file the extension starts keeping later is covered
/// without a second list to forget.
fn extension_account_files() -> impl Iterator<Item = &'static str> {
    ACCOUNT_PUSH_FILES
        .into_iter()
        .chain(std::iter::once(PUSH_CONTEXT_FILE))
}

/// Removes [`ACCOUNT_PUSH_FILES`] and `push_context.json` (`userId`, `deviceId`, the bearer
/// `pushToken`) ONLY WHEN `push_context.json` NAMES `user_id`. An allowlist by owner: none of the
/// NDJSON files carries its account, so the context is the one fact that can prove whose they are.
/// The same names go from `extension_dir` (the iOS App Group container, `None` elsewhere) on the
/// same proof: what is there is a copy of this directory's files or the extension's half of them.
///
/// - names `user_id`: every file goes, the context LAST - a failure keeps the proof for the resume;
/// - names another account: nothing is touched - that account signed in after, the files are its;
/// - absent, unreadable or naming nobody: nothing is touched and it is logged - an unknown owner is
///   never a licence to delete.
///
/// The read, the check and every removal run under [`PUSH_CONTEXT_LOCK`], so a context a new
/// sign-in stores meanwhile is written AFTER the deletion and survives it.
///
/// Returns how many files were removed.
pub(crate) fn remove_user_push_files(
    data_dir: &std::path::Path,
    extension_dir: Option<&std::path::Path>,
    user_id: &str,
) -> Result<usize, String> {
    remove_user_push_files_proved(data_dir, extension_dir, user_id, || {})
}

/// [`remove_user_push_files`], with `after_proof` run once the context has proved `user_id` owns
/// the files and before the first removal, the lock still held: the window the lock closes, which
/// a test fills with a concurrent sign-in.
fn remove_user_push_files_proved(
    data_dir: &std::path::Path,
    extension_dir: Option<&std::path::Path>,
    user_id: &str,
    after_proof: impl FnOnce(),
) -> Result<usize, String> {
    if !crate::commands::storage::is_wipeable_account_id(user_id) {
        log::error!("[DEL-LOCAL] push files: refusing a user id outside the allowlist");
        return Err("invalid user id".to_string());
    }
    let _guard = push_context_guard();
    let context_path = data_dir.join(PUSH_CONTEXT_FILE);
    let bytes = match std::fs::read(&context_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::warn!(
                "[DEL-LOCAL] push files: no {PUSH_CONTEXT_FILE}, owner unknown - left alone"
            );
            return Ok(0);
        }
        Err(e) => return Err(format!("{PUSH_CONTEXT_FILE} unreadable: {e}")),
    };
    let owner = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("userId")?.as_str().map(str::to_string))
        .filter(|o| !o.is_empty());
    match owner.as_deref() {
        None => {
            log::warn!(
                "[DEL-LOCAL] push files: {PUSH_CONTEXT_FILE} names no account - owner unknown, left alone"
            );
            return Ok(0);
        }
        Some(o) if o != user_id => {
            log::info!(
                "[DEL-LOCAL] push files belong to another account signed in since - left alone"
            );
            return Ok(0);
        }
        Some(_) => {}
    }
    after_proof();
    let mut removed = 0usize;
    let mut failures = 0usize;
    for name in ACCOUNT_PUSH_FILES {
        crate::commands::storage::remove_entry(&data_dir.join(name), &mut removed, &mut failures);
    }
    for (_, name) in taken_files(data_dir) {
        crate::commands::storage::remove_entry(&data_dir.join(name), &mut removed, &mut failures);
    }
    if let Some(dir) = extension_dir {
        let before = removed;
        for name in extension_account_files() {
            crate::commands::storage::remove_entry(&dir.join(name), &mut removed, &mut failures);
        }
        log::info!(
            "[DEL-LOCAL] push files: {} removed from the extension's container",
            removed - before
        );
    }
    if failures == 0 {
        crate::commands::storage::remove_entry(&context_path, &mut removed, &mut failures);
    }
    log::info!("[DEL-LOCAL] push files: {removed} removed, {failures} failed");
    if failures > 0 {
        return Err(format!("{failures} push file(s) could not be removed"));
    }
    Ok(removed)
}

/// The app's own handoff file: read FIRST by every in-app reader, then moved into the Keystore /
/// Keychain (`retrievePushSecret`, `CanariRetrievePushSecret`).
pub(crate) const PENDING_PUSH_SECRET_FILE: &str = "pending_push_secret.txt";

/// The iOS Notification Service Extension's copy, in the App Group container
/// (`NotificationService.loadPushSecret`). The extension has no other way to the secret.
pub(crate) const EXTENSION_PUSH_SECRET_FILE: &str = "push_secret.txt";

/// Writes a freshly minted push secret to EVERY place a reader looks for it, in one call.
///
/// `POST /mls/push/register` invalidates the previous secret the instant it answers, so a copy not
/// written here is a copy the server already refuses. The extension's copy used to be written only
/// by `CanariMirrorPushStateToAppGroup` at `didBecomeActive` / `willResignActive` - and the
/// registration runs just AFTER `didBecomeActive`, so for the whole foreground session (and for
/// ever, when the app left the foreground before the registration answered) the extension
/// presented the previous secret: production 2026-10-12, six iPhones, every avatar, commit
/// catch-up and omitted-proto fetch 403 `[PUSH_SECRET] reason=mismatch`, while the same devices'
/// in-app `refresh-token` calls passed. `extension_dir` is `None` where there is no extension
/// (Android).
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub(crate) fn write_push_secret(
    data_dir: &std::path::Path,
    extension_dir: Option<&std::path::Path>,
    secret: &str,
) -> Result<(), String> {
    log::debug!(
        "[PushSecret] storing a new secret (extension copy: {})",
        extension_dir.is_some()
    );
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join(PENDING_PUSH_SECRET_FILE), secret).map_err(|e| e.to_string())?;
    if let Some(dir) = extension_dir {
        // Temp + rename: the extension reads this file from another process, and must never see
        // it half-written.
        let target = dir.join(EXTENSION_PUSH_SECRET_FILE);
        let tmp = dir.join(format!("{EXTENSION_PUSH_SECRET_FILE}.tmp"));
        std::fs::write(&tmp, secret)
            .and_then(|()| std::fs::rename(&tmp, &target))
            .map_err(|e| {
                log::error!(
                    "[PushSecret] the extension copy was NOT written - every PushSecret fetch the \
                     notification extension makes will 403 until the next activation: {e}"
                );
                format!("write {}: {e}", target.display())
            })?;
    }
    // A SECRET IS THE SERVER'S ANSWER TO A REGISTRATION, so this device is a push destination again
    // - for the session that registered it. LAST, once every copy of the secret is written: a
    // device whose copies are incomplete stays signed out, and its next registration retries all.
    // See `push_registration.rs`.
    crate::commands::push_registration::clear_signed_out_mark(data_dir)
}

/// Stores the pushSecret received from the backend: `pending_push_secret.txt` for the app's own
/// readers (moved into the Keystore / Keychain at the next startup or resume), and on iOS the
/// notification extension's copy in the App Group too - see `write_push_secret` for why both are
/// written here and not left to a lifecycle transition.
#[tauri::command]
pub(crate) fn store_push_secret(secret: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        #[cfg(target_os = "ios")]
        {
            let group = crate::app_group::app_group_dir();
            write_push_secret(&data_dir, group.as_deref().ok(), &secret)?;
            if let Err(e) = group {
                log::error!(
                    "[PushSecret] no App Group container - the notification extension keeps a \
                     secret the server refuses: {e}"
                );
                return Err(e);
            }
        }
        #[cfg(target_os = "android")]
        write_push_secret(&data_dir, None, &secret)?;
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
        graine_seed_held, merge_graine_seed, prune_graine_sessions, read_graine_mirror,
        read_graine_seed, remove_graine_sessions, reseal_graine_mirror, store_graine_seeds_json,
        MirrorSeed, MirrorSeedV2, GRAINE_MIRROR_SESSIONS_PER_CHANNEL,
    };
    use crate::native_cache::{is_sealed_file, CacheKey};

    /// The install key every test seals under.
    const KEY: CacheKey = [3u8; 32];

    /// A v1 seed at floor 0 - what every test below wrote before the entry carried more.
    fn merge(
        dir: &std::path::Path,
        channel_id: &str,
        session_id: &str,
        seed_b64: &str,
        created_at: i64,
    ) -> Result<usize, String> {
        merge_graine_seed(
            dir,
            &KEY,
            &MirrorSeed {
                channel_id,
                session_id,
                seed_b64,
                created_at,
                first_index: 0,
                v2: None,
            },
        )
    }

    /// The one native writer both platforms call: a payload that is not an array is -1 - a
    /// different fact from "zero seeds usable" - and an incomplete entry costs only itself.
    #[test]
    fn the_shared_seed_writer_counts_what_it_stored_and_refuses_a_non_array() {
        let dir = std::env::temp_dir().join(format!("graine-seeds-json-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(store_graine_seeds_json(&dir, Some(&KEY), "{}"), -1);
        let bundle = serde_json::json!([
            { "channelId": "chan", "sessionId": "s-1", "seedB64": "c2VlZA==", "createdAt": 1 },
            { "channelId": "chan", "sessionId": "", "seedB64": "c2VlZA==", "createdAt": 2 },
        ]);
        assert_eq!(
            store_graine_seeds_json(&dir, Some(&KEY), &bundle.to_string()),
            1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// AT REST THE MIRROR IS SEALED: no seed, channel or session id is readable in the file, and
    /// only the install key reads it back.
    #[test]
    fn the_mirror_is_sealed_on_disk() {
        let dir = mirror_dir("sealed");
        merge(&dir, "chan-visible", "sess-visible", "c2VlZHNlZWQ=", 1).unwrap();
        let bytes = std::fs::read(dir.join("graine_seeds.json")).unwrap();
        assert!(is_sealed_file(&bytes));
        for needle in [&b"chan-visible"[..], b"sess-visible", b"c2VlZHNlZWQ="] {
            assert!(!bytes.windows(needle.len()).any(|w| w == needle));
        }
        assert_eq!(
            graine_seed_held(&dir, Some(&KEY), "chan-visible", "sess-visible"),
            1
        );
        assert_eq!(
            graine_seed_held(&dir, Some(&KEY), "chan-visible", "other"),
            0
        );
        // No key, or another key: unreadable, never "absent".
        assert_eq!(
            graine_seed_held(&dir, None, "chan-visible", "sess-visible"),
            -1
        );
        assert_eq!(
            graine_seed_held(&dir, Some(&[4u8; 32]), "chan-visible", "sess-visible"),
            -1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// NEVER IN THE CLEAR: a writer with no key writes nothing at all.
    #[test]
    fn a_writer_with_no_key_writes_nothing() {
        let dir = mirror_dir("nokey");
        let bundle = serde_json::json!([
            { "channelId": "chan", "sessionId": "s-1", "seedB64": "c2VlZA==", "createdAt": 1 },
        ]);
        assert_eq!(store_graine_seeds_json(&dir, None, &bundle.to_string()), -1);
        assert!(!dir.join("graine_seeds.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// THE UPGRADE: an older build's plaintext mirror is still read, is sealed by the migration
    /// with every session kept, and a second pass changes nothing (idempotent on the file's marker).
    #[test]
    fn a_plaintext_mirror_is_read_then_sealed_once() {
        let dir = mirror_dir("legacy");
        let legacy =
            serde_json::json!({ "chan": { "s-1": { "seed": "c2VlZA==", "createdAt": 1 } } });
        std::fs::write(dir.join("graine_seeds.json"), legacy.to_string()).unwrap();
        // Before the migration both a keyed and an unkeyed reader find the session.
        assert!(read_graine_seed(&dir, None, "chan", "s-1")
            .unwrap()
            .is_some());
        assert!(read_graine_seed(&dir, Some(&KEY), "chan", "s-1")
            .unwrap()
            .is_some());

        assert!(crate::native_cache::seal_legacy_seed_mirror(&dir, &KEY).unwrap());
        let bytes = std::fs::read(dir.join("graine_seeds.json")).unwrap();
        assert!(is_sealed_file(&bytes));
        assert_eq!(read_graine_mirror(&dir, Some(&KEY)).unwrap(), Some(legacy));
        assert!(!crate::native_cache::seal_legacy_seed_mirror(&dir, &KEY).unwrap());
        assert!(!reseal_graine_mirror(&dir, &KEY).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A sealed mirror this install's key does not open is rebuilt by the next write - the key
    /// never rotates, so nothing would ever read it - and the new session is kept.
    #[test]
    fn an_unopenable_mirror_is_rebuilt_by_the_next_write() {
        let dir = mirror_dir("foreign");
        std::fs::write(
            dir.join("graine_seeds.json"),
            crate::native_cache::seal_file(
                &[8u8; 32],
                crate::native_cache::Purpose::SeedMirror,
                b"{}",
            ),
        )
        .unwrap();
        merge(&dir, "chan", "s-1", "c2VlZA==", 1).unwrap();
        assert_eq!(graine_seed_held(&dir, Some(&KEY), "chan", "s-1"), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Channel-encryption section 19: the MLS lane and the salon lane absorb seeds at the same
    /// moment. Every writer read the whole map and wrote it back, so the later of two overlapping
    /// writers erased the earlier one's session. Sixteen at once, each its own session: all stay.
    #[test]
    fn concurrent_merges_keep_every_seed() {
        let dir = std::env::temp_dir().join(format!("graine-mirror-race-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        let writers: Vec<_> = (0..16)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    merge(&dir, "chan", &format!("s-{i}"), "c2VlZA==", i).unwrap();
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }

        let root = mirror(&dir);
        assert_eq!(root["chan"].as_object().unwrap().len(), 16);
        // Nothing half-written was left beside it.
        assert!(!dir.join("graine_seeds.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn seed(created_at: i64) -> serde_json::Value {
        serde_json::json!({ "seed": "c2VlZA==", "createdAt": created_at })
    }

    fn mirror_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("graine-mirror-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mirror(dir: &std::path::Path) -> serde_json::Value {
        read_graine_mirror(dir, Some(&KEY)).unwrap().unwrap()
    }

    /// Channel-encryption section 21: a frame naming a held session with other bytes is somebody
    /// replacing a seed they did not mint, and every later banner of that session would open under
    /// their key. The held seed stays.
    #[test]
    fn a_held_session_is_never_replaced_by_other_bytes() {
        let dir = mirror_dir("replace");
        merge(&dir, "chan", "s-1", "c2VlZA==", 1).unwrap();

        assert!(merge(&dir, "chan", "s-1", "b3RoZXI=", 2).is_err());

        assert_eq!(mirror(&dir)["chan"]["s-1"]["seed"], "c2VlZA==");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_held_session_is_never_moved_to_another_salon() {
        let dir = mirror_dir("move");
        merge(&dir, "chan-a", "s-1", "c2VlZA==", 1).unwrap();

        assert!(merge(&dir, "chan-b", "s-1", "c2VlZA==", 1).is_err());

        assert!(mirror(&dir).get("chan-b").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The seed push and the frame on the message carry the SAME seed, often in the same second:
    /// the second copy is a no-op, never a refusal.
    #[test]
    fn the_same_seed_again_is_accepted_and_changes_nothing() {
        let dir = mirror_dir("same");
        merge(&dir, "chan", "s-1", "c2VlZA==", 1).unwrap();

        assert_eq!(merge(&dir, "chan", "s-1", "c2VlZA==", 9), Ok(0));

        assert_eq!(mirror(&dir)["chan"]["s-1"]["createdAt"], 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn v2_seed<'a>(minter: &'a str, first_index: u32) -> MirrorSeed<'a> {
        MirrorSeed {
            channel_id: "chan",
            session_id: "s-2",
            seed_b64: "c2VlZA==",
            created_at: 1,
            first_index,
            v2: Some(MirrorSeedV2 {
                minter_user_id: minter,
                signing_public_key_b64: "cGs=",
            }),
        }
    }

    /// Graine v2 (channel-encryption section 21): the entry carries what a push is verified
    /// against, and a copy of a v2 session without it - or naming another minter - is a different
    /// session wearing a held id, refused like other bytes are.
    #[test]
    fn a_v2_session_is_mirrored_whole_and_never_downgraded() {
        let dir = mirror_dir("v2");
        merge_graine_seed(&dir, &KEY, &v2_seed("alice", 0)).unwrap();
        let entry = &mirror(&dir)["chan"]["s-2"];
        assert_eq!(entry["version"], 2);
        assert_eq!(entry["minterUserId"], "alice");
        assert_eq!(entry["signingPk"], "cGs=");

        assert!(merge(&dir, "chan", "s-2", "c2VlZA==", 1).is_err());
        assert!(merge_graine_seed(&dir, &KEY, &v2_seed("mallory", 0)).is_err());
        assert_eq!(mirror(&dir)["chan"]["s-2"]["minterUserId"], "alice");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The floor only ever moves DOWN on a second copy, as in the durable store.
    #[test]
    fn a_second_copy_may_lower_the_floor_and_never_raise_it() {
        let dir = mirror_dir("floor");
        merge_graine_seed(&dir, &KEY, &v2_seed("alice", 10)).unwrap();
        merge_graine_seed(&dir, &KEY, &v2_seed("alice", 20)).unwrap();
        assert_eq!(mirror(&dir)["chan"]["s-2"]["firstIndex"], 10);
        merge_graine_seed(&dir, &KEY, &v2_seed("alice", 4)).unwrap();
        assert_eq!(mirror(&dir)["chan"]["s-2"]["firstIndex"], 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The push path's extraction: a v2 entry missing its minter is refused, never mirrored as v1.
    #[test]
    fn the_push_writer_refuses_a_v2_seed_without_its_endorsement_fields() {
        let dir = mirror_dir("v2-json");
        let bundle = serde_json::json!([
            { "channelId": "chan", "sessionId": "s-3", "seedB64": "c2VlZA==", "createdAt": 1,
              "version": 2, "signingPublicKeyB64": "cGs=" },
            { "channelId": "chan", "sessionId": "s-4", "seedB64": "c2VlZA==", "createdAt": 1,
              "firstIndex": 3, "version": 2, "minterUserId": "alice", "signingPublicKeyB64": "cGs=" },
        ]);
        assert_eq!(
            store_graine_seeds_json(&dir, Some(&KEY), &bundle.to_string()),
            1
        );
        assert!(mirror(&dir)["chan"].get("s-3").is_none());
        assert_eq!(mirror(&dir)["chan"]["s-4"]["firstIndex"], 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A bundle's seeds (`relayed`) reach the mirror only for a salon it already holds a session
    /// of: native code cannot tell a private salon this viewer may not read from a public one, so
    /// every other relayed seed is left to the app, which reads the same answer from its queue.
    /// A seed distributed by its own sender (not relayed) is mirrored as before.
    #[test]
    fn a_relayed_seed_is_mirrored_only_for_a_salon_the_device_already_reads() {
        let dir = mirror_dir("relayed");
        merge(&dir, "read-salon", "s-held", "c2VlZA==", 1).unwrap();
        let seeds = serde_json::json!([
            { "channelId": "read-salon", "sessionId": "s-a", "seedB64": "c2VlZA==", "createdAt": 2, "relayed": true },
            { "channelId": "other-salon", "sessionId": "s-b", "seedB64": "c2VlZA==", "createdAt": 3, "relayed": true },
            { "channelId": "new-salon", "sessionId": "s-c", "seedB64": "c2VlZA==", "createdAt": 4 },
        ]);
        assert_eq!(
            store_graine_seeds_json(&dir, Some(&KEY), &seeds.to_string()),
            2
        );
        assert!(mirror(&dir)["read-salon"].get("s-a").is_some());
        assert!(mirror(&dir).get("other-salon").is_none());
        assert!(mirror(&dir)["new-salon"].get("s-c").is_some());
        std::fs::remove_dir_all(&dir).ok();
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

#[cfg(test)]
mod push_secret_tests {
    use super::{write_push_secret, EXTENSION_PUSH_SECRET_FILE, PENDING_PUSH_SECRET_FILE};

    fn dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("push-secret-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(dir: &std::path::Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    /// Production 2026-10-12: the extension's copy followed only a lifecycle transition, so after a
    /// registration it held the secret the server had just invalidated. Every rotation must reach
    /// both copies in the same call - the second rotation is the case that used to diverge.
    #[test]
    fn every_rotation_reaches_the_extension_copy_in_the_same_call() {
        let app = dir("app");
        let group = dir("group");

        write_push_secret(&app, Some(&group), "first").unwrap();
        assert_eq!(read(&app, PENDING_PUSH_SECRET_FILE), "first");
        assert_eq!(read(&group, EXTENSION_PUSH_SECRET_FILE), "first");

        write_push_secret(&app, Some(&group), "second").unwrap();
        assert_eq!(read(&app, PENDING_PUSH_SECRET_FILE), "second");
        assert_eq!(read(&group, EXTENSION_PUSH_SECRET_FILE), "second");
        // Temp + rename leaves nothing beside the file the extension reads.
        assert_eq!(std::fs::read_dir(&group).unwrap().count(), 1);
    }

    #[test]
    fn without_an_extension_only_the_app_handoff_is_written() {
        let app = dir("android");
        write_push_secret(&app, None, "only").unwrap();
        assert_eq!(read(&app, PENDING_PUSH_SECRET_FILE), "only");
        assert!(!app.join(EXTENSION_PUSH_SECRET_FILE).exists());
    }

    #[test]
    fn an_unwritable_extension_copy_is_an_error_not_a_silent_success() {
        let app = dir("app-err");
        let missing = app.join("no-such-group");
        assert!(write_push_secret(&app, Some(&missing), "s").is_err());
        // The app's own readers still get the secret: their copy is written first.
        assert_eq!(read(&app, PENDING_PUSH_SECRET_FILE), "s");
    }
}

#[cfg(test)]
mod delete_user_push_files_tests {
    use super::{remove_user_push_files, ACCOUNT_PUSH_FILES, PUSH_CONTEXT_FILE};

    fn dir_with(tag: &str, context: Option<&str>) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canari_del_push_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for f in ACCOUNT_PUSH_FILES {
            std::fs::write(dir.join(f), b"{}\n").unwrap();
        }
        std::fs::write(dir.join("mls.bin"), b"x").unwrap();
        std::fs::write(dir.join("graine_seeds.json"), b"[]").unwrap();
        if let Some(c) = context {
            std::fs::write(dir.join(PUSH_CONTEXT_FILE), c).unwrap();
        }
        dir
    }

    fn untouched(dir: &std::path::Path) -> bool {
        ACCOUNT_PUSH_FILES.iter().all(|f| dir.join(f).exists())
    }

    /// The context names the deleted account: its plaintext files and the context go, the
    /// per-install files stay.
    #[test]
    fn removes_the_files_the_context_proves_are_the_deleted_accounts() {
        let dir = dir_with(
            "own",
            Some(r#"{"userId":"a.b@x.fr","deviceId":"d","pushToken":"t"}"#),
        );
        std::fs::write(
            dir.join("fcm_message_cache.taken.3.ndjson"),
            b"{}
",
        )
        .unwrap();
        assert_eq!(remove_user_push_files(&dir, None, "a.b@x.fr").unwrap(), 7);
        assert!(!dir.join("fcm_message_cache.taken.3.ndjson").exists());
        for f in ACCOUNT_PUSH_FILES {
            assert!(!dir.join(f).exists(), "{f}");
        }
        assert!(!dir.join(PUSH_CONTEXT_FILE).exists());
        assert!(dir.join("mls.bin").exists());
        assert!(dir.join("graine_seeds.json").exists());
        // Idempotent: a resumed wipe finds no context and touches nothing.
        assert_eq!(remove_user_push_files(&dir, None, "a.b@x.fr").unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Another account signed in since: the files are its own, nothing is touched.
    #[test]
    fn never_touches_files_another_account_owns() {
        let dir = dir_with("other", Some(r#"{"userId":"b","deviceId":"d"}"#));
        assert_eq!(remove_user_push_files(&dir, None, "a").unwrap(), 0);
        assert!(untouched(&dir));
        assert!(dir.join(PUSH_CONTEXT_FILE).exists());
        // A prefix of the owner is another account too.
        assert_eq!(remove_user_push_files(&dir, None, "b_").unwrap(), 0);
        assert!(untouched(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No context, a malformed one, or one naming nobody: the owner is unknown, nothing goes.
    #[test]
    fn an_unknown_owner_is_never_a_licence_to_delete() {
        for (tag, ctx) in [
            ("none", None),
            ("garbage", Some("not json")),
            ("anon", Some(r#"{"locale":"fr"}"#)),
            ("empty", Some(r#"{"userId":""}"#)),
        ] {
            let dir = dir_with(tag, ctx);
            assert_eq!(remove_user_push_files(&dir, None, "a").unwrap(), 0, "{tag}");
            assert!(untouched(&dir), "{tag}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// What the iOS App Group container holds once the mirror and the extension have run: the
    /// mirrored context and the extension's decrypted cache (the deleted account's), and the
    /// per-install copies the deletion keeps.
    fn extension_container(dir: &std::path::Path, context: &str) -> std::path::PathBuf {
        let group = dir.join("app_group");
        std::fs::create_dir_all(&group).unwrap();
        std::fs::write(group.join(PUSH_CONTEXT_FILE), context).unwrap();
        std::fs::write(group.join(super::FCM_CACHE_FILE), b"{}\n").unwrap();
        // The device-notice ledger the extension claims in: markers name `userId:deviceId`.
        std::fs::create_dir_all(group.join(super::DEVICE_NOTICES_DIR)).unwrap();
        std::fs::write(group.join(super::DEVICE_NOTICES_DIR).join("6123"), b"").unwrap();
        for kept in ["mls.bin", "graine_seeds.json", "push_secret.txt"] {
            std::fs::write(group.join(kept), b"x").unwrap();
        }
        group
    }

    /// The defect: the App Group copy of `push_context.json` (userId, deviceId, the bearer
    /// pushToken) and the extension's decrypted cache outlived the account's deletion, because the
    /// mirror never deletes and the deletion never looked there. Both go now, on the same proof.
    #[test]
    fn removes_the_deleted_accounts_copies_from_the_extensions_container() {
        let ctx = r#"{"userId":"a","deviceId":"d","pushToken":"t"}"#;
        let dir = dir_with("group_own", Some(ctx));
        let group = extension_container(&dir, ctx);
        assert_eq!(remove_user_push_files(&dir, Some(&group), "a").unwrap(), 9);
        assert!(!group.join(PUSH_CONTEXT_FILE).exists());
        assert!(!group.join(super::FCM_CACHE_FILE).exists());
        assert!(!group.join(super::DEVICE_NOTICES_DIR).exists());
        for kept in ["mls.bin", "graine_seeds.json", "push_secret.txt"] {
            assert!(group.join(kept).exists(), "{kept}");
        }
        assert!(!dir.join(PUSH_CONTEXT_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The container is reached on the app's proof only: another owner, or none, leaves it whole.
    #[test]
    fn never_touches_the_extensions_container_without_the_proof() {
        for (tag, ctx) in [
            ("group_other", Some(r#"{"userId":"b","deviceId":"d"}"#)),
            ("group_none", None),
        ] {
            let dir = dir_with(tag, ctx);
            let group = extension_container(&dir, r#"{"userId":"b","deviceId":"d"}"#);
            assert_eq!(
                remove_user_push_files(&dir, Some(&group), "a").unwrap(),
                0,
                "{tag}"
            );
            assert!(group.join(PUSH_CONTEXT_FILE).exists(), "{tag}");
            assert!(group.join(super::FCM_CACHE_FILE).exists(), "{tag}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A copy the container refuses to give up keeps the app's context - the proof the resumed
    /// deletion needs to come back for it.
    #[cfg(unix)]
    #[test]
    fn a_container_copy_that_stays_keeps_the_proof() {
        let ctx = r#"{"userId":"a","deviceId":"d"}"#;
        let dir = dir_with("group_fail", Some(ctx));
        // A FILE where the container should be: every removal under it fails with ENOTDIR,
        // which is not "not found".
        let group = dir.join("not_a_dir");
        std::fs::write(&group, b"x").unwrap();
        assert!(remove_user_push_files(&dir, Some(&group), "a").is_err());
        assert!(dir.join(PUSH_CONTEXT_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unreadable names copy is reported, and never keeps the deleted account's context and
    /// outbox on disk: every other file is still removed.
    #[test]
    fn a_names_copy_that_cannot_be_read_does_not_stop_the_rest() {
        let dir = dir_with("names", Some(r#"{"userId":"a","deviceId":"d"}"#));
        // A directory where the file should be: reading it fails with something other than
        // "not found", which is the case a `?` used to turn into an early return.
        std::fs::create_dir_all(dir.join(crate::commands::display_names::DISPLAY_NAMES_FILE))
            .unwrap();
        let err = super::remove_account_push_and_name_files(&dir, None, "a").unwrap_err();
        assert!(err.contains("6 push file(s) removed"), "{err}");
        for f in ACCOUNT_PUSH_FILES {
            assert!(!dir.join(f).exists(), "{f}");
        }
        assert!(!dir.join(PUSH_CONTEXT_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The names copy of the deleted account goes with the rest, in both directories.
    #[test]
    fn removes_the_deleted_accounts_names_copy_too() {
        use crate::commands::display_names::{merge_display_names, DISPLAY_NAMES_FILE};
        let dir = dir_with("names_ok", Some(r#"{"userId":"a","deviceId":"d"}"#));
        let group = dir.join("group");
        let names = std::collections::HashMap::from([("1".repeat(64), "Alice".to_string())]);
        merge_display_names(&dir, "a", &names, &[]).unwrap();
        merge_display_names(&group, "a", &names, &[]).unwrap();
        assert_eq!(
            super::remove_account_push_and_name_files(&dir, Some(&group), "a").unwrap(),
            6
        );
        assert!(!dir.join(DISPLAY_NAMES_FILE).exists());
        assert!(!group.join(DISPLAY_NAMES_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An id outside the allowlist is refused before anything is read.
    #[test]
    fn refuses_an_id_outside_the_allowlist() {
        let dir = dir_with("bad", Some(r#"{"userId":"../x"}"#));
        assert!(remove_user_push_files(&dir, None, "../x").is_err());
        assert!(untouched(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod fcm_cache_take_tests {
    use super::{ack_fcm_cache_in, take_fcm_cache_in, FcmCacheTake, FCM_CACHE_FILE};
    use crate::native_cache::{seal_line, CacheKey, Purpose};

    const KEY: CacheKey = [5u8; 32];

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fcm-take-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ids(take: &FcmCacheTake) -> Vec<String> {
        take.entries
            .iter()
            .map(|e| e["messageId"].as_str().unwrap().to_string())
            .collect()
    }

    /// A line as this build's native writers append it: sealed.
    fn push(d: &std::path::Path, id: &str) {
        let line = seal_line(
            &KEY,
            Purpose::PushCache,
            &format!("{{\"messageId\":\"{id}\"}}"),
        );
        std::fs::write(d.join(FCM_CACHE_FILE), format!("{line}\n")).unwrap();
    }

    /// THE UPGRADE: lines an older build wrote in the clear are still taken beside sealed ones,
    /// and the ack deletes the file - which is their migration.
    #[test]
    fn plaintext_lines_of_an_older_build_are_taken_beside_sealed_ones() {
        let d = dir("mixed");
        let sealed = seal_line(&KEY, Purpose::PushCache, "{\"messageId\":\"new\"}");
        std::fs::write(
            d.join(FCM_CACHE_FILE),
            format!("{{\"messageId\":\"old\"}}\n{sealed}\n"),
        )
        .unwrap();
        let take = take_fcm_cache_in(&d, Some(&KEY));
        assert_eq!(ids(&take), vec!["old", "new"]);
        assert_eq!(ack_fcm_cache_in(&d, &take.files), 1);
        assert_eq!(files_in(&d), 0);
        std::fs::remove_dir_all(&d).ok();
    }

    /// At rest a cached message's text is not in the file.
    #[test]
    fn a_sealed_line_carries_no_text() {
        let d = dir("text");
        let line = seal_line(
            &KEY,
            Purpose::PushCache,
            "{\"messageId\":\"a\",\"content\":\"bonjour\"}",
        );
        std::fs::write(d.join(FCM_CACHE_FILE), format!("{line}\n")).unwrap();
        let raw = std::fs::read_to_string(d.join(FCM_CACHE_FILE)).unwrap();
        assert!(!raw.contains("bonjour") && !raw.contains("messageId"));
        let take = take_fcm_cache_in(&d, Some(&KEY));
        assert_eq!(take.entries[0]["content"], "bonjour");
        std::fs::remove_dir_all(&d).ok();
    }

    /// With no key, a file holding a sealed line is NOT handed over - so never acknowledged and
    /// deleted unread - and a later take with the key gets it.
    #[test]
    fn a_take_with_no_key_keeps_a_sealed_file_for_a_take_that_can_read_it() {
        let d = dir("nokey");
        push(&d, "a");
        let blind = take_fcm_cache_in(&d, None);
        assert!(blind.entries.is_empty() && blind.files.is_empty());
        assert_eq!(ids(&take_fcm_cache_in(&d, Some(&KEY))), vec!["a"]);
        std::fs::remove_dir_all(&d).ok();
    }

    /// A sealed line another key wrote is dropped - this install will never open it - and costs
    /// only itself.
    #[test]
    fn a_line_this_key_does_not_open_costs_only_itself() {
        let d = dir("foreign");
        let foreign = seal_line(&[6u8; 32], Purpose::PushCache, "{\"messageId\":\"x\"}");
        let mine = seal_line(&KEY, Purpose::PushCache, "{\"messageId\":\"a\"}");
        std::fs::write(d.join(FCM_CACHE_FILE), format!("{foreign}\n{mine}\n")).unwrap();
        let take = take_fcm_cache_in(&d, Some(&KEY));
        assert_eq!(ids(&take), vec!["a"]);
        assert_eq!(take.files.len(), 1);
        std::fs::remove_dir_all(&d).ok();
    }

    fn files_in(d: &std::path::Path) -> usize {
        std::fs::read_dir(d).unwrap().count()
    }

    /// The defect: the cache was deleted before the frontend persisted it, so a process death in
    /// between lost it. A take that is never acknowledged must be handed over again.
    #[test]
    fn an_unacknowledged_take_is_handed_over_again() {
        let d = dir("replay");
        push(&d, "a");
        assert_eq!(ids(&take_fcm_cache_in(&d, Some(&KEY))), vec!["a"]);
        // The process dies here, with no ack. A push arrives before the next boot.
        push(&d, "b");
        let second = take_fcm_cache_in(&d, Some(&KEY));
        assert_eq!(ids(&second), vec!["a", "b"]);
        assert!(!d.join(FCM_CACHE_FILE).exists());
        assert_eq!(ack_fcm_cache_in(&d, &second.files), 2);
        assert_eq!(files_in(&d), 0);
        assert!(take_fcm_cache_in(&d, Some(&KEY)).entries.is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    /// A native write that lands in a taken file AFTER it was read makes it larger than the size
    /// handed over: the ack keeps it, and the next take hands the late line over.
    #[test]
    fn a_line_written_after_the_read_is_never_deleted_unread() {
        let d = dir("late");
        push(&d, "a");
        let take = take_fcm_cache_in(&d, Some(&KEY));
        let taken = d.join(&take.files[0].name);
        let mut body = std::fs::read_to_string(&taken).unwrap();
        body.push_str("{\"messageId\":\"late\"}\n");
        std::fs::write(&taken, body).unwrap();
        assert_eq!(ack_fcm_cache_in(&d, &take.files), 0);
        assert_eq!(ids(&take_fcm_cache_in(&d, Some(&KEY))), vec!["a", "late"]);
        std::fs::remove_dir_all(&d).ok();
    }

    /// An ack deletes only the taken files it names, and nothing that is not a taken file.
    #[test]
    fn an_ack_deletes_only_the_taken_files_it_names() {
        let d = dir("names");
        push(&d, "a");
        let first = take_fcm_cache_in(&d, Some(&KEY));
        push(&d, "b");
        // The live file was taken by a second take nobody has acknowledged yet.
        std::fs::rename(
            d.join(FCM_CACHE_FILE),
            d.join("fcm_message_cache.taken.9.ndjson"),
        )
        .unwrap();
        assert_eq!(ack_fcm_cache_in(&d, &first.files), 1);
        assert!(d.join("fcm_message_cache.taken.9.ndjson").exists());
        let forged = vec![super::FcmTakenFile {
            name: "mls.bin".to_string(),
            bytes: 1,
        }];
        std::fs::write(d.join("mls.bin"), b"x").unwrap();
        assert_eq!(ack_fcm_cache_in(&d, &forged), 0);
        assert!(d.join("mls.bin").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn nothing_to_take_is_empty() {
        let d = dir("empty");
        let t = take_fcm_cache_in(&d, Some(&KEY));
        assert!(t.entries.is_empty());
        assert!(t.files.is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    /// A line that will not parse costs only itself, as it did before.
    #[test]
    fn an_unparsable_line_costs_only_itself() {
        let d = dir("garbage");
        std::fs::write(
            d.join(FCM_CACHE_FILE),
            "not json\n\n{\"messageId\":\"a\"}\n",
        )
        .unwrap();
        assert_eq!(ids(&take_fcm_cache_in(&d, Some(&KEY))), vec!["a"]);
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod push_context_lock_tests {
    use super::{
        remove_user_push_files_proved, write_session_push_context, PUSH_CONTEXT_FILE,
        PUSH_CONTEXT_LOCK,
    };

    fn owner(dir: &std::path::Path) -> Option<String> {
        let bytes = std::fs::read(dir.join(PUSH_CONTEXT_FILE)).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        v.get("userId")?.as_str().map(str::to_string)
    }

    /// A new sign-in storing its context inside the deletion's window - after the proof, before
    /// the removals - is held until the deletion is done, and its context survives it.
    #[test]
    fn a_sign_in_during_the_deletion_keeps_its_push_context() {
        let dir = std::env::temp_dir().join(format!("canari_push_ctx_lock_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_session_push_context(&dir, "deleted", "d1", "https://x", "t1", None).unwrap();

        let mut sign_in = None;
        let removed = remove_user_push_files_proved(&dir, None, "deleted", || {
            // The proof and the removals are one critical section.
            assert!(PUSH_CONTEXT_LOCK.try_lock().is_err());
            let d = dir.clone();
            sign_in = Some(std::thread::spawn(move || {
                write_session_push_context(&d, "new", "d2", "https://x", "t2", None)
            }));
        })
        .unwrap();
        sign_in.unwrap().join().unwrap().unwrap();

        assert_eq!(
            removed, 1,
            "only the deleted account's context was there to remove"
        );
        assert_eq!(owner(&dir).as_deref(), Some("new"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
