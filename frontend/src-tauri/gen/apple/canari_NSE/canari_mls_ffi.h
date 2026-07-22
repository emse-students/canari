#pragma once

// C declarations for the Rust MLS decrypt FFI exported from `libapp.a`
// (src-tauri/src/mobile/ios_ffi.rs). The Notification Service Extension links the
// same static library as the app and calls these leaf functions directly to
// decrypt a push in its own process. They are read-only: none of them persist
// mls.bin. Every `char *` returned here is heap-allocated by Rust and MUST be
// released with `canari_free_string`.

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Decrypts an MLS application message. Returns a heap JSON string
/// (`{"ok":true,"text":...}` or `{"ok":false}`); free with canari_free_string.
char *canari_native_decrypt_message(const unsigned char *state_ptr, size_t state_len,
                                    const char *pin, const char *user_id, const char *device_id,
                                    const char *group_id, const unsigned char *cipher_ptr,
                                    size_t cipher_len);

/// Returns the persisted group's current MLS epoch, or -1 if unknown / unreadable.
/// Used to compute the `sinceEpoch` before an in-memory commit catch-up.
long long canari_native_group_epoch(const unsigned char *state_ptr, size_t state_len,
                                    const char *pin, const char *user_id, const char *device_id,
                                    const char *group_id);

/// In-memory commit catch-up then decrypt: applies the ordered base64 commits in
/// `commits_json` to reach the message epoch, then decrypts. Never persists mls.bin.
/// Same JSON contract as canari_native_decrypt_message.
char *canari_native_decrypt_message_with_commits(const unsigned char *state_ptr, size_t state_len,
                                                 const char *pin, const char *user_id,
                                                 const char *device_id, const char *group_id,
                                                 const char *commits_json,
                                                 const unsigned char *cipher_ptr, size_t cipher_len);

/// Decrypts a channel/community message (AES-256-GCM, not MLS). All three args are
/// base64: raw epoch key (32 bytes), nonce (12 bytes), ciphertext (`ciphertext||tag`).
/// Same JSON contract as canari_native_decrypt_message. Stateless and read-only.
char *canari_native_decrypt_channel_message(const char *key_b64, const char *nonce_b64,
                                            const char *ciphertext_b64);

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
