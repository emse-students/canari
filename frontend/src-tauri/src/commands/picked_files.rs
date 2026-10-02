//! Hands the WebView a file the SYSTEM picker copied into the app's sandbox, then deletes the copy.
//!
//! WHY THIS EXISTS (user, 2026-10-02, iPhone): in the iOS app the composer's "+" opened Canari's
//! menu, and its "Photos et videos" then opened a SECOND, native one (Phototheque / Prendre une
//! photo / Choisir les fichiers). That second sheet is WebKit's: `WKFileUploadPanel` shows it for
//! every `<input type="file">` that accepts images or videos and carries no `capture`, and no
//! `accept` value a page can write skips it. So the photo library is opened natively instead,
//! through `tauri-plugin-dialog`'s `PHPickerViewController`, which COPIES each pick into
//! `Library/Caches` (and the document picker, `asCopy`, into `tmp/`). This command is the read
//! half: the page names the copy, receives its bytes, and the copy is gone.
//!
//! A COMMAND THAT READS AND DELETES A PATH THE PAGE NAMES TAKES AN ALLOWLIST, NEVER A DENYLIST: only
//! a file under the canonical caches or temporary directory - the two places the pickers write - is
//! touched, and `..` or a symlink cannot reach outside them because the CANONICAL path is compared.
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
    roots
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
    let requested = picked_path(&path)?;
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("picked file unreadable: {e}"))?;
    let roots = picker_roots(&app);
    if !is_inside_any(&canonical, &roots) {
        log::error!(
            "[PickedFiles] refused a path outside the picker directories: {}",
            canonical.display()
        );
        return Err("path outside the picker directories".to_string());
    }
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
