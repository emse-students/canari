use std::io::Write;
use std::path::PathBuf;

use base64::Engine;
use tauri::{command, AppHandle, Manager, Runtime};

#[cfg(mobile)]
use crate::GalleryExt;

/// What `save_video` answers: `saved`, or `denied` when the member refused gallery access.
#[derive(serde::Serialize)]
pub struct SaveVideoAnswer {
    pub status: String,
}

/// The prefix every staged file carries in the app cache, so the start-up sweep finds them and
/// nothing else (`sweep_staged`).
const STAGED_PREFIX: &str = "gallery-";

/// A staging session id is the frontend's `crypto.randomUUID()`: a plain token, never a path.
fn valid_session(session: &str) -> bool {
    (1..=64).contains(&session.len())
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The file a session stages into. `.mp4`, because iOS Photos reads the container off the
/// extension of the URL it is given.
fn staged_path<R: Runtime>(app: &AppHandle<R>, session: &str) -> crate::Result<PathBuf> {
    if !valid_session(session) {
        return Err(crate::Error::BadSession);
    }
    let dir = app.path().app_cache_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{STAGED_PREFIX}{session}.mp4")))
}

/// Removes every staged file left in the app cache. Called once at start-up, when no save can be
/// in flight, so a save the process died during leaves no decrypted reel behind for longer than
/// one launch.
pub(crate) fn sweep_staged<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_cache_dir() else {
        log::warn!("[gallery] sweep: the app cache directory is unknown");
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        // No cache directory yet: nothing was ever staged.
        log::debug!("[gallery] sweep: no cache directory");
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(STAGED_PREFIX) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => log::warn!("[gallery] sweep: removed a save interrupted by a restart: {name:?}"),
            Err(e) => log::warn!("[gallery] sweep: {name:?} was not removed: {e}"),
        }
    }
}

/// Appends one base64 chunk of the video to the session's staged file.
///
/// WHY CHUNKS, AND WHY BASE64: on Android every IPC call travels through `postMessage` as JSON -
/// Tauri never uses its custom-protocol transport there, the WebView cannot read a request body - so
/// a raw `Uint8Array` would arrive as a JSON array of numbers, several times the video's size in one
/// string. A chunk of base64 is a third larger than its bytes and bounded.
///
/// `offset` is where the chunk starts. `0` creates (or truncates) the file; any other value must
/// equal the bytes already staged, or the call is refused (`OutOfOrder`) rather than writing a
/// video with a hole or a duplicate in it.
#[command]
pub(crate) async fn append_video_chunk<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    offset: u64,
    data: String,
) -> crate::Result<u64> {
    let path = staged_path(&app, &session)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| crate::Error::BadChunk)?;
    let mut file = if offset == 0 {
        log::debug!("[gallery] stage {session}: start");
        std::fs::File::create(&path)?
    } else {
        let staged = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if staged != offset {
            log::error!("[gallery] stage {session}: chunk at {offset}, {staged} bytes staged");
            return Err(crate::Error::OutOfOrder { offset, staged });
        }
        std::fs::OpenOptions::new().append(true).open(&path)?
    };
    file.write_all(&bytes)?;
    Ok(offset + bytes.len() as u64)
}

/// Hands the session's staged file to the phone's gallery under `name`, then removes it.
///
/// The bytes go through a FILE because both platforms import one (`MediaStore` copies a stream,
/// `PHAssetCreationRequest` reads a URL). The copy is removed whatever the outcome: a decrypted reel
/// must not outlive its save.
#[command]
pub(crate) async fn save_video<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    name: String,
) -> crate::Result<SaveVideoAnswer> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err(crate::Error::BadName);
    }
    let path = staged_path(&app, &session)?;
    log::debug!("[gallery] save_video {session} as {name}");
    #[cfg(mobile)]
    let outcome = app
        .gallery()
        .save_video(path.to_string_lossy().into_owned(), name)
        .map(|o| SaveVideoAnswer { status: o.status });
    #[cfg(not(mobile))]
    let outcome = {
        let _ = name;
        Err(crate::Error::Unsupported)
    };
    remove_staged(&path);
    outcome
}

/// Removes a session's staged file - the frontend's answer to a save that failed before
/// `save_video` was reached.
#[command]
pub(crate) async fn discard_video<R: Runtime>(
    app: AppHandle<R>,
    session: String,
) -> crate::Result<()> {
    log::debug!("[gallery] discard_video {session}");
    remove_staged(&staged_path(&app, &session)?);
    Ok(())
}

fn remove_staged(path: &std::path::Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::debug!("[gallery] {} was not staged", path.display());
        }
        Err(e) => log::warn!("[gallery] the staged copy {} was not removed: {e}", path.display()),
    }
}

/// Opens this app's page in the system settings.
#[command]
pub(crate) async fn open_app_settings<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    log::debug!("[gallery] open_app_settings");
    #[cfg(mobile)]
    {
        app.gallery().open_app_settings()
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Err(crate::Error::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::valid_session;

    #[test]
    fn a_session_is_a_token_never_a_path() {
        assert!(valid_session("0f8b8f8e-6d1c-4b3e-9a51-2d4f1c9e7a10"));
        assert!(!valid_session(""));
        assert!(!valid_session("../escape"));
        assert!(!valid_session("a/b"));
        assert!(!valid_session(&"a".repeat(65)));
    }
}
