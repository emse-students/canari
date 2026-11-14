//! `conversation_nicknames.json`: the per-conversation nicknames this account may see, mirrored for
//! the native push path (owner, 2026-11-14: *"comme sur Messenger, tous les pseudos"*, and *"Tout
//! pourrait etre donne par l'appareil et rien par le serveur"*).
//!
//! A notification names a member by the nickname set in THAT conversation, and the DEVICE composes
//! that name - no push carries one. The FCM service, the iOS extension and `canari_push.mm` cannot
//! ask the WebView, so the WebView hands its register here (`nicknameMirror.ts`) and they read the
//! file. The rule every reader applies is `libs/contracts/notification-nickname.cases.json`.
//!
//! The file is `{"userId": <owner>, "scopes": {<scope>: {<64 hex id>: <nickname>}}, "channels":
//! {<salon id>: <community scope>}}`. A scope is an MLS group id or `community:<workspace id>`; a
//! salon push names its salon, not its community, hence `channels`. It names its OWNER because it is
//! one file per install: every reader uses it only when the owner is the account in
//! `push_context.json`, a write for another owner REPLACES it, and the sign-out
//! ([`forget_conversation_nicknames`]) and the account deletion remove it only when it is that
//! account's. Written through a temporary file renamed over the old one: a reader in another process
//! never sees half a file.
//!
//! The WebView writes only nicknames its account may SEE (the block rule of the screen, applied
//! before the write), so a reader applies no rule of its own beyond the lookup.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// The file every native reader opens, in the app's data directory (and, on iOS, in the App Group
/// container the notification extension reads).
pub(crate) const CONVERSATION_NICKNAMES_FILE: &str = "conversation_nicknames.json";

/// At most this many nicknames are kept, every conversation together. One conversation's register
/// holds at most 500 (`MAX_NICKNAME_ENTRIES`); a nickname is ~150 bytes here, so the file stays
/// under a megabyte for the extension's memory ceiling.
pub(crate) const CONVERSATION_NICKNAMES_MAX: usize = 5000;

/// At most this many salons are placed in their community.
pub(crate) const CONVERSATION_CHANNELS_MAX: usize = 2000;

/// The longest nickname kept, in characters - the contract's own bound
/// (`libs/contracts/conversation-nickname.json`); a longer one is truncated, never refused.
const NICKNAME_MAX_CHARS: usize = 100;

/// The longest scope or salon id kept. Group ids, `community:<uuid>` and salon uuids are far shorter.
const KEY_MAX_CHARS: usize = 200;

/// One change the WebView states: `nickname` None (or empty) removes the member's entry in `scope`.
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NicknameChange {
    pub scope: String,
    pub member_id: String,
    pub nickname: Option<String>,
}

/// One salon placed in its community (`scope`), or forgotten (`scope` None).
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelChange {
    pub channel_id: String,
    pub scope: Option<String>,
}

/// Whether `id` is a user id: 64 hex characters, lower-cased by the caller.
fn is_user_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether `key` may name a scope or a salon: non-empty, bounded, no control character.
fn is_key(key: &str) -> bool {
    !key.is_empty() && key.chars().count() <= KEY_MAX_CHARS && !key.chars().any(char::is_control)
}

type Scopes = BTreeMap<String, BTreeMap<String, String>>;

/// The scopes and salons of `{dir}/conversation_nicknames.json` when it is `owner`'s; empty when it
/// is absent, another account's or unparsable (each said).
fn read_owned(dir: &Path, owner: &str) -> Result<(Scopes, BTreeMap<String, String>), String> {
    let path = dir.join(CONVERSATION_NICKNAMES_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(e) => return Err(format!("read {CONVERSATION_NICKNAMES_FILE}: {e}")),
    };
    let root = match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[NICKNAME_MIRROR] stored file unparsable, rebuilt from this write: {e}");
            return Ok(Default::default());
        }
    };
    if root.get("userId").and_then(|o| o.as_str()) != Some(owner) {
        log::info!("[NICKNAME_MIRROR] the stored nicknames belong to another account - replaced");
        return Ok(Default::default());
    }
    let mut scopes = Scopes::new();
    if let Some(map) = root.get("scopes").and_then(|s| s.as_object()) {
        for (scope, members) in map {
            let Some(members) = members.as_object() else {
                continue;
            };
            let kept: BTreeMap<String, String> = members
                .iter()
                .filter_map(|(id, n)| Some((id.clone(), n.as_str()?.to_string())))
                .filter(|(id, n)| is_user_id(id) && !n.trim().is_empty())
                .collect();
            if is_key(scope) && !kept.is_empty() {
                scopes.insert(scope.clone(), kept);
            }
        }
    }
    let channels = root
        .get("channels")
        .and_then(|c| c.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(id, s)| Some((id.clone(), s.as_str()?.to_string())))
                .filter(|(id, s)| is_key(id) && is_key(s))
                .collect()
        })
        .unwrap_or_default();
    Ok((scopes, channels))
}

/// Merges `changes` and `channels` into `{dir}/conversation_nicknames.json` for `owner`, and returns
/// how many nicknames the file holds afterwards.
///
/// - The file names another owner (or none, or cannot be parsed): it is REPLACED, never merged.
/// - Each scope of `restated` is emptied BEFORE `changes` apply: the WebView restates that scope's
///   whole register in them, so an entry it no longer holds leaves the copy too.
/// - A change with a nickname sets the member's entry in its scope; one without (or empty) removes it.
/// - Over [`CONVERSATION_NICKNAMES_MAX`]: entries THIS write did not touch go first, in reverse key
///   order, then this write's own the same way. Deterministic; the same for the salons.
///
/// A malformed change (a member that is not a user id, a scope that is no key) is skipped and counted.
pub(crate) fn merge_conversation_nicknames(
    dir: &Path,
    owner: &str,
    changes: &[NicknameChange],
    channels: &[ChannelChange],
    restated: &[String],
) -> Result<usize, String> {
    let owner = owner.trim().to_lowercase();
    if owner.is_empty() {
        log::error!("[NICKNAME_MIRROR] refused: no owner");
        return Err("no owner".to_string());
    }
    let (mut scopes, mut salons) = read_owned(dir, &owner)?;
    for scope in restated {
        scopes.remove(scope.trim());
    }

    let mut touched: BTreeSet<(String, String)> = BTreeSet::new();
    let mut skipped = 0usize;
    for change in changes {
        let scope = change.scope.trim();
        let member = change.member_id.trim().to_lowercase();
        if !is_key(scope) || !is_user_id(&member) {
            skipped += 1;
            continue;
        }
        let nickname: String = change
            .nickname
            .as_deref()
            .unwrap_or("")
            .trim()
            .chars()
            .take(NICKNAME_MAX_CHARS)
            .collect();
        if nickname.is_empty() {
            if let Some(members) = scopes.get_mut(scope) {
                members.remove(&member);
                if members.is_empty() {
                    scopes.remove(scope);
                }
            }
        } else {
            scopes
                .entry(scope.to_string())
                .or_default()
                .insert(member.clone(), nickname);
            touched.insert((scope.to_string(), member));
        }
    }
    let mut placed: BTreeSet<String> = BTreeSet::new();
    for change in channels {
        let id = change.channel_id.trim();
        let id = id.strip_prefix("channel_").unwrap_or(id);
        if !is_key(id) {
            skipped += 1;
            continue;
        }
        match change.scope.as_deref().map(str::trim) {
            Some(scope) if is_key(scope) => {
                salons.insert(id.to_string(), scope.to_string());
                placed.insert(id.to_string());
            }
            _ => {
                salons.remove(id);
            }
        }
    }

    let total: usize = scopes.values().map(BTreeMap::len).sum();
    if total > CONVERSATION_NICKNAMES_MAX {
        let mut keys: Vec<(bool, String, String)> = scopes
            .iter()
            .flat_map(|(s, m)| m.keys().map(move |id| (s.clone(), id.clone())))
            .map(|(s, id)| (touched.contains(&(s.clone(), id.clone())), s, id))
            .collect();
        // Untouched first (false < true), and within each the last key first.
        keys.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| (&b.1, &b.2).cmp(&(&a.1, &a.2))));
        let excess = total - CONVERSATION_NICKNAMES_MAX;
        for (_, scope, id) in keys.into_iter().take(excess) {
            if let Some(members) = scopes.get_mut(&scope) {
                members.remove(&id);
                if members.is_empty() {
                    scopes.remove(&scope);
                }
            }
        }
        log::warn!(
            "[NICKNAME_MIRROR] over {CONVERSATION_NICKNAMES_MAX} nicknames - {excess} dropped"
        );
    }
    if salons.len() > CONVERSATION_CHANNELS_MAX {
        let excess = salons.len() - CONVERSATION_CHANNELS_MAX;
        let mut ids: Vec<(bool, String)> = salons
            .keys()
            .map(|id| (placed.contains(id), id.clone()))
            .collect();
        ids.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
        for (_, id) in ids.into_iter().take(excess) {
            salons.remove(&id);
        }
        log::warn!("[NICKNAME_MIRROR] over {CONVERSATION_CHANNELS_MAX} salons - {excess} dropped");
    }

    let count: usize = scopes.values().map(BTreeMap::len).sum();
    let root = serde_json::json!({ "userId": owner, "scopes": scopes, "channels": salons });
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{CONVERSATION_NICKNAMES_FILE}.tmp"));
    std::fs::write(&tmp, root.to_string())
        .and_then(|()| std::fs::rename(&tmp, dir.join(CONVERSATION_NICKNAMES_FILE)))
        .map_err(|e| format!("write {CONVERSATION_NICKNAMES_FILE}: {e}"))?;
    log::debug!(
        "[NICKNAME_MIRROR] {} change(s), {} salon(s), {} scope(s) restated, {skipped} skipped, {count} held",
        changes.len(),
        channels.len(),
        restated.len()
    );
    Ok(count)
}

/// Removes `{dir}/conversation_nicknames.json` ONLY when it names `owner` - the sign-out's and the
/// account deletion's rule: an unknown or other owner is never a licence to delete. Returns whether a
/// file was removed.
pub(crate) fn remove_conversation_nicknames_of(dir: &Path, owner: &str) -> Result<bool, String> {
    let path = dir.join(CONVERSATION_NICKNAMES_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {CONVERSATION_NICKNAMES_FILE}: {e}")),
    };
    let named = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("userId")?.as_str().map(str::to_string));
    if named.as_deref() != Some(owner.trim().to_lowercase().as_str()) {
        log::info!(
            "[NICKNAME_MIRROR] {CONVERSATION_NICKNAMES_FILE} is not this account's - left alone"
        );
        return Ok(false);
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("remove {CONVERSATION_NICKNAMES_FILE}: {e}"))?;
    log::info!("[NICKNAME_MIRROR] {CONVERSATION_NICKNAMES_FILE} of the account removed");
    Ok(true)
}

/// The nickname a notification gives `member` in a conversation, read from the file's parsed root -
/// the contract's lookup (`libs/contracts/notification-nickname.cases.json`), the same as the Kotlin,
/// Swift and ObjC readers. `salon` says `conversation` is a salon id (its `channel_` prefix allowed),
/// read through `channels`; otherwise it is an MLS group id, itself the scope. Rust composes no
/// banner, so this exists to hold the writer to the readers' rule in its own tests.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn lookup_conversation_nickname(
    root: &serde_json::Value,
    me: Option<&str>,
    salon: bool,
    conversation: &str,
    member: &str,
) -> Option<String> {
    let me = me?.trim().to_lowercase();
    if root.get("userId")?.as_str()? != me {
        return None;
    }
    let scope = if salon {
        let id = conversation
            .strip_prefix("channel_")
            .unwrap_or(conversation);
        root.get("channels")?.get(id)?.as_str()?.to_string()
    } else {
        conversation.to_string()
    };
    let name = root
        .get("scopes")?
        .get(&scope)?
        .get(member.trim().to_lowercase())?
        .as_str()?
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// The directories this account's copy lives in: the data directory, and on iOS the App Group the
/// extension reads.
fn mirror_dirs(app: &tauri::AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
    use tauri::Manager;
    #[allow(unused_mut)]
    let mut dirs = vec![app.path().app_data_dir().map_err(|e| e.to_string())?];
    #[cfg(target_os = "ios")]
    {
        let group = crate::app_group::app_group_dir().inspect_err(|e| {
            log::error!(
                "[NICKNAME_MIRROR] no App Group container - the extension keeps old nicknames: {e}"
            );
        })?;
        dirs.push(group);
    }
    Ok(dirs)
}

/// Mirrors the nickname changes the WebView noted since its last call, for `user_id` (the signed-in
/// account), into every copy a native reader opens.
#[tauri::command]
pub(crate) fn store_conversation_nicknames(
    app: tauri::AppHandle,
    user_id: String,
    changes: Vec<NicknameChange>,
    channels: Vec<ChannelChange>,
    restated_scopes: Vec<String>,
) -> Result<usize, String> {
    log::debug!(
        "[NICKNAME_MIRROR] store_conversation_nicknames: {} change(s), {} salon(s), {} restated",
        changes.len(),
        channels.len(),
        restated_scopes.len()
    );
    let mut held = 0;
    for dir in mirror_dirs(&app)? {
        held = merge_conversation_nicknames(&dir, &user_id, &changes, &channels, &restated_scopes)?;
    }
    Ok(held)
}

/// Removes `user_id`'s copy at sign-out (`forgetConversationNicknames`): the names other members set
/// are text written about people, and outlive the session no more than the WebView's register does.
/// A copy of another account is left alone.
#[tauri::command]
pub(crate) fn forget_conversation_nicknames(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<bool, String> {
    log::debug!("[NICKNAME_MIRROR] forget_conversation_nicknames");
    let mut removed = false;
    let mut first_error: Option<String> = None;
    for dir in mirror_dirs(&app)? {
        match remove_conversation_nicknames_of(&dir, &user_id) {
            Ok(r) => removed |= r,
            Err(e) => {
                log::error!("[NICKNAME_MIRROR] a copy was not removed at sign-out: {e}");
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
        let dir = std::env::temp_dir().join(format!("canari-nicks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn id(n: u32) -> String {
        format!("{n:064x}")
    }

    fn set(scope: &str, member: &str, nickname: Option<&str>) -> NicknameChange {
        NicknameChange {
            scope: scope.into(),
            member_id: member.into(),
            nickname: nickname.map(Into::into),
        }
    }

    fn read(dir: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join(CONVERSATION_NICKNAMES_FILE)).unwrap())
            .unwrap()
    }

    const OWNER: &str = "ab";

    #[test]
    fn a_change_sets_and_a_reset_removes() {
        let dir = temp_dir("set");
        let n = merge_conversation_nicknames(
            &dir,
            OWNER,
            &[
                set("g1", &id(1), Some(" Lili ")),
                set("g1", &id(2).to_uppercase(), Some("Bob")),
            ],
            &[],
            &[],
        );
        assert_eq!(n, Ok(2));
        assert_eq!(read(&dir)["scopes"]["g1"][id(1)], "Lili");
        assert_eq!(read(&dir)["scopes"]["g1"][id(2)], "Bob", "lower-cased id");
        assert_eq!(
            merge_conversation_nicknames(&dir, OWNER, &[set("g1", &id(1), None)], &[], &[]),
            Ok(1)
        );
        assert_eq!(
            merge_conversation_nicknames(&dir, OWNER, &[set("g1", &id(2), Some(" "))], &[], &[]),
            Ok(0)
        );
        assert!(
            read(&dir)["scopes"].get("g1").is_none(),
            "an emptied scope is dropped"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn another_accounts_copy_is_replaced_never_merged() {
        let dir = temp_dir("owner");
        merge_conversation_nicknames(&dir, "other", &[set("g1", &id(1), Some("A"))], &[], &[])
            .unwrap();
        merge_conversation_nicknames(&dir, OWNER, &[set("g2", &id(2), Some("B"))], &[], &[])
            .unwrap();
        let v = read(&dir);
        assert_eq!(v["userId"], OWNER);
        assert!(
            v["scopes"].get("g1").is_none(),
            "the other account's nickname leaked"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn salons_are_placed_and_forgotten() {
        let dir = temp_dir("salons");
        let place = |id: &str, scope: Option<&str>| ChannelChange {
            channel_id: id.into(),
            scope: scope.map(Into::into),
        };
        merge_conversation_nicknames(
            &dir,
            OWNER,
            &[],
            &[
                place("channel_c1", Some("community:w")),
                place("c2", Some("community:w")),
            ],
            &[],
        )
        .unwrap();
        assert_eq!(
            read(&dir)["channels"]["c1"],
            "community:w",
            "the prefix is not stored"
        );
        merge_conversation_nicknames(&dir, OWNER, &[], &[place("c2", None)], &[]).unwrap();
        assert!(read(&dir)["channels"].get("c2").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn what_no_reader_could_look_up_is_not_stored() {
        let dir = temp_dir("skip");
        let n = merge_conversation_nicknames(
            &dir,
            OWNER,
            &[
                set("g1", "not-hex", Some("X")),
                set("", &id(1), Some("X")),
                set("g\u{0}", &id(1), Some("X")),
                set("g1", &id(2), Some(&"B".repeat(300))),
            ],
            &[],
            &[],
        );
        assert_eq!(n, Ok(1));
        assert_eq!(
            read(&dir)["scopes"]["g1"][id(2)]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            NICKNAME_MAX_CHARS
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_cap_keeps_this_writes_nicknames_first() {
        let dir = temp_dir("cap");
        let old: Vec<NicknameChange> = (0..CONVERSATION_NICKNAMES_MAX as u32)
            .map(|n| set("g1", &id(n), Some("old")))
            .collect();
        merge_conversation_nicknames(&dir, OWNER, &old, &[], &[]).unwrap();
        assert_eq!(
            merge_conversation_nicknames(&dir, OWNER, &[set("g9", &id(1), Some("New"))], &[], &[]),
            Ok(CONVERSATION_NICKNAMES_MAX)
        );
        assert_eq!(read(&dir)["scopes"]["g9"][id(1)], "New");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_restated_scope_keeps_only_what_the_restatement_names() {
        let dir = temp_dir("restate");
        merge_conversation_nicknames(
            &dir,
            OWNER,
            &[
                set("community:w", &id(1), Some("Gone")),
                set("community:w", &id(2), Some("Kept")),
                set("g1", &id(1), Some("Elsewhere")),
            ],
            &[],
            &[],
        )
        .unwrap();
        let n = merge_conversation_nicknames(
            &dir,
            OWNER,
            &[set("community:w", &id(2), Some("Kept"))],
            &[],
            &["community:w".to_string()],
        );
        assert_eq!(n, Ok(2));
        let v = read(&dir);
        assert!(
            v["scopes"]["community:w"].get(id(1)).is_none(),
            "a member the list stopped naming kept the old nickname"
        );
        assert_eq!(v["scopes"]["community:w"][id(2)], "Kept");
        assert_eq!(
            v["scopes"]["g1"][id(1)],
            "Elsewhere",
            "another scope is untouched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_sign_out_removes_only_its_own_accounts_copy() {
        let dir = temp_dir("remove");
        merge_conversation_nicknames(&dir, OWNER, &[set("g1", &id(1), Some("A"))], &[], &[])
            .unwrap();
        assert_eq!(
            remove_conversation_nicknames_of(&dir, "someone-else"),
            Ok(false)
        );
        assert!(dir.join(CONVERSATION_NICKNAMES_FILE).exists());
        assert_eq!(remove_conversation_nicknames_of(&dir, OWNER), Ok(true));
        assert!(!dir.join(CONVERSATION_NICKNAMES_FILE).exists());
        assert_eq!(
            remove_conversation_nicknames_of(&dir, OWNER),
            Ok(false),
            "idempotent"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The shared contract: the book it describes, WRITTEN by this module, answers every case the
    /// native readers are held to.
    #[test]
    fn the_written_file_answers_the_shared_contract() {
        let raw = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../libs/contracts/notification-nickname.cases.json"),
        )
        .unwrap();
        let contract: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        let book = &contract["book"];
        let owner = book["userId"].as_str().unwrap();
        let mut changes = Vec::new();
        for (scope, members) in book["scopes"].as_object().unwrap() {
            for (member, nick) in members.as_object().unwrap() {
                changes.push(set(scope, member, nick.as_str()));
            }
        }
        let channels: Vec<ChannelChange> = book["channels"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, scope)| ChannelChange {
                channel_id: id.clone(),
                scope: scope.as_str().map(Into::into),
            })
            .collect();
        let dir = temp_dir("contract");
        merge_conversation_nicknames(&dir, owner, &changes, &channels, &[]).unwrap();
        let written = read(&dir);
        for case in contract["cases"].as_array().unwrap() {
            let got = lookup_conversation_nickname(
                &written,
                case["me"].as_str(),
                case["kind"] == "salon",
                case["conversation"].as_str().unwrap(),
                case["member"].as_str().unwrap(),
            );
            assert_eq!(
                got.as_deref(),
                case["expected"].as_str(),
                "{}",
                case["name"]
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
