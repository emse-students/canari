#pragma once

// C declarations for the Rust MLS decrypt FFI exported from `libapp.a`
// (src-tauri/src/mobile/ios_ffi.rs). The Notification Service Extension links the
// same static library as the app and calls these leaf functions directly to
// decrypt a push in its own process. They are read-only: none of them persist
// mls.bin. Every `char *` returned here is heap-allocated by Rust and MUST be
// released with `canari_free_string`.

// <stddef.h> for size_t, <stdint.h> for the fixed-width types. Both are needed and neither is
// implied: this header is precompiled as the NSE's bridging header, where nothing else is in
// scope, so a missing include is a build failure in the extension target ALONE - the app target
// links the same libapp.a without ever parsing this file. `uint32_t` arrived with the Graine
// decrypt entry point and <stdint.h> did not, which took out the whole v0.14.1 iOS release.
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Decrypts an MLS application message. Returns a heap JSON string
/// (`{"ok":true,"text":...}` or `{"ok":false,"reason":...}`); free with canari_free_string.
/// sender_id is the push's own: a frame MLS verified as sent by somebody else is refused with
/// `reason=sender-mismatch` (WP-G2-1b).
char *canari_native_decrypt_message(const unsigned char *state_ptr, size_t state_len,
                                    const char *device_key_b64, const char *user_id, const char *device_id,
                                    const char *group_id, const char *sender_id,
                                    const unsigned char *cipher_ptr, size_t cipher_len);

/// Returns the persisted group's current MLS epoch, or -1 if unknown / unreadable.
/// Used to compute the `sinceEpoch` before an in-memory commit catch-up.
long long canari_native_group_epoch(const unsigned char *state_ptr, size_t state_len,
                                    const char *device_key_b64, const char *user_id, const char *device_id,
                                    const char *group_id);

/// In-memory commit catch-up then decrypt: applies the ordered base64 commits in
/// `commits_json` to reach the message epoch, then decrypts. Never persists mls.bin.
/// Same JSON contract as canari_native_decrypt_message.
char *canari_native_decrypt_message_with_commits(const unsigned char *state_ptr, size_t state_len,
                                                 const char *device_key_b64, const char *user_id,
                                                 const char *device_id, const char *group_id,
                                                 const char *sender_id, const char *commits_json,
                                                 const unsigned char *cipher_ptr, size_t cipher_len);

/// Opens a community-channel push sealed under a Graine session (AES-256-GCM, not MLS) against
/// data_dir/graine_seeds.json: Rust reads the session and applies the floor and, under a v2 session,
/// the author, the signature and the AAD (channel-encryption section 21.5). nonce_b64,
/// ciphertext_b64 and signature_b64 are the push's own fields; signature_b64 is "" when it carried
/// none. Same JSON contract as canari_native_decrypt_message. Read-only and lock-free.
char *canari_native_open_graine_push(const char *data_dir, const char *channel_id,
                                     const char *session_id, uint32_t message_index,
                                     const char *sender_id, const char *nonce_b64,
                                     const char *ciphertext_b64, const char *signature_b64);

/// Writes the seeds of a key-material frame (the `seeds` array of a graine-key-material refusal)
/// into data_dir/graine_seeds.json, under the file lock every writer takes. Returns how many were
/// kept, or -1 when the payload is not a JSON array. Channel-encryption section 19.
int32_t canari_native_store_graine_seeds(const char *data_dir, const char *seeds_json);

/// Decrypts an end-to-end-encrypted media blob (AES-256-GCM) into raw plaintext bytes for a
/// notification thumbnail (WP-XP-3). key_b64/iv_b64 are the base64 CEK (32 bytes) + IV (12 bytes)
/// from the MLS-decrypted MediaMsg; cipher_ptr/cipher_len point at the downloaded ciphertext||tag.
/// Writes the plaintext length to out_len and returns a heap buffer to free with canari_free_bytes,
/// or NULL (out_len set to 0) on failure.
unsigned char *canari_native_decrypt_media(const char *key_b64, const char *iv_b64,
                                           const unsigned char *cipher_ptr, size_t cipher_len,
                                           size_t *out_len);

/// Frees a byte buffer returned by canari_native_decrypt_media. len MUST be the value written to
/// out_len by that call.
void canari_free_bytes(unsigned char *ptr, size_t len);

/// Frees a string returned by any of the canari_native_* functions above.
void canari_free_string(char *ptr);

#ifdef __cplusplus
}
#endif
