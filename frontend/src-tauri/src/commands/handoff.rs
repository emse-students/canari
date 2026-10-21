//! One-shot files the NATIVE side leaves for the page to pick up once it is running.
//!
//! The native layer often acts while the page cannot hear it: a CallKit answer on a locked iPhone,
//! a share that cold-starts the Android app. It writes a small JSON file into the app data
//! directory, and the page drains it - reads it, and the file is gone - at mount and whenever the
//! native side tells a live page to look. Reading and deleting in one command is what makes a
//! handoff happen exactly once.

use tauri::Manager;

/// Reads `{app_data_dir}/{name}`, deletes it, and returns its contents; `None` when there is
/// nothing waiting or it cannot be read (said at warn level under `tag`).
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
    let path = data_dir.join(name);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[{tag}] read failed: {e}");
            return None;
        }
    };
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[{tag}] delete failed: {e}");
    }
    log::info!("[{tag}] {name} drained ({} bytes)", content.len());
    Some(content)
}

/// Drains `pending_share.json`, written by Android's `IncomingShare` when another app shares into
/// Canari: `{"id","text","files":[{"path","name","mime"}],"refused"}`. Each `path` is a copy under
/// the app cache, read and deleted by `take_picked_file`. Null when nothing is waiting.
#[tauri::command]
pub(crate) fn read_and_clear_pending_share(app: tauri::AppHandle) -> Option<String> {
    read_and_clear_app_data_file(&app, "pending_share.json", "SHARE")
}
