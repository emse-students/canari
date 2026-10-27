//! The native caches, sealed at rest: the Graine seed mirror (`graine_seeds.json`), the push
//! message cache (`fcm_message_cache*.ndjson`) and the push key-group join ledger
//! (`key_group_push_joins.json`, group ids and salon scopes - `mobile/key_group_join.rs`).
//!
//! **WHAT THESE FILES ARE.** Both exist so a phone can do something while the app is shut: the seed
//! mirror lets the notification service derive a salon message key, and the push cache carries the
//! messages it decrypted to the app's next start. Each therefore holds what the app's own stores
//! seal - key material and message text - in a file a background process must read, so both are
//! sealed at rest. A file in the older unsealed format is sealed the first time this build holds
//! the key ([`seal_legacy_seed_mirror`]).
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
    /// `key_group_push_joins.json`, sealed whole (`mobile/key_group_join.rs`, which exists only
    /// where a push service can join).
    #[cfg(any(target_os = "android", target_os = "ios", test))]
    KeyGroupJoinLedger,
}

impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Purpose::SeedMirror => b"canari/native-cache/v1/seed-mirror",
            Purpose::PushCache => b"canari/native-cache/v1/push-cache",
            #[cfg(any(target_os = "android", target_os = "ios", test))]
            Purpose::KeyGroupJoinLedger => b"canari/native-cache/v1/key-group-join-ledger",
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
///
/// Reported on the TRANSITION, not on every read: `take_fcm_cache` asks on a poll, and one fact
/// repeated every few seconds is a line its reader learns to skip ([`KeyPresence`]).
#[cfg(mobile)]
pub(crate) fn app_cache_key<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<CacheKey, String> {
    use mls_core::keystore::DeviceKeyStore;
    let keystore = crate::keystore_bridge::PluginDeviceKeyStore::new(app.clone()).unattended(true);
    let key = keystore.retrieve_device_key(CACHE_KEY_ALIAS);
    match APP_KEY_PRESENCE.observe(key.is_some()) {
        Some(false) => log::error!(
            "[NATIVE_CACHE] the install's cache key cannot be read - nothing sealed is read or \
             written until it can (said once, until it changes)"
        ),
        Some(true) => log::info!("[NATIVE_CACHE] the install's cache key is readable again"),
        None => {}
    }
    key.ok_or_else(|| "native cache key unavailable".to_string())
}

#[cfg(mobile)]
static APP_KEY_PRESENCE: KeyPresence = KeyPresence::new();

/// Whether the cache key was readable at the last read in this process, so that its absence is
/// logged when it BEGINS and its return when it ENDS - never once per poll. The first read that
/// finds no key is a transition (from "not yet asked"); the first that finds one is not.
#[cfg(any(mobile, test))]
pub(crate) struct KeyPresence(std::sync::atomic::AtomicU8);

#[cfg(any(mobile, test))]
impl KeyPresence {
    const UNKNOWN: u8 = 0;
    const PRESENT: u8 = 1;
    const ABSENT: u8 = 2;

    pub(crate) const fn new() -> Self {
        Self(std::sync::atomic::AtomicU8::new(Self::UNKNOWN))
    }

    /// Records one read, and returns `Some(present)` when it CHANGED what the last one found and
    /// is worth a line: an absence after anything else, a presence after an absence.
    pub(crate) fn observe(&self, present: bool) -> Option<bool> {
        let now = if present { Self::PRESENT } else { Self::ABSENT };
        let before = self.0.swap(now, std::sync::atomic::Ordering::AcqRel);
        match (before, present) {
            (b, false) if b != Self::ABSENT => Some(false),
            (Self::ABSENT, true) => Some(true),
            _ => None,
        }
    }
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

/// Keeps one native cache file out of iCloud and computer backups (iOS); nothing anywhere else -
/// Android excludes its whole data domain in `data_extraction_rules.xml`, desktop writes no cache.
///
/// Per FILE and after EVERY write: the writers replace the file by an atomic rename, a new inode,
/// and the flag does not travel with the name. Never the directory: it also holds `mls.bin` and the
/// identity files, which a restore must bring back (the ObjC twin,
/// `CanariExcludeNativeCacheFilesFromBackup`, says why). A failure is logged and changes nothing
/// else: the file is sealed whichever way, so a backup of it carries ciphertext under a key that
/// does not travel.
pub(crate) fn exclude_from_backup(path: &std::path::Path) {
    #[cfg(target_os = "ios")]
    if let Err(e) = ios_exclude_from_backup(path) {
        log::error!(
            "[NATIVE_CACHE] {} not excluded from backups: {e}",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
    }
    #[cfg(not(target_os = "ios"))]
    let _ = path;
}

/// `[[NSURL fileURLWithPath:path] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey]`,
/// through the Objective-C runtime like `app_group::app_group_dir` and for its reason: `libapp.a`
/// is linked into the notification extension too, so a function of ours in `canari_push.mm` would
/// leave the extension's link with an undefined symbol. Foundation is linked into both.
#[cfg(target_os = "ios")]
fn ios_exclude_from_backup(path: &std::path::Path) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        static NSURLIsExcludedFromBackupKey: *const AnyObject;
    }

    let c_path = std::ffi::CString::new(path.to_string_lossy().into_owned())
        .map_err(|e| format!("path has a NUL byte: {e}"))?;
    objc2::rc::autoreleasepool(|_| {
        let str_class = AnyClass::get(c"NSString").ok_or("NSString is not loaded")?;
        let url_class = AnyClass::get(c"NSURL").ok_or("NSURL is not loaded")?;
        let num_class = AnyClass::get(c"NSNumber").ok_or("NSNumber is not loaded")?;
        // SAFETY: plain Foundation messages with the argument and return types their headers
        // declare; every object returned is autoreleased into the pool around this block, and the
        // key is a Foundation constant that lives as long as the process.
        unsafe {
            let ns_path: *mut AnyObject =
                msg_send![str_class, stringWithUTF8String: c_path.as_ptr()];
            if ns_path.is_null() {
                return Err("path is not UTF-8".to_string());
            }
            let url: *mut AnyObject = msg_send![url_class, fileURLWithPath: ns_path];
            let yes: *mut AnyObject = msg_send![num_class, numberWithBool: Bool::YES];
            let no_error: *mut *mut AnyObject = std::ptr::null_mut();
            let ok: Bool = msg_send![
                url,
                setResourceValue: yes,
                forKey: NSURLIsExcludedFromBackupKey,
                error: no_error
            ];
            if ok.as_bool() {
                Ok(())
            } else {
                Err("setResourceValue refused".to_string())
            }
        }
    })
}

/// Gives `path` the iOS Data Protection class `Complete` (`NSFileProtectionComplete`): its key is
/// discarded while the device is locked, so the file reads only once the member has unlocked it.
/// For what waits for the member and nothing background reads - a share waiting for its
/// destination (`app_group_share`). NEVER for a file the notification extension reads while the
/// phone is locked (the caches above keep `CompleteUntilFirstUserAuthentication`). A no-op off iOS:
/// Android's app storage is credential-encrypted already (`docs/wiki/frontend/sharing.md`).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn protect_until_unlocked(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    return ios_file_protection(path, IosProtection::Set);
    #[cfg(not(target_os = "ios"))]
    {
        let _ = path;
        Ok(())
    }
}

/// The Data Protection class `path` holds (`NSFileProtectionComplete`, ...), for a log line that
/// READS what a rename kept rather than assuming it. `None` off iOS.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn file_protection(path: &std::path::Path) -> Option<String> {
    #[cfg(target_os = "ios")]
    return ios_file_protection(path, IosProtection::Get)
        .inspect_err(|e| log::warn!("[NATIVE_CACHE] protection class unreadable: {e}"))
        .ok();
    #[cfg(not(target_os = "ios"))]
    {
        let _ = path;
        None
    }
}

#[cfg(target_os = "ios")]
enum IosProtection {
    Set,
    Get,
}

/// `-[NSFileManager setAttributes:@{NSFileProtectionKey: NSFileProtectionComplete} ofItemAtPath:]`
/// or `attributesOfItemAtPath:[NSFileProtectionKey]`, through the Objective-C runtime for the reason
/// [`ios_exclude_from_backup`] gives. `Set` answers `Ok("")`, `Get` the class name.
#[cfg(target_os = "ios")]
fn ios_file_protection(path: &std::path::Path, op: IosProtection) -> Result<String, String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        static NSFileProtectionKey: *const AnyObject;
        static NSFileProtectionComplete: *const AnyObject;
    }

    let c_path = std::ffi::CString::new(path.to_string_lossy().into_owned())
        .map_err(|e| format!("path has a NUL byte: {e}"))?;
    objc2::rc::autoreleasepool(|_| {
        let str_class = AnyClass::get(c"NSString").ok_or("NSString is not loaded")?;
        let fm_class = AnyClass::get(c"NSFileManager").ok_or("NSFileManager is not loaded")?;
        let dict_class = AnyClass::get(c"NSDictionary").ok_or("NSDictionary is not loaded")?;
        // SAFETY: plain Foundation messages with the argument and return types their headers
        // declare; every object returned is autoreleased into the pool around this block, and the
        // keys are Foundation constants that live as long as the process.
        unsafe {
            let ns_path: *mut AnyObject =
                msg_send![str_class, stringWithUTF8String: c_path.as_ptr()];
            if ns_path.is_null() {
                return Err("path is not UTF-8".to_string());
            }
            let manager: *mut AnyObject = msg_send![fm_class, defaultManager];
            let no_error: *mut *mut AnyObject = std::ptr::null_mut();
            match op {
                IosProtection::Set => {
                    let attributes: *mut AnyObject = msg_send![
                        dict_class,
                        dictionaryWithObject: NSFileProtectionComplete,
                        forKey: NSFileProtectionKey
                    ];
                    let ok: Bool = msg_send![
                        manager,
                        setAttributes: attributes,
                        ofItemAtPath: ns_path,
                        error: no_error
                    ];
                    if ok.as_bool() {
                        Ok(String::new())
                    } else {
                        Err("setAttributes refused".to_string())
                    }
                }
                IosProtection::Get => {
                    let attributes: *mut AnyObject =
                        msg_send![manager, attributesOfItemAtPath: ns_path, error: no_error];
                    if attributes.is_null() {
                        return Err("attributesOfItemAtPath refused".to_string());
                    }
                    let class: *mut AnyObject =
                        msg_send![attributes, objectForKey: NSFileProtectionKey];
                    if class.is_null() {
                        return Ok("none".to_string());
                    }
                    let utf8: *const std::os::raw::c_char = msg_send![class, UTF8String];
                    if utf8.is_null() {
                        return Err("the class name is not UTF-8".to_string());
                    }
                    Ok(std::ffi::CStr::from_ptr(utf8)
                        .to_string_lossy()
                        .into_owned())
                }
            }
        }
    })
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
    /// A key that stays absent across a poll is said ONCE, and again only after it came back.
    #[test]
    fn a_missing_key_is_logged_on_the_transition_not_on_every_poll() {
        let presence = KeyPresence::new();
        assert_eq!(presence.observe(false), Some(false));
        assert_eq!(presence.observe(false), None);
        assert_eq!(presence.observe(false), None);
        assert_eq!(presence.observe(true), Some(true));
        assert_eq!(presence.observe(true), None);
        assert_eq!(presence.observe(false), Some(false));

        let healthy = KeyPresence::new();
        assert_eq!(healthy.observe(true), None);
        assert_eq!(healthy.observe(true), None);
    }

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
