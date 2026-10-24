//! Storage Tauri commands: persistence, reload, heartbeat, flags.

use crate::concurrency::{
    foreground_checkpoint_lock, mark_foreground_active, mls_bin_write_lock, write_mls_state_blob,
};
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

/// What a resume reload did, and WHY when it did nothing - a TYPE, because the caller must act
/// differently on each refusal and a `bool` made two of them look identical.
///
/// `LiveAhead` is the one with an obligation: the live manager holds a ratchet advance the file
/// does not, so the caller persists the live state (otherwise the NEXT resume refuses again and a
/// background engine starts from a file that is already behind). The other three owe nothing.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReloadOutcome {
    /// `mls.bin` was installed over the live manager.
    Reloaded,
    /// No `mls.bin` yet - nothing to reload.
    NothingOnDisk,
    /// The snapshot would move a live group to a LOWER epoch; the live state is kept.
    EpochRegression,
    /// The live manager sent, burnt or decrypted a frame no checkpoint holds; the live state is
    /// kept and must be persisted.
    LiveAhead,
}

/// C2: reloads `mls.bin` from disk into the in-memory foreground manager, under the global lock,
/// and marks the foreground active. Called on foreground return BEFORE any operation: while in the
/// background a JNI engine (Welcome/send/worker) may have advanced `mls.bin`; without this reload
/// the hot manager is stale and its next persist would OVERWRITE the background advance
/// (lost-update -> SecretReuse + epoch regression). Returns a [`ReloadOutcome`]: installed, or the reason it was not. Callers are mobile-only (no background engine on desktop).
#[tauri::command]
pub(crate) async fn recharger_mls_au_resume(
    user_id: String,
    device_id: String,
    device_key_b64: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ReloadOutcome, String> {
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
        //
        // AND THE CHECKPOINT ORDER BEFORE BOTH (2026-10-13). A checkpoint now releases the manager
        // once it has exported, and the export clears `has_unsaved_ratchet_advance`: between that
        // export and its write, the live manager says it is not ahead of a file that is still
        // behind it. Waiting for the checkpoint's own lock is what keeps this read after its write
        // (`foreground_checkpoint_lock`, which also fixes the order of the three locks).
        reload_in_checkpoint_order(&manager_state, &path, &user_id, &device_id, &device_key_b64)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The resume reload's critical section, in the lock order the comment above sets out: the
/// checkpoint ordering lock, then the manager, then (inside [`reload_into`]) the file lock.
///
/// A function rather than inline so the ORDER is what the tests exercise: taking the manager without
/// the ordering lock first compiles, works whenever no checkpoint is mid-write, and reads a file the
/// in-flight checkpoint is about to replace while the live ratchet flag says nothing is owed.
fn reload_in_checkpoint_order(
    manager_state: &std::sync::Mutex<Option<MlsManager>>,
    path: &std::path::Path,
    user_id: &str,
    device_id: &str,
    device_key_b64: &str,
) -> Result<ReloadOutcome, String> {
    let _ordered = foreground_checkpoint_lock();
    let mut live = manager_state
        .lock()
        .map_err(|_| "Failed to lock state".to_string())?;
    reload_into(&mut live, path, user_id, device_id, device_key_b64)
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
) -> Result<ReloadOutcome, String> {
    // THE LIVE MANAGER IS ASKED FIRST WHETHER IT IS AHEAD OF THE FILE, before the file is even read.
    //
    // A frame this process sent, burnt or decrypted since the last serialisation moved a ratchet
    // GENERATION inside an epoch, and the newest `mls.bin` does not hold it. `reload_is_monotonic`
    // below grades epochs and accepts that snapshot, which installs a secret tree behind the live
    // one: measured on the Mi 9T 2026-09-08 09:53:16, generations 45 and 46 - already read - were
    // derived AGAIN 112 ms after the reload and the engine accepted them. A frame read twice is a
    // frame dropped once (the second read overwrites the first), and the next send re-issues a
    // generation the peers consumed.
    //
    // THE ANSWER IS READ HERE, UNDER THE MANAGER LOCK THE CALLER HOLDS, because that is the only
    // place a message arriving between "check" and "swap" cannot exist. The check this replaces
    // lived in the WebView and counted SENDS only: a receive moved nothing it could see, and a
    // frame decrypted after it ran was still overwritten. The reload is REFUSED rather than merged
    // (the background advance it exists to rescue is lost to a persist of the live state, as it
    // already was for a send): the caller persists the live state, which closes the gap for good.
    if live
        .as_ref()
        .is_some_and(MlsManager::has_unsaved_ratchet_advance)
    {
        log::warn!(
            "[RESUME] reload REFUSED - the live manager holds a ratchet advance (a send or a decrypted frame) that no checkpoint has captured; installing mls.bin would put the secret tree BACK. The caller must persist the live state."
        );
        if let Some(current) = live.as_ref() {
            report_what_keeping_the_live_state_loses(
                current,
                path,
                user_id,
                device_id,
                device_key_b64,
            );
        }
        return Ok(ReloadOutcome::LiveAhead);
    }
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
        return Ok(ReloadOutcome::NothingOnDisk);
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
            report_what_a_live_persist_erases(current, &candidate);
            if let Some(dir) = path.parent() {
                report_background_stages(dir, current);
            }
            return Ok(ReloadOutcome::EpochRegression);
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
    if let Some(dir) = path.parent() {
        report_background_stages(dir, &candidate);
    }
    *live = Some(candidate);
    log::debug!("[RESUME] foreground manager reloaded from mls.bin (C2)");
    Ok(ReloadOutcome::Reloaded)
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

/// Deletes `mls.bin` and, with it, the record of whose state it was ([`MLS_STATE_OWNER_FILE`]) -
/// an owner left beside no state would name an account this install no longer holds anything of.
#[tauri::command]
pub(crate) fn delete_mls_state(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    remove_mls_state_in(&data_dir)
}

/// The memo of background Welcomes the server refused as stale, keyed by the digest of `mls.bin`
/// (`mobile/background.rs`). It describes `mls.bin`, so it leaves with it.
pub(crate) const STALE_WELCOME_LEDGER_FILE: &str = "welcome_request_stale.json";

/// A push key-group join's staged post-join state beside `mls.bin` (`mobile/key_group_join.rs`). It
/// holds that state's epoch secrets, so it leaves with `mls.bin`. Named here, not in the module that
/// writes it, because that module is not compiled on desktop and this sweep is.
pub(crate) const STAGED_KEY_GROUP_JOIN_FILE: &str = "mls.bin.keygroup-join";

/// The ledger of key-group joins the push service attempted (`mobile/key_group_join.rs`). Its
/// `joined` entries name groups installed in THIS `mls.bin`, which the next start writes into the
/// registry - so it leaves with `mls.bin`, or the next account to sign in would adopt them.
pub(crate) const KEY_GROUP_PUSH_JOIN_LEDGER_FILE: &str = "key_group_push_joins.json";

/// The background Welcome stages written into `mls.bin` and not yet settled by the engine that wrote
/// them (`mobile/background.rs`): `{groupId: {"baseEpoch"}}`. The foreground's next load reports
/// each against the state it then holds ([`report_background_stages`]), so a stage left to the
/// foreground is either seen settled or seen GONE - never silently lost. It describes `mls.bin`, so it
/// leaves with it.
pub(crate) const BACKGROUND_STAGES_FILE: &str = "background_stages.json";

/// Runs `edit` on the JSON-object ledger `file_name` beside `mls.bin`, under the process-wide
/// `mls.bin` write lock (every FCM thread shares that process), writing it back by rename when
/// `edit` says it changed. An absent or unparsable ledger reads as empty, and the unparsable one is
/// said. The caller must NOT hold the write lock.
pub(crate) fn with_json_ledger<R>(
    data_dir: &std::path::Path,
    file_name: &str,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> (R, bool),
) -> Result<R, String> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    edit_json_ledger_held(data_dir, file_name, edit)
}

/// [`with_json_ledger`] for a caller that ALREADY HOLDS [`mls_bin_write_lock`] - the background
/// Welcome, which notes its stage under the same hold as the `mls.bin` write that stages it.
pub(crate) fn edit_json_ledger_held<R>(
    data_dir: &std::path::Path,
    file_name: &str,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> (R, bool),
) -> Result<R, String> {
    let path = data_dir.join(file_name);
    let mut map = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => {
                log::warn!("[MLS] ledger {file_name} unparsable - read as empty");
                serde_json::Map::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("read {file_name}: {e}")),
    };
    let (result, changed) = edit(&mut map);
    if changed {
        let tmp = data_dir.join(format!("{file_name}.tmp"));
        std::fs::write(&tmp, serde_json::Value::Object(map).to_string())
            .map_err(|e| format!("write {file_name}: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename {file_name}: {e}"))?;
    }
    Ok(result)
}

/// What [`report_background_stages`] found, one count per verdict.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StagesReport {
    pub found: usize,
    pub merged: usize,
    pub absent: usize,
}

/// Reports every background Welcome stage the ledger names against `held`, the state this
/// foreground now keeps, and forgets them: FOUND (its staged commit and record are there - the
/// foreground settles it by resubmission), ALREADY MERGED (the group is past its base), or ABSENT
/// (said at ERROR: an Add the server may hold is not on this device, and the replay recovers it).
/// Returns what was reported.
pub(crate) fn report_background_stages(
    data_dir: &std::path::Path,
    held: &MlsManager,
) -> StagesReport {
    use mls_core::pending_submission::PendingSubmissionRead;
    let reported = with_json_ledger(data_dir, BACKGROUND_STAGES_FILE, |map| {
        let mut report = StagesReport::default();
        if map.is_empty() {
            return (report, false);
        }
        for (group_id, entry) in map.iter() {
            let short: String = group_id.chars().take(8).collect();
            let base = entry.get("baseEpoch").and_then(serde_json::Value::as_u64);
            let found = matches!(
                held.pending_submission(group_id),
                PendingSubmissionRead::Recorded(ref r) if Some(r.base_epoch) == base
            );
            if found {
                report.found += 1;
                log::info!(
                    "[MLS] background stage of group={short} (base {base:?}) found in the loaded state - settled by resubmission"
                );
                continue;
            }
            match (held.get_epoch(group_id), base) {
                (Ok(epoch), Some(b)) if epoch > b => {
                    report.merged += 1;
                    log::info!(
                        "[MLS] background stage of group={short} (base {b}) already merged (epoch {epoch})"
                    );
                }
                (epoch, _) => {
                    report.absent += 1;
                    log::error!(
                        "[MLS] background stage of group={short} (base {base:?}) is ABSENT from the state this foreground keeps (epoch {:?}) - an Add the server may hold is not on this device; the replay recovers it",
                        epoch.ok()
                    );
                }
            }
        }
        map.clear();
        (report, true)
    });
    reported.unwrap_or_else(|e| {
        log::error!("[MLS] background stage ledger unreadable ({e}) - its stages are not reported");
        StagesReport::default()
    })
}

/// What persisting `live` over the file `candidate` was read from ERASES, said at ERROR before the
/// persist: the groups whose file copy holds a staged commit the live one does not, and the groups
/// the file holds at a later epoch (or holds and the live one does not). Counts and group prefixes
/// only. Returns the two counts.
pub(crate) fn report_what_a_live_persist_erases(
    live: &MlsManager,
    candidate: &MlsManager,
) -> (usize, usize) {
    let short = |g: &String| g.chars().take(8).collect::<String>();
    let mut staged = Vec::new();
    let mut later = Vec::new();
    for group_id in candidate.get_known_groups() {
        if matches!(candidate.has_pending_commit(&group_id), Ok(true))
            && !matches!(live.has_pending_commit(&group_id), Ok(true))
        {
            staged.push(short(&group_id));
        }
        match (candidate.get_epoch(&group_id), live.get_epoch(&group_id)) {
            (Ok(file), Ok(kept)) if file > kept => later.push(short(&group_id)),
            (Ok(_), Err(_)) => later.push(short(&group_id)),
            _ => {}
        }
    }
    if !staged.is_empty() || !later.is_empty() {
        log::error!(
            "[RESUME] persisting the live state ERASES what mls.bin holds beyond it: {} staged commit(s) {:?}, {} group(s) at a later epoch {:?}",
            staged.len(),
            staged,
            later.len(),
            later
        );
    }
    (staged.len(), later.len())
}

/// The reports a refused reload owes before the live state is persisted over `path`: what the file
/// holds beyond the live state ([`report_what_a_live_persist_erases`]), and the background stages
/// the live state does not hold ([`report_background_stages`]). It reads and decrypts the file,
/// which only a refused reload pays, and only when the stages ledger names a stage. A failure to
/// read is said, and nothing else is affected.
fn report_what_keeping_the_live_state_loses(
    current: &MlsManager,
    path: &std::path::Path,
    user_id: &str,
    device_id: &str,
    device_key_b64: &str,
) {
    // Only a background stage left in the file makes this report worth decrypting the whole
    // `mls.bin`: without one, a refused reload loses nothing a background engine wrote.
    let Some(dir) = path.parent() else {
        return;
    };
    match with_json_ledger(dir, BACKGROUND_STAGES_FILE, |map| (map.is_empty(), false)) {
        Ok(true) => {
            log::debug!("[RESUME] no background stage noted - what the persist erases is not read");
            return;
        }
        Ok(false) => {}
        Err(e) => log::warn!(
            "[RESUME] background stage ledger unreadable ({e}) - mls.bin is read to report what the persist erases"
        ),
    }
    let bytes = {
        let Ok(_guard) = mls_bin_write_lock().lock() else {
            log::error!(
                "[RESUME] mls_bin write lock poisoned - what the persist erases is not reported"
            );
            return;
        };
        match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                log::error!(
                    "[RESUME] mls.bin unreadable ({e}) - what the persist erases is not reported"
                );
                return;
            }
        }
    };
    let candidate = mls_core::crypto::decode_base64_to_32_bytes(device_key_b64)
        .map_err(|e| e.to_string())
        .and_then(|key| {
            MlsManager::load_with_key(user_id, device_id, Some(bytes), &key)
                .map_err(|e| e.to_string())
        });
    match candidate {
        Ok(candidate) => {
            report_what_a_live_persist_erases(current, &candidate);
        }
        Err(e) => log::error!(
            "[RESUME] mls.bin does not open ({e}) - what the persist erases is not reported"
        ),
    }
    report_background_stages(dir, current);
}

/// [`delete_mls_state`] minus the `AppHandle`, so what it removes is tested on a real directory:
/// `mls.bin`, its owner record, and the ledgers and push-join files built from it - no epoch secret
/// outlives the state it belongs to.
fn remove_mls_state_in(data_dir: &std::path::Path) -> Result<(), String> {
    log::debug!("[MLS] removing mls.bin and what was built from it");
    // `mls.bin` GOES AFTER WHAT WAS BUILT FROM IT: the staged join and the ledgers describe it, so a
    // sweep that fails part-way leaves the state intact and the next reset finishes the job - never
    // staged epoch secrets, or a memo about a digest, beside no state...
    // ...and the owner record AFTER it: a failed removal of `mls.bin` leaves the state with the
    // record naming whose it is, never a state nobody is named for.
    // UNDER THE `mls.bin` WRITE LOCK: a background Welcome writes its stage and notes it under one
    // hold of that lock, so the sweep removes both or neither - never a ledger it re-creates after.
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    let stale_ledger_tmp = format!("{STALE_WELCOME_LEDGER_FILE}.tmp");
    let join_staged_tmp = format!("{STAGED_KEY_GROUP_JOIN_FILE}.tmp");
    let join_ledger_tmp = format!("{KEY_GROUP_PUSH_JOIN_LEDGER_FILE}.tmp");
    let stages_tmp = format!("{BACKGROUND_STAGES_FILE}.tmp");
    let owner_tmp = format!("{MLS_STATE_OWNER_FILE}.tmp");
    for name in [
        STALE_WELCOME_LEDGER_FILE,
        stale_ledger_tmp.as_str(),
        STAGED_KEY_GROUP_JOIN_FILE,
        join_staged_tmp.as_str(),
        KEY_GROUP_PUSH_JOIN_LEDGER_FILE,
        join_ledger_tmp.as_str(),
        BACKGROUND_STAGES_FILE,
        stages_tmp.as_str(),
        "mls.bin",
        MLS_STATE_OWNER_FILE,
        owner_tmp.as_str(),
    ] {
        let path = data_dir.join(name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove {name}: {e}"))?;
        }
    }
    Ok(())
}

/// The file beside `mls.bin` naming the account whose state it is.
///
/// **`mls.bin` IS ONE FILE PER INSTALL, AND NOTHING IN IT SAYS WHOSE IT IS WITHOUT OPENING IT.** When
/// account B signs in on a phone that holds account A's state, B's key cannot open A's blob, and the
/// gate used to read that exactly like a PIN rotated elsewhere or a damaged state - and offered the
/// reset, which deletes A's state. With this record the gate can say "another account's messages are
/// here" and withhold the reset (`TauriMlsService._initImpl`, `device_holds_other_account`).
///
/// Written ONLY by [`write_mls_state_owner`] after `initialiser_mls` LOADED or created a state for
/// that account - the credential check in `load_or_create` is what proves the state is that
/// account's - so a record can never name an account whose state was not opened under it.
pub(crate) const MLS_STATE_OWNER_FILE: &str = "mls.owner";

/// Records `user_id` as the owner of `mls.bin` ([`MLS_STATE_OWNER_FILE`]). Atomic (tmp + rename), so a
/// reader sees the old owner or the new one, never a torn name. Skipped when it already says so.
pub(crate) fn write_mls_state_owner(app: &tauri::AppHandle, user_id: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    record_mls_state_owner(&data_dir, user_id)
}

/// [`write_mls_state_owner`] minus the `AppHandle`, testable on a real directory.
fn record_mls_state_owner(data_dir: &std::path::Path, user_id: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join(MLS_STATE_OWNER_FILE);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(user_id) {
        return Ok(());
    }
    let tmp = data_dir.join(format!("{MLS_STATE_OWNER_FILE}.tmp"));
    std::fs::write(&tmp, user_id).map_err(|e| format!("write {MLS_STATE_OWNER_FILE}.tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {MLS_STATE_OWNER_FILE}: {e}"))?;
    log::info!("[MLS] mls.bin owner recorded");
    Ok(())
}

/// The account `mls.bin` was last opened for ([`MLS_STATE_OWNER_FILE`]), `None` when nothing was
/// ever recorded - an install whose state predates the record, or a first install. `None` is
/// ABSENCE OF PROOF and the frontend treats it so: it never claims the state is another account's.
#[tauri::command]
pub(crate) fn mls_state_owner(app: tauri::AppHandle) -> Option<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[MLS] app_data_dir() failed: {e}");
            return None;
        }
    };
    read_mls_state_owner(&data_dir)
}

/// [`mls_state_owner`] minus the `AppHandle`, testable on a real directory.
fn read_mls_state_owner(data_dir: &std::path::Path) -> Option<String> {
    match std::fs::read_to_string(data_dir.join(MLS_STATE_OWNER_FILE)) {
        Ok(owner) if !owner.is_empty() => Some(owner),
        Ok(_) => {
            log::warn!("[MLS] {MLS_STATE_OWNER_FILE} is empty - read as no owner recorded");
            None
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("[MLS] read {MLS_STATE_OWNER_FILE}: {e}");
            None
        }
    }
}

/// Reads {app_data_dir}/mls.bin and returns its encrypted contents.
/// Returns None when the file does not exist (first install).
///
/// THE SHARED READER, AND THE REASON IT IS ONE. `initialiser_mls` needs these same bytes, and
/// until 2026-09-15 it got them by having the FRONTEND read them through the command below and
/// hand them straight back - 8 MB across the IPC bridge twice, as a JSON array of per-byte
/// numbers. Measured on a Pixel 6a: 29 074 883 characters of JSON per crossing, 908 ms of main
/// thread warm, and a 2 731 ms block on a cold launch that the fingerprint prompt waited out,
/// because the prompt is raised by an `invoke` queued behind it. Two callers, one read, no bridge.
pub(crate) fn read_mls_state_blob(app: &tauri::AppHandle) -> Option<Vec<u8>> {
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

/// The frontend's view of the reader above.
///
/// STILL NEEDED, AND BY EXACTLY ONE FLOW: old-PIN recovery hands the blob to `openLocalStateWithKey`,
/// which re-seals it in the frontend. The LOGIN path no longer calls it - see
/// [`read_mls_state_blob`] for what that cost - and neither does anything that only wants to know
/// whether a state exists, which is what [`mls_state_size`] answers.
#[tauri::command]
pub(crate) fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
    read_mls_state_blob(&app)
}

/// Whether `mls.bin` at `path` is PROVABLY absent: `Ok(true)` when the file does not exist or is
/// empty, `Ok(false)` when it holds bytes, `Err` when the filesystem could not say.
///
/// THE ALLOWLIST OF A DESTRUCTIVE DECISION. A device whose id survived but whose state did not
/// re-enrols under a new id and retires the old one; only a state KNOWN to be gone may start that.
/// [`mls_state_size`] answers 0 on an unreadable directory too, which is right for "is there
/// something to load" and wrong for this, so the error stays an error here.
pub(crate) fn state_file_absent(path: &std::path::Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(m) => Ok(m.len() == 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("stat mls.bin: {e}")),
    }
}

/// The frontend's view of [`state_file_absent`] for this install's `mls.bin`.
#[tauri::command]
pub(crate) fn mls_state_absent(app: tauri::AppHandle) -> Result<bool, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let absent = state_file_absent(&data_dir.join("mls.bin"));
    log::debug!("[MLS] mls.bin provably absent: {absent:?}");
    absent
}

/// The SIZE of {app_data_dir}/mls.bin, 0 when there is none.
///
/// "Is there a saved state" is a question three call sites asked by loading the whole file: the
/// login path, which then handed the bytes straight back to Rust, and two that only tested them
/// for truthiness. It is one `metadata()` syscall, and a number that crosses the bridge as a
/// number.
#[tauri::command]
pub(crate) fn mls_state_size(app: tauri::AppHandle) -> u64 {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[MLS] app_data_dir() failed: {e}");
            return 0;
        }
    };
    match std::fs::metadata(data_dir.join("mls.bin")) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            log::warn!("[MLS] stat mls.bin: {e}");
            0
        }
    }
}

/// Entries at the top of `{app_data_dir}` that this must NOT empty wholesale, for one of three
/// reasons: they belong to a framework, Canari only owns part of what is inside (`files` and
/// `shared_prefs`, both emptied selectively below - and a first draft of this constant omitted
/// those two, which deleted Firebase's installation id and left both prefix lists dead code), or the
/// entry is an order a reset would move backwards (`share_epoch`).
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
    // The sign-out's two push marks (`push_registration.rs`). A revoked device is wiped right after
    // its sign-out wrote them, and the wipe must not undo the sign-out: without them the deletion
    // of the OS push token is no longer owed, and a push that still arrives is no longer dropped.
    crate::commands::push_registration::SIGNED_OUT_FILE,
    crate::commands::push_registration::DELETION_OWED_FILE,
    // Shared with Firebase - emptied by prefix, not wholesale.
    "files",
    "shared_prefs",
    // The share EPOCH is an ORDER that never moves back (`commands/handoff.rs`): reset to 0 here, a
    // share captured before the wipe - on iOS, stamped from the App Group copy this wipe never
    // reaches - would read as NEWER than the current session and be offered to the next account.
    // It names no account and holds no secret.
    "share_epoch",
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
    let wiped = wipe_app_data(&data_dir);
    // The mirrored names also live in the iOS App Group container, which the walk above never
    // reaches. Same policy as the account deletion: no container is logged at ERROR and returned,
    // after everything else was removed.
    #[cfg(target_os = "ios")]
    {
        // The names copy, and the share the Share Extension left there - its manifest and its
        // copies - which no sign-out reaches if nobody signed in (`app_group_share`).
        let group = crate::app_group::app_group_dir().and_then(|g| {
            let names = wipe_group_names(&g);
            let share = crate::commands::app_group_share::wipe_group_share(&g);
            match (names, share) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(a), Err(b)) => Err(format!("{a}; {b}")),
                (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            }
        });
        if let Err(e) = group {
            log::error!("[RESET] the App Group was not entirely wiped: {e}");
            return match wiped {
                Ok(()) => Err(e),
                Err(w) => Err(format!("{w}; {e}")),
            };
        }
    }
    wiped
}

/// Removes the App Group copy of `display_names.json`. A factory wipe forgets every account, so
/// unlike the account deletion it is owner-agnostic. Only that file: the other App Group copies
/// (`push_context.json`, the extension's caches) are not this wipe's today, see the backlog.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
pub(crate) fn wipe_group_names(group: &std::path::Path) -> Result<(), String> {
    let (mut removed, mut failures) = (0usize, 0usize);
    remove_entry(
        &group.join(crate::commands::display_names::DISPLAY_NAMES_FILE),
        &mut removed,
        &mut failures,
    );
    log::info!("[RESET] App Group names copy: {removed} removed, {failures} failed");
    if failures == 0 {
        Ok(())
    } else {
        Err("the App Group names copy could not be removed".to_string())
    }
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

/// The directory `tauri-plugin-sql` opens `sqlite:<name>` under, resolved the SAME way it does.
///
/// tauri-plugin-sql 2.4 (`wrapper.rs`, `DbPool::connect`) joins the file name onto
/// `app.path().app_config_dir()` - NOT `app_data_dir()`. The two are one directory on Windows and
/// macOS and differ on Linux (`~/.config` vs `~/.local/share`), so a delete under `app_data_dir()`
/// "removed 0 files" there and reported success while the database stayed. Re-read that function
/// before changing this one, and on every bump of the plugin.
fn sql_plugin_db_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Deletes ONE account's local message database - `canari_<userId>.db` and its WAL/SHM side files -
/// and nothing else: not `mls.bin` (one file per install, which may belong to another account), not
/// another account's database. The account-deletion path calls it after closing the SQLite handle.
///
/// `expect_database` is set when the caller KNOWS the database exists (a store was open for that
/// account in this run): finding no file then is a failure, not "nothing to do". Returns how many
/// files were removed.
#[tauri::command]
pub(crate) fn delete_user_database(
    app: tauri::AppHandle,
    user_id: String,
    expect_database: bool,
) -> Result<usize, String> {
    let db_dir = sql_plugin_db_dir(&app)?;
    remove_user_database(&db_dir, &user_id, expect_database)
}

/// Whether `user_id` may name a database file: `[A-Za-z0-9_.@-]`, 1 to 255 characters - the SAME
/// allowlist as the frontend's `isWipeableAccountId` (`accountLocalKeys.ts`).
///
/// The id is the MiConnect `sub`, which may be a UUID, a hash, a username or an email, hence `.` and
/// `@`. A path separator is what could make "this account's database" name something else, and it is
/// outside the set; `..` inside `canari_<id>.db` is an ordinary file name, never a parent.
pub(crate) fn is_wipeable_account_id(user_id: &str) -> bool {
    !user_id.is_empty()
        && user_id.len() <= 255
        && user_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '@'))
}

/// The whole of `delete_user_database` minus the `AppHandle`, so it runs against a real directory.
///
/// An id outside the allowlist is REFUSED rather than sanitised: a sanitised id names another file.
pub(crate) fn remove_user_database(
    db_dir: &std::path::Path,
    user_id: &str,
    expect_database: bool,
) -> Result<usize, String> {
    if !is_wipeable_account_id(user_id) {
        log::error!("[DEL-LOCAL] refusing a user id outside the allowlist");
        return Err("invalid user id".to_string());
    }
    let main_existed = db_dir.join(format!("canari_{user_id}.db")).exists();
    let mut removed = 0usize;
    let mut failures = 0usize;
    for suffix in ["", "-wal", "-shm"] {
        let path = db_dir.join(format!("canari_{user_id}.db{suffix}"));
        remove_entry(&path, &mut removed, &mut failures);
    }
    log::info!(
        "[DEL-LOCAL] removed {removed} database file(s) under {}, {failures} failed",
        db_dir.display()
    );
    if failures > 0 {
        return Err(format!("{failures} database file(s) could not be removed"));
    }
    if expect_database && !main_existed {
        log::error!(
            "[DEL-LOCAL] a database was expected under {} and none was there - nothing removed",
            db_dir.display()
        );
        return Err("no database where the SQL plugin keeps it".to_string());
    }
    Ok(removed)
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
pub(crate) fn remove_entry(path: &std::path::Path, removed: &mut usize, failures: &mut usize) {
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

    /// Only a missing or empty file is "absent"; a file with bytes is not.
    #[test]
    fn state_file_absent_is_true_only_for_a_missing_or_empty_file() {
        let dir = std::env::temp_dir().join(format!("canari-absent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mls.bin");
        let _ = std::fs::remove_file(&path);
        assert_eq!(state_file_absent(&path), Ok(true));
        std::fs::write(&path, b"").unwrap();
        assert_eq!(state_file_absent(&path), Ok(true));
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(state_file_absent(&path), Ok(false));
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
        assert_eq!(
            reloaded,
            ReloadOutcome::Reloaded,
            "a present mls.bin must reload"
        );

        let installed = live.as_ref().unwrap().key_package_keys().unwrap();
        let lost: Vec<_> = minted_keys.difference(&installed).collect();
        assert!(
            lost.is_empty(),
            "{} bundle(s) the completed mint persisted are absent from the installed keystore -              the snapshot was read before the call rather than during it",
            lost.len()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// THE RECEIVE HALF OF THE RESUME REWIND (RESUME-B-1), AT THE COMMAND'S OWN SEAM.
    ///
    /// The live manager read a frame after `mls.bin` was written. The file holds every group at the
    /// same epoch, so the epoch guard accepts it - and installing it would let the spent generation
    /// decrypt a second time. The reload must refuse with `LiveAhead` (so the caller persists), keep
    /// the live ratchet, and after that persist a reload is allowed again.
    #[test]
    fn a_reload_is_refused_while_the_live_manager_holds_an_unsaved_receive() {
        let dir = temp_dir("resume-ahead");
        let path = dir.join("mls.bin");
        let gid = "g-resume-ahead";

        let mut alice = MlsManager::load_or_create("u-ra-alice", "d1", None).unwrap();
        let mut bob = MlsManager::load_or_create("u-ra-bob", "d1", None).unwrap();
        alice.create_group(gid.to_string()).unwrap();
        let kp = bob.generate_key_package().unwrap();
        let (_, welcome, _, _) = alice.add_members_bulk(gid, &[&kp]).unwrap();
        alice.merge_pending_commit_for(gid).unwrap();
        let tree = alice.export_ratchet_tree_for(gid).unwrap();
        bob.process_welcome(welcome.as_deref().unwrap(), Some(&tree))
            .unwrap();
        // The checkpoint on disk, then a frame read AFTER it.
        persist(&bob, &path);
        let frame = alice
            .send_message(gid, b"read after the checkpoint")
            .unwrap();
        bob.process_incoming_message(gid, &frame).unwrap();

        let mut live: Option<MlsManager> = Some(bob);
        let outcome = reload_into(&mut live, &path, "u-ra-bob", "d1", DEV_KEY_B64).unwrap();
        assert_eq!(outcome, ReloadOutcome::LiveAhead);
        assert!(
            live.as_mut()
                .unwrap()
                .process_incoming_message(gid, &frame)
                .is_err(),
            "the live ratchet must still know it spent that generation"
        );

        // The caller's obligation: persist the live state. Then a reload is safe and proceeds.
        persist(live.as_ref().unwrap(), &path);
        let outcome = reload_into(&mut live, &path, "u-ra-bob", "d1", DEV_KEY_B64).unwrap();
        assert_eq!(outcome, ReloadOutcome::Reloaded);
        assert!(
            live.as_mut()
                .unwrap()
                .process_incoming_message(gid, &frame)
                .is_err(),
            "the installed snapshot holds the spent generation"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// THE RESUME RELOAD WAITS FOR A CHECKPOINT THAT HAS EXPORTED BUT NOT WRITTEN (2026-10-13).
    ///
    /// The checkpoint releases the manager after its export, and the export cleared the ratchet
    /// flag: in that window the live manager says it is NOT ahead of `mls.bin`, while the file is
    /// still the one from before the frame. A reload taking only the manager lock would install that
    /// file and let the spent generation decrypt a second time. Taking the checkpoint's ordering lock
    /// first makes it wait for the write and read the file that holds the frame.
    #[test]
    fn a_resume_reload_waits_for_a_checkpoint_that_has_exported_but_not_written() {
        let _s = crate::concurrency::test_support::serialise();
        let dir = temp_dir("resume-mid-checkpoint");
        let path = dir.join("mls.bin");
        let (mut alice, mut bob, gid) = crate::concurrency::test_support::joined_pair("resume-mid");
        persist(&bob, &path); // the file from BEFORE the frame
        let frame = alice
            .send_message(&gid, b"read before the checkpoint")
            .unwrap();
        bob.process_incoming_message(&gid, &frame).unwrap();

        let live = std::sync::Arc::new(std::sync::Mutex::new(Some(bob)));
        let key = mls_core::crypto::decode_base64_to_32_bytes(DEV_KEY_B64).unwrap();
        let (in_write_tx, in_write_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let checkpoint = {
            let live = live.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                crate::concurrency::checkpoint_live_manager(&live, &key, |sealed| {
                    in_write_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    crate::concurrency::write_mls_bin_atomically(&path, sealed)
                })
            })
        };
        in_write_rx
            .recv()
            .expect("the checkpoint reached its write");

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let reload = {
            let live = live.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                let outcome =
                    reload_in_checkpoint_order(&live, &path, "resume-mid-bob", "d1", DEV_KEY_B64);
                done_tx.send(()).unwrap();
                outcome
            })
        };
        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_err(),
            "the reload ran while the checkpoint was still writing - it read the file from before the frame"
        );

        release_tx.send(()).unwrap();
        checkpoint.join().unwrap().unwrap();
        assert_eq!(reload.join().unwrap().unwrap(), ReloadOutcome::Reloaded);
        assert!(
            live.lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .process_incoming_message(&gid, &frame)
                .is_err(),
            "the installed state must hold the generation the frame spent"
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

    /// THE A -> B -> A RECORD (backlog "switching accounts on one iPhone"). The owner beside
    /// `mls.bin` is what lets B's gate say "another account's messages are here" instead of offering
    /// the reset that deletes them: it must name the LAST account a state was opened for, read back
    /// absent as `None` (absence of proof, never a claim), and leave with the state it describes.
    #[test]
    fn the_owner_beside_mls_bin_names_the_last_account_and_leaves_with_the_state() {
        let dir = temp_dir("mls-owner");
        assert_eq!(
            read_mls_state_owner(&dir),
            None,
            "no record on a first install"
        );

        record_mls_state_owner(&dir, "user-a").unwrap();
        assert_eq!(read_mls_state_owner(&dir).as_deref(), Some("user-a"));
        // Re-recording the same owner is a no-op, and a new one replaces it whole (tmp + rename).
        record_mls_state_owner(&dir, "user-a").unwrap();
        record_mls_state_owner(&dir, "user-b").unwrap();
        assert_eq!(read_mls_state_owner(&dir).as_deref(), Some("user-b"));
        assert!(
            !dir.join(format!("{MLS_STATE_OWNER_FILE}.tmp")).exists(),
            "the temporary file must not survive the rename"
        );

        // An empty record is not an owner.
        std::fs::write(dir.join(MLS_STATE_OWNER_FILE), b"").unwrap();
        assert_eq!(read_mls_state_owner(&dir), None);

        // The reset deletes the state AND the record: an owner left beside no state would withhold
        // a later reset over nothing.
        record_mls_state_owner(&dir, "user-a").unwrap();
        file(&dir, "mls.bin");
        remove_mls_state_in(&dir).unwrap();
        assert!(!dir.join("mls.bin").exists());
        assert_eq!(read_mls_state_owner(&dir), None);
        // And it is idempotent on an install that holds neither.
        remove_mls_state_in(&dir).unwrap();

        // A background Welcome's stale memo goes with the state it was built from.
        file(&dir, "mls.bin");
        file(&dir, "welcome_request_stale.json");
        file(&dir, "welcome_request_stale.json.tmp");
        file(&dir, "unrelated.json");
        remove_mls_state_in(&dir).unwrap();
        assert!(!dir.join("welcome_request_stale.json").exists());
        assert!(
            !dir.join("welcome_request_stale.json.tmp").exists(),
            "a ledger write cut before its rename leaves its tmp, which describes the same state"
        );
        assert!(
            dir.join("unrelated.json").exists(),
            "only what belongs to mls.bin"
        );

        // A push key-group join's staged state and its ledger go too: the stage holds epoch
        // secrets, and the ledger's `joined` entries would be adopted by the next account's start.
        file(&dir, "mls.bin");
        file(&dir, "mls.bin.keygroup-join");
        file(&dir, "mls.bin.keygroup-join.tmp");
        file(&dir, "key_group_push_joins.json");
        file(&dir, "key_group_push_joins.json.tmp");
        remove_mls_state_in(&dir).unwrap();
        for gone in [
            "mls.bin",
            "mls.bin.keygroup-join",
            "mls.bin.keygroup-join.tmp",
            "key_group_push_joins.json",
            "key_group_push_joins.json.tmp",
        ] {
            assert!(!dir.join(gone).exists(), "{gone} outlived the sign-out");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `mls.bin` GOES AFTER THE LEDGER: a sweep that fails part-way leaves the state it was
    /// sweeping intact, never a memo about a digest beside no state.
    #[test]
    fn a_sweep_that_fails_part_way_leaves_mls_bin_in_place() {
        let dir = temp_dir("mls-sweep-order");
        file(&dir, "mls.bin");
        record_mls_state_owner(&dir, "user-a").unwrap();
        // A ledger name that cannot be removed as a file: the sweep fails on it.
        std::fs::create_dir_all(dir.join("welcome_request_stale.json")).unwrap();

        assert!(remove_mls_state_in(&dir).is_err());
        assert!(
            dir.join("mls.bin").exists(),
            "the state outlives a sweep that did not finish"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// THE OWNER RECORD GOES AFTER `mls.bin`: a removal of `mls.bin` that fails leaves the state
    /// WITH its owner, never a state nobody is named for - which the gate would read like any
    /// other account's. Its temporary goes too.
    #[test]
    fn a_failed_mls_bin_removal_keeps_the_owner_record() {
        let dir = temp_dir("mls-owner-order");
        record_mls_state_owner(&dir, "user-a").unwrap();
        // A `mls.bin` that cannot be removed as a file.
        std::fs::create_dir_all(dir.join("mls.bin")).unwrap();
        file(&dir, "welcome_request_stale.json");

        assert!(remove_mls_state_in(&dir).is_err());
        assert_eq!(read_mls_state_owner(&dir).as_deref(), Some("user-a"));
        assert!(
            !dir.join("welcome_request_stale.json").exists(),
            "what was built from mls.bin still goes before it"
        );

        std::fs::remove_dir_all(dir.join("mls.bin")).unwrap();
        file(&dir, "mls.bin");
        file(&dir, &format!("{MLS_STATE_OWNER_FILE}.tmp"));
        remove_mls_state_in(&dir).unwrap();
        assert_eq!(read_mls_state_owner(&dir), None);
        assert!(!dir.join(format!("{MLS_STATE_OWNER_FILE}.tmp")).exists());
        std::fs::remove_dir_all(&dir).ok();
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

    /// The share epoch survives a wipe: a counter that restarted at 0 would make every share captured
    /// before it look current again.
    #[test]
    fn keeps_the_share_epoch_which_never_moves_back() {
        let dir = temp_dir("share-epoch");
        file(&dir, "share_epoch");
        file(&dir, "pending_share.json");

        wipe_app_data(&dir).unwrap();

        assert!(dir.join("share_epoch").exists(), "the epoch was reset");
        assert!(
            !dir.join("pending_share.json").exists(),
            "a waiting share survived"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A revoked device is signed out and then wiped. The wipe keeps the sign-out's two push marks:
    /// the OS token deletion stays owed until the native side completes it, and a push that still
    /// arrives stays dropped until a new registration is answered.
    #[test]
    fn keeps_the_marks_a_sign_out_wrote_for_the_push_registration() {
        use crate::commands::push_registration::{DELETION_OWED_FILE, SIGNED_OUT_FILE};
        let dir = temp_dir("push-marks");
        file(&dir, SIGNED_OUT_FILE);
        file(&dir, DELETION_OWED_FILE);
        file(&dir, "push_context.json");

        wipe_app_data(&dir).unwrap();

        assert!(
            dir.join(SIGNED_OUT_FILE).exists(),
            "the signed-out mark was wiped"
        );
        assert!(
            dir.join(DELETION_OWED_FILE).exists(),
            "the owed deletion was wiped"
        );
        assert!(!dir.join("push_context.json").exists());
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

    /// The factory wipe reaches the iOS App Group copy of the mirrored names, whoever owns it, and
    /// nothing else in that container.
    #[test]
    fn the_wipe_removes_the_app_group_names_copy_and_only_that() {
        let group = temp_dir("group-names");
        std::fs::write(
            group.join(crate::commands::display_names::DISPLAY_NAMES_FILE),
            br#"{"userId":"someone","names":{}}"#,
        )
        .unwrap();
        std::fs::write(group.join("push_context.json"), b"{}").unwrap();
        wipe_group_names(&group).unwrap();
        assert!(!group
            .join(crate::commands::display_names::DISPLAY_NAMES_FILE)
            .exists());
        assert!(group.join("push_context.json").exists());
        // Nothing to remove is a success, not a failure.
        wipe_group_names(&group).unwrap();
        std::fs::remove_dir_all(&group).ok();
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

    /// A deletion removes THAT account's database and its side files, and leaves another account's
    /// database and the per-install `mls.bin` exactly where they were.
    #[test]
    fn remove_user_database_touches_only_that_account() {
        let dir = std::env::temp_dir().join(format!("canari_del_local_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in [
            "canari_a.db",
            "canari_a.db-wal",
            "canari_a.db-shm",
            "canari_b.db",
            "canari_b.db-wal",
            "mls.bin",
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        assert_eq!(remove_user_database(&dir, "a", true).unwrap(), 3);
        assert!(!dir.join("canari_a.db").exists());
        assert!(!dir.join("canari_a.db-wal").exists());
        assert!(dir.join("canari_b.db").exists());
        assert!(dir.join("canari_b.db-wal").exists());
        assert!(dir.join("mls.bin").exists());
        // Idempotent when nothing is expected: a resumed wipe finds nothing and succeeds.
        assert_eq!(remove_user_database(&dir, "a", false).unwrap(), 0);
        // But nothing where a database was KNOWN to exist is the wrong directory: a failure.
        assert!(remove_user_database(&dir, "a", true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A MiConnect subject may be an email or carry dots: accepted, and only its own file goes.
    #[test]
    fn remove_user_database_accepts_an_email_like_id() {
        let dir =
            std::env::temp_dir().join(format!("canari_del_local_mail_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["canari_a.b@x.fr.db", "canari_a.db", "canari_b@x.fr.db"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        assert_eq!(remove_user_database(&dir, "a.b@x.fr", true).unwrap(), 1);
        assert!(!dir.join("canari_a.b@x.fr.db").exists());
        assert!(dir.join("canari_a.db").exists());
        assert!(dir.join("canari_b@x.fr.db").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An id that could leave the app data directory is refused, never sanitised.
    #[test]
    fn remove_user_database_refuses_a_path_like_id() {
        let dir = std::env::temp_dir();
        for bad in ["", "../x", "a/b", "a\\b", "a:b", "a b"] {
            assert!(remove_user_database(&dir, bad, false).is_err(), "{bad:?}");
        }
        assert!(remove_user_database(&dir, &"a".repeat(256), false).is_err());
    }
}
