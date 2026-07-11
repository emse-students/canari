//! Pont FFI C expose a `libapp.a` pour le code natif iOS (ObjC++/Swift).

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::slice;

use super::background::{
    cleanup_pending_db, create_welcome_background, decrypt_push_message,
    process_welcome_background, send_message_background,
};

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
