//! Hands the WebView a file the SYSTEM picker copied into the app's sandbox, then deletes the copy.
//!
//! WHY THIS EXISTS (user, 2026-10-02, iPhone): in the iOS app the composer's "+" opened Canari's
//! menu, and its "Photos et videos" then opened a SECOND, native one (Phototheque / Prendre une
//! photo / Choisir les fichiers). That second sheet is WebKit's: `WKFileUploadPanel` shows it for
//! every `<input type="file">` that accepts images or videos (Canari has no `capture` input since
//! 2026-10-11: its camera is the in-app overlay, never the system one), and no
//! `accept` value a page can write skips it. So the photo library is opened natively instead,
//! through `tauri-plugin-dialog`'s `PHPickerViewController`, which COPIES each pick into
//! `Library/Caches` (and the document picker, `asCopy`, into `tmp/`). This command is the read
//! half: the page names the copy, receives its bytes, and the copy is gone.
//!
//! A COMMAND THAT READS AND DELETES A PATH THE PAGE NAMES TAKES AN ALLOWLIST, NEVER A DENYLIST: only
//! a file under the canonical caches or temporary directory - the two places the pickers write - is
//! touched, and `..` or a symlink cannot reach outside them because the CANONICAL path is compared.
//! The same command reads the copies of a share INTO Canari (Android, and iOS once the app has carried
//! the Share Extension's copies out of the App Group), from the one directory those are made in -
//! see `docs/wiki/frontend/sharing.md`.
//! See `docs/wiki/frontend/modules/chat.md` (the attachment menu).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// Whether `path` (already canonical) lies inside one of `roots` (already canonical).
///
/// Component-wise (`Path::starts_with`), so `/cache-evil/x` is not inside `/cache`.
pub(crate) fn is_inside_any(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Turns what the dialog plugin returned - a `file://` URL on iOS, a plain path elsewhere - into a
/// path. A URL is percent-decoded by the URL parser, so a name with a space is found.
pub(crate) fn picked_path(raw: &str) -> Result<PathBuf, String> {
    if raw.starts_with("file://") {
        let url = tauri::Url::parse(raw).map_err(|e| format!("not a file URL: {e}"))?;
        return url
            .to_file_path()
            .map_err(|_| "file URL without a local path".to_string());
    }
    Ok(PathBuf::from(raw))
}

/// The directories a system picker writes its copies to, canonical. A directory that cannot be
/// resolved is left out and said at warn level: it only narrows what can be read.
fn picker_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for (name, dir) in [
        ("cache", app.path().cache_dir()),
        ("temp", app.path().temp_dir()),
    ] {
        match dir.and_then(|d| d.canonicalize().map_err(tauri::Error::from)) {
            Ok(d) => roots.push(d),
            Err(e) => log::warn!("[PickedFiles] {name} directory unresolved: {e}"),
        }
    }
    // The copies Android's `IncomingShare.kt` makes of what another app shared into Canari (and that
    // iOS moves there out of the App Group, `app_group_share`). That directory, and NOT the whole app
    // cache around it: the cache also holds the WebView's own files
    // and the gallery's decrypted staging, none of which the page may read or delete by name.
    roots.extend(shared_inbox_root(app));
    roots
}

/// The app cache's `shared_inbox`, canonical; `None` before the first share (nothing to read there,
/// and nothing wrong) or when unresolved (said at warn level).
fn shared_inbox_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let inbox = app.path().app_cache_dir().ok()?.join(SHARED_INBOX);
    match inbox.canonicalize() {
        Ok(d) => Some(d),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("[PickedFiles] shared inbox unresolved: {e}");
            None
        }
    }
}

/// Once the last copy of a share is read or discarded, its `shared_inbox/<id>/` is empty: removed
/// here rather than left for the next process's sweep. Only a directory DIRECTLY under the inbox, and
/// only when empty (`remove_dir` refuses one that is not, so a copy still waiting is never touched);
/// nobody writes into a share's directory once its manifest is handed over, which is the only way the
/// page learns its id.
pub(crate) fn remove_emptied_share_dir(file: &Path, inbox: &Path) {
    let Some(dir) = file.parent() else { return };
    if dir.parent() != Some(inbox) {
        return;
    }
    // The directory's name is the share id the extension or `IncomingShare.kt` made: an id, never a
    // name the sender chose.
    let id = dir.file_name().unwrap_or_default().to_string_lossy();
    match std::fs::remove_dir(dir) {
        Ok(()) => log::debug!("[PickedFiles] emptied share directory removed: share {id}"),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
            ) => {}
        Err(e) => log::warn!("[PickedFiles] emptied share directory kept ({e}): share {id}"),
    }
}

/// What a log line may say of a picked or shared copy: the id of the share it belongs to, or that
/// it is a picker's copy - NEVER its path. A shared copy is named `<index>_<sender's file name>` and
/// a picker's copy keeps the photo's or document's own name, and a file name is content a log line
/// does not carry (`docs/wiki/frontend/mobile.md`, "What a native log line may carry").
pub(crate) fn copy_label(file: &Path, inbox: Option<&Path>) -> String {
    match (file.parent(), inbox) {
        (Some(dir), Some(inbox)) if dir.parent() == Some(inbox) => format!(
            "a copy of share {}",
            dir.file_name().unwrap_or_default().to_string_lossy()
        ),
        _ => "a picker copy".to_string(),
    }
}

/// The directory under the app cache that `IncomingShare.kt` copies shared streams into - and, on
/// iOS, the name of the Share Extension's directory in the App Group, whose share directories the
/// app moves under the app cache by the same name.
pub(crate) const SHARED_INBOX: &str = "shared_inbox";

/// The canonical form of `path` when it lies under a picker directory; an error (logged) otherwise.
fn allowed_path<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<PathBuf, String> {
    let requested = picked_path(path)?;
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("picked file unreadable: {e}"))?;
    if !is_inside_any(&canonical, &picker_roots(app)) {
        // The path is the page's, and may name anything: said without it.
        log::error!("[PickedFiles] refused a path outside the picker directories");
        return Err("path outside the picker directories".to_string());
    }
    Ok(canonical)
}

/// Reads the picker's copy at `path`, deletes it, and returns its bytes as a raw IPC body.
///
/// Refuses (and touches nothing) when the canonical path is outside the picker directories.
/// A failed delete is logged and does not fail the read: the bytes are already in hand, and the
/// copy sits in a directory the OS purges.
#[tauri::command]
pub(crate) async fn take_picked_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let canonical = allowed_path(&app, &path)?;
    let bytes = std::fs::read(&canonical).map_err(|e| format!("picked file unreadable: {e}"))?;
    let inbox = shared_inbox_root(&app);
    let label = copy_label(&canonical, inbox.as_deref());
    log::debug!("[PickedFiles] read {} bytes from {label}", bytes.len());
    match std::fs::remove_file(&canonical) {
        Ok(()) => {
            if let Some(inbox) = &inbox {
                remove_emptied_share_dir(&canonical, inbox);
            }
        }
        Err(e) => log::warn!("[PickedFiles] {label} kept after read ({e})"),
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Deletes the picker's copy at `path` UNREAD: the page will not stage it (the member dropped the
/// share, a newer one replaced it, or it is over the upload ceiling) and must not leave it on disk.
/// The same allowlist as `take_picked_file`, so it can delete nothing that command could not.
#[tauri::command]
pub(crate) async fn discard_picked_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), String> {
    let canonical = allowed_path(&app, &path)?;
    std::fs::remove_file(&canonical).map_err(|e| format!("picked file not deleted: {e}"))?;
    let inbox = shared_inbox_root(&app);
    log::debug!(
        "[PickedFiles] discarded {}",
        copy_label(&canonical, inbox.as_deref())
    );
    if let Some(inbox) = &inbox {
        remove_emptied_share_dir(&canonical, inbox);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_emptied_share_directory_goes_and_nothing_else_does() {
        let root = std::env::temp_dir().join(format!("canari-emptied-{}", std::process::id()));
        let inbox = root.join(SHARED_INBOX);
        let (empty, full, deep) = (inbox.join("a"), inbox.join("b"), inbox.join("c").join("d"));
        for d in [&empty, &full, &deep] {
            std::fs::create_dir_all(d).expect("dir");
        }
        std::fs::write(full.join("kept.png"), b"x").expect("file");

        remove_emptied_share_dir(&empty.join("0_gone.png"), &inbox);
        remove_emptied_share_dir(&full.join("0_gone.png"), &inbox);
        remove_emptied_share_dir(&deep.join("0_gone.png"), &inbox);
        remove_emptied_share_dir(&inbox.join("loose.png"), &inbox);

        assert!(!empty.exists(), "the emptied share directory is removed");
        assert!(
            full.join("kept.png").exists(),
            "a share still holding a copy is kept"
        );
        assert!(
            deep.exists(),
            "nothing deeper than a share directory is touched"
        );
        assert!(inbox.exists(), "the inbox itself is never removed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_copy_is_named_by_its_share_id_never_by_its_file_name() {
        let inbox = Path::new("/var/app/Library/Caches/fr.emse.canari/shared_inbox");
        let shared = inbox.join("4F1C-AB").join("0_Holiday plans.pdf");
        assert_eq!(copy_label(&shared, Some(inbox)), "a copy of share 4F1C-AB");
        let picked = Path::new("/var/app/Library/Caches/IMG_0001.heic");
        assert_eq!(copy_label(picked, Some(inbox)), "a picker copy");
        assert_eq!(copy_label(&shared, None), "a picker copy");
    }

    #[test]
    fn a_file_under_a_root_is_inside() {
        let roots = vec![PathBuf::from("/var/app/Library/Caches")];
        assert!(is_inside_any(
            Path::new("/var/app/Library/Caches/IMG_0001.heic"),
            &roots
        ));
    }

    #[test]
    fn a_sibling_sharing_a_prefix_is_not_inside() {
        let roots = vec![PathBuf::from("/var/app/Library/Caches")];
        assert!(!is_inside_any(
            Path::new("/var/app/Library/CachesEvil/x"),
            &roots
        ));
        assert!(!is_inside_any(
            Path::new("/var/app/Documents/mls.bin"),
            &roots
        ));
    }

    #[test]
    fn no_root_means_nothing_is_inside() {
        assert!(!is_inside_any(Path::new("/tmp/x"), &[]));
    }

    #[test]
    fn a_plain_path_is_kept() {
        assert_eq!(
            picked_path("/tmp/a b.jpg").unwrap(),
            PathBuf::from("/tmp/a b.jpg")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_url_is_percent_decoded() {
        assert_eq!(
            picked_path("file:///private/var/tmp/a%20b.mov").unwrap(),
            PathBuf::from("/private/var/tmp/a b.mov")
        );
    }
}
