//! The one notification builder, asked for from the WebView (Android).
//!
//! **WHY THIS FILE EXISTS.** Android used to have TWO message-notification builders, and they had
//! nothing in common but the channel they filed on:
//!
//! | | the plain one | the rich one |
//! | --- | --- | --- |
//! | built by | the WebView, `tauri-plugin-notification` | `CanariFirebaseMessagingService` |
//! | triggered by | a WebSocket frame | an FCM data push |
//! | suppressed when | the reader can SEE the message land | the app is in the foreground |
//! | a tap | opens the app onto nothing | opens the conversation |
//!
//! The two suppression predicates are DISJOINT - a backgrounded app satisfies neither - and the
//! two id namespaces cannot collide, so a message that arrived over the socket AND was pushed
//! (the server pushes a frame the client has not ACKed after 10 s) produced two notifications
//! side by side for one message. Reported by the user on 2026-09-18 with a capture of the pair.
//!
//! So the WebSocket frame stopped being a second BUILDER and became a second TRIGGER for the same
//! one. That needs a call in the direction this app had never made - Rust into Kotlin - which is
//! what [`notifier_message_natif`] is.
//!
//! The DESKTOP notification path is untouched: it is a different implementation (`notify-rust`)
//! with a different defect surface, and nothing here has been measured against it.

/// Asks the native builder to post (or update) the notification for one conversation.
///
/// Returns whether the native side ACCEPTED the work. It cannot say more synchronously: building
/// the notification fetches the sender's avatar over HTTP, so Kotlin queues it on its own lane and
/// answers immediately. `false` therefore means the request never reached a builder at all - no
/// JavaVM, no class loader, or no Application context - and every one of those is logged here at a
/// level that accuses, because on Android this is now the ONLY path to a banner for a message the
/// server will never push.
///
/// `false` off Android for a different reason entirely: there is no native builder to ask. The
/// caller checks the platform before calling and never reaches this branch; it exists so the
/// command is present on every target rather than being a conditional part of the API surface.
///
/// # Arguments
///
/// Mirrors what the push payload carries, so that both triggers render the same notification:
/// `group_name` is EMPTY for a direct message, and `sent_at` is the sender's own instant in
/// milliseconds (0 when unknown, which costs the de-duplication of a message arriving both ways).
/// `covers` is how many inbound messages this one banner stands for (a catch-up flush raises one
/// banner for N), which the Kotlin `GenericBannerLedger` credits against refused pushes.
#[tauri::command]
pub(crate) fn notifier_message_natif(
    group_id: String,
    sender_id: String,
    sender_name: String,
    group_name: String,
    body: String,
    mentions_me: bool,
    sent_at: i64,
    covers: i32,
) -> bool {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;

        let Some(vm) = crate::android_java_vm() else {
            log::error!("[NOTIF] no JavaVM cached - the message notification was NOT raised");
            return false;
        };
        let mut env = match vm.attach_current_thread() {
            Ok(env) => env,
            Err(e) => {
                log::error!("[NOTIF] attach_current_thread failed: {e} - notification NOT raised");
                return false;
            }
        };
        // NOT `find_class`. A thread attached from native code has no Java frames on its stack, so
        // `FindClass` falls back to the SYSTEM class loader, which knows the boot classpath and
        // nothing of ours - the reason `flush_webview_cookies` could only ever call a framework
        // class. The app's own loader is cached at `JNI_OnLoad`, where the stack still has one.
        let Some(class) =
            crate::find_app_class(&mut env, "fr.emse.canari.CanariFirebaseMessagingService")
        else {
            log::error!("[NOTIF] CanariFirebaseMessagingService not loadable - NOT raised");
            return false;
        };

        // Built in one pass so that a failure names WHICH argument failed: five separate matches
        // would say the same thing five times, and one shared message would say nothing.
        let mut args = Vec::with_capacity(5);
        for (value, what) in [
            (&group_id, "groupId"),
            (&sender_id, "senderId"),
            (&sender_name, "senderName"),
            (&group_name, "groupName"),
            (&body, "body"),
        ] {
            match env.new_string(value) {
                Ok(s) => args.push(s),
                Err(e) => {
                    log::error!("[NOTIF] new_string({what}) failed: {e} - notification NOT raised");
                    return false;
                }
            }
        }

        match env
            .call_static_method(
                &class,
                "notifyMessageFromWebSocket",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZJI)Z",
                &[
                    (&args[0]).into(),
                    (&args[1]).into(),
                    (&args[2]).into(),
                    (&args[3]).into(),
                    (&args[4]).into(),
                    JValue::Bool(u8::from(mentions_me)),
                    JValue::Long(sent_at),
                    JValue::Int(covers),
                ],
            )
            .and_then(|v| v.z())
        {
            Ok(accepted) => {
                log::debug!(
                    "[NOTIF] native builder {} for {} (covers {covers})",
                    if accepted { "queued" } else { "refused" },
                    group_id.chars().take(8).collect::<String>()
                );
                accepted
            }
            Err(e) => {
                log::error!("[NOTIF] notifyMessageFromWebSocket failed: {e} - NOT raised");
                false
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (
            group_id,
            sender_id,
            sender_name,
            group_name,
            body,
            mentions_me,
            sent_at,
            covers,
        );
        false
    }
}

// --- The foreground's faces, handed to the notification's cache ---------------------------------

/// The file name `CanariFirebaseMessagingService.avatarCacheFile` reads for `user_id`, without its
/// extension. **Both spellings must agree byte for byte** - every character outside
/// `[A-Za-z0-9_-]` becomes `_`, then the first 40 are kept, behind the `avatar_` prefix the device
/// wipe (`storage.rs`) erases by - or the mirror writes a file nobody reads.
/// `avatarMirror.test.ts` holds the Kotlin spelling and this one together.
///
/// Compiled where its reader exists (Android) and under test - the same `cfg` as the two below.
#[cfg(any(target_os = "android", test))]
pub(crate) fn avatar_cache_stem(user_id: &str) -> String {
    let safe: String = user_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    format!("avatar_{safe}")
}

/// Whether `bytes` open like one of the image formats the avatar route serves. A body the WebView
/// read as `ok` is not proof of a picture - a proxy's HTML page is `200` too - and a file that is
/// not one would sit in the notification's cache for a day being refused by its decoder.
#[cfg(any(target_os = "android", test))]
fn looks_like_an_image(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(&[0x89, b'P', b'N', b'G'])
        || bytes.starts_with(b"GIF8")
        || (bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

/// Writes one face into the notification's avatar cache, `{data_dir}/files/avatar_<id>.jpg`, and
/// drops any "no picture" marker beside it (`avatar_<id>.absent`).
///
/// **ONE CACHE, ONE READER.** The FCM service reads that file before it asks the network, so a
/// contact the app has drawn never depends on the network for the notification - the bad Wi-Fi of
/// 2026-10-01 drew initials for two faces the app had shown minutes earlier. The write is atomic
/// (a sibling, then a rename) because the reader is another thread that may run at any instant.
///
/// The file's mtime is the moment of THIS write, and that is the decision: the app only holds
/// these bytes because the server vouched for them within its own 24 h `max-age`, so the native
/// 24 h clock now measures "since the app last drew this face" - a contact seen daily never ages
/// out, and a changed photo is at most two days stale in the shade, against one before. No ETag is
/// carried: a cross-origin `fetch` cannot read it without an `Access-Control-Expose-Headers`
/// nobody sends, and the reader would have nothing to compare it with before asking the network,
/// which is the one thing it must not need.
#[cfg(any(target_os = "android", test))]
pub(crate) fn write_avatar_mirror(
    data_dir: &std::path::Path,
    user_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if user_id.trim().is_empty() {
        return Err("no user id".into());
    }
    if !looks_like_an_image(bytes) {
        return Err(format!("{} bytes that are not an image", bytes.len()));
    }
    let dir = data_dir.join("files");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let stem = avatar_cache_stem(user_id);
    let target = dir.join(format!("{stem}.jpg"));
    let staging = dir.join(format!("{stem}.jpg.part"));
    std::fs::write(&staging, bytes).map_err(|e| format!("write {}: {e}", staging.display()))?;
    std::fs::rename(&staging, &target).map_err(|e| format!("rename {}: {e}", target.display()))?;
    let absent = dir.join(format!("{stem}.absent"));
    match std::fs::remove_file(&absent) {
        Ok(()) => log::debug!("[AVATAR_MIRROR] {stem}: the stale no-picture marker is gone"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[AVATAR_MIRROR] {stem}: could not delete the no-picture marker: {e}"),
    }
    log::debug!("[AVATAR_MIRROR] {stem}: {} bytes mirrored", bytes.len());
    Ok(())
}

/// Hands the bytes of a face the WebView has just drawn to the notification's cache (Android).
///
/// `data` is the image as a byte array, the shape `save_mls_state` already takes. **NOT a raw
/// invoke body**: the first version read `tauri::ipc::Request` and the Mi 9T refused every call
/// with "the body is not raw bytes" - Android's IPC delivers a typed array as JSON, whatever the
/// caller passed. Off Android it refuses: the iOS extension reads its own app-group container,
/// which this does not write, and the caller checks the platform before it calls.
#[tauri::command]
pub(crate) fn store_avatar_mirror(
    app: tauri::AppHandle,
    user_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        write_avatar_mirror(&data_dir, &user_id, &data).inspect_err(|e| {
            log::warn!(
                "[AVATAR_MIRROR] {} not mirrored: {e}",
                avatar_cache_stem(&user_id)
            );
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, data);
        log::warn!("[AVATAR_MIRROR] refused off Android for {user_id}: no reader here");
        Err("android only".into())
    }
}

#[cfg(test)]
mod avatar_mirror_tests {
    use super::{avatar_cache_stem, write_avatar_mirror};

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10];

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-avatar-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn spells_the_name_the_kotlin_reader_reads() {
        assert_eq!(avatar_cache_stem("c71e1a5b-0f"), "avatar_c71e1a5b-0f");
        assert_eq!(avatar_cache_stem("a.b/c@d"), "avatar_a_b_c_d");
        assert_eq!(
            avatar_cache_stem(&"x".repeat(64)).len(),
            "avatar_".len() + 40
        );
    }

    #[test]
    fn writes_the_face_and_drops_the_no_picture_marker() {
        let dir = temp_dir("write");
        std::fs::create_dir_all(dir.join("files")).unwrap();
        std::fs::write(dir.join("files/avatar_u1.absent"), b"").unwrap();
        write_avatar_mirror(&dir, "u1", JPEG).unwrap();
        assert_eq!(
            std::fs::read(dir.join("files/avatar_u1.jpg")).unwrap(),
            JPEG
        );
        assert!(!dir.join("files/avatar_u1.absent").exists());
        assert!(!dir.join("files/avatar_u1.jpg.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_what_is_not_a_picture_and_a_face_with_no_owner() {
        let dir = temp_dir("refuse");
        assert!(write_avatar_mirror(&dir, "u1", b"<html>").is_err());
        assert!(write_avatar_mirror(&dir, " ", JPEG).is_err());
        assert!(!dir.join("files/avatar_u1.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
