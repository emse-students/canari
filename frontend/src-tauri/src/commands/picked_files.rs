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
//! The same command reads the copies of a share INTO Canari (Android), from the one directory those
//! are made in - see `docs/wiki/frontend/sharing.md`.
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
    // The copies Android's `IncomingShare.kt` makes of what another app shared into Canari. That
    // directory, and NOT the whole app cache around it: the cache also holds the WebView's own files
    // and the gallery's decrypted staging, none of which the page may read or delete by name.
    if let Ok(inbox) = app.path().app_cache_dir().map(|d| d.join(SHARED_INBOX)) {
        match inbox.canonicalize() {
            Ok(d) => roots.push(d),
            // Absent until the first share: nothing to read there, and nothing wrong.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[PickedFiles] shared inbox unresolved: {e}"),
        }
    }
    roots
}

/// The directory under the app cache that `IncomingShare.kt` copies shared streams into.
const SHARED_INBOX: &str = "shared_inbox";

/// The canonical form of `path` when it lies under a picker directory; an error (logged) otherwise.
fn allowed_path<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<PathBuf, String> {
    let requested = picked_path(path)?;
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("picked file unreadable: {e}"))?;
    if !is_inside_any(&canonical, &picker_roots(app)) {
        log::error!(
            "[PickedFiles] refused a path outside the picker directories: {}",
            canonical.display()
        );
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
    log::debug!(
        "[PickedFiles] read {} bytes from {}",
        bytes.len(),
        canonical.display()
    );
    if let Err(e) = std::fs::remove_file(&canonical) {
        log::warn!(
            "[PickedFiles] copy kept after read ({e}): {}",
            canonical.display()
        );
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
    log::debug!("[PickedFiles] discarded {}", canonical.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
