//! Canari Tauri backend: MLS cryptography, push notifications, and system integration.

#[cfg(target_os = "ios")]
mod app_group;
mod commands;
mod concurrency;
mod happy_eyeballs;
mod keystore_bridge;
mod native_cache;
mod page_ring;
mod state;

// `test` is in the gate so the shared background logic - the outbox batch drain in particular -
// is exercised by a host `cargo test` rather than only by a device build. Nothing in it is
// platform-specific; the gate exists to keep it out of the desktop binary.
#[cfg(any(target_os = "android", target_os = "ios", test))]
mod mobile;

use std::sync::{Arc, Mutex};

use tauri::Manager;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};

use crate::state::{AppState, PendingDb};

// Re-export commands for generate_handler!
use crate::commands::at_rest_key::{
    cle_au_repos_lire, cle_au_repos_marquer, cle_au_repos_oublier, cle_au_repos_preparer,
    cle_au_repos_schema, supprimer_cle_appareil,
};
#[cfg(feature = "bench-observables")]
use crate::commands::bench::bench_native_store;
use crate::commands::cookies::flush_webview_cookies;
use crate::commands::display_names::store_display_names;
use crate::commands::handoff::{advance_share_epoch, read_and_clear_pending_share};
use crate::commands::mls::{
    actualiser_cle_keystore_avec_devicekey, ajouter_membres_bulk, annuler_commit, cle_feuille,
    cles_signature_epinglees, confirmer_commit, confirmer_commit_welcome_du,
    contexte_correspond_base, creer_groupe, date_feuille, definir_politique_admission,
    envoyer_message_bytes, epoques_departs, exporter_group_info, exporter_ratchet_tree,
    exporter_secret, feuille_portant_cle, generer_key_packages_et_persister,
    graine_member_signature_key, graine_run, graine_session_keypair,
    graine_sign_with_device_credential, graine_sign_with_session_key, graine_verify_signature,
    graine_verify_signatures, groupe_actif, groupes_commit_en_attente, initialiser_mls,
    key_package_a_clef_privee, lister_groupes, lister_identites_membres,
    mls_external_join_is_a_further_device, obtenir_epoch, oublier_groupe, oublier_key_packages,
    prendre_constats_fork, prendre_evenements_appareils, rafraichir_feuille, recenser_key_packages,
    recevoir_message_bytes, recevoir_messages_batch, recuperer_cle_session_mls,
    rejoindre_par_commit_externe, remplacer_appareil, retirer_membres,
    retirer_membres_par_appareil, sauvegarder_mls_et_persister, skip_send_generations,
    soumission_en_attente, terminer_session_mls, trailer_welcome, verifier_key_package,
    welcome_remis, welcomes_dus,
};
use crate::commands::notifications::{notifier_message_natif, store_avatar_mirror};
use crate::commands::nse_outcomes::take_nse_outcomes;
use crate::commands::picked_files::discard_picked_file;
use crate::commands::picked_files::take_picked_file;
use crate::commands::push::{
    ack_fcm_cache, check_push_secret_health, claim_device_notices, delete_user_push_files,
    forget_graine_channel, forget_graine_sessions, get_fcm_token, get_push_diagnostic,
    get_voip_token, load_push_context, read_and_clear_outbox_sent,
    read_and_clear_pending_call_accept, read_and_clear_read_watermarks, read_outbox_mirror,
    set_push_context_locale, store_device_identity, store_graine_seed, store_outbox_mirror,
    store_push_context, store_push_secret, take_fcm_cache, take_key_group_push_joins,
};
use crate::commands::push_registration::{
    complete_owed_push_token_deletion, end_push_registration,
};
use crate::commands::storage::{
    clear_app_data, delete_user_database, get_installer_package, get_local_storage_usage,
    get_native_flags, load_mls_state, mls_foreground_heartbeat, mls_state_absent, mls_state_owner,
    mls_state_size, pause_mls_foreground, recharger_mls_au_resume, remove_native_flag,
    save_mls_state, set_native_flag,
};

// ─── JNI functions (Android background push) ──────────────────────────────
// Kept in lib.rs because they use `extern "system"` / `no_mangle` and reference
// `mobile::background` / `mobile::proto_fields` which are conditionally compiled.
// PIN-based JNI variants removed: all decrypt paths now use key-based variants.

#[cfg(target_os = "android")]
static ANDROID_JAVA_VM: std::sync::OnceLock<jni::JavaVM> = std::sync::OnceLock::new();

/// The APP's class loader, cached because a native thread cannot reach our classes without it.
///
/// `FindClass` resolves against the class loader of the nearest Java frame on the calling thread's
/// stack. A thread attached from Rust has none, so it falls back to the SYSTEM loader - which knows
/// the boot classpath and nothing of `fr.emse.canari`. That is why `flush_webview_cookies` could
/// only ever call a framework class, and it is the whole obstacle between Rust and our own Kotlin.
///
/// `JNI_OnLoad` is the one place where that is not true: it runs on the thread that called
/// `System.loadLibrary`, whose stack still carries `CanariApplication`. The loader taken there is
/// kept as a global reference and every later upcall goes through [`find_app_class`].
#[cfg(target_os = "android")]
static ANDROID_CLASS_LOADER: std::sync::OnceLock<jni::objects::GlobalRef> =
    std::sync::OnceLock::new();

/// Caches the `JavaVM` when the native library is loaded.
///
/// Every other JNI symbol in this file is called FROM Kotlin, so the JVM hands it a `JNIEnv`.
/// `flush_webview_cookies` is the opposite direction - Rust calling into the framework at a moment
/// Kotlin knows nothing about - and that needs a `JavaVM` to attach the calling thread to.
/// `JNI_OnLoad` is the only hook guaranteed to run before any of our Rust code can, because it is
/// what `System.loadLibrary("mines_app_lib")` invokes (CanariApplication and generated/Rust.kt).
///
/// # Safety
///
/// `vm` is the `JavaVM` pointer the JVM itself passes on `System.loadLibrary`, and it is
/// dereferenced here. Nothing but the JVM may call this symbol - which is why it is `unsafe`
/// rather than left to a lint suppression.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "system" fn JNI_OnLoad(
    vm: *mut jni::sys::JavaVM,
    _reserved: *mut std::ffi::c_void,
) -> jni::sys::jint {
    match unsafe { jni::JavaVM::from_raw(vm) } {
        Ok(vm) => {
            let _ = ANDROID_JAVA_VM.set(vm);
            if let Some(vm) = ANDROID_JAVA_VM.get() {
                cache_app_class_loader(vm);
            }
        }
        Err(e) => log::error!("[JNI] JNI_OnLoad: JavaVM::from_raw failed: {e}"),
    }
    jni::sys::JNI_VERSION_1_6
}

/// Takes the app's class loader from the thread that is loading this library, and keeps it.
///
/// Every failure is logged rather than absorbed: without it, every Rust-to-Kotlin call in the
/// process fails, and the first symptom would be a message notification that never appears.
#[cfg(target_os = "android")]
fn cache_app_class_loader(vm: &jni::JavaVM) {
    // `get_env` rather than `attach_current_thread`: this thread is already a Java thread - it is
    // the one executing `System.loadLibrary` - and it is precisely that fact we are here to use.
    let mut env = match vm.get_env() {
        Ok(env) => env,
        Err(e) => return log::error!("[JNI] JNI_OnLoad: get_env failed: {e}"),
    };
    let class = match env.find_class("fr/emse/canari/CanariApplication") {
        Ok(c) => c,
        Err(e) => {
            return log::error!("[JNI] JNI_OnLoad: find_class(CanariApplication) failed: {e}")
        }
    };
    let loader = match env
        .call_method(&class, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
    {
        Ok(l) => l,
        Err(e) => return log::error!("[JNI] JNI_OnLoad: getClassLoader failed: {e}"),
    };
    match env.new_global_ref(&loader) {
        Ok(global) => {
            let _ = ANDROID_CLASS_LOADER.set(global);
            log::debug!("[JNI] app class loader cached");
        }
        Err(e) => log::error!("[JNI] JNI_OnLoad: new_global_ref(ClassLoader) failed: {e}"),
    }
}

/// Loads one of OUR classes by its binary name (dots, e.g. `fr.emse.canari.MainActivity`).
///
/// Goes through the cached app loader rather than `FindClass`, which on a native thread would look
/// only at the boot classpath - see [`ANDROID_CLASS_LOADER`]. Returns `None` when the loader was
/// never cached or the class is absent, both of which the caller must report rather than retry.
#[cfg(target_os = "android")]
pub(crate) fn find_app_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    binary_name: &str,
) -> Option<jni::objects::JClass<'a>> {
    let Some(loader) = ANDROID_CLASS_LOADER.get() else {
        log::error!("[JNI] find_app_class({binary_name}): no class loader cached");
        return None;
    };
    let name = match env.new_string(binary_name) {
        Ok(n) => n,
        Err(e) => {
            log::error!("[JNI] find_app_class({binary_name}): new_string failed: {e}");
            return None;
        }
    };
    match env
        .call_method(
            loader.as_obj(),
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )
        .and_then(|v| v.l())
    {
        Ok(class) => Some(jni::objects::JClass::from(class)),
        Err(e) => {
            log::error!("[JNI] find_app_class({binary_name}): loadClass failed: {e}");
            None
        }
    }
}

/// The cached `JavaVM`, or `None` if `JNI_OnLoad` never ran (which would mean the library was not
/// loaded through `System.loadLibrary` - a case that must be visible, never silently absorbed).
#[cfg(target_os = "android")]
pub(crate) fn android_java_vm() -> Option<&'static jni::JavaVM> {
    ANDROID_JAVA_VM.get()
}

/// Writes Graine seeds carried by a push into `graine_seeds.json`, so the NEXT salon notification
/// can be read.
///
/// `seeds_json` is the `seeds` array `extract_full_message_info` produced for a
/// `graine_key_material` frame: `[{channelId, sessionId, seedB64, createdAt}]`. Returns how many
/// were written.
///
/// **This is the only write this path performs, and it is deliberately not MLS state.**
/// `graine_seeds.json` is a mirror of key material the durable store already owns; the push
/// service must never become a second writer of `mls.bin`, which is why the decrypt that produced
/// these seeds is read-only and the queued frame is still processed by the foreground afterwards.
/// Nothing is consumed by writing here.
///
/// The directory comes from Kotlin (`MlsContextLoader.tauriDataDir`) because there is no
/// `AppHandle` in a process with no WebView; the merge and its per-channel bound are the
/// foreground's, shared through `commands::push::merge_graine_seed`.
///
/// Returns -1 if the argument could not be marshalled or parsed at all, or no cache key was handed
/// over, which are different facts from "zero seeds were usable" and must not read as the same one.
///
/// `cacheKeyB64` is the install's native cache key Kotlin unwrapped from the Android Keystore
/// (`NativeCacheKey.retrieve`), or `""` when it could not: the mirror is sealed under it
/// (`native_cache`), and with none nothing is written.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeStoreGraineSeeds<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
    cache_key_b64: jni::objects::JString<'a>,
    seeds_json: jni::objects::JString<'a>,
) -> i32 {
    let Ok(dir) = env.get_string(&data_dir) else {
        log::error!("[GRAINE_PUSH] jni-data-dir");
        return -1;
    };
    let Ok(key) = env.get_string(&cache_key_b64) else {
        log::error!("[GRAINE_PUSH] jni-cache-key");
        return -1;
    };
    let Ok(json) = env.get_string(&seeds_json) else {
        log::error!("[GRAINE_PUSH] jni-seeds-json");
        return -1;
    };
    let dir: String = dir.into();
    let key: String = key.into();
    let json: String = json.into();

    commands::push::store_graine_seeds_json(
        std::path::Path::new(&dir),
        native_cache::platform_key(&key).as_ref(),
        &json,
    )
}

/// Whether the seed mirror under `dataDir` holds a session: 1 yes, 0 no, -1 it cannot be read.
/// What the push service asks before choosing between the mirror and the seed frame a message
/// carries - the seed itself never enters the JVM. `cacheKeyB64` as for `nativeStoreGraineSeeds`.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeGraineSeedHeld<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
    cache_key_b64: jni::objects::JString<'a>,
    channel_id: jni::objects::JString<'a>,
    session_id: jni::objects::JString<'a>,
) -> i32 {
    let mut read = |s: &jni::objects::JString<'a>| -> Option<String> {
        env.get_string(s).ok().map(Into::into)
    };
    let (Some(dir), Some(key), Some(channel), Some(session)) = (
        read(&data_dir),
        read(&cache_key_b64),
        read(&channel_id),
        read(&session_id),
    ) else {
        log::error!("[GRAINE_MIRROR] jni-string");
        return -1;
    };
    commands::push::graine_seed_held(
        std::path::Path::new(&dir),
        native_cache::platform_key(&key).as_ref(),
        &channel,
        &session,
    )
}

/// Seals one push-cache line under the install's native cache key (`native_cache`). Returns `null`
/// when there is no usable key, and the caller then writes NOTHING - never a line in the clear.
/// A companion-object function, because the notification action receiver writes the cache too.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeSealCacheLine<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _companion: jni::objects::JObject<'a>,
    cache_key_b64: jni::objects::JString<'a>,
    line: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let null = || jni::objects::JString::from(jni::objects::JObject::null());
    let (Ok(key), Ok(line)) = (env.get_string(&cache_key_b64), env.get_string(&line)) else {
        log::error!("[FCM_CACHE] jni-string");
        return null();
    };
    let key: String = key.into();
    let line: String = line.into();
    let Some(key) = native_cache::platform_key(&key) else {
        return null();
    };
    let sealed = native_cache::seal_line(&key, native_cache::Purpose::PushCache, &line);
    env.new_string(sealed).unwrap_or_else(|e| {
        log::error!("[FCM_CACHE] sealed line not returned: {e}");
        null()
    })
}

/// Whether the page rings an incoming call itself (it holds the gateway socket) - `page_ring`. The
/// ring of a `call_ring` push stands back only when this is true AND the app is in front.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativePageRingsInApp<
    'a,
>(
    _env: jni::JNIEnv<'a>,
    _companion: jni::objects::JObject<'a>,
) -> jni::sys::jboolean {
    if page_ring::page_rings_in_app() {
        jni::sys::JNI_TRUE
    } else {
        jni::sys::JNI_FALSE
    }
}

/// Claims the `ownDeviceAdded` keys a push decrypt or a background Add answered in the shared
/// device-notice ledger under `dataDir` (`MlsContextLoader.tauriDataDir`, the directory the app's
/// own claim uses) and returns, as a JSON array, the keys nobody announced before - the ones the
/// service raises its "a new device was added to your account" notification for. `[]` when the
/// arguments cannot be read. See `mobile::device_notice`.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeClaimDeviceNotices<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
    keys_json: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let claimed = (|| -> Option<String> {
        let dir: String = env.get_string(&data_dir).ok()?.into();
        let json: String = env.get_string(&keys_json).ok()?.into();
        Some(mobile::device_notice::claim_device_notices_json(
            std::path::Path::new(&dir),
            &json,
        ))
    })()
    .unwrap_or_else(|| {
        log::error!("[DEVICE_NOTICE] jni arguments unreadable - nothing claimed");
        "[]".to_string()
    });
    env.new_string(&claimed)
        .unwrap_or_else(|_| env.new_string("[]").unwrap())
}

/// Opens a salon push against the seed mirror under `dataDir` - every v1 and v2 rule, in the one
/// implementation both platforms share (`mobile::background::open_graine_push`). `signatureB64` is
/// empty when the push carried none. Returns the same JSON as `nativeDecryptMessageWithKey`.
/// `locale` is the app language mirrored in `push_context.json` (`""` when none was).
/// `cacheKeyB64` opens the sealed mirror, as for `nativeStoreGraineSeeds`.
#[cfg(target_os = "android")]
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeOpenGrainePush<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
    cache_key_b64: jni::objects::JString<'a>,
    channel_id: jni::objects::JString<'a>,
    session_id: jni::objects::JString<'a>,
    message_index: jni::sys::jint,
    sender_id: jni::objects::JString<'a>,
    nonce_b64: jni::objects::JString<'a>,
    ciphertext_b64: jni::objects::JString<'a>,
    signature_b64: jni::objects::JString<'a>,
    locale: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        // A negative index cannot exist: it is a uint32 on the wire and in the derivation. Refusing
        // it here keeps the cast from wrapping into an index that derives a plausible wrong key.
        if message_index < 0 {
            log::error!("[GraineBG] negative message index {message_index}");
            return serde_json::json!({ "ok": false, "reason": "jni-message-index" });
        }
        let mut read = |s: &jni::objects::JString<'a>| -> Option<String> {
            env.get_string(s).ok().map(Into::into)
        };
        let (
            Some(dir),
            Some(cache_key),
            Some(channel),
            Some(session),
            Some(sender),
            Some(nonce),
            Some(ciphertext),
            Some(signature),
            Some(locale),
        ) = (
            read(&data_dir),
            read(&cache_key_b64),
            read(&channel_id),
            read(&session_id),
            read(&sender_id),
            read(&nonce_b64),
            read(&ciphertext_b64),
            read(&signature_b64),
            read(&locale),
        )
        else {
            return serde_json::json!({ "ok": false, "reason": "jni-string" });
        };
        mobile::background::open_graine_push(
            std::path::Path::new(&dir),
            native_cache::platform_key(&cache_key).as_ref(),
            &mobile::background::GrainePush {
                channel_id: &channel,
                session_id: &session,
                index: message_index as u32,
                sender_id: &sender,
                nonce_b64: &nonce,
                ciphertext_b64: &ciphertext,
                signature_b64: &signature,
            },
            mobile::push_text::PushLanguage::from_tag(&locale),
        )
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

// ─── Key-based JNI variants (biometric mode, no PIN) ────────────────────

/// `locale` is the app language mirrored in `push_context.json` (`""` when none was), and words
/// every sentence the scanner composes itself (`PushLanguage::from_tag`).
#[cfg(target_os = "android")]
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessageWithKey<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    sender_id: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
    locale: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        let state_vec = match env.convert_byte_array(&state_bytes) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-state-bytes" }),
        };
        let locale_str: String = match env.get_string(&locale) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-locale" }),
        };
        let key_b64_str: String = match env.get_string(&key_b64) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-key" }),
        };
        let user_id_str: String = match env.get_string(&user_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-user-id" }),
        };
        let device_id_str: String = match env.get_string(&device_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-device-id" }),
        };
        let group_id_str: String = match env.get_string(&group_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-group-id" }),
        };
        let sender_id_str: String = match env.get_string(&sender_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-sender-id" }),
        };
        let cipher_vec = match env.convert_byte_array(&ciphertext) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-ciphertext" }),
        };

        // EVERY REFUSAL NAMES ITSELF NOW - the six marshalling faults above by their argument,
        // and the crypto path through `refused` in `mobile/background.rs`. Eleven distinct causes
        // reached the phone's log as one sentence, `decryptProto: ok=false -> decryption failed`,
        // including a CONTROL FRAME - which is work that SUCCEEDED. Measured as the whole of
        // NOTIF-4's and NOTIF-10's remaining dirt on 2026-09-07.
        mobile::background::decrypt_push_message_with_key(
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &mobile::background::PushFrame {
                group_id: &group_id_str,
                sender_id: &sender_id_str,
                ciphertext: &cipher_vec,
            },
            mobile::push_text::PushLanguage::from_tag(&locale_str),
        )
    })();

    let json_str = result.to_string();
    env.new_string(&json_str).unwrap_or_else(|_| {
        env.new_string("{\"ok\":false,\"reason\":\"jni-string-alloc\"}")
            .unwrap()
    })
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeGroupEpochWithKey<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
) -> jni::sys::jlong {
    let epoch = (|| -> Option<u64> {
        let state_vec = env.convert_byte_array(&state_bytes).ok()?;
        let key_b64_str: String = env.get_string(&key_b64).ok()?.into();
        let user_id_str: String = env.get_string(&user_id).ok()?.into();
        let device_id_str: String = env.get_string(&device_id).ok()?.into();
        let group_id_str: String = env.get_string(&group_id).ok()?.into();
        mobile::background::background_group_epoch_with_key(
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
        )
    })();
    epoch.map(|e| e as jni::sys::jlong).unwrap_or(-1)
}

/// `locale` as for `nativeDecryptMessageWithKey`.
#[cfg(target_os = "android")]
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessageWithCommitsWithKey<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    sender_id: jni::objects::JString<'a>,
    commits_json: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
    locale: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        let locale_str: String = match env.get_string(&locale) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-locale" }),
        };
        let state_vec = match env.convert_byte_array(&state_bytes) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let key_b64_str: String = match env.get_string(&key_b64) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let user_id_str: String = match env.get_string(&user_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let device_id_str: String = match env.get_string(&device_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let group_id_str: String = match env.get_string(&group_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let sender_id_str: String = match env.get_string(&sender_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false, "reason": "jni-sender-id" }),
        };
        let commits_json_str: String = match env.get_string(&commits_json) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let cipher_vec = match env.convert_byte_array(&ciphertext) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };

        let commits = mobile::background::decode_commits_b64_json(&commits_json_str);
        mobile::background::decrypt_push_message_with_commits_with_key(
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &commits,
            &mobile::background::PushFrame {
                group_id: &group_id_str,
                sender_id: &sender_id_str,
                ciphertext: &cipher_vec,
            },
            mobile::push_text::PushLanguage::from_tag(&locale_str),
        )
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMedia<'a>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    key_b64: jni::objects::JString<'a>,
    iv_b64: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JByteArray<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let plaintext: Option<Vec<u8>> = (|| {
        let key: String = env.get_string(&key_b64).ok()?.into();
        let iv: String = env.get_string(&iv_b64).ok()?.into();
        let key = STANDARD.decode(key.trim()).ok()?;
        let iv = STANDARD.decode(iv.trim()).ok()?;
        let cipher_vec = env.convert_byte_array(&ciphertext).ok()?;
        mobile::background::decrypt_media_blob(&key, &iv, &cipher_vec)
    })();

    let bytes = plaintext.unwrap_or_default();
    match env.byte_array_from_slice(&bytes) {
        Ok(arr) => arr,
        Err(_) => unsafe { jni::objects::JByteArray::from_raw(std::ptr::null_mut()) },
    }
}

// ─── JNI: Background Worker & Welcome/Send ────────────────────────────────

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_MlsBackgroundWorker_nativeProcessBackgroundTasks(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    files_dir: jni::objects::JString,
    _state_bytes: jni::objects::JByteArray,
    _device_key_b64: jni::objects::JString,
    _user_id: jni::objects::JString,
    _device_id: jni::objects::JString,
) -> jni::sys::jboolean {
    let files_dir_str: String = match env.get_string(&files_dir) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    match mobile::background::cleanup_pending_db(std::path::Path::new(&files_dir_str)) {
        Ok(()) => {
            log::info!("Background Worker completed successfully");
            1
        }
        Err(e) => {
            log::error!("Background Worker failed: {e}");
            0
        }
    }
}

/// Prepares a background Welcome: builds it and STAGES the Add in `mls.bin`, with its submission
/// record (see `mobile::background::prepare_welcome_background_with_key` for the answer's shape).
#[cfg(target_os = "android")]
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativePrepareWelcomeBackground<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    requester: jni::objects::JString<'a>,
    key_package_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key_b64_str: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let group_id_str: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let requester_str: String = env
            .get_string(&requester)
            .map_err(|e| e.to_string())?
            .into();
        let kp_b64: String = env
            .get_string(&key_package_b64)
            .map_err(|e| e.to_string())?
            .into();

        Ok(mobile::background::prepare_welcome_background_with_key(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &mobile::background::WelcomeRequest {
                group_id: &group_id_str,
                requester: &requester_str,
                key_package_b64: &kp_b64,
            },
        ))
    })();

    let json = match result {
        Ok(v) => v,
        Err(e) => {
            log::error!(
                "[BG_WELCOME] nativePrepareWelcomeBackground: JNI argument unreadable: {e}"
            );
            serde_json::json!({ "ok": false, "reason": "jni-argument" })
        }
    };
    env.new_string(json.to_string())
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Settles the Add a prepared Welcome staged in `mls.bin`, on the server's DEFINITIVE answer:
/// `accepted` merges it; otherwise it is cleared, and `stale_base` / `server_epoch` (both `>= 0` for
/// an `epoch_mismatch`, recorded for the group, `-1` otherwise) or `refused_target` (`userId:deviceId`,
/// recorded for that target alone) say what the refusal leaves in the stale ledger. An answer nobody
/// read is not settled here at all (see `mobile::background::settle_background_welcome`).
#[cfg(target_os = "android")]
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeSettleBackgroundWelcome<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    commit_b64: jni::objects::JString<'a>,
    base_epoch: jni::sys::jlong,
    accepted: jni::sys::jboolean,
    stale_base: jni::sys::jlong,
    server_epoch: jni::sys::jlong,
    refused_target: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let text =
            |env: &mut jni::JNIEnv<'a>, s: &jni::objects::JString<'a>| -> Result<String, String> {
                Ok(env.get_string(s).map_err(|e| e.to_string())?.into())
            };
        let dir = text(&mut env, &files_dir)?;
        let state = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key = text(&mut env, &key_b64)?;
        let user = text(&mut env, &user_id)?;
        let device = text(&mut env, &device_id)?;
        let gid = text(&mut env, &group_id)?;
        let commit = text(&mut env, &commit_b64)?;
        let target = if refused_target.is_null() {
            None
        } else {
            Some(text(&mut env, &refused_target)?)
        };
        let base = mobile::background::staged_base_from_jni(base_epoch)?;
        let answer = mobile::background::welcome_answer_from_jni(
            accepted != 0,
            stale_base,
            server_epoch,
            target.as_deref(),
        );
        Ok(mobile::background::settle_background_welcome(
            std::path::Path::new(&dir),
            &state,
            &key,
            &user,
            &device,
            &mobile::background::StagedWelcome {
                group_id: &gid,
                commit_b64: &commit,
                base_epoch: base,
            },
            answer,
        ))
    })();
    let json = match result {
        Ok(v) => v,
        Err(e) => {
            // Nothing was settled: the stage stays in mls.bin, and the foreground settles it.
            log::error!(
                "[BG_WELCOME] nativeSettleBackgroundWelcome: JNI argument unreadable ({e}) - left to the foreground"
            );
            serde_json::json!({ "ok": false, "reason": "jni-argument" })
        }
    };
    env.new_string(json.to_string())
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Why a Welcome for `target` in `group_id`, built from these `mls.bin` bytes, would be refused
/// again - `stale-epoch-known` or `target-refused-known` - or an empty string when it is not known.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeWelcomeRequestKnownRefused<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    group_id: jni::objects::JString<'a>,
    target: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let token = match (
        env.get_string(&files_dir),
        env.get_string(&group_id),
        env.get_string(&target),
        env.convert_byte_array(&state_bytes),
    ) {
        (Ok(dir), Ok(gid), Ok(target), Ok(state)) => {
            let dir: String = dir.into();
            let gid: String = gid.into();
            let target: String = target.into();
            mobile::background::welcome_request_known_refused(
                std::path::Path::new(&dir),
                &state,
                &gid,
                &target,
            )
            .unwrap_or("")
        }
        _ => {
            log::error!("[BG_WELCOME] nativeWelcomeRequestKnownRefused: JNI argument unreadable");
            ""
        }
    };
    env.new_string(token)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeProcessWelcomeBackground(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    files_dir: jni::objects::JString,
    state_bytes: jni::objects::JByteArray,
    key_b64: jni::objects::JString,
    user_id: jni::objects::JString,
    device_id: jni::objects::JString,
    welcome_b64: jni::objects::JString,
    ratchet_tree_b64: jni::objects::JString,
) -> jni::sys::jboolean {
    let result = (|| -> Result<(), String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key_b64_str: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let welcome_b64_str: String = env
            .get_string(&welcome_b64)
            .map_err(|e| e.to_string())?
            .into();
        let rt_b64_str: String = env
            .get_string(&ratchet_tree_b64)
            .map_err(|e| e.to_string())?
            .into();

        mobile::background::process_welcome_background_with_key(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &welcome_b64_str,
            &rt_b64_str,
        )
    })();

    match result {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[BG_JOIN] nativeProcessWelcomeBackground failed: {e}");
            0
        }
    }
}

// ─── A key group joined from a salon push (channel-encryption section 26) ────────────────────
// The orchestration (two PushSecret round trips) is Kotlin's; the ledger, the crypto and the
// compare-and-swap install are `mobile::key_group_join`'s. Every string crosses as a JNI string,
// and the state bytes as the one byte array the caller already read.

/// The install's native cache key a ledger call was handed, or the error that refuses the call: the
/// ledger is sealed under it and is never read or written without it.
#[cfg(target_os = "android")]
fn key_group_join_ledger_key(
    env: &mut jni::JNIEnv,
    cache_key_b64: &jni::objects::JString,
) -> Result<native_cache::CacheKey, String> {
    let b64: String = env
        .get_string(cache_key_b64)
        .map_err(|e| e.to_string())?
        .into();
    native_cache::platform_key(&b64)
        .ok_or_else(|| "no native cache key - the ledger is never written in the clear".to_string())
}

/// Claims one push-join attempt at a key group: `granted`, `granted-unless-base:<epoch>`,
/// `attempted:<state>`, `full`, or `error`. `cacheKeyB64` seals the ledger, as for
/// `nativeStoreGraineSeeds`; without it the answer is `error` and nothing is attempted.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeKeyGroupJoinClaim<'a>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    cache_key_b64: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use mobile::key_group_join::{claim, Claim};
    let answer = (|| -> Result<String, String> {
        let dir: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let key = key_group_join_ledger_key(&mut env, &cache_key_b64)?;
        let gid: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        Ok(match claim(std::path::Path::new(&dir), &key, &gid)? {
            Claim::Granted => "granted".to_string(),
            Claim::GrantedUnlessBaseAt(epoch) => format!("granted-unless-base:{epoch}"),
            Claim::AlreadyAttempted(state) => format!("attempted:{state}"),
            Claim::LedgerFull => "full".to_string(),
        })
    })()
    .unwrap_or_else(|e| {
        log::error!("[KG_PUSH_JOIN] claim failed: {e}");
        "error".to_string()
    });
    env.new_string(&answer)
        .unwrap_or_else(|_| env.new_string("error").unwrap())
}

/// Settles a push-join attempt. `state` is `joined` (`a` = scope kind, `b` = scope id), `refused`,
/// `lost` or `retryable` (`a` = the reason token), or `deferred` (`a` = the reason, `b` = the base
/// epoch). `cacheKeyB64` seals the ledger, as for the claim. Returns whether the ledger was written.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeKeyGroupJoinSettle(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    files_dir: jni::objects::JString,
    cache_key_b64: jni::objects::JString,
    group_id: jni::objects::JString,
    state: jni::objects::JString,
    a: jni::objects::JString,
    b: jni::objects::JString,
) -> jni::sys::jboolean {
    use mobile::key_group_join::{settle, Settlement};
    let result = (|| -> Result<(), String> {
        let dir: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let key = key_group_join_ledger_key(&mut env, &cache_key_b64)?;
        let gid: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let state: String = env.get_string(&state).map_err(|e| e.to_string())?.into();
        let a: String = env.get_string(&a).map_err(|e| e.to_string())?.into();
        let b: String = env.get_string(&b).map_err(|e| e.to_string())?.into();
        let settlement = match state.as_str() {
            "joined" => Settlement::Joined {
                scope_kind: a,
                scope_id: b,
            },
            "refused" => Settlement::Refused(a),
            "lost" => Settlement::Lost(a),
            "retryable" => Settlement::Retryable(a),
            "deferred" => Settlement::Deferred {
                reason: a,
                base_epoch: b
                    .parse::<u64>()
                    .map_err(|e| format!("deferred base epoch '{b}': {e}"))?,
            },
            other => return Err(format!("unknown settlement '{other}'")),
        };
        settle(std::path::Path::new(&dir), &key, &gid, &settlement)
    })();
    match result {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[KG_PUSH_JOIN] settle failed: {e}");
            0
        }
    }
}

/// Builds the external commit and stages the post-join state - see
/// `mobile::key_group_join::prepare_key_group_join`. Returns its JSON answer.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativePrepareKeyGroupJoin<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    group_info_b64: jni::objects::JString<'a>,
    base_epoch: jni::sys::jlong,
    seed_frame_b64: jni::objects::JString<'a>,
    frame_sender_id: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let dir: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let gid: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let gi: String = env
            .get_string(&group_info_b64)
            .map_err(|e| e.to_string())?
            .into();
        let frame: String = env
            .get_string(&seed_frame_b64)
            .map_err(|e| e.to_string())?
            .into();
        let sender: String = env
            .get_string(&frame_sender_id)
            .map_err(|e| e.to_string())?
            .into();
        let base_epoch = u64::try_from(base_epoch).map_err(|_| "negative baseEpoch".to_string())?;
        Ok(mobile::key_group_join::prepare_key_group_join(
            std::path::Path::new(&dir),
            &state,
            &key,
            &user,
            &device,
            &mobile::key_group_join::JoinInputs {
                group_id: &gid,
                group_info_b64: &gi,
                base_epoch,
                seed_frame_b64: &frame,
                frame_sender_id: &sender,
            },
        ))
    })();
    let json = result
        .unwrap_or_else(|e| {
            log::error!("[KG_PUSH_JOIN] prepare marshalling failed: {e}");
            serde_json::json!({ "ok": false, "reason": "jni-marshalling", "terminal": false })
        })
        .to_string();
    env.new_string(&json)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Installs the staged post-join state once the server accepted the commit. False = LOST.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeFinishKeyGroupJoin(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    files_dir: jni::objects::JString,
) -> jni::sys::jboolean {
    let result = env
        .get_string(&files_dir)
        .map_err(|e| e.to_string())
        .and_then(|dir| {
            let dir: String = dir.into();
            mobile::key_group_join::finish_key_group_join(std::path::Path::new(&dir))
        });
    match result {
        Ok(_) => 1,
        Err(e) => {
            log::error!("[KG_PUSH_JOIN] finish FAILED - the server holds a leaf this device has no state for: {e}");
            0
        }
    }
}

/// Deletes the staged post-join state of a commit the server did not accept.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeAbandonKeyGroupJoin(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    files_dir: jni::objects::JString,
) {
    match env.get_string(&files_dir) {
        Ok(dir) => {
            let dir: String = dir.into();
            mobile::key_group_join::abandon_key_group_join(std::path::Path::new(&dir));
        }
        Err(e) => log::error!("[KG_PUSH_JOIN] abandon marshalling failed: {e}"),
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildTextMessageProto<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    message_id: jni::objects::JString<'a>,
    sent_at: jni::sys::jlong,
    content: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> Result<String, String> {
        let message_id_str: String = env
            .get_string(&message_id)
            .map_err(|e| e.to_string())?
            .into();
        let content_str: String = env.get_string(&content).map_err(|e| e.to_string())?.into();
        let bytes =
            mobile::proto_fields::build_text_app_message(&message_id_str, sent_at, &content_str);
        Ok(STANDARD.encode(&bytes))
    })();

    let out = result.unwrap_or_else(|e| {
        log::error!("[QUICK_REPLY] nativeBuildTextMessageProto failed: {e}");
        String::new()
    });
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

/// Builds the `read_watermark` control proto for the "mark as read" and quick-reply notification
/// actions. `at` is the sender's `sent_at` for the message the notification is about, carried down
/// from the push - never this device's clock, for the reason
/// [`mobile::proto_fields::build_read_watermark_app_message`] states.
///
/// Infallible by construction (no string to decode, no JSON to parse), so unlike its neighbours it
/// has no error branch to log: an empty return would mean the JVM could not allocate a string.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildReadWatermarkProto<
    'a,
>(
    env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    at: jni::sys::jlong,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let bytes = mobile::proto_fields::build_read_watermark_app_message(at);
    let out = STANDARD.encode(&bytes);
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

/// Builds the call hangup a callee sends when it refuses a ring, for the Decline of the NATIVE
/// ring (notification action and call screen), which runs with no webview: the same frame the
/// in-app Decline sends, so the caller's ring ends at once
/// ([`mobile::proto_fields::build_call_hangup_app_message`]). Empty on a marshalling failure,
/// logged; the Kotlin caller then sends nothing and says so.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildCallHangupProto<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    message_id: jni::objects::JString<'a>,
    sent_at: jni::sys::jlong,
    call_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    end_reason: jni::sys::jint,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> Result<String, String> {
        let message_id_str: String = env
            .get_string(&message_id)
            .map_err(|e| e.to_string())?
            .into();
        let call_id_str: String = env.get_string(&call_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let bytes = mobile::proto_fields::build_call_hangup_app_message(
            &message_id_str,
            sent_at,
            &call_id_str,
            &device_id_str,
            end_reason.max(0) as u32,
        );
        Ok(STANDARD.encode(&bytes))
    })();

    let out = result.unwrap_or_else(|e| {
        log::error!("[CALL_DECLINE] nativeBuildCallHangupProto failed: {e}");
        String::new()
    });
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeSendMessagesBackground<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    entries_json: jni::objects::JString<'a>,
    max_attempts: jni::sys::jint,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key_b64_str: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let entries_str: String = env
            .get_string(&entries_json)
            .map_err(|e| e.to_string())?
            .into();
        let entries = mobile::background::parse_outbox_entries_json(&entries_str)?;

        mobile::background::send_messages_background_with_key(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &entries,
            usize::try_from(max_attempts).map_err(|_| format!("max attempts {max_attempts}"))?,
        )
    })();

    let json_str = match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            log::error!("[BG_SEND] nativeSendMessagesBackground failed: {e}");
            format!("{{\"ok\":false,\"error\":{:?}}}", e)
        }
    };

    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

// ─── run() ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log::error!("PANIC: {info}");
            prev(info);
        }));
    }

    #[cfg(all(desktop, not(dev)))]
    let port: u16 = 1421;

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                // OPENMLS NARRATES ITS OWN FAILURES, AND NATIVE HAD NO ANSWER TO THAT UNTIL NOW.
                // The library logs from inside its framing and validation code, where it knows
                // nothing a reader could act on: `Sender data decryption error` names no group and
                // no epoch, `Wrong Epoch: message.epoch() 1 > 10` names no group. Every path into
                // it is wrapped by `mls_core`, which reports the same event with the group, both
                // epochs and the marker every consumer keys on - or returns a typed `MlsError` the
                // caller surfaces. So its narration is a duplicate of a better line, at every
                // level, and at ERROR it is a duplicate that accuses.
                //
                // THE WEB HAS DECLINED TO REPEAT IT FOR A WHILE AND THIS END HAD NOT. That
                // asymmetry is the exact shape of the `CannotDecryptOwnMessage` defect recorded in
                // `mls-wasm/src/lib.rs`: a shim on one client, nothing on the other, and the
                // untreated end quietly doing something worse. `level_for` keys on the emitting
                // module, so unlike a text match it cannot drift with an upstream rewording.
                .level_for("openmls", log::LevelFilter::Off)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        // The chat socket's TCP connect races IPv6 and IPv4 (RFC 8305) instead of trying them in
        // turn (CALL-WS-V6): see `happy_eyeballs.rs` and the patch in `patches/tauri-plugin-websocket`,
        // whose `Builder::new` REQUIRES the connector (upstream's `init()` is removed).
        .plugin(tauri_plugin_websocket::Builder::new(happy_eyeballs::tcp_connector()).build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Publishes the COMPILE-TIME target OS to the WebView (window.__TAURI_OS_PLUGIN_INTERNALS__).
        // The frontend used to read the platform out of navigator.userAgent, which an iPad WKWebView
        // does not answer honestly: desktop-class browsing reports "Macintosh", so an iPad fell
        // through every iOS branch - including the OIDC redirect URI, which App Review rejected.
        .plugin(tauri_plugin_os::init());

    #[cfg(all(desktop, not(dev)))]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keystore::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_customtabs::init())
        .plugin(tauri_plugin_gallery::init())
        // Android's Restore Credentials (WP-RESTORE-1); its commands answer Unsupported on iOS.
        .plugin(tauri_plugin_restore::init());

    // The native tab bar, iOS only: see the dependency's comment in Cargo.toml.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_system_components::init());

    // A WKWebView whose web content process died has lost its page, and with it every socket that
    // page held: the ring facts are cleared BEFORE the reload (Tauri's own default, kept), so no ring
    // arriving in between is left to a dead page (`page_ring`).
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let builder = builder.on_web_content_process_terminate(|webview| {
        log::warn!("[CALL_RING] the web content process terminated - reloading the page");
        page_ring::forget_on_web_content_terminated();
        if let Err(e) = webview.reload() {
            log::error!("[CALL_RING] the page could not be reloaded after its process died: {e}");
        }
    });

    builder
        .manage(AppState {
            mls_manager: Arc::new(Mutex::new(None)),
            device_key: Arc::new(Mutex::new(None)),
        })
        .setup(move |app| {
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
                            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                            .busy_timeout(std::time::Duration::from_secs(5)),
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
                        created_at INTEGER NOT NULL,\
                        is_ready   INTEGER NOT NULL DEFAULT 0\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB schema: {e}"))?;

            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await;
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration: {e}"))?;

            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await;
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration attempt_count: {e}"))?;

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

            #[cfg(desktop)]
            {
                #[cfg(dev)]
                let url = tauri::WebviewUrl::App(std::path::PathBuf::from("/"));

                #[cfg(not(dev))]
                let url = {
                    let localhost_url: tauri::Url =
                        format!("http://localhost:{}", port).parse().unwrap();
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

                let mut window_config = app.config().app.windows[0].clone();
                window_config.url = url;

                tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?.build()?;
            }

            #[cfg(mobile)]
            tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App(std::path::PathBuf::from("/")),
            )
            // THE APP OWNS WHICH URLS ITS OWN WEBVIEW MAY LOAD. Without this, a URL `http::Uri`
            // cannot parse becomes wry's `currentUrl` and the next IPC aborts the process from
            // inside a JNI frame - no JS error, no boundary, the app simply vanishes. Refusing
            // here is the only half of that defect this repository owns; the reasoning, the
            // measurement and what it does NOT close are in `mobile::navigation`.
            .on_navigation(|url| crate::mobile::navigation::webview_may_load(url.as_str()))
            .build()?;

            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }

            #[cfg(mobile)]
            let _ = app;

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
        // A new document holds no gateway socket: whatever the previous page said about ringing a
        // call itself is void from here (`page_ring`).
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                page_ring::forget_on_page_load();
            }
        })
        .on_window_event(|window, event| {
            #[cfg(mobile)]
            let _ = (window, event);
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            initialiser_mls,
            graine_session_keypair,
            graine_sign_with_session_key,
            graine_verify_signature,
            graine_verify_signatures,
            graine_sign_with_device_credential,
            mls_external_join_is_a_further_device,
            graine_member_signature_key,
            graine_run,
            recuperer_cle_session_mls,
            cle_au_repos_schema,
            cle_au_repos_preparer,
            cle_au_repos_marquer,
            cle_au_repos_lire,
            cle_au_repos_oublier,
            supprimer_cle_appareil,
            sauvegarder_mls_et_persister,
            creer_groupe,
            lister_groupes,
            recenser_key_packages,
            oublier_groupe,
            obtenir_epoch,
            groupe_actif,
            generer_key_packages_et_persister,
            key_package_a_clef_privee,
            oublier_key_packages,
            ajouter_membres_bulk,
            verifier_key_package,
            feuille_portant_cle,
            cles_signature_epinglees,
            remplacer_appareil,
            epoques_departs,
            prendre_evenements_appareils,
            lister_identites_membres,
            definir_politique_admission,
            retirer_membres,
            retirer_membres_par_appareil,
            rafraichir_feuille,
            date_feuille,
            cle_feuille,
            contexte_correspond_base,
            soumission_en_attente,
            groupes_commit_en_attente,
            confirmer_commit_welcome_du,
            welcomes_dus,
            welcome_remis,
            confirmer_commit,
            annuler_commit,
            exporter_ratchet_tree,
            exporter_group_info,
            rejoindre_par_commit_externe,
            trailer_welcome,
            envoyer_message_bytes,
            prendre_constats_fork,
            skip_send_generations,
            recevoir_message_bytes,
            recevoir_messages_batch,
            exporter_secret,
            get_fcm_token,
            get_push_diagnostic,
            check_push_secret_health,
            store_push_context,
            store_device_identity,
            set_push_context_locale,
            load_push_context,
            save_mls_state,
            recharger_mls_au_resume,
            mls_foreground_heartbeat,
            page_ring::page_ring_document,
            page_ring::set_page_gateway_socket,
            page_ring::set_page_ringing_call,
            pause_mls_foreground,
            terminer_session_mls,
            load_mls_state,
            mls_state_size,
            mls_state_absent,
            mls_state_owner,
            store_push_secret,
            claim_device_notices,
            end_push_registration,
            complete_owed_push_token_deletion,
            clear_app_data,
            delete_user_database,
            delete_user_push_files,
            remove_native_flag,
            set_native_flag,
            get_native_flags,
            get_installer_package,
            get_local_storage_usage,
            take_fcm_cache,
            ack_fcm_cache,
            read_and_clear_read_watermarks,
            take_key_group_push_joins,
            take_nse_outcomes,
            store_outbox_mirror,
            read_outbox_mirror,
            read_and_clear_outbox_sent,
            read_and_clear_pending_call_accept,
            read_and_clear_pending_share,
            advance_share_epoch,
            get_voip_token,
            store_graine_seed,
            forget_graine_channel,
            forget_graine_sessions,
            actualiser_cle_keystore_avec_devicekey,
            flush_webview_cookies,
            take_picked_file,
            discard_picked_file,
            notifier_message_natif,
            store_avatar_mirror,
            store_display_names,
            // A BENCH build only - see `commands::bench`. Absent, not refusing, everywhere else.
            #[cfg(feature = "bench-observables")]
            bench_native_store
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            #[cfg(target_os = "android")]
            log::error!("Tauri failed to start: {e:?}");
            panic!("error while running tauri application: {e:?}");
        });
}
