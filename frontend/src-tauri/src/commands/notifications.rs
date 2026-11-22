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
//! what [`notify_native_message`] is.
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
/// `server_at` is the server's acceptance of that message (0 when the frame carried none), handed to
/// the shade's "mark as read" and quick reply so their mark lands on the clock the conversation is
/// ordered by (readState.ts). `covers` is how many inbound messages this one banner stands for (a catch-up flush raises one
/// banner for N), which the Kotlin `GenericBannerLedger` credits against refused pushes.
/// `author_proven` is whether the WebView's open PROVED the author (a salon row under a Graine v2
/// session): a salon banner names its speaker only then, the same rule the push trigger applies to
/// its own native open (`ChannelBannerAuthor`), so the two triggers of one message agree.
/// `is_group` is whether the conversation is a group or a salon, from the WebView's conversation
/// type: the push carries the same fact as `isGroup`, and the name cannot answer it (a third of
/// groups have none), so both triggers draw an unnamed group as a group (`ConversationShape`).
/// `None` when the row carries no type: handed to Kotlin as a null `java.lang.Boolean`, the same
/// "not said" the push's absent `isGroup` is, so the builder falls back to the name rule.
/// `reaction` says the frame is a REACTION to one of this account's messages (2026-11-17), not a
/// message: `body` is then the emoji and `sender_*` the actor, and Kotlin posts the push's own
/// reaction composition on `canari_reactions_v2` under `reaction:<groupId>` - the WebView raises it
/// only while the app is in front with that conversation off screen, where the push is dropped.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn notify_native_message(
    group_id: String,
    sender_id: String,
    sender_name: String,
    group_name: String,
    body: String,
    mentions_me: bool,
    sent_at: i64,
    server_at: i64,
    covers: i32,
    author_proven: bool,
    is_group: Option<bool>,
    reaction: bool,
) -> bool {
    #[cfg(target_os = "android")]
    {
        use jni::objects::{JObject, JValue};

        with_native_builder(|env, class| {
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
                        log::error!(
                            "[NOTIF] new_string({what}) failed: {e} - notification NOT raised"
                        );
                        return false;
                    }
                }
            }
            // A boxed Boolean, so "not said" stays null rather than becoming `false` (a DM). The class
            // is a boot class, which the system loader of this attached thread does find.
            let is_group_arg = match is_group {
                None => JObject::null(),
                Some(value) => {
                    match env.new_object(
                        "java/lang/Boolean",
                        "(Z)V",
                        &[JValue::Bool(u8::from(value))],
                    ) {
                        Ok(boxed) => boxed,
                        Err(e) => {
                            log::error!("[NOTIF] new_object(isGroup) failed: {e} - NOT raised");
                            return false;
                        }
                    }
                }
            };

            match env
            .call_static_method(
                class,
                "notifyMessageFromWebSocket",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZJJIZLjava/lang/Boolean;Z)Z",
                &[
                    (&args[0]).into(),
                    (&args[1]).into(),
                    (&args[2]).into(),
                    (&args[3]).into(),
                    (&args[4]).into(),
                    JValue::Bool(u8::from(mentions_me)),
                    JValue::Long(sent_at),
                    JValue::Long(server_at),
                    JValue::Int(covers),
                    JValue::Bool(u8::from(author_proven)),
                    (&is_group_arg).into(),
                    JValue::Bool(u8::from(reaction)),
                ],
            )
            .and_then(|v| v.z())
        {
            Ok(accepted) => {
                log::debug!(
                    "[NOTIF] native builder {} for {} (covers {covers}){}",
                    if accepted { "queued" } else { "refused" },
                    group_id.chars().take(8).collect::<String>(),
                    if reaction { " - a reaction" } else { "" }
                );
                accepted
            }
            Err(e) => {
                log::error!("[NOTIF] notifyMessageFromWebSocket failed: {e} - NOT raised");
                false
            }
        }
        })
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
            server_at,
            covers,
            author_proven,
            is_group,
            reaction,
        );
        false
    }
}

/// Runs `call` against `CanariFirebaseMessagingService` on a thread attached to the JVM - the ONE
/// door both commands of this file take into the native builder.
///
/// NOT `find_class`. A thread attached from native code has no Java frames on its stack, so
/// `FindClass` falls back to the SYSTEM class loader, which knows the boot classpath and nothing of
/// ours - the reason `flush_webview_cookies` could only ever call a framework class. The app's own
/// loader is cached at `JNI_OnLoad`, where the stack still has one.
///
/// `false` when the class cannot be reached (no JavaVM, no attach, no class loader), logged at a
/// level that accuses: nothing the caller asked of the native builder happened.
///
/// A JAVA EXCEPTION THE CALL LEFT PENDING IS CLEARED HERE, the one door: `call_static_method`
/// answers `Error::JavaException` and leaves the exception set on the thread, where the next JNI
/// call from it would abort the process. It is described to logcat (its stack is the evidence),
/// then cleared, and the call reads as not done.
#[cfg(target_os = "android")]
pub(crate) fn with_native_builder(
    call: impl FnOnce(&mut jni::JNIEnv<'_>, &jni::objects::JClass<'_>) -> bool,
) -> bool {
    let Some(vm) = crate::android_java_vm() else {
        log::error!("[NOTIF] no JavaVM cached - the native builder was NOT reached");
        return false;
    };
    let mut env = match vm.attach_current_thread() {
        Ok(env) => env,
        Err(e) => {
            log::error!(
                "[NOTIF] attach_current_thread failed: {e} - the native builder was NOT reached"
            );
            return false;
        }
    };
    let Some(class) =
        crate::find_app_class(&mut env, "fr.emse.canari.CanariFirebaseMessagingService")
    else {
        log::error!("[NOTIF] CanariFirebaseMessagingService not loadable - NOT reached");
        return false;
    };
    let done = call(&mut env, &class);
    if env.exception_check().unwrap_or(false) {
        log::error!("[NOTIF] the native builder threw - described below, cleared, NOT done");
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return false;
    }
    done
}

/// Tells the native side that THIS ACCOUNT read a conversation on another device, as the WebView
/// learned it over its socket, so it removes the conversation's notification once the read covers
/// every line of it (Android).
///
/// **THE SECOND TRIGGER OF THE CANCEL**, as [`notify_native_message`] is the second trigger of the
/// post. The push was the cancel's only trigger, and the server pushes only a frame the device did
/// not ACK: a self read receipt the WebView received over its socket (app in front, or backgrounded
/// and not yet frozen) was never pushed, so the banner the WebView had posted for that conversation
/// was never removed (owner's report, 2026-11-20).
///
/// `at` is the mark and `server_clock` its clock: Kotlin RECORDS it beside the cancel, and every
/// post checks it, so a post of a message this mark covers that reaches Kotlin AFTER this call is
/// not posted - the order of the two decides nothing (`ReadElsewhereMarks`). The cancel is decided
/// there too, against the instants stamped on the shade's lines: a line newer than the read keeps
/// the banner, whatever the WebView's row (which can lag behind the shade) counts. Returns whether
/// the work was queued; `false` off Android, where there is no native banner and the caller never
/// calls.
#[tauri::command]
pub(crate) fn record_read_elsewhere(
    group_id: String,
    at: i64,
    server_clock: bool,
    reason: String,
) -> bool {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;

        with_native_builder(|env, class| {
            let (group, why) = match (env.new_string(&group_id), env.new_string(&reason)) {
                (Ok(group), Ok(why)) => (group, why),
                (Err(e), _) | (_, Err(e)) => {
                    log::error!(
                        "[NOTIF] new_string failed: {e} - the read elsewhere was NOT recorded"
                    );
                    return false;
                }
            };
            match env
                .call_static_method(
                    class,
                    "readElsewhereFromWebSocket",
                    "(Ljava/lang/String;JZLjava/lang/String;)Z",
                    &[
                        (&group).into(),
                        JValue::Long(at),
                        JValue::Bool(u8::from(server_clock)),
                        (&why).into(),
                    ],
                )
                .and_then(|v| v.z())
            {
                // Kotlin logs what it queued; a refusal it already accused there.
                Ok(queued) => queued,
                Err(e) => {
                    log::error!("[NOTIF] readElsewhereFromWebSocket failed: {e} - NOT recorded");
                    false
                }
            }
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (group_id, at, server_clock, reason);
        false
    }
}

/// iOS: takes down a conversation's DELIVERED notifications - the page's reader opened it
/// (`read_here`) or it ended (`conversation_ended`) - and recomputes the badge from what remains.
///
/// Opening the app removes nothing any more (owner, 2026-11-21: "N'effacer que les lues"): each
/// banner goes with ITS conversation, and this is the event that says so on the device whose own
/// reader is the one reading, which no push or socket echo reports back. A class message to
/// `CanariConversationNotifications` (`canari_push.mm`) through the Objective-C runtime rather than
/// a symbol, because this crate is linked into the notification extension too, which does not carry
/// that class (see `push_registration.rs`). Returns whether the removal was asked; `false` off iOS,
/// where the caller never calls (Android has [`record_read_elsewhere`]).
#[tauri::command]
pub(crate) fn cancel_conversation_notifications(group_id: String, reason: String) -> bool {
    #[cfg(target_os = "ios")]
    {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        use std::ffi::CString;

        let Ok(group) = CString::new(group_id.as_str()) else {
            log::error!(
                "[NOTIF] a conversation id with a NUL byte - nothing taken down ({reason})"
            );
            return false;
        };
        let (Some(class), Some(str_class)) = (
            AnyClass::get(c"CanariConversationNotifications"),
            AnyClass::get(c"NSString"),
        ) else {
            log::error!(
                "[NOTIF] CanariConversationNotifications is not loaded - the notifications of a conversation ({reason}) stay"
            );
            return false;
        };
        objc2::rc::autoreleasepool(|_| {
            // SAFETY: `stringWithUTF8String:` takes a NUL-terminated C string that outlives the call
            // (`group`), and `cancelForConversation:` is a class method declared `+ (BOOL)` taking
            // one NSString in canari_push.mm; it only schedules work on the notification centre.
            unsafe {
                let ns: *mut AnyObject = msg_send![str_class, stringWithUTF8String: group.as_ptr()];
                let queued: bool = msg_send![class, cancelForConversation: ns];
                log::debug!("[NOTIF] taking down the notifications of a conversation ({reason}): queued={queued}");
                queued
            }
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (group_id, reason);
        false
    }
}

/// What the page's ask of the announced-messages ledger answered (`mobile::announced`).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageAnnouncement {
    /// Whether the page raises its banner: one message of it nobody announced is enough.
    raise: bool,
    fresh: usize,
    by_extension: usize,
    by_page: usize,
    /// The keys the banner covers, stamped on it so the extension can replace it.
    keys: Vec<String>,
}

/// One message a page banner covers: its sender and its instant, the two halves of its key in the
/// announced-messages ledger with the conversation (`mobile::announced::announce_key`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
// Read on iOS only, where the ledger is.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) struct AnnouncedMessageArg {
    sender_id: String,
    at: i64,
}

/// iOS: the page asks, BEFORE it raises the one banner covering `messages` of `conversation_id`,
/// whether any of them is still unannounced - the notification extension draws every
/// alert push and acknowledges nothing, so a cold launch or a resume redelivers what it already
/// showed (`docs/wiki/frontend/ios-notification-ownership.md`). Every key is claimed in the same
/// locked step, over the ledger sealed under the install's native cache key. An `Err` is a ledger
/// that could not be read or written, a cache key that cannot be read, or a banner whose messages
/// carry no sender or instant: the page says so at ERROR. Off iOS there is no extension to share
/// with: `Err`.
#[tauri::command]
pub(crate) fn claim_message_announcement(
    app: tauri::AppHandle,
    conversation_id: String,
    messages: Vec<AnnouncedMessageArg>,
) -> Result<MessageAnnouncement, String> {
    #[cfg(target_os = "ios")]
    {
        let dir = crate::app_group::app_group_dir()?;
        let key = crate::native_cache::app_cache_key(&app)?;
        let messages: Vec<(String, i64)> =
            messages.into_iter().map(|m| (m.sender_id, m.at)).collect();
        let (claim, keys) =
            crate::mobile::announced::page_claim_in(&dir, &key, &conversation_id, &messages)?;
        Ok(MessageAnnouncement {
            raise: claim.raise(),
            fresh: claim.fresh,
            by_extension: claim.by_extension,
            by_page: claim.by_page,
            keys,
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, conversation_id, messages);
        Err("no notification extension shares this ledger off iOS".to_string())
    }
}

/// Android: a conversation ENDED (deleted, left, excluded, its salon or community gone) - withdraws
/// its message banner, its reaction notification and the summary's share of them, UNCONDITIONALLY and
/// without recording any read mark (`endConversationFromWebSocket`).
///
/// It is not a read, and must never travel the read path: a mark is a process-lifetime record that
/// suppresses later posts at or below it, so an ending routed through [`record_read_elsewhere`] with
/// a huge mark silenced the conversation for good once the account came back to it. Returns whether
/// the work was queued; `false` off Android.
#[tauri::command]
pub(crate) fn end_conversation_notifications(group_id: String, reason: String) -> bool {
    #[cfg(target_os = "android")]
    {
        with_native_builder(|env, class| {
            let (group, why) = match (env.new_string(&group_id), env.new_string(&reason)) {
                (Ok(group), Ok(why)) => (group, why),
                (Err(e), _) | (_, Err(e)) => {
                    log::error!(
                        "[NOTIF] new_string failed: {e} - the ended conversation was NOT withdrawn"
                    );
                    return false;
                }
            };
            match env
                .call_static_method(
                    class,
                    "endConversationFromWebSocket",
                    "(Ljava/lang/String;Ljava/lang/String;)Z",
                    &[(&group).into(), (&why).into()],
                )
                .and_then(|v| v.z())
            {
                Ok(queued) => queued,
                Err(e) => {
                    log::error!(
                        "[NOTIF] endConversationFromWebSocket failed: {e} - its banner may stay"
                    );
                    false
                }
            }
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (group_id, reason);
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

/// The bytes of one face from the base64 the WebView sends; an undecodable string is refused by
/// name rather than written as an empty or truncated file.
#[cfg(any(target_os = "android", test))]
fn decode_avatar_b64(data_b64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("{} chars that are not base64: {e}", data_b64.len()))
}

/// Hands the bytes of a face the WebView has just drawn to the notification's cache (Android).
///
/// `data_b64` is the image as ONE base64 string. **NOT a raw invoke body**: the first version read
/// `tauri::ipc::Request` and the Mi 9T refused every call with "the body is not raw bytes" -
/// Android's IPC delivers its arguments as JSON, whatever the caller passed. And NOT a number array
/// (`Vec<u8>`, the shape this took until 2026-10-13): JSON spells each byte as up to four
/// characters, and the WebView builds and serialises one number per byte on its main thread - 50
/// faces of 7.5 KB cost 360-440 ms there as an array, 130-150 ms as base64 (Mi 9T). Off Android it
/// refuses: the iOS extension reads its own app-group container, which this does not write, and the
/// caller checks the platform before it calls.
#[tauri::command]
pub(crate) fn store_avatar_mirror(
    app: tauri::AppHandle,
    user_id: String,
    data_b64: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        decode_avatar_b64(&data_b64)
            .and_then(|data| write_avatar_mirror(&data_dir, &user_id, &data))
            .inspect_err(|e| {
                log::warn!(
                    "[AVATAR_MIRROR] {} not mirrored: {e}",
                    avatar_cache_stem(&user_id)
                );
            })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, data_b64);
        log::warn!("[AVATAR_MIRROR] refused off Android for {user_id}: no reader here");
        Err("android only".into())
    }
}

#[cfg(test)]
mod avatar_mirror_tests {
    use super::{avatar_cache_stem, decode_avatar_b64, write_avatar_mirror};

    #[test]
    fn decodes_the_base64_the_webview_sends_and_refuses_anything_else() {
        // "/9j/4AAQ" is what `toBase64` makes of a JPEG's first six bytes.
        assert_eq!(
            decode_avatar_b64("/9j/4AAQ").unwrap(),
            vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]
        );
        assert!(decode_avatar_b64("not base64!").is_err());
    }

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
