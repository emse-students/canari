//! `display_names.json`: the names this device already knows, mirrored for the native push path
//! (WP-MENTION-NAME, decided 2026-10-18).
//!
//! A mention travels as `@[<64 hex>]` and a push handler has no name directory, so a banner used to
//! say "@someone" for everybody but its reader. The decision: the name comes from the PHONE'S OWN
//! copy - the names the WebView has already resolved for this account - and never from the push or
//! a network call on the push path. "someone" stays the answer for an id the device has never named.
//!
//! The file is `{"userId": <owner>, "names": {<64 hex id>: <name>}, "firstNames": {<64 hex id>:
//! <first name>}}`. `firstNames` (2026-11-27) is the profile's given name, for the label of an
//! UNNAMED group drawn while the app is dead ([`read_name_book`], `mobile/unnamed_group_label.rs`);
//! it only holds ids `names` holds, and a reader that predates it ignores it. It names its OWNER because it
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

/// Merges `names` (and their `first_names`) into `{dir}/display_names.json` for `owner`, and returns
/// how many names the file holds afterwards.
///
/// - The file names another owner (or none, or cannot be read): it is REPLACED, never merged - the
///   names of one account are not another's to read.
/// - Same owner: a name in `names` overrides the stored one (a renamed person is renamed here too),
///   and a first name in `first_names` overrides the stored first name.
/// - Over [`DISPLAY_NAMES_MAX`]: the names of THIS write are kept first, then the stored ones in key
///   order until the cap. Deterministic, but NOT "the most recent": a batch larger than the cap is
///   cut in key order, and the stored names that survive are the first in key order. A first name
///   is kept only beside a name the file keeps, so the cap holds for both.
///
/// - An id in `removed` is DROPPED, from the stored names and from this write alike, first name
///   included: the server answered that the account does not exist (deleted), so no banner may name
///   it again - a token for it then reads "someone", as the web reads its own label. The caller never
///   puts one id in both, since the later of the two facts wins in `nameMirror.ts`; a removal is
///   applied last.
///
/// Ids are lower-cased; an id that is not a mention id and an empty name are skipped and counted.
pub(crate) fn merge_display_names(
    dir: &Path,
    owner: &str,
    names: &HashMap<String, String>,
    first_names: &HashMap<String, String>,
    removed: &[String],
) -> Result<usize, String> {
    let owner = owner.trim().to_lowercase();
    if owner.is_empty() {
        log::error!("[NAME_MIRROR] refused: no owner");
        return Err("no owner".to_string());
    }
    let path = dir.join(DISPLAY_NAMES_FILE);
    let empty = || (serde_json::Map::new(), serde_json::Map::new());
    let (stored, stored_first) = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(v) if v.get("userId").and_then(|o| o.as_str()) == Some(owner.as_str()) => {
                let map = |key: &str| {
                    v.get(key)
                        .and_then(|n| n.as_object())
                        .cloned()
                        .unwrap_or_default()
                };
                (map("names"), map("firstNames"))
            }
            Ok(_) => {
                log::info!("[NAME_MIRROR] the stored names belong to another account - replaced");
                empty()
            }
            Err(e) => {
                log::warn!("[NAME_MIRROR] stored file unparsable, rebuilt from this write: {e}");
                empty()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => empty(),
        Err(e) => return Err(format!("read {DISPLAY_NAMES_FILE}: {e}")),
    };

    let gone: std::collections::HashSet<String> =
        removed.iter().map(|id| id.trim().to_lowercase()).collect();
    let dropped = stored.keys().filter(|id| gone.contains(*id)).count();

    let mut fresh: Vec<(String, String)> = Vec::with_capacity(names.len());
    let mut skipped = 0usize;
    for (id, name) in names {
        let id = id.trim().to_lowercase();
        let name: String = name.trim().chars().take(DISPLAY_NAME_MAX_CHARS).collect();
        if !is_mention_id(&id) || name.is_empty() || gone.contains(&id) {
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
        if name.is_string() && is_mention_id(&id) && !out.contains_key(&id) && !gone.contains(&id) {
            out.insert(id, name);
        }
    }
    if dropped > 0 {
        log::info!("[NAME_MIRROR] {dropped} name(s) of deleted account(s) dropped");
    }

    // The stored first names, then this write's over them - each only beside a name kept above.
    let mut first_out = serde_json::Map::new();
    for (id, first) in stored_first {
        if first.as_str().is_some_and(|f| !f.trim().is_empty()) && out.contains_key(&id) {
            first_out.insert(id, first);
        }
    }
    for (id, first) in first_names {
        let id = id.trim().to_lowercase();
        let first: String = first.trim().chars().take(DISPLAY_NAME_MAX_CHARS).collect();
        if !first.is_empty() && out.contains_key(&id) {
            first_out.insert(id, serde_json::Value::String(first));
        }
    }

    let count = out.len();
    let root = serde_json::json!({ "userId": owner, "names": out, "firstNames": first_out });
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

/// What `{dir}/display_names.json` holds for its owner: each id's name and, when the profile gave
/// one, its first name. Read by the push path that titles an unnamed group
/// (`mobile/unnamed_group_label.rs`); the mention readers (Kotlin, Swift, ObjC) read `names` alone.
#[cfg_attr(
    not(any(test, target_os = "android", target_os = "ios")),
    allow(dead_code)
)]
#[derive(Debug, Default)]
pub(crate) struct NameBook {
    pub(crate) names: serde_json::Map<String, serde_json::Value>,
    pub(crate) first_names: serde_json::Map<String, serde_json::Value>,
}

#[cfg_attr(
    not(any(test, target_os = "android", target_os = "ios")),
    allow(dead_code)
)]
impl NameBook {
    /// The FIRST name of `id` when the profile gave one, else its name - the order the app's
    /// `getUserFirstNameSync` answers in - or `None` when this device has never named it.
    pub(crate) fn first_name_of(&self, id: &str) -> Option<String> {
        let id = id.trim().to_lowercase();
        [&self.first_names, &self.names]
            .into_iter()
            .filter_map(|map| map.get(&id)?.as_str())
            .map(str::trim)
            .find(|name| !name.is_empty())
            .map(str::to_string)
    }
}

/// Why [`read_name_book`] found no book. Named, never guessed by a caller: each is its own state.
#[cfg_attr(
    not(any(test, target_os = "android", target_os = "ios")),
    allow(dead_code)
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NameBookAbsent {
    /// No file: the WebView never resolved a name on this install. An ordinary state.
    NoFile,
    /// The file is another account's, and is never read for this one. Ordinary after a switch.
    OtherAccount,
    /// The file exists and cannot be read or parsed: a fault.
    Unreadable,
}

#[cfg_attr(
    not(any(test, target_os = "android", target_os = "ios")),
    allow(dead_code)
)]
impl NameBookAbsent {
    /// The token a native caller logs.
    pub(crate) fn token(self) -> &'static str {
        match self {
            Self::NoFile => "no-name-file",
            Self::OtherAccount => "other-account",
            Self::Unreadable => "unreadable",
        }
    }
}

/// Reads `{dir}/display_names.json` for `owner`, or says why it cannot be used.
#[cfg_attr(
    not(any(test, target_os = "android", target_os = "ios")),
    allow(dead_code)
)]
pub(crate) fn read_name_book(dir: &Path, owner: &str) -> Result<NameBook, NameBookAbsent> {
    let bytes = match std::fs::read(dir.join(DISPLAY_NAMES_FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(NameBookAbsent::NoFile),
        Err(_) => return Err(NameBookAbsent::Unreadable),
    };
    let root: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| NameBookAbsent::Unreadable)?;
    if root.get("userId").and_then(|o| o.as_str()) != Some(owner.trim().to_lowercase().as_str()) {
        return Err(NameBookAbsent::OtherAccount);
    }
    let map = |key: &str| {
        root.get(key)
            .and_then(|n| n.as_object())
            .cloned()
            .unwrap_or_default()
    };
    Ok(NameBook {
        names: map("names"),
        first_names: map("firstNames"),
    })
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
/// account), and drops the ids in `removed` - accounts the server answered do not exist. Written to
/// the app's data directory, and on iOS to the App Group container too, which is the only copy the
/// notification extension can read - written here, at the call, rather than left to the next
/// lifecycle mirror, so a banner never waits a whole session for a name.
#[tauri::command]
pub(crate) fn store_display_names(
    app: tauri::AppHandle,
    user_id: String,
    names: HashMap<String, String>,
    first_names: Option<HashMap<String, String>>,
    removed: Vec<String>,
) -> Result<usize, String> {
    use tauri::Manager;
    // Optional only so a page that predates the first names still writes its names.
    let first_names = first_names.unwrap_or_default();
    log::debug!(
        "[NAME_MIRROR] store_display_names: {} name(s), {} first name(s), {} removal(s)",
        names.len(),
        first_names.len(),
        removed.len()
    );
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let held = merge_display_names(&data_dir, &user_id, &names, &first_names, &removed)?;
    #[cfg(target_os = "ios")]
    {
        let group = crate::app_group::app_group_dir().inspect_err(|e| {
            log::error!(
                "[NAME_MIRROR] no App Group container - the extension keeps old names: {e}"
            );
        })?;
        merge_display_names(&group, &user_id, &names, &first_names, &removed)?;
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
        assert_eq!(
            merge_display_names(&dir, OWNER, &first, &HashMap::new(), &[]),
            Ok(2)
        );
        let second = HashMap::from([(id(2).to_uppercase(), " Robert ".to_string())]);
        assert_eq!(
            merge_display_names(&dir, OWNER, &second, &HashMap::new(), &[]),
            Ok(2)
        );
        let v = read(&dir);
        assert_eq!(v["userId"], OWNER);
        assert_eq!(v["names"][id(1)], "Alice");
        assert_eq!(v["names"][id(2)], "Robert", "lower-cased id, trimmed name");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn another_accounts_names_are_replaced_never_merged() {
        let dir = temp_dir("owner");
        merge_display_names(
            &dir,
            "other",
            &HashMap::from([(id(1), "Alice".into())]),
            &HashMap::new(),
            &[],
        )
        .unwrap();
        merge_display_names(
            &dir,
            OWNER,
            &HashMap::from([(id(2), "Bob".into())]),
            &HashMap::new(),
            &[],
        )
        .unwrap();
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
        assert_eq!(
            merge_display_names(&dir, OWNER, &names, &HashMap::new(), &[]),
            Ok(1)
        );
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
        merge_display_names(&dir, OWNER, &old, &HashMap::new(), &[]).unwrap();
        let fresh = HashMap::from([(id(900_000), "New".to_string())]);
        assert_eq!(
            merge_display_names(&dir, OWNER, &fresh, &HashMap::new(), &[]),
            Ok(DISPLAY_NAMES_MAX)
        );
        assert_eq!(read(&dir)["names"][id(900_000)], "New");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deleted_account_is_dropped_and_never_named_again() {
        let dir = temp_dir("gone");
        let first = HashMap::from([(id(1), "Alice".to_string()), (id(2), "Bob".to_string())]);
        merge_display_names(&dir, OWNER, &first, &HashMap::new(), &[]).unwrap();
        // Bob's account is deleted: dropped from the stored names, upper-case id or not.
        assert_eq!(
            merge_display_names(
                &dir,
                OWNER,
                &HashMap::new(),
                &HashMap::new(),
                &[id(2).to_uppercase()]
            ),
            Ok(1)
        );
        let v = read(&dir);
        assert!(
            v["names"].get(id(2)).is_none(),
            "a deleted account kept its name"
        );
        assert_eq!(v["names"][id(1)], "Alice");
        // A removal outranks a name for the same id in the same write.
        let both = HashMap::from([(id(3), "Carol".to_string())]);
        assert_eq!(
            merge_display_names(&dir, OWNER, &both, &HashMap::new(), &[id(3)]),
            Ok(1)
        );
        assert!(read(&dir)["names"].get(id(3)).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_deletion_removes_only_the_deleted_accounts_file() {
        let dir = temp_dir("remove");
        merge_display_names(
            &dir,
            OWNER,
            &HashMap::from([(id(1), "A".into())]),
            &HashMap::new(),
            &[],
        )
        .unwrap();
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

    /// A FIRST NAME is kept beside its name, merged like it, dropped with it, and read back by the
    /// book the unnamed-group label reads - which answers the first name, else the name, else none.
    #[test]
    fn first_names_ride_beside_their_names_and_the_book_reads_them() {
        let dir = temp_dir("first");
        let names = HashMap::from([
            (id(1), "Alice Martin".to_string()),
            (id(2), "Bob Durand".to_string()),
        ]);
        let first = HashMap::from([
            (id(1), " Alice ".to_string()),
            // No name in the file for it: never stored alone.
            (id(9), "Orphan".to_string()),
        ]);
        merge_display_names(&dir, OWNER, &names, &first, &[]).unwrap();
        // A later write that names nobody's first name keeps the stored one.
        merge_display_names(&dir, OWNER, &HashMap::new(), &HashMap::new(), &[]).unwrap();
        let v = read(&dir);
        assert_eq!(v["firstNames"][id(1)], "Alice");
        assert!(v["firstNames"].get(id(9)).is_none());

        let book = read_name_book(&dir, OWNER).unwrap();
        assert_eq!(book.first_name_of(&id(1)).as_deref(), Some("Alice"));
        assert_eq!(
            book.first_name_of(&id(2)).as_deref(),
            Some("Bob Durand"),
            "no first name: the name"
        );
        assert_eq!(book.first_name_of(&id(3)), None);

        // A deleted account loses its first name with its name.
        merge_display_names(&dir, OWNER, &HashMap::new(), &HashMap::new(), &[id(1)]).unwrap();
        assert!(read(&dir)["firstNames"].get(id(1)).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The book says WHY it cannot be used, each state by its own token.
    #[test]
    fn the_book_names_why_it_is_absent() {
        let dir = temp_dir("book");
        assert_eq!(
            read_name_book(&dir, OWNER).unwrap_err(),
            NameBookAbsent::NoFile
        );
        merge_display_names(
            &dir,
            "other",
            &HashMap::from([(id(1), "A".into())]),
            &HashMap::new(),
            &[],
        )
        .unwrap();
        assert_eq!(
            read_name_book(&dir, OWNER).unwrap_err(),
            NameBookAbsent::OtherAccount
        );
        std::fs::write(dir.join(DISPLAY_NAMES_FILE), b"{not json").unwrap();
        assert_eq!(
            read_name_book(&dir, OWNER).unwrap_err().token(),
            "unreadable"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
