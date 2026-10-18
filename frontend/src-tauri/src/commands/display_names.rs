//! `display_names.json`: the names this device already knows, mirrored for the native push path
//! (WP-MENTION-NAME, decided 2026-10-18).
//!
//! A mention travels as `@[<64 hex>]` and a push handler has no name directory, so a banner used to
//! say "@someone" for everybody but its reader. The decision: the name comes from the PHONE'S OWN
//! copy - the names the WebView has already resolved for this account - and never from the push or
//! a network call on the push path. "someone" stays the answer for an id the device has never named.
//!
//! The file is `{"userId": <owner>, "names": {<64 hex id>: <name>}}`. It names its OWNER because it
//! is one file per install and two accounts may sign in on one phone: every reader (Kotlin
//! `MentionNames`, the NSE, `canari_push.mm`) uses it only when the owner is the account in
//! `push_context.json`, and the account deletion removes it only when the owner is the deleted one.
//! Readers live in another process (the FCM service, the iOS extension), so it is written through a
//! temporary file renamed over the old one: a reader never sees half a file.

use std::collections::HashMap;
use std::path::Path;

/// The file every native reader opens, in the app's data directory (and, on iOS, in the App Group
/// container the notification extension reads).
pub(crate) const DISPLAY_NAMES_FILE: &str = "display_names.json";

/// At most this many names are kept. A name is ~100 bytes on disk, so the file stays near 200 KB:
/// a push handler parses it once per banner that carries a mention, and the iOS extension runs
/// under a memory ceiling of its own.
pub(crate) const DISPLAY_NAMES_MAX: usize = 2000;

/// The longest name kept, in characters. A display name is a person's name; anything longer is
/// truncated rather than refused, since the banner truncates the body anyway.
const DISPLAY_NAME_MAX_CHARS: usize = 100;

/// Whether `id` is what a mention token can name: 64 hex characters, lower-cased by the caller.
/// Anything else could never be looked up, so it is not stored.
fn is_mention_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Merges `names` into `{dir}/display_names.json` for `owner`, and returns how many names the file
/// holds afterwards.
///
/// - The file names another owner (or none, or cannot be read): it is REPLACED, never merged - the
///   names of one account are not another's to read.
/// - Same owner: a name in `names` overrides the stored one (a renamed person is renamed here too).
/// - Over [`DISPLAY_NAMES_MAX`]: the names of THIS write are kept first, then the stored ones in key
///   order until the cap - so what the app resolved most recently survives, deterministically.
///
/// Ids are lower-cased; an id that is not a mention id and an empty name are skipped and counted.
pub(crate) fn merge_display_names(
    dir: &Path,
    owner: &str,
    names: &HashMap<String, String>,
) -> Result<usize, String> {
    let owner = owner.trim().to_lowercase();
    if owner.is_empty() {
        log::error!("[NAME_MIRROR] refused: no owner");
        return Err("no owner".to_string());
    }
    let path = dir.join(DISPLAY_NAMES_FILE);
    let stored: serde_json::Map<String, serde_json::Value> = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(v) if v.get("userId").and_then(|o| o.as_str()) == Some(owner.as_str()) => v
                .get("names")
                .and_then(|n| n.as_object())
                .cloned()
                .unwrap_or_default(),
            Ok(_) => {
                log::info!("[NAME_MIRROR] the stored names belong to another account - replaced");
                serde_json::Map::new()
            }
            Err(e) => {
                log::warn!("[NAME_MIRROR] stored file unparsable, rebuilt from this write: {e}");
                serde_json::Map::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("read {DISPLAY_NAMES_FILE}: {e}")),
    };

    let mut fresh: Vec<(String, String)> = Vec::with_capacity(names.len());
    let mut skipped = 0usize;
    for (id, name) in names {
        let id = id.trim().to_lowercase();
        let name: String = name.trim().chars().take(DISPLAY_NAME_MAX_CHARS).collect();
        if !is_mention_id(&id) || name.is_empty() {
            skipped += 1;
            continue;
        }
        fresh.push((id, name));
    }
    // Key order, so a write larger than the cap keeps the same names whatever order the map gave.
    fresh.sort();

    let mut out = serde_json::Map::new();
    for (id, name) in fresh.into_iter().take(DISPLAY_NAMES_MAX) {
        out.insert(id, serde_json::Value::String(name));
    }
    for (id, name) in stored {
        if out.len() >= DISPLAY_NAMES_MAX {
            break;
        }
        if name.is_string() && is_mention_id(&id) && !out.contains_key(&id) {
            out.insert(id, name);
        }
    }

    let count = out.len();
    let root = serde_json::json!({ "userId": owner, "names": out });
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{DISPLAY_NAMES_FILE}.tmp"));
    std::fs::write(&tmp, root.to_string())
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("write {DISPLAY_NAMES_FILE}: {e}"))?;
    log::debug!(
        "[NAME_MIRROR] {} name(s) written, {skipped} skipped, {count} held",
        names.len() - skipped
    );
    Ok(count)
}

/// Removes `{dir}/display_names.json` ONLY when it names `owner` - the account deletion's rule
/// (WP-DEL-LOCAL): an unknown or other owner is never a licence to delete. Returns whether a file
/// was removed.
pub(crate) fn remove_display_names_of(dir: &Path, owner: &str) -> Result<bool, String> {
    let path = dir.join(DISPLAY_NAMES_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {DISPLAY_NAMES_FILE}: {e}")),
    };
    let named = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("userId")?.as_str().map(str::to_string));
    if named.as_deref() != Some(owner.trim().to_lowercase().as_str()) {
        log::info!("[NAME_MIRROR] {DISPLAY_NAMES_FILE} is not the deleted account's - left alone");
        return Ok(false);
    }
    std::fs::remove_file(&path).map_err(|e| format!("remove {DISPLAY_NAMES_FILE}: {e}"))?;
    log::info!("[NAME_MIRROR] {DISPLAY_NAMES_FILE} of the deleted account removed");
    Ok(true)
}

/// Mirrors the names the WebView resolved since its last call, for `user_id` (the signed-in
/// account). Written to the app's data directory, and on iOS to the App Group container too, which
/// is the only copy the notification extension can read - written here, at the call, rather than
/// left to the next lifecycle mirror, so a banner never waits a whole session for a name.
#[tauri::command]
pub(crate) fn store_display_names(
    app: tauri::AppHandle,
    user_id: String,
    names: HashMap<String, String>,
) -> Result<usize, String> {
    use tauri::Manager;
    log::debug!("[NAME_MIRROR] store_display_names: {} name(s)", names.len());
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let held = merge_display_names(&data_dir, &user_id, &names)?;
    #[cfg(target_os = "ios")]
    {
        let group = crate::app_group::app_group_dir().map_err(|e| {
            log::error!(
                "[NAME_MIRROR] no App Group container - the extension keeps old names: {e}"
            );
            e
        })?;
        merge_display_names(&group, &user_id, &names)?;
    }
    Ok(held)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-names-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn id(n: u32) -> String {
        format!("{n:064x}")
    }

    fn read(dir: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join(DISPLAY_NAMES_FILE)).unwrap()).unwrap()
    }

    const OWNER: &str = "ab";

    #[test]
    fn names_are_merged_for_the_same_owner_and_a_rename_overrides() {
        let dir = temp_dir("merge");
        let first = HashMap::from([(id(1), "Alice".to_string()), (id(2), "Bob".to_string())]);
        assert_eq!(merge_display_names(&dir, OWNER, &first), Ok(2));
        let second = HashMap::from([(id(2).to_uppercase(), " Robert ".to_string())]);
        assert_eq!(merge_display_names(&dir, OWNER, &second), Ok(2));
        let v = read(&dir);
        assert_eq!(v["userId"], OWNER);
        assert_eq!(v["names"][id(1)], "Alice");
        assert_eq!(v["names"][id(2)], "Robert", "lower-cased id, trimmed name");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn another_accounts_names_are_replaced_never_merged() {
        let dir = temp_dir("owner");
        merge_display_names(&dir, "other", &HashMap::from([(id(1), "Alice".into())])).unwrap();
        merge_display_names(&dir, OWNER, &HashMap::from([(id(2), "Bob".into())])).unwrap();
        let v = read(&dir);
        assert_eq!(v["userId"], OWNER);
        assert!(
            v["names"].get(id(1)).is_none(),
            "the other account's name leaked"
        );
        assert_eq!(v["names"][id(2)], "Bob");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn what_no_mention_can_name_is_not_stored() {
        let dir = temp_dir("skip");
        let names = HashMap::from([
            ("not-hex".to_string(), "X".to_string()),
            (id(1), "   ".to_string()),
            (id(2), "B".repeat(300)),
        ]);
        assert_eq!(merge_display_names(&dir, OWNER, &names), Ok(1));
        assert_eq!(
            read(&dir)["names"][id(2)].as_str().unwrap().chars().count(),
            DISPLAY_NAME_MAX_CHARS
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_cap_keeps_this_writes_names_first() {
        let dir = temp_dir("cap");
        let old: HashMap<String, String> = (0..DISPLAY_NAMES_MAX as u32)
            .map(|n| (id(n), format!("old {n}")))
            .collect();
        merge_display_names(&dir, OWNER, &old).unwrap();
        let fresh = HashMap::from([(id(900_000), "New".to_string())]);
        assert_eq!(
            merge_display_names(&dir, OWNER, &fresh),
            Ok(DISPLAY_NAMES_MAX)
        );
        assert_eq!(read(&dir)["names"][id(900_000)], "New");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_deletion_removes_only_the_deleted_accounts_file() {
        let dir = temp_dir("remove");
        merge_display_names(&dir, OWNER, &HashMap::from([(id(1), "A".into())])).unwrap();
        assert_eq!(remove_display_names_of(&dir, "someone-else"), Ok(false));
        assert!(dir.join(DISPLAY_NAMES_FILE).exists());
        assert_eq!(remove_display_names_of(&dir, OWNER), Ok(true));
        assert!(!dir.join(DISPLAY_NAMES_FILE).exists());
        assert_eq!(
            remove_display_names_of(&dir, OWNER),
            Ok(false),
            "idempotent"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
