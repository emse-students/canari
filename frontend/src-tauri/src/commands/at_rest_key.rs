//! The at-rest key held by the phone's secure hardware (user decision 2026-10-22).
//!
//! **WHAT CHANGES.** Until this module, the key sealing `mls.bin`, the local messages, the Graine
//! seeds and the outbox was DERIVED from the account PIN. On a phone it is now 32 RANDOM bytes,
//! generated here, kept only in the platform keystore entry the background push already reads
//! (Android Keystore / iOS Keychain `ThisDeviceOnly`), and handed to the WebView once the PIN has been
//! accepted. The PIN only unlocks; it derives nothing that opens local data any more.
//!
//! **ONE MARKER PER ACCOUNT IS THE DURABLE FACT THE UNLOCK READS.** `at_rest_keys/<hex(userId)>.json`
//! in the app data directory records which scheme seals that account's data on this install:
//!
//! - absent - `pin-derived`: the pre-2026-10-22 install, or a fresh one;
//! - `migrating` - a re-key to a random key is under way. The key reached the keystore entry the
//!   marker names (`alias`) BEFORE a single row moved - a write is read back before it counts
//!   (`keystore_bridge.rs`) - so a `migrating` marker whose entry does not hold the key proves nothing
//!   moved, and is reverted ([`settle_scheme`]);
//! - `hardware` - every store is sealed under the hardware-held key.
//!
//! One file per account because accounts share an install: one marker for the install let a second
//! account's re-key overwrite the first one's, and with it the only record of which key seals that
//! account's surviving message database.
//!
//! It carries a KEY CHECK VALUE (`kcv`) of the hardware-held key, never the key: only the kcv says
//! whether the bytes in the keystore ARE the key the marker names. A 256-bit random key cannot be
//! recovered from a 128-bit HKDF output of it.
//!
//! **AND IT IS WHAT KEEPS THE KEYSTORE ENTRY ALIVE.** Once a marker exists, the entry is the ONLY copy
//! of the key. [`guard_write`] and [`guard_delete`] are the one rule every keystore mutation passes
//! (`PluginDeviceKeyStore`, the only writer; the plugin's write and delete are not reachable from the
//! WebView): no other key may replace it, and nothing deletes it. The one way out is the explicit
//! reset, which removes the marker ([`forget_marker`]) only after the data it guards is gone.

use aes_gcm::aead::{KeyInit, OsRng};
use aes_gcm::Aes256Gcm;
use base64::Engine;
use hkdf::Hkdf;
use sha2::Sha256;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::keystore_bridge::PluginDeviceKeyStore;

/// The directory holding one marker per account, in the app data directory. Removed whole by the
/// factory wipe (`clear_app_data`: not in `KEPT_AT_TOP_LEVEL`).
pub(crate) const AT_REST_KEY_MARKER_DIR: &str = "at_rest_keys";

/// The keystore alias of one device's key - the entry the background push reads.
///
/// NOT PARSEABLE BACK INTO ITS PARTS: a user id may contain `_` (`[A-Za-z0-9_.@-]`), and a device id
/// embeds the user id (`<platform>-<userId>-...`), so `mls_device_key_alice_x_...` may be account
/// `alice` or account `alice_x`. The guard therefore matches the EXACT alias a marker recorded.
pub(crate) fn device_key_alias(user_id: &str, device_id: &str) -> String {
    format!("mls_device_key_{user_id}_{device_id}")
}

/// ONE LOCK FOR THE MARKER AND THE KEYSTORE ENTRY IT GUARDS. Every read-modify of a marker
/// ([`settle_scheme`], [`prepare`], [`mark_hardware`], [`forget_marker`]) and every keystore
/// mutation with its guard verdict (`PluginDeviceKeyStore::store_guarded` / `delete_guarded`) runs
/// under it. Without it a settle could read a `migrating` marker in the instant between [`prepare`]
/// writing it and the key reaching the entry, and REVERT a re-key that was about to move rows.
static AT_REST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Takes [`AT_REST_LOCK`]. It guards an ORDER, not a value: a holder that panicked leaves the files
/// in a state every reader already handles, so a poisoned lock is taken as it is.
pub(crate) fn at_rest_guard() -> std::sync::MutexGuard<'static, ()> {
    AT_REST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Why the guard refused a keystore mutation - TYPED, so a caller tells a held key from a marker
/// it cannot read without reading prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GuardRefusal {
    /// A marker names this entry: it holds that account's hardware-held key.
    HeldKey(MarkerScheme),
    /// A marker cannot be listed or read. Which entry it guards is then unknown, so EVERY entry is
    /// refused until it is readable or reset - failing open would be the one way to lose a key.
    Unreadable(String),
}

impl std::fmt::Display for GuardRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardRefusal::HeldKey(scheme) => write!(
                f,
                "the entry holds a hardware-held key ({scheme:?}) - only the reset frees it"
            ),
            GuardRefusal::Unreadable(why) => write!(f, "an at-rest marker is unreadable ({why})"),
        }
    }
}

/// HKDF `info` for the key check value. Versioned: a change of derivation is a change of format.
const KCV_INFO: &[u8] = b"canari-at-rest-key-check-v1";

/// The two states a marker can record. `pin-derived` is the ABSENCE of a marker, never written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MarkerScheme {
    Migrating,
    Hardware,
}

/// The marker's content. `version` is 1; a reader refuses anything else as unreadable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Marker {
    pub version: u32,
    pub scheme: MarkerScheme,
    pub user_id: String,
    /// The keystore entry the key was written to. Read from here, never rebuilt from the current
    /// device id: a device identity rotated since keeps its data, and the key stays where it was put.
    pub alias: String,
    /// Base64 of the first 16 bytes of HKDF-SHA256(key, info = [`KCV_INFO`]).
    pub kcv: String,
}

/// What reading one account's marker found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MarkerRead {
    Absent,
    Present(Marker),
    /// The file exists and cannot be parsed, or names another account. Never read as "absent": that
    /// would hand a login the PIN-derived key for data sealed under the hardware key.
    Unreadable(String),
}

/// The scheme of `user_id`'s data on this install, as the frontend names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scheme {
    PinDerived,
    Migrating,
    Hardware,
    Unreadable,
}

impl Scheme {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Scheme::PinDerived => "pin-derived",
            Scheme::Migrating => "migrating",
            Scheme::Hardware => "hardware",
            Scheme::Unreadable => "unreadable",
        }
    }
}

/// An unattended read of one keystore entry: the key, nothing (`Ok(None)`), or a failure to read -
/// which is NOT "nothing" and is never treated as such.
pub(crate) type EntryRead = Result<Option<[u8; 32]>, String>;

/// The key check value of `key` - see the module doc for why it exists and why it leaks nothing.
pub(crate) fn key_check_value(key: &[u8; 32]) -> String {
    let hk = Hkdf::<Sha256>::new(None, key);
    let mut out = [0u8; 16];
    // 16 bytes is far below HKDF-SHA256's 8160-byte ceiling: `expand` cannot fail here.
    hk.expand(KCV_INFO, &mut out)
        .expect("HKDF-SHA256 expand of 16 bytes cannot exceed the output limit");
    base64::engine::general_purpose::STANDARD.encode(out)
}

/// 32 bytes from the operating system's CSPRNG.
pub(crate) fn generate_data_key() -> [u8; 32] {
    let key = Aes256Gcm::generate_key(&mut OsRng);
    let mut out = [0u8; 32];
    out.copy_from_slice(&key);
    out
}

fn hex_encode(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<String> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

fn marker_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(AT_REST_KEY_MARKER_DIR)
}

/// The marker file of `user_id`: the id hex-encoded, so no id can name a path outside the directory.
fn marker_path(data_dir: &Path, user_id: &str) -> PathBuf {
    marker_dir(data_dir).join(format!("{}.json", hex_encode(user_id)))
}

/// Reads `user_id`'s marker.
pub(crate) fn read_marker(data_dir: &Path, user_id: &str) -> MarkerRead {
    let text = match std::fs::read_to_string(marker_path(data_dir, user_id)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MarkerRead::Absent,
        Err(e) => return MarkerRead::Unreadable(format!("read: {e}")),
    };
    match serde_json::from_str::<Marker>(&text) {
        Ok(m) if m.version != 1 => MarkerRead::Unreadable(format!("version {}", m.version)),
        Ok(m) if m.user_id != user_id => MarkerRead::Unreadable("names another account".into()),
        Ok(m) => MarkerRead::Present(m),
        Err(e) => MarkerRead::Unreadable(format!("parse: {e}")),
    }
}

/// Records one durability step, for the tests that hold their ORDER (a power loss cannot be
/// simulated here, the order that makes it harmless can be checked). Nothing outside tests.
fn durability_step(what: &str) {
    #[cfg(test)]
    DURABILITY_STEPS.with(|s| s.borrow_mut().push(what.to_string()));
    let _ = what;
}

#[cfg(test)]
thread_local! {
    static DURABILITY_STEPS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Makes a rename, a creation or an unlink in `dir` durable by syncing the DIRECTORY itself.
///
/// WHY: POSIX makes a file's own bytes durable with its `fsync`, but the directory entry - which
/// name points at which file - only with an `fsync` of the directory. F2FS, the file system of most
/// Android phones, follows that strictly: after a power loss a rename that was never synced in its
/// directory can come back undone, which here would resurrect the PREVIOUS marker (a `migrating`
/// after the rows moved, or a marker the reset had removed). Windows has no directory handle to sync
/// and journals the metadata itself, so the call is a no-op there.
fn sync_dir(dir: &Path) -> Result<(), String> {
    durability_step("sync dir");
    #[cfg(unix)]
    std::fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| format!("sync dir {}: {e}", dir.display()))?;
    #[cfg(not(unix))]
    log::debug!(
        "[AT_REST_KEY] no directory sync on this platform: {}",
        dir.display()
    );
    Ok(())
}

/// The marker directory, created durably the first time: the new directory's own entry lives in
/// the data directory, which is synced for the same reason as a rename ([`sync_dir`]).
fn ensure_marker_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = marker_dir(data_dir);
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create marker dir: {e}"))?;
        durability_step("create dir");
        sync_dir(data_dir)?;
    }
    Ok(dir)
}

/// Writes `marker` durably: a synced temporary file, a rename, then a sync of the directory, so a
/// reader sees the previous marker or this one, and a power loss cannot bring the previous one back.
pub(crate) fn write_marker(data_dir: &Path, marker: &Marker) -> Result<(), String> {
    use std::io::Write;
    let dir = ensure_marker_dir(data_dir)?;
    let path = marker_path(data_dir, &marker.user_id);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec(marker).map_err(|e| e.to_string())?;
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create marker tmp: {e}"))?;
        f.write_all(&body)
            .map_err(|e| format!("write marker tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync marker tmp: {e}"))?;
        durability_step("sync tmp");
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename marker: {e}"))?;
    durability_step("rename");
    sync_dir(&dir)
}

/// Removes `user_id`'s marker - THE EXPLICIT RESET, and the only way the keystore entry stops being
/// guarded. Callers run it only once that account's local data is gone (`resetDeviceAsFreshImpl`,
/// the account deletion); the factory wipe removes the whole directory.
pub(crate) fn forget_marker(data_dir: &Path, user_id: &str) -> Result<(), String> {
    match std::fs::remove_file(marker_path(data_dir, user_id)) {
        Ok(()) => {
            durability_step("remove");
            sync_dir(&marker_dir(data_dir))?;
            log::info!("[AT_REST_KEY] marker removed - the keystore entry is no longer guarded");
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove marker: {e}")),
    }
}

/// The scheme of `user_id`'s data, SETTLED: a `migrating` marker whose entry does not hold its key
/// is reverted here, deterministically, before any caller acts on it.
///
/// Why reverting is safe: rows move only after the key was written AND read back from the entry the
/// marker names (`PluginDeviceKeyStore::store_guarded`), and once a marker exists nothing may replace
/// or delete that entry. So an entry that is empty, or holds another key, proves the re-key never
/// moved a row: the data is under the PIN-derived key, and saying `migrating` would only strand a PIN
/// recovery or restore (a marker restored onto a phone without its `ThisDeviceOnly` key). A read that
/// FAILS proves nothing, and answers `Unreadable` rather than guessing.
pub(crate) fn settle_scheme(
    data_dir: &Path,
    user_id: &str,
    read_entry: impl FnOnce(&str) -> EntryRead,
) -> Scheme {
    match read_marker(data_dir, user_id) {
        MarkerRead::Absent => Scheme::PinDerived,
        MarkerRead::Unreadable(why) => {
            log::error!(
                "[AT_REST_KEY] marker unreadable ({why}) - the unlock is refused, not guessed"
            );
            Scheme::Unreadable
        }
        MarkerRead::Present(m) if m.scheme == MarkerScheme::Hardware => Scheme::Hardware,
        MarkerRead::Present(m) => match read_entry(&m.alias) {
            Ok(Some(key)) if key_check_value(&key) == m.kcv => Scheme::Migrating,
            Ok(found) => {
                log::warn!(
                    "[AT_REST_KEY] migrating, and the entry {} its key - no row moved: marker reverted",
                    if found.is_some() { "holds another key than" } else { "does not hold" }
                );
                match forget_marker(data_dir, user_id) {
                    Ok(()) => Scheme::PinDerived,
                    Err(e) => {
                        log::error!("[AT_REST_KEY] the marker could not be reverted: {e}");
                        Scheme::Unreadable
                    }
                }
            }
            Err(e) => {
                log::error!("[AT_REST_KEY] migrating, and the keystore entry cannot be read: {e}");
                Scheme::Unreadable
            }
        },
    }
}

/// Starts (or resumes) the re-key of `user_id`'s data to a hardware-held random key, and returns
/// that key.
///
/// RESUMED, never restarted, when the marker already says `migrating` AND its entry holds the very
/// key it names (kcv): rows may already sit under it. Anything else means the key never reached the
/// keystore, nothing is sealed under it, and a fresh key is safe.
///
/// The marker is written `migrating`, naming `alias`, then the key is WRITTEN TO THAT ENTRY and read
/// back (`write_entry`), both before the key is returned - and the caller holds [`at_rest_guard`]
/// across the whole of it. So a `migrating` marker whose entry lacks its key is only ever seen after a
/// crash between the two writes, never by a concurrent [`settle_scheme`]: that one would revert it.
/// A failed `write_entry` leaves exactly that crash state, which the next settle reverts.
pub(crate) fn prepare(
    data_dir: &Path,
    user_id: &str,
    alias: &str,
    read_entry: impl FnOnce(&str) -> EntryRead,
    write_entry: impl FnOnce(&str, &[u8; 32]) -> Result<(), String>,
) -> Result<[u8; 32], String> {
    match read_marker(data_dir, user_id) {
        MarkerRead::Present(m) if m.scheme == MarkerScheme::Hardware => {
            return Err("already hardware-held - nothing to prepare".into());
        }
        MarkerRead::Present(m) => match read_entry(&m.alias) {
            Ok(Some(key)) if key_check_value(&key) == m.kcv => {
                log::info!("[AT_REST_KEY] migration resumed with the key already in the keystore");
                return Ok(key);
            }
            Ok(_) => log::info!(
                "[AT_REST_KEY] marker says migrating but the keystore never received its key - a new key"
            ),
            Err(e) => return Err(format!("the keystore entry cannot be read ({e}) - no re-key")),
        },
        MarkerRead::Unreadable(why) => {
            return Err(format!("marker unreadable ({why}) - refusing to start a re-key"));
        }
        MarkerRead::Absent => {}
    }
    let key = generate_data_key();
    write_marker(
        data_dir,
        &Marker {
            version: 1,
            scheme: MarkerScheme::Migrating,
            user_id: user_id.to_string(),
            alias: alias.to_string(),
            kcv: key_check_value(&key),
        },
    )?;
    durability_step("marker migrating");
    write_entry(alias, &key).map_err(|e| {
        log::error!("[AT_REST_KEY] the new key did not reach the keystore ({e}) - no row moves");
        format!("the new key did not reach the keystore: {e}")
    })?;
    durability_step("entry written");
    log::info!("[AT_REST_KEY] migration started: a random key generated, marker and entry written");
    Ok(key)
}

/// Records that every store is sealed under `key`: `migrating` -> `hardware`, for this account and
/// this very key only. Idempotent on a marker already `hardware` with the same kcv.
pub(crate) fn mark_hardware(data_dir: &Path, user_id: &str, key: &[u8; 32]) -> Result<(), String> {
    let kcv = key_check_value(key);
    match read_marker(data_dir, user_id) {
        MarkerRead::Present(m) if m.kcv == kcv => {
            if m.scheme == MarkerScheme::Hardware {
                return Ok(());
            }
            write_marker(
                data_dir,
                &Marker {
                    scheme: MarkerScheme::Hardware,
                    ..m
                },
            )?;
            log::info!("[AT_REST_KEY] migration complete - the at-rest key is hardware-held");
            Ok(())
        }
        MarkerRead::Present(_) => Err("refused: the marker names another key".into()),
        MarkerRead::Absent => Err("refused: no marker for this account".into()),
        MarkerRead::Unreadable(why) => Err(format!("refused: marker unreadable ({why})")),
    }
}

/// What reading the hardware-held key found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HardwareKeyRead {
    Key([u8; 32]),
    /// No marker of this account: the data is not (yet) under a hardware-held key.
    NotHardware,
    /// The marker names a key and its entry holds nothing.
    Absent,
    /// The entry holds a key that is not the one the marker names.
    Mismatch,
    /// The marker, or the entry, cannot be read.
    Unreadable,
}

/// Reads this account's hardware-held key from the entry its marker names, verified by the kcv.
pub(crate) fn read_hardware_key(
    data_dir: &Path,
    user_id: &str,
    read_entry: impl FnOnce(&str) -> EntryRead,
) -> HardwareKeyRead {
    let marker = match read_marker(data_dir, user_id) {
        MarkerRead::Present(m) => m,
        MarkerRead::Unreadable(_) => return HardwareKeyRead::Unreadable,
        MarkerRead::Absent => return HardwareKeyRead::NotHardware,
    };
    match read_entry(&marker.alias) {
        Ok(None) => HardwareKeyRead::Absent,
        Ok(Some(key)) if key_check_value(&key) == marker.kcv => HardwareKeyRead::Key(key),
        Ok(Some(_)) => HardwareKeyRead::Mismatch,
        Err(e) => {
            log::error!("[AT_REST_KEY] the hardware-held key's entry cannot be read: {e}");
            HardwareKeyRead::Unreadable
        }
    }
}

/// What the guard answers a write of one key into one keystore entry.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EntryWrite {
    /// No marker guards this entry: write it (a legacy or desktop install, or an account reset).
    Free,
    /// The key IS the one the marker names: write it only if the entry does not hold it already, so
    /// an unchanged entry is never rewritten (every login asks).
    KeepIfHeld,
    /// Another key, or a marker that cannot be read: the entry is the only copy of the key.
    Refused(GuardRefusal),
}

/// What the guard answers a delete of one keystore entry.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EntryDelete {
    Free,
    Refused(GuardRefusal),
}

/// The markers that guard `alias`: every readable marker whose recorded alias IS `alias` - the exact
/// string, never a prefix, since an alias cannot be split back into its account
/// ([`device_key_alias`]) - and every marker that cannot be read, because nothing then says which
/// entry it guards.
fn guarding_markers(data_dir: &Path, alias: &str) -> Result<Vec<MarkerRead>, String> {
    let entries = match std::fs::read_dir(marker_dir(data_dir)) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("list markers: {e}")),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("list markers: {e}"))?;
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
            continue;
        };
        let Some(user_id) = hex_decode(stem) else {
            continue;
        };
        match read_marker(data_dir, &user_id) {
            MarkerRead::Present(m) if m.alias == alias => out.push(MarkerRead::Present(m)),
            MarkerRead::Present(_) | MarkerRead::Absent => {}
            unreadable @ MarkerRead::Unreadable(_) => out.push(unreadable),
        }
    }
    Ok(out)
}

/// THE ONE RULE FOR A KEYSTORE WRITE - see the module doc. A marker that cannot be listed or read
/// refuses: failing open would be the one way to lose the key.
pub(crate) fn guard_write(data_dir: &Path, alias: &str, key: &[u8; 32]) -> EntryWrite {
    let markers = match guarding_markers(data_dir, alias) {
        Ok(m) => m,
        Err(e) => return EntryWrite::Refused(GuardRefusal::Unreadable(e)),
    };
    let kcv = key_check_value(key);
    let mut verdict = EntryWrite::Free;
    for marker in markers {
        match marker {
            MarkerRead::Absent => {}
            MarkerRead::Present(m) if m.kcv == kcv => verdict = EntryWrite::KeepIfHeld,
            MarkerRead::Present(m) => {
                return EntryWrite::Refused(GuardRefusal::HeldKey(m.scheme));
            }
            MarkerRead::Unreadable(why) => {
                return EntryWrite::Refused(GuardRefusal::Unreadable(why));
            }
        }
    }
    verdict
}

/// THE ONE RULE FOR A KEYSTORE DELETE: never an entry a marker names, and nothing while a marker
/// cannot be read.
pub(crate) fn guard_delete(data_dir: &Path, alias: &str) -> EntryDelete {
    match guarding_markers(data_dir, alias) {
        Err(e) => EntryDelete::Refused(GuardRefusal::Unreadable(e)),
        Ok(markers) => match markers.into_iter().next() {
            None | Some(MarkerRead::Absent) => EntryDelete::Free,
            Some(MarkerRead::Present(m)) => EntryDelete::Refused(GuardRefusal::HeldKey(m.scheme)),
            Some(MarkerRead::Unreadable(why)) => {
                EntryDelete::Refused(GuardRefusal::Unreadable(why))
            }
        },
    }
}

/// The keystore alias `user_id`'s marker recorded, if a readable marker exists - what the account
/// deletion must remove, which is not necessarily the alias built from today's device id.
pub(crate) fn recorded_alias(data_dir: &Path, user_id: &str) -> Option<String> {
    match read_marker(data_dir, user_id) {
        MarkerRead::Present(m) => Some(m.alias),
        MarkerRead::Absent | MarkerRead::Unreadable(_) => None,
    }
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Reads one keystore entry with NO prompt - the read the background push makes.
fn read_entry(app: &tauri::AppHandle, alias: &str) -> EntryRead {
    PluginDeviceKeyStore::new(app.clone()).read_unattended(alias)
}

/// `pin-derived` | `migrating` | `hardware` | `unreadable` for `user_id`, settled - see
/// [`settle_scheme`].
#[tauri::command]
pub(crate) async fn cle_au_repos_schema(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = at_rest_guard();
        let scheme = settle_scheme(&data_dir(&app)?, &user_id, |alias| read_entry(&app, alias));
        log::debug!(
            "[AT_REST_KEY] scheme for {}: {}",
            short(&user_id),
            scheme.as_str()
        );
        Ok(scheme.as_str().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts or resumes the re-key - see [`prepare`]. Returns the key as base64: the WebView needs it,
/// because it seals the message stores itself (`encryption.ts`).
#[tauri::command]
pub(crate) async fn cle_au_repos_preparer(
    app: tauri::AppHandle,
    user_id: String,
    device_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir(&app)?;
        let alias = device_key_alias(&user_id, &device_id);
        let store = PluginDeviceKeyStore::new(app.clone());
        let _lock = at_rest_guard();
        let key = prepare(
            &dir,
            &user_id,
            &alias,
            |a| read_entry(&app, a),
            // Already under the lock: the locked half of `store_guarded`, so the marker just written
            // decides the verdict (`KeepIfHeld` for this key) and the write is read back.
            |a, k| {
                store
                    .store_guarded_locked(k, a)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            },
        )?;
        Ok(base64::engine::general_purpose::STANDARD.encode(key))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Records the end of the re-key - see [`mark_hardware`].
#[tauri::command]
pub(crate) fn cle_au_repos_marquer(
    app: tauri::AppHandle,
    user_id: String,
    device_key_b64: String,
) -> Result<(), String> {
    let key = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
        .map_err(|e| format!("invalid device_key_b64: {e}"))?;
    let _lock = at_rest_guard();
    mark_hardware(&data_dir(&app)?, &user_id, &key)
}

/// The explicit reset of one account's guard - see [`forget_marker`]. Answers the keystore alias the
/// marker recorded (read under the same lock, before the removal), so the account deletion removes
/// the entry that holds the key rather than the one today's device id would name.
#[tauri::command]
pub(crate) fn cle_au_repos_oublier(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<Option<String>, String> {
    let dir = data_dir(&app)?;
    let _lock = at_rest_guard();
    let alias = recorded_alias(&dir, &user_id);
    forget_marker(&dir, &user_id)?;
    Ok(alias)
}

/// Deletes one keystore entry for the WebView, THROUGH THE GUARD. The plugin's own delete is not in
/// the WebView's permissions any more: every delete passes [`guard_delete`] here.
#[tauri::command]
pub(crate) async fn supprimer_cle_appareil(
    app: tauri::AppHandle,
    alias: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        PluginDeviceKeyStore::new(app)
            .delete_guarded(&alias)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The answer of [`cle_au_repos_lire`]: a status, and the key only for `key`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareKeyAnswer {
    status: &'static str,
    key_b64: Option<String>,
}

/// Reads this account's hardware-held key with no prompt, verified against the marker.
///
/// It returns the key WITHOUT a PIN, and that is no new door: `initialiser_mls` with
/// `unattendedKeyRead` already reads the same entry for the 12-hour biometric cadence, and the
/// background push reads it on every notification. The PIN gate stays where it was - the frontend
/// asks the server before it installs what this returns (`pinUnlock.ts`).
#[tauri::command]
pub(crate) async fn cle_au_repos_lire(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<HardwareKeyAnswer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir(&app)?;
        let _lock = at_rest_guard();
        let read = read_hardware_key(&dir, &user_id, |alias| read_entry(&app, alias));
        let (status, key_b64) = match read {
            HardwareKeyRead::Key(k) => (
                "key",
                Some(base64::engine::general_purpose::STANDARD.encode(k)),
            ),
            HardwareKeyRead::NotHardware => ("not-hardware", None),
            HardwareKeyRead::Absent => ("absent", None),
            HardwareKeyRead::Mismatch => ("mismatch", None),
            HardwareKeyRead::Unreadable => ("unreadable", None),
        };
        if key_b64.is_none() {
            log::warn!(
                "[AT_REST_KEY] hardware-held key read for {}: {status}",
                short(&user_id)
            );
        }
        Ok(HardwareKeyAnswer { status, key_b64 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The first 8 characters of an id, for a log line - never the whole id.
fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE_ENTRY: &str = "mls_device_key_alice_dev1";

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "canari-at-rest-{}-{}",
            std::process::id(),
            generate_data_key()[0..6]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn holds(key: [u8; 32]) -> impl FnOnce(&str) -> EntryRead {
        move |_| Ok(Some(key))
    }

    fn empty(_: &str) -> EntryRead {
        Ok(None)
    }

    fn written(_: &str, _: &[u8; 32]) -> Result<(), String> {
        Ok(())
    }

    /// A re-key that got its key into the keystore: prepared, written, read back.
    fn migrating(d: &Path) -> [u8; 32] {
        prepare(d, "alice", ALICE_ENTRY, empty, written).unwrap()
    }

    fn steps() -> Vec<String> {
        DURABILITY_STEPS.with(|s| std::mem::take(&mut *s.borrow_mut()))
    }

    /// The race of the re-review: a settle that read the marker between `prepare` writing it and the
    /// key reaching the entry reverted a re-key about to move rows. Under the one lock, the settle
    /// waits for `prepare` to finish and finds the entry holding the key.
    #[test]
    fn a_settle_during_a_re_key_waits_for_it_and_never_reverts() {
        use std::sync::{mpsc, Arc, Mutex};
        let d = dir();
        let entry: Arc<Mutex<Option<[u8; 32]>>> = Arc::new(Mutex::new(None));
        let (marker_written, wait_marker) = mpsc::channel();
        let (d1, e1) = (d.clone(), entry.clone());
        let re_key = std::thread::spawn(move || {
            let _lock = at_rest_guard();
            prepare(&d1, "alice", ALICE_ENTRY, empty, |_, k| {
                marker_written.send(()).unwrap();
                // Widen the window the race needed; correctness never depends on it.
                std::thread::sleep(std::time::Duration::from_millis(100));
                *e1.lock().unwrap() = Some(*k);
                Ok(())
            })
            .unwrap()
        });
        wait_marker.recv().unwrap();
        let scheme = {
            let _lock = at_rest_guard();
            settle_scheme(&d, "alice", |_| Ok(*entry.lock().unwrap()))
        };
        let key = re_key.join().unwrap();
        assert_eq!(scheme, Scheme::Migrating);
        assert_eq!(
            read_hardware_key(&d, "alice", holds(key)),
            HardwareKeyRead::Key(key)
        );
    }

    #[test]
    fn prepare_writes_the_marker_then_the_entry() {
        let d = dir();
        steps();
        migrating(&d);
        let order = steps();
        let marker = order.iter().position(|s| s == "marker migrating").unwrap();
        let entry = order.iter().position(|s| s == "entry written").unwrap();
        assert!(marker < entry, "{order:?}");
    }

    /// A key that did not reach the keystore leaves the crash state: nothing moved, the next settle
    /// reverts it.
    #[test]
    fn a_failed_entry_write_returns_an_error_and_the_marker_is_reverted_next() {
        let d = dir();
        prepare(&d, "alice", ALICE_ENTRY, empty, |_, _| {
            Err("keystore -25293".into())
        })
        .unwrap_err();
        assert_eq!(settle_scheme(&d, "alice", empty), Scheme::PinDerived);
    }

    #[test]
    fn a_marker_write_syncs_the_tmp_then_renames_then_syncs_the_directory() {
        let d = dir();
        steps();
        migrating(&d);
        let order = steps();
        let tail: Vec<&str> = order
            .iter()
            .map(String::as_str)
            .skip_while(|s| *s != "sync tmp")
            .take(3)
            .collect();
        assert_eq!(tail, ["sync tmp", "rename", "sync dir"]);
        // The first write created the directory, and synced its parent.
        let create = order.iter().position(|s| s == "create dir").unwrap();
        assert_eq!(order[create + 1], "sync dir");
    }

    #[test]
    fn a_removal_syncs_the_directory_after_it() {
        let d = dir();
        migrating(&d);
        steps();
        forget_marker(&d, "alice").unwrap();
        assert_eq!(steps(), ["remove", "sync dir"]);
    }

    /// Ids may contain `_`, so `mls_device_key_alice_x_dev1` may be account `alice_x`: only the exact
    /// alias a marker recorded is guarded.
    #[test]
    fn an_account_whose_id_extends_another_is_not_guarded_by_it() {
        let d = dir();
        let key = migrating(&d);
        mark_hardware(&d, "alice", &key).unwrap();
        let alice_x = device_key_alias("alice_x", "dev1");
        assert!(alice_x.starts_with("mls_device_key_alice_"));
        assert_eq!(guard_write(&d, &alice_x, &[1u8; 32]), EntryWrite::Free);
        assert_eq!(guard_delete(&d, &alice_x), EntryDelete::Free);
        assert_eq!(
            guard_write(&d, ALICE_ENTRY, &[1u8; 32]),
            EntryWrite::Refused(GuardRefusal::HeldKey(MarkerScheme::Hardware))
        );
    }

    #[test]
    fn the_reset_answers_the_alias_the_marker_recorded() {
        let d = dir();
        migrating(&d);
        assert_eq!(recorded_alias(&d, "alice").as_deref(), Some(ALICE_ENTRY));
        assert_eq!(recorded_alias(&d, "bob"), None);
    }

    #[test]
    fn an_install_without_a_marker_is_pin_derived_and_unguarded() {
        let d = dir();
        assert_eq!(settle_scheme(&d, "alice", empty), Scheme::PinDerived);
        assert_eq!(
            read_hardware_key(&d, "alice", empty),
            HardwareKeyRead::NotHardware
        );
        assert_eq!(guard_write(&d, ALICE_ENTRY, &[1u8; 32]), EntryWrite::Free);
        assert_eq!(guard_delete(&d, ALICE_ENTRY), EntryDelete::Free);
    }

    #[test]
    fn two_generated_keys_differ_and_the_kcv_is_not_the_key() {
        let a = generate_data_key();
        let b = generate_data_key();
        assert_ne!(a, b);
        let kcv = key_check_value(&a);
        assert_eq!(kcv, key_check_value(&a));
        assert_ne!(kcv, key_check_value(&b));
        assert!(!kcv.contains(&base64::engine::general_purpose::STANDARD.encode(a)));
    }

    #[test]
    fn prepare_writes_migrating_before_returning_and_mark_completes_it() {
        let d = dir();
        let key = migrating(&d);
        assert_eq!(settle_scheme(&d, "alice", holds(key)), Scheme::Migrating);
        mark_hardware(&d, "alice", &key).unwrap();
        assert_eq!(settle_scheme(&d, "alice", empty), Scheme::Hardware);
        mark_hardware(&d, "alice", &key).unwrap();
        assert_eq!(
            read_hardware_key(&d, "alice", holds(key)),
            HardwareKeyRead::Key(key)
        );
    }

    #[test]
    fn a_resumed_migration_keeps_the_key_the_keystore_already_holds() {
        let d = dir();
        let first = migrating(&d);
        let resumed = prepare(&d, "alice", ALICE_ENTRY, holds(first), |_, _| {
            panic!("a resumed re-key never rewrites the entry")
        })
        .unwrap();
        assert_eq!(resumed, first);
    }

    #[test]
    fn a_migration_whose_key_never_reached_the_keystore_takes_a_new_one() {
        let d = dir();
        let first = migrating(&d);
        let legacy_copy = [7u8; 32];
        let second = prepare(&d, "alice", ALICE_ENTRY, holds(legacy_copy), written).unwrap();
        assert_ne!(second, first);
        mark_hardware(&d, "alice", &first).unwrap_err();
        mark_hardware(&d, "alice", &second).unwrap();
    }

    /// The PIN-recovery dead end of the review, and a marker restored onto a phone without its
    /// `ThisDeviceOnly` key: `migrating` with nothing in the entry resolves to `pin-derived`.
    #[test]
    fn migrating_with_no_key_in_the_entry_is_reverted_deterministically() {
        let d = dir();
        migrating(&d);
        assert_eq!(settle_scheme(&d, "alice", empty), Scheme::PinDerived);
        assert_eq!(read_marker(&d, "alice"), MarkerRead::Absent);
        // The entry is unguarded again: the next login rewrites its PIN-derived key there.
        assert_eq!(guard_write(&d, ALICE_ENTRY, &[1u8; 32]), EntryWrite::Free);
    }

    #[test]
    fn migrating_with_another_key_in_the_entry_is_reverted_too() {
        let d = dir();
        migrating(&d);
        assert_eq!(
            settle_scheme(&d, "alice", holds([3u8; 32])),
            Scheme::PinDerived
        );
    }

    #[test]
    fn an_entry_that_cannot_be_read_never_reverts_a_marker() {
        let d = dir();
        migrating(&d);
        assert_eq!(
            settle_scheme(&d, "alice", |_| Err("keystore busy".into())),
            Scheme::Unreadable
        );
        assert!(matches!(read_marker(&d, "alice"), MarkerRead::Present(_)));
    }

    /// A marker restored onto a new phone whose keystore never held the key: a typed answer the
    /// login turns into `hardware_key_unavailable`, never a silent PIN-derived key.
    #[test]
    fn a_hardware_marker_without_its_key_reads_absent() {
        let d = dir();
        let key = migrating(&d);
        mark_hardware(&d, "alice", &key).unwrap();
        assert_eq!(
            read_hardware_key(&d, "alice", empty),
            HardwareKeyRead::Absent
        );
        assert_eq!(
            read_hardware_key(&d, "alice", holds([9u8; 32])),
            HardwareKeyRead::Mismatch
        );
        assert_eq!(
            read_hardware_key(&d, "bob", holds(key)),
            HardwareKeyRead::NotHardware
        );
    }

    #[test]
    fn the_key_is_read_from_the_entry_the_marker_names() {
        let d = dir();
        let key = migrating(&d);
        mark_hardware(&d, "alice", &key).unwrap();
        let asked = std::cell::RefCell::new(String::new());
        read_hardware_key(&d, "alice", |a| {
            *asked.borrow_mut() = a.to_string();
            Ok(Some(key))
        });
        assert_eq!(asked.into_inner(), ALICE_ENTRY);
    }

    /// Path: every login's `store_push_context`, and the keystore refresh, during and after a re-key.
    #[test]
    fn a_guarded_entry_takes_its_own_key_only() {
        let d = dir();
        let key = migrating(&d);
        assert_eq!(guard_write(&d, ALICE_ENTRY, &key), EntryWrite::KeepIfHeld);
        assert!(matches!(
            guard_write(&d, ALICE_ENTRY, &[1u8; 32]),
            EntryWrite::Refused(_)
        ));
        // Only the entry the marker recorded: a device identity rotated since writes a NEW alias,
        // which holds no key of record (the key stays where the marker says).
        assert_eq!(
            guard_write(&d, "mls_device_key_alice_dev2", &[1u8; 32]),
            EntryWrite::Free
        );
        mark_hardware(&d, "alice", &key).unwrap();
        assert!(matches!(
            guard_write(&d, ALICE_ENTRY, &[1u8; 32]),
            EntryWrite::Refused(_)
        ));
    }

    /// Paths: the biometric disable, the refused-write cleanup of a key change, the stale-key probe of
    /// a biometric init, the account wipe - none deletes a guarded entry.
    #[test]
    fn a_guarded_entry_is_never_deleted() {
        let d = dir();
        let key = migrating(&d);
        assert!(matches!(
            guard_delete(&d, ALICE_ENTRY),
            EntryDelete::Refused(_)
        ));
        mark_hardware(&d, "alice", &key).unwrap();
        assert!(matches!(
            guard_delete(&d, ALICE_ENTRY),
            EntryDelete::Refused(_)
        ));
    }

    /// Path: the explicit reset - the only one that frees the entry, and only by removing the marker.
    #[test]
    fn the_reset_frees_the_entry_by_removing_the_marker() {
        let d = dir();
        let key = migrating(&d);
        mark_hardware(&d, "alice", &key).unwrap();
        forget_marker(&d, "alice").unwrap();
        forget_marker(&d, "alice").unwrap();
        assert_eq!(guard_delete(&d, ALICE_ENTRY), EntryDelete::Free);
        assert_eq!(guard_write(&d, ALICE_ENTRY, &[1u8; 32]), EntryWrite::Free);
    }

    /// Several accounts on one install: each keeps its own marker and its own guard.
    #[test]
    fn a_second_account_never_touches_the_first_ones_marker() {
        let d = dir();
        let alice = migrating(&d);
        mark_hardware(&d, "alice", &alice).unwrap();
        let bob = prepare(&d, "bob", "mls_device_key_bob_dev9", empty, written).unwrap();
        mark_hardware(&d, "bob", &bob).unwrap();
        assert_eq!(
            read_hardware_key(&d, "alice", holds(alice)),
            HardwareKeyRead::Key(alice)
        );
        assert_eq!(
            read_hardware_key(&d, "bob", holds(bob)),
            HardwareKeyRead::Key(bob)
        );
        assert!(matches!(
            guard_write(&d, ALICE_ENTRY, &bob),
            EntryWrite::Refused(_)
        ));
        assert_eq!(
            guard_write(&d, "mls_device_key_bob_dev9", &bob),
            EntryWrite::KeepIfHeld
        );
    }

    #[test]
    fn an_unreadable_marker_guards_its_account_and_is_never_read_as_absent() {
        let d = dir();
        std::fs::create_dir_all(marker_dir(&d)).unwrap();
        std::fs::write(marker_path(&d, "alice"), b"{not json").unwrap();
        assert_eq!(settle_scheme(&d, "alice", empty), Scheme::Unreadable);
        assert_eq!(
            read_hardware_key(&d, "alice", empty),
            HardwareKeyRead::Unreadable
        );
        prepare(&d, "alice", ALICE_ENTRY, empty, written).unwrap_err();
        assert!(matches!(
            guard_write(&d, ALICE_ENTRY, &[1u8; 32]),
            EntryWrite::Refused(GuardRefusal::Unreadable(_))
        ));
        assert!(matches!(
            guard_delete(&d, ALICE_ENTRY),
            EntryDelete::Refused(GuardRefusal::Unreadable(_))
        ));
        // Which entry it guarded is unknown, so every entry is refused until it is reset.
        assert!(matches!(
            guard_write(&d, "mls_device_key_bob_dev9", &[1u8; 32]),
            EntryWrite::Refused(GuardRefusal::Unreadable(_))
        ));
    }

    #[test]
    fn prepare_refuses_an_install_already_hardware_held() {
        let d = dir();
        let key = migrating(&d);
        mark_hardware(&d, "alice", &key).unwrap();
        prepare(&d, "alice", ALICE_ENTRY, holds(key), written).unwrap_err();
    }

    #[test]
    fn a_user_id_cannot_name_a_path_outside_the_marker_directory() {
        let d = dir();
        assert_eq!(hex_decode(&hex_encode("../x")).as_deref(), Some("../x"));
        assert!(marker_path(&d, "../../etc").starts_with(marker_dir(&d)));
    }
}
