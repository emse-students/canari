//! The native caches, sealed at rest: the Graine seed mirror (`graine_seeds.json`) and the push
//! message cache (`fcm_message_cache*.ndjson`).
//!
//! **WHAT THESE FILES ARE.** Both exist so a phone can do something while the app is shut: the seed
//! mirror lets the notification service derive a salon message key, and the push cache carries the
//! messages it decrypted to the app's next start. Each therefore holds what the app's own stores
//! seal - key material and message text - in a file a background process must read. Until
//! 2026-10-22 they were app-private PLAINTEXT; they are sealed now, and an older build's plaintext
//! copy is sealed the first time this build holds the key ([`seal_legacy_seed_mirror`]).
//!
//! **THE KEY IS ITS OWN, AND IT IS THE INSTALL'S, NOT THE ACCOUNT'S.** A random 32-byte key, created
//! once per install by the native side the moment the app's process starts (Android
//! `NativeCacheKey.ensure` in `CanariApplication`, iOS `CanariEnsureNativeCacheKey` at bootstrap),
//! and kept exactly where the device key's background copy is kept: wrapped by a non-exportable
//! Android Keystore key, or a Keychain item shared with the notification extension through the App
//! Group access group, `AfterFirstUnlockThisDeviceOnly` - never in a backup, never on another
//! device. It is NOT the device key, deliberately: the device key changes with the PIN, and every
//! file sealed under it would then have to be re-sealed across two processes the PIN change does not
//! hold - a window in which a background writer holding the old key meets a re-sealed file. A key
//! that never rotates has no such window. Nor is it derivable from anything the server holds.
//!
//! Rust never CREATES it: two creators could seal two halves of one file under two keys. The app
//! process reads it through the keystore plugin ([`app_cache_key`]); the background paths are handed
//! it by the platform code that read it.
//!
//! **TWO ENVELOPES.** A whole file (the mirror) is `MAGIC || nonce || ciphertext+tag`; a line of the
//! push cache is `cs1:<base64(nonce || ciphertext+tag)>`, so the NDJSON append, take and size-checked
//! acknowledgement keep working line by line. Each purpose has its own subkey (HKDF), so a line can
//! never be opened as the mirror or the other way round. Anything WITHOUT the marker is the format
//! an older build wrote, and is read as such - the reader for the previous format, in the same
//! commit as the change.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hkdf::Hkdf;
use sha2::Sha256;

/// The alias both platforms keep the key under (Android Keystore + `keystore_aliases` prefs; iOS
/// Keychain account `mls_bg_key_<alias>`). Spelled in `NativeCacheKey.kt`, `canari_ios.mm` and
/// `NotificationService.swift` too; `nativeCacheSeal.test.ts` holds the four together.
#[cfg(any(mobile, test))]
pub(crate) const CACHE_KEY_ALIAS: &str = "canari_native_cache_key";

/// The raw key.
pub(crate) type CacheKey = [u8; 32];

/// What a sealed value is FOR - each has its own subkey and its own AAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Purpose {
    /// `graine_seeds.json`, sealed whole.
    SeedMirror,
    /// One line of `fcm_message_cache*.ndjson`.
    PushCache,
}

impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Purpose::SeedMirror => b"canari/native-cache/v1/seed-mirror",
            Purpose::PushCache => b"canari/native-cache/v1/push-cache",
        }
    }
}

/// The marker a sealed whole file starts with. Never valid JSON, so a plaintext mirror cannot be
/// mistaken for a sealed one.
const FILE_MAGIC: &[u8; 8] = b"CNSEAL1\n";
/// The marker a sealed NDJSON line starts with. A plaintext line is a JSON object and starts `{`.
pub(crate) const LINE_PREFIX: &str = "cs1:";
const NONCE_LEN: usize = 12;

/// Why a sealed value did not open. Named for what was OBSERVED: a tag that does not verify is a
/// value sealed under another key or a damaged one, and nothing here can tell which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SealError {
    /// Shorter than its own envelope, or a line whose body is not base64.
    Malformed,
    /// The AEAD tag did not verify under this key and purpose.
    Unopenable,
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Malformed => write!(f, "sealed value malformed"),
            SealError::Unopenable => {
                write!(f, "sealed value does not open (another key, or damaged)")
            }
        }
    }
}

/// What a read found: a value this build sealed, or one an older build wrote in the clear.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Opened<T> {
    Sealed(T),
    Plaintext(T),
}

impl<T> Opened<T> {
    /// The value, whichever envelope it came in.
    pub(crate) fn into_inner(self) -> T {
        match self {
            Opened::Sealed(v) | Opened::Plaintext(v) => v,
        }
    }
}

fn cipher(key: &CacheKey, purpose: Purpose) -> Aes256Gcm {
    let mut sub = [0u8; 32];
    Hkdf::<Sha256>::new(None, key)
        .expand(purpose.label(), &mut sub)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&sub))
}

fn seal_raw(key: &CacheKey, purpose: Purpose, plain: &[u8]) -> Vec<u8> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher(key, purpose)
        .encrypt(
            &nonce,
            Payload {
                msg: plain,
                aad: purpose.label(),
            },
        )
        .expect("AES-GCM encryption of an in-memory buffer cannot fail");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

fn open_raw(key: &CacheKey, purpose: Purpose, sealed: &[u8]) -> Result<Vec<u8>, SealError> {
    if sealed.len() < NONCE_LEN + 16 {
        return Err(SealError::Malformed);
    }
    let (nonce, ct) = sealed.split_at(NONCE_LEN);
    cipher(key, purpose)
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: purpose.label(),
            },
        )
        .map_err(|_| SealError::Unopenable)
}

/// Seals a whole file's bytes.
pub(crate) fn seal_file(key: &CacheKey, purpose: Purpose, plain: &[u8]) -> Vec<u8> {
    let mut out = FILE_MAGIC.to_vec();
    out.extend(seal_raw(key, purpose, plain));
    out
}

/// Opens a whole file: sealed when it carries the marker, the older build's plaintext otherwise.
pub(crate) fn open_file(
    key: &CacheKey,
    purpose: Purpose,
    bytes: &[u8],
) -> Result<Opened<Vec<u8>>, SealError> {
    match bytes.strip_prefix(FILE_MAGIC.as_slice()) {
        Some(sealed) => open_raw(key, purpose, sealed).map(Opened::Sealed),
        None => Ok(Opened::Plaintext(bytes.to_vec())),
    }
}

/// Whether a whole file carries the sealed marker - asked WITHOUT a key, by a reader that only
/// needs to know whether there is plaintext left to seal.
#[cfg(any(mobile, test, feature = "bench-observables"))]
pub(crate) fn is_sealed_file(bytes: &[u8]) -> bool {
    bytes.starts_with(FILE_MAGIC)
}

/// Seals one NDJSON line. The result carries no newline. Only the native writers (JNI, FFI) seal a
/// line; Rust itself only takes them.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn seal_line(key: &CacheKey, purpose: Purpose, line: &str) -> String {
    format!(
        "{LINE_PREFIX}{}",
        STANDARD.encode(seal_raw(key, purpose, line.as_bytes()))
    )
}

/// Opens one NDJSON line: sealed when it carries the prefix, the older build's plaintext otherwise.
pub(crate) fn open_line(
    key: &CacheKey,
    purpose: Purpose,
    line: &str,
) -> Result<Opened<String>, SealError> {
    let Some(body) = line.strip_prefix(LINE_PREFIX) else {
        return Ok(Opened::Plaintext(line.to_string()));
    };
    let sealed = STANDARD
        .decode(body.trim())
        .map_err(|_| SealError::Malformed)?;
    let plain = open_raw(key, purpose, &sealed)?;
    String::from_utf8(plain)
        .map(Opened::Sealed)
        .map_err(|_| SealError::Malformed)
}

/// Decodes the base64 key a platform caller hands over. An empty string is `None`: the platform
/// could not read the key (absent on this install yet, or its store locked), which every caller
/// must treat as "do not write, do not read sealed" - never as a reason to write in the clear.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn decode_key(b64: &str) -> Result<Option<CacheKey>, String> {
    let b64 = b64.trim();
    if b64.is_empty() {
        return Ok(None);
    }
    mls_core::crypto::decode_base64_to_32_bytes(b64)
        .map(Some)
        .map_err(|e| format!("native cache key is not 32 base64 bytes: {e}"))
}

/// [`decode_key`] for a key a platform caller handed over (JNI, FFI): a key that is there but not
/// 32 bytes is logged as the defect it is and treated as absent - so nothing sealed is read and
/// nothing is written, never written in the clear.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn platform_key(b64: &str) -> Option<CacheKey> {
    match decode_key(b64) {
        Ok(Some(key)) => Some(key),
        Ok(None) => {
            log::warn!("[NATIVE_CACHE] no cache key handed over by the platform");
            None
        }
        Err(e) => {
            log::error!("[NATIVE_CACHE] {e}");
            None
        }
    }
}

/// Reads the install's cache key in the APP process, through the keystore plugin, with no prompt.
///
/// `Err` when it cannot be read - the native side creates it at process start, so its absence is a
/// failed creation (an iPhone whose Keychain refused, a process started before the first unlock)
/// and is reported as such. Never cached across calls: a wipe can delete it under a live process.
#[cfg(mobile)]
pub(crate) fn app_cache_key<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<CacheKey, String> {
    use mls_core::keystore::DeviceKeyStore;
    let keystore = crate::keystore_bridge::PluginDeviceKeyStore::new(app.clone()).unattended(true);
    keystore.retrieve_device_key(CACHE_KEY_ALIAS).ok_or_else(|| {
        log::error!("[NATIVE_CACHE] the install's cache key cannot be read - nothing sealed is read or written");
        "native cache key unavailable".to_string()
    })
}

/// Seals a seed mirror an older build left in the clear, under the writers' lock, and says whether
/// it did. Idempotent: a sealed mirror, or none, is left alone - the file's own marker is the
/// durable record of whether this has run, so a kill anywhere leaves either the plaintext file
/// (sealed next time) or the sealed one (the rename is atomic).
#[cfg(any(mobile, test))]
pub(crate) fn seal_legacy_seed_mirror(
    data_dir: &std::path::Path,
    key: &CacheKey,
) -> Result<bool, String> {
    let path = data_dir.join("graine_seeds.json");
    match std::fs::read(&path) {
        Ok(bytes) if is_sealed_file(&bytes) => return Ok(false),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read graine_seeds.json: {e}")),
    }
    // Through the one writer: it reads the plaintext under the lock and writes the map back sealed.
    let sealed = crate::commands::push::reseal_graine_mirror(data_dir, key)?;
    if sealed {
        log::info!(
            "[NATIVE_CACHE] the seed mirror an older build wrote in the clear is now sealed"
        );
    }
    Ok(sealed)
}

/// Seals or removes every plaintext file an older build left, once per process: the seed mirror in
/// `data_dir` and - on iOS - its App Group copy the notification extension reads, then
/// `channel_keys.json`. Each step is idempotent on its own (the file's marker, or its absence, is the
/// durable record), so the per-process flag only saves the reads; it is set after the pass, and a
/// step that failed is logged and retried by the next process.
#[cfg(mobile)]
pub(crate) fn migrate_legacy_files(data_dir: &std::path::Path, key: &CacheKey) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.load(Ordering::Acquire) {
        return;
    }
    log::debug!("[NATIVE_CACHE] legacy plaintext pass");
    // The notification extension's copy lives in the App Group container, on iOS only.
    #[cfg(target_os = "ios")]
    let group = crate::app_group::app_group_dir()
        .map_err(|e| log::error!("[NATIVE_CACHE] App Group copy not checked: {e}"))
        .ok();
    #[cfg(not(target_os = "ios"))]
    let group: Option<std::path::PathBuf> = None;
    let mut failed = false;
    for dir in std::iter::once(data_dir.to_path_buf()).chain(group) {
        if let Err(e) = seal_legacy_seed_mirror(&dir, key) {
            log::error!("[NATIVE_CACHE] a plaintext seed mirror was not sealed: {e}");
            failed = true;
        }
        remove_legacy_channel_keys(&dir);
    }
    if !failed {
        DONE.store(true, Ordering::Release);
    }
}

/// Removes `channel_keys.json`, the epoch-key mirror an older build wrote in the clear. Nothing has
/// read it since the Graine seed mirror replaced it, so there is nothing to seal: it is deleted.
#[cfg(any(mobile, test))]
pub(crate) fn remove_legacy_channel_keys(data_dir: &std::path::Path) -> bool {
    match std::fs::remove_file(data_dir.join("channel_keys.json")) {
        Ok(()) => {
            log::info!(
                "[NATIVE_CACHE] removed channel_keys.json, a plaintext mirror no reader uses"
            );
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            log::error!("[NATIVE_CACHE] channel_keys.json could not be removed: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: CacheKey = [7u8; 32];
    const OTHER: CacheKey = [9u8; 32];

    #[test]
    fn a_sealed_file_opens_under_its_key_and_purpose_only() {
        let sealed = seal_file(&K, Purpose::SeedMirror, br#"{"c":{}}"#);
        assert!(is_sealed_file(&sealed));
        assert!(!sealed.windows(4).any(|w| w == b"\"c\":"));
        assert_eq!(
            open_file(&K, Purpose::SeedMirror, &sealed).unwrap(),
            Opened::Sealed(br#"{"c":{}}"#.to_vec())
        );
        assert_eq!(
            open_file(&OTHER, Purpose::SeedMirror, &sealed),
            Err(SealError::Unopenable)
        );
        assert_eq!(
            open_file(&K, Purpose::PushCache, &sealed),
            Err(SealError::Unopenable)
        );
    }

    #[test]
    fn a_file_without_the_marker_is_the_older_builds_plaintext() {
        assert_eq!(
            open_file(&K, Purpose::SeedMirror, b"{}").unwrap(),
            Opened::Plaintext(b"{}".to_vec())
        );
        assert!(!is_sealed_file(b"{}"));
    }

    #[test]
    fn a_damaged_file_is_unopenable_never_plaintext() {
        let mut sealed = seal_file(&K, Purpose::SeedMirror, b"{}");
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert_eq!(
            open_file(&K, Purpose::SeedMirror, &sealed),
            Err(SealError::Unopenable)
        );
        assert_eq!(
            open_file(&K, Purpose::SeedMirror, FILE_MAGIC),
            Err(SealError::Malformed)
        );
    }

    #[test]
    fn a_sealed_line_hides_its_text_and_opens_back() {
        let line = seal_line(&K, Purpose::PushCache, r#"{"content":"bonjour"}"#);
        assert!(line.starts_with(LINE_PREFIX));
        assert!(!line.contains("bonjour") && !line.contains('\n'));
        assert_eq!(
            open_line(&K, Purpose::PushCache, &line).unwrap(),
            Opened::Sealed(r#"{"content":"bonjour"}"#.to_string())
        );
        assert_eq!(
            open_line(&OTHER, Purpose::PushCache, &line),
            Err(SealError::Unopenable)
        );
        assert_eq!(
            open_line(&K, Purpose::PushCache, "cs1:%%%"),
            Err(SealError::Malformed)
        );
        assert_eq!(
            open_line(&K, Purpose::PushCache, r#"{"a":1}"#).unwrap(),
            Opened::Plaintext(r#"{"a":1}"#.to_string())
        );
    }

    #[test]
    fn two_seals_of_one_value_differ() {
        assert_ne!(
            seal_line(&K, Purpose::PushCache, "x"),
            seal_line(&K, Purpose::PushCache, "x")
        );
    }

    #[test]
    fn an_empty_key_is_no_key_and_a_short_one_is_an_error() {
        assert_eq!(decode_key("").unwrap(), None);
        assert_eq!(decode_key(&STANDARD.encode(K)).unwrap(), Some(K));
        assert!(decode_key("AAAA").is_err());
        // What a platform hands over: a bad key is no key, never a reason to write in the clear.
        assert_eq!(platform_key(""), None);
        assert_eq!(platform_key("AAAA"), None);
        assert_eq!(platform_key(&STANDARD.encode(K)), Some(K));
    }

    /// The alias the native creators use; `nativeCacheSeal.test.ts` holds the other spellings.
    #[test]
    fn the_alias_is_the_one_the_platforms_spell() {
        assert_eq!(CACHE_KEY_ALIAS, "canari_native_cache_key");
    }

    #[test]
    fn the_legacy_epoch_mirror_is_removed_once() {
        let dir = std::env::temp_dir().join(format!("canari-nc-ck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("channel_keys.json"), b"{}").unwrap();
        assert!(remove_legacy_channel_keys(&dir));
        assert!(!remove_legacy_channel_keys(&dir));
        assert!(!dir.join("channel_keys.json").exists());
    }
}
