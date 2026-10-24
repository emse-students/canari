//! Rust bridge to the native keystore (Android KeyStore / iOS Keychain).
//!
//! Implements [`mls_core::keystore::DeviceKeyStore`] by delegating to the
//! Tauri keystore plugin, which in turn calls the native Kotlin/Swift
//! implementations. On desktop, the plugin falls back to the OS keyring
//! (keyring crate).

use base64::Engine;
use mls_core::keystore::DeviceKeyStore;
use tauri::Runtime;
use tauri_plugin_keystore::{BiometricPromptText, KeystoreExt};

/// Implements `DeviceKeyStore` for mobile and desktop by delegating to the
/// Tauri keystore plugin.
///
/// The `AppHandle` is stored internally so the bridge can be used from any
/// thread (it is `Send + Sync`).
pub struct PluginDeviceKeyStore<R: Runtime> {
    app: tauri::AppHandle<R>,
    /// Text for the biometric sheet that reading the key raises. Only `retrieve_device_key`
    /// prompts, so the two store-only call sites leave this empty and the native fallback applies.
    prompt: BiometricPromptText,
    /// When set, `retrieve_device_key` reads with NO biometric sheet (the "every 12h" cadence).
    unattended: bool,
}

impl<R: Runtime> PluginDeviceKeyStore<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self {
            app,
            prompt: BiometricPromptText::default(),
            unattended: false,
        }
    }

    /// Makes [`DeviceKeyStore::retrieve_device_key`] skip the biometric sheet.
    ///
    /// The frontend decides this, from the unlock cadence the user picked and the time of the last
    /// PROMPTED unlock - this process has neither. On iOS it also changes WHICH item is read: the
    /// `.userPresence` one cannot be read without a sheet, so the background copy is used instead.
    pub fn unattended(mut self, unattended: bool) -> Self {
        self.unattended = unattended;
        self
    }

    /// Attaches the localized text used by [`DeviceKeyStore::retrieve_device_key`].
    ///
    /// The frontend owns the locale, so the strings travel down with the call that needs them
    /// rather than being resolved here - nothing in this process knows which language to pick.
    pub fn with_prompt(mut self, prompt: BiometricPromptText) -> Self {
        self.prompt = prompt;
        self
    }
}

/// What a guarded write did.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyEntryWrite {
    /// The entry now holds the key, read back.
    Written,
    /// The entry already held this key, guarded: nothing was rewritten.
    AlreadyHeld,
}

/// Why a guarded keystore mutation did not happen - TYPED, so a caller tells the guard's answer from
/// a platform failure without reading prose.
#[derive(Debug)]
pub enum KeyEntryError {
    /// The at-rest guard refused: the entry is the only copy of a hardware-held key, or a marker
    /// cannot be read (`at_rest_key::guard_write` / `guard_delete`).
    Refused(crate::commands::at_rest_key::GuardRefusal),
    /// The platform keystore failed, or the key read back is not the key written.
    Failed(String),
}

impl std::fmt::Display for KeyEntryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyEntryError::Refused(why) => write!(f, "refused by the at-rest guard: {why}"),
            KeyEntryError::Failed(why) => write!(f, "keystore failure: {why}"),
        }
    }
}

/// The order of a guarded write, apart from the platform so it is tested: the guard's verdict, the
/// skip of an entry already holding its key, the write, and the read-back that makes "written" true.
fn run_guarded_store(
    verdict: crate::commands::at_rest_key::EntryWrite,
    key: &[u8; 32],
    read: impl Fn() -> Result<Option<[u8; 32]>, String>,
    write: impl FnOnce() -> Result<(), String>,
) -> Result<KeyEntryWrite, KeyEntryError> {
    use crate::commands::at_rest_key::EntryWrite;
    match verdict {
        EntryWrite::Refused(why) => {
            log::info!("[KEYSTORE] write refused by the at-rest guard: {why}");
            return Err(KeyEntryError::Refused(why));
        }
        EntryWrite::KeepIfHeld => {
            if read().map_err(KeyEntryError::Failed)? == Some(*key) {
                log::debug!("[KEYSTORE] the guarded entry already holds this key - not rewritten");
                return Ok(KeyEntryWrite::AlreadyHeld);
            }
            log::info!("[KEYSTORE] the guarded entry does not hold its key yet - writing it");
        }
        EntryWrite::Free => {}
    }
    write().map_err(KeyEntryError::Failed)?;
    match read() {
        Ok(Some(back)) if back == *key => Ok(KeyEntryWrite::Written),
        Ok(other) => {
            log::error!(
                "[KEYSTORE] the key read back is not the key written ({})",
                if other.is_some() {
                    "another key"
                } else {
                    "nothing"
                }
            );
            Err(KeyEntryError::Failed(
                "the key read back is not the key written".into(),
            ))
        }
        Err(e) => {
            log::error!("[KEYSTORE] the key written cannot be read back: {e}");
            Err(KeyEntryError::Failed(format!("read back: {e}")))
        }
    }
}

/// What one unattended plugin read MEANS for the at-rest key. ONLY a resolved `keyBytes: null` is
/// "absent" (`Ok(None)`) - the plugin answers that for `errSecItemNotFound` / no stored entry alone.
/// A rejected call (a locked keychain, an entitlement error, a decrypt failure) stays an `Err`, and
/// so does an entry that is not 32 base64 bytes: `settle_scheme`, `prepare` and the guarded write
/// revert a marker or write a new key on "absent", so a failure read as absent would destroy the
/// only copy of a hardware-held key.
fn unattended_read_outcome(
    plugin: Result<Option<String>, String>,
) -> Result<Option<[u8; 32]>, String> {
    let Some(b64) = plugin.map_err(|e| {
        log::error!("[KEYSTORE] unattended read failed (not 'absent'): {e}");
        e
    })?
    else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("entry is not base64: {e}"))?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|b: Vec<u8>| format!("entry holds {} bytes, not 32", b.len()))?;
    Ok(Some(key))
}

impl<R: Runtime> PluginDeviceKeyStore<R> {
    fn data_dir(&self) -> Result<std::path::PathBuf, KeyEntryError> {
        tauri::Manager::path(&self.app)
            .app_data_dir()
            .map_err(|e| KeyEntryError::Failed(format!("app data dir: {e}")))
    }

    /// Reads one entry with NO biometric sheet, telling "nothing there" (`Ok(None)`) from "could not
    /// read" (`Err`) - the difference `at_rest_key::settle_scheme` stands on.
    pub fn read_unattended(&self, alias: &str) -> Result<Option<[u8; 32]>, String> {
        unattended_read_outcome(
            self.app
                .keystore()
                .get_key_bytes_unattended(tauri_plugin_keystore::GetKeyBytesUnattendedRequest {
                    alias: alias.to_string(),
                })
                .map(|resp| resp.key_bytes)
                .map_err(|e| e.to_string()),
        )
    }

    /// THE ONE KEYSTORE WRITE. Asks the at-rest guard first: a guarded entry takes only the key its
    /// marker names, and is not rewritten when it holds it already (every login asks, and an
    /// unchanged entry must not be put at risk for nothing). Every write is then READ BACK: a key
    /// change moves rows only after this returns, so "written" must mean "there". The verdict and
    /// the write run under the at-rest lock (`at_rest_key::at_rest_guard`), so no marker changes
    /// between them.
    pub fn store_guarded(
        &self,
        key: &[u8; 32],
        alias: &str,
    ) -> Result<KeyEntryWrite, KeyEntryError> {
        let _lock = crate::commands::at_rest_key::at_rest_guard();
        self.store_guarded_locked(key, alias)
    }

    /// [`Self::store_guarded`] for a caller ALREADY holding the at-rest lock - `at_rest_key::prepare`,
    /// which writes the marker and then the entry in one locked step. Never call it without the lock.
    pub(crate) fn store_guarded_locked(
        &self,
        key: &[u8; 32],
        alias: &str,
    ) -> Result<KeyEntryWrite, KeyEntryError> {
        let verdict = crate::commands::at_rest_key::guard_write(&self.data_dir()?, alias, key);
        run_guarded_store(
            verdict,
            key,
            || self.read_unattended(alias),
            || {
                self.app
                    .keystore()
                    .store_key_bytes(tauri_plugin_keystore::StoreKeyBytesRequest {
                        alias: alias.to_string(),
                        key_bytes: base64::engine::general_purpose::STANDARD.encode(key),
                    })
                    .map_err(|e| e.to_string())
            },
        )
    }

    /// THE ONE KEYSTORE DELETE, refused by the at-rest guard while a marker of the entry's account
    /// exists - whichever caller asks (the biometric toggle, a key change's cleanup, the stale-key
    /// probe of a biometric init, a wipe that ran before its marker was removed).
    pub fn delete_guarded(&self, alias: &str) -> Result<(), KeyEntryError> {
        use crate::commands::at_rest_key::{at_rest_guard, guard_delete, EntryDelete};
        let _lock = at_rest_guard();
        if let EntryDelete::Refused(why) = guard_delete(&self.data_dir()?, alias) {
            log::warn!("[KEYSTORE] delete refused by the at-rest guard: {why}");
            return Err(KeyEntryError::Refused(why));
        }
        self.app
            .keystore()
            .delete_key_bytes(tauri_plugin_keystore::DeleteKeyBytesRequest {
                alias: alias.to_string(),
            })
            .map_err(|e| KeyEntryError::Failed(e.to_string()))
    }
}

impl<R: Runtime> DeviceKeyStore for PluginDeviceKeyStore<R> {
    /// Through [`PluginDeviceKeyStore::store_guarded`]: no write reaches the plugin unguarded.
    fn store_device_key(&self, key: &[u8; 32], alias: &str) -> Result<(), String> {
        self.store_guarded(key, alias)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn retrieve_device_key(&self, alias: &str) -> Option<[u8; 32]> {
        let keystore = self.app.keystore();
        let read = if self.unattended {
            log::debug!("[KEYSTORE] retrieve_device_key: unattended read (no biometric sheet)");
            keystore.get_key_bytes_unattended(tauri_plugin_keystore::GetKeyBytesUnattendedRequest {
                alias: alias.to_string(),
            })
        } else {
            keystore.get_key_bytes(tauri_plugin_keystore::GetKeyBytesRequest {
                alias: alias.to_string(),
                prompt: self.prompt.clone(),
            })
        };
        let resp = read
            // Info, not warn: a user cancelling the sheet lands here too, and that is not a defect.
            .map_err(|e| {
                log::info!(
                    "[KEYSTORE] retrieve_device_key refused (unattended={}): {e}",
                    self.unattended
                )
            })
            .ok()?;

        let b64 = resp.key_bytes?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .ok()?;

        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Some(key)
        } else {
            None
        }
    }

    /// Through [`PluginDeviceKeyStore::delete_guarded`]: no delete reaches the plugin unguarded.
    fn delete_device_key(&self, alias: &str) -> Result<(), String> {
        self.delete_guarded(alias).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::at_rest_key::EntryWrite;
    use std::cell::{Cell, RefCell};

    const K: [u8; 32] = [5u8; 32];

    /// A failed keychain read (iOS `errSecInteractionNotAllowed`, `-34018`; an Android decrypt
    /// failure) reaches Rust as a rejected call, and must stay an error: read as "absent" it would
    /// revert a migrating marker or let a new key overwrite the only copy of the old one.
    #[test]
    fn only_a_resolved_null_is_absent_and_a_failed_read_stays_an_error() {
        use base64::Engine as _;
        assert_eq!(unattended_read_outcome(Ok(None)), Ok(None));
        let b64 = base64::engine::general_purpose::STANDARD.encode(K);
        assert_eq!(unattended_read_outcome(Ok(Some(b64))), Ok(Some(K)));
        assert!(unattended_read_outcome(Err("OSStatus -25308".into())).is_err());
        assert!(unattended_read_outcome(Ok(Some("not base64!".into()))).is_err());
        let short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        assert!(unattended_read_outcome(Ok(Some(short))).is_err());
    }

    /// An entry in memory, counting writes.
    struct Entry {
        held: RefCell<Option<[u8; 32]>>,
        writes: Cell<u32>,
    }

    impl Entry {
        fn holding(k: Option<[u8; 32]>) -> Self {
            Entry {
                held: RefCell::new(k),
                writes: Cell::new(0),
            }
        }
        fn store(&self, v: EntryWrite) -> Result<KeyEntryWrite, KeyEntryError> {
            run_guarded_store(
                v,
                &K,
                || Ok(*self.held.borrow()),
                || {
                    self.writes.set(self.writes.get() + 1);
                    *self.held.borrow_mut() = Some(K);
                    Ok(())
                },
            )
        }
    }

    /// Path: every login's `store_push_context` on a migrated phone - the entry is never rewritten.
    #[test]
    fn a_guarded_entry_holding_its_key_is_not_rewritten() {
        let e = Entry::holding(Some(K));
        assert_eq!(
            e.store(EntryWrite::KeepIfHeld).unwrap(),
            KeyEntryWrite::AlreadyHeld
        );
        assert_eq!(e.writes.get(), 0);
    }

    /// Path: the re-key's `pointUnattendedUnlockAt` - written once, then read back.
    #[test]
    fn a_guarded_entry_still_holding_the_old_key_takes_the_new_one() {
        let e = Entry::holding(Some([1u8; 32]));
        assert_eq!(
            e.store(EntryWrite::KeepIfHeld).unwrap(),
            KeyEntryWrite::Written
        );
        assert_eq!(e.writes.get(), 1);
    }

    #[test]
    fn a_refused_write_never_reaches_the_platform() {
        let e = Entry::holding(Some([1u8; 32]));
        use crate::commands::at_rest_key::{GuardRefusal, MarkerScheme};
        assert!(matches!(
            e.store(EntryWrite::Refused(GuardRefusal::HeldKey(
                MarkerScheme::Hardware
            ))),
            Err(KeyEntryError::Refused(GuardRefusal::HeldKey(_)))
        ));
        assert_eq!(e.writes.get(), 0);
    }

    /// The durability half of the review: a write the platform accepted but did not keep (Android's
    /// asynchronous `apply()`, a keychain that answered success) is a FAILURE, so no row moves.
    #[test]
    fn a_write_that_does_not_read_back_fails() {
        let r = run_guarded_store(EntryWrite::Free, &K, || Ok(None), || Ok(()));
        assert!(matches!(r, Err(KeyEntryError::Failed(_))));
        let r = run_guarded_store(EntryWrite::Free, &K, || Ok(Some([2u8; 32])), || Ok(()));
        assert!(matches!(r, Err(KeyEntryError::Failed(_))));
        let r = run_guarded_store(EntryWrite::Free, &K, || Err("busy".into()), || Ok(()));
        assert!(matches!(r, Err(KeyEntryError::Failed(_))));
    }

    #[test]
    fn a_platform_refusal_is_a_failure_not_a_guard_refusal() {
        let r = run_guarded_store(EntryWrite::Free, &K, || Ok(None), || Err("-25293".into()));
        assert!(matches!(r, Err(KeyEntryError::Failed(_))));
    }
}
