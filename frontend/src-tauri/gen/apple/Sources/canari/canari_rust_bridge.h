#pragma once

#include <stddef.h>
#include <stdint.h>
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
    const char *entries_json,
    size_t max_attempts);

char *canari_native_build_text_message_proto(
    const char *message_id,
    long long sent_at,
    const char *content);

char *canari_native_build_read_watermark_proto(long long at);

char *canari_native_build_call_hangup_proto(
    const char *message_id,
    long long sent_at,
    const char *call_id,
    const char *device_id,
    unsigned int end_reason);

int canari_native_cleanup_pending_db(const char *files_dir);

void canari_ios_on_resume(void);
void canari_ios_on_pause(void);

/* Whether the page rings an incoming call itself: it holds the gateway socket the caller's invite
   arrives on (Rust `page_ring`). An app in front at the PIN gate holds none, and is rung natively. */
bool canari_ios_page_rings_in_app(void);

/* Whether the page is ringing THIS call itself (its CallService is `incoming` on it, Rust
   `page_ring`). The handover ends an unanswered CallKit ring only on this: a page holding the
   socket may still have skipped that call's invite. */
bool canari_ios_page_rings_call(const char *call_id);

/* Registers the function Rust `page_ring` calls when the page STARTS ringing a call, with its id
   (valid for the call only, on the thread of the Tauri command). Registered, never linked: the
   Rust library is linked into the notification extension too, where that function does not exist.
   NULL removes it. */
void canari_ios_set_page_ringing_listener(void (*listener)(const char *call_id));

/* The share manifest's name, in the app data directory and in the App Group: the native side
   only STATS it (whether a share waits, which Data Protection allows while the device is locked),
   never reads it. Pinned against Rust's PENDING_SHARE_FILE by iosShareExtension.test.ts. */
#define CANARI_SHARE_PENDING_FILE "pending_share.json"

/* A share INTO Canari left by the Share Extension in the App Group (commands/app_group_share.rs):
   carried into the app data and cache directories. Answers one of the codes below, which the
   caller NSLogs - the launch call runs before the Rust logger exists. Pinned against the Rust
   IMPORT_* constants by iosShareExtension.test.ts. */
#define CANARI_SHARE_IMPORT_IMPORTED 1
#define CANARI_SHARE_IMPORT_NOTHING 0
#define CANARI_SHARE_IMPORT_BUSY 2
#define CANARI_SHARE_IMPORT_DROPPED 3
#define CANARI_SHARE_IMPORT_PROTECTED 4
#define CANARI_SHARE_IMPORT_DROPPED_OVER_LOCKED 5
#define CANARI_SHARE_IMPORT_NO_DIRS (-1)
#define CANARI_SHARE_IMPORT_NO_GROUP (-2)
#define CANARI_SHARE_IMPORT_FAILED (-3)
int canari_ios_import_app_group_share(const char *data_dir, const char *cache_dir);

/* Once per process, before the page exists: deletes the share copies no current manifest names,
   the App Group's leftover claim files, and repairs an App Group epoch behind the app's. The
   report is NSLogged by the caller (Rust's CanariShareSweep, same layout; flags are SWEEP_*). */
typedef struct {
  int32_t deleted;
  int32_t leftovers;
  uint32_t flags;
} CanariShareSweep;
#define CANARI_SHARE_SWEEP_ALREADY_RAN (1u << 0)
#define CANARI_SHARE_SWEEP_NO_DIRS (1u << 1)
#define CANARI_SHARE_SWEEP_NO_GROUP (1u << 2)
#define CANARI_SHARE_SWEEP_GROUP_BUSY (1u << 3)
#define CANARI_SHARE_SWEEP_GROUP_LOCK_FAILED (1u << 4)
#define CANARI_SHARE_SWEEP_EPOCH_UNREADABLE (1u << 5)
#define CANARI_SHARE_SWEEP_EPOCH_REPAIRED (1u << 6)
#define CANARI_SHARE_SWEEP_EPOCH_REPAIR_FAILED (1u << 7)
#define CANARI_SHARE_SWEEP_LEFTOVER_FAILED (1u << 8)
#define CANARI_SHARE_SWEEP_PROTECTED (1u << 9)
#define CANARI_SHARE_SWEEP_CLAIM_RESTORED (1u << 10)
#define CANARI_SHARE_SWEEP_CLAIM_LOST (1u << 11)
CanariShareSweep canari_ios_sweep_shared_inboxes(const char *data_dir, const char *cache_dir);

#ifdef __cplusplus
}
#endif
