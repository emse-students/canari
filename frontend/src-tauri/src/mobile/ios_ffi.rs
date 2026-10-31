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
    background_group_epoch_with_key, cleanup_pending_db, decode_commits_b64_json,
    decrypt_push_message_with_commits_with_key, decrypt_push_message_with_key, open_graine_push,
    parse_outbox_entries_json, process_welcome_background_with_key,
    send_messages_background_with_key, GrainePush, PushFrame,
};
use super::proto_fields::{
    build_call_hangup_app_message, build_read_watermark_app_message, build_text_app_message,
};
use super::push_text::PushLanguage;

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
///
/// `locale` is the app language mirrored in `push_context.json` (`""` when none was), and words
/// every sentence the scanner composes itself (`PushLanguage::from_tag`).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn canari_native_decrypt_message(
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    sender_id: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
    locale: *const c_char,
) -> *mut c_char {
    if state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || sender_id.is_null()
        || cipher_ptr.is_null()
        || locale.is_null()
    {
        return json_to_c_string(serde_json::json!({ "ok": false }));
    }

    let state_bytes = slice::from_raw_parts(state_ptr, state_len);
    let ciphertext = slice::from_raw_parts(cipher_ptr, cipher_len);
    let device_key_str = str_from_c_str(device_key_b64);
    let user_id_str = str_from_c_str(user_id);
    let device_id_str = str_from_c_str(device_id);
    let group_id_str = str_from_c_str(group_id);

    // ALWAYS A VALUE NOW, AND IT CARRIES ITS OWN `reason` - see `refused` in `background.rs`. The
    // `None` arm this replaces collapsed every distinct refusal into one indistinguishable object,
    // so the iOS half had exactly the fault the Android half was measured on.
    json_to_c_string(decrypt_push_message_with_key(
        state_bytes,
        &device_key_str,
        &user_id_str,
        &device_id_str,
        &PushFrame {
            group_id: &group_id_str,
            sender_id: &str_from_c_str(sender_id),
            ciphertext,
        },
        PushLanguage::from_tag(&str_from_c_str(locale)),
    ))
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
/// `locale` as for `canari_native_decrypt_message`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn canari_native_decrypt_message_with_commits(
    state_ptr: *const u8,
    state_len: usize,
    device_key_b64: *const c_char,
    user_id: *const c_char,
    device_id: *const c_char,
    group_id: *const c_char,
    sender_id: *const c_char,
    commits_json: *const c_char,
    cipher_ptr: *const u8,
    cipher_len: usize,
    locale: *const c_char,
) -> *mut c_char {
    if state_ptr.is_null()
        || device_key_b64.is_null()
        || user_id.is_null()
        || device_id.is_null()
        || group_id.is_null()
        || sender_id.is_null()
        || commits_json.is_null()
        || cipher_ptr.is_null()
        || locale.is_null()
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

    json_to_c_string(decrypt_push_message_with_commits_with_key(
        state_bytes,
        &device_key_str,
        &user_id_str,
        &device_id_str,
        &commits,
        &PushFrame {
            group_id: &group_id_str,
            sender_id: &str_from_c_str(sender_id),
            ciphertext,
        },
        PushLanguage::from_tag(&str_from_c_str(locale)),
    ))
}

/// Opens a salon push against the seed mirror under `data_dir`: every v1 and v2 rule, in the one
/// implementation both platforms share (`background::open_graine_push`). `signature_b64` is an
/// empty string when the push carried none. Returns the same JSON as
/// `canari_native_decrypt_message`. Read-only and lock-free. FFI mirror of the Android JNI
/// `nativeOpenGrainePush`. `locale` as for `canari_native_decrypt_message`. `cache_key_b64` is the
/// install's native cache key the caller read from the shared Keychain item (`native_cache`), or an
/// empty string when it could not.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn canari_native_open_graine_push(
    data_dir: *const c_char,
    cache_key_b64: *const c_char,
    channel_id: *const c_char,
    session_id: *const c_char,
    message_index: u32,
    sender_id: *const c_char,
    nonce_b64: *const c_char,
    ciphertext_b64: *const c_char,
    signature_b64: *const c_char,
    locale: *const c_char,
) -> *mut c_char {
    if [
        data_dir,
        cache_key_b64,
        channel_id,
        session_id,
        sender_id,
        nonce_b64,
        ciphertext_b64,
        signature_b64,
        locale,
    ]
    .iter()
    .any(|p| p.is_null())
    {
        return json_to_c_string(serde_json::json!({ "ok": false, "reason": "ffi-null" }));
    }
    let cache_key = crate::native_cache::platform_key(&str_from_c_str(cache_key_b64));
    let dir = str_from_c_str(data_dir);
    let channel = str_from_c_str(channel_id);
    let session = str_from_c_str(session_id);
    let sender = str_from_c_str(sender_id);
    let nonce = str_from_c_str(nonce_b64);
    let ciphertext = str_from_c_str(ciphertext_b64);
    let signature = str_from_c_str(signature_b64);
    json_to_c_string(open_graine_push(
        std::path::Path::new(&dir),
        cache_key.as_ref(),
        &GrainePush {
            channel_id: &channel,
            session_id: &session,
            index: message_index,
            sender_id: &sender,
            nonce_b64: &nonce,
            ciphertext_b64: &ciphertext,
            signature_b64: &signature,
        },
        PushLanguage::from_tag(&str_from_c_str(locale)),
    ))
}

/// Writes the seeds of a key-material frame into `{data_dir}/graine_seeds.json`, and returns how
/// many it kept, or -1 when the arguments or the payload could not be read at all.
///
/// `seeds_json` is the `seeds` array of a `graine-key-material` refusal, exactly as
/// `canari_native_decrypt_message` returned it. The extension calls this when it opens the seed
/// frame a salon push carries (channel-encryption section 19). `data_dir` is the App Group
/// directory both the app and the extension read the mirror from. FFI mirror of the Android JNI
/// `nativeStoreGraineSeeds`, and the same implementation behind it. `cache_key_b64` as for
/// [`canari_native_open_graine_push`]; with none, nothing is written (-1).
#[no_mangle]
pub unsafe extern "C" fn canari_native_store_graine_seeds(
    data_dir: *const c_char,
    cache_key_b64: *const c_char,
    seeds_json: *const c_char,
) -> i32 {
    if data_dir.is_null() || cache_key_b64.is_null() || seeds_json.is_null() {
        log::error!("[GRAINE_PUSH] ffi: null argument");
        return -1;
    }
    let cache_key = crate::native_cache::platform_key(&str_from_c_str(cache_key_b64));
    crate::commands::push::store_graine_seeds_json(
        &path_from_c_str(data_dir),
        cache_key.as_ref(),
        &str_from_c_str(seeds_json),
    )
}

/// Whether the seed mirror under `data_dir` holds a session: 1 yes, 0 no, -1 it cannot be read.
/// What the push paths ask before choosing between the mirror and a seed frame, so the seed itself
/// never leaves Rust. FFI mirror of the Android JNI `nativeGraineSeedHeld`.
#[no_mangle]
pub unsafe extern "C" fn canari_native_graine_seed_held(
    data_dir: *const c_char,
    cache_key_b64: *const c_char,
    channel_id: *const c_char,
    session_id: *const c_char,
) -> i32 {
    if [data_dir, cache_key_b64, channel_id, session_id]
        .iter()
        .any(|p| p.is_null())
    {
        log::error!("[GRAINE_MIRROR] ffi: null argument");
        return -1;
    }
    let cache_key = crate::native_cache::platform_key(&str_from_c_str(cache_key_b64));
    crate::commands::push::graine_seed_held(
        &path_from_c_str(data_dir),
        cache_key.as_ref(),
        &str_from_c_str(channel_id),
        &str_from_c_str(session_id),
    )
}

/// Seals one push-cache line (`native_cache`) and returns it as a heap C string to free with
/// `canari_free_string`, or NULL when there is no usable key - in which case the caller writes
/// NOTHING. Never a line in the clear. FFI mirror of the Android JNI `nativeSealCacheLine`.
#[no_mangle]
pub unsafe extern "C" fn canari_native_seal_cache_line(
    cache_key_b64: *const c_char,
    line: *const c_char,
) -> *mut c_char {
    if cache_key_b64.is_null() || line.is_null() {
        log::error!("[FCM_CACHE] ffi: null argument");
        return std::ptr::null_mut();
    }
    let Some(key) = crate::native_cache::platform_key(&str_from_c_str(cache_key_b64)) else {
        return std::ptr::null_mut();
    };
    let sealed = crate::native_cache::seal_line(
        &key,
        crate::native_cache::Purpose::PushCache,
        &str_from_c_str(line),
    );
    match std::ffi::CString::new(sealed) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Claims the `ownDeviceAdded` keys of a decrypt answer in the device-notice ledger under
/// `data_dir` (the App Group directory, which the app's own claim uses too) and returns the keys
/// nobody announced before as a JSON array - free with `canari_free_string`. NULL arguments claim
/// nothing and answer `[]`. FFI mirror of the Android JNI `nativeClaimDeviceNotices`, and the same
/// implementation behind it (`mobile::device_notice`).
#[no_mangle]
pub unsafe extern "C" fn canari_native_claim_device_notices(
    data_dir: *const c_char,
    keys_json: *const c_char,
) -> *mut c_char {
    if data_dir.is_null() || keys_json.is_null() {
        log::error!("[DEVICE_NOTICE] ffi: null argument - nothing claimed");
        return json_to_c_string(serde_json::json!([]));
    }
    let claimed = super::device_notice::claim_device_notices_json(
        &path_from_c_str(data_dir),
        &str_from_c_str(keys_json),
    );
    let value = serde_json::from_str(&claimed).unwrap_or_else(|_| serde_json::json!([]));
    json_to_c_string(value)
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
/// `entries_json` is `[{"id":"...","groupId":"...","proto":"<b64>"}, ...]`; at most `max_attempts`
/// of them are encrypted, a group held behind an unsettled staged commit taking none. Android twin:
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
    max_attempts: usize,
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
        max_attempts,
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

/// Builds a plaintext `AppMessage` read-watermark (system) proto (base64, heap-allocated C string)
/// for the "mark as read" and quick-reply notification actions. `at` is the sender's `sent_at` for
/// the message the notification is about, carried in the notification's `userInfo` - never this
/// device's clock, for the reason [`build_read_watermark_app_message`] states. Sent through the
/// outbox drain like the reply above, but marked `silent` by the caller so it triggers the existing
/// cross-device notification-cancel path instead of a peer push.
#[no_mangle]
pub unsafe extern "C" fn canari_native_build_read_watermark_proto(at: i64) -> *mut c_char {
    let bytes = build_read_watermark_app_message(at);
    CString::new(STANDARD.encode(&bytes))
        .unwrap_or_else(|_| CString::new("").expect("static empty"))
        .into_raw()
}

/// Builds the call hangup (base64, heap-allocated C string) the CallKit Decline sends - the frame
/// the in-app Decline sends, so the caller's ring ends at once ([`build_call_hangup_app_message`]).
/// `end_reason` is the wire value of `CallEndReason` (DECLINED = 2). Empty on a null argument.
#[no_mangle]
pub unsafe extern "C" fn canari_native_build_call_hangup_proto(
    message_id: *const c_char,
    sent_at: i64,
    call_id: *const c_char,
    device_id: *const c_char,
    end_reason: u32,
) -> *mut c_char {
    if message_id.is_null() || call_id.is_null() || device_id.is_null() {
        log::error!("[CALL_DECLINE] canari_native_build_call_hangup_proto: null argument");
        return CString::new("").unwrap().into_raw();
    }
    let bytes = build_call_hangup_app_message(
        &str_from_c_str(message_id),
        sent_at,
        &str_from_c_str(call_id),
        &str_from_c_str(device_id),
        end_reason,
    );
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

/// Whether the page rings an incoming call itself (it holds the gateway socket) - `page_ring`. The
/// CallKit ring of an app in front stands back only when this is true.
#[no_mangle]
pub extern "C" fn canari_ios_page_rings_in_app() -> bool {
    crate::page_ring::page_rings_in_app()
}

/// Whether the page is ringing `call_id` itself right now (its `CallService` is `incoming` on it) -
/// `page_ring`. The handover ends an UNANSWERED CallKit ring only when this is true: a page holding
/// the socket may still have skipped that call's invite, and its CallKit ring is then the only one.
///
/// # Safety
/// `call_id` must be null or a valid null-terminated C string for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn canari_ios_page_rings_call(call_id: *const c_char) -> bool {
    if call_id.is_null() {
        log::error!("[CALL_RING] canari_ios_page_rings_call: a null call id - rings no call");
        return false;
    }
    crate::page_ring::page_rings_call(&str_from_c_str(call_id))
}

/// Signals the move to background (diagnostic log).
#[no_mangle]
pub extern "C" fn canari_ios_on_pause() {
    log::debug!("[iOS] canari_ios_on_pause");
}
