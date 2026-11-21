//! The native outbox mirror, `{app_data_dir}/outbox_pending.ndjson`: one line per queued frame
//! (`id`, `groupId`, base64 cleartext `proto`, `sentAt`, `silent`, `durable`, and the optional
//! `unsendable` and `owner`), read by the background senders of both phones when the app is not in
//! front.
//!
//! **TWO WRITERS, AND THE FILE SAYS WHICH LINE IS WHOSE.** The page mirrors its outbox queue here
//! after every mutation ([`store_outbox_mirror`]), and the native side appends what it queued on its
//! own - a notification quick reply, a read watermark - and rewrites what its drain left. Until
//! 2026-11-21 the page's write was a WHOLE rewrite from its queue, so a warm page in the background
//! erased every native-only line with its next mutation: a reply typed in the shade, or an entry the
//! drain had marked unsendable, gone with no failed bubble and no Retry (principle 2, the essential
//! is never lost). The page now writes ITS lines only ([`merge_outbox_mirror`]): each one stamped
//! `owner: "page"`, and every line without that stamp - native, or written before the stamp
//! existed - kept unless the page holds its id. The page adopts those lines into its queue at login
//! and whenever it returns to the front (`outboxMirror.ts`), after which they are its own.
//!
//! **THE PAGE WRITES UNDER THE LOCK THE NATIVE WRITERS TAKE (Android).** Every Kotlin
//! read-modify-write of the file runs under `CanariFirebaseMessagingService.OUTBOX_LOCK`, a JVM
//! monitor, and the page's write takes THAT monitor ([`under_outbox_lock`]) - a file lock could not
//! serialise with it: `FileChannel.lock` is an fcntl lock, per process, and the page and the
//! service share one. The lock order: `OUTBOX_LOCK` is taken here with no Rust lock held and nothing
//! else is taken under it, so it sits where Kotlin already puts it - first, with its leaf locks
//! (`AwaitedReplies`, `RingSequencer.lock`) under it. A drain holds it through its POSTs, so the
//! page's write waits for one: the commands run on a blocking thread, never the IPC one.
//!
//! **iOS HAS NO SHARED LOCK, AND THAT IS A NAMED RESIDUAL.** `canari_push.mm` reads, appends and
//! rewrites the file with no lock, so a native write landing between this module's read and write is
//! still lost there ([chat-delivery](../../../../docs/wiki/chat-delivery.md#the-outbox-mirror-has-two-writers)).

use std::collections::HashSet;

use serde_json::Value;
use tauri::Manager;

/// The mirror's file name, under the app data directory.
pub(crate) const OUTBOX_PENDING_FILE: &str = "outbox_pending.ndjson";

/// The `owner` value the page stamps on its lines. Any other value, or none, is a native line.
const PAGE_OWNER: &str = "page";

/// What one merge did, for its log line.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct MirrorMerge {
    /// Lines written for the page.
    pub page: usize,
    /// Native lines kept: the page does not hold their id.
    pub native_kept: usize,
    /// Native lines dropped because the page holds their id (adopted, or the same frame).
    pub native_held: usize,
    /// Page lines of an earlier write the page no longer queues.
    pub page_dropped: usize,
    /// Lines that are no entry (unparseable, or no `id`): nobody can send them.
    pub unreadable: usize,
}

/// Whether `line` was written by the page.
fn page_owned(line: &Value) -> bool {
    line.get("owner").and_then(Value::as_str) == Some(PAGE_OWNER)
}

/// The mirror's lines after the page writes `page`, given the file's `current` text.
///
/// `held` is the id of EVERY entry the page queues - the parked and the failed ones too, which it
/// does not mirror: a native line whose id it holds is the page's from then on, and keeping it
/// would hand the native drain a frame the page shows as failed. The result is the native lines
/// kept, in their file order, then the page's, each stamped `owner: "page"` - the native ones were
/// queued before this write ever saw them.
///
/// Pure, so the rule is tested without a device; [`write_page_lines`] is its one caller.
pub(crate) fn merge_outbox_mirror(
    current: &str,
    page: Vec<Value>,
    held: &HashSet<String>,
) -> (Vec<Value>, MirrorMerge) {
    let mut merge = MirrorMerge::default();
    let page_ids: HashSet<String> = page
        .iter()
        .filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let mut lines: Vec<Value> = Vec::new();
    for raw in current.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            merge.unreadable += 1;
            continue;
        };
        let Some(id) = line.get("id").and_then(Value::as_str) else {
            merge.unreadable += 1;
            continue;
        };
        if page_owned(&line) {
            if !page_ids.contains(id) {
                merge.page_dropped += 1;
            }
            continue;
        }
        if held.contains(id) || page_ids.contains(id) {
            merge.native_held += 1;
            continue;
        }
        merge.native_kept += 1;
        lines.push(line);
    }
    for mut entry in page {
        if let Value::Object(fields) = &mut entry {
            fields.insert("owner".into(), Value::String(PAGE_OWNER.into()));
        }
        merge.page += 1;
        lines.push(entry);
    }
    (lines, merge)
}

/// Runs `work` holding Kotlin's `OUTBOX_LOCK` monitor - the lock every native read-modify-write of
/// the mirror takes. `Err` when the monitor could not be taken: `work` then did NOT run, and the
/// caller must not touch the file without it.
#[cfg(target_os = "android")]
fn under_outbox_lock<T>(work: impl FnOnce() -> T) -> Result<T, String> {
    let mut done = None;
    let reached = crate::commands::notifications::with_native_builder(|env, class| {
        let lock = match env
            .call_static_method(class, "outboxLock", "()Ljava/lang/Object;", &[])
            .and_then(|v| v.l())
        {
            Ok(lock) => lock,
            Err(e) => {
                log::error!("[OUTBOX_MIRROR] outboxLock() failed: {e} - the mirror NOT touched");
                return false;
            }
        };
        let guard = match env.lock_obj(&lock) {
            Ok(guard) => guard,
            Err(e) => {
                log::error!("[OUTBOX_MIRROR] OUTBOX_LOCK not taken: {e} - the mirror NOT touched");
                return false;
            }
        };
        done = Some(work());
        drop(guard);
        true
    });
    match done {
        Some(out) if reached => Ok(out),
        // `work` ran and the JNI door then reported a pending exception (the monitor's release):
        // the file was written, the result stands.
        Some(out) => {
            log::error!("[OUTBOX_MIRROR] the lock's release reported a failure - the work done under it stands");
            Ok(out)
        }
        None => Err("the outbox lock could not be taken".into()),
    }
}

/// Off Android no native writer shares a lock with the page: iOS's is the named residual above,
/// and a desktop has no native sender.
#[cfg(not(target_os = "android"))]
fn under_outbox_lock<T>(work: impl FnOnce() -> T) -> Result<T, String> {
    Ok(work())
}

/// Reads the mirror's text; empty when there is no file.
fn read_text(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("mirror read failed: {e}")),
    }
}

/// Merges the page's lines into the file at `path` and writes it ([`merge_outbox_mirror`]); an
/// empty result deletes the file, so the native side sees "nothing pending" without parsing it.
///
/// AN UNREADABLE FILE IS NOT REWRITTEN: read as empty, the write would erase every native line in
/// it - the defect this module exists to end.
fn write_page_lines(
    path: &std::path::Path,
    page: Vec<Value>,
    held: &HashSet<String>,
) -> Result<MirrorMerge, String> {
    let current = read_text(path)?;
    let (lines, merge) = merge_outbox_mirror(&current, page, held);
    if lines.is_empty() {
        if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("mirror delete failed: {e}"));
            }
        }
        return Ok(merge);
    }
    let body = lines
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(path, body + "\n").map_err(|e| format!("mirror write failed: {e}"))?;
    Ok(merge)
}

/// The page's write of its outbox queue into the mirror: `entries` are its mirrored lines, `held`
/// the id of every entry it queues. See the module doc for what is kept and why.
#[tauri::command]
pub(crate) async fn store_outbox_mirror(
    app: tauri::AppHandle,
    entries: Vec<Value>,
    held: Vec<String>,
) -> Result<(), String> {
    log::debug!(
        "[OUTBOX_MIRROR] page write: {} line(s), {} id(s) held",
        entries.len(),
        held.len()
    );
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let path = data_dir.join(OUTBOX_PENDING_FILE);
        let held: HashSet<String> = held.into_iter().collect();
        let merge = under_outbox_lock(|| write_page_lines(&path, entries, &held))?
            .inspect_err(|e| log::error!("[OUTBOX_MIRROR] page write NOT done: {e}"))?;
        if merge.unreadable > 0 {
            log::error!(
                // log-safe: `MirrorMerge` is five counts, no id and no content.
                "[OUTBOX_MIRROR] {} line(s) were no entry and are dropped: {merge:?}",
                merge.unreadable
            );
        } else {
            log::debug!(
                // log-safe: `MirrorMerge` is five counts, no id and no content.
                "[OUTBOX_MIRROR] page write done: {merge:?}"
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads the mirror WITHOUT clearing it, under the same lock as its writers, so the page can adopt
/// into its own outbox every native line (`adoptOrphanedMirrorEntries`). Not clearing is deliberate:
/// the file is the background senders' queue, and an adopted line becomes the page's at its next
/// [`store_outbox_mirror`]. `Err` when it could not be read - never an empty list, which the page
/// would take for "nothing to adopt".
#[tauri::command]
pub(crate) async fn read_outbox_mirror(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = data_dir.join(OUTBOX_PENDING_FILE);
        let text = under_outbox_lock(|| read_text(&path))?
            .inspect_err(|e| log::error!("[OUTBOX_MIRROR] page read NOT done: {e}"))?;
        let mut unreadable = 0usize;
        let entries: Vec<Value> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| {
                serde_json::from_str(l)
                    .inspect_err(|_| unreadable += 1)
                    .ok()
            })
            .collect();
        if unreadable > 0 {
            log::error!("[OUTBOX_MIRROR] {unreadable} mirror line(s) unreadable, not adopted");
        }
        log::debug!("[OUTBOX_MIRROR] {} mirror line(s) read", entries.len());
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(id: &str, owner: Option<&str>) -> Value {
        let mut v = json!({ "id": id, "groupId": "g1", "proto": "AA==", "sentAt": 1, "silent": false, "durable": true });
        if let Some(o) = owner {
            v["owner"] = json!(o);
        }
        v
    }

    fn text(lines: &[Value]) -> String {
        lines.iter().map(|l| l.to_string() + "\n").collect()
    }

    fn ids(lines: &[Value]) -> Vec<&str> {
        lines.iter().map(|l| l["id"].as_str().unwrap()).collect()
    }

    fn held(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// THE P1's CLOSING TEST: a line the native side queued alone survives the page's write.
    #[test]
    fn a_native_only_line_survives_a_page_write() {
        let current = text(&[line("native", None), line("p1", Some("page"))]);
        let (lines, merge) = merge_outbox_mirror(
            &current,
            vec![line("p1", None), line("p2", None)],
            &held(&["p1", "p2"]),
        );
        assert_eq!(ids(&lines), ["native", "p1", "p2"]);
        assert!(
            lines[0].get("owner").is_none(),
            "a native line stays native"
        );
        assert!(lines[1..].iter().all(|l| l["owner"] == "page"));
        assert_eq!(merge.native_kept, 1);
        assert_eq!(merge.page, 2);
    }

    /// The page's write of an EMPTY queue keeps every native line - it used to delete the file.
    #[test]
    fn an_empty_page_queue_keeps_the_native_lines() {
        let current = text(&[line("native", None)]);
        let (lines, _) = merge_outbox_mirror(&current, vec![], &held(&[]));
        assert_eq!(ids(&lines), ["native"]);
    }

    /// An entry the drain marked unsendable is kept WITH its mark, for the page to adopt it failed.
    #[test]
    fn an_unsendable_native_line_survives_with_its_mark() {
        let mut unsendable = line("stuck", None);
        unsendable["unsendable"] = json!(true);
        let (lines, _) = merge_outbox_mirror(&text(&[unsendable]), vec![], &held(&[]));
        assert_eq!(lines[0]["unsendable"], json!(true));
    }

    /// A page line the page no longer queues goes: sent, withdrawn or discarded.
    #[test]
    fn a_page_line_the_page_dropped_goes() {
        let current = text(&[line("sent", Some("page")), line("p1", Some("page"))]);
        let (lines, merge) = merge_outbox_mirror(&current, vec![line("p1", None)], &held(&["p1"]));
        assert_eq!(ids(&lines), ["p1"]);
        assert_eq!(merge.page_dropped, 1);
    }

    /// A native line the page holds - adopted, and parked or failed so not mirrored - is the page's:
    /// kept, the native drain would send what the page shows as failed.
    #[test]
    fn a_native_line_the_page_holds_is_the_pages() {
        let current = text(&[line("adopted", None), line("same", None)]);
        let (lines, merge) = merge_outbox_mirror(
            &current,
            vec![line("same", None)],
            &held(&["adopted", "same"]),
        );
        assert_eq!(ids(&lines), ["same"]);
        assert_eq!(lines[0]["owner"], "page");
        assert_eq!(merge.native_held, 2);
    }

    /// A line written before the stamp existed has no owner: read as native, so never erased.
    #[test]
    fn a_line_with_another_owner_is_native() {
        let current = text(&[line("x", Some("native"))]);
        let (lines, _) = merge_outbox_mirror(&current, vec![], &held(&[]));
        assert_eq!(ids(&lines), ["x"]);
    }

    #[test]
    fn a_line_that_is_no_entry_is_counted_and_dropped() {
        let current = "not json\n{\"groupId\":\"g1\"}\n".to_string() + &text(&[line("n", None)]);
        let (lines, merge) = merge_outbox_mirror(&current, vec![], &held(&[]));
        assert_eq!(ids(&lines), ["n"]);
        assert_eq!(merge.unreadable, 2);
    }

    /// The file round trip: an unreadable file is never rewritten, an empty result deletes it.
    #[test]
    fn the_file_is_deleted_when_nothing_is_left_and_kept_when_a_native_line_is() {
        let dir = std::env::temp_dir().join(format!("canari-mirror-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(OUTBOX_PENDING_FILE);
        std::fs::write(
            &path,
            text(&[line("native", None), line("p1", Some("page"))]),
        )
        .unwrap();

        write_page_lines(&path, vec![], &held(&[])).unwrap();
        let left = std::fs::read_to_string(&path).unwrap();
        assert!(left.contains("\"native\"") && !left.contains("\"p1\""));

        write_page_lines(&path, vec![], &held(&["native"])).unwrap();
        assert!(!path.exists(), "nothing left: the file goes");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
