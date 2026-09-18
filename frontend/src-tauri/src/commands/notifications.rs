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
#[tauri::command]
pub(crate) fn notifier_message_natif(
    group_id: String,
    sender_id: String,
    sender_name: String,
    group_name: String,
    body: String,
    mentions_me: bool,
    sent_at: i64,
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
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZJ)Z",
                &[
                    (&args[0]).into(),
                    (&args[1]).into(),
                    (&args[2]).into(),
                    (&args[3]).into(),
                    (&args[4]).into(),
                    JValue::Bool(u8::from(mentions_me)),
                    JValue::Long(sent_at),
                ],
            )
            .and_then(|v| v.z())
        {
            Ok(accepted) => {
                log::debug!(
                    "[NOTIF] native builder {} for {}",
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
        );
        false
    }
}
