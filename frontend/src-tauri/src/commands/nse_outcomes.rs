//! The iOS Notification Service Extension's outcome log, carried into the app's own log.
//!
//! **WHY IT EXISTS.** The extension runs in its own process and logs through `NSLog` only, so what
//! it did with a push - decrypted it, fell back to the generic text, ran out of time, or was killed -
//! was visible in Console.app on a Mac and nowhere a user's exported log could show it. A P1 (iPhone
//! notifications showing no content, 2026-11-01) arrived with a log holding nothing about it.
//!
//! **THE CONTRACT WITH `NotificationService.swift` (`NseOutcomeLog`), in the App Group container:**
//!
//! - `nse_outcomes.ndjson` - one JSON object per notification, appended when the extension hands
//!   its content back (`finish`) or when iOS asks it to stop (`serviceExtensionTimeWillExpire`).
//!   Rotated by the writer to `nse_outcomes.1.ndjson` past [`ROTATE_BYTES`], so the pair is bounded.
//! - `nse_inflight.<pid>.<n>.json` - written when a notification starts (stamped with the boot it
//!   ran in, `boot` = `kern.bootsessionuuid`), rewritten at each stage, removed when its line is
//!   written - in the log or as a done record. It NEVER carries an outcome. A marker whose
//!   process is PROVEN gone never reached either exit: the process was KILLED (memory, a crash).
//!   That is the one outcome the extension cannot write itself, decided here by a proof - a marker
//!   of another boot, or `kill(pid, 0)` answering `ESRCH` - never by an age.
//! - `nse_done.<pid>.<n>.json` - the extension NEVER WAITS for the lock on the path that hands the
//!   content back: when the app holds it, the run's line is written atomically under this name, and
//!   only then is its marker removed. A done file is an outcome line; it is consumed here like one,
//!   and a marker of the same run (`pid`, `at`) seen beside it is removed uncounted.
//! - `nse_outcomes.lock` - `flock`ed by both sides around every edit, so a line appended while the
//!   app takes the file is never lost between the read and the removal.
//!
//! **WHAT A LINE MAY CARRY.** Outcome codes, a stage name, timings, a memory footprint and the size
//! of the MLS state: never text, a name, a user, device, group or message id. The writer is built
//! that way and this reader enforces it again with a TYPED allowlist ([`allowed`]): numbers where
//! numbers are written, enums for the outcome and the stage, and a code token with no digit for the
//! kind and the cause - so a writer mistake cannot carry content, or an id, into an exported log.

// Everything but the command is reached only on iOS (and by the host tests).
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::collections::HashSet;
use std::path::Path;

/// The outcome lines, newest last.
pub(crate) const OUTCOMES_FILE: &str = "nse_outcomes.ndjson";
/// The previous generation, written by the extension's rotation.
pub(crate) const ROTATED_FILE: &str = "nse_outcomes.1.ndjson";
/// The cross-process lock both sides `flock`.
pub(crate) const LOCK_FILE: &str = "nse_outcomes.lock";
/// Prefix of a run's in-flight marker: `nse_inflight.<pid>.<n>.json`.
pub(crate) const INFLIGHT_PREFIX: &str = "nse_inflight.";
/// Prefix of a run's line left beside the log because its lock was held: `nse_done.<pid>.<n>.json`.
pub(crate) const DONE_PREFIX: &str = "nse_done.";
/// The size past which the extension rotates the outcome file (twin of `NseOutcomeLog.rotateBytes`).
pub(crate) const ROTATE_BYTES: u64 = 32 * 1024;
/// At most this many lines are handed to the page per drain, the newest kept.
pub(crate) const MAX_LINES: usize = 400;
/// At most this many in-flight markers are kept between drains; the oldest beyond it are removed,
/// with a warning, so a process this sandbox can never prove gone cannot grow the directory.
pub(crate) const MAX_MARKERS: usize = 64;

/// Every outcome a line may name (`killed` is written only by this reader).
const OUTCOMES: &[&str] = &[
    "decrypted",
    "fallback",
    "server-content",
    "call-blank",
    "expired",
    "killed",
];
/// Every stage a run may reach.
const STAGES: &[&str] = &[
    "start",
    "push-context",
    "fetch-proto",
    "load-state",
    "decrypt",
    "locality",
    "catchup",
    "attach",
];
/// The keys a line may carry, in the order they are re-serialised.
const ALLOWED_KEYS: &[&str] = &[
    "v", "at", "kind", "outcome", "cause", "stage", "ms", "peakMB", "stateKB", "pid",
];

/// A code token: `^[a-z0-9_-]+(;direct=[a-z0-9-]+)?$`, at most 64 bytes, and WITH NO DIGIT and not
/// shaped like a UUID. Every code the extension writes is made of letters and dashes; an id almost
/// always carries a digit, and the explicit UUID shape catches the one that does not.
fn is_code_token(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    let (head, tail) = match s.split_once(';') {
        Some((h, t)) => (h, Some(t)),
        None => (s, None),
    };
    let word = |w: &str, underscore: bool| {
        !w.is_empty()
            && w.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || (underscore && b == b'_')
            })
    };
    if !word(head, true) {
        return false;
    }
    if let Some(tail) = tail {
        match tail.strip_prefix("direct=") {
            Some(direct) if word(direct, false) => {}
            _ => return false,
        }
    }
    !s.bytes().any(|b| b.is_ascii_digit()) && !has_uuid_shape(s)
}

/// Whether `s` holds an 8-4-4-4-12 hex run, the shape of every id this app mints.
fn has_uuid_shape(s: &str) -> bool {
    s.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .any(|run| {
            let parts: Vec<&str> = run.split('-').collect();
            parts
                .windows(5)
                .any(|w| w.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]))
        })
}

/// The typed allowlist: whether `value` may be kept under `key`.
fn allowed(key: &str, value: &serde_json::Value) -> bool {
    match key {
        "v" | "at" | "ms" | "peakMB" | "stateKB" | "pid" => value.as_i64().is_some(),
        "outcome" => value.as_str().is_some_and(|s| OUTCOMES.contains(&s)),
        "stage" => value.as_str().is_some_and(|s| STAGES.contains(&s)),
        "kind" | "cause" => value.as_str().is_some_and(is_code_token),
        _ => false,
    }
}

/// Keeps only the allowed keys of one line, each with a value of its type, and re-serialises it.
/// `None` for a line that is not a JSON object or has no valid outcome (a torn write from a killed
/// writer reads as nothing, not as text).
pub(crate) fn sanitize_line(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let object = value.as_object()?;
    let mut kept = serde_json::Map::new();
    for key in ALLOWED_KEYS {
        if let Some(v) = object.get(*key) {
            if allowed(key, v) {
                kept.insert((*key).to_string(), v.clone());
            } else {
                log::warn!("[NSE_OUTCOME] key {key} dropped: its value is not of its type");
            }
        }
    }
    if !kept.contains_key("outcome") {
        return None;
    }
    Some(serde_json::Value::Object(kept).to_string())
}

/// The pid a run's file name carries (`<prefix><pid>.<n>.json`).
fn file_pid(name: &str, prefix: &str) -> Option<i32> {
    let rest = name.strip_prefix(prefix)?.strip_suffix(".json")?;
    rest.split('.').next()?.parse().ok()
}

/// The pid an in-flight marker's name carries (`nse_inflight.<pid>.<n>.json`).
pub(crate) fn marker_pid(name: &str) -> Option<i32> {
    file_pid(name, INFLIGHT_PREFIX)
}

/// A run's identity in a line: its pid and its start time. A killed candidate with the identity of a
/// line already taken is the same run, which DID write its outcome.
fn run_identity(line: &str) -> Option<(i64, i64)> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    Some((value.get("pid")?.as_i64()?, value.get("at")?.as_i64()?))
}

/// One in-flight marker read off the disk.
struct Marker {
    path: std::path::PathBuf,
    pid: i32,
    fields: Option<serde_json::Value>,
}

impl Marker {
    fn number(&self, key: &str) -> Option<i64> {
        self.fields.as_ref()?.get(key)?.as_i64()
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.fields.as_ref()?.get(key)?.as_str()
    }
}

/// The line a dead run's marker becomes: the marker's own fields, with `outcome: killed`.
fn killed_line(fields: &serde_json::Value) -> Option<String> {
    let mut value = fields.clone();
    value
        .as_object_mut()?
        .insert("outcome".to_string(), serde_json::json!("killed"));
    sanitize_line(&value.to_string())
}

/// Reads one outcome file into `lines` and removes it.
fn take_file(dir: &Path, name: &str, lines: &mut Vec<String>) {
    let path = dir.join(name);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let before = lines.len();
            lines.extend(text.lines().filter_map(sanitize_line));
            let dropped =
                text.lines().filter(|l| !l.trim().is_empty()).count() - (lines.len() - before);
            if dropped > 0 {
                log::warn!("[NSE_OUTCOME] {dropped} unreadable line(s) in {name} dropped");
            }
            if let Err(e) = std::fs::remove_file(&path) {
                log::error!(
                    "[NSE_OUTCOME] {name} read but NOT removed, it will be read again: {e}"
                );
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::error!("[NSE_OUTCOME] {name} unreadable: {e}"),
    }
}

/// What a removal found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Removed {
    /// Removed by this call.
    Done,
    /// Already gone: the extension removed or moved it between the listing and this call, which is
    /// its ordinary path (a run that wrote its line removes its own marker), not a failure.
    AlreadyGone,
    /// Still there: it will be met again.
    Failed,
}

pub(crate) fn remove(path: &Path, what: &str) -> Removed {
    match std::fs::remove_file(path) {
        Ok(()) => Removed::Done,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::debug!("[NSE_OUTCOME] {what} already moved by its run");
            Removed::AlreadyGone
        }
        Err(e) => {
            log::error!("[NSE_OUTCOME] {what} NOT removed: {e}");
            Removed::Failed
        }
    }
}

/// Takes every outcome line, every done file and every dead run's marker out of `dir`, oldest first.
///
/// A marker whose run's line was taken (same `pid` and `at`) is finished, alive or not, and is
/// removed uncounted. Otherwise it is dead when it was stamped in another boot session than `boot`
/// (both known, compared for EQUALITY), or when `is_dead(pid)` PROVES its process gone; a marker of
/// a live (or unknowable) process stays for a later drain, at most [`MAX_MARKERS`] of them. The
/// caller holds the lock.
pub(crate) fn take_locked(
    dir: &Path,
    is_dead: &dyn Fn(i32) -> bool,
    boot: Option<&str>,
) -> Vec<String> {
    log::debug!(
        "[NSE_OUTCOME] taking the outcome log boot_known={}",
        boot.is_some()
    );
    let mut lines = Vec::new();
    take_file(dir, ROTATED_FILE, &mut lines);
    take_file(dir, OUTCOMES_FILE, &mut lines);
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::error!("[NSE_OUTCOME] App Group directory not listed: {e}");
            return lines;
        }
    };
    let mut markers = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_pid(&name, DONE_PREFIX).is_some() {
            match std::fs::read_to_string(entry.path()) {
                Ok(text) => match sanitize_line(&text) {
                    Some(line) => lines.push(line),
                    None => log::warn!("[NSE_OUTCOME] a done record was unreadable - dropped"),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => log::warn!("[NSE_OUTCOME] a done record could not be read: {e}"),
            }
            remove(&entry.path(), "a done record");
            continue;
        }
        let Some(pid) = marker_pid(&name) else {
            continue;
        };
        let fields = std::fs::read_to_string(entry.path())
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(t.trim()).ok());
        markers.push(Marker {
            path: entry.path(),
            pid,
            fields,
        });
    }
    let taken: HashSet<(i64, i64)> = lines.iter().filter_map(|l| run_identity(l)).collect();
    let mut killed = Vec::new();
    let mut alive = Vec::new();
    for marker in markers {
        let identity = marker.number("at").map(|at| (i64::from(marker.pid), at));
        if identity.is_some_and(|id| taken.contains(&id)) {
            // Its run wrote its line and was removing this marker - the done path's own order.
            log::debug!("[NSE_OUTCOME] a marker beside its own outcome line - removed uncounted");
            remove(&marker.path, "a finished run's marker");
            continue;
        }
        let other_boot = boot
            .zip(marker.text("boot"))
            .is_some_and(|(now, then)| now != then);
        if !other_boot && !is_dead(marker.pid) {
            alive.push(marker);
            continue;
        }
        match marker.fields.as_ref().and_then(killed_line) {
            Some(line) => killed.push(line),
            None => log::warn!(
                "[NSE_OUTCOME] a dead run's marker was unreadable - its kill is not counted"
            ),
        }
        remove(&marker.path, "a dead run's marker");
    }
    if alive.len() > MAX_MARKERS {
        alive.sort_by_key(|m| m.number("at").unwrap_or(i64::MIN));
        let cut = alive.len() - MAX_MARKERS;
        log::warn!(
            "[NSE_OUTCOME] {cut} in-flight marker(s) beyond {MAX_MARKERS} never proven gone - the oldest removed uncounted"
        );
        for marker in alive.drain(..cut) {
            remove(&marker.path, "an excess marker");
        }
    }
    lines.extend(killed);
    if lines.len() > MAX_LINES {
        let cut = lines.len() - MAX_LINES;
        log::warn!("[NSE_OUTCOME] {cut} oldest line(s) beyond {MAX_LINES} not handed over");
        lines.drain(..cut);
    }
    lines
}

/// This boot's `kern.bootsessionuuid` - the stamp the extension writes into each marker
/// (`NseOutcomeLog.bootSession`), compared for EQUALITY. Not `kern.boottime`: Darwin recomputes it
/// when the clock is stepped, so a live run's marker would read as another boot's and be reported
/// `killed`. `None` when the kernel does not answer, which disables the boot proof only.
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub(crate) fn boot_session() -> Option<String> {
    let name = c"kern.bootsessionuuid";
    let mut size: libc::size_t = 0;
    // SAFETY: a size query - a null buffer and a valid out-pointer for the length.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 {
        log::warn!(
            "[NSE_OUTCOME] kern.bootsessionuuid unreadable - a marker from a previous boot is not proven dead: {}",
            std::io::Error::last_os_error()
        );
        return None;
    }
    let mut buffer = vec![0u8; size + 1];
    // SAFETY: a read into a buffer of `size + 1` bytes, its length passed alongside it.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        log::warn!(
            "[NSE_OUTCOME] kern.bootsessionuuid unreadable - a marker from a previous boot is not proven dead: {}",
            std::io::Error::last_os_error()
        );
        return None;
    }
    let session = std::ffi::CStr::from_bytes_until_nul(&buffer)
        .ok()?
        .to_str()
        .ok()?;
    (!session.is_empty()).then(|| session.to_owned())
}

/// Whether `pid` is PROVEN not to exist: `kill(pid, 0)` failing with `ESRCH`. A live process, or one
/// this sandbox may not signal (`EPERM`), is not proven gone.
#[cfg(unix)]
pub(crate) fn process_is_gone(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; it only asks the kernel whether the process exists.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return false;
    }
    let errno = std::io::Error::last_os_error().raw_os_error();
    if errno != Some(libc::ESRCH) {
        // EPERM here means the sandbox hides the answer, and every kill would go uncounted until the
        // boot proof or the marker cap takes the marker - said for every marker it cannot decide.
        log::warn!("[NSE_OUTCOME] pid liveness not provable errno={errno:?}");
    }
    errno == Some(libc::ESRCH)
}

/// Takes the lock file's exclusive `flock`, runs `body`, releases it. The app side may WAIT for it:
/// the extension never does (it leaves a done record instead), so no notification waits on the app.
#[cfg(unix)]
pub(crate) fn with_lock<T>(dir: &Path, body: impl FnOnce() -> T) -> Result<T, String> {
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))
        .map_err(|e| format!("lock file not opened: {e}"))?;
    // SAFETY: a plain flock on a descriptor this function owns; released when `file` drops.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(format!(
            "lock not taken: {}",
            std::io::Error::last_os_error()
        ));
    }
    let out = body();
    // SAFETY: as above; closing would release it too, this says so explicitly.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    Ok(out)
}

/// The extension's outcome lines since the last call, sanitised, oldest first - each one a JSON
/// object of codes and numbers. Empty off iOS, where no extension exists.
///
/// Called by the page at login and at every resume (`nseOutcomes.ts`), which writes each line into
/// the in-app log as `[NSE_OUTCOME] ...`.
#[tauri::command]
pub(crate) fn take_nse_outcomes() -> Vec<String> {
    #[cfg(target_os = "ios")]
    {
        let dir = match crate::app_group::app_group_dir() {
            Ok(d) => d,
            Err(e) => {
                log::error!("[NSE_OUTCOME] App Group unavailable - the extension's outcomes cannot be read: {e}");
                return vec![];
            }
        };
        let boot = boot_session();
        match with_lock(&dir, || {
            take_locked(&dir, &process_is_gone, boot.as_deref())
        }) {
            Ok(lines) => {
                log::info!("[NSE_OUTCOME] {} line(s) taken", lines.len());
                lines
            }
            Err(e) => {
                log::error!("[NSE_OUTCOME] not taken: {e}");
                vec![]
            }
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        log::debug!("[NSE_OUTCOME] not iOS - no extension, nothing to take");
        vec![]
    }
}

#[cfg(test)]
mod token_tests {
    use super::*;

    #[test]
    fn a_line_keeps_only_codes_and_numbers() {
        let line = r#"{"v":1,"outcome":"fallback","cause":"group-absent","ms":420,"body":"secret text","groupId":"abc","userId":"u"}"#;
        let kept = sanitize_line(line).expect("kept");
        assert!(!kept.contains("secret"), "{kept}");
        assert!(
            !kept.contains("groupId") && !kept.contains("userId"),
            "{kept}"
        );
        assert!(kept.contains("\"cause\":\"group-absent\""), "{kept}");
    }

    #[test]
    fn a_torn_or_outcomeless_line_reads_as_nothing() {
        assert_eq!(sanitize_line(r#"{"v":1,"outc"#), None);
        assert_eq!(sanitize_line(r#"{"v":1,"ms":3}"#), None);
        assert_eq!(sanitize_line("plain text"), None);
        assert_eq!(sanitize_line(r#"{"outcome":"something-else"}"#), None);
    }

    #[test]
    fn each_key_keeps_only_a_value_of_its_type() {
        let kept = sanitize_line(
            r#"{"v":"1","at":1.5,"ms":"fast","pid":7,"outcome":"expired","stage":"Somewhere","kind":"message","cause":"Decrypt failed"}"#,
        )
        .expect("kept");
        assert!(!kept.contains("\"v\"") && !kept.contains("\"at\"") && !kept.contains("\"ms\""));
        assert!(!kept.contains("stage") && !kept.contains("cause"), "{kept}");
        assert!(
            kept.contains("\"pid\":7") && kept.contains("\"kind\":\"message\""),
            "{kept}"
        );
    }

    #[test]
    fn a_uuid_shaped_value_is_never_kept_as_a_code() {
        let uuid = "3f2b8c1e-9a4d-4e7f-b6c2-0d1e2f3a4b5c";
        let all_letters = "abcdefab-cdef-abcd-efab-cdefabcdefab";
        for id in [uuid, all_letters] {
            for key in ["cause", "kind"] {
                let kept = sanitize_line(&format!(r#"{{"outcome":"fallback","{key}":"{id}"}}"#))
                    .expect("kept");
                assert!(!kept.contains(id), "{key}={id} kept: {kept}");
            }
            let direct = format!(r#"{{"outcome":"fallback","cause":"group-absent;direct={id}"}}"#);
            assert!(!sanitize_line(&direct).expect("kept").contains(id));
        }
    }

    #[test]
    fn the_codes_the_extension_writes_are_kept() {
        for cause in [
            "no-push-context",
            "locality-unknown;direct=mls-refused-for-good",
            "catchup-failed;direct=not-attempted",
            "no-outcome-set",
            "load-state",
        ] {
            assert!(is_code_token(cause), "{cause}");
        }
        assert!(is_code_token("call_ring") && is_code_token("form_reminder"));
        assert!(!is_code_token("group-absent;direct=a_b"));
        assert!(!is_code_token("cause;other=x"));
        assert!(!is_code_token(&"a".repeat(65)));
    }

    #[test]
    fn the_pid_is_read_from_the_marker_name() {
        assert_eq!(marker_pid("nse_inflight.4242.7.json"), Some(4242));
        assert_eq!(marker_pid("nse_inflight.x.7.json"), None);
        assert_eq!(marker_pid("fcm_message_cache.ndjson"), None);
        assert_eq!(file_pid("nse_done.31.2.json", DONE_PREFIX), Some(31));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOT: Option<&str> = Some("BOOT-A");

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nse_outcomes_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("temp dir");
        d
    }

    #[test]
    fn rotated_lines_come_first_and_both_files_are_removed() {
        let d = dir("order");
        std::fs::write(
            d.join(ROTATED_FILE),
            "{\"outcome\":\"decrypted\",\"at\":1}\n",
        )
        .unwrap();
        std::fs::write(
            d.join(OUTCOMES_FILE),
            "{\"outcome\":\"expired\",\"at\":2}\n",
        )
        .unwrap();
        let lines = take_locked(&d, &|_| false, BOOT);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("decrypted") && lines[1].contains("expired"));
        assert!(!d.join(ROTATED_FILE).exists() && !d.join(OUTCOMES_FILE).exists());
    }

    #[test]
    fn a_dead_runs_marker_becomes_a_killed_line_and_a_live_one_stays() {
        let d = dir("killed");
        let dead = d.join("nse_inflight.111.1.json");
        let live = d.join("nse_inflight.222.1.json");
        std::fs::write(
            &dead,
            r#"{"v":1,"at":5,"kind":"message","stage":"decrypt","peakMB":23,"pid":111,"boot":"BOOT-A"}"#,
        )
        .unwrap();
        std::fs::write(
            &live,
            r#"{"v":1,"at":6,"kind":"message","stage":"load-state","pid":222,"boot":"BOOT-A"}"#,
        )
        .unwrap();
        let lines = take_locked(&d, &|pid| pid == 111, BOOT);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"outcome\":\"killed\""), "{}", lines[0]);
        assert!(lines[0].contains("\"stage\":\"decrypt\""), "{}", lines[0]);
        assert!(!lines[0].contains("boot"), "{}", lines[0]);
        assert!(!dead.exists(), "the dead run's marker is consumed");
        assert!(
            live.exists(),
            "a run not proven dead is left for a later drain"
        );
    }

    #[test]
    fn a_marker_of_another_boot_is_dead_whoever_holds_its_pid_now() {
        let d = dir("boot");
        let old = d.join("nse_inflight.333.1.json");
        std::fs::write(
            &old,
            r#"{"v":1,"at":9,"kind":"message","stage":"decrypt","pid":333,"boot":"BOOT-B"}"#,
        )
        .unwrap();
        let lines = take_locked(&d, &|_| false, BOOT);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("killed"));
        assert!(!old.exists());
    }

    #[test]
    fn a_killed_candidate_whose_run_already_wrote_its_line_is_not_counted() {
        let d = dir("dedupe");
        std::fs::write(
            d.join(OUTCOMES_FILE),
            "{\"outcome\":\"expired\",\"stage\":\"decrypt\",\"at\":5,\"pid\":111}\n",
        )
        .unwrap();
        let marker = d.join("nse_inflight.111.1.json");
        std::fs::write(
            &marker,
            r#"{"v":1,"at":5,"stage":"decrypt","pid":111,"boot":"BOOT-A"}"#,
        )
        .unwrap();
        let lines = take_locked(&d, &|_| true, BOOT);
        assert_eq!(lines.len(), 1, "exactly one line for one run: {lines:?}");
        assert!(lines[0].contains("expired"));
        assert!(!marker.exists());
    }

    #[test]
    fn the_boot_proof_is_an_equality_and_needs_both_sides() {
        let d = dir("boot_eq");
        let same = d.join("nse_inflight.1.1.json");
        let unstamped = d.join("nse_inflight.2.1.json");
        let legacy = d.join("nse_inflight.3.1.json");
        std::fs::write(
            &same,
            r#"{"at":1,"stage":"decrypt","pid":1,"boot":"BOOT-A"}"#,
        )
        .unwrap();
        std::fs::write(&unstamped, r#"{"at":2,"stage":"decrypt","pid":2}"#).unwrap();
        // A number is not a session (a stamp of an earlier build): not proof of another boot.
        std::fs::write(&legacy, r#"{"at":3,"stage":"decrypt","pid":3,"boot":1000}"#).unwrap();
        assert!(take_locked(&d, &|_| false, BOOT).is_empty());
        assert!(same.exists() && unstamped.exists() && legacy.exists());
        // An unknown session on this side proves nothing either.
        std::fs::write(
            d.join("nse_inflight.4.1.json"),
            r#"{"at":4,"stage":"decrypt","pid":4,"boot":"BOOT-B"}"#,
        )
        .unwrap();
        assert!(take_locked(&d, &|_| false, None).is_empty());
        assert!(d.join("nse_inflight.4.1.json").exists());
    }

    #[test]
    fn a_done_record_beside_its_live_marker_is_one_line_and_the_marker_goes() {
        // The extension writes the done record, THEN removes its marker; a drain between the two
        // sees both while the process is still alive.
        let d = dir("done_race");
        std::fs::write(
            d.join("nse_done.77.1.json"),
            r#"{"v":1,"at":70,"outcome":"decrypted","stage":"attach","pid":77}"#,
        )
        .unwrap();
        let marker = d.join("nse_inflight.77.1.json");
        std::fs::write(
            &marker,
            r#"{"v":1,"at":70,"stage":"attach","pid":77,"boot":"BOOT-A"}"#,
        )
        .unwrap();
        let lines = take_locked(&d, &|_| false, BOOT);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("decrypted"));
        assert!(
            !marker.exists(),
            "a finished run's marker never lingers to be judged killed"
        );
        // ...and a later death of that pid finds nothing to call killed.
        assert!(take_locked(&d, &|_| true, BOOT).is_empty());
    }

    #[test]
    fn a_file_already_moved_by_its_run_is_not_a_failure() {
        let d = dir("enoent");
        assert_eq!(
            remove(&d.join("nse_inflight.5.1.json"), "a marker"),
            Removed::AlreadyGone
        );
        let present = d.join("nse_done.5.1.json");
        std::fs::write(&present, "{}").unwrap();
        assert_eq!(remove(&present, "a done record"), Removed::Done);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_boot_session_is_read_and_stable() {
        let first = boot_session().expect("kern.bootsessionuuid answers on macOS");
        assert_eq!(boot_session().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn a_done_record_is_an_outcome_line_and_is_consumed() {
        let d = dir("done");
        let done = d.join("nse_done.444.3.json");
        std::fs::write(
            &done,
            r#"{"v":1,"at":7,"outcome":"decrypted","stage":"attach","pid":444}"#,
        )
        .unwrap();
        let lines = take_locked(&d, &|_| false, BOOT);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("decrypted"));
        assert!(!done.exists());
    }

    #[test]
    fn markers_never_proven_gone_are_capped_oldest_first() {
        let d = dir("cap");
        for n in 0..(MAX_MARKERS + 3) {
            std::fs::write(
                d.join(format!("nse_inflight.9.{n}.json")),
                format!(r#"{{"v":1,"at":{n},"stage":"start","pid":9,"boot":"BOOT-A"}}"#),
            )
            .unwrap();
        }
        assert!(take_locked(&d, &|_| false, BOOT).is_empty());
        let left: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().collect();
        assert_eq!(left.len(), MAX_MARKERS);
        assert!(
            !d.join("nse_inflight.9.0.json").exists(),
            "the oldest went first"
        );
        assert!(d
            .join(format!("nse_inflight.9.{}.json", MAX_MARKERS + 2))
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn this_process_is_not_gone_and_an_absurd_pid_is_not_proven_either() {
        assert!(!process_is_gone(std::process::id() as i32));
        assert!(!process_is_gone(0));
        assert!(!process_is_gone(-1));
    }

    #[cfg(unix)]
    #[test]
    fn the_lock_is_taken_and_released() {
        let d = dir("lock");
        assert_eq!(with_lock(&d, || 7).unwrap(), 7);
        assert_eq!(with_lock(&d, || 8).unwrap(), 8);
    }
}
