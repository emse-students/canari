//! Pont FFI C expose a `libapp.a` pour le code natif iOS (ObjC++/Swift).

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::slice;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::background::{
    background_group_epoch, cleanup_pending_db, create_welcome_background, decode_commits_b64_json,
    decrypt_channel_message, decrypt_push_message, decrypt_push_message_with_commits,
    process_welcome_background, send_message_background,
};
use super::proto_fields::{build_read_receipt_app_message, build_text_app_message};

fn json_to_c_string(value: serde_json::Value) -> *mut c_char {
    CString::new(value.to_string())
        .unwrap_or_else(|_| CString::new("{\"ok\":false}").expect("static json"))
        .into_raw()
}

fn err_json_to_c_string(err: String) -> *mut c_char {
    let value = serde_json::json!({ "ok": false, "error": err });
    json_to_c_string(value)
}

/// Decode une chaine C null-terminated en `PathBuf` possede (duree de vie FFI).
unsafe fn path_from_c_str(ptr: *const c_char) -> std::path::PathBuf {
    std::path::PathBuf::from(CStr::from_ptr(ptr).to_string_lossy().into_owned())
}

/// Decode une chaine C null-terminated en `String` possedee.
unsafe fn str_from_c_str(ptr: *const c_char) -> String {
    CStr::from_ptr(ptr).to_string_lossy().into_owned()
}

/// Libere une chaine allouee par les fonctions `canari_*` de ce module.
#[no_mangle]
pub extern "C" fn canari_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(CString::from_raw(ptr));
    }
}

/// Dechiffre un message MLS et retourne un JSON UTF-8 alloue sur le tas.
#[no_mangle]
pub unsafe extern "C" fn canari_native_decrypt_message(
    state_ptr: *const u8,
    state_len: usize,
    pin: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
) -> *mut c_char {
    if state_ptr.is_null()
        || pin.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || cipher_ptr.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let ciphertext = slice::from_raw_parts(cipher_ptr, cipher_len);
    let pin_str = str_from_c_str(pin);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);

    match decrypt_push_message(
        state_bytes,
        &pin_str,
        &user_id_str,
        &device_id_str,
        &group_id_str,
        ciphertext,
    ) {
        Some(v) => json_to_c_string(v),
        None => json_to_c_string(serde_json::json!({ "ok": false })),
    }
}

/// Retourne l'epoch MLS courant du groupe dans l'etat persiste, ou -1 si inconnu / etat illisible.
/// Le chemin push background l'appelle pour calculer le `sinceEpoch` a recuperer avant le rattrapage
/// de commits en memoire. Lecture seule, ne persiste jamais.
#[no_mangle]
pub unsafe extern "C" fn canari_native_group_epoch(
    state_ptr: *const u8,
    state_len: usize,
    pin: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
) -> i64 {
    if state_ptr.is_null()
        || pin.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
    {
        return -1;
    }

    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let pin_str = str_from_c_str(pin);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);

    match background_group_epoch(
        state_bytes,
        &pin_str,
        &user_id_str,
        &device_id_str,
        &group_id_str,
    ) {
        // u64 epochs are tiny in practice (< 2^53); the i64 cast never truncates a real epoch.
        Some(e) => e as i64,
        None => -1,
    }
}

/// Rattrapage de commits en memoire (lecture seule) puis dechiffrement. Applique les commits ordonnes
/// de `commits_json` (tableau JSON de commits base64) a un manager ephemere pour atteindre l'epoch du
/// message, puis dechiffre `cipher_ptr`. Retourne le meme JSON que `canari_native_decrypt_message`,
/// ou `{"ok":false}`. N'ecrit jamais mls.bin - l'etat durable est rattrape plus tard au premier plan.
#[no_mangle]
pub unsafe extern "C" fn canari_native_decrypt_message_with_commits(
    state_ptr: *const u8,
    state_len: usize,
    pin: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    commits_json: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
) -> *mut c_char {
    if state_ptr.is_null()
        || pin.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || commits_json.is_null()
        || cipher_ptr.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let ciphertext = slice::from_raw_parts(cipher_ptr, cipher_len);
    let pin_str = str_from_c_str(pin);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);
    let commits = decode_commits_b64_json(&str_from_c_str(commits_json));

    match decrypt_push_message_with_commits(
        state_bytes,
        &pin_str,
        &user_id_str,
        &device_id_str,
        &group_id_str,
        &commits,
        ciphertext,
    ) {
        Some(v) => json_to_c_string(v),
        None => json_to_c_string(serde_json::json!({ "ok": false })),
    }
}

/// Dechiffre un message channel/communaute (AES-256-GCM, hors MLS). Les trois arguments sont des
/// chaines base64 : cle d'epoch brute (32 octets), nonce (12 octets), ciphertext (`ciphertext||tag`).
/// Retourne le meme JSON que `canari_native_decrypt_message` (`{"ok":true,"text":...}`), ou
/// `{"ok":false}`. Sans etat MLS ni verrou : le dechiffrement est stateless et en lecture seule.
/// Miroir FFI du JNI Android `nativeDecryptChannelMessage`.
#[no_mangle]
pub unsafe extern "C" fn canari_native_decrypt_channel_message(
    key_b64: *const c_char,
    nonce_b64: *const c_char,
    ciphertext_b64: *const c_char,
) -> *mut c_char {
    if key_b64.is_null() || nonce_b64.is_null() || ciphertext_b64.is_null() {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let decode = |s: String| STANDARD.decode(s.trim()).ok();
    let key = match decode(str_from_c_str(key_b64)) {
        Some(v) => v,
        None => return json_to_c_string(serde_json::json!({ "ok": false })),
    };
    let nonce = match decode(str_from_c_str(nonce_b64)) {
        Some(v) => v,
        None => return json_to_c_string(serde_json::json!({ "ok": false })),
    };
    let ciphertext = match decode(str_from_c_str(ciphertext_b64)) {
        Some(v) => v,
        None => return json_to_c_string(serde_json::json!({ "ok": false })),
    };

    match decrypt_channel_message(&key, &nonce, &ciphertext) {
        Some(v) => json_to_c_string(v),
        None => json_to_c_string(serde_json::json!({ "ok": false })),
    }
}

/// Cree un Welcome MLS. Retourne un JSON alloue (`welcome`, `commit`, `baseEpoch`, ...).
#[no_mangle]
pub unsafe extern "C" fn canari_native_create_welcome_background(
    files_dir: *const c_char,
    state_ptr: *const u8,
    state_len: usize,
    pin: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    key_package_b64: *const c_char,
) -> *mut c_char {
    if files_dir.is_null()
        || state_ptr.is_null()
        || pin.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || key_package_b64.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let files_dir = path_from_c_str(files_dir);
    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    match create_welcome_background(
        &files_dir,
        state_bytes,
        &str_from_c_str(pin),
        &str_from_c_str(user_id),
        &str_from_c_str(device_id),
        &str_from_c_str(group_id),
        &str_from_c_str(key_package_b64),
    ) {
        Ok(v) => json_to_c_string(v),
        Err(e) => err_json_to_c_string(e),
    }
}

/// Applique un Welcome recu. Retourne 1 si succes, 0 sinon.
#[no_mangle]
pub unsafe extern "C" fn canari_native_process_welcome_background(
    files_dir: *const c_char,
    state_ptr: *const u8,
    state_len: usize,
    pin: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    welcome_b64: *const c_char,
    ratchet_tree_b64: *const c_char,
) -> i32 {
    if files_dir.is_null()
        || state_ptr.is_null()
        || pin.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || welcome_b64.is_null()
        || ratchet_tree_b64.is_null()
    {
        return 0;
    }

    let files_dir = path_from_c_str(files_dir);
    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    match process_welcome_background(
        &files_dir,
        state_bytes,
        &str_from_c_str(pin),
        &str_from_c_str(user_id),
        &str_from_c_str(device_id),
        &str_from_c_str(welcome_b64),
        &str_from_c_str(ratchet_tree_b64),
    ) {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[BG_JOIN] canari_native_process_welcome_background: {e}");
            0
        }
    }
}

/// Chiffre un proto AppMessage en clair (base64) et retourne `{"ok":true,"ciphertext":"..."}`.
#[no_mangle]
pub unsafe extern "C" fn canari_native_send_message_background(
    files_dir: *const c_char,
    state_ptr: *const u8,
    state_len: usize,
    pin: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    proto_b64: *const c_char,
) -> *mut c_char {
    if files_dir.is_null()
        || state_ptr.is_null()
        || pin.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || proto_b64.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let files_dir = path_from_c_str(files_dir);
    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    match send_message_background(
        &files_dir,
        state_bytes,
        &str_from_c_str(pin),
        &str_from_c_str(user_id),
        &str_from_c_str(device_id),
        &str_from_c_str(group_id),
        &str_from_c_str(proto_b64),
    ) {
        Ok(v) => json_to_c_string(v),
        Err(e) => err_json_to_c_string(e),
    }
}

/// Builds a plaintext `AppMessage` text proto (base64, heap-allocated C string) for a
/// notification quick-reply (`UNTextInputNotificationAction`), without touching MLS state. The
/// caller (canari_push.mm) appends the result as an entry to `outbox_pending.ndjson` and drains it
/// through the existing `canari_native_send_message_background`-based `CanariDrainOutboxBackground`
/// - no new send path, only a new way to produce the plaintext proto when the app may be killed.
#[no_mangle]
pub unsafe extern "C" fn canari_native_build_text_message_proto(
    message_id: *const c_char,
    sent_at: i64,
    content: *const c_char,
) -> *mut c_char {
    if message_id.is_null() || content.is_null() {
        return CString::new("").unwrap().into_raw();
    }
    let bytes = build_text_app_message(
        &str_from_c_str(message_id),
        sent_at,
        &str_from_c_str(content),
    );
    CString::new(STANDARD.encode(&bytes))
        .unwrap_or_else(|_| CString::new("").expect("static empty"))
        .into_raw()
}

/// Builds a plaintext `AppMessage` read-receipt (system) proto (base64, heap-allocated C string)
/// for the "mark as read" notification quick action. `message_ids_json` is a JSON array of message
/// id strings (read from `fcm_message_cache.ndjson` on the ObjC side). Sent through the outbox
/// drain like the reply above, but marked `silent` by the caller so it triggers the existing
/// cross-device notification-cancel path instead of a peer push.
#[no_mangle]
pub unsafe extern "C" fn canari_native_build_read_receipt_proto(
    message_ids_json: *const c_char,
) -> *mut c_char {
    if message_ids_json.is_null() {
        return CString::new("").unwrap().into_raw();
    }
    let ids: Vec<String> =
        serde_json::from_str(&str_from_c_str(message_ids_json)).unwrap_or_default();
    let bytes = build_read_receipt_app_message(&ids);
    CString::new(STANDARD.encode(&bytes))
        .unwrap_or_else(|_| CString::new("").expect("static empty"))
        .into_raw()
}

/// Nettoie `mls_pending.db`. Retourne 1 si succes.
#[no_mangle]
pub unsafe extern "C" fn canari_native_cleanup_pending_db(files_dir: *const c_char) -> i32 {
    if files_dir.is_null() {
        return 0;
    }
    let files_dir = path_from_c_str(files_dir);
    match cleanup_pending_db(&files_dir) {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[PushBG] cleanup_pending_db: {e}");
            0
        }
    }
}

/// Rafraichit la garde foreground (appele depuis `canari_ios` au resume).
#[no_mangle]
pub extern "C" fn canari_ios_on_resume() {
    crate::mark_foreground_active();
    log::debug!("[iOS] canari_ios_on_resume: garde foreground rafraichie");
}

/// Signale la mise en arriere-plan (log diagnostic).
#[no_mangle]
pub extern "C" fn canari_ios_on_pause() {
    log::debug!("[iOS] canari_ios_on_pause");
}
