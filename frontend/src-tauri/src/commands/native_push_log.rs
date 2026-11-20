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
//! **TWO STREAMS, TWO BUDGETS (2026-11-20).** The service also records ONE INFO line per
//! notification decision on purpose (`PushShowOutcome`, `FcmLog.iRecorded`). Those are many and
//! ordinary; the WARN and ERROR lines are few and are what this file exists for. Sharing one pair,
//! a busy afternoon of INFO lines would rotate the warnings out whole. So [`Stream::Info`] has its
//! own pair ([`INFO_FILE`], [`INFO_ROTATED_FILE`]) with the same bound, and an INFO line can never
//! evict a WARN or ERROR one. A take merges the two by the service's own stamp.
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
/// The recorded-INFO stream's current generation ([`Stream::Info`]).
pub(crate) const INFO_FILE: &str = "native_push_info.txt";
/// The recorded-INFO stream's previous generation.
pub(crate) const INFO_ROTATED_FILE: &str = "native_push_info.1.txt";
/// The size at which the current generation of either stream is rotated. ~250 lines of 120 characters.
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

/// Which budget a line is stored under: the service's WARN and ERROR lines, or the INFO lines it
/// records on purpose. Chosen by the caller (`NativePushLog`), never read back out of the line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stream {
    /// WARN and ERROR: [`LOG_FILE`] and [`ROTATED_FILE`].
    Alerts,
    /// Deliberately recorded INFO: [`INFO_FILE`] and [`INFO_ROTATED_FILE`].
    Info,
}

impl Stream {
    /// `(current, previous)` generation file names.
    fn files(self) -> (&'static str, &'static str) {
        match self {
            Stream::Alerts => (LOG_FILE, ROTATED_FILE),
            Stream::Info => (INFO_FILE, INFO_ROTATED_FILE),
        }
    }
}

/// The length of the service's stamp at the head of every line (`yyyy-MM-dd HH:mm:ss.SSS`,
/// `NativePushLogLine`), which orders the two streams when a take merges them.
const STAMP_CHARS: usize = 23;

/// Appends one line to `stream`, rotating that stream first when its current generation is full.
pub(crate) fn append(data_dir: &Path, stream: Stream, line: &str) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (current_name, rotated_name) = stream.files();
    let current = data_dir.join(current_name);
    let size = std::fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
    if size >= ROTATE_BYTES {
        std::fs::rename(&current, data_dir.join(rotated_name))
            .map_err(|e| format!("rotate: {e}"))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current)
        .map_err(|e| format!("open: {e}"))?;
    writeln!(file, "{}", one_line(line)).map_err(|e| format!("write: {e}"))
}

/// Every stored line of both streams, oldest first by the service's stamp, and every generation
/// removed. A generation that cannot be read is said and LEFT in place, so the next take tries it
/// again.
pub(crate) fn take(data_dir: &Path) -> Vec<String> {
    let _held = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let alerts = take_stream(data_dir, Stream::Alerts);
    let info = take_stream(data_dir, Stream::Info);
    merge_by_stamp(alerts, info)
}

/// Merges two streams, each already oldest first, by their stamp; on a tie the alert comes first.
fn merge_by_stamp(alerts: Vec<String>, info: Vec<String>) -> Vec<String> {
    let stamp = |l: &String| l.chars().take(STAMP_CHARS).collect::<String>();
    let mut out = Vec::with_capacity(alerts.len() + info.len());
    let mut a = alerts.into_iter().peekable();
    let mut i = info.into_iter().peekable();
    loop {
        let take_info = match (a.peek(), i.peek()) {
            (None, None) => break,
            (Some(_), None) => false,
            (None, Some(_)) => true,
            (Some(x), Some(y)) => stamp(y) < stamp(x),
        };
        out.extend(if take_info { i.next() } else { a.next() });
    }
    out
}

/// One stream's lines, previous generation first, its files removed (same failure rule as [`take`]).
fn take_stream(data_dir: &Path, stream: Stream) -> Vec<String> {
    let (current, rotated) = stream.files();
    let mut lines = Vec::new();
    for name in [rotated, current] {
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

/// The push service's WARN and ERROR lines, and its recorded INFO lines, since the last call,
/// oldest first. Empty off Android,
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
        append(&dir, Stream::Alerts, "first").unwrap();
        append(&dir, Stream::Alerts, "second").unwrap();
        assert_eq!(take(&dir), vec!["first", "second"]);
        assert!(take(&dir).is_empty(), "a second take finds nothing");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_line_break_cannot_forge_a_second_line_and_a_long_line_is_cut() {
        let dir = temp_dir("one-line");
        append(&dir, Stream::Alerts, "a\nE CanariFCM: forged").unwrap();
        append(&dir, Stream::Alerts, &"x".repeat(MAX_LINE_CHARS + 50)).unwrap();
        let lines = take(&dir);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "a E CanariFCM: forged");
        assert_eq!(lines[1].chars().count(), MAX_LINE_CHARS + 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn info_lines_never_evict_a_warning() {
        let dir = temp_dir("streams");
        append(
            &dir,
            Stream::Alerts,
            "2026-11-20 17:04:00.000 W CanariFCM: the one warning",
        )
        .unwrap();
        // Three pairs' worth of INFO: it rotates its own files, never the alerts'.
        let info = "i".repeat(100);
        let per_generation = (ROTATE_BYTES as usize / (info.len() + 40)) + 1;
        for n in 0..(3 * per_generation) {
            let stamp = format!(
                "2026-11-20 18:{:02}:{:02}.{:03}",
                n / 60000 % 60,
                n / 1000 % 60,
                n % 1000
            );
            append(&dir, Stream::Info, &format!("{stamp} I CanariFCM: {info}")).unwrap();
        }
        let lines = take(&dir);
        assert_eq!(
            lines.first().map(String::as_str),
            Some("2026-11-20 17:04:00.000 W CanariFCM: the one warning"),
            "the warning survived the INFO flood, and comes first by its stamp"
        );
        assert!(
            lines.len() < 3 * per_generation,
            "the INFO stream is bounded by its own pair"
        );
        assert!(take(&dir).is_empty(), "a take empties both streams");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_merge_orders_the_two_streams_by_the_services_stamp() {
        let alerts = vec![
            "2026-11-20 10:00:01.000 W a".to_string(),
            "2026-11-20 10:00:03.000 E b".to_string(),
        ];
        let info = vec![
            "2026-11-20 10:00:00.000 I x".to_string(),
            "2026-11-20 10:00:01.000 I y".to_string(),
            "2026-11-20 10:00:04.000 I z".to_string(),
        ];
        let merged = merge_by_stamp(alerts, info);
        let tails: Vec<&str> = merged.iter().map(|l| &l[24..]).collect();
        assert_eq!(tails, vec!["I x", "W a", "I y", "E b", "I z"]);
    }

    #[test]
    fn the_pair_is_bounded_and_the_older_generation_comes_first() {
        let dir = temp_dir("bound");
        let line = "y".repeat(100);
        // Three generations' worth: the oldest is gone, the two newest are kept.
        let per_generation = (ROTATE_BYTES as usize / (line.len() + 1)) + 1;
        for i in 0..(3 * per_generation) {
            append(&dir, Stream::Alerts, &format!("{i:06} {line}")).unwrap();
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
