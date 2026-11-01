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
//! - `nse_inflight.<pid>.<n>.json` - written when a notification starts, removed when its line is
//!   appended. A marker whose process no longer exists is a run that never reached either exit: the
//!   process was KILLED (memory, a crash). That is the one outcome the extension cannot write
//!   itself, and it is decided here by a proof - `kill(pid, 0)` answering `ESRCH` - never by an age.
//! - `nse_outcomes.lock` - `flock`ed by both sides around every edit, so a line appended while the
//!   app takes the file is never lost between the read and the removal.
//!
//! **WHAT A LINE MAY CARRY.** Outcome codes, a stage name, timings, a memory footprint and the size
//! of the MLS state: never text, a name, a user, device, group or message id. The writer is built
//! that way and this reader enforces it again with an allowlist ([`ALLOWED_KEYS`]), so a writer
//! mistake cannot carry content into an exported log.

// Everything but the command is reached only on iOS (and by the host tests).
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::path::Path;

/// The outcome lines, newest last.
pub(crate) const OUTCOMES_FILE: &str = "nse_outcomes.ndjson";
/// The previous generation, written by the extension's rotation.
pub(crate) const ROTATED_FILE: &str = "nse_outcomes.1.ndjson";
/// The cross-process lock both sides `flock`.
pub(crate) const LOCK_FILE: &str = "nse_outcomes.lock";
/// Prefix of a run's in-flight marker: `nse_inflight.<pid>.<n>.json`.
pub(crate) const INFLIGHT_PREFIX: &str = "nse_inflight.";
/// The size past which the extension rotates the outcome file (twin of `NseOutcomeLog.rotateBytes`).
pub(crate) const ROTATE_BYTES: u64 = 32 * 1024;
/// At most this many lines are handed to the page per drain, the newest kept.
pub(crate) const MAX_LINES: usize = 400;

/// The keys a line may carry. Anything else is dropped here, whatever the writer put there.
const ALLOWED_KEYS: &[&str] = &[
    "v", "at", "kind", "outcome", "cause", "stage", "ms", "peakMB", "stateKB", "pid",
];

/// Keeps only the allowed keys of one line, with scalar values, and re-serialises it. `None` for a
/// line that is not a JSON object (a torn write from a killed writer reads as nothing, not as text).
pub(crate) fn sanitize_line(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let object = value.as_object()?;
    let mut kept = serde_json::Map::new();
    for key in ALLOWED_KEYS {
        if let Some(v) = object.get(*key) {
            let scalar = match v {
                serde_json::Value::String(s) if s.len() <= 64 => true,
                serde_json::Value::Number(_) | serde_json::Value::Bool(_) => true,
                _ => false,
            };
            if scalar {
                kept.insert((*key).to_string(), v.clone());
            }
        }
    }
    if !kept.contains_key("outcome") {
        return None;
    }
    Some(serde_json::Value::Object(kept).to_string())
}

/// The pid a marker's name carries (`nse_inflight.<pid>.<n>.json`).
pub(crate) fn marker_pid(name: &str) -> Option<i32> {
    let rest = name.strip_prefix(INFLIGHT_PREFIX)?.strip_suffix(".json")?;
    rest.split('.').next()?.parse().ok()
}

/// The line a dead run's marker becomes: the marker's own fields, with `outcome: killed`.
fn killed_line(marker: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(marker.trim()).ok()?;
    let object = value.as_object_mut()?;
    object.insert("outcome".to_string(), serde_json::json!("killed"));
    sanitize_line(&value.to_string())
}

/// Takes every outcome line and every dead run's marker out of `dir`, oldest first.
///
/// `is_dead(pid)` answers whether that process is PROVEN gone; a marker of a live (or unknowable)
/// process stays for a later drain. The caller holds the lock; this only reads and removes.
pub(crate) fn take_locked(dir: &Path, is_dead: &dyn Fn(i32) -> bool) -> Vec<String> {
    log::debug!("[NSE_OUTCOME] taking the outcome log");
    let mut lines = Vec::new();
    for name in [ROTATED_FILE, OUTCOMES_FILE] {
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
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::error!("[NSE_OUTCOME] App Group directory not listed: {e}");
            return lines;
        }
    };
    let mut killed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = marker_pid(&name) else {
            continue;
        };
        if !is_dead(pid) {
            continue;
        }
        match std::fs::read_to_string(entry.path()) {
            Ok(text) => match killed_line(&text) {
                Some(line) => killed.push(line),
                None => log::warn!("[NSE_OUTCOME] a dead run's marker was unreadable - counted as killed with no detail"),
            },
            Err(e) => log::warn!("[NSE_OUTCOME] a dead run's marker could not be read: {e}"),
        }
        if let Err(e) = std::fs::remove_file(entry.path()) {
            log::error!("[NSE_OUTCOME] a dead run's marker NOT removed: {e}");
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

/// Whether `pid` is PROVEN not to exist: `kill(pid, 0)` failing with `ESRCH`. A live process, or one
/// this sandbox may not signal (`EPERM`), is not proven gone.
#[cfg(unix)]
pub(crate) fn process_is_gone(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; it only asks the kernel whether the process exists.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Takes the lock file's exclusive `flock`, runs `body`, releases it.
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
        match with_lock(&dir, || take_locked(&dir, &process_is_gone)) {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nse_outcomes_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("temp dir");
        d
    }

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
    }

    #[test]
    fn a_long_string_value_is_dropped_not_truncated() {
        let long = "x".repeat(65);
        let kept =
            sanitize_line(&format!(r#"{{"outcome":"decrypted","cause":"{long}"}}"#)).expect("kept");
        assert!(!kept.contains("cause"), "{kept}");
    }

    #[test]
    fn the_pid_is_read_from_the_marker_name() {
        assert_eq!(marker_pid("nse_inflight.4242.7.json"), Some(4242));
        assert_eq!(marker_pid("nse_inflight.x.7.json"), None);
        assert_eq!(marker_pid("fcm_message_cache.ndjson"), None);
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
        let lines = take_locked(&d, &|_| false);
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
            r#"{"v":1,"at":5,"kind":"message","stage":"decrypt","peakMB":23}"#,
        )
        .unwrap();
        std::fs::write(
            &live,
            r#"{"v":1,"at":6,"kind":"message","stage":"load-state"}"#,
        )
        .unwrap();
        let lines = take_locked(&d, &|pid| pid == 111);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"outcome\":\"killed\""), "{}", lines[0]);
        assert!(lines[0].contains("\"stage\":\"decrypt\""), "{}", lines[0]);
        assert!(!dead.exists(), "the dead run's marker is consumed");
        assert!(
            live.exists(),
            "a run not proven dead is left for a later drain"
        );
    }

    #[test]
    fn this_process_is_not_gone_and_an_absurd_pid_is_not_proven_either() {
        assert!(!process_is_gone(std::process::id() as i32));
        assert!(!process_is_gone(0));
        assert!(!process_is_gone(-1));
    }

    #[test]
    fn the_lock_is_taken_and_released() {
        let d = dir("lock");
        assert_eq!(with_lock(&d, || 7).unwrap(), 7);
        assert_eq!(with_lock(&d, || 8).unwrap(), 8);
    }
}
