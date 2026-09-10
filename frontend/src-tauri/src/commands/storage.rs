//! Storage Tauri commands: persistence, reload, heartbeat, flags.

use crate::concurrency::{mark_foreground_active, mls_bin_write_lock, write_mls_state_blob};
use crate::state::AppState;
use mls_core::MlsManager;
use tauri::Manager;

/// Write an already-encrypted MLS state blob into {app_data_dir}/mls.bin.
/// Accepts the encrypted bytes (as number[] from JS) and writes them verbatim.
/// This is used by the frontend when it already holds an encrypted state and
/// wants to persist it to the native app data directory (avoid WebView eviction).
#[tauri::command]
pub(crate) fn save_mls_state(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    write_mls_state_blob(&app, &data)
}

/// C2: reloads `mls.bin` from disk into the in-memory foreground manager, under the global lock,
/// and marks the foreground active. Called on foreground return BEFORE any operation: while in the
/// background a JNI engine (Welcome/send/worker) may have advanced `mls.bin`; without this reload
/// the hot manager is stale and its next persist would OVERWRITE the background advance
/// (lost-update -> SecretReuse + epoch regression). Returns `true` if a reload happened, `false` if
/// `mls.bin` is absent (nothing to do). Callers are mobile-only (no background engine on desktop).
#[tauri::command]
pub(crate) async fn recharger_mls_au_resume(
    user_id: String,
    device_id: String,
    device_key_b64: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    // Mark active BEFORE reading: any in-flight background write completes (lock) and subsequent
    // ones give up -> the read below picks up the latest background advance.
    mark_foreground_active();
    let manager_state = state.mls_manager.clone();
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = data_dir.join("mls.bin");
        // THE MANAGER LOCK IS TAKEN FIRST AND HELD ACROSS THE READ, THE DECRYPT AND THE INSTALL,
        // BECAUSE READ-THEN-INSTALL IS ONE OPERATION AND WAS WRITTEN AS TWO.
        //
        // Until 2026-09-08 the file was read under `mls_bin_write_lock`, that lock was dropped, and
        // the manager lock was taken only to install. `mark_foreground_active()` above was what
        // guarded the gap - and it guards against BACKGROUND JNI engines, which is not who races
        // here. `generer_key_packages_et_persister` is a FOREGROUND command: it holds the manager
        // lock while it mints, and writes `mls.bin` at the end of that same critical section. So a
        // mint that begins after the read and ends before the install is invisible to every guard
        // on this path, and the snapshot installed over it is missing exactly the bundles the mint
        // produced - which the server already holds, because publishing follows the mint.
        //
        // MEASURED ON THE Mi 9T, 2026-09-08 18:02:04-18:02:14, deliberately provoked by resuming
        // during a ten-package mint:
        //
        //   18:02:04.730  thread 15666  generer_key_packages_et_persister start count=10
        //   18:02:08.926  thread 15669  load_or_create ... KeyPackage 2928x   <- read, mid-mint
        //   18:02:09.571  thread 15666  generer ... done state_bytes=10423737 <- mint persists
        //   18:02:09.592  thread 15669  [RESUME] reload DROPS KEY MATERIAL - 11 ... live=2939, loading=2928
        //   18:02:09.599  thread 15669  [RESUME] foreground manager reloaded  <- stale snapshot wins
        //   18:02:14.429                REFUSED to purge 10/50 prekey(s) this session published itself
        //
        // AND THE TWO PATHS TOOK THE TWO LOCKS IN OPPOSITE ORDERS, which is the same defect seen
        // from the other side. The mint is `mls_manager` then `mls_bin_write_lock` (the latter
        // inside `write_mls_state_blob`); this function was `mls_bin_write_lock` then `mls_manager`.
        // It escaped deadlock only by releasing the first before taking the second - and that
        // release IS the window. Taking them in the mint's order removes the inversion and the
        // window in one move: a mint in flight makes this wait and then read the file it wrote, and
        // a reload in flight makes the mint wait and then mint into the manager just installed.
        // There is no interleaving left to reconcile afterwards, which is why this is an ordering
        // change and not a retry.
        //
        // THE COST IS THE DECRYPT, AND IT IS THE POINT. The manager is now unavailable for the
        // ~600 ms a 10 MB `mls.bin` takes to load, where before it was unavailable only for the
        // install. That is not a regression to be minimised: an MLS mutation running against a
        // manager that is about to be replaced is the defect, so excluding it is the fix.
        let mut live = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        reload_into(&mut live, &path, &user_id, &device_id, &device_key_b64)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads `mls.bin`, grades it against the live manager and installs it - all while the caller holds
/// the manager lock, WHICH IS WHAT THE FIRST ARGUMENT IS FOR.
///
/// **THE ORDERING IS IN THE SIGNATURE BECAUSE A COMMENT IS NOT A GUARANTEE.** The defect this
/// function was extracted to close was a read taken outside the manager lock and an install taken
/// inside it, with a foreground mint fitting between the two. Fixing the sequence in place would
/// leave the next caller free to make the same mistake, and the mistake is invisible at the call
/// site: both orders compile and both work whenever nothing interleaves. Taking `&mut Option<MlsManager>`
/// makes the lock a PRECONDITION OF CALLING - the only way to obtain one is to hold the guard - so
/// the read cannot be hoisted out of the critical section without the borrow checker objecting.
///
/// It also makes the logic testable without Tauri: an `Option<MlsManager>` and a path are the whole
/// input, where the command needs an `AppHandle`, a `State` and a runtime.
fn reload_into(
    live: &mut Option<MlsManager>,
    path: &std::path::Path,
    user_id: &str,
    device_id: &str,
    device_key_b64: &str,
) -> Result<bool, String> {
    // Read the file UNDER the write lock too (never read while a JNI engine writes). Released
    // before the decrypt; the manager lock above is what now spans the whole operation.
    let bytes = {
        let _guard = mls_bin_write_lock()
            .lock()
            .map_err(|_| "mls_bin write lock poisoned".to_string())?;
        match std::fs::read(path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("read mls.bin: {e}")),
        }
    };
    let Some(bytes) = bytes else {
        log::debug!("[RESUME] mls.bin absent - nothing to reload (C2)");
        return Ok(false);
    };
    let key = mls_core::crypto::decode_base64_to_32_bytes(device_key_b64)
        .map_err(|e| format!("invalid device_key_b64: {e}"))?;
    let candidate = MlsManager::load_with_key(user_id, device_id, Some(bytes), &key)
        .map_err(|e| format!("reload mls.bin: {e}"))?;
    // Epoch-monotonic reload guard (C2): a snapshot must never regress a live group's epoch.
    // If the live manager already holds a group at a higher epoch than the reloaded candidate
    // (e.g. a stale mls.bin), keep the live state rather than clobber it. [[C2]]
    if let Some(current) = live.as_ref() {
        if !current.reload_is_monotonic(&candidate) {
            log::warn!(
                "[RESUME] reload refused - mls.bin would regress a live group epoch, keeping live state (C2)"
            );
            return Ok(false);
        }
        // THE GUARD ABOVE GRADES ON GROUP EPOCHS, AND KEY MATERIAL IS NOT A GROUP EPOCH.
        //
        // A snapshot written before a prekey mint holds every group at the same epoch, so it
        // passes `reload_is_monotonic` unchanged and installs a keystore missing the fifty
        // bundles this device published seconds earlier. `key_package_a_clef_privee` then
        // answers `false` about the device's own fresh mints, and that is precisely the
        // observation `reconcilePublishedKeyPackages` reads as "the server holds an orphan"
        // before purging the pool - the loop in `docs/wiki/backlog.md` whose cause is open.
        //
        // IT ACCUSES AND DOES NOT REFUSE, AND THE REASON IS THE WHOLE POINT. Refusing would
        // keep the live manager, and this reload exists to pick up what a background JNI engine
        // advanced while the app was away. That advance is often a RATCHET GENERATION rather
        // than an epoch - a decrypted application message moves no epoch at all - so a refusal
        // grading on key packages would silently drop exactly the background work the reload
        // was written to rescue, trading a known defect for an unmeasured one.
        //
        // So the loss is NAMED rather than prevented: a correct mechanism with no report is
        // found by hand, a day late, and this line is what turns the open cause into a reading
        // instead of an inference.
        //
        // AND IT COMPARED CARDINALITIES UNTIL 2026-09-08, WHICH IS NOT THE QUESTION. `cand <
        // live` accuses a candidate holding FEWER bundles and waves through one holding the same
        // number - so a reload that drops six and a mint that adds six is invisible to the very
        // detector written for it. That is not hypothetical: measured on the Mi 9T that day,
        // `reconcilePublishedKeyPackages` printed `REFUSED to purge 6/50 prekey(s) this session
        // published itself` on two consecutive reconnections - six of the device's own mints
        // unbacked by the installed keystore - and this line did not print once. The downstream
        // symptom was visible and its cause was silent, which is exactly the shape that had the
        // backlog entry calling candidate 2 unobserved for two days.
        //
        // A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER: "how many" cannot
        // answer "which ones". The comparison is now a SET DIFFERENCE over the storage keys, so
        // what is reported is the bundles the live manager holds and the candidate does not -
        // a substitution included - and the two cardinalities go in the line beside it, because
        // `lost=6 live=50 loading=50` and `lost=6 live=50 loading=44` are different accidents.
        match (current.key_package_keys(), candidate.key_package_keys()) {
            (Ok(live), Ok(cand)) => {
                let lost = live.difference(&cand).count();
                if lost > 0 {
                    log::error!(
                        "[RESUME] reload DROPS KEY MATERIAL - {} key package bundle(s) the live                              keystore holds are ABSENT from the mls.bin being loaded (live={},                              loading={}; equal totals mean a SUBSTITUTION, not a shrink). Every group is                              at or ahead of its live epoch, so the epoch guard cannot see this. The lost                              bundles are packages this device may have PUBLISHED, and the reconciliation                              will read them back as server orphans and purge the pool (see backlog: the                              prekey purge loop). Accepted anyway - see the comment above for why refusing                              would be worse.",
                        lost,
                        live.len(),
                        cand.len()
                    );
                }
            }
            (Err(e), _) | (_, Err(e)) => log::warn!(
                "[RESUME] key material could not be enumerated across this reload ({e}) - the                      epoch guard still held, but nothing checked whether key packages were dropped."
            ),
        }
    }
    *live = Some(candidate);
    log::debug!("[RESUME] foreground manager reloaded from mls.bin (C2)");
    Ok(true)
}

/// Foreground heartbeat: refreshes the guard while the WebView is visible. As long as it stays
/// fresh, background JNI engines give up their `mls.bin` writes (C1/FCM3).
#[tauri::command]
pub(crate) fn mls_foreground_heartbeat() {
    mark_foreground_active();
}

/// Releases the foreground guard (moving to the background): immediately allows JNI engines to
/// write `mls.bin`. The guard would expire anyway after FOREGROUND_GRACE_MS; this speeds up the
/// clean case (`hidden` event received) so background delivery is not delayed.
#[tauri::command]
pub(crate) fn pause_mls_foreground() {
    crate::concurrency::mark_foreground_inactive();
}

#[tauri::command]
pub(crate) fn delete_mls_state(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("mls.bin");
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Reads {app_data_dir}/mls.bin and returns its encrypted contents.
/// Returns None when the file does not exist (first install).
/// Used at startup on mobile when localStorage is empty (WebView cleared).
#[tauri::command]
pub(crate) fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[MLS] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join("mls.bin");
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("[MLS] read mls.bin: {e}");
            None
        }
    }
}

/// Entries at the top of `{app_data_dir}` that this must NOT empty wholesale, for one of two
/// reasons: they belong to a framework, or Canari only owns part of what is inside (`files` and
/// `shared_prefs`, both emptied selectively below - and a first draft of this constant omitted
/// those two, which deleted Firebase's installation id and left both prefix lists dead code).
///
/// Everything else at that level is deleted, so the default for a file added tomorrow is ERASED.
/// The filter this replaced kept only `*.db`, which is why a device revoked on 2026-08-28 was
/// measured still holding `graine_seeds.json` - the seeds the background service decrypts push
/// payloads with - plus `channel_keys.json`, `push_context.json`, `fcm_token.txt` and
/// `session-meta.json`. None of them carries the one extension the filter could see, and every
/// one of them was added AFTER it: a wipe whose default is SURVIVE is wrong the day the next file
/// lands, and nothing tells you.
///
/// `app_webview` is the store the RUNNING WebView reads out of and `no_backup` holds
/// WorkManager's live database. Deleting either from under its owner is the process-killing
/// mistake that already cost this wipe every step after its first; they are cleared through
/// their own APIs instead - the WebView stores by `deviceReset.ts`, measured empty the same day.
const KEPT_AT_TOP_LEVEL: &[&str] = &[
    "app_textures",
    "app_webview",
    "cache",
    "code_cache",
    "databases",
    "lib",
    "no_backup",
    // Shared with Firebase - emptied by prefix, not wholesale.
    "files",
    "shared_prefs",
];

/// Names inside `{app_data_dir}/files`, a directory Canari SHARES with Firebase, that are ours.
/// `avatar_<hash>.jpg` is written by `CanariFirebaseMessagingService` so a notification can show
/// a face: cached photographs of real people, which is exactly what a revocation must not leave.
const OUR_FILES_PREFIXES: &[&str] = &["avatar_"];

/// Names inside `{app_data_dir}/shared_prefs` that are ours. `keystore_aliases.xml` is spelled
/// out because it carries no `canari_` prefix: it maps the MLS device-key aliases, so leaving it
/// behind leaves a revoked device the index of its own keys.
const OUR_PREFS_PREFIXES: &[&str] = &["canari_", "keystore_aliases"];

/// Erases every trace of the account this device held, natively.
///
/// Pairs with the WebView half in `deviceReset.ts`: this owns the native app data directory,
/// that one owns the stores inside the engine. Both are best-effort by design, so a single
/// unremovable entry must not abandon the rest - each failure is logged and carried, and the
/// error returned at the end names how many there were.
#[tauri::command]
pub(crate) fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    wipe_app_data(&data_dir)
}

/// The whole of `clear_app_data` minus the `AppHandle`, so it can be tested against a real
/// directory. A wipe is the one operation whose bug is invisible until someone reads the disk.
pub(crate) fn wipe_app_data(data_dir: &std::path::Path) -> Result<(), String> {
    if !data_dir.exists() {
        log::debug!("[RESET] no native app data directory - nothing to wipe");
        return Ok(());
    }
    let mut removed = 0usize;
    let mut failures = 0usize;

    match std::fs::read_dir(data_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        log::warn!("[RESET] unreadable entry in the app data directory: {e}");
                        failures += 1;
                        continue;
                    }
                };
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                if KEPT_AT_TOP_LEVEL.contains(&name.as_str()) {
                    log::debug!("[RESET] leaving {name} to its owner");
                    continue;
                }
                remove_entry(&path, &mut removed, &mut failures);
            }
        }
        Err(e) => return Err(format!("read the app data directory: {e}")),
    }

    wipe_by_prefix(
        &data_dir.join("files"),
        OUR_FILES_PREFIXES,
        &mut removed,
        &mut failures,
    );
    wipe_by_prefix(
        &data_dir.join("shared_prefs"),
        OUR_PREFS_PREFIXES,
        &mut removed,
        &mut failures,
    );

    log::info!("[RESET] native wipe removed {removed} entries, {failures} failed");
    if failures == 0 {
        Ok(())
    } else {
        Err(format!("{failures} native entries could not be removed"))
    }
}

/// Deletes the entries of `dir` whose name starts with one of `prefixes`, for the two
/// directories Canari shares with a framework and therefore cannot empty wholesale.
fn wipe_by_prefix(
    dir: &std::path::Path,
    prefixes: &[&str],
    removed: &mut usize,
    failures: &mut usize,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("[RESET] read {}: {e}", dir.display());
            *failures += 1;
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if prefixes.iter().any(|p| name.starts_with(p)) {
            remove_entry(&path, removed, failures);
        }
    }
}

/// Removes one file or directory tree, counting the outcome. Logs at a level that ACCUSES on
/// failure: what a wipe leaves behind is only ever found by reading the disk afterwards.
fn remove_entry(path: &std::path::Path, removed: &mut usize, failures: &mut usize) {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Ok(()) => *removed += 1,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::error!("[RESET] could not remove {}: {e}", path.display());
            *failures += 1;
        }
    }
}

/// Stores a boolean flag in {app_data_dir}/native_flags.json.
/// Used to persist UI flags (e.g. biometric enrollment) outside the WebView
/// storage layer, which MIUI and other aggressive OEMs may clear between sessions.
#[tauri::command]
pub(crate) fn set_native_flag(
    key: String,
    value: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("native_flags.json");
    let mut flags: serde_json::Map<String, serde_json::Value> = if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    flags.insert(key, serde_json::Value::Bool(value));
    std::fs::write(&path, serde_json::Value::Object(flags).to_string()).map_err(|e| e.to_string())
}

/// Removes one flag from `native_flags.json`, deleting the file when nothing is left in it.
///
/// `set_native_flag(key, false)` says the same thing to every READER - `get_native_flags` cannot
/// tell an absent key from a `false` one - but not on disk, and that difference is load-bearing
/// exactly once. The device wipe runs `BiometricService.forget` as its LAST step, by a rule and a
/// guard test, which is AFTER `clear_app_data`: a flag written there re-creates the file the wipe
/// had just deleted, and a criterion reading the disk then has to carve out an exception for it.
/// Exceptions in a wipe's criterion are how this one stayed broken twice.
#[tauri::command]
pub(crate) fn remove_native_flag(key: String, app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    remove_flag(&data_dir, &key)
}

/// `remove_native_flag` minus the `AppHandle`, so the file it must NOT recreate can be tested.
fn remove_flag(data_dir: &std::path::Path, key: &str) -> Result<(), String> {
    let path = data_dir.join("native_flags.json");
    if !path.exists() {
        log::debug!("[Flags] no native_flags.json - {key} is already absent");
        return Ok(());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut flags: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&bytes).unwrap_or_default();
    if flags.remove(key).is_none() {
        return Ok(());
    }
    if flags.is_empty() {
        log::debug!("[Flags] {key} was the last flag - removing native_flags.json");
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    } else {
        std::fs::write(&path, serde_json::Value::Object(flags).to_string())
            .map_err(|e| e.to_string())
    }
}

/// Name of the file `CanariApplication.onCreate` (Kotlin) writes the installing package
/// name into. Cross-process contract with the Android side - pinned by
/// `frontend/src/lib/mobile/installerPackageContract.test.ts`, which is the only thing
/// standing between a rename here and a reader that silently finds nothing.
const INSTALLER_PACKAGE_FILE: &str = "installer_package.txt";

/// Reads the package that installed this app, as recorded by the Android side at startup
/// (`com.android.vending` for Google Play, something else or empty for a sideload).
///
/// The frontend needs this because the Play build and the GitHub APK carry DIFFERENT
/// signatures - neither can install over the other - so the update destination depends on
/// how this install actually arrived. Returns `None` off Android, and whenever the file is
/// missing or empty; the caller decides what an unknown source means.
#[tauri::command]
pub(crate) fn get_installer_package(app: tauri::AppHandle) -> Option<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[Installer] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join(INSTALLER_PACKAGE_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::debug!("[Installer] {INSTALLER_PACKAGE_FILE} unreadable: {e}");
            return None;
        }
    };
    let installer = raw.trim();
    if installer.is_empty() {
        log::debug!("[Installer] no installing package recorded (sideload or adb install)");
        return None;
    }
    log::debug!("[Installer] installing package: {installer}");
    Some(installer.to_string())
}

/// Bucketed disk usage of `{app_data_dir}`, for the Settings storage panel (WP-DEVICESTORAGE-1).
#[derive(serde::Serialize)]
pub(crate) struct LocalStorageUsage {
    /// The local message database: `canari_<userId>.db` plus its WAL/SHM side files, counted by
    /// substring rather than by extension. Those side files can hold a meaningful fraction of
    /// what SQLite has on disk while a write-ahead log is active, so a size REPORT that matched
    /// only `.db` would understate the total - which is exactly the reading `clear_app_data` used
    /// to make when it DELETED by extension, and how `mls_pending.db-wal` outlived a wipe.
    messages_bytes: u64,
    /// `mls.bin` - the MLS encryption state. Reported separately and must NEVER be offered as
    /// part of a "clear cache" action: it is identity and key material, not a cache.
    encryption_state_bytes: u64,
    /// Everything else in the app data directory (outbox mirror, FCM cache, push context, native
    /// flags, the installer-package marker) - individually tiny, lumped together on purpose
    /// rather than growing this struct one field per file.
    other_bytes: u64,
}

/// Walks `{app_data_dir}` once and buckets every file's size. Read-only - pairs with the
/// JS-side Cache Storage measurement (media/avatar/logo caches), which this command knows
/// nothing about since those live inside the WebView, not the native app data directory.
#[tauri::command]
pub(crate) fn get_local_storage_usage(app: tauri::AppHandle) -> Result<LocalStorageUsage, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut usage = LocalStorageUsage {
        messages_bytes: 0,
        encryption_state_bytes: 0,
        other_bytes: 0,
    };
    if !data_dir.exists() {
        return Ok(usage);
    }
    for entry in std::fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "mls.bin" {
            usage.encryption_state_bytes += size;
        } else if name.starts_with("canari_") && name.contains(".db") {
            usage.messages_bytes += size;
        } else {
            usage.other_bytes += size;
        }
    }
    Ok(usage)
}

/// Reads all boolean flags from {app_data_dir}/native_flags.json.
/// Returns an empty object if the file does not exist yet.
#[tauri::command]
pub(crate) fn get_native_flags(app: tauri::AppHandle) -> serde_json::Value {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[Flags] app_data_dir() failed: {e}");
            return serde_json::Value::Object(serde_json::Map::new());
        }
    };
    let path = data_dir.join("native_flags.json");
    if !path.exists() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// A device key that is 32 bytes, base64, and constant - the reload takes it as text.
    const DEV_KEY_B64: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    /// Writes `manager`'s encrypted state to `path`, the way a mint's final step does.
    fn persist(manager: &MlsManager, path: &Path) {
        let key = mls_core::crypto::decode_base64_to_32_bytes(DEV_KEY_B64).unwrap();
        std::fs::write(path, manager.save_encrypted_with_key(&key).unwrap()).unwrap();
    }

    /// THE RACE OF 2026-09-08, AS THE ONE PROPERTY THAT WOULD HAVE PREVENTED IT.
    ///
    /// The defect was not that the reload installed a stale snapshot - given a stale snapshot it is
    /// still correct to install it and accuse, and that is tested in `mls-core`. The defect was that
    /// the snapshot was READ before the manager lock was taken, so a mint holding that lock could
    /// finish, persist, and still be overwritten by bytes read before it began. Ten bundles the
    /// server already held were erased from the keystore that way, on the Mi 9T, at 18:02:09.
    ///
    /// **WHAT THIS TEST DOES AND DOES NOT GUARD, STATED PLAINLY.** It would NOT have caught the
    /// original defect, and claiming otherwise would be worth less than saying so: the mistake lived
    /// in the CALLER's sequencing, and a unit test cannot observe which of two locks a caller takes
    /// first. That half is now a compile-time property instead - `reload_into` is unreachable
    /// without a `&mut Option<MlsManager>`, and the only source of one is the held guard.
    ///
    /// What this pins is the half that makes the compile-time property worth anything: the bytes are
    /// fetched INSIDE the guarded call, so whatever `mls.bin` holds at the moment of the call is what
    /// wins. Move the read back into the command - reading first and passing bytes in, which is
    /// exactly how the defect was written - and the signature changes, this test stops compiling, and
    /// the regression is refused at the door rather than measured on a phone six weeks later.
    #[test]
    fn the_snapshot_is_read_when_the_call_is_made_so_a_completed_mint_cannot_be_overwritten() {
        let dir = temp_dir("resume-read");
        let path = dir.join("mls.bin");

        // The state as it stood before the mint, persisted first - the bytes the old code read.
        let before = MlsManager::load_or_create("u-resume", "d1", None).unwrap();
        persist(&before, &path);
        let stale_keys = before.key_package_keys().unwrap();

        // The mint, completing while the reload would have been in flight: same device, twelve new
        // bundles, persisted over the same file.
        let key = mls_core::crypto::decode_base64_to_32_bytes(DEV_KEY_B64).unwrap();
        let minted =
            MlsManager::load_with_key("u-resume", "d1", Some(std::fs::read(&path).unwrap()), &key)
                .unwrap();
        minted.generate_key_packages(12).unwrap();
        persist(&minted, &path);
        let minted_keys = minted.key_package_keys().unwrap();
        assert!(
            minted_keys.len() > stale_keys.len(),
            "the fixture must actually add key material"
        );

        let mut live: Option<MlsManager> = Some(before);
        let reloaded = reload_into(&mut live, &path, "u-resume", "d1", DEV_KEY_B64).unwrap();
        assert!(reloaded, "a present mls.bin must reload");

        let installed = live.as_ref().unwrap().key_package_keys().unwrap();
        let lost: Vec<_> = minted_keys.difference(&installed).collect();
        assert!(
            lost.is_empty(),
            "{} bundle(s) the completed mint persisted are absent from the installed keystore -              the snapshot was read before the call rather than during it",
            lost.len()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-wipe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(dir: &Path, rel: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    /// The measurement of 2026-08-28, as a test: a revoked device kept its Graine seeds, its
    /// channel keys, its push session and its FCM token, because none of them ends in `.db`.
    /// Against the extension filter this replaced, exactly ONE of these names disappeared.
    #[test]
    fn erases_what_a_revocation_must_not_leave() {
        let dir = temp_dir("revoked");
        for name in [
            "graine_seeds.json",
            "channel_keys.json",
            "push_context.json",
            "session-meta.json",
            "oidc-state.json",
            "fcm_token.txt",
            "keystore_ok.flag",
            "native_flags.json",
            "installer_package.txt",
            "mls.bin",
            "mls_pending.db",
            "mls_pending.db-wal",
            "mls_pending.db-shm",
            "canari_user.db",
        ] {
            file(&dir, name);
        }
        file(&dir, "logs/app.log");

        wipe_app_data(&dir).unwrap();

        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.is_empty(), "the wipe left {left:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The other half of the same rule: a wipe that deletes the store its own engine is reading
    /// out of kills the process, and every step after it becomes collateral.
    #[test]
    fn leaves_the_stores_their_owners_are_still_reading() {
        let dir = temp_dir("owners");
        file(&dir, "app_webview/Default/Local Storage/leveldb/CURRENT");
        file(&dir, "no_backup/androidx.work.workdb");
        file(&dir, "cache/WebView/blob");
        file(&dir, "code_cache/x");
        file(&dir, "app_textures/x");
        file(&dir, "databases/x");
        file(&dir, "graine_seeds.json");

        wipe_app_data(&dir).unwrap();

        assert!(dir
            .join("app_webview/Default/Local Storage/leveldb/CURRENT")
            .exists());
        assert!(dir.join("no_backup/androidx.work.workdb").exists());
        assert!(dir.join("cache/WebView/blob").exists());
        assert!(dir.join("code_cache/x").exists());
        assert!(dir.join("app_textures/x").exists());
        assert!(dir.join("databases/x").exists());
        assert!(!dir.join("graine_seeds.json").exists(), "ours was kept");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `files/` and `shared_prefs/` are shared with Firebase, so they are the two directories
    /// this cannot empty wholesale - and the two where a prefix list can go stale silently.
    #[test]
    fn empties_only_our_share_of_the_two_shared_directories() {
        let dir = temp_dir("shared");
        file(&dir, "files/avatar_deadbeef.jpg");
        file(&dir, "files/PersistedInstallation.W0RFRkFVTFRd.json");
        file(&dir, "files/generatefid.lock");
        file(&dir, "shared_prefs/keystore_aliases.xml");
        file(&dir, "shared_prefs/canari_push_prefs.xml");
        file(&dir, "shared_prefs/canari_notif_ids.xml");
        file(&dir, "shared_prefs/com.google.android.gms.appid.xml");
        file(&dir, "shared_prefs/WebViewChromiumPrefs.xml");

        wipe_app_data(&dir).unwrap();

        assert!(
            !dir.join("files/avatar_deadbeef.jpg").exists(),
            "a cached face survived"
        );
        assert!(
            !dir.join("shared_prefs/keystore_aliases.xml").exists(),
            "the alias index survived"
        );
        assert!(!dir.join("shared_prefs/canari_push_prefs.xml").exists());
        assert!(!dir.join("shared_prefs/canari_notif_ids.xml").exists());
        assert!(dir
            .join("files/PersistedInstallation.W0RFRkFVTFRd.json")
            .exists());
        assert!(dir.join("files/generatefid.lock").exists());
        assert!(dir
            .join("shared_prefs/com.google.android.gms.appid.xml")
            .exists());
        assert!(dir.join("shared_prefs/WebViewChromiumPrefs.xml").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reason `remove_native_flag` exists rather than `set_native_flag(key, false)`: the wipe's
    /// LAST step must not put back the file the wipe deleted.
    #[test]
    fn removing_the_last_flag_removes_the_file() {
        let dir = temp_dir("flags");
        let path = dir.join("native_flags.json");
        std::fs::write(&path, br#"{"biometricConfigured":true}"#).unwrap();

        remove_flag(&dir, "biometricConfigured").unwrap();

        assert!(!path.exists(), "the file survived its last flag");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// And it must not take the OTHER flags with it - `biometricPromptDismissed` lives in the same
    /// file and is written by a different call site.
    #[test]
    fn removing_one_flag_keeps_the_others() {
        let dir = temp_dir("flags-kept");
        let path = dir.join("native_flags.json");
        std::fs::write(
            &path,
            br#"{"biometricConfigured":true,"biometricPromptDismissed":true}"#,
        )
        .unwrap();

        remove_flag(&dir, "biometricConfigured").unwrap();

        let left: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            left["biometricPromptDismissed"],
            serde_json::Value::Bool(true)
        );
        assert!(left.get("biometricConfigured").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A wipe that already deleted the file calls this anyway, and it must not recreate it.
    #[test]
    fn removing_a_flag_from_nothing_creates_nothing() {
        let dir = temp_dir("flags-gone");
        remove_flag(&dir, "biometricConfigured").unwrap();
        assert!(!dir.join("native_flags.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fresh install has neither directory, and a wipe with nothing to do is not a failure -
    /// `deviceReset.ts` runs this on the login page, where there may never have been an account.
    #[test]
    fn nothing_to_wipe_is_not_a_failure() {
        let dir = temp_dir("empty");
        wipe_app_data(&dir).unwrap();
        wipe_app_data(&dir.join("never-existed")).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
