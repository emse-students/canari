//! The at-rest key held by the phone's secure hardware (user decision 2026-10-22).
//!
//! **WHAT CHANGES.** Until this module, the key sealing `mls.bin`, the local messages, the Graine
//! seeds and the outbox was DERIVED from the account PIN. On a phone it is now 32 RANDOM bytes,
//! generated here, kept only in the platform keystore entry the background push already reads
//! (Android Keystore / iOS Keychain `ThisDeviceOnly`), and handed to the WebView once the PIN has been
//! accepted. The PIN only unlocks; it derives nothing that opens local data any more.
//!
//! **THE MARKER IS THE ONE DURABLE FACT THE UNLOCK READS.** `at_rest_key.json`, beside `mls.bin`,
//! records which scheme seals this install's data and for which account:
//!
//! - absent (or another account's) - `pin-derived`: the pre-2026-10-22 install, or a fresh one;
//! - `migrating` - a re-key to a random key is under way; the stores sit under the old key, the new
//!   one, or both, and the login and the migration settle which (`hardwareKeyMigration.ts`);
//! - `hardware` - every store is sealed under the hardware-held key.
//!
//! It carries a KEY CHECK VALUE (`kcv`) of the hardware-held key, never the key: the keystore can
//! hold an older key (a legacy install's PIN-derived copy, a write a kill interrupted), and only the
//! kcv says whether the bytes read back ARE the key the marker names. A 256-bit random key cannot be
//! recovered from a 128-bit HKDF output of it.
//!
//! **AND IT IS WHAT KEEPS THE KEYSTORE FROM BEING OVERWRITTEN.** Every login's `store_push_context`
//! used to write the session key into the keystore. During a migration that session key is the OLD
//! one, and the write would replace the only copy of the new key while rows already sit under it.
//! [`keystore_write_allowed`] is the single gate both keystore writers ask.

use aes_gcm::aead::{KeyInit, OsRng};
use aes_gcm::Aes256Gcm;
use base64::Engine;
use hkdf::Hkdf;
use mls_core::DeviceKeyStore;
use sha2::Sha256;
use std::path::Path;
use tauri::Manager;

use crate::keystore_bridge::PluginDeviceKeyStore;

/// The marker file, beside `mls.bin` in the app data directory. Deleted with `mls.bin` by a reset
/// (`remove_mls_state_in`) and by the factory wipe (not in `KEPT_AT_TOP_LEVEL`).
pub(crate) const AT_REST_KEY_MARKER_FILE: &str = "at_rest_key.json";

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
    /// Base64 of the first 16 bytes of HKDF-SHA256(key, info = [`KCV_INFO`]).
    pub kcv: String,
}

/// What reading the marker found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MarkerRead {
    Absent,
    Present(Marker),
    /// The file exists and cannot be parsed. Never read as "absent": that would hand a login the
    /// PIN-derived key for data sealed under the hardware key, and the next migration would strand
    /// every row under a key no path asks for again.
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

/// Reads the marker in `data_dir`.
pub(crate) fn read_marker(data_dir: &Path) -> MarkerRead {
    let path = data_dir.join(AT_REST_KEY_MARKER_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MarkerRead::Absent,
        Err(e) => return MarkerRead::Unreadable(format!("read: {e}")),
    };
    match serde_json::from_str::<Marker>(&text) {
        Ok(m) if m.version == 1 => MarkerRead::Present(m),
        Ok(m) => MarkerRead::Unreadable(format!("version {}", m.version)),
        Err(e) => MarkerRead::Unreadable(format!("parse: {e}")),
    }
}

/// Writes `marker` durably: a synced temporary file, then a rename, so a reader sees the previous
/// marker or this one and a power loss cannot leave a torn one.
pub(crate) fn write_marker(data_dir: &Path, marker: &Marker) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let tmp = data_dir.join(format!("{AT_REST_KEY_MARKER_FILE}.tmp"));
    let body = serde_json::to_vec(marker).map_err(|e| e.to_string())?;
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create marker tmp: {e}"))?;
        f.write_all(&body)
            .map_err(|e| format!("write marker tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync marker tmp: {e}"))?;
    }
    std::fs::rename(&tmp, data_dir.join(AT_REST_KEY_MARKER_FILE))
        .map_err(|e| format!("rename marker: {e}"))?;
    Ok(())
}

/// The scheme of `user_id`'s data. Another account's marker is `PinDerived` for this one: `mls.bin`
/// is one file per install, and a marker naming someone else describes a state this account cannot
/// open anyway (the owner record and `device_holds_other_account` handle that case).
pub(crate) fn scheme_for(data_dir: &Path, user_id: &str) -> Scheme {
    match read_marker(data_dir) {
        MarkerRead::Absent => Scheme::PinDerived,
        MarkerRead::Present(m) if m.user_id != user_id => Scheme::PinDerived,
        MarkerRead::Present(m) => match m.scheme {
            MarkerScheme::Migrating => Scheme::Migrating,
            MarkerScheme::Hardware => Scheme::Hardware,
        },
        MarkerRead::Unreadable(why) => {
            log::error!(
                "[AT_REST_KEY] marker unreadable ({why}) - the unlock is refused, not guessed"
            );
            Scheme::Unreadable
        }
    }
}

/// Starts (or resumes) the re-key of `user_id`'s data to a hardware-held random key, and returns
/// that key.
///
/// RESUMED, never restarted, when the marker already says `migrating` for this account AND the
/// keystore holds the very key it names (kcv): rows may already sit under it, and a new key would
/// strand them. Any other keystore content (the legacy PIN-derived copy, nothing) means the key never
/// reached the keystore - the migration writes it there BEFORE it moves a single row - so nothing is
/// sealed under it and a fresh key is safe.
///
/// The marker is written `migrating` BEFORE the key is returned: from then on no other keystore
/// write may replace it ([`keystore_write_allowed`]).
pub(crate) fn prepare(
    data_dir: &Path,
    user_id: &str,
    keystore_read: impl FnOnce() -> Option<[u8; 32]>,
) -> Result<[u8; 32], String> {
    match read_marker(data_dir) {
        MarkerRead::Present(m) if m.user_id == user_id && m.scheme == MarkerScheme::Hardware => {
            return Err("already hardware-held - nothing to prepare".into());
        }
        MarkerRead::Present(m) if m.user_id == user_id && m.scheme == MarkerScheme::Migrating => {
            if let Some(key) = keystore_read() {
                if key_check_value(&key) == m.kcv {
                    log::info!(
                        "[AT_REST_KEY] migration resumed with the key already in the keystore"
                    );
                    return Ok(key);
                }
            }
            log::info!(
                "[AT_REST_KEY] marker says migrating but the keystore never received its key - a new key"
            );
        }
        MarkerRead::Unreadable(why) => {
            return Err(format!(
                "marker unreadable ({why}) - refusing to start a re-key"
            ));
        }
        _ => {}
    }
    let key = generate_data_key();
    write_marker(
        data_dir,
        &Marker {
            version: 1,
            scheme: MarkerScheme::Migrating,
            user_id: user_id.to_string(),
            kcv: key_check_value(&key),
        },
    )?;
    log::info!("[AT_REST_KEY] migration started: a random key generated, marker written");
    Ok(key)
}

/// Records that every store is sealed under `key`: `migrating` -> `hardware`, for this account and
/// this very key only. Idempotent on a marker already `hardware` with the same kcv.
pub(crate) fn mark_hardware(data_dir: &Path, user_id: &str, key: &[u8; 32]) -> Result<(), String> {
    let kcv = key_check_value(key);
    match read_marker(data_dir) {
        MarkerRead::Present(m) if m.user_id == user_id && m.kcv == kcv => {
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
        other => Err(format!(
            "refused: the marker does not name this account and key ({:?})",
            describe(&other)
        )),
    }
}

/// What reading the hardware-held key found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HardwareKeyRead {
    Key([u8; 32]),
    /// No marker of this account: the data is not (yet) under a hardware-held key.
    NotHardware,
    /// The marker names a key and the keystore holds nothing.
    Absent,
    /// The keystore holds a key that is not the one the marker names.
    Mismatch,
    /// The marker cannot be read.
    Unreadable,
}

/// Reads this account's hardware-held key, verified against the marker's kcv.
pub(crate) fn read_hardware_key(
    data_dir: &Path,
    user_id: &str,
    keystore_read: impl FnOnce() -> Option<[u8; 32]>,
) -> HardwareKeyRead {
    let marker = match read_marker(data_dir) {
        MarkerRead::Present(m) if m.user_id == user_id => m,
        MarkerRead::Unreadable(_) => return HardwareKeyRead::Unreadable,
        _ => return HardwareKeyRead::NotHardware,
    };
    match keystore_read() {
        None => HardwareKeyRead::Absent,
        Some(key) if key_check_value(&key) == marker.kcv => HardwareKeyRead::Key(key),
        Some(_) => HardwareKeyRead::Mismatch,
    }
}

/// Whether the keystore entry of `user_id` may be overwritten with `key`.
///
/// Allowed when no marker of this account exists (a legacy or desktop install: the keystore holds
/// the PIN-derived key, as before) and when `key` IS the key the marker names. Refused otherwise:
/// that entry is the only copy of the hardware-held key.
pub(crate) fn keystore_write_allowed(
    data_dir: &Path,
    user_id: &str,
    key: &[u8; 32],
) -> Result<(), String> {
    match read_marker(data_dir) {
        MarkerRead::Absent => Ok(()),
        MarkerRead::Present(m) if m.user_id != user_id => Ok(()),
        MarkerRead::Present(m) if m.kcv == key_check_value(key) => Ok(()),
        MarkerRead::Present(m) => Err(format!(
            "the keystore holds this account's hardware-held key ({:?}) - another key may not replace it",
            m.scheme
        )),
        MarkerRead::Unreadable(why) => Err(format!(
            "the at-rest marker is unreadable ({why}) - the keystore is not overwritten"
        )),
    }
}

fn describe(read: &MarkerRead) -> &'static str {
    match read {
        MarkerRead::Absent => "absent",
        MarkerRead::Present(_) => "another account or key",
        MarkerRead::Unreadable(_) => "unreadable",
    }
}

fn alias(user_id: &str, device_id: &str) -> String {
    format!("mls_device_key_{user_id}_{device_id}")
}

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Reads the keystore entry of this device with NO prompt - the read the background push makes.
fn unattended_read(app: &tauri::AppHandle, user_id: &str, device_id: &str) -> Option<[u8; 32]> {
    PluginDeviceKeyStore::new(app.clone())
        .unattended(true)
        .retrieve_device_key(&alias(user_id, device_id))
}

/// `pin-derived` | `migrating` | `hardware` | `unreadable` for `user_id` - see [`Scheme`].
#[tauri::command]
pub(crate) fn cle_au_repos_schema(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<String, String> {
    let scheme = scheme_for(&data_dir(&app)?, &user_id);
    log::debug!(
        "[AT_REST_KEY] scheme for {}: {}",
        short(&user_id),
        scheme.as_str()
    );
    Ok(scheme.as_str().to_string())
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
        let key = prepare(&dir, &user_id, || {
            unattended_read(&app, &user_id, &device_id)
        })?;
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
    mark_hardware(&data_dir(&app)?, &user_id, &key)
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
    device_id: String,
) -> Result<HardwareKeyAnswer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = data_dir(&app)?;
        let read = read_hardware_key(&dir, &user_id, || {
            unattended_read(&app, &user_id, &device_id)
        });
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

    fn dir() -> std::path::PathBuf {
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

    #[test]
    fn an_install_without_a_marker_is_pin_derived() {
        let d = dir();
        assert_eq!(scheme_for(&d, "alice"), Scheme::PinDerived);
        assert_eq!(
            read_hardware_key(&d, "alice", || None),
            HardwareKeyRead::NotHardware
        );
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
        let key = prepare(&d, "alice", || None).unwrap();
        assert_eq!(scheme_for(&d, "alice"), Scheme::Migrating);
        mark_hardware(&d, "alice", &key).unwrap();
        assert_eq!(scheme_for(&d, "alice"), Scheme::Hardware);
        // Idempotent.
        mark_hardware(&d, "alice", &key).unwrap();
        assert_eq!(
            read_hardware_key(&d, "alice", || Some(key)),
            HardwareKeyRead::Key(key)
        );
    }

    #[test]
    fn a_resumed_migration_keeps_the_key_the_keystore_already_holds() {
        let d = dir();
        let first = prepare(&d, "alice", || None).unwrap();
        // The migration wrote it into the keystore and was killed: the same key comes back.
        let resumed = prepare(&d, "alice", || Some(first)).unwrap();
        assert_eq!(resumed, first);
    }

    #[test]
    fn a_migration_whose_key_never_reached_the_keystore_takes_a_new_one() {
        let d = dir();
        let first = prepare(&d, "alice", || None).unwrap();
        let legacy_copy = [7u8; 32];
        let second = prepare(&d, "alice", || Some(legacy_copy)).unwrap();
        assert_ne!(second, first);
        assert_ne!(second, legacy_copy);
        mark_hardware(&d, "alice", &first).unwrap_err();
        mark_hardware(&d, "alice", &second).unwrap();
    }

    #[test]
    fn the_keystore_refuses_another_key_once_a_marker_names_one() {
        let d = dir();
        let legacy = [1u8; 32];
        keystore_write_allowed(&d, "alice", &legacy).unwrap();
        let key = prepare(&d, "alice", || None).unwrap();
        keystore_write_allowed(&d, "alice", &key).unwrap();
        keystore_write_allowed(&d, "alice", &legacy).unwrap_err();
        // Another account on the same install is not this marker's business.
        keystore_write_allowed(&d, "bob", &legacy).unwrap();
        mark_hardware(&d, "alice", &key).unwrap();
        keystore_write_allowed(&d, "alice", &legacy).unwrap_err();
    }

    #[test]
    fn a_read_checks_the_key_against_the_marker() {
        let d = dir();
        let key = prepare(&d, "alice", || None).unwrap();
        mark_hardware(&d, "alice", &key).unwrap();
        assert_eq!(
            read_hardware_key(&d, "alice", || None),
            HardwareKeyRead::Absent
        );
        assert_eq!(
            read_hardware_key(&d, "alice", || Some([9u8; 32])),
            HardwareKeyRead::Mismatch
        );
        assert_eq!(
            read_hardware_key(&d, "bob", || Some(key)),
            HardwareKeyRead::NotHardware
        );
    }

    #[test]
    fn an_unreadable_marker_is_never_read_as_absent() {
        let d = dir();
        std::fs::write(d.join(AT_REST_KEY_MARKER_FILE), b"{not json").unwrap();
        assert_eq!(scheme_for(&d, "alice"), Scheme::Unreadable);
        assert_eq!(
            read_hardware_key(&d, "alice", || None),
            HardwareKeyRead::Unreadable
        );
        prepare(&d, "alice", || None).unwrap_err();
        keystore_write_allowed(&d, "alice", &[1u8; 32]).unwrap_err();
    }

    #[test]
    fn prepare_refuses_an_install_already_hardware_held() {
        let d = dir();
        let key = prepare(&d, "alice", || None).unwrap();
        mark_hardware(&d, "alice", &key).unwrap();
        prepare(&d, "alice", || Some(key)).unwrap_err();
    }
}
