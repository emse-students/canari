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

/// The cache directory a file waits in while another app reads it from the share sheet. Its name is
/// also the app's FileProvider path (`res/xml/file_paths.xml`), which exposes this directory alone.
const SHARE_OUT_DIR: &str = "share_out";

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

/// Removes every staged file left in the app cache, and the last file shared out. Called once at
/// start-up, when no save or share can be in flight, so neither leaves a decrypted file behind for
/// longer than one launch.
pub(crate) fn sweep_staged<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_cache_dir() else {
        log::warn!("[gallery] sweep: the app cache directory is unknown");
        return;
    };
    empty_share_out(&dir.join(SHARE_OUT_DIR));
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
            Ok(()) => {
                log::warn!("[gallery] sweep: removed a save interrupted by a restart: {name:?}")
            }
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
    if !valid_name(&name) {
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

/// A file name the page chose, used as the last segment of a cache path: never a path itself.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && !name.contains(['/', '\\']) && !name.contains("..")
}

/// A plain `type/subtype`, as the receiving app is told: nothing that could carry parameters or
/// anything else into the intent.
fn valid_mime(mime: &str) -> bool {
    let Some((kind, sub)) = mime.split_once('/') else {
        return false;
    };
    let token = |t: &str| {
        !t.is_empty()
            && t.len() <= 64
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
    };
    token(kind) && token(sub)
}

/// Deletes whatever the last share left in `share_out/`. A file shared out cannot be deleted when
/// the sheet closes - the receiving app may still be reading it, on its own schedule - so it stays
/// until the next share, the next sign-out or the next launch, and nothing else ever accumulates
/// there. The names are NOT logged: they are the member's attachment names.
fn empty_share_out(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        log::debug!("[gallery] share_out: nothing to empty");
        return;
    };
    let (mut removed, mut kept) = (0u32, 0u32);
    for entry in entries.flatten() {
        match std::fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(e) => {
                kept += 1;
                log::warn!("[gallery] share_out: a file was not removed: {e}");
            }
        }
    }
    log::debug!("[gallery] share_out: {removed} removed, {kept} left");
}

/// Empties `share_out/` at sign-out: the decrypted file the last share left must not outlive the
/// session it was decrypted in. The next share and the next launch empty it too.
#[command]
pub(crate) async fn discard_shared_out<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    log::debug!("[gallery] discard_shared_out");
    empty_share_out(&app.path().app_cache_dir()?.join(SHARE_OUT_DIR));
    Ok(())
}

/// Opens the system share sheet on a text (a message, a link).
#[command]
pub(crate) async fn share_text<R: Runtime>(app: AppHandle<R>, text: String) -> crate::Result<()> {
    log::debug!("[gallery] share_text: {} chars", text.len());
    #[cfg(mobile)]
    {
        app.gallery().share_text(text)
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, text);
        Err(crate::Error::Unsupported)
    }
}

/// Opens the system share sheet on the session's staged file, under `name` and `mime`.
///
/// The staged file is MOVED into `share_out/` (emptied first: one file shared out at a time), the
/// one cache directory the app's FileProvider exposes, because the receiving app reads it through a
/// `content://` grant (Android) or a file URL (iOS) after this call has returned. It stays there
/// until the next share or the next launch (`empty_share_out`). The staged copy is removed on every
/// path that does not move it.
#[command]
pub(crate) async fn share_staged<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    name: String,
    mime: String,
) -> crate::Result<()> {
    let staged = staged_path(&app, &session)?;
    if !valid_name(&name) {
        remove_staged(&staged);
        return Err(crate::Error::BadName);
    }
    if !valid_mime(&mime) {
        remove_staged(&staged);
        return Err(crate::Error::BadMime);
    }
    let dir = app.path().app_cache_dir()?.join(SHARE_OUT_DIR);
    empty_share_out(&dir);
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(&name);
    if let Err(e) = std::fs::rename(&staged, &target) {
        log::error!("[gallery] share_staged {session}: the staged file was not moved: {e}");
        remove_staged(&staged);
        return Err(e.into());
    }
    // The name is the member's attachment name: the size and the type say enough.
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    log::debug!("[gallery] share_staged {session}: {size} bytes, {mime}");
    #[cfg(mobile)]
    {
        app.gallery()
            .share_file(target.to_string_lossy().into_owned(), mime)
    }
    #[cfg(not(mobile))]
    {
        let _ = target;
        Err(crate::Error::Unsupported)
    }
}

fn remove_staged(path: &std::path::Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::debug!("[gallery] {} was not staged", path.display());
        }
        Err(e) => log::warn!(
            "[gallery] the staged copy {} was not removed: {e}",
            path.display()
        ),
    }
}

/// One conversation suggested in the phone's share sheet, as the page sends it: the id
/// (`c:<conversation id>`, Android's shortcut id and iOS's `conversationIdentifier`), the name
/// shown, and the deep link a tap from Android's launcher opens (iOS ignores it). The native side
/// validates each and drops a malformed one (`ShareTargets.kt`, `ShareSuggestions.swift`).
#[derive(serde::Serialize, serde::Deserialize)]
pub struct ShareTarget {
    pub id: String,
    pub label: String,
    pub link: String,
}

/// What a publish left: the suggestions the platform lists afterwards (`present`), and the stale
/// ones it could not remove (`leftover`, still recorded natively) - when that is not 0 the page
/// must not believe the set is the one it asked for.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PublishAnswer {
    pub present: u32,
    pub leftover: u32,
}

/// Replaces the conversations the phone's share sheet suggests (sharing lot S5) with `targets`,
/// most recent first. Answers what the platform holds afterwards and what it left. Android
/// publishes sharing shortcuts (`ShareTargets.kt`); iOS donates one `INSendMessageIntent` per
/// target under one group identifier, after deleting that group (`ShareSuggestions.swift`).
///
/// The labels are conversation names: they are NOT logged, only their count.
#[command]
pub(crate) async fn publish_share_targets<R: Runtime>(
    app: AppHandle<R>,
    targets: Vec<ShareTarget>,
) -> crate::Result<PublishAnswer> {
    log::debug!(
        "[gallery] publish_share_targets: {} target(s)",
        targets.len()
    );
    #[cfg(mobile)]
    {
        app.gallery().publish_share_targets(targets)
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, targets);
        Err(crate::Error::Unsupported)
    }
}

/// Removes every conversation this app suggested to the phone's share sheet - at sign-out, and when
/// the member turns the suggestions off. Returns how many were removed (on iOS, how many the last
/// donation left: the platform deletes a donation group without counting it).
#[command]
pub(crate) async fn clear_share_targets<R: Runtime>(app: AppHandle<R>) -> crate::Result<u32> {
    log::debug!("[gallery] clear_share_targets");
    #[cfg(mobile)]
    {
        app.gallery().clear_share_targets().map(|o| o.removed)
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Err(crate::Error::Unsupported)
    }
}

/// Removes every `chat_<group>` conversation shortcut the message notifications published - at
/// sign-out, beside `clear_share_targets`: they carry a conversation's name and a face, and nothing
/// of an account stays with the system for the next one. Returns how many were removed. Android
/// only, and the page never calls it on iOS: there the notification extension donates no intent
/// and publishes no shortcut, so there is no such set to erase.
#[command]
pub(crate) async fn clear_conversation_shortcuts<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<u32> {
    log::debug!("[gallery] clear_conversation_shortcuts");
    #[cfg(target_os = "android")]
    {
        app.gallery()
            .clear_conversation_shortcuts()
            .map(|o| o.removed)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(crate::Error::AndroidOnly)
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
    use super::{valid_mime, valid_name, valid_session};

    #[test]
    fn a_session_is_a_token_never_a_path() {
        assert!(valid_session("0f8b8f8e-6d1c-4b3e-9a51-2d4f1c9e7a10"));
        assert!(!valid_session(""));
        assert!(!valid_session("../escape"));
        assert!(!valid_session("a/b"));
        assert!(!valid_session(&"a".repeat(65)));
    }

    #[test]
    fn a_shared_name_is_a_last_segment_never_a_path() {
        assert!(valid_name("photo.jpg"));
        assert!(valid_name("Rapport final.pdf"));
        assert!(!valid_name(""));
        assert!(!valid_name("../mls.bin"));
        assert!(!valid_name("a/b.png"));
        assert!(!valid_name("a\\b.png"));
        assert!(!valid_name(&"a".repeat(201)));
    }

    #[test]
    fn a_shared_mime_is_a_plain_type_and_subtype() {
        assert!(valid_mime("image/jpeg"));
        assert!(valid_mime(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ));
        assert!(valid_mime("image/svg+xml"));
        assert!(!valid_mime("image"));
        assert!(!valid_mime("text/plain; charset=utf-8"));
        assert!(!valid_mime("/png"));
        assert!(!valid_mime("image/"));
    }
}
