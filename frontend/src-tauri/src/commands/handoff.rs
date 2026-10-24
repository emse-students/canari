//! One-shot files the NATIVE side leaves for the page to pick up once it is running.
//!
//! The native layer often acts while the page cannot hear it: a CallKit answer on a locked iPhone,
//! a share that cold-starts the Android app. It writes a small JSON file into the app data
//! directory, and the page drains it - reads it, and the file is gone - at mount and whenever the
//! native side tells a live page to look. Reading and deleting in one command is what makes a
//! handoff happen exactly once.

use tauri::Manager;

/// Takes `{app_data_dir}/{name}`: claims it, reads it, deletes it, and returns its contents; `None`
/// when there is nothing waiting or it cannot be read (said at warn level under `tag`).
///
/// CLAIMED BY A RENAME BEFORE IT IS READ. Reading the file and then deleting it by name would delete
/// whatever sits there by then - a NEWER handoff the native side renamed into place between the two
/// calls, lost unread and unlogged. A rename is atomic on POSIX (Android and iOS, where every
/// handoff runs): it moves exactly the file that was there, and
/// a newer one landing afterwards waits for the next drain. Android's `IncomingShare` claims a
/// waiting share the same way before replacing it, so each manifest has exactly one taker.
pub(crate) fn read_and_clear_app_data_file(
    app: &tauri::AppHandle,
    name: &str,
    tag: &str,
) -> Option<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[{tag}] app_data_dir() failed: {e}");
            return None;
        }
    };
    take_handoff(&data_dir, name, tag)
}

/// The claim itself, on a plain directory: rename `{dir}/{name}` to a claim name, read it, delete it.
fn take_handoff(dir: &std::path::Path, name: &str, tag: &str) -> Option<String> {
    let path = dir.join(name);
    let claimed = dir.join(format!("{name}.draining"));
    match std::fs::rename(&path, &claimed) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[{tag}] claim failed: {e}");
            return None;
        }
    }
    let content = std::fs::read_to_string(&claimed);
    if let Err(e) = std::fs::remove_file(&claimed) {
        log::warn!("[{tag}] delete failed: {e}");
    }
    match content {
        Ok(c) => {
            log::info!("[{tag}] {name} drained ({} bytes)", c.len());
            Some(c)
        }
        Err(e) => {
            log::warn!("[{tag}] read failed: {e}");
            None
        }
    }
}

/// The share EPOCH, a counter in `{app_data_dir}/share_epoch` that every sign-out advances
/// (`advance_share_epoch`). Android's `IncomingShare` reads it when a capture STARTS - and the iOS
/// Share Extension reads the App Group copy the advance also writes - and writes it into the manifest, so the page can tell a share made in an ended session - a copy that was still
/// running when the member signed out - from one made since, and never offer the first to the next
/// account. An ORDER, not a clock: a manifest is stale exactly when a sign-out came after its start.
pub(crate) const SHARE_EPOCH_FILE: &str = "share_epoch";

/// The share manifest's name, in the app data directory and - on iOS - in the App Group, where the
/// Share Extension leaves it for `app_group_share` to carry over.
pub(crate) const PENDING_SHARE_FILE: &str = "pending_share.json";

/// The current epoch; 0 before the first sign-out ever (no file). AN UNREADABLE FILE IS AN ERROR,
/// never 0: read as 0, every manifest would look current (a share of the account that left, offered
/// to the next), and an advance from 0 would move the order BACKWARDS.
pub(crate) fn read_share_epoch(dir: &std::path::Path) -> std::io::Result<u64> {
    match std::fs::read_to_string(dir.join(SHARE_EPOCH_FILE)) {
        Ok(raw) => raw
            .trim()
            .parse()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e),
    }
}

/// Writes the next epoch, whole or not at all (a temporary file renamed into place), and returns it.
/// Refuses when the current one cannot be read, rather than restarting the count.
fn advance_share_epoch_in(dir: &std::path::Path) -> std::io::Result<u64> {
    let next = read_share_epoch(dir)? + 1;
    write_share_epoch(dir, next)?;
    Ok(next)
}

/// Writes `value` as `{dir}/share_epoch`, whole or not at all: a reader in another process (the
/// iOS Share Extension reads the App Group copy) never sees half of it.
pub(crate) fn write_share_epoch(dir: &std::path::Path, value: u64) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let staging = dir.join(format!("{SHARE_EPOCH_FILE}.tmp"));
    std::fs::write(&staging, value.to_string())?;
    std::fs::rename(&staging, dir.join(SHARE_EPOCH_FILE))
}

/// A drained share manifest, with the epoch current when it was drained - `None` when it could not be
/// read, and then the page offers nothing (it cannot tell this session's share from the last one's).
#[derive(serde::Serialize)]
pub(crate) struct PendingShare {
    manifest: String,
    epoch: Option<u64>,
}

/// Drains `pending_share.json`, written by Android's `IncomingShare` when another app shares into
/// Canari: `{"id","epoch","text","files":[{"path","name","mime","size"}],"refused"}`. Each `path` is
/// a copy under the app cache, read and deleted by `take_picked_file`, or deleted unread by
/// `discard_picked_file`. Null when nothing is waiting. The current share epoch rides along, read
/// AFTER the claim, so a sign-out that came before the drain makes an older manifest stale.
///
/// On iOS the Share Extension writes its manifest into the App Group, which this process alone
/// cannot drain from: it is carried into the app data directory FIRST (`app_group_share`), so every
/// drain - and the sign-out's erase, which claims through this same command - also sees a share the
/// native side has not imported yet.
#[tauri::command]
pub(crate) fn read_and_clear_pending_share(app: tauri::AppHandle) -> Option<PendingShare> {
    #[cfg(target_os = "ios")]
    super::app_group_share::import_for_app(&app);
    let manifest = read_and_clear_app_data_file(&app, PENDING_SHARE_FILE, "SHARE")?;
    let epoch = match app.path().app_data_dir() {
        Ok(dir) => read_share_epoch(&dir)
            .inspect_err(|e| log::error!("[SHARE] the share epoch is unreadable: {e}"))
            .ok(),
        Err(e) => {
            log::error!("[SHARE] app_data_dir() failed reading the share epoch: {e}");
            None
        }
    };
    Some(PendingShare { manifest, epoch })
}

/// Advances the share epoch at a sign-out: every share captured before now is from the session that
/// ends, and is never offered again. Returns the new epoch.
///
/// On iOS the advance is ALSO written into the App Group (`share_epoch` there), the only copy the
/// Share Extension - another process, with a container of its own - can read when a capture starts.
/// It fails closed like the rest: an advance whose App Group copy is not written is an ERROR, and the
/// page then fences this process at `Infinity` - a capture stamped with the stale copy would
/// otherwise look current. The app data copy stays the authority: it is written first, and the
/// App Group copy can only lag it, which makes a capture look OLDER (dropped), never newer.
#[tauri::command]
pub(crate) fn advance_share_epoch(app: tauri::AppHandle) -> Result<u64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir() failed: {e}"))?;
    let next =
        advance_share_epoch_in(&dir).map_err(|e| format!("share epoch not advanced: {e}"))?;
    log::info!("[SHARE] share epoch advanced to {next}");
    #[cfg(target_os = "ios")]
    {
        let copied = crate::app_group::app_group_dir()
            .and_then(|group| write_share_epoch(&group, next).map_err(|e| e.to_string()));
        if let Err(e) = copied {
            log::error!("[SHARE] share epoch {next} not written into the App Group: {e}");
            return Err(format!(
                "share epoch advanced to {next}, but the App Group copy was not written: {e}"
            ));
        }
        log::info!("[SHARE] share epoch {next} written into the App Group");
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::{advance_share_epoch_in, read_share_epoch, take_handoff, write_share_epoch};

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canari-handoff-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_handoff_is_taken_exactly_once() {
        let dir = scratch("once");
        std::fs::write(dir.join("h.json"), "{}").expect("write");
        assert_eq!(take_handoff(&dir, "h.json", "T").as_deref(), Some("{}"));
        assert_eq!(take_handoff(&dir, "h.json", "T"), None);
        assert!(std::fs::read_dir(&dir).expect("dir").next().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// POSIX only, and so is the guarantee: `rename(2)` resolves the source PATH atomically, so the
    /// second taker gets `ENOENT`. Windows' std rename opens a handle on the file and then renames
    /// the handle, so a taker that opened `h.json` before the other's rename renames the CLAIMED
    /// file and both read it (measured: 2 winners in round 6 of 50). The handoffs run on Android and
    /// iOS only - a share and a CallKit answer have no desktop path.
    #[cfg(unix)]
    #[test]
    fn two_takers_racing_for_one_handoff_give_it_to_one() {
        for round in 0..50 {
            let dir = scratch(&format!("race{round}"));
            std::fs::write(dir.join("h.json"), "{\"id\":1}").expect("write");
            let takers: Vec<_> = (0..2)
                .map(|_| {
                    let dir = dir.clone();
                    std::thread::spawn(move || take_handoff(&dir, "h.json", "T"))
                })
                .collect();
            let won = takers
                .into_iter()
                .filter_map(|t| t.join().expect("taker"))
                .count();
            assert_eq!(won, 1, "round {round}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_newer_handoff_written_after_the_claim_waits_for_the_next_drain() {
        let dir = scratch("newer");
        std::fs::write(dir.join("h.json"), "old").expect("write");
        assert_eq!(take_handoff(&dir, "h.json", "T").as_deref(), Some("old"));
        // The native side renames a newer manifest into place after the claim: it is not touched.
        std::fs::write(dir.join("h.json"), "new").expect("write");
        assert_eq!(take_handoff(&dir, "h.json", "T").as_deref(), Some("new"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_share_epoch_starts_at_zero_and_each_sign_out_advances_it() {
        let dir = scratch("epoch");
        assert_eq!(read_share_epoch(&dir).expect("read"), 0);
        assert_eq!(advance_share_epoch_in(&dir).expect("advance"), 1);
        assert_eq!(advance_share_epoch_in(&dir).expect("advance"), 2);
        assert_eq!(read_share_epoch(&dir).expect("read"), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The iOS App Group copy is written by the same function, whole: the Share Extension reads
    /// exactly what the app data copy says.
    #[test]
    fn the_app_group_copy_of_the_epoch_reads_back_as_written() {
        let dir = scratch("epoch-copy");
        write_share_epoch(&dir, 7).expect("write");
        assert_eq!(read_share_epoch(&dir).expect("read"), 7);
        assert!(!dir
            .join(format!("{}.tmp", super::SHARE_EPOCH_FILE))
            .exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_share_epoch_is_an_error_and_never_restarts_the_count() {
        let dir = scratch("epoch-corrupt");
        std::fs::write(dir.join(super::SHARE_EPOCH_FILE), "not a number").expect("write");
        assert!(read_share_epoch(&dir).is_err());
        assert!(advance_share_epoch_in(&dir).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join(super::SHARE_EPOCH_FILE)).expect("read"),
            "not a number"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
