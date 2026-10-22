//! The device half of "a sign-out ends this device's push registration".
//!
//! WHAT IT GUARANTEES. After any sign-out the device stops being a push destination for the account
//! that left, whether or not the server could be told: the OS push token is deleted (Android
//! `FirebaseMessaging.deleteToken`, iOS `-[FIRMessaging deleteTokenWithCompletion:]`), the push
//! secret that authenticates the background paths is erased, and `push_context.json` keeps only
//! what describes the DEVICE (`userId`, `deviceId`, `locale`) - so every native background reader
//! (`MlsContextLoader.loadPushContext`, `CanariLoadPushContext`, the extension's loader), which
//! requires a `baseUrl`, finds no session to decrypt, fetch or re-register for. The server half is
//! core-service's, at `/api/auth/logout` and at every revocation (`docs/wiki/sessions.md`).
//!
//! TWO MARKS, BECAUSE THEY ANSWER TWO QUESTIONS WITH TWO LIFETIMES:
//!
//! - [`SIGNED_OUT_FILE`] - "does an account own this device's pushes?". Written at the sign-out,
//!   removed by the next registration the server ANSWERS (`write_push_secret`). While it exists a
//!   push that still arrives is dropped by the native handlers, never shown.
//! - [`DELETION_OWED_FILE`] - "has the OS token been deleted since the sign-out?". Written at the
//!   sign-out, removed by the native side once the deletion succeeded. An offline sign-out leaves it,
//!   and the deletion is completed at the next launch / foreground (`MainActivity`, the boot
//!   receiver, `CanariSyncFcmTokenIfApnsReady`) and by `startPushService` BEFORE it registers.
//!
//! Durable files, not a timer: whether the deletion is owed is a fact on disk, read by every path
//! that could otherwise re-register the old token. The native side owns the deletion itself and
//! removes the owed mark; this file writes the marks and strips the account's push files.

#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager;

use crate::commands::push::{
    push_context_guard, EXTENSION_PUSH_SECRET_FILE, PENDING_PUSH_SECRET_FILE, PUSH_CONTEXT_FILE,
};

/// Present while no account owns this device's pushes. Name shared with `PushRegistrationEnd.kt`
/// and `canari_push.mm` - change all three together.
pub(crate) const SIGNED_OUT_FILE: &str = "push_signed_out";

/// Present while the OS push token of the account that left has not been deleted. Name shared with
/// `PushRegistrationEnd.kt` and `canari_push.mm` - change all three together.
pub(crate) const DELETION_OWED_FILE: &str = "push_token_deletion_owed";

/// The token the native side mirrors for `get_fcm_token`; the registration that ended named it.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
const FCM_TOKEN_FILE: &str = "fcm_token.txt";

/// The iOS PushKit (VoIP) token `CanariPersistVoipToken` writes and `get_voip_token` reads; the
/// registration that ended named it, so the next one must not send it before PushKit hands a fresh
/// one (`didUpdatePushCredentials` runs at every launch).
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
const VOIP_TOKEN_FILE: &str = "voip_token.txt";

/// The keys of `push_context.json` that describe the DEVICE and outlive a sign-out - an ALLOWLIST,
/// so a key added to the context later is dropped at sign-out until somebody decides it is not the
/// session's. `userId` + `deviceId` are the identity mirror `load_push_context` restores (see
/// `store_device_identity`), `locale` is the language the user chose. `baseUrl` and the bearer
/// `pushToken` belong to the session that ended.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
const DEVICE_CONTEXT_KEYS: [&str; 3] = ["userId", "deviceId", "locale"];

/// Writes both marks and strips this account's push material from `data_dir` (and from
/// `extension_dir`, the iOS App Group container, `None` elsewhere).
///
/// Every step is attempted whatever an earlier one did - a mark that could not be written must not
/// keep the bearer token on disk - and the first error is returned once all of them ran.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub(crate) fn end_push_registration_files(
    data_dir: &std::path::Path,
    extension_dir: Option<&std::path::Path>,
) -> Result<(), String> {
    log::info!("[PushEnd] ending this device's push registration");
    let mut first_error: Option<String> = None;
    let mut note = |what: &str, e: String| {
        log::error!("[PushEnd] {what}: {e}");
        first_error.get_or_insert(format!("{what}: {e}"));
    };

    if let Err(e) = std::fs::create_dir_all(data_dir) {
        note("data directory not created", e.to_string());
    }
    for mark in [SIGNED_OUT_FILE, DELETION_OWED_FILE] {
        if let Err(e) = std::fs::write(data_dir.join(mark), b"1") {
            note(&format!("{mark} not written"), e.to_string());
        }
    }
    if let Err(e) = keep_device_context_only(data_dir) {
        note("push context not stripped", e);
    }
    let mut removed = 0usize;
    let mut failures = 0usize;
    for name in [PENDING_PUSH_SECRET_FILE, FCM_TOKEN_FILE, VOIP_TOKEN_FILE] {
        crate::commands::storage::remove_entry(&data_dir.join(name), &mut removed, &mut failures);
    }
    if let Some(dir) = extension_dir {
        // The extension's copies: its secret, and the context it decrypts with. The next mirror
        // (`CanariMirrorPushStateToAppGroup`) copies the stripped context back, never this one.
        for name in [EXTENSION_PUSH_SECRET_FILE, PUSH_CONTEXT_FILE] {
            crate::commands::storage::remove_entry(&dir.join(name), &mut removed, &mut failures);
        }
    }
    if failures > 0 {
        note(
            "push files not removed",
            format!("{failures} file(s) could not be removed"),
        );
    }
    log::info!("[PushEnd] {removed} push file(s) removed, {failures} failed");
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Rewrites `push_context.json` with [`DEVICE_CONTEXT_KEYS`] only, under the context lock. An absent
/// file is nothing to strip; an unreadable one is removed, since nothing proves which keys it holds.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn keep_device_context_only(data_dir: &std::path::Path) -> Result<(), String> {
    let path = data_dir.join(PUSH_CONTEXT_FILE);
    let _guard = push_context_guard();
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::debug!("[PushEnd] no {PUSH_CONTEXT_FILE} - nothing to strip");
            return Ok(());
        }
        Err(e) => return Err(format!("{PUSH_CONTEXT_FILE} unreadable: {e}")),
    };
    let Ok(serde_json::Value::Object(ctx)) = serde_json::from_slice::<serde_json::Value>(&bytes)
    else {
        log::error!("[PushEnd] {PUSH_CONTEXT_FILE} is not a JSON object - removed whole");
        return std::fs::remove_file(&path).map_err(|e| e.to_string());
    };
    let kept: serde_json::Map<String, serde_json::Value> = ctx
        .into_iter()
        .filter(|(k, _)| DEVICE_CONTEXT_KEYS.contains(&k.as_str()))
        .collect();
    std::fs::write(&path, serde_json::Value::Object(kept).to_string()).map_err(|e| e.to_string())
}

/// Removes [`SIGNED_OUT_FILE`]: the server has just answered a registration, so this device is a
/// push destination again. Called by `write_push_secret`, the one place that answer lands.
pub(crate) fn clear_signed_out_mark(data_dir: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(data_dir.join(SIGNED_OUT_FILE)) {
        Ok(()) => {
            log::info!("[PushEnd] a registration was answered - this device receives pushes again");
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            log::error!("[PushEnd] {SIGNED_OUT_FILE} not removed - pushes stay dropped: {e}");
            Err(format!("{SIGNED_OUT_FILE} not removed: {e}"))
        }
    }
}

/// Ends this device's push registration at a sign-out: [`end_push_registration_files`], then the
/// native deletion of the OS token and of the platform-held push secret.
///
/// Returns whether the token deletion COMPLETED. `false` is not an error: it means the deletion is
/// owed ([`DELETION_OWED_FILE`] stays) and will be completed before anything registers again; the
/// native side has logged why. `Err` means a file step failed, and the native deletion was still
/// attempted. Always `Ok(true)` off the phone platforms, which have no push registration.
#[tauri::command]
pub(crate) async fn end_push_registration(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        #[cfg(target_os = "ios")]
        let files = {
            let group = crate::app_group::app_group_dir();
            if let Err(e) = &group {
                log::error!(
                    "[PushEnd] no App Group container - the extension's copies were not reached: {e}"
                );
            }
            end_push_registration_files(&data_dir, group.as_deref().ok())
        };
        #[cfg(target_os = "android")]
        let files = end_push_registration_files(&data_dir, None);
        let deleted = run_native(NativeStep::EndForSignOut).await;
        files.map(|()| deleted)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        log::debug!("[PushEnd] no push registration on this platform");
        Ok(true)
    }
}

/// Completes a token deletion a sign-out left owed, and answers whether none is owed any more.
/// `startPushService` calls it before registering, so the token of the account that left is never
/// the one registered for the next. Always `true` off the phone platforms.
#[tauri::command]
pub(crate) async fn complete_owed_push_token_deletion(app: tauri::AppHandle) -> bool {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        match app.path().app_data_dir() {
            Ok(dir) if !dir.join(DELETION_OWED_FILE).exists() => return true,
            Ok(_) => {}
            Err(e) => {
                log::error!(
                    "[PushEnd] app_data_dir() failed - the owed deletion is not known: {e}"
                );
                return false;
            }
        }
        log::info!("[PushEnd] a token deletion is owed - completing it before any registration");
        run_native(NativeStep::CompleteOwed).await
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        true
    }
}

/// Which native entry point [`run_native`] calls.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Clone, Copy, Debug)]
enum NativeStep {
    /// Erase the platform-held push secret, then [`NativeStep::CompleteOwed`].
    EndForSignOut,
    /// Delete the OS push token if [`DELETION_OWED_FILE`] says it is owed.
    CompleteOwed,
}

/// Runs `step` on a blocking thread - the deletion waits on the network, which neither the main
/// thread nor an async worker may do - and answers whether the token deletion completed.
#[cfg(any(target_os = "android", target_os = "ios"))]
async fn run_native(step: NativeStep) -> bool {
    match tauri::async_runtime::spawn_blocking(move || native_step(step)).await {
        Ok(done) => done,
        Err(e) => {
            log::error!("[PushEnd] {step:?} did not run - the token deletion stays owed: {e}");
            false
        }
    }
}

/// Android: a static upcall into `fr.emse.canari.PushRegistrationEnd`, through the app's
/// class loader (see `find_app_class`).
#[cfg(target_os = "android")]
fn native_step(step: NativeStep) -> bool {
    let method = match step {
        NativeStep::EndForSignOut => "endForSignOutFromRust",
        NativeStep::CompleteOwed => "completeOwedDeletionFromRust",
    };
    let Some(vm) = crate::android_java_vm() else {
        log::error!("[PushEnd] no JavaVM cached - {method} not called, the deletion stays owed");
        return false;
    };
    let mut env = match vm.attach_current_thread() {
        Ok(env) => env,
        Err(e) => {
            log::error!("[PushEnd] attach_current_thread failed: {e} - the deletion stays owed");
            return false;
        }
    };
    let Some(class) = crate::find_app_class(&mut env, "fr.emse.canari.PushRegistrationEnd") else {
        log::error!("[PushEnd] PushRegistrationEnd not loadable - the deletion stays owed");
        return false;
    };
    match env
        .call_static_method(&class, method, "()Z", &[])
        .and_then(|v| v.z())
    {
        Ok(done) => {
            log::info!("[PushEnd] {method}: token deletion {}", completed(done));
            done
        }
        Err(e) => {
            log::error!("[PushEnd] {method} failed: {e} - the deletion stays owed");
            false
        }
    }
}

/// iOS: a class message to `CanariPushRegistrationEnd` (`canari_push.mm`), through the Objective-C
/// runtime rather than a symbol: `libapp.a` is linked into the notification extension too, which
/// does not carry that class (see `app_group.rs`).
#[cfg(target_os = "ios")]
fn native_step(step: NativeStep) -> bool {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;

    objc2::rc::autoreleasepool(|_| {
        let Some(class) = AnyClass::get(c"CanariPushRegistrationEnd") else {
            log::error!(
                "[PushEnd] CanariPushRegistrationEnd is not loaded - the deletion stays owed"
            );
            return false;
        };
        // SAFETY: both selectors are class methods declared `+ (BOOL)` in canari_push.mm, taking
        // no argument; they block on the FCM completion and must not run on the main thread,
        // which `run_native`'s blocking thread is not.
        let done: bool = unsafe {
            match step {
                NativeStep::EndForSignOut => msg_send![class, endForSignOut],
                NativeStep::CompleteOwed => msg_send![class, completeOwedDeletion],
            }
        };
        log::info!("[PushEnd] {step:?}: token deletion {}", completed(done));
        done
    })
}

/// The log word for a native step's answer.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn completed(done: bool) -> &'static str {
    if done {
        "completed"
    } else {
        "still OWED"
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clear_signed_out_mark, end_push_registration_files, DELETION_OWED_FILE, FCM_TOKEN_FILE,
        SIGNED_OUT_FILE, VOIP_TOKEN_FILE,
    };
    use crate::commands::push::{
        EXTENSION_PUSH_SECRET_FILE, PENDING_PUSH_SECRET_FILE, PUSH_CONTEXT_FILE,
    };

    fn dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("push-end-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn context(dir: &std::path::Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join(PUSH_CONTEXT_FILE)).unwrap()).unwrap()
    }

    /// The whole sign-out on disk: both marks, the session's keys gone from the context while the
    /// device's stay, the secret hand-off and the token mirror removed, and the extension's copies
    /// removed with them.
    #[test]
    fn a_sign_out_keeps_the_device_and_drops_the_session() {
        let app = dir("app");
        let group = dir("group");
        std::fs::write(
            app.join(PUSH_CONTEXT_FILE),
            r#"{"userId":"u-1","deviceId":"d-1","locale":"en","baseUrl":"https://x","pushToken":"bearer","later":"?"}"#,
        )
        .unwrap();
        std::fs::write(app.join(PENDING_PUSH_SECRET_FILE), "secret").unwrap();
        std::fs::write(app.join(FCM_TOKEN_FILE), "token").unwrap();
        std::fs::write(app.join(VOIP_TOKEN_FILE), "voip").unwrap();
        std::fs::write(group.join(EXTENSION_PUSH_SECRET_FILE), "secret").unwrap();
        std::fs::write(group.join(PUSH_CONTEXT_FILE), "{}").unwrap();

        end_push_registration_files(&app, Some(&group)).unwrap();

        assert!(app.join(SIGNED_OUT_FILE).exists());
        assert!(app.join(DELETION_OWED_FILE).exists());
        assert_eq!(
            context(&app),
            serde_json::json!({"userId":"u-1","deviceId":"d-1","locale":"en"})
        );
        assert!(!app.join(PENDING_PUSH_SECRET_FILE).exists());
        assert!(!app.join(FCM_TOKEN_FILE).exists());
        assert!(!app.join(VOIP_TOKEN_FILE).exists());
        assert!(!group.join(EXTENSION_PUSH_SECRET_FILE).exists());
        assert!(!group.join(PUSH_CONTEXT_FILE).exists());
    }

    /// A sign-out with nothing registered (never signed in, or signed out twice) still writes the
    /// marks and is not an error.
    #[test]
    fn a_sign_out_with_no_push_files_still_marks_the_device() {
        let app = dir("empty");
        end_push_registration_files(&app, None).unwrap();
        end_push_registration_files(&app, None).unwrap();
        assert!(app.join(SIGNED_OUT_FILE).exists());
        assert!(app.join(DELETION_OWED_FILE).exists());
        assert!(!app.join(PUSH_CONTEXT_FILE).exists());
    }

    /// A context that is not an object proves nothing about which keys it holds, so it goes.
    #[test]
    fn an_unparsable_context_is_removed_rather_than_kept() {
        let app = dir("garbage");
        std::fs::write(app.join(PUSH_CONTEXT_FILE), "not json").unwrap();
        end_push_registration_files(&app, None).unwrap();
        assert!(!app.join(PUSH_CONTEXT_FILE).exists());
    }

    /// A failed step does not stop the others: a mark that cannot be written (its path is a
    /// directory) is reported, and the other mark, the stripped context and the removed secret
    /// hand-off are all still done.
    #[test]
    fn a_failed_step_is_reported_after_every_other_step_ran() {
        let app = dir("partial");
        let group = dir("partial-group");
        std::fs::write(app.join(PENDING_PUSH_SECRET_FILE), "secret").unwrap();
        std::fs::write(
            app.join(PUSH_CONTEXT_FILE),
            r#"{"userId":"u-1","deviceId":"d-1","pushToken":"bearer"}"#,
        )
        .unwrap();
        std::fs::write(group.join(EXTENSION_PUSH_SECRET_FILE), "secret").unwrap();
        std::fs::create_dir_all(app.join(SIGNED_OUT_FILE).join("blocked")).unwrap();

        assert!(end_push_registration_files(&app, Some(&group)).is_err());
        assert!(app.join(DELETION_OWED_FILE).exists());
        assert_eq!(
            context(&app),
            serde_json::json!({"userId":"u-1","deviceId":"d-1"})
        );
        assert!(!app.join(PENDING_PUSH_SECRET_FILE).exists());
        assert!(!group.join(EXTENSION_PUSH_SECRET_FILE).exists());
    }

    /// The registration answer lifts the signed-out mark and leaves the owed deletion alone - the
    /// two answer different questions.
    #[test]
    fn a_registration_answer_clears_only_the_signed_out_mark() {
        let app = dir("register");
        end_push_registration_files(&app, None).unwrap();
        clear_signed_out_mark(&app).unwrap();
        clear_signed_out_mark(&app).unwrap();
        assert!(!app.join(SIGNED_OUT_FILE).exists());
        assert!(app.join(DELETION_OWED_FILE).exists());
    }

    /// Through the real writer: a new secret is what lifts the mark.
    #[test]
    fn storing_a_new_push_secret_lifts_the_signed_out_mark() {
        let app = dir("secret");
        end_push_registration_files(&app, None).unwrap();
        crate::commands::push::write_push_secret(&app, None, "fresh").unwrap();
        assert!(!app.join(SIGNED_OUT_FILE).exists());
    }

    /// The mark is lifted LAST: a secret whose extension copy could not be written (the copy's path
    /// is a directory here) leaves the device signed out, so the next registration retries it.
    #[test]
    fn a_secret_not_written_everywhere_keeps_the_signed_out_mark() {
        let app = dir("secret-partial");
        let group = dir("secret-partial-group");
        end_push_registration_files(&app, Some(&group)).unwrap();
        std::fs::create_dir_all(group.join(EXTENSION_PUSH_SECRET_FILE).join("blocked")).unwrap();
        assert!(crate::commands::push::write_push_secret(&app, Some(&group), "fresh").is_err());
        assert!(app.join(SIGNED_OUT_FILE).exists());
    }
}
