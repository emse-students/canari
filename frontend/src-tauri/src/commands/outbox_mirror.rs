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
//! **iOS: ONE LOCK, OWNED HERE AND TAKEN BY `canari_push.mm`.** The page's commands and every
//! native read-modify-write of the file run in the APP process - the file lives in the app's own
//! Application Support, out of the notification extension's reach, and the extension never names
//! it. So one process-local lock covers them all: [`OUTBOX_MIRROR_LOCK`], which the ObjC side takes
//! through [`canari_with_outbox_mirror_lock`] around each whole drain (read, encrypt, POST,
//! rewrite, as Kotlin's drain holds `OUTBOX_LOCK`). The order: this lock first; the drain's encrypt
//! takes `g_mlsStateLock` under it with `tryLock`, which never waits, and the page takes nothing
//! under it but the journal lock below ([chat-delivery](../../../../docs/wiki/services/chat-delivery.md#the-outbox-mirror-has-two-writers)).
//!
//! **A NATIVE APPEND NEVER WAITS BEHIND A DRAIN: IT GOES TO A JOURNAL.** A drain holds the mirror
//! lock through its POSTs (tens of seconds on a bad network), and a reply typed in the shade that
//! waited for it sat only in memory - inside `goAsync`'s window on Android, in a process iOS may
//! suspend. So native code appends to [`OUTBOX_JOURNAL_FILE`] under [`JOURNAL_LOCK`] alone, which
//! covers one file write ([`append_journal`]), and every holder of the mirror lock - a drain, the
//! page's write and read - first folds the journal into the mirror ([`fold_into_mirror`]). The
//! order: the mirror lock, then `JOURNAL_LOCK`, a leaf; an appender takes the leaf only.
//!
//! **A MIRROR THAT CANNOT BE READ IS MOVED ASIDE, NEVER OVER ANOTHER, AND READ BACK.** Each one to
//! the first free `outbox_pending.unreadable.<n>.ndjson` ([`set_aside`]); the fold reads every one
//! lossily, takes each line that is an entry, and deletes the file only once the mirror holding
//! them is written. What still cannot be read is counted and returned to the page, which tells the
//! member (principle 2: the essential is never lost, or never lost silently) - once per fact.
//!
//! **EVERY WRITE SURVIVES A POWER LOSS, AND NO FOLDED SOURCE STAYS READABLE AS NEW.** Each write is
//! a temp file, synced, renamed over ([`write_durably`]); the journal is renamed to a folding name
//! before it is read, and a source the fold cannot delete FAILS the fold, so no caller sends and
//! drops a line that could then come back from it ([`fold_into_mirror`]).

use std::collections::HashSet;

use serde_json::Value;
use tauri::Manager;

/// The mirror's file name, under the app data directory.
pub(crate) const OUTBOX_PENDING_FILE: &str = "outbox_pending.ndjson";

/// The `owner` value the page stamps on its lines. Any other value, or none, is a native line.
const PAGE_OWNER: &str = "page";

/// The fields only a NATIVE writer sets on a line - its verdicts on the frame. The page's write
/// carries them over from the current line of the same id, or its own copy of a page line would
/// erase what a background drain learned: an `unsendable` mark gone, and every later drain trying
/// again what the server refused for good. An allowlist: a field the page stopped setting is not
/// resurrected by this.
const NATIVE_VERDICTS: [&str; 2] = ["unsendable", "unsendableCause"];

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
    /// Page lines that kept a native verdict ([`NATIVE_VERDICTS`]) of the current line.
    pub verdicts_kept: usize,
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
/// queued before this write ever saw them. A native verdict on the current line of a page id
/// ([`NATIVE_VERDICTS`]) is carried onto the page's copy.
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
    let mut verdicts: std::collections::HashMap<String, serde_json::Map<String, Value>> =
        std::collections::HashMap::new();
    for raw in current.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            merge.unreadable += 1;
            continue;
        };
        let Some(id) = line.get("id").and_then(Value::as_str) else {
            merge.unreadable += 1;
            continue;
        };
        if page_ids.contains(id) {
            let found: serde_json::Map<String, Value> = NATIVE_VERDICTS
                .iter()
                .filter_map(|k| line.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                .collect();
            if !found.is_empty() {
                verdicts.entry(id.to_owned()).or_default().extend(found);
            }
        }
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
            let id = fields.get("id").and_then(Value::as_str).map(str::to_owned);
            if let Some(kept) = id.and_then(|id| verdicts.remove(&id)) {
                merge.verdicts_kept += 1;
                for (k, v) in kept {
                    fields.entry(k).or_insert(v);
                }
            }
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

/// The iOS mirror lock - see the module doc. Not reentrant: no holder of it takes it again (the ObjC
/// side takes it around an append, releases it, then drains under it).
#[cfg(any(target_os = "ios", test))]
static OUTBOX_MIRROR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs `work` holding [`OUTBOX_MIRROR_LOCK`]. A poisoned lock (a panic under it) still serialises:
/// the file it guards is rewritten whole by every holder, so no half-state survives the panic.
#[cfg(any(target_os = "ios", test))]
fn with_mirror_lock<T>(work: impl FnOnce() -> T) -> T {
    let _held = OUTBOX_MIRROR_LOCK.lock().unwrap_or_else(|poisoned| {
        log::error!(
            "[OUTBOX_MIRROR] the mirror lock was poisoned by a panic under it - taken anyway"
        );
        poisoned.into_inner()
    });
    work()
}

/// **THE ONE DOOR `canari_push.mm` TAKES THE MIRROR LOCK THROUGH**: runs `work(ctx)` holding
/// [`OUTBOX_MIRROR_LOCK`], the lock the page's commands take (`CanariWithOutboxMirrorLock`). A null
/// `work` runs nothing, logged - the caller's read-modify-write did not happen.
#[cfg(any(target_os = "ios", test))]
#[no_mangle]
pub extern "C" fn canari_with_outbox_mirror_lock(
    ctx: *mut std::ffi::c_void,
    work: Option<extern "C" fn(*mut std::ffi::c_void)>,
) {
    let Some(work) = work else {
        log::error!("[OUTBOX_MIRROR] canari_with_outbox_mirror_lock: no work given - nothing ran");
        return;
    };
    with_mirror_lock(|| work(ctx));
}

/// iOS: the lock `canari_push.mm` takes around every read-modify-write of the file.
#[cfg(target_os = "ios")]
fn under_outbox_lock<T>(work: impl FnOnce() -> T) -> Result<T, String> {
    Ok(with_mirror_lock(work))
}

/// A desktop has no native sender: nothing else writes the file.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn under_outbox_lock<T>(work: impl FnOnce() -> T) -> Result<T, String> {
    Ok(work())
}

/// Reads a mirror file's text LOSSILY: bytes that are not UTF-8 become U+FFFD, and the line they
/// spoil is then counted and dropped by its parse, never the whole file. Empty when there is no file.
fn read_text(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{} read failed: {e}", short_name(path))),
    }
}

/// The file name alone, for a log line (no directory, which names the install).
fn short_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ── Durable writes: a power loss never empties the queue ─────────────────────────────────────────

/// Syncs `dir`'s entries to the disk, so a rename or a delete in it survives a power loss. Unix
/// only: elsewhere a directory cannot be opened for it (the desktop builds), and nothing is owed.
fn sync_dir(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)
            .and_then(|d| d.sync_all())
            .map_err(|e| format!("directory not synced: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// THE ONE DURABLE WRITE of a mirror file: `body` to `<name>.tmp`, synced, RENAMED over `path`
/// (atomic: a reader sees the old file or the new one), then the directory synced; `None` deletes
/// the file, durably too. A truncate-then-write lost the whole queue to a power loss between the
/// two. `Err` leaves `path` as it was. THE ONE durable write: Kotlin and iOS write the mirror through
/// it too (`nativeWriteOutboxMirror`, `canari_outbox_write_mirror`).
fn write_durably(path: &std::path::Path, body: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("a mirror path with no directory")?;
    match body {
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("{} delete failed: {e}", short_name(path)));
            }
            _ => {}
        },
        Some(body) => {
            let tmp = dir.join(format!("{}.tmp", short_name(path)));
            std::fs::File::create(&tmp)
                .and_then(|mut f| {
                    f.write_all(body.as_bytes())?;
                    f.sync_all()
                })
                .and_then(|()| std::fs::rename(&tmp, path))
                .map_err(|e| {
                    let _ = std::fs::remove_file(&tmp);
                    format!("{} write failed: {e}", short_name(path))
                })?;
        }
    }
    sync_dir(dir)
}

/// Writes `lines` as the mirror at `path`, durably ([`write_durably`]); no line deletes the file,
/// so the native side sees "nothing pending" without parsing it.
fn write_lines(path: &std::path::Path, lines: &[String]) -> Result<(), String> {
    let body = (!lines.is_empty()).then(|| lines.join("\n") + "\n");
    write_durably(path, body.as_deref())
}

// ── The side files: what is moved aside, what is being folded ────────────────────────────────────

/// A mirror that could not be read, moved aside ([`set_aside`]): `outbox_pending.unreadable.<n>.ndjson`.
const ASIDE_PREFIX: &str = "outbox_pending.unreadable.";
/// The journal while it is folded ([`fold_into_mirror`]): `outbox_journal.folding.<n>.ndjson`.
const FOLDING_PREFIX: &str = "outbox_journal.folding.";
/// The suffix of every numbered side file.
const SIDE_SUFFIX: &str = ".ndjson";
/// Appended to a side file that cannot be read once it has been REPORTED to the member: no fold
/// lists it again, so it is told once, and it stays for the account's deletion.
const REPORTED_SUFFIX: &str = ".reported";

/// The numbered side files `<prefix><n>.ndjson` in `dir`, in their order of `n`.
fn numbered_files(dir: &std::path::Path, prefix: &str) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, String)> = read
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|name| {
            let n = name.strip_prefix(prefix)?.strip_suffix(SIDE_SUFFIX)?;
            Some((n.parse().ok()?, name))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, name)| name).collect()
}

/// The first FREE `<prefix><n>.ndjson` in `dir` - never an existing one. Called under the mirror
/// lock (and the journal lock for a folding name), so no other writer picks the same name.
fn first_free(dir: &std::path::Path, prefix: &str) -> Result<String, String> {
    (1u64..)
        .map(|n| format!("{prefix}{n}{SIDE_SUFFIX}"))
        .find(|name| {
            !dir.join(name).exists() && !dir.join(format!("{name}{REPORTED_SUFFIX}")).exists()
        })
        .ok_or_else(|| format!("no free {prefix}<n> name"))
}

/// The side files REPORTED unreadable in `dir` (`<prefix><n>.ndjson.reported`), in name order:
/// read again by every fold, never counted again.
fn reported_files(dir: &std::path::Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let suffix = format!("{SIDE_SUFFIX}{REPORTED_SUFFIX}");
    let mut found: Vec<String> = read
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| {
            (name.starts_with(ASIDE_PREFIX) || name.starts_with(FOLDING_PREFIX))
                && name.ends_with(&suffix)
        })
        .collect();
    found.sort();
    found
}

/// The files moved aside in `dir`, in their order of `n`.
pub(crate) fn aside_files(dir: &std::path::Path) -> Vec<String> {
    numbered_files(dir, ASIDE_PREFIX)
}

/// EVERY side file of the mirror in `dir` - moved aside, being folded, reported, a temp file a crash
/// left - for the account's deletion (`remove_user_push_files`): the same account's protos.
pub(crate) fn mirror_side_files(dir: &std::path::Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let tmp = format!("{OUTBOX_PENDING_FILE}.tmp");
    let mut found: Vec<String> = read
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| {
            name.starts_with(ASIDE_PREFIX) || name.starts_with(FOLDING_PREFIX) || *name == tmp
        })
        .collect();
    found.sort();
    found
}

/// Moves `path` aside under the first free `outbox_pending.unreadable.<n>.ndjson` - never over an
/// earlier one - for [`fold_into_mirror`] to read again.
fn set_aside(path: &std::path::Path) -> Result<String, String> {
    let dir = path.parent().ok_or("a mirror path with no directory")?;
    let name = first_free(dir, ASIDE_PREFIX)?;
    std::fs::rename(path, dir.join(&name)).map_err(|e| format!("not moved aside ({e})"))?;
    Ok(name)
}

/// A mirror file's text for a WRITE. One that cannot be read at all is MOVED ASIDE ([`set_aside`]),
/// logged at ERROR, and the write starts from an empty file: kept, read again by the next fold, and
/// the page's writes never wedged behind it. `Err` only when it can be neither read nor moved - then
/// nothing is written over it.
fn read_or_set_aside(path: &std::path::Path) -> Result<String, String> {
    let error = match read_text(path) {
        Ok(text) => return Ok(text),
        Err(e) => e,
    };
    let aside = set_aside(path).map_err(|e| format!("{error}, and {e} - NOT written over"))?;
    log::error!(
        // log-safe: an io error and a file name of the form outbox_pending.unreadable.<n>.ndjson.
        "[OUTBOX_MIRROR] {error} - moved aside to {aside}, the write starts from an empty file"
    );
    Ok(String::new())
}

// ── The journal: a native append never waits behind a drain ─────────────────────────────────────

/// The append-only journal the native side queues into (`outbox_journal.ndjson`), beside the mirror.
///
/// **AN APPEND NEVER WAITS BEHIND A DRAIN.** A drain holds the mirror lock through its POSTs - up to
/// tens of seconds - and an append under that lock held a reply typed in the shade IN MEMORY for as
/// long, in a process the OS may suspend (iOS) or end (Android's `goAsync` window) meanwhile. The
/// append takes only [`JOURNAL_LOCK`], held for the one file write; every holder of the mirror lock
/// folds the journal into the mirror first ([`fold_into_mirror`]). Removed with the account's files.
pub(crate) const OUTBOX_JOURNAL_FILE: &str = "outbox_journal.ndjson";

/// Serialises the journal's appends, its reads and its fold, in this process - every writer of it
/// is in the app process on both phones (the iOS notification extension never names these files).
/// A LEAF: taken under the mirror lock by a fold, alone by an append or a read, and nothing is
/// taken under it.
static JOURNAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Takes [`JOURNAL_LOCK`]; a panic under it leaves no half-state (each holder writes whole lines or
/// whole files), so a poisoned lock is taken anyway, logged.
fn journal_lock() -> std::sync::MutexGuard<'static, ()> {
    JOURNAL_LOCK.lock().unwrap_or_else(|poisoned| {
        log::error!(
            "[OUTBOX_MIRROR] the journal lock was poisoned by a panic under it - taken anyway"
        );
        poisoned.into_inner()
    })
}

/// Appends one native line (a JSON object with an `id`) to the journal in `dir`, durably. The ONE
/// way a native writer queues a frame: Kotlin's `enqueueOutboxMirror`, the iOS quick reply and mark
/// read. `Err` names why nothing was queued.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn append_journal(dir: &std::path::Path, line: &str) -> Result<(), String> {
    use std::io::Write;
    let entry: Value = serde_json::from_str(line).map_err(|e| format!("not a JSON line: {e}"))?;
    if entry
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("a line with no id".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("no data directory: {e}"))?;
    let _held = journal_lock();
    let journal = dir.join(OUTBOX_JOURNAL_FILE);
    let created = !journal.exists();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&journal)
        .map_err(|e| format!("journal not opened: {e}"))?;
    file.write_all(format!("{entry}\n").as_bytes())
        .and_then(|()| file.sync_data())
        .map_err(|e| format!("journal not written: {e}"))?;
    // A journal this append created is a new directory entry: on the disk only once its directory
    // is. The line itself is synced and WILL be folded, so a failure here is no "not queued".
    if created {
        if let Err(e) = sync_dir(dir) {
            log::error!("[OUTBOX_MIRROR] journal created, {e} - the line is queued, its file may not survive a power loss");
        }
    }
    Ok(())
}

/// The journal's lines not folded yet, for a native caller that only LOOKS (Kotlin's
/// `readOutboxQueuedOrNull`): every file being folded, then the journal, read under
/// [`JOURNAL_LOCK`] so no append is half-read.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn read_journal_text(dir: &std::path::Path) -> Result<String, String> {
    let _held = journal_lock();
    let mut text = String::new();
    for name in numbered_files(dir, FOLDING_PREFIX)
        .into_iter()
        .chain(std::iter::once(OUTBOX_JOURNAL_FILE.to_owned()))
    {
        text.push_str(&read_text(&dir.join(name))?);
    }
    Ok(text)
}

/// How many SENDABLE entries are queued in `dir` - the mirror and the journal not folded yet, each
/// id once, `unsendable` ones left out: what a drain whose fold failed answers as left, so it never
/// reports a pending entry that is not there (and never 0 when one is).
#[cfg(any(target_os = "ios", test))]
pub(crate) fn queued_count(dir: &std::path::Path) -> Result<usize, String> {
    let text = read_text(&dir.join(OUTBOX_PENDING_FILE))? + "\n" + &read_journal_text(dir)?;
    let mut ids = HashSet::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("unsendable").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            ids.insert(id.to_owned());
        }
    }
    Ok(ids.len())
}

/// What a fold did, for its log line and for the member.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Fold {
    /// Lines moved into the mirror, from the journal and the files moved aside.
    pub folded: usize,
    /// Lines of a folded source that are no entry, dropped with it in THIS fold: the member is told.
    pub unreadable_lines: usize,
    /// Side files found unreadable in THIS fold and marked reported: the member is told, once.
    pub unreadable_files: usize,
}

/// Collects the lines of `text` that are entries and whose id is not in `known`, into `out`.
fn collect_new(text: &str, known: &mut HashSet<String>, out: &mut Vec<String>, fold: &mut Fold) {
    for raw in text.lines().filter(|l| !l.trim().is_empty()) {
        let parsed = serde_json::from_str::<Value>(raw).ok();
        let Some(id) = parsed.as_ref().and_then(|v| v.get("id")?.as_str()) else {
            fold.unreadable_lines += 1;
            continue;
        };
        if known.insert(id.to_owned()) {
            fold.folded += 1;
            out.push(parsed.as_ref().map(Value::to_string).unwrap_or_default());
        }
    }
}

/// Folds the journal, and every file moved aside, into the mirror in `dir`. **THE CALLER HOLDS THE
/// MIRROR LOCK** - the page's commands, a native drain - and goes on only on `Ok`.
///
/// **NO FOLDED SOURCE STAYS READABLE AS NEW.** The journal is first RENAMED to a folding name, so
/// nothing appended after this fold began lands in what it deletes. The sources are read, the
/// mirror holding their lines is written DURABLY, and only then are they deleted. A folding file a
/// crash left is folded again by the next holder - harmlessly, by id, since the mirror holding its
/// lines was written before any delete and no holder sends before its fold. **A SOURCE THAT CANNOT
/// BE DELETED FAILS THE FOLD**: its caller then sends nothing and drops nothing, so a line sent and
/// dropped from the mirror can never come back from it as native; the next fold tries again.
///
/// A side file that cannot be read is marked `.reported` and counted ONCE: the page tells the
/// member, and no later fold counts it again.
pub(crate) fn fold_into_mirror(dir: &std::path::Path) -> Result<Fold, String> {
    fold_with(dir, &|path| std::fs::remove_file(path))
}

/// [`fold_into_mirror`] with the delete of a folded source given, for a test to make it fail.
fn fold_with(
    dir: &std::path::Path,
    remove: &dyn Fn(&std::path::Path) -> std::io::Result<()>,
) -> Result<Fold, String> {
    let mut fold = Fold::default();
    let _held = journal_lock();
    let journal_path = dir.join(OUTBOX_JOURNAL_FILE);
    if journal_path.exists() {
        let folding = first_free(dir, FOLDING_PREFIX)?;
        std::fs::rename(&journal_path, dir.join(&folding))
            .map_err(|e| format!("journal not renamed for its fold: {e}"))?;
    }
    // A file REPORTED unreadable is still read by every fold: an unreadable file may be a passing
    // fault, and a folding file holds shade replies. It is only never COUNTED again.
    let sources: Vec<String> = numbered_files(dir, FOLDING_PREFIX)
        .into_iter()
        .chain(aside_files(dir))
        .chain(reported_files(dir))
        .collect();
    if sources.is_empty() {
        return Ok(fold);
    }
    let path = dir.join(OUTBOX_PENDING_FILE);
    let current = read_or_set_aside(&path)?;
    let mut lines: Vec<String> = current
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect();
    let mut known: HashSet<String> = lines
        .iter()
        .filter_map(|l| {
            serde_json::from_str::<Value>(l)
                .ok()?
                .get("id")?
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    let mut folded = Vec::new();
    for name in &sources {
        match read_text(&dir.join(name)) {
            Ok(text) => {
                collect_new(&text, &mut known, &mut lines, &mut fold);
                folded.push(name);
            }
            Err(e) if name.ends_with(REPORTED_SUFFIX) => log::debug!(
                // log-safe: an io error and a side file's name.
                "[OUTBOX_MIRROR] {e} - still unreadable, already reported, read again by the next fold"
            ),
            Err(e) => {
                fold.unreadable_files += 1;
                let reported = format!("{name}{REPORTED_SUFFIX}");
                match std::fs::rename(dir.join(name), dir.join(&reported)) {
                    Ok(()) => log::error!(
                        // log-safe: an io error and a side file's name.
                        "[OUTBOX_MIRROR] {e} - kept as {reported}, the member is told once"
                    ),
                    Err(r) => log::error!(
                        // log-safe: two io errors and a side file's name.
                        "[OUTBOX_MIRROR] {e}, and not marked reported ({r}) - the member is told again by the next fold"
                    ),
                }
            }
        }
    }
    write_lines(&path, &lines)?;
    let undeleted: Vec<String> = folded
        .iter()
        .filter_map(|name| match remove(&dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Some(format!("{name} ({e})")),
            _ => None,
        })
        .collect();
    sync_dir(dir)?;
    if !undeleted.is_empty() {
        return Err(format!(
            "folded but NOT deleted: {} - nothing may be sent on this fold, the next one tries again",
            undeleted.join(", ")
        ));
    }
    if fold != Fold::default() {
        log::info!(
            // log-safe: `Fold` is counts, no id and no content.
            "[OUTBOX_MIRROR] fold: {fold:?}"
        );
    }
    Ok(fold)
}

/// Merges the page's lines into the mirror at `path` ([`merge_outbox_mirror`]) and writes it.
fn write_page_lines(
    path: &std::path::Path,
    page: Vec<Value>,
    held: &HashSet<String>,
) -> Result<MirrorMerge, String> {
    let current = read_or_set_aside(path)?;
    let (lines, merge) = merge_outbox_mirror(&current, page, held);
    write_lines(
        path,
        &lines.iter().map(Value::to_string).collect::<Vec<_>>(),
    )?;
    Ok(merge)
}

/// The page's write in `dir`, the caller holding the mirror lock: the fold, then the page's lines.
/// Answers what was LOST IN THIS WRITE - lines dropped as no entry, side files found unreadable -
/// which the page tells the member, once per fact: a dropped line is gone after it, a side file is
/// marked reported.
fn page_write(
    dir: &std::path::Path,
    entries: Vec<Value>,
    held: &HashSet<String>,
) -> Result<usize, String> {
    let fold = fold_into_mirror(dir)?;
    let merge = write_page_lines(&dir.join(OUTBOX_PENDING_FILE), entries, held)?;
    let lost = merge.unreadable + fold.unreadable_lines + fold.unreadable_files;
    if lost > 0 {
        log::error!(
            // log-safe: `MirrorMerge` and `Fold` are counts, no id and no content.
            "[OUTBOX_MIRROR] {lost} line(s) or file(s) lost in this write, the member is told: {merge:?} {fold:?}"
        );
    } else {
        log::debug!(
            // log-safe: `MirrorMerge` is counts, no id and no content.
            "[OUTBOX_MIRROR] page write done: {merge:?}"
        );
    }
    Ok(lost)
}

/// The page's write of its outbox queue into the mirror: `entries` are its mirrored lines, `held`
/// the id of every entry it queues - after the journal and the files moved aside are folded in.
/// Answers what was lost in this write ([`page_write`]). See the module doc for what is kept.
#[tauri::command]
pub(crate) async fn store_outbox_mirror(
    app: tauri::AppHandle,
    entries: Vec<Value>,
    held: Vec<String>,
) -> Result<usize, String> {
    log::debug!(
        "[OUTBOX_MIRROR] page write: {} line(s), {} id(s) held",
        entries.len(),
        held.len()
    );
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let held: HashSet<String> = held.into_iter().collect();
        under_outbox_lock(|| page_write(&data_dir, entries, &held))?
            .inspect_err(|e| log::error!("[OUTBOX_MIRROR] page write NOT done: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the page reads of the mirror: its entries, and what THIS read's fold lost - which the page
/// TELLS the member, since nobody can send it.
#[derive(Debug, serde::Serialize)]
pub(crate) struct MirrorRead {
    entries: Vec<Value>,
    unreadable: usize,
}

/// The page's read in `dir`, the caller holding the mirror lock: the fold, then the mirror. A
/// mirror line that is no entry is skipped here and NOT counted: it stays in the file until the
/// page's next write drops it, which reports it - once.
fn page_read(dir: &std::path::Path) -> Result<MirrorRead, String> {
    let fold = fold_into_mirror(dir)?;
    let text = read_text(&dir.join(OUTBOX_PENDING_FILE))?;
    let mut skipped = 0usize;
    let entries: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).inspect_err(|_| skipped += 1).ok())
        .collect();
    let unreadable = fold.unreadable_lines + fold.unreadable_files;
    if unreadable > 0 {
        log::error!("[OUTBOX_MIRROR] {unreadable} folded line(s) or file(s) lost in this read - the member is told");
    }
    log::debug!(
        "[OUTBOX_MIRROR] {} mirror line(s) read, {skipped} not an entry (reported by the write that drops them)",
        entries.len()
    );
    Ok(MirrorRead {
        entries,
        unreadable,
    })
}

/// Reads the mirror WITHOUT clearing it, under the same lock as its writers and after folding the
/// journal and the files moved aside into it, so the page can adopt into its own outbox every
/// native line (`adoptOrphanedMirrorEntries`). Not clearing is deliberate: the file is the
/// background senders' queue, and an adopted line becomes the page's at its next
/// [`store_outbox_mirror`]. `Err` when it could not be read - never an empty list, which the page
/// would take for "nothing to adopt".
#[tauri::command]
pub(crate) async fn read_outbox_mirror(app: tauri::AppHandle) -> Result<MirrorRead, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        under_outbox_lock(|| page_read(&data_dir))?
            .inspect_err(|e| log::error!("[OUTBOX_MIRROR] page read NOT done: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── The native doors to the journal and the fold ─────────────────────────────────────────────────

/// Reads a C string argument, `None` (logged) when null or not UTF-8.
#[cfg(any(target_os = "ios", test))]
fn c_arg(ptr: *const std::ffi::c_char, what: &str) -> Option<String> {
    if ptr.is_null() {
        log::error!("[OUTBOX_MIRROR] {what}: null argument");
        return None;
    }
    // SAFETY: a non-null pointer to a NUL-terminated string, alive for the call (the C contract).
    let s = unsafe { std::ffi::CStr::from_ptr(ptr) };
    s.to_str()
        .inspect_err(|_| log::error!("[OUTBOX_MIRROR] {what}: not UTF-8"))
        .ok()
        .map(str::to_owned)
}

/// iOS: [`append_journal`] - 1 when the line is queued, 0 (logged) when not.
#[cfg(any(target_os = "ios", test))]
#[no_mangle]
pub extern "C" fn canari_outbox_journal_append(
    data_dir: *const std::ffi::c_char,
    line: *const std::ffi::c_char,
) -> i32 {
    let (Some(dir), Some(line)) = (
        c_arg(data_dir, "journal append"),
        c_arg(line, "journal append"),
    ) else {
        return 0;
    };
    match append_journal(std::path::Path::new(&dir), &line) {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[OUTBOX_MIRROR] journal append NOT done: {e}");
            0
        }
    }
}

/// iOS: [`fold_into_mirror`], for a drain that holds the mirror lock - 1 when folded, 0 (logged)
/// when not: the drain then sends nothing, and the journal stays for the next holder.
#[cfg(any(target_os = "ios", test))]
#[no_mangle]
pub extern "C" fn canari_outbox_fold(data_dir: *const std::ffi::c_char) -> i32 {
    let Some(dir) = c_arg(data_dir, "fold") else {
        return 0;
    };
    match fold_into_mirror(std::path::Path::new(&dir)) {
        Ok(_) => 1,
        Err(e) => {
            log::error!(
                "[OUTBOX_MIRROR] fold NOT done: {e} - the journal waits for the next holder"
            );
            0
        }
    }
}

/// iOS: [`write_durably`] of the mirror, for `CanariRewriteOutboxMirror` under the mirror lock - an
/// empty `body` deletes it. 1 when written, 0 (logged) when not: the mirror is then as it was.
#[cfg(any(target_os = "ios", test))]
#[no_mangle]
pub extern "C" fn canari_outbox_write_mirror(
    data_dir: *const std::ffi::c_char,
    body: *const std::ffi::c_char,
) -> i32 {
    let (Some(dir), Some(body)) = (c_arg(data_dir, "mirror write"), c_arg(body, "mirror write"))
    else {
        return 0;
    };
    let path = std::path::Path::new(&dir).join(OUTBOX_PENDING_FILE);
    match write_durably(&path, (!body.is_empty()).then_some(body.as_str())) {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[OUTBOX_MIRROR] native mirror write NOT done: {e}");
            0
        }
    }
}

/// iOS: [`queued_count`], for a drain whose fold failed - the count, or -1 (logged) when it could
/// not be read.
#[cfg(any(target_os = "ios", test))]
#[no_mangle]
pub extern "C" fn canari_outbox_queued_count(data_dir: *const std::ffi::c_char) -> i32 {
    let Some(dir) = c_arg(data_dir, "queued count") else {
        return -1;
    };
    match queued_count(std::path::Path::new(&dir)) {
        Ok(n) => i32::try_from(n).unwrap_or(i32::MAX),
        Err(e) => {
            log::error!("[OUTBOX_MIRROR] queued count NOT read: {e}");
            -1
        }
    }
}

/// Android: [`write_durably`] of the mirror, for `rewriteOutboxMirror` under `OUTBOX_LOCK` - an
/// empty `body` deletes it. THE ONE DURABLE WRITE for Kotlin too: a JVM directory sync is refused
/// on Android (`FileChannel.open` on a directory is `EISDIR` there), and Rust's works on Unix.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeWriteOutboxMirror<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _companion: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
    body: jni::objects::JString<'a>,
) -> jni::sys::jboolean {
    let (Some(dir), Some(body)) = (
        jni_arg(&mut env, &data_dir, "mirror write"),
        jni_arg(&mut env, &body, "mirror write"),
    ) else {
        return jni::sys::JNI_FALSE;
    };
    let path = std::path::Path::new(&dir).join(OUTBOX_PENDING_FILE);
    match write_durably(&path, (!body.is_empty()).then_some(body.as_str())) {
        Ok(()) => jni::sys::JNI_TRUE,
        Err(e) => {
            log::error!("[OUTBOX_MIRROR] native mirror write NOT done: {e}");
            jni::sys::JNI_FALSE
        }
    }
}

/// Reads a JNI string argument, `None` (logged) when it cannot be read.
#[cfg(target_os = "android")]
fn jni_arg(env: &mut jni::JNIEnv<'_>, s: &jni::objects::JString<'_>, what: &str) -> Option<String> {
    env.get_string(s)
        .inspect_err(|e| log::error!("[OUTBOX_MIRROR] {what}: jni-string ({e})"))
        .ok()
        .map(Into::into)
}

/// Android: [`append_journal`] (`CanariFirebaseMessagingService.enqueueOutboxMirror`) - true when the
/// line is queued.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeAppendOutboxJournal<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _companion: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
    line: jni::objects::JString<'a>,
) -> jni::sys::jboolean {
    let (Some(dir), Some(line)) = (
        jni_arg(&mut env, &data_dir, "journal append"),
        jni_arg(&mut env, &line, "journal append"),
    ) else {
        return jni::sys::JNI_FALSE;
    };
    match append_journal(std::path::Path::new(&dir), &line) {
        Ok(()) => jni::sys::JNI_TRUE,
        Err(e) => {
            log::error!("[OUTBOX_MIRROR] journal append NOT done: {e}");
            jni::sys::JNI_FALSE
        }
    }
}

/// Android: [`read_journal_text`], for Kotlin's `readOutboxQueuedOrNull` - the text, or null
/// (logged) when it could not be read.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeReadOutboxJournal<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _companion: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
) -> jni::sys::jstring {
    let Some(dir) = jni_arg(&mut env, &data_dir, "journal read") else {
        return std::ptr::null_mut();
    };
    match read_journal_text(std::path::Path::new(&dir)) {
        Ok(text) => env
            .new_string(text)
            .map(jni::objects::JString::into_raw)
            .unwrap_or_else(|e| {
                log::error!("[OUTBOX_MIRROR] journal read: jni-string ({e})");
                std::ptr::null_mut()
            }),
        Err(e) => {
            log::error!("[OUTBOX_MIRROR] journal read NOT done: {e}");
            std::ptr::null_mut()
        }
    }
}

/// Android: [`fold_into_mirror`], for a caller holding `OUTBOX_LOCK` - true when folded; false
/// (logged): the caller sends nothing on it, and the journal waits for the next holder.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeFoldOutboxMirror<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _companion: jni::objects::JObject<'a>,
    data_dir: jni::objects::JString<'a>,
) -> jni::sys::jboolean {
    let Some(dir) = jni_arg(&mut env, &data_dir, "fold") else {
        return jni::sys::JNI_FALSE;
    };
    match fold_into_mirror(std::path::Path::new(&dir)) {
        Ok(_) => jni::sys::JNI_TRUE,
        Err(e) => {
            log::error!(
                "[OUTBOX_MIRROR] fold NOT done: {e} - the journal waits for the next holder"
            );
            jni::sys::JNI_FALSE
        }
    }
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

    /// A verdict a background drain set on a PAGE line survives the page's next copy of it.
    #[test]
    fn a_native_verdict_on_a_page_line_is_carried_over() {
        let mut marked = line("p1", Some("page"));
        marked["unsendable"] = json!(true);
        marked["unsendableCause"] = json!("refused");
        let (lines, merge) =
            merge_outbox_mirror(&text(&[marked]), vec![line("p1", None)], &held(&["p1"]));
        assert_eq!(lines[0]["unsendable"], json!(true));
        assert_eq!(lines[0]["unsendableCause"], "refused");
        assert_eq!(lines[0]["owner"], "page");
        assert_eq!(merge.verdicts_kept, 1);
    }

    /// Only the allowlisted verdicts: any other field of the old line is the page's to set or not.
    #[test]
    fn a_field_outside_the_verdicts_is_not_carried() {
        let mut old = line("p1", Some("page"));
        old["somethingElse"] = json!(1);
        let (lines, _) = merge_outbox_mirror(&text(&[old]), vec![line("p1", None)], &held(&["p1"]));
        assert!(lines[0].get("somethingElse").is_none());
    }

    /// Bytes that are not UTF-8 spoil their line only: the rest is read, the spoiled line counted.
    #[test]
    fn a_file_with_bad_bytes_is_read_lossily() {
        let dir = std::env::temp_dir().join(format!("canari-mirror-lossy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(OUTBOX_PENDING_FILE);
        let mut bytes = b"{\"id\":\xff\xfe}\n".to_vec();
        bytes.extend(text(&[line("native", None)]).into_bytes());
        std::fs::write(&path, bytes).unwrap();
        let merge = write_page_lines(&path, vec![], &held(&[])).unwrap();
        assert_eq!(merge.unreadable, 1);
        assert_eq!(merge.native_kept, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A mirror that cannot be read at all (here: a directory) is moved aside, never written over,
    /// and the page's write goes on from an empty mirror.
    #[test]
    fn an_unreadable_mirror_is_moved_aside_and_the_write_goes_on() {
        let dir = std::env::temp_dir().join(format!("canari-mirror-aside-{}", std::process::id()));
        let path = dir.join(OUTBOX_PENDING_FILE);
        std::fs::create_dir_all(&path).unwrap();
        write_page_lines(&path, vec![line("p1", None)], &held(&["p1"])).unwrap();
        assert!(
            dir.join("outbox_pending.unreadable.1.ndjson").is_dir(),
            "the unreadable mirror is kept aside"
        );
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"p1\""));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A scratch data directory of its own per test.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-mirror-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A native append goes to the journal - never to the mirror a drain holds - and the next
    /// holder of the mirror lock folds it in, once.
    #[test]
    fn a_journal_append_is_folded_into_the_mirror_once() {
        let dir = scratch("journal");
        std::fs::write(
            dir.join(OUTBOX_PENDING_FILE),
            text(&[line("p1", Some("page"))]),
        )
        .unwrap();
        append_journal(&dir, &line("reply", None).to_string()).unwrap();
        append_journal(&dir, &line("reply", None).to_string()).unwrap();
        assert!(
            append_journal(&dir, "{\"groupId\":\"g1\"}").is_err(),
            "a line with no id"
        );
        let mirror = std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE)).unwrap();
        assert!(
            !mirror.contains("\"reply\""),
            "the append never touches the mirror"
        );

        let fold = fold_into_mirror(&dir).unwrap();
        assert_eq!(fold.folded, 1);
        let mirror = std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE)).unwrap();
        assert_eq!(mirror.matches("\"reply\"").count(), 1);
        assert!(
            !dir.join(OUTBOX_JOURNAL_FILE).exists(),
            "the journal goes once folded"
        );
        // The page's write keeps the folded native line.
        let (lines, _) = merge_outbox_mirror(&mirror, vec![line("p1", None)], &held(&["p1"]));
        assert_eq!(ids(&lines), ["reply", "p1"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A second unreadable mirror is moved aside under a NEW name, never over the first.
    #[test]
    fn a_mirror_moved_aside_never_overwrites_an_earlier_one() {
        let dir = scratch("aside-twice");
        std::fs::write(
            dir.join("outbox_pending.unreadable.1.ndjson"),
            text(&[line("first", None)]),
        )
        .unwrap();
        std::fs::create_dir_all(dir.join(OUTBOX_PENDING_FILE)).unwrap();
        assert_eq!(
            set_aside(&dir.join(OUTBOX_PENDING_FILE)).unwrap(),
            "outbox_pending.unreadable.2.ndjson"
        );
        assert!(
            std::fs::read_to_string(dir.join("outbox_pending.unreadable.1.ndjson"))
                .unwrap()
                .contains("\"first\"")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// What was moved aside is read again: its entries folded back into the mirror (for the page to
    /// adopt), the file deleted only then; a file that still cannot be read is kept and counted, and
    /// its bad lines too - the page tells the member.
    #[test]
    fn the_files_moved_aside_are_folded_back_and_the_unreadable_rest_is_counted() {
        let dir = scratch("aside-fold");
        let mut lossy = b"not json\n".to_vec();
        lossy.extend(text(&[line("kept", None)]).into_bytes());
        std::fs::write(dir.join("outbox_pending.unreadable.1.ndjson"), lossy).unwrap();
        std::fs::create_dir_all(dir.join("outbox_pending.unreadable.2.ndjson")).unwrap();

        let fold = fold_into_mirror(&dir).unwrap();
        assert_eq!(
            fold,
            Fold {
                folded: 1,
                unreadable_lines: 1,
                unreadable_files: 1
            }
        );
        let mirror = std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE)).unwrap();
        assert!(mirror.contains("\"kept\""));
        assert!(
            !dir.join("outbox_pending.unreadable.1.ndjson").exists(),
            "folded: deleted"
        );
        assert!(
            dir.join("outbox_pending.unreadable.2.ndjson.reported")
                .exists(),
            "unreadable: kept, marked reported"
        );
        assert!(aside_files(&dir).is_empty());
        assert_eq!(
            mirror_side_files(&dir),
            ["outbox_pending.unreadable.2.ndjson.reported"],
            "the reported file is still the account's, for its deletion"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// TOLD ONCE PER FACT (review of #3929): a side file that stays unopenable is counted by the
    /// write that finds it, never by the writes after; a mirror line that is no entry is counted by
    /// the write that drops it, never by a read.
    #[test]
    fn repeated_writes_over_one_stuck_file_report_it_once() {
        let dir = scratch("told-once");
        std::fs::create_dir_all(dir.join("outbox_pending.unreadable.1.ndjson")).unwrap();
        std::fs::write(
            dir.join(OUTBOX_PENDING_FILE),
            "not an entry\n".to_owned() + &text(&[line("native", None)]),
        )
        .unwrap();
        // A read neither counts the mirror's bad line nor drops it.
        let read = page_read(&dir).unwrap();
        assert_eq!(read.unreadable, 1, "the stuck file, found by this read");
        assert_eq!(read.entries.len(), 1);
        assert_eq!(page_read(&dir).unwrap().unreadable, 0);
        // The write drops the bad line and says so once.
        assert_eq!(page_write(&dir, vec![], &held(&[])).unwrap(), 1);
        assert_eq!(page_write(&dir, vec![], &held(&[])).unwrap(), 0);
        assert_eq!(page_write(&dir, vec![], &held(&[])).unwrap(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// NO FOLDED SOURCE STAYS READABLE AS NEW (review of #3929): a source that cannot be deleted
    /// fails the fold, so its caller sends and drops nothing on it; the next fold deletes it, and a
    /// line sent and dropped after that never comes back as native.
    #[test]
    fn a_sent_line_is_never_resurrected_when_the_delete_fails() {
        let dir = scratch("no-resurrection");
        append_journal(&dir, &line("reply", None).to_string()).unwrap();
        let refuse = |_: &std::path::Path| -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "held",
            ))
        };
        assert!(
            fold_with(&dir, &refuse).is_err(),
            "an undeleted source fails the fold"
        );
        assert!(
            !dir.join(OUTBOX_JOURNAL_FILE).exists(),
            "the journal was renamed before it was read: never readable as new"
        );
        assert!(
            fold_with(&dir, &refuse).is_err(),
            "and again, while it lasts"
        );
        // The delete works again: folded by id (once), and the folding file goes.
        let fold = fold_into_mirror(&dir).unwrap();
        assert_eq!(fold.folded, 0, "already in the mirror: not added twice");
        assert!(mirror_side_files(&dir).is_empty());
        // The drain sends it and drops it from the mirror.
        write_lines(&dir.join(OUTBOX_PENDING_FILE), &[]).unwrap();
        fold_into_mirror(&dir).unwrap();
        assert!(
            !dir.join(OUTBOX_PENDING_FILE).exists(),
            "the sent line never comes back"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A folding file a crash left (renamed, maybe folded, not deleted) is folded again by id, beside
    /// a journal appended since - each line once.
    #[test]
    fn a_folding_file_left_by_a_crash_is_folded_again_once() {
        let dir = scratch("crash-folding");
        std::fs::write(
            dir.join("outbox_journal.folding.1.ndjson"),
            text(&[line("before", None)]),
        )
        .unwrap();
        std::fs::write(dir.join(OUTBOX_PENDING_FILE), text(&[line("before", None)])).unwrap();
        append_journal(&dir, &line("after", None).to_string()).unwrap();
        let fold = fold_into_mirror(&dir).unwrap();
        assert_eq!(fold.folded, 1);
        let mirror = std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE)).unwrap();
        assert_eq!(mirror.matches("\"before\"").count(), 1);
        assert_eq!(mirror.matches("\"after\"").count(), 1);
        assert!(mirror_side_files(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The durable write replaces the file whole through a temp file it never leaves behind, and an
    /// empty result deletes it.
    #[test]
    fn the_durable_write_replaces_whole_and_leaves_no_temp_file() {
        let dir = scratch("durable");
        let path = dir.join(OUTBOX_PENDING_FILE);
        std::fs::write(&path, "old\n").unwrap();
        write_durably(&path, Some("new\n")).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
        assert!(mirror_side_files(&dir).is_empty(), "no temp file left");
        // A temp name taken by a directory: the write fails, the file is as it was.
        std::fs::create_dir_all(dir.join(format!("{OUTBOX_PENDING_FILE}.tmp"))).unwrap();
        assert!(write_durably(&path, Some("lost\n")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
        std::fs::remove_dir_all(dir.join(format!("{OUTBOX_PENDING_FILE}.tmp"))).unwrap();
        write_durably(&path, None).unwrap();
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A file reported unreadable is READ AGAIN by every later fold - a passing fault never turns a
    /// shade reply into a loss - and counted once only.
    #[test]
    fn a_reported_file_is_read_again_and_folded_once_it_reads() {
        let dir = scratch("reported-again");
        let folding = dir.join("outbox_journal.folding.1.ndjson");
        std::fs::create_dir_all(&folding).unwrap();
        assert_eq!(fold_into_mirror(&dir).unwrap().unreadable_files, 1);
        assert_eq!(
            fold_into_mirror(&dir).unwrap().unreadable_files,
            0,
            "still unreadable: not counted again"
        );
        // The fault passes: the reported file now reads.
        let reported = dir.join("outbox_journal.folding.1.ndjson.reported");
        std::fs::remove_dir_all(&reported).unwrap();
        std::fs::write(&reported, text(&[line("shade", None)])).unwrap();
        let fold = fold_into_mirror(&dir).unwrap();
        assert_eq!(fold.folded, 1);
        assert!(std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE))
            .unwrap()
            .contains("\"shade\""));
        assert!(mirror_side_files(&dir).is_empty(), "folded: deleted");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// What a drain whose fold failed answers as left: the sendable entries of the mirror and the
    /// journal, each once - 0 when nothing is queued, never a phantom.
    #[test]
    fn the_queued_count_covers_the_journal_and_is_zero_when_empty() {
        let dir = scratch("queued-count");
        assert_eq!(queued_count(&dir).unwrap(), 0);
        let mut stuck = line("stuck", None);
        stuck["unsendable"] = json!(true);
        std::fs::write(
            dir.join(OUTBOX_PENDING_FILE),
            text(&[line("a", None), stuck]),
        )
        .unwrap();
        append_journal(&dir, &line("b", None).to_string()).unwrap();
        append_journal(&dir, &line("a", None).to_string()).unwrap();
        assert_eq!(queued_count(&dir).unwrap(), 2);
        let c_dir = std::ffi::CString::new(dir.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(canari_outbox_queued_count(c_dir.as_ptr()), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// What Kotlin's read-only checkers see of the journal: the folding files, then the journal.
    #[test]
    fn the_journal_read_covers_what_is_being_folded() {
        let dir = scratch("journal-read");
        std::fs::write(
            dir.join("outbox_journal.folding.1.ndjson"),
            text(&[line("folding", None)]),
        )
        .unwrap();
        append_journal(&dir, &line("new", None).to_string()).unwrap();
        let read = read_journal_text(&dir).unwrap();
        assert!(read.contains("\"folding\"") && read.contains("\"new\""));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The C doors: an append and a fold through them, and a null argument refused, logged.
    #[test]
    fn the_c_doors_append_and_fold() {
        let dir = scratch("c-doors");
        let c_dir = std::ffi::CString::new(dir.to_string_lossy().as_bytes()).unwrap();
        let c_line = std::ffi::CString::new(line("c", None).to_string()).unwrap();
        assert_eq!(
            canari_outbox_journal_append(c_dir.as_ptr(), c_line.as_ptr()),
            1
        );
        assert_eq!(
            canari_outbox_journal_append(std::ptr::null(), c_line.as_ptr()),
            0
        );
        assert_eq!(canari_outbox_fold(c_dir.as_ptr()), 1);
        assert!(std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE))
            .unwrap()
            .contains("\"c\""));
        // The durable rewrite door: a body replaces the mirror, an empty one deletes it.
        let body = std::ffi::CString::new(text(&[line("left", None)])).unwrap();
        assert_eq!(canari_outbox_write_mirror(c_dir.as_ptr(), body.as_ptr()), 1);
        assert!(std::fs::read_to_string(dir.join(OUTBOX_PENDING_FILE))
            .unwrap()
            .contains("\"left\""));
        let empty = std::ffi::CString::new("").unwrap();
        assert_eq!(
            canari_outbox_write_mirror(c_dir.as_ptr(), empty.as_ptr()),
            1
        );
        assert!(!dir.join(OUTBOX_PENDING_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The ObjC door runs its work HOLDING the lock the page's iOS commands take.
    #[test]
    fn the_objc_door_runs_its_work_under_the_page_lock() {
        extern "C" fn probe(ctx: *mut std::ffi::c_void) {
            // SAFETY: `ctx` is the `bool` below, alive for the whole call.
            let held = unsafe { &mut *(ctx as *mut bool) };
            *held = matches!(
                OUTBOX_MIRROR_LOCK.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
        }
        let mut held = false;
        canari_with_outbox_mirror_lock(
            &mut held as *mut bool as *mut std::ffi::c_void,
            Some(probe),
        );
        assert!(held, "the work ran without the lock");
        assert!(
            OUTBOX_MIRROR_LOCK.try_lock().is_ok(),
            "the lock was not released"
        );
        canari_with_outbox_mirror_lock(std::ptr::null_mut(), None);
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
