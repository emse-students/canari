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
    const char *pin,
    const char *user_id,
    const char *device_id,
    const char *group_id,
    const unsigned char *cipher_ptr,
    size_t cipher_len);

long long canari_native_group_epoch(
    const unsigned char *state_ptr,
    size_t state_len,
    const char *pin,
    const char *user_id,
    const char *device_id,
    const char *group_id);

char *canari_native_decrypt_message_with_commits(
    const unsigned char *state_ptr,
    size_t state_len,
    const char *pin,
    const char *user_id,
    const char *device_id,
    const char *group_id,
    const char *commits_json,
    const unsigned char *cipher_ptr,
    size_t cipher_len);

char *canari_native_decrypt_channel_message(
    const char *key_b64,
    const char *nonce_b64,
    const char *ciphertext_b64);

char *canari_native_create_welcome_background(
    const char *files_dir,
    const unsigned char *state_ptr,
    size_t state_len,
    const char *pin,
    const char *user_id,
    const char *device_id,
    const char *group_id,
    const char *key_package_b64);

int canari_native_process_welcome_background(
    const char *files_dir,
    const unsigned char *state_ptr,
    size_t state_len,
    const char *pin,
    const char *user_id,
    const char *device_id,
    const char *welcome_b64,
    const char *ratchet_tree_b64);

char *canari_native_send_message_background(
    const char *files_dir,
    const unsigned char *state_ptr,
    size_t state_len,
    const char *pin,
    const char *user_id,
    const char *device_id,
    const char *group_id,
    const char *proto_b64);

int canari_native_cleanup_pending_db(const char *files_dir);

void canari_ios_on_resume(void);
void canari_ios_on_pause(void);

#ifdef __cplusplus
}
#endif
