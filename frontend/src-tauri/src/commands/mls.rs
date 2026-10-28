//! MLS Tauri commands: initialisation, groups, encryption, decryption.

use crate::concurrency::{
    checkpoint_live_manager, foreground_checkpoint_lock, persist_locked_manager,
    write_mls_state_blob, ForegroundCritical,
};
use crate::keystore_bridge::PluginDeviceKeyStore;
use crate::state::{
    decrypt_messages_batch, AppState, BatchDecryptItem, DecryptedFrame, KeyPackageBatchResult,
    PendingDb,
};
use mls_core::pending_submission::PendingSubmissionRead;
use mls_core::{DecryptErrorKind, MlsManager};
use std::sync::Mutex;

/// The two situational inputs of [`initialiser_mls`], grouped so the command keeps a workable
/// arity. Every field is optional and the whole struct defaults, so a frontend that sends nothing
/// still initialises - neither input is required for a normal login.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct InitMlsOptions {
    /// One-shot migration path for `mls.bin` files written before v0.11.0, sealed in the Argon2id
    /// envelope `[salt (16) || nonce (12) || ciphertext]` keyed on the raw PIN. Nothing ever
    /// rewrote them, so on the first v0.11.x launch they fail to decrypt exactly like a snapshot
    /// sealed with another device's key. When it is supplied and the normal load fails, the legacy
    /// envelope is tried once; on success the snapshot is re-sealed under the device key and
    /// written back, so the conversion happens at most once per install.
    pub legacy_pin: Option<String>,
    /// Localized text for the sheet that biometric mode raises. This is the only command that can
    /// supply it: the native keystore plugin has no access to the app's message catalogue, and the
    /// frontend is the only layer that knows the active locale.
    pub biometric_prompt: Option<tauri_plugin_keystore::BiometricPromptText>,
    /// READ `mls.bin` HERE INSTEAD OF BEING HANDED IT, and the reason this flag exists rather than
    /// being inferred: an absent `encrypted_state` already means something, and it means FIRST
    /// INSTALL - the load below then fresh-starts, which rotates the device identity. "There is no
    /// state" and "the state is on disk, not in this argument" are two different facts and a
    /// missing array cannot carry both, so the caller states which one it means.
    pub state_on_disk: Option<bool>,
    /// Biometric mode only: read the keystore key WITHOUT a biometric sheet. Set by the frontend
    /// when the user's unlock cadence is "every 12h" and a prompted unlock happened inside that
    /// window - see `biometricCadence.ts`, which owns that decision. Absent means prompt, as before.
    pub unattended_key_read: Option<bool>,
}

/// Initialises the MLS manager for this session and caches its at-rest key.
#[tauri::command]
pub(crate) async fn initialiser_mls(
    app: tauri::AppHandle,
    user_id: String,
    device_id: String,
    device_key_b64: String,
    encrypted_state: Option<Vec<u8>>,
    opts: Option<InitMlsOptions>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let opts = opts.unwrap_or_default();
    let legacy_pin = opts.legacy_pin;
    // THE BLOB NEVER HAS TO CROSS THE BRIDGE - see `read_mls_state_blob` for what it cost when it
    // did. `state_on_disk` is only honoured when the caller supplied no bytes, so a caller that
    // does supply them (old-PIN recovery, the migration retry) keeps deciding what is loaded.
    //
    // EITHER WAY THE FOREGROUND IS MARKED BEFORE ANY BYTES ARE TRUSTED, and the disk read happens
    // under the write lock: a background engine (a key-group join from a push, channel-encryption
    // section 26) then either wrote before this read or sees the mark and gives up - never lands
    // between the read and this manager's first persist, which would erase it.
    let encrypted_state = match (encrypted_state, opts.state_on_disk) {
        (None, Some(true)) => {
            let path = tauri::Manager::path(&app)
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("mls.bin");
            crate::concurrency::foreground_load_mls_bin(&path)?
        }
        (supplied, _) => {
            crate::concurrency::mark_foreground_manager_loading();
            supplied
        }
    };
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    let keystore = PluginDeviceKeyStore::new(app.clone())
        .with_prompt(opts.biometric_prompt.unwrap_or_default())
        .unattended(opts.unattended_key_read == Some(true));

    // Empty device_key_b64 → biometric mode: the keystore holds the device key directly.
    // resolve_at_rest_key then takes Path A (retrieve_device_key), which triggers a single
    // BiometricPrompt on Android/iOS.
    let key_b64_opt = if device_key_b64.is_empty() {
        None
    } else {
        Some(device_key_b64)
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve the key explicitly instead of letting the loader do it internally: the
        // resolved key is cached below so later saves in this session (which arrive with an
        // empty device_key_b64 in biometric mode) never have to prompt again.
        let key = MlsManager::resolve_at_rest_key(
            &user_id,
            &device_id,
            encrypted_state.as_deref(),
            key_b64_opt,
            &keystore,
        )
        .map_err(|e| e.to_string())?;

        let manager =
            match MlsManager::load_with_key(&user_id, &device_id, encrypted_state.clone(), &key) {
                Ok(manager) => manager,
                Err(e) => {
                    let migrated = match (&encrypted_state, &legacy_pin) {
                        (Some(blob), Some(pin)) => migrate_legacy_state_blob(&app, blob, pin, &key),
                        _ => None,
                    };
                    match migrated {
                        Some(resealed) => {
                            log::info!("[MLS] Pre-v0.11.0 mls.bin re-sealed under the device key.");
                            MlsManager::load_with_key(&user_id, &device_id, Some(resealed), &key)
                                .map_err(|e| e.to_string())?
                        }
                        None => return Err(e.to_string()),
                    }
                }
            };

        // THE STATE IS NOW PROVEN TO BE THIS ACCOUNT'S - `load_or_create` refused it otherwise - so
        // this is the one place the record beside `mls.bin` may name it. A failure to write it costs
        // only the gate's "another account's messages are here" for a later sign-in, so it is
        // accused and the session goes on. It is written BEFORE this state is ever saved (a created
        // one has no `mls.bin` yet): a crash in between leaves at worst a STALE record beside the
        // previous file, never a state of this account recorded as another's.
        if let Err(e) = crate::commands::storage::write_mls_state_owner(&app, &user_id) {
            log::error!("[MLS] Recording the owner of mls.bin failed: {e}");
        }
        // A stage a background Welcome left in mls.bin is reported against what was loaded.
        match tauri::Manager::path(&app).app_data_dir() {
            Ok(dir) => {
                crate::commands::storage::report_background_stages(&dir, &manager);
            }
            Err(e) => {
                log::warn!("[MLS] app_data_dir() failed ({e}) - background stages not reported")
            }
        }

        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        *lock = Some(manager);
        *device_key_state
            .lock()
            .map_err(|_| "Failed to lock device key".to_string())? = Some(key);
        Ok::<String, String>("MLS Initialized".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a pre-v0.11.0 `mls.bin` (Argon2id, `[salt (16) || nonce (12) || ciphertext]`) with `pin`
/// and rewrites it sealed under `key`, returning the re-sealed bytes.
///
/// Returns `None` when the blob is not that envelope or `pin` does not open it - the caller then
/// keeps the original load error and falls back to recovery. The rewrite happens here rather than
/// being left to the opportunistic save on the JS side: a snapshot left in the legacy envelope
/// replays this migration on every launch, and any failure in between resurfaces as a bogus
/// "PIN changed on another device".
fn migrate_legacy_state_blob(
    app: &tauri::AppHandle,
    blob: &[u8],
    pin: &str,
    key: &[u8; 32],
) -> Option<Vec<u8>> {
    if blob.len() < 16 + 12 {
        return None;
    }
    let (salt, sealed) = blob.split_at(16);
    let legacy_key = mls_core::security::derive_key_from_pin_owned(pin.to_string(), salt).ok()?;
    let plain = mls_core::security::decrypt_blob(&legacy_key, sealed).ok()?;

    let resealed = MlsManager::encrypt_state_blob_with_key(&plain, key)
        .map_err(|e| log::error!("[MLS] Re-sealing the legacy snapshot failed: {e}"))
        .ok()?;
    write_mls_state_blob(app, &resealed)
        .map_err(|e| log::error!("[MLS] Persisting the re-sealed snapshot failed: {e}"))
        .ok()?;
    Some(resealed)
}

/// Resolve the at-rest key for a save: the caller's base64 key when it supplied one, otherwise
/// the key `initialiser_mls` cached for this session.
///
/// The JS layer passes an empty string on the biometric path, where it never holds the key.
fn session_at_rest_key(
    device_key_b64: &str,
    cached: &Mutex<Option<[u8; 32]>>,
) -> Result<[u8; 32], String> {
    if !device_key_b64.is_empty() {
        return mls_core::crypto::decode_base64_to_32_bytes(device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"));
    }
    (*cached
        .lock()
        .map_err(|_| "Failed to lock device key".to_string())?)
    .ok_or_else(|| "no device key for this session - MLS not initialized".to_string())
}

/// Returns the at-rest key [`initialiser_mls`] cached for this session, base64-encoded, or `None`
/// when no session has been initialised yet.
///
/// Biometric mode is the only caller. There the frontend calls `initialiser_mls` with an empty
/// `device_key_b64` and never learns the key - but the key seals more than `mls.bin`: locally
/// stored messages are AES-256-GCM blobs encrypted **in JS** (`db/sqlite.ts`) under that same key.
/// Without it every stored row fails to decrypt and every new row fails to be written, silently,
/// for the whole session.
///
/// Handing the cached copy back costs no second prompt, which reading the keystore again would.
/// It is also not a new exposure: on the PIN and vault paths `deriveDeviceKeyB64` produces this
/// exact key in the WebView to begin with - biometric mode was the one path where the frontend
/// was missing something it needs.
#[tauri::command]
pub(crate) async fn recuperer_cle_session_mls(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    use base64::Engine;
    let cached = *state
        .device_key
        .lock()
        .map_err(|_| "Failed to lock device key".to_string())?;
    Ok(cached.map(|key| base64::engine::general_purpose::STANDARD.encode(key)))
}

/// Encrypts the live MLS state, writes `mls.bin`, and returns THE NUMBER OF BYTES WRITTEN.
///
/// IT RETURNS A LENGTH AND NOT THE BLOB, AND THAT IS THE WHOLE POINT OF THIS DOCBLOCK. This command
/// exists because handing the snapshot back to JS so that JS could write it cost a `number[]`
/// marshalling of the entire state - 2.0 s of a 3.7 s checkpoint on a Mi 9T, measured 2026-08-14.
/// The duplicate WRITE was removed then; the marshalling was not, because the command kept
/// returning `Vec<u8>`, which Tauri serialises as a JSON array of one number per byte. A 7.8 MB
/// snapshot crossed the bridge as ~7.8 million JSON integers on every checkpoint and once more in
/// front of the first screen, and **all four native call sites discarded it** - the return type was
/// web's meaning of `saveState` (where the bytes ARE the persistence, because IndexedDB still has
/// to be handed them) leaking into a platform that had already written the file.
///
/// The length is kept rather than nothing because a write that reports no size is a write nothing
/// can sanity-check, and eight bytes is not a cost.
#[tauri::command]
pub(crate) async fn sauvegarder_mls_et_persister(
    device_key_b64: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // HELD ACROSS THE SERIALISE, NOT JUST THE WRITE. `save_encrypted_with_key` cost 48 s on a
        // Mi 9T; `write_mls_state_blob` is the first thing that refreshes the heartbeat deadline,
        // so without this the guard lapses mid-checkpoint on a backgrounded app and a background
        // engine writes back the state it loaded BEFORE this one started (see `concurrency.rs`).
        let _checkpoint = ForegroundCritical::enter();
        let key = session_at_rest_key(&device_key_b64, &device_key_state)?;
        // The manager lock spans the export only; the seal and the write run on the copy, in
        // checkpoint order - see `checkpoint_live_manager` for what that freed and what it kept.
        checkpoint_live_manager(&manager_state, &key, |sealed| {
            write_mls_state_blob(&app, sealed)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn creer_groupe(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager.create_group(group_id).map_err(|e| e.to_string())
}

/// Drops the private bundles for key packages the SERVER reported deleting.
///
/// The list is always what the purge returned and never one this side derived: a row the purge
/// removed was still in the pool, which is the same as never having been handed out, while a row
/// absent for any other reason may be absent because a peer is about to send the Welcome built on
/// it. See `MlsManager::forget_key_packages`.
///
/// PERSISTS, because this is the only caller whose whole purpose is to make the state smaller. A
/// reclaim that is not written back is reclaimed again next session and never actually shrinks
/// `mls.bin` - which is the file the 3051-bundle measurement was taken on.
#[tauri::command]
pub(crate) async fn oublier_key_packages(
    device_key_b64: String,
    key_packages: Vec<Vec<u8>>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Checkpoint order first: this writes `mls.bin` from the live manager, so it must not
        // interleave with a checkpoint that exported before it (see `foreground_checkpoint_lock`).
        let _ordered = foreground_checkpoint_lock();
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;

        let outcome = manager
            .forget_key_packages(&key_packages)
            .map_err(|e| e.to_string())?;
        log::info!(
            "oublier_key_packages: {} forgotten, {} not held, {} unreadable",
            outcome.forgotten,
            outcome.not_held,
            outcome.unreadable
        );

        if outcome.forgotten > 0 {
            let key = session_at_rest_key(&device_key_b64, &device_key_state)?;
            persist_locked_manager(manager, &key, |sealed| write_mls_state_blob(&app, sealed))?;
        }
        Ok::<usize, String>(outcome.forgotten)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn key_package_a_clef_privee(
    key_package_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let has_private = manager
            .key_package_has_private(&key_package_bytes)
            .map_err(|e| e.to_string())?;
        Ok::<bool, String>(has_private)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn generer_key_packages_et_persister(
    device_key_b64: String,
    count: usize,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<KeyPackageBatchResult, String> {
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Checkpoint order first: this writes `mls.bin` from the live manager, so it must not
        // interleave with a checkpoint that exported before it (see `foreground_checkpoint_lock`).
        let _ordered = foreground_checkpoint_lock();
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;

        log::debug!(
            "generer_key_packages_et_persister start count={} (batch native path)",
            count
        );

        // ENTERED BEFORE THE MINT, NOT BEFORE THE WRITE. The bundles exist in this engine's storage
        // from `generate_key_packages` onwards and are only durable after the write below; a
        // background engine writing back its older blob anywhere in between deletes fifty private
        // keys whose public halves this device has just published. That is the loop
        // `reconcilePublishedKeyPackages` then reads as fifty server orphans (see `concurrency.rs`).
        let _checkpoint = ForegroundCritical::enter();
        // The STATIC fallback, and it is last-resort because the delivery service serves this one
        // package to every peer that finds the pool empty (`resolveKeyPackagePayloadForDevice`).
        // An ordinary KeyPackage's private bundle dies with the first Welcome built on it, so the
        // second peer to be served it could never join - see `mls-core/tests/last_resort_key_package.rs`.
        //
        // REPUBLISHED, NOT REMINTED, and the old behaviour was unbounded. This minted a fresh one on
        // EVERY connection while the pool beside it is topped up incrementally (`needed = 50 -
        // existing`, so nothing is minted when the pool is full). The asymmetry had no reason behind
        // it: reuse is the entire meaning of the extension, which is why the server can serve the
        // same package to every peer. Each remint wrote a ~2 364-byte bundle nothing deletes for 84
        // days, to replace one that was still perfectly good - 269 of them on the Mi 9T measured on
        // 2026-09-09, 9% of a 3051-bundle keystore.
        //
        // Rotation is now the package's OWN lifetime: `existing_last_resort_key_package` returns
        // `None` once nothing valid is left, and only then does this mint. Every 84 days rather than
        // every time the socket comes back, which is a cadence a reader can state.
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .map_err(|e| format!("System clock is before the UNIX epoch: {e}"))?;
        let (fallback, minted_fallback) = match manager
            .existing_last_resort_key_package(now_secs)
            .map_err(|e| e.to_string())?
        {
            Some(held) => {
                log::debug!("generer_key_packages_et_persister: republishing the held last-resort");
                (held, false)
            }
            None => {
                log::info!(
                    "generer_key_packages_et_persister: no valid last-resort held - minting one"
                );
                (
                    manager
                        .generate_last_resort_key_package()
                        .map_err(|e| e.to_string())?,
                    true,
                )
            }
        };
        let pool_packages = if count > 0 {
            manager
                .generate_key_packages(count)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };

        // A ROUND THAT MINTS NOTHING OWES THE DISK NOTHING, AND THAT IS THE ORDINARY ROUND.
        //
        // The write below exists to make new private bundles durable before their public halves
        // are published. The two branches above say exactly whether any were created: an empty
        // pool plus a republished last-resort leaves this engine's storage byte-identical to what
        // the blob already holds, so encrypting and rewriting it is Argon2 and a multi-megabyte
        // file write for no change.
        //
        // It is the common case, not an edge one. `needed = 50 - existing` is zero whenever no
        // peer has claimed a prekey since the last connection, and the last-resort rotates on its
        // own 84-day lifetime since #458. The web half of this same round was measured on
        // production on 2026-09-16 doing two full decrypts, two full encrypts and three
        // checkpoints of a 7 539 305-byte state on `needed=0`.
        //
        // WHAT DECIDES IS THIS ROUND'S OWN ACTION. `MlsManager`'s snapshot dirty bit answers "must
        // the CBOR be rebuilt", which `load_or_create` leaves true on a state that matches the
        // blob exactly - evidence for a different question, and trusting it here would skip a
        // write that is genuinely owed.
        if count > 0 || minted_fallback {
            let key = session_at_rest_key(&device_key_b64, &device_key_state)?;
            let state_bytes =
                persist_locked_manager(manager, &key, |sealed| write_mls_state_blob(&app, sealed))?;
            log::debug!(
                "generer_key_packages_et_persister done count={} state_bytes={}",
                count,
                state_bytes
            );
        } else {
            log::debug!(
                "generer_key_packages_et_persister done count=0 - pool full and last-resort valid, nothing minted so no write owed"
            );
        }

        Ok::<KeyPackageBatchResult, String>(KeyPackageBatchResult {
            fallback: fallback.into(),
            pool_packages: pool_packages.into_iter().map(Into::into).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn oublier_groupe(
    group_id: String,
    // u64: same width as the source epoch (Tauri serializes it as a JSON number on the JS side). [[S4]]
    min_epoch: u64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.forget_group(&group_id, min_epoch);
    Ok(())
}

#[tauri::command]
pub(crate) fn lister_groupes(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.get_known_groups())
}

/// WHAT THE `KeyPackage` LABEL IN THE COMPOSITION LINE IS MADE OF - the breakdown a COUNT cannot give.
///
/// Expired debt, superseded fallbacks and a revoked pool stack into one number and are reclaimed by
/// three different mechanisms, so a count names no remedy. This is the native twin of
/// `WasmMlsClient::key_package_census`, and the two are called from the SAME line of `sessionAuth`.
///
/// **IT IS A COMMAND RATHER THAN A LINE IN `initialiser_mls`, AND THAT IS THE WHOLE POINT.** It used
/// to be a `log::info!` inside `load_or_create`, which put an O(pool) walk that deserialises every
/// stored bundle in front of the first screen: 24.5 ms against 12.9 ms at a 1000-package pool,
/// measured on OXYGEN 2026-09-17 - half of a cold load. Web already called its own census after
/// `MLS ready` for exactly that reason. Now both do.
///
/// Returns the line rather than logging it, so the ONE place that decides where a diagnostic is
/// printed stays the caller - the same shape as the wasm side.
#[tauri::command]
pub(crate) fn recenser_key_packages(state: tauri::State<AppState>) -> Result<String, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.key_package_census_summary())
}

/// Whether this device is still a member of the group (false once a Remove commit naming it was
/// applied). See `MlsManager::is_group_active`: the fact that makes an eviction knowable at the
/// commit rather than at the refused send.
///
/// **ASYNC, SO A WAIT FOR THE MANAGER PARKS A RUST THREAD AND NOT THE WEBVIEW.** As a plain `fn` it
/// ran inside Android's JavaScript bridge call and froze the screen for whatever held the lock -
/// 2.8-3.2 s per call during a rejoin on the Mi 9T (2026-10-13). No caller can tell the two apart:
/// every one `await`s the answer, which reaches JS asynchronously either way, and the answer is the
/// state at the moment the lock is taken - inside the interval between the call and its result in
/// both shapes, which is all a reader that resumes after an `await` could ever rely on.
#[tauri::command]
pub(crate) async fn groupe_actif(
    group_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        manager
            .is_group_active(&group_id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The group's current epoch. Async for the reason [`groupe_actif`] is; its callers already order
/// concurrent readings themselves (`TauriMlsService`'s cache stamps), so none relies on FIFO.
#[tauri::command]
pub(crate) async fn obtenir_epoch(
    group_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        // u64: no truncation; Tauri serializes it as a JSON number (exact <= 2^53, never reached). [[S4]]
        manager.get_epoch(&group_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What [`ajouter_membres_bulk`] hands back: the staged commit, the Welcome (none when nobody was
/// added), the added leaf indices, the key packages skipped, and the external-join base.
type StagedBulkAdd = (
    Vec<u8>,
    Option<Vec<u8>>,
    Vec<u32>,
    Vec<mls_core::SkippedKeyPackage>,
    Vec<u8>,
);

/// `expected_identities[i]` is the `userId:deviceId` `key_packages_bytes[i]` was fetched for: a
/// package naming another device, or the right one under a key this device never pinned for it, is
/// skipped (`identity-mismatch`, `signature-key-changed` - see `mls_core::device_trust`).
#[tauri::command]
pub(crate) fn ajouter_membres_bulk(
    group_id: String,
    key_packages_bytes: Vec<Vec<u8>>,
    expected_identities: Vec<String>,
    intent: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<StagedBulkAdd, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    // Stage-only (C7-A): the commit is NOT merged here. The caller validates it server-side then
    // calls confirmer_commit (accepted) / annuler_commit (rejected), and reads the post-merge
    // ratchet tree via exporter_ratchet_tree.
    let refs: Vec<&[u8]> = key_packages_bytes.iter().map(|v| v.as_slice()).collect();
    // The fifth element is the external-join base for the epoch the commit creates: submitted WITH
    // the commit by the caller, never published on its own (COMM-22). Recorded with `intent` in
    // this same call, under this same lock: no checkpoint holds the staged commit without it.
    let expected: Vec<&str> = expected_identities.iter().map(String::as_str).collect();
    let (record, skipped) = manager
        .add_members_recorded(&group_id, &refs, &expected, intent)
        .map_err(|e| e.to_string())?;
    let welcome = (!record.welcome.is_empty()).then_some(record.welcome);
    Ok((
        record.commit,
        welcome,
        record.added_indices,
        skipped,
        record.group_info,
    ))
}

/// Stages ONE commit that removes the device `identity`'s leaf and adds it back from `key_package`
/// (the repair of a device whose leaf is still in the tree), without merging (C7-A). Returns
/// `(commit, welcome, group_info)` - see `MlsManager::replace_device_with_base`. Recorded with
/// `intent` in this same call, under this same lock (`MlsManager::replace_device_recorded`).
#[tauri::command]
pub(crate) fn remplacer_appareil(
    group_id: String,
    identity: String,
    key_package: Vec<u8>,
    intent: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<mls_core::ReplaceDeviceResult, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    let record = manager
        .replace_device_recorded(&group_id, &identity, &key_package, intent)
        .map_err(|e| e.to_string())?;
    Ok((record.commit, record.welcome, record.group_info))
}

/// Whether `key_package` may be added as `expected_identity` (`userId:deviceId`), without staging
/// anything: `"first-sight"` / `"pinned"` when it may, otherwise the skip reason's wire name. Asked
/// BEFORE a re-add removes the device's stale leaf - see `MlsManager::vet_key_package`.
#[tauri::command]
pub(crate) fn verifier_key_package(
    key_package: Vec<u8>,
    expected_identity: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager
        .vet_key_package(&key_package, &expected_identity)
        .to_string())
}

/// The identity of the leaf of `group_id` carrying `key_package`'s signature key, or `None` - who
/// holds the key an Add was refused as a duplicate of. See `MlsManager::leaf_holding_key_of`.
#[tauri::command]
pub(crate) fn feuille_portant_cle(
    group_id: String,
    key_package: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .leaf_holding_key_of(&group_id, &key_package)
        .map_err(|e| e.to_string())
}

/// The pin of `user_id:device_id` (`{ keys, anchored, reaffirmations }`, keys as byte arrays), or
/// `None` for a device never seen (unverified, never forged) - see
/// `MlsManager::pinned_signature_keys`.
#[tauri::command]
pub(crate) fn cles_signature_epinglees(
    user_id: String,
    device_id: String,
    state: tauri::State<AppState>,
) -> Result<Option<mls_core::device_trust::PinView>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.pinned_signature_keys(&user_id, &device_id))
}

/// The epochs at which this device saw `user_id` leave `group_id`'s tree, oldest first - see
/// `MlsManager::removal_epochs`.
#[tauri::command]
pub(crate) fn epoques_departs(
    group_id: String,
    user_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u64>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.removal_epochs(&group_id, &user_id))
}

/// Every device event recorded since the last call, and forgets them - see
/// `mls_core::device_trust::DeviceEvent`. Serialised with the field names the WASM binding uses.
#[tauri::command]
pub(crate) fn prendre_evenements_appareils(
    state: tauri::State<AppState>,
) -> Result<Vec<mls_core::DeviceEvent>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    Ok(manager.take_device_events())
}

#[tauri::command]
pub(crate) fn trailer_welcome(
    welcome_bytes: Vec<u8>,
    ratchet_tree_bytes: Option<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| {
            log::error!(
                "[WELCOME] Erreur critique lors du traitement du Welcome MLS: {:?}",
                e
            );
            e.to_string()
        })
}

/// What `envoyer_message_bytes` did with a frame: SEALED, with its author's signature appended
/// (`mls_core::authorship`) and the encoded proof the sender keeps on its own copy - the same proof
/// its peers receive, so a history bundle it later writes carries it - or REFUSED because the group
/// holds a staged commit nobody has settled: a TYPE, which the WebView maps to the settle that
/// answers it.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum Scellement {
    Sealed(crate::state::AuthoredFramePayload),
    CommitPending,
}

/// Seals `message_bytes` for `group_id` - UNLESS the group holds a staged commit.
///
/// **THE STATE DECIDES, NOT AN INDEX.** openmls seals at epoch N while a commit to N+1 is pending,
/// and the server may already hold that commit (a background Welcome whose answer this device never
/// read, installed by a resume reload). The WebView keeps an index of such groups, but an index can
/// lag the state it describes - a reload swaps the manager under it - so the refusal is read here,
/// under the manager lock, from the manager the frame would be sealed with.
#[tauri::command]
pub(crate) fn envoyer_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Scellement, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    seal_unless_commit_pending(manager, &group_id, &message_bytes)
}

/// [`envoyer_message_bytes`] minus the Tauri state, so the refusal is tested on a real manager.
pub(crate) fn seal_unless_commit_pending(
    manager: &mut MlsManager,
    group_id: &str,
    message_bytes: &[u8],
) -> Result<Scellement, String> {
    if matches!(manager.has_pending_commit(group_id), Ok(true)) {
        log::warn!(
            "[MLS] send REFUSED in group={} - it holds a staged commit not yet settled",
            group_id.chars().take(8).collect::<String>()
        );
        return Ok(Scellement::CommitPending);
    }
    manager
        .send_authored_message(group_id, message_bytes)
        .map(|frame| Scellement::Sealed(frame.into()))
        .map_err(|e| {
            log::error!("[AUTHORSHIP] authored send failed for {group_id}: {e}");
            e.to_string()
        })
}

/// Hands over the fork findings recorded since the last call (`mls_core::fork_check`).
#[tauri::command]
pub(crate) fn prendre_constats_fork(
    state: tauri::State<AppState>,
) -> Result<Vec<crate::state::ForkFindingPayload>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager
        .take_fork_findings()
        .into_iter()
        .map(Into::into)
        .collect())
}

/// Advances the send ratchet by `count` generations without emitting anything, repairing an
/// `mls.bin` restored behind frames this device had already sent. ONE invoke for the whole burn:
/// a per-generation crossing would marshal a discarded ciphertext back over IPC every time.
/// See `MlsManager::skip_send_generations` for why it encrypts and why over-shooting is safe.
#[tauri::command]
pub(crate) fn skip_send_generations(
    group_id: String,
    count: u32,
    state: tauri::State<AppState>,
) -> Result<u32, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .skip_send_generations(&group_id, count)
        .map_err(|e| e.to_string())
}

/// Every leaf identity (`userId:deviceId`) currently in the group's ratchet tree.
///
/// The tree is the only authority on who can READ a group. The delivery service's membership rows
/// answer who it will ROUTE to - a different question, and one a community's key-distribution group
/// has no rows for at all - so a reconciliation deciding whether a leaf still belongs reads this.
#[tauri::command]
pub(crate) fn lister_identites_membres(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager.member_identities(&group_id).map_err(|e| {
        log::error!(
            "lister_identites_membres failed: group={} err={}",
            group_id,
            e
        );
        e.to_string()
    })
}

#[tauri::command]
pub(crate) fn retirer_membres(
    group_id: String,
    user_ids: Vec<String>,
    intent: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<mls_core::StagedRemovalResult, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = user_ids.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_users_recorded(&group_id, &id_slices, intent)
        .map(|r| (r.commit, r.group_info))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn retirer_membres_par_appareil(
    group_id: String,
    device_identities: Vec<String>,
    intent: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<mls_core::StagedRemovalResult, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = device_identities.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_devices_recorded(&group_id, &id_slices, intent)
        .map(|r| (r.commit, r.group_info))
        .map_err(|e| e.to_string())
}

/// Stages a refresh of this device's own leaf in `group_id` (`MlsManager::stage_self_update_recorded`):
/// an empty commit with a path and no proposal, recorded with `intent` in the same call. Merged by
/// `confirmer_commit` or cleared by `annuler_commit` on the server's answer, like every other staged
/// commit.
#[tauri::command]
pub(crate) fn rafraichir_feuille(
    group_id: String,
    intent: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<mls_core::StagedSelfUpdateResult, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .stage_self_update_recorded(&group_id, intent)
        .map(|r| (r.commit, r.group_info))
        .map_err(|e| e.to_string())
}

/// When this device's leaf in `group_id` was minted (Unix seconds), or `None` once a commit
/// replaced it (`MlsManager::own_leaf_minted_at`).
#[tauri::command]
pub(crate) fn date_feuille(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Option<u64>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .own_leaf_minted_at(&group_id)
        .map_err(|e| e.to_string())
}

/// The HPKE encryption key of this device's leaf in `group_id`, which names the leaf, or `None`
/// when the tree holds none (`MlsManager::own_leaf_encryption_key`).
#[tauri::command]
pub(crate) fn cle_feuille(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Option<Vec<u8>>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .own_leaf_encryption_key(&group_id)
        .map_err(|e| e.to_string())
}

/// Whether this device's current context in `group_id` is the one the served base `group_info`
/// describes (`MlsManager::own_context_matches_base`) - the fork gate of the periodic refresh.
#[tauri::command]
pub(crate) fn contexte_correspond_base(
    group_id: String,
    group_info: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<bool, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .own_context_matches_base(&group_id, &group_info)
        .map_err(|e| e.to_string())
}

/// The record of a staged commit, as `soumission_en_attente` hands it to TypeScript: the same
/// three answers, in the same order, as the WASM binding's array.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum SoumissionLue {
    None,
    Unreadable,
    #[serde(rename_all = "camelCase")]
    Recorded {
        intent: Vec<u8>,
        base_epoch: u64,
        commit: Vec<u8>,
        group_info: Vec<u8>,
        welcome: Option<Vec<u8>>,
        added_indices: Vec<u32>,
    },
}

/// The record of `group_id`'s staged commit (`MlsManager::pending_submission`).
#[tauri::command]
pub(crate) fn soumission_en_attente(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<SoumissionLue, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(match manager.pending_submission(&group_id) {
        PendingSubmissionRead::None => SoumissionLue::None,
        PendingSubmissionRead::Unreadable => SoumissionLue::Unreadable,
        PendingSubmissionRead::Recorded(r) => SoumissionLue::Recorded {
            intent: r.intent,
            base_epoch: r.base_epoch,
            commit: r.commit,
            group_info: r.group_info,
            welcome: (!r.welcome.is_empty()).then_some(r.welcome),
            added_indices: r.added_indices,
        },
    })
}

/// Every group holding a staged commit (`MlsManager::groups_with_pending_commit`).
#[tauri::command]
pub(crate) fn groupes_commit_en_attente(
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.groups_with_pending_commit())
}

/// Merges `group_id`'s accepted Add and, in the same call, records its Welcome as owed to
/// `recipients` (`MlsManager::merge_pending_commit_owing_welcome`).
#[tauri::command]
pub(crate) fn confirmer_commit_welcome_du(
    group_id: String,
    recipients: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .merge_pending_commit_owing_welcome(&group_id, recipients)
        .map_err(|e| e.to_string())
}

/// One owed Welcome, as `welcomes_dus` hands it to TypeScript.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WelcomeDu {
    group_id: String,
    welcome: Vec<u8>,
    ratchet_tree: Vec<u8>,
    recipients: Vec<String>,
}

/// Every Welcome still owed (`MlsManager::owed_welcomes`).
#[tauri::command]
pub(crate) fn welcomes_dus(state: tauri::State<AppState>) -> Result<Vec<WelcomeDu>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager
        .owed_welcomes()
        .into_iter()
        .map(|w| WelcomeDu {
            group_id: w.group_id,
            welcome: w.welcome,
            ratchet_tree: w.ratchet_tree,
            recipients: w.recipients,
        })
        .collect())
}

/// `recipient` was answered for `welcome` in `group_id` (`MlsManager::welcome_delivered`).
#[tauri::command]
pub(crate) fn welcome_remis(
    group_id: String,
    recipient: String,
    welcome: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.welcome_delivered(&group_id, &recipient, &welcome);
    Ok(())
}

/// Confirms (merges) a *staged* commit (ADD or REMOVE) AFTER the server accepts it
/// (`validateCommit`). Advances the local epoch. Counterpart of `annuler_commit`. [[C7]] Option A:
/// validate-then-merge, never a local fork on rejection (unified ADD+REMOVE regime).
///
/// Does NOT persist: the caller chains `persistMlsStateAfterMutation` (which holds the device key,
/// retrieved from the session-level keystore) as for any other mutation - same merge->persist
/// window as before.
#[tauri::command]
pub(crate) fn confirmer_commit(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .merge_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Clears a *staged* commit (ADD or REMOVE) when the server REJECTS it. The local epoch stays
/// unchanged (no fork). No persistence: `mls.bin` is already at the pre-stage state. [[C7]]
#[tauri::command]
pub(crate) fn annuler_commit(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .clear_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exports the group's ratchet tree from the CURRENT state (post-merge) for the Welcome. For an
/// ADD, call it AFTER `confirmer_commit` (the new member joins at epoch N+1). [[C7]]
#[tauri::command]
pub(crate) fn exporter_ratchet_tree(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_ratchet_tree_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exports a self-contained GroupInfo (tree included) for `group_id`, to be stored server-side and
/// served to authorized members joining via an external commit (`rejoindre_par_commit_externe`).
#[tauri::command]
pub(crate) fn exporter_group_info(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_group_info(&group_id)
        .map_err(|e| e.to_string())
}

/// Whether an external commit built on this GroupInfo would bring this device in as a FURTHER
/// DEVICE OF A MEMBER (`MlsManager::external_join_is_a_further_device`).
#[tauri::command]
pub(crate) async fn mls_external_join_is_a_further_device(
    group_info_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .external_join_is_a_further_device(&group_info_bytes)
        .map_err(|e| e.to_string())
}

/// Joins a group via an external commit built from a served GroupInfo. The returned group is at
/// epoch N+1 with the commit *staged*: the caller submits the commit for epoch validation
/// server-side (against the GroupInfo's base epoch), then `confirmer_commit` if accepted, or
/// `oublier_groupe` + retry with a fresher GroupInfo if rejected (an external commit cannot be
/// rolled back). Returns (group_id, commit).
#[tauri::command]
pub(crate) fn rejoindre_par_commit_externe(
    group_info_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(String, Vec<u8>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .join_by_external_commit(&group_info_bytes)
        .map_err(|e| e.to_string())
}

/// Dechiffre un message MLS entrant.
/// If decryption fails with "Process error:" (Sender Ratchet gap: the received generation is
/// higher than the expected one), the message is stored in SQLite via PendingDb and the command
/// returns Err("GAP_QUEUED:<group_id>") so the frontend knows it must fetch the missing messages.
#[tauri::command]
pub(crate) async fn recevoir_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
) -> Result<Option<DecryptedFrame>, String> {
    // Chantier 1 : detection proactive de l'epoch gap AVANT tout dechiffrement.
    // The epoch is cleartext in the MLS header -> no ratchet key consumed.
    // The MutexGuard is released in the inner block BEFORE any .await.
    let epoch_gap: Option<(u64, u64)> = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        match lock.as_ref() {
            Some(manager) => {
                let group_epoch = manager.get_epoch(&group_id).ok();
                match (MlsManager::parse_message_epoch(&message_bytes), group_epoch) {
                    (Some(msg_ep), Some(group_ep)) if msg_ep > group_ep => Some((msg_ep, group_ep)),
                    _ => None,
                }
            }
            None => None,
        }
        // lock is released here - no await has happened yet
    };
    if let Some((msg_ep, group_ep)) = epoch_gap {
        log::warn!(
            "[GAP] Epoch gap detecte AVANT dechiffrement : \
             msg_epoch={} > group_epoch={} pour group={}. \
             Mise en attente et declenchement de la resync.",
            msg_ep,
            group_ep,
            group_id
        );
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        let id = format!("{}-epoch-{}", group_id, ts);
        let insert_result = sqlx::query(
            "INSERT OR IGNORE INTO pending_mls_messages \
             (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
        )
        .bind(&id)
        .bind(&group_id)
        .bind(message_bytes.as_slice())
        .bind(ts)
        .execute(&*pending_db.0)
        .await;
        match insert_result {
            Ok(_) => (),
            Err(db_e) => {
                log::error!("[GAP] DB insert (epoch pre-check) failed: {}", db_e);
                return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
            }
        }
        return Err(format!(
            "GAP_QUEUED:{}:msg_epoch={}:group_epoch={}",
            group_id, msg_ep, group_ep
        ));
    }

    // Acquire + release the Mutex BEFORE any async operation, to avoid deadlocks with
    // std::sync::Mutex (non-Send across await points).
    let result = {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        manager.process_incoming_message_with_sender(&group_id, &message_bytes)
    };

    match result {
        Ok(val) => Ok(val.map(DecryptedFrame::from)),
        Err(e) => {
            let err_str = e.to_string();
            // Classification centralisee cote mls-core (source unique du string-matching). [[S5]]
            let kind = e.decrypt_kind();

            // SEVERITY IS THE CLASSIFICATION'S TO REPORT, NOT THE BARE FACT THAT A DECRYPT RETURNED
            // `Err`. Every arm below already logs the conclusion it reached, and this line sat above
            // all of them at `error!` - so an own frame re-offered by a replay, or a generation the
            // ratchet has already consumed, each announced an application ERROR on the phone, where
            // logs are hardest to read, every single time the protocol worked as specified. An error
            // that fires on the normal path is one its reader learns to skip. Only what NOTHING has
            // explained keeps `error!`.
            if matches!(
                kind,
                DecryptErrorKind::Other | DecryptErrorKind::Unrecoverable
            ) {
                log::error!(
                    "recevoir_message_bytes failed: group={} err={}",
                    group_id,
                    err_str
                );
            } else {
                log::debug!(
                    "recevoir_message_bytes classified: group={} kind={:?} err={}",
                    group_id,
                    kind,
                    err_str
                );
            }

            match kind {
                // Corruption detected by mls-core -> unrecoverable state, trigger a re-bootstrap.
                DecryptErrorKind::Unrecoverable => Err(format!("UNRECOVERABLE:{}", group_id)),

                // SecretReuseError = this message's ratchet key was already consumed. Unlike a
                // FUTURE generation gap, it will NEVER decrypt: queueing it in SQLite would loop
                // forever. It is NOT necessarily a duplicate, and this used to answer Ok(None),
                // which said "nothing to show" and lost the distinction: a sender whose ratchet
                // rewound (WP-LOSS-1, WP-MULTITAB-1) encrypts a NEW message at a generation the
                // receiver already consumed, and it read here exactly like a second delivery of one
                // already displayed. The error is surfaced instead, so the shared frontend
                // classifier can compare the frame against the ones it has processed and, when it
                // has never seen this one, ask the sender to send it again. The frontend still
                // ACKs; only the diagnosis changes. Parity with the web WASM path, which reaches
                // the same classifier through its own thrown error.
                DecryptErrorKind::SecretReuse => {
                    log::debug!(
                        "[DUP] SecretReuseError group={} - already-consumed generation, handing the classification to the frontend",
                        group_id
                    );
                    Err(format!(
                        "SecretReuseError: already-consumed generation in group {}",
                        group_id
                    ))
                }

                // The generation is beyond what OpenMLS will derive forward: this device missed too
                // many of that sender's frames. Deliberately NOT queued in SQLite - it can never
                // decrypt, so a retry row is dead weight forever, exactly as for SecretReuse. The
                // error is surfaced verbatim so the shared frontend classifier recognises
                // `TooDistantInTheFuture` and escalates to a re-Welcome, which is the only thing
                // that resets the ratchets. It used to reach the frontend as a plain `GAP_QUEUED`,
                // which ran a commit replay that applied nothing, declared the gap healed, and ACKed
                // the message off the server (WP-PENDING-2).
                DecryptErrorKind::GenerationTooFarAhead => {
                    log::warn!(
                        "[GAP] Generation too far ahead for group={} - unrecoverable locally, escalating to the frontend",
                        group_id
                    );
                    Err(err_str)
                }

                // A frame this device itself encrypted, handed back by a replay of its own mailbox.
                // NOT queued, for the reason the two arms above are not: no retry can decrypt what
                // MLS forbids us to decrypt. Until this arm existed the string fell through to
                // `SenderRatchetGap` below, so every own frame cost a row in `pending_mls_messages`
                // and three drain attempts before the sweeper removed it. Surfaced verbatim so the
                // frontend classifier answers `own-message` and ACKs - nothing is lost, the sender's
                // optimistic render wrote this message already (WP-ECHO-1).
                DecryptErrorKind::OwnMessage => Err(err_str),

                // "Process error:" = OpenMLS error on the same epoch -> likely a Sender Ratchet gap
                // (future generation received) -> queued in SQLite for retry.
                DecryptErrorKind::SenderRatchetGap => {
                    log::warn!(
                        "[GAP] Sender Ratchet gap for group={} - message queued in SQLite",
                        group_id
                    );
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as i64;
                    let id = format!("{}-gen-{}", group_id, ts);
                    let insert_result = sqlx::query(
                        "INSERT OR IGNORE INTO pending_mls_messages \
                         (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
                    )
                    .bind(&id)
                    .bind(&group_id)
                    .bind(message_bytes.as_slice())
                    .bind(ts)
                    .execute(&*pending_db.0)
                    .await;
                    if let Err(db_e) = insert_result {
                        log::error!("[GAP] DB store failed: {}", db_e);
                        return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
                    }
                    // Embed the original OpenMLS error so the frontend can log it.
                    Err(format!("GAP_QUEUED:{}:{}", group_id, err_str))
                }

                // An application frame from an epoch whose secrets we no longer hold. Not queued in
                // SQLite, for the same reason as the two arms above: no retry can decrypt it, so a
                // row here is dead weight forever. Surfaced verbatim so the shared frontend
                // classifier reaches the same policy it applies to a consumed generation - a LOST
                // frame, and an id-addressed history diff, which is the only thing that recovers a
                // message a member still holds in its durable store.
                DecryptErrorKind::PastEpochApplication => {
                    log::warn!(
                        "[GAP] Past-epoch application frame for group={} - unreadable locally, escalating to the frontend",
                        group_id
                    );
                    Err(err_str)
                }

                // A FRAME FOR A GROUP THIS DEVICE HAS BEEN REMOVED FROM. Never queued: a row here
                // would be retried against a group whose Remove commit retired our leaf, which no
                // attempt can change. Surfaced verbatim so the shared frontend classifier reaches
                // the ONE policy that separates this from every other permanent kind above - ACK
                // and retire, and specifically NO recovery. The out-of-sync answer this used to
                // fall into asks to be re-added to a group we were deliberately removed from, and
                // the commit request behind it can only ever be refused.
                DecryptErrorKind::Evicted => {
                    log::warn!(
                        "[EVICT] Frame for group={} arrived after this device was evicted - handing the classification to the frontend, no repair is owed",
                        group_id
                    );
                    Err(err_str)
                }

                // REFUSED AT EXACTLY ITS OWN EPOCH. Never queued, for the reason the arms above
                // are not: a retry reads the same immutable epoch state and is refused again, so
                // the row is dead weight until the sweeper reaches it. Surfaced verbatim, and the
                // loop it closes is on the OTHER side of the boundary - on the web an
                // unacknowledged frame comes back on every single connection, for ever.
                DecryptErrorKind::SameEpochRefusal => {
                    log::warn!(
                        "[MLS] Same-epoch refusal for group={} - unreadable for good however often it is retried, escalating to the frontend",
                        group_id
                    );
                    Err(err_str)
                }

                DecryptErrorKind::Other => Err(err_str),
            }
        }
    }
}

/// Decrypts a page of MLS ciphertexts in one IPC crossing (ratchet order preserved).
#[tauri::command]
pub(crate) async fn recevoir_messages_batch(
    group_id: String,
    messages: Vec<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BatchDecryptItem>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_mut()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        log::debug!(
            "recevoir_messages_batch group={} count={}",
            group_id,
            messages.len()
        );
        Ok::<Vec<BatchDecryptItem>, String>(decrypt_messages_batch(manager, &group_id, &messages))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn exporter_secret(
    group_id: String,
    label: String,
    context: Option<Vec<u8>>,
    key_len: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager
        .export_secret(
            &group_id,
            &label,
            context.as_deref().unwrap_or(&[]),
            key_len,
        )
        .map_err(|e| e.to_string())
}

/// Stores the new deviceKeyB64 straight into the keystore after a PIN change.
/// The derivation (PBKDF2-SHA256, see `$lib/crypto/deviceKey.ts`) already happened on the frontend.
///
/// Decodes the base64 into 32 bytes and stores them under the alias
/// `mls_device_key_{user_id}_{device_id}`. A refused write is RETURNED, never swallowed: a PIN change
/// awaits this before it moves any data (`pointUnattendedUnlockAt`), and the frontend types the
/// refusal as the `keystore` stage of the change.
#[tauri::command]
pub(crate) async fn actualiser_cle_keystore_avec_devicekey(
    device_key_b64: String,
    user_id: String,
    device_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let alias = crate::commands::at_rest_key::device_key_alias(&user_id, &device_id);
    let keystore = PluginDeviceKeyStore::new(app.clone());

    let key_bytes = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
        .map_err(|e| format!("invalid device_key_b64: {e}"))?;

    // Through the at-rest guard, and READ BACK (`store_guarded`): a guard refusal is RETURNED, not
    // skipped - the caller (a key change) must not move data while the unattended unlock points
    // elsewhere - and so is a write the platform did not keep.
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        keystore
            .store_guarded(&key_bytes, &alias)
            .map(|_| ())
            .map_err(|e| {
                log::warn!("[DEVICEKEY_CHANGE] The keystore did not take the key: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A new v2 session's Ed25519 pair (channel-encryption §21), from `mls_core::graine_signature`.
///
/// Stateless: the secret is returned to the caller, which seals it into the session's encrypted
/// blob - no Rust state holds it, so nothing here outlives the call.
#[derive(serde::Serialize)]
pub(crate) struct GraineSessionKeyPairDto {
    secret: Vec<u8>,
    public: Vec<u8>,
}

#[tauri::command]
pub(crate) fn graine_session_keypair() -> Result<GraineSessionKeyPairDto, String> {
    log::debug!("[GRAINE_SIG] graine_session_keypair");
    let pair =
        mls_core::graine_signature::new_session_keypair().map_err(|e| e.code().to_string())?;
    Ok(GraineSessionKeyPairDto {
        secret: pair.secret.to_vec(),
        public: pair.public,
    })
}

/// Signs a v2 message's `H || nonce || ciphertext` with its session secret. The error is the
/// engine's CODE (`GraineSignatureError::code`), which the frontend classifies on.
#[tauri::command]
pub(crate) fn graine_sign_with_session_key(
    secret: Vec<u8>,
    message: Vec<u8>,
) -> Result<Vec<u8>, String> {
    mls_core::graine_signature::sign_with_session_key(&secret, &message)
        .map_err(|e| e.code().to_string())
}

/// Verifies a session's or a device's signature; answers `valid` or the refusal's code, never an
/// error, since a signature that does not verify is an answer and not a failure of the call.
#[tauri::command]
pub(crate) fn graine_verify_signature(
    public_key: Vec<u8>,
    message: Vec<u8>,
    signature: Vec<u8>,
) -> String {
    match mls_core::graine_signature::verify_graine_signature(&public_key, &message, &signature) {
        Ok(()) => "valid".to_string(),
        Err(e) => e.code().to_string(),
    }
}

/// Verifies a whole page's signatures in ONE crossing of the bridge (F7, `community-open-budget.md`).
///
/// `packed_b64` is `packGraineSignatureChecks`'s buffer as ONE base64 string: not a raw invoke body
/// (Android delivers every argument as JSON, see `store_avatar_mirror`) and not a number array (one
/// JSON number per byte, built on the WebView's main thread). The answer is one verdict per check, in
/// order, each what `graine_verify_signature` answers for it. An `Err` means the packing itself was
/// broken - a contract fault, never a verdict about a row.
///
/// `async` + `spawn_blocking`: a page is a few hundred verifications, which a synchronous command
/// would run on the main thread.
#[tauri::command]
pub(crate) async fn graine_verify_signatures(packed_b64: String) -> Result<Vec<String>, String> {
    use base64::Engine;
    let packed = base64::engine::general_purpose::STANDARD
        .decode(&packed_b64)
        .map_err(|e| {
            log::error!(
                "[GRAINE_SIG] signature batch of {} chars is not base64, nothing verified: {e}",
                packed_b64.len()
            );
            format!("packed batch is not base64: {e}")
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        mls_core::graine_signature::verify_packed_graine_signatures(&packed)
            .map(|verdicts| verdicts.into_iter().map(str::to_string).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| {
        log::error!("[GRAINE_SIG] signature batch task failed: {e}");
        e.to_string()
    })?
}

/// This device's own credential signature key, public half (`MlsManager::own_signature_key`).
///
/// ASYNC so the UI's call never waits on the manager mutex on the main thread.
#[tauri::command]
pub(crate) async fn mls_own_signature_key(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.own_signature_key())
}

/// Signs a v2 session ENDORSEMENT with this device's MLS credential key.
#[tauri::command]
pub(crate) fn graine_sign_with_device_credential(
    message: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .sign_with_device_credential(&message)
        .map_err(|e| e.to_string())
}

/// The clean run covering `group_id`'s current epoch, for Graine's outbound rotation
/// (`mls-core/src/graine_run.rs`). Read under the manager lock, from the same manager that seals the
/// next distribution frame.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraineRunDto {
    run_id: String,
    epoch: u64,
    epoch_fingerprint: String,
}

#[tauri::command]
pub(crate) fn graine_run(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<GraineRunDto, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    let reading = manager.graine_run(&group_id).map_err(|e| e.to_string())?;
    Ok(GraineRunDto {
        run_id: reading.run_id,
        epoch: reading.epoch,
        epoch_fingerprint: reading.epoch_fingerprint,
    })
}

/// The signature key the tree of `group_id` holds for the leaf `identity`, or `None` when no leaf
/// carries it (channel-encryption section 21: what a v2 endorsement is checked against).
#[tauri::command]
pub(crate) fn graine_member_signature_key(
    group_id: String,
    identity: String,
    state: tauri::State<AppState>,
) -> Result<Option<Vec<u8>>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .member_signature_key(&group_id, &identity)
        .map_err(|e| e.to_string())
}
