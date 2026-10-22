#pragma once

#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void canari_free_string(char *ptr);

char *canari_native_decrypt_message(
    const unsigned char *state_ptr,
    size_t state_len,
    const char *device_key_b64,
    const char *user_id,
    const char *device_id,
    const char *group_id,
    const char *sender_id,
    const unsigned char *cipher_ptr,
    size_t cipher_len,
    const char *locale);

long long canari_native_group_epoch(
    const unsigned char *state_ptr,
    size_t state_len,
    const char *device_key_b64,
    const char *user_id,
    const char *device_id,
    const char *group_id);

char *canari_native_decrypt_message_with_commits(
    const unsigned char *state_ptr,
    size_t state_len,
    const char *device_key_b64,
    const char *user_id,
    const char *device_id,
    const char *group_id,
    const char *sender_id,
    const char *commits_json,
    const unsigned char *cipher_ptr,
    size_t cipher_len,
    const char *locale);

/// cache_key_b64 is the install's native cache key the mirror is sealed under, "" when unreadable.
char *canari_native_open_graine_push(
    const char *data_dir,
    const char *cache_key_b64,
    const char *channel_id,
    const char *session_id,
    uint32_t message_index,
    const char *sender_id,
    const char *nonce_b64,
    const char *ciphertext_b64,
    const char *signature_b64,
    const char *locale);

/// Writes the seeds of a key-material frame (the `seeds` array of a graine-key-material refusal)
/// into data_dir/graine_seeds.json, sealed under cache_key_b64, under the file lock every writer
/// takes. Returns how many were kept, or -1 when the payload is not a JSON array or there is no
/// key (nothing is ever written in the clear). Channel-encryption section 19.
int32_t canari_native_store_graine_seeds(
    const char *data_dir, const char *cache_key_b64, const char *seeds_json);

/// Whether data_dir/graine_seeds.json holds a session: 1 yes, 0 no, -1 unreadable.
int32_t canari_native_graine_seed_held(
    const char *data_dir, const char *cache_key_b64, const char *channel_id,
    const char *session_id);

/// Seals one push-cache line under cache_key_b64. NULL when there is no usable key - the caller then
/// writes nothing. Free with canari_free_string.
char *canari_native_seal_cache_line(const char *cache_key_b64, const char *line);

unsigned char *canari_native_decrypt_media(
    const char *key_b64,
    const char *iv_b64,
    const unsigned char *cipher_ptr,
    size_t cipher_len,
    size_t *out_len);

void canari_free_bytes(unsigned char *ptr, size_t len);

int canari_native_process_welcome_background(
    const char *files_dir,
    const unsigned char *state_ptr,
    size_t state_len,
    const char *device_key_b64,
    const char *user_id,
    const char *device_id,
    const char *welcome_b64,
    const char *ratchet_tree_b64);

char *canari_native_send_messages_background(
    const char *files_dir,
    const unsigned char *state_ptr,
    size_t state_len,
    const char *device_key_b64,
    const char *user_id,
    const char *device_id,
    const char *entries_json);

char *canari_native_build_text_message_proto(
    const char *message_id,
    long long sent_at,
    const char *content);

char *canari_native_build_read_watermark_proto(long long at);

int canari_native_cleanup_pending_db(const char *files_dir);

void canari_ios_on_resume(void);
void canari_ios_on_pause(void);

#ifdef __cplusplus
}
#endif
