//! C FFI bridge exposed by `libapp.a` to the native iOS code (ObjC++/Swift).
//!
//! Every MLS entry point takes `device_key_b64`: the base64 32-byte device key read from
//! `push_context.json`, never the user's PIN. Shared logic lives in `super::background`,
//! which is also what the Android JNI layer calls, so both platforms stay in lockstep.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::slice;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::concurrency::mark_foreground_active;

use super::background::{
    background_group_epoch_with_key, cleanup_pending_db, create_welcome_background_with_key,
    decode_commits_b64_json, decrypt_channel_message, decrypt_push_message_with_commits_with_key,
    decrypt_push_message_with_key, parse_outbox_entries_json, process_welcome_background_with_key,
    send_messages_background_with_key,
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

/// Decodes a null-terminated C string into an owned `PathBuf` (FFI lifetime).
unsafe fn path_from_c_str(ptr: *const c_char) -> std::path::PathBuf {
    std::path::PathBuf::from(CStr::from_ptr(ptr).to_string_lossy().into_owned())
}

/// Decodes a null-terminated C string into an owned `String`.
unsafe fn str_from_c_str(ptr: *const c_char) -> String {
    CStr::from_ptr(ptr).to_string_lossy().into_owned()
}

/// Frees a string allocated by the `canari_*` functions in this module.
#[no_mangle]
pub extern "C" fn canari_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(CString::from_raw(ptr));
    }
}

/// Decrypts an MLS message and returns a heap-allocated UTF-8 JSON string. Read-only.
#[no_mangle]
pub unsafe extern "C" fn canari_native_decrypt_message(
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
) -> *mut c_char {
    if state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || cipher_ptr.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let ciphertext = slice::from_raw_parts(cipher_ptr, cipher_len);
    let device_key_str = str_from_c_str(device_key_b64);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);

    match decrypt_push_message_with_key(
        state_bytes,
        &device_key_str,
        &user_id_str,
        &device_id_str,
        &group_id_str,
        ciphertext,
    ) {
        Some(v) => json_to_c_string(v),
        None => json_to_c_string(serde_json::json!({ "ok": false })),
    }
}

/// Returns the group's current MLS epoch from the persisted state, or -1 if unknown / unreadable.
/// The background push path calls this to compute the `sinceEpoch` to fetch before the in-memory
/// commit catch-up. Read-only, never persists.
#[no_mangle]
pub unsafe extern "C" fn canari_native_group_epoch(
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
) -> i64 {
    if state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
    {
        return -1;
    }

    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let device_key_str = str_from_c_str(device_key_b64);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);

    match background_group_epoch_with_key(
        state_bytes,
        &device_key_str,
        &user_id_str,
        &device_id_str,
        &group_id_str,
    ) {
        // u64 epochs are tiny in practice (< 2^53); the i64 cast never truncates a real epoch.
        Some(e) => e as i64,
        None => -1,
    }
}

/// In-memory commit catch-up (read-only) followed by decryption. Applies the ordered commits from
/// `commits_json` (JSON array of base64 commits) to an ephemeral manager to reach the message's
/// epoch, then decrypts `cipher_ptr`. Returns the same JSON as `canari_native_decrypt_message`, or
/// `{"ok":false}`. Never writes mls.bin - the durable state catches up later in the foreground.
#[no_mangle]
pub unsafe extern "C" fn canari_native_decrypt_message_with_commits(
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    commits_json: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
) -> *mut c_char {
    if state_ptr.is_null()
        || device_key_b64.is_null()
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
    let device_key_str = str_from_c_str(device_key_b64);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);
    let commits = decode_commits_b64_json(&str_from_c_str(commits_json));

    match decrypt_push_message_with_commits_with_key(
        state_bytes,
        &device_key_str,
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

/// Decrypts a channel/community message (AES-256-GCM, outside MLS). The three arguments are base64
/// strings: raw epoch key (32 bytes), nonce (12 bytes), ciphertext (`ciphertext||tag`). Returns the
/// same JSON as `canari_native_decrypt_message` (`{"ok":true,"text":...}`), or `{"ok":false}`. No
/// MLS state and no lock: the decryption is stateless and read-only.
/// FFI mirror of the Android JNI `nativeDecryptChannelMessage`.
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

/// Decrypts an end-to-end-encrypted media blob (AES-256-GCM) for a notification thumbnail
/// (WP-XP-3). `key_b64`/`iv_b64` are the CEK (32 bytes) + IV (12 bytes) in base64, extracted from
/// the MLS-decrypted `MediaMsg`; `cipher_ptr`/`cipher_len` point at the `ciphertext||tag`
/// downloaded from `/api/mls/push/media/:mediaId`. Writes the plaintext length to `out_len` and
/// returns a heap pointer to free with `canari_free_bytes`. Returns NULL (and `*out_len = 0`) on
/// failure. FFI mirror of the Android JNI `nativeDecryptMedia`.
#[no_mangle]
pub unsafe extern "C" fn canari_native_decrypt_media(
    key_b64: *const c_char,
    iv_b64: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if !out_len.is_null() {
        *out_len = 0;
    }
    if key_b64.is_null() || iv_b64.is_null() || cipher_ptr.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let decode = |s: String| STANDARD.decode(s.trim()).ok();
    let key = match decode(str_from_c_str(key_b64)) {
        Some(v) => v,
        None => return std::ptr::null_mut(),
    };
    let iv = match decode(str_from_c_str(iv_b64)) {
        Some(v) => v,
        None => return std::ptr::null_mut(),
    };
    let ciphertext = slice::from_raw_parts(cipher_ptr, cipher_len);

    let plaintext = match super::background::decrypt_media_blob(&key, &iv, ciphertext) {
        Some(v) => v,
        None => return std::ptr::null_mut(),
    };

    // Hand ownership to the caller as a boxed slice (capacity == length), matching `canari_free_bytes`.
    let mut boxed = plaintext.into_boxed_slice();
    let ptr = boxed.as_mut_ptr();
    *out_len = boxed.len();
    std::mem::forget(boxed);
    ptr
}

/// Frees a byte buffer allocated by `canari_native_decrypt_media`. `len` must be the length
/// returned via `out_len` (the allocation is a boxed slice, capacity == length).
#[no_mangle]
pub unsafe extern "C" fn canari_free_bytes(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// Creates an MLS Welcome. Returns an allocated JSON (`welcome`, `commit`, `baseEpoch`, ...).
#[no_mangle]
pub unsafe extern "C" fn canari_native_create_welcome_background(
    files_dir: *const c_char,
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    key_package_b64: *const c_char,
) -> *mut c_char {
    if files_dir.is_null()
        || state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || key_package_b64.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let files_dir = path_from_c_str(files_dir);
    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    match create_welcome_background_with_key(
        &files_dir,
        state_bytes,
        &str_from_c_str(device_key_b64),
        &str_from_c_str(user_id),
        &str_from_c_str(device_id),
        &str_from_c_str(group_id),
        &str_from_c_str(key_package_b64),
    ) {
        Ok(v) => json_to_c_string(v),
        Err(e) => err_json_to_c_string(e),
    }
}

/// Applies a received Welcome. Returns 1 on success, 0 otherwise.
#[no_mangle]
pub unsafe extern "C" fn canari_native_process_welcome_background(
    files_dir: *const c_char,
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    welcome_b64: *const c_char,
    ratchet_tree_b64: *const c_char,
) -> i32 {
    if files_dir.is_null()
        || state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || welcome_b64.is_null()
        || ratchet_tree_b64.is_null()
    {
        return 0;
    }

    let files_dir = path_from_c_str(files_dir);
    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    match process_welcome_background_with_key(
        &files_dir,
        state_bytes,
        &str_from_c_str(device_key_b64),
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

/// Encrypts a WHOLE outbox batch against one load of `mls.bin` and returns
/// `{"ok":true,"results":[{"id":..,"ok":..,"ciphertext"|"error":..}, ...]}`.
///
/// `entries_json` is `[{"id":"...","groupId":"...","proto":"<b64>"}, ...]`. Android twin:
/// `nativeSendMessagesBackground`. See `send_messages_background_with_key` for why the drain is a
/// batch and why the save must precede the return.
#[no_mangle]
pub unsafe extern "C" fn canari_native_send_messages_background(
    files_dir: *const c_char,
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    entries_json: *const c_char,
) -> *mut c_char {
    if files_dir.is_null()
        || state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || entries_json.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let files_dir = path_from_c_str(files_dir);
    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let entries = match parse_outbox_entries_json(&str_from_c_str(entries_json)) {
        Ok(entries) => entries,
        Err(e) => return err_json_to_c_string(e),
    };
    match send_messages_background_with_key(
        &files_dir,
        state_bytes,
        &str_from_c_str(device_key_b64),
        &str_from_c_str(user_id),
        &str_from_c_str(device_id),
        &entries,
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

/// Prunes `mls_pending.db`. Returns 1 on success.
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

/// Refreshes the foreground guard (called from `canari_ios` on resume).
#[no_mangle]
pub extern "C" fn canari_ios_on_resume() {
    mark_foreground_active();
    log::debug!("[iOS] canari_ios_on_resume: garde foreground rafraichie");
}

/// Signals the move to background (diagnostic log).
#[no_mangle]
pub extern "C" fn canari_ios_on_pause() {
    log::debug!("[iOS] canari_ios_on_pause");
}
