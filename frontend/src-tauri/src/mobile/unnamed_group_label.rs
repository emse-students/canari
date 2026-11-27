//! The title of a push for an UNNAMED group, drawn while the app is dead (owner, 2026-11-17).
//!
//! The app draws such a group by its other members' first names (`composeUnnamedGroupLabel`,
//! `unnamedGroupLabel.ts`), and a push raised while the app is dead used to read "Conversation de
//! groupe": the push carries no name (none exists - the server never learns one the members did not
//! choose, principle 1), and the native composers had no members to name. This module is the ONE
//! native copy of the rule, for the Android FCM service and the iOS notification extension alike:
//!
//! - **Who**: the user ids of the group's ratchet tree AT THE MESSAGE'S EPOCH, which the push
//!   decrypt already holds in memory after its commit catch-up (`treeMembers` in its answer,
//!   `background.rs`) - so a member removed while the app was dead is already gone from the next
//!   banner, as the app would draw it.
//! - **What they are called**: the nickname set in THIS group (`conversation_nicknames.json`), else
//!   the profile's first name, else its name (`display_names.json`) - the phone's own copies, written
//!   by the WebView. Nothing is asked of a server, and nothing about the label rides a push.
//! - **The rule**: [`compose_unnamed_group_label`], held to the app's by
//!   `libs/contracts/unnamed-group-label.cases.json`, words from [`PushText`].
//!
//! A member this phone has never named makes NO label: the banner keeps the generic title rather
//! than print an id or "someone" as if it were a name. The answer says why, because this crate's
//! log reaches no logger in a killed Android app or in the iOS extension: the native callers print it.
//!
//! docs/wiki/frontend/modules/chat.md, "An unnamed group: no name stored, the members' first names
//! drawn".

use std::path::Path;

use mls_core::device_trust::canonical_user_id;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

use super::push_text::{PushLanguage, PushText};
use crate::commands::conversation_nicknames::{
    lookup_conversation_nickname, CONVERSATION_NICKNAMES_FILE,
};
use crate::commands::display_names::read_name_book;

/// The first-level key a label's names are ordered by: NFD, every combining mark removed, then
/// lower-cased - the TypeScript `labelCollationKey`, under the same contract.
fn label_collation_key(name: &str) -> String {
    name.nfd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

/// The label of a group holding `members`, as `viewer` sees it: the OTHER members, each named by
/// `name_of` (trimmed, its id when empty), in the contract's fixed order; up to three spelt out,
/// past that two named and the rest counted. `None` when nobody else is in the group.
///
/// The Rust half of `libs/contracts/unnamed-group-label.cases.json`, whose other half is the app's
/// `composeUnnamedGroupLabel`.
pub fn compose_unnamed_group_label(
    members: &[String],
    viewer: &str,
    name_of: impl Fn(&str) -> String,
    language: PushLanguage,
) -> Option<String> {
    let viewer = canonical_user_id(viewer);
    let mut ids: Vec<String> = members.iter().map(|m| canonical_user_id(m)).collect();
    ids.sort();
    ids.dedup();
    let mut named: Vec<(String, String, String)> = ids
        .into_iter()
        .filter(|id| *id != viewer)
        .map(|id| {
            let name = name_of(&id).trim().to_string();
            let name = if name.is_empty() { id.clone() } else { name };
            (label_collation_key(&name), name, id)
        })
        .collect();
    // Rust's `str` order is code point order: the key, then the name, then the id.
    named.sort();
    let names: Vec<&str> = named.iter().map(|(_, name, _)| name.as_str()).collect();
    match names.as_slice() {
        [] => None,
        [one] => Some((*one).to_string()),
        [first, second] => Some(PushText::UnnamedGroupTwo(first, second).render(language)),
        [first, second, third] => {
            Some(PushText::UnnamedGroupThree(first, second, third).render(language))
        }
        [first, second, rest @ ..] => {
            Some(PushText::UnnamedGroupMore(first, second, rest.len()).render(language))
        }
    }
}

/// The title a push for the unnamed group `group_id` takes on `viewer`'s phone, read from the copies
/// under `data_dir` (the Tauri data directory on Android, the App Group container on iOS): the answer
/// is `{"label": "<title>"}`, or `{"label": null, "reason": <token>}` saying why there is none -
///
/// - `alone`: nobody else is in the tree; an ordinary state;
/// - `name-unknown` (with `unknown`, how many): a member this phone has never named, the name file
///   being this account's - a member added while the app was away, an ordinary state;
/// - `no-name-file`, `other-account`, `unreadable`: why the name file could not answer
///   ([`crate::commands::display_names::NameBookAbsent`]) when a member needed it.
pub fn unnamed_group_title(
    data_dir: &Path,
    viewer: &str,
    group_id: &str,
    members: &[String],
    language: PushLanguage,
) -> serde_json::Value {
    let me = canonical_user_id(viewer.trim());
    let mut others: Vec<String> = members
        .iter()
        .map(|m| canonical_user_id(m))
        .filter(|id| *id != me)
        .collect();
    others.sort();
    others.dedup();
    if others.is_empty() {
        return serde_json::json!({ "label": null, "reason": "alone" });
    }
    let nicknames: Option<serde_json::Value> =
        std::fs::read(data_dir.join(CONVERSATION_NICKNAMES_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let book = read_name_book(data_dir, &me);
    let name_of = |id: &str| -> Option<String> {
        nicknames
            .as_ref()
            .and_then(|root| lookup_conversation_nickname(root, Some(&me), false, group_id, id))
            .or_else(|| book.as_ref().ok()?.first_name_of(id))
    };
    let unknown = others.iter().filter(|id| name_of(id).is_none()).count();
    if unknown > 0 {
        let reason = match &book {
            Ok(_) => "name-unknown",
            Err(absent) => absent.token(),
        };
        return serde_json::json!({ "label": null, "reason": reason, "unknown": unknown });
    }
    let label =
        compose_unnamed_group_label(members, &me, |id| name_of(id).unwrap_or_default(), language);
    match label {
        Some(label) => serde_json::json!({ "label": label }),
        None => serde_json::json!({ "label": null, "reason": "alone" }),
    }
}

/// [`unnamed_group_title`] for a native caller: `members_json` is the `treeMembers` array of the
/// decrypt answer as it was handed back, `locale` the tag in `push_context.json`. The ONE body behind
/// the Android JNI `nativeUnnamedGroupTitle` and the iOS `canari_native_unnamed_group_title`. A
/// members array that does not parse answers `members-unreadable`, a fault the caller accuses.
pub fn unnamed_group_title_from_json(
    data_dir: &Path,
    viewer: &str,
    group_id: &str,
    members_json: &str,
    locale: &str,
) -> serde_json::Value {
    match serde_json::from_str::<Vec<String>>(members_json) {
        Ok(members) => unnamed_group_title(
            data_dir,
            viewer,
            group_id,
            &members,
            PushLanguage::from_tag(locale),
        ),
        Err(_) => serde_json::json!({ "label": null, "reason": "members-unreadable" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// The shared contract: every case, both languages.
    #[test]
    fn the_rule_answers_the_shared_contract() {
        let raw = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../libs/contracts/unnamed-group-label.cases.json"),
        )
        .unwrap();
        let contract: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        let cases = contract["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let members: Vec<String> = case["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap().to_string())
                .collect();
            let names = &case["names"];
            let name_of = |id: &str| names[id].as_str().unwrap_or_default().to_string();
            for (lang, language) in [("fr", PushLanguage::French), ("en", PushLanguage::English)] {
                let got = compose_unnamed_group_label(
                    &members,
                    case["viewer"].as_str().unwrap(),
                    name_of,
                    language,
                );
                assert_eq!(got.as_deref(), case[lang].as_str(), "{lang}: {name}");
            }
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-ugl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn id(n: u32) -> String {
        format!("{n:064x}")
    }

    const ME: u32 = 1;

    fn write_names(dir: &Path, names: &[(u32, &str, Option<&str>)]) {
        let all: HashMap<String, String> = names
            .iter()
            .map(|(n, name, _)| (id(*n), name.to_string()))
            .collect();
        let first: HashMap<String, String> = names
            .iter()
            .filter_map(|(n, _, first)| Some((id(*n), (*first)?.to_string())))
            .collect();
        crate::commands::display_names::merge_display_names(dir, &id(ME), &all, &first, &[])
            .unwrap();
    }

    /// A dead app's push for an unnamed group is titled by the OTHER members' first names, a
    /// nickname set in THIS group winning, a member with no first name named by their name.
    #[test]
    fn the_title_names_the_other_members_from_the_phones_copies() {
        let dir = temp_dir("title");
        write_names(
            &dir,
            &[
                (ME, "Moi Meme", Some("Moi")),
                (2, "Alice Martin", Some("Alice")),
                (3, "Bob Durand", Some("Bob")),
                (4, "Zed", None),
            ],
        );
        let nicknames = serde_json::json!({
            "userId": id(ME),
            "scopes": { "grp-1": { id(3): "Bobby" }, "grp-2": { id(2): "Lili" } },
            "channels": {}
        });
        std::fs::write(dir.join(CONVERSATION_NICKNAMES_FILE), nicknames.to_string()).unwrap();
        let members = vec![id(ME), id(4), id(3), id(2)];

        let fr = unnamed_group_title(&dir, &id(ME), "grp-1", &members, PushLanguage::French);
        assert_eq!(fr["label"], "Alice, Bobby et Zed");
        let en = unnamed_group_title(&dir, &id(ME), "grp-1", &members, PushLanguage::English);
        assert_eq!(en["label"], "Alice, Bobby and Zed");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// One member removed: the next title follows the tree it is handed.
    #[test]
    fn the_title_follows_the_tree() {
        let dir = temp_dir("follow");
        write_names(
            &dir,
            &[(ME, "Moi", None), (2, "Alice", None), (3, "Bob", None)],
        );
        let before = unnamed_group_title(
            &dir,
            &id(ME),
            "g",
            &[id(ME), id(2), id(3)],
            PushLanguage::French,
        );
        assert_eq!(before["label"], "Alice et Bob");
        let after = unnamed_group_title(&dir, &id(ME), "g", &[id(ME), id(2)], PushLanguage::French);
        assert_eq!(after["label"], "Alice");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// No label, and the reason named, rather than an id or "someone" on a banner.
    #[test]
    fn no_label_says_why() {
        let dir = temp_dir("why");
        assert_eq!(
            unnamed_group_title(&dir, &id(ME), "g", &[id(ME)], PushLanguage::French),
            serde_json::json!({ "label": null, "reason": "alone" })
        );
        assert_eq!(
            unnamed_group_title(&dir, &id(ME), "g", &[id(ME), id(2)], PushLanguage::French)
                ["reason"],
            "no-name-file"
        );
        write_names(&dir, &[(2, "Alice", None)]);
        let unknown = unnamed_group_title(
            &dir,
            &id(ME),
            "g",
            &[id(ME), id(2), id(3)],
            PushLanguage::French,
        );
        assert_eq!(unknown["reason"], "name-unknown");
        assert_eq!(unknown["unknown"], 1);
        // Another account's copy is never read for this one.
        let other = unnamed_group_title(&dir, &id(9), "g", &[id(9), id(2)], PushLanguage::French);
        assert_eq!(other["reason"], "other-account");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The native entry point reads the members array the decrypt answer carried, and the locale
    /// tag; an array that does not parse is named, never read as "alone".
    #[test]
    fn the_native_entry_reads_the_members_json_and_the_locale() {
        let dir = temp_dir("json");
        write_names(&dir, &[(2, "Alice", None), (3, "Bob", None)]);
        let members = serde_json::json!([id(ME), id(2), id(3)]).to_string();
        assert_eq!(
            unnamed_group_title_from_json(&dir, &id(ME), "g", &members, "en-GB")["label"],
            "Alice and Bob"
        );
        assert_eq!(
            unnamed_group_title_from_json(&dir, &id(ME), "g", "not json", "fr")["reason"],
            "members-unreadable"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
