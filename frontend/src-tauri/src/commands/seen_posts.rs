//! `seen_posts.json`: the posts this device displayed, mirrored for the native push path (owner,
//! 2026-11-24, "Verif sur l'appareil").
//!
//! A campus trend ("Suggestion : ...") can announce a post the member already saw in the feed: the
//! server records no "seen" and must not (charter, principles 1 and 3 of `docs/principes.md`). The
//! DEVICE keeps the record - the WebView notes each post card it displayed (`seenPosts.svelte.ts`) -
//! and a trend for one of them shows no banner and no bell row. NOTHING is sent to the server; the
//! accepted limit is that a post seen on another device is not recognised.
//!
//! The FCM service, the iOS extension and `canari_push.mm` compose the banner while the app is closed
//! and cannot ask the WebView, so the WebView hands them its record here and they read this file under
//! the rule of `libs/contracts/notification-seen-trend.cases.json`: a push whose `contentKey` is a
//! trend key and whose `postId` is in `posts` is withheld.
//!
//! The file is `{"userId": <owner>, "posts": {<post id>: <publishedAt, epoch ms>}}`. It names its
//! OWNER because it is one file per install: every reader uses it only when the owner is the account
//! in `push_context.json`, a write for another owner REPLACES it, and the sign-out
//! ([`forget_seen_posts`]) and the account deletion remove it only when it is that account's. Each
//! write STATES THE WHOLE RECORD (the WebView prunes by age before it writes - a post older than the
//! trend window can never be announced again), so this file never grows on its own. Written through
//! a temporary file renamed over the old one: a reader in another process never sees half a file.

use std::collections::BTreeMap;
use std::path::Path;

/// The file every native reader opens, in the app's data directory (and, on iOS, in the App Group
/// container the notification extension reads).
pub(crate) const SEEN_POSTS_FILE: &str = "seen_posts.json";

/// At most this many posts are kept - the client's own cap (`SEEN_POSTS_MAX`). A post is ~50 bytes
/// here, so the file stays near 25 KB for the extension's memory ceiling. The NEWEST publications win.
pub(crate) const SEEN_POSTS_MAX: usize = 500;

/// One post the WebView displayed.
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeenPost {
    pub post_id: String,
    /// The post's `publishedAt` as epoch milliseconds - the instant its entry is pruned by.
    pub published_at: f64,
}

/// A post id as a reader looks it up: lower-case, a uuid's 36 characters of hex and dashes. Anything
/// else could never match a push's `postId`, so it is not stored.
fn normalise_post_id(id: &str) -> Option<String> {
    let id = id.trim().to_lowercase();
    let well_formed = id.len() == 36
        && id
            .bytes()
            .all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    well_formed.then_some(id)
}

/// Replaces `{dir}/seen_posts.json` with `posts` for `owner`, and returns how many posts the file
/// holds afterwards. Ids that are not a post id and instants that are not a number are skipped and
/// counted; over [`SEEN_POSTS_MAX`] the OLDEST publications are dropped (ties by id, so the cut is
/// the same whatever order the WebView sent).
pub(crate) fn replace_seen_posts(
    dir: &Path,
    owner: &str,
    posts: &[SeenPost],
) -> Result<usize, String> {
    let owner = owner.trim().to_lowercase();
    if owner.is_empty() {
        log::error!("[SEEN_TREND] refused: no owner");
        return Err("no owner".to_string());
    }
    let mut kept: BTreeMap<String, i64> = BTreeMap::new();
    let mut skipped = 0usize;
    for post in posts {
        match (
            normalise_post_id(&post.post_id),
            post.published_at.is_finite(),
        ) {
            (Some(id), true) => {
                kept.insert(id, post.published_at as i64);
            }
            _ => skipped += 1,
        }
    }
    let mut dropped = 0usize;
    if kept.len() > SEEN_POSTS_MAX {
        let mut oldest_first: Vec<(String, i64)> = kept.clone().into_iter().collect();
        oldest_first.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        for (id, _) in oldest_first.into_iter().take(kept.len() - SEEN_POSTS_MAX) {
            kept.remove(&id);
            dropped += 1;
        }
    }
    let count = kept.len();
    let root = serde_json::json!({ "userId": owner, "posts": kept });
    let path = dir.join(SEEN_POSTS_FILE);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{SEEN_POSTS_FILE}.tmp"));
    std::fs::write(&tmp, root.to_string())
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("write {SEEN_POSTS_FILE}: {e}"))?;
    log::debug!("[SEEN_TREND] {count} post(s) written, {skipped} skipped, {dropped} over the cap");
    Ok(count)
}

/// Removes `{dir}/seen_posts.json` ONLY when it names `owner` - the sign-out's and the account
/// deletion's rule: an unknown or other owner is never a licence to delete. Returns whether a file
/// was removed.
pub(crate) fn remove_seen_posts_of(dir: &Path, owner: &str) -> Result<bool, String> {
    let path = dir.join(SEEN_POSTS_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {SEEN_POSTS_FILE}: {e}")),
    };
    let named = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("userId")?.as_str().map(str::to_string));
    if named.as_deref() != Some(owner.trim().to_lowercase().as_str()) {
        log::info!("[SEEN_TREND] {SEEN_POSTS_FILE} is not this account's - left alone");
        return Ok(false);
    }
    std::fs::remove_file(&path).map_err(|e| format!("remove {SEEN_POSTS_FILE}: {e}"))?;
    log::info!("[SEEN_TREND] {SEEN_POSTS_FILE} of the account removed");
    Ok(true)
}

/// Whether a push is withheld on this device, read from the file's parsed root - the contract's rule
/// (`libs/contracts/notification-seen-trend.cases.json`), the same as the Kotlin, Swift and ObjC
/// readers. Rust composes no banner, so this exists to hold the writer to the readers' rule in its
/// own tests.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn withholds_push(
    root: &serde_json::Value,
    me: Option<&str>,
    content_key: Option<&str>,
    post_id: &str,
    trend_keys: &[&str],
) -> bool {
    let Some(me) = me
        .map(|m| m.trim().to_lowercase())
        .filter(|m| !m.is_empty())
    else {
        return false;
    };
    if root.get("userId").and_then(|o| o.as_str()) != Some(me.as_str()) {
        return false;
    }
    if !content_key.is_some_and(|k| trend_keys.contains(&k)) {
        return false;
    }
    let id = post_id.trim().to_lowercase();
    !id.is_empty() && root.get("posts").and_then(|p| p.get(&id)).is_some()
}

/// The directories this account's copy lives in: the data directory, and on iOS the App Group the
/// extension reads. EACH is its own result: a missing App Group must not stop the data directory's
/// copy from being written (the app's own readers), and the other way round - every failure is logged
/// where it happens and the first one is returned once every copy was tried.
fn mirror_dirs(app: &tauri::AppHandle) -> Vec<Result<std::path::PathBuf, String>> {
    use tauri::Manager;
    #[allow(unused_mut)]
    let mut dirs = vec![app.path().app_data_dir().map_err(|e| e.to_string())];
    #[cfg(target_os = "ios")]
    dirs.push(crate::app_group::app_group_dir().inspect_err(|e| {
        log::error!(
            "[SEEN_TREND] no App Group container - the extension shows trends for displayed posts: {e}"
        );
    }));
    dirs
}

/// Writes `posts` for `owner` into every directory of `dirs`, each independently; returns the count the
/// last written copy holds, or the first error once all were tried.
pub(crate) fn replace_seen_posts_in(
    dirs: Vec<Result<std::path::PathBuf, String>>,
    owner: &str,
    posts: &[SeenPost],
) -> Result<usize, String> {
    let mut held = 0;
    let mut first_error: Option<String> = None;
    for dir in dirs {
        match dir.and_then(|d| replace_seen_posts(&d, owner, posts)) {
            Ok(n) => held = n,
            Err(e) => {
                log::error!("[SEEN_TREND] a copy was NOT written, the others still are: {e}");
                first_error.get_or_insert(e);
            }
        }
    }
    first_error.map_or(Ok(held), Err)
}

/// Mirrors the record of displayed posts the WebView holds, for `user_id` (the signed-in account),
/// into every copy a native reader opens.
#[tauri::command]
pub(crate) fn store_seen_posts(
    app: tauri::AppHandle,
    user_id: String,
    posts: Vec<SeenPost>,
) -> Result<usize, String> {
    log::debug!("[SEEN_TREND] store_seen_posts: {} post(s)", posts.len());
    replace_seen_posts_in(mirror_dirs(&app), &user_id, &posts)
}

/// Removes `user_id`'s copy at sign-out (`forgetSeenPosts`): which posts a member displayed is theirs,
/// and outlives the session no more than the WebView's record does. A copy of another account is left
/// alone.
#[tauri::command]
pub(crate) fn forget_seen_posts(app: tauri::AppHandle, user_id: String) -> Result<bool, String> {
    log::debug!("[SEEN_TREND] forget_seen_posts");
    let mut removed = false;
    let mut first_error: Option<String> = None;
    for dir in mirror_dirs(&app) {
        match dir.and_then(|d| remove_seen_posts_of(&d, &user_id)) {
            Ok(r) => removed |= r,
            Err(e) => {
                log::error!("[SEEN_TREND] a copy was not removed at sign-out: {e}");
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(removed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-seen-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn uuid(n: u32) -> String {
        format!("{n:08x}-0000-4000-8000-000000000000")
    }

    #[test]
    fn a_missing_app_group_does_not_stop_the_data_directory_copy() {
        let data = temp_dir("l3-data");
        let id = uuid(1);
        let dirs = vec![Err("no App Group".to_string()), Ok(data.clone())];
        let out = replace_seen_posts_in(dirs, "me", &[post(&id, 5.0)]);
        // The failure is reported so the WebView keeps the record dirty...
        assert_eq!(out, Err("no App Group".to_string()));
        // ...and the copy that could be written was.
        let root: serde_json::Value =
            serde_json::from_slice(&std::fs::read(data.join(SEEN_POSTS_FILE)).unwrap()).unwrap();
        assert!(root["posts"].get(&id).is_some());
    }

    fn post(id: &str, at: f64) -> SeenPost {
        SeenPost {
            post_id: id.into(),
            published_at: at,
        }
    }

    fn read(dir: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join(SEEN_POSTS_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn a_write_states_the_whole_record() {
        let dir = temp_dir("whole");
        replace_seen_posts(&dir, "Ab", &[post(&uuid(1), 10.0), post(&uuid(2), 20.0)]).unwrap();
        // The next write is the record as the WebView holds it NOW: a post it pruned leaves.
        let n = replace_seen_posts(&dir, "ab", &[post(&uuid(2).to_uppercase(), 20.0)]).unwrap();
        assert_eq!(n, 1);
        let root = read(&dir);
        assert_eq!(root["userId"], "ab");
        assert!(root["posts"].get(uuid(1)).is_none());
        assert_eq!(root["posts"][uuid(2)], 20);
    }

    #[test]
    fn what_no_reader_could_look_up_is_not_stored() {
        let dir = temp_dir("junk");
        let n = replace_seen_posts(
            &dir,
            "ab",
            &[
                post(&uuid(1), 5.0),
                post("not-a-post-id", 5.0),
                post(&uuid(2), f64::NAN),
            ],
        )
        .unwrap();
        assert_eq!(n, 1);
        assert!(replace_seen_posts(&dir, "  ", &[]).is_err());
    }

    #[test]
    fn the_cap_drops_the_oldest_publications() {
        let dir = temp_dir("cap");
        let posts: Vec<SeenPost> = (0..(SEEN_POSTS_MAX as u32 + 3))
            .map(|n| post(&uuid(n), f64::from(n)))
            .collect();
        let n = replace_seen_posts(&dir, "ab", &posts).unwrap();
        assert_eq!(n, SEEN_POSTS_MAX);
        let root = read(&dir);
        // The three oldest (0, 1, 2) are gone, the newest stays.
        assert!(root["posts"].get(uuid(2)).is_none());
        assert!(root["posts"].get(uuid(3)).is_some());
        assert!(root["posts"].get(uuid(SEEN_POSTS_MAX as u32 + 2)).is_some());
    }

    #[test]
    fn another_accounts_copy_is_replaced_never_merged() {
        let dir = temp_dir("owner");
        replace_seen_posts(&dir, "a", &[post(&uuid(1), 1.0)]).unwrap();
        replace_seen_posts(&dir, "b", &[post(&uuid(2), 2.0)]).unwrap();
        let root = read(&dir);
        assert_eq!(root["userId"], "b");
        assert!(root["posts"].get(uuid(1)).is_none());
    }

    #[test]
    fn the_sign_out_removes_only_its_own_accounts_copy() {
        let dir = temp_dir("signout");
        assert!(
            !remove_seen_posts_of(&dir, "a").unwrap(),
            "absent is not an error"
        );
        replace_seen_posts(&dir, "a", &[post(&uuid(1), 1.0)]).unwrap();
        assert!(!remove_seen_posts_of(&dir, "b").unwrap());
        assert!(dir.join(SEEN_POSTS_FILE).exists());
        assert!(remove_seen_posts_of(&dir, " A ").unwrap());
        assert!(!dir.join(SEEN_POSTS_FILE).exists());
    }

    /// The written file answers the shared contract every reader follows.
    #[test]
    fn the_written_file_answers_the_shared_contract() {
        let contract: serde_json::Value = serde_json::from_slice(
            &std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../libs/contracts/notification-seen-trend.cases.json"
            ))
            .unwrap(),
        )
        .unwrap();
        let keys: Vec<String> = contract["trendKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
        let book = &contract["book"];
        let posts: Vec<SeenPost> = book["posts"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, at)| post(id, at.as_f64().unwrap()))
            .collect();
        let dir = temp_dir("contract");
        replace_seen_posts(&dir, book["userId"].as_str().unwrap(), &posts).unwrap();
        let root = read(&dir);
        let cases = contract["cases"].as_array().unwrap();
        assert!(cases.len() > 10, "the contract lost its cases");
        for case in cases {
            let got = withholds_push(
                &root,
                case["me"].as_str(),
                case["contentKey"].as_str(),
                case["postId"].as_str().unwrap(),
                &keys,
            );
            assert_eq!(
                got,
                case["expected"].as_bool().unwrap(),
                "{}",
                case["name"].as_str().unwrap()
            );
        }
    }
}
