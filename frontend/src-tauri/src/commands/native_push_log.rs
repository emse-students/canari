//! The Android push service's warnings and errors, carried into the app's own log (2026-11-04).
//!
//! **WHY IT EXISTS.** The FCM service (`CanariFirebaseMessagingService`, tag `CanariFCM`) runs in a
//! process the WebView is usually not alive in, and it logs through `android.util.Log` - logcat only.
//! The in-app log a member exports is the WebView's console (`appLog.ts`), so every line that says
//! WHY a salon banner went up blind ("Quelqu'un" / "Nouveau message dans #salon") was invisible to
//! the one log a tester can send: a report arrived with a log holding nothing about it. This is the
//! Android counterpart of the iOS extension's outcome log (`nse_outcomes.rs`).
//!
//! **THE CONTRACT.** Kotlin's `NativePushLog` hands every WARN and ERROR line of the service to
//! [`append`] (JNI `nativeAppendPushLog`), already stamped and cut to one line. The page takes them
//! with [`take_native_push_log`] at login, at every resume and before an export
//! (`nativePushLog.ts`), and writes each through the console - so it is REDACTED BY THE SAME RULES
//! as every other line of the in-app log (`redactLogLine`) before anything is stored or exported.
//!
//! **BOUNDED BY SIZE, NEVER BY A CLOCK.** Two generations, [`LOG_FILE`] and [`ROTATED_FILE`]: past
//! [`ROTATE_BYTES`] the current one replaces the previous, so the pair never exceeds twice that. A
//! take reads the previous generation first, then the current, and removes both.
//!
//! **ONE PROCESS, ONE LOCK.** The service and the WebView live in the same Android process (no
//! `android:process` in the manifest), and both sides reach the files only through this module, so
//! one in-process mutex orders every append against every take: a line is either in the take or in
//! the next one, never lost between a read and a removal.

// Everything but the command is reached only on Android (and by the host tests).
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

/// The current generation, in the app data directory.
pub(crate) const LOG_FILE: &str = "native_push_log.txt";
/// The previous generation.
pub(crate) const ROTATED_FILE: &str = "native_push_log.1.txt";
/// The size at which the current generation is rotated. ~250 lines of 120 characters.
pub(crate) const ROTATE_BYTES: u64 = 32 * 1024;
/// The longest line kept, in characters - the in-app log's own cap (`MAX_LOG_LINE_CHARS`).
pub(crate) const MAX_LINE_CHARS: usize = 400;

/// Orders every append against every take (see the module comment).
static LOCK: Mutex<()> = Mutex::new(());

/// One line as it is stored: no line break inside it, at most [`MAX_LINE_CHARS`] characters.
fn one_line(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if flat.chars().count() <= MAX_LINE_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(MAX_LINE_CHARS).collect();
    format!("{cut}...")
}

/// Appends one line, rotating first when the current generation is full.
pub(crate) fn append(data_dir: &Path, line: &str) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = data_dir.join(LOG_FILE);
    let size = std::fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
    if size >= ROTATE_BYTES {
        std::fs::rename(&current, data_dir.join(ROTATED_FILE))
            .map_err(|e| format!("rotate: {e}"))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current)
        .map_err(|e| format!("open: {e}"))?;
    writeln!(file, "{}", one_line(line)).map_err(|e| format!("write: {e}"))
}

/// Every stored line, oldest first, and both generations removed. A generation that cannot be read
/// is said and LEFT in place, so the next take tries it again.
pub(crate) fn take(data_dir: &Path) -> Vec<String> {
    let _held = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut lines = Vec::new();
    for name in [ROTATED_FILE, LOG_FILE] {
        let path = data_dir.join(name);
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                lines.extend(text.lines().filter(|l| !l.is_empty()).map(str::to_string));
                if let Err(e) = std::fs::remove_file(&path) {
                    log::error!("[NATIVE_PUSH_LOG] {name} read and NOT removed - its lines come back next take: {e}");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                log::error!("[NATIVE_PUSH_LOG] {name} unreadable, left for the next take: {e}")
            }
        }
    }
    lines
}

/// The push service's WARN and ERROR lines since the last call, oldest first. Empty off Android,
/// where no such service exists.
///
/// Called by the page at login, at every resume and before an export (`nativePushLog.ts`), which
/// writes each line into the in-app log as `[NATIVE_PUSH] ...`.
#[tauri::command]
pub(crate) fn take_native_push_log(app: tauri::AppHandle) -> Vec<String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::error!("[NATIVE_PUSH_LOG] no app data dir - the push service's lines cannot be read: {e}");
                return vec![];
            }
        };
        let lines = take(&dir);
        log::info!("[NATIVE_PUSH_LOG] {} line(s) taken", lines.len());
        lines
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        log::debug!("[NATIVE_PUSH_LOG] not Android - no push service log, nothing to take");
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-npl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn a_take_returns_every_line_in_order_and_empties_the_log() {
        let dir = temp_dir("order");
        append(&dir, "first").unwrap();
        append(&dir, "second").unwrap();
        assert_eq!(take(&dir), vec!["first", "second"]);
        assert!(take(&dir).is_empty(), "a second take finds nothing");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_line_break_cannot_forge_a_second_line_and_a_long_line_is_cut() {
        let dir = temp_dir("one-line");
        append(&dir, "a\nE CanariFCM: forged").unwrap();
        append(&dir, &"x".repeat(MAX_LINE_CHARS + 50)).unwrap();
        let lines = take(&dir);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "a E CanariFCM: forged");
        assert_eq!(lines[1].chars().count(), MAX_LINE_CHARS + 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_pair_is_bounded_and_the_older_generation_comes_first() {
        let dir = temp_dir("bound");
        let line = "y".repeat(100);
        // Three generations' worth: the oldest is gone, the two newest are kept.
        let per_generation = (ROTATE_BYTES as usize / (line.len() + 1)) + 1;
        for i in 0..(3 * per_generation) {
            append(&dir, &format!("{i:06} {line}")).unwrap();
        }
        let total: u64 = [LOG_FILE, ROTATED_FILE]
            .iter()
            .map(|f| std::fs::metadata(dir.join(f)).map(|m| m.len()).unwrap_or(0))
            .sum();
        assert!(
            total <= 2 * ROTATE_BYTES + 200,
            "the pair holds {total} bytes"
        );
        let lines = take(&dir);
        let numbers: Vec<usize> = lines.iter().map(|l| l[..6].parse().unwrap()).collect();
        assert!(numbers.windows(2).all(|w| w[0] < w[1]), "oldest first");
        assert_eq!(
            *numbers.last().unwrap(),
            3 * per_generation - 1,
            "the newest line is kept"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
