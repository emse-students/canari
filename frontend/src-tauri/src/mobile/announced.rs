//! ONE NOTIFICATION PER MESSAGE ON AN IPHONE, WHICHEVER PROCESS DRAWS IT - the ledger the app and
//! its notification extension share (`docs/wiki/frontend/ios-notification-ownership.md`).
//!
//! Two processes can announce one message on iOS: the notification extension, which draws every
//! alert push, and the page, which raises a local notification for a frame it takes while the reader
//! cannot see it land. The extension acknowledges nothing, so the row it announced is redelivered at
//! the app's next connection - a cold launch, a resume - and the page used to announce it again
//! (iPhone 12, `1.7.3-alpha.6`: one push, two identical rows after a cold launch, three after a warm
//! resume). Nothing in memory can answer "was this shown?" after a kill, and the notification
//! centre cannot either: a tapped or swiped banner leaves it.
//!
//! So the answer is DURABLE STATE both processes write, under one OS file lock
//! (`announced_messages.lock`, `flock`: it orders threads and processes alike, and the OS drops it
//! if the holder dies), in the App Group store. The key is the Android one
//! (`CanariFirebaseMessagingService.alertedKey`): the conversation and the message's instant - the
//! sender's for an MLS message, the server's `createdAt` for a salon - which both triggers carry
//! unchanged, and which holds no text.
//!
//! **The three writers, and why every interleaving ends with exactly one surface:**
//!
//! - the EXTENSION ([`claim_by_extension`]) claims a key when it draws a message. First, the key is
//!   its own; after the page, its banner is a second one, which it files quietly in place of the
//!   page's.
//! - the PAGE ([`claim_by_page`]) asks before it raises. A key nobody holds is FRESH, and one fresh
//!   key is enough to raise; every key of the banner is then the page's. With none fresh it raises
//!   nothing, and marks the extension's keys WANTED: the page would have announced them.
//! - the app's `willPresentNotification` ([`settle_in_front`]) is the one place that knows an
//!   extension banner was NOT shown: a push reaching an ACTIVE app is answered `None`. So there, and
//!   only there, the extension's claim is given back - unless the page already asked for it, in
//!   which case the push is presented, since the page stood down for it.
//!
//! Killed or suspended, no `willPresent` runs and the extension's banner is shown: its claim stands,
//! and the page's later ask stands down. That is the defect closed, by a record rather than a clock.

use std::path::Path;

/// The ledger file in the App Group store.
pub const ANNOUNCED_FILE: &str = "announced_messages.json";
/// The lock every writer takes around a read-modify-write of [`ANNOUNCED_FILE`].
pub const ANNOUNCED_LOCK: &str = "announced_messages.lock";
/// The most keys kept, the oldest dropped first. A key that old names a message whose row was
/// acknowledged long ago, so no redelivery will ask for it again.
pub const MAX_ANNOUNCED_KEYS: usize = 512;

/// Who announced a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Announcer {
    Extension,
    Page,
}

/// One announced message.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Announced {
    /// [`announce_key`] of the message.
    pub key: String,
    pub by: Announcer,
    /// The page asked to announce an extension's key and stood down for it - read by
    /// [`settle_in_front`] only.
    #[serde(default)]
    pub wanted: bool,
}

/// The key of one message: `<conversation>:<instant>`, or `None` when either is unknown - such a
/// message cannot be recognised, and is never claimed.
pub fn announce_key(conversation: &str, at: i64) -> Option<String> {
    if conversation.is_empty() || at <= 0 {
        return None;
    }
    Some(format!("{conversation}:{at}"))
}

/// What the extension's claim found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionClaim {
    /// Nobody announced it: the extension's banner is the announcement.
    First,
    /// The page announced it first: the extension's banner replaces the page's, quietly.
    AfterPage,
}

/// The extension draws the message `key`.
pub fn claim_by_extension(ledger: &mut Vec<Announced>, key: &str) -> ExtensionClaim {
    if let Some(found) = ledger.iter().find(|a| a.key == key) {
        return match found.by {
            Announcer::Page => ExtensionClaim::AfterPage,
            // A second push of one message (a retried delivery): still the extension's.
            Announcer::Extension => ExtensionClaim::First,
        };
    }
    push_bounded(
        ledger,
        Announced {
            key: key.to_string(),
            by: Announcer::Extension,
            wanted: false,
        },
    );
    ExtensionClaim::First
}

/// What the page's ask found, for its one banner covering `fresh + by_extension + by_page` keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageClaim {
    /// Keys nobody had announced.
    pub fresh: usize,
    /// Keys the extension had announced.
    pub by_extension: usize,
    /// Keys this app had announced already (the same frame delivered twice).
    pub by_page: usize,
}

impl PageClaim {
    /// Whether the page raises its banner: one message of it nobody announced is enough.
    pub fn raise(&self) -> bool {
        self.fresh > 0
    }
}

/// The page asks to announce the messages `keys` with ONE banner.
///
/// Raising (one key fresh), every key becomes the page's: an extension key whose push has not
/// reached `willPresent` yet is then answered `None` there, the page's banner covering it. Standing
/// down, the extension's keys are marked wanted, so a push still on its way to an active app is
/// presented ([`settle_in_front`]).
pub fn claim_by_page(ledger: &mut Vec<Announced>, keys: &[String]) -> PageClaim {
    let mut claim = PageClaim::default();
    for key in keys {
        match ledger.iter().find(|a| &a.key == key).map(|a| a.by) {
            None => claim.fresh += 1,
            Some(Announcer::Extension) => claim.by_extension += 1,
            Some(Announcer::Page) => claim.by_page += 1,
        }
    }
    let raise = claim.raise();
    for key in keys {
        match ledger.iter_mut().find(|a| &a.key == key) {
            Some(found) if raise => {
                found.by = Announcer::Page;
                found.wanted = false;
            }
            Some(found) => {
                if found.by == Announcer::Extension {
                    found.wanted = true;
                }
            }
            None => push_bounded(
                ledger,
                Announced {
                    key: key.clone(),
                    by: Announcer::Page,
                    wanted: false,
                },
            ),
        }
    }
    claim
}

/// What an active app does with an extension's banner in `willPresentNotification`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InFront {
    /// The page stood down for this message: the push is presented.
    PageAsked,
    /// Nobody asked: the push is not presented, and its claim is given back to the page.
    Released,
    /// The page's banner announces it (or the claim was dropped by the bound): not presented.
    NotHeld,
}

/// An extension banner reaches an ACTIVE app, which does not present a message push on its own.
pub fn settle_in_front(ledger: &mut Vec<Announced>, key: &str) -> InFront {
    let Some(index) = ledger.iter().position(|a| a.key == key) else {
        return InFront::NotHeld;
    };
    let found = &ledger[index];
    match (found.by, found.wanted) {
        (Announcer::Page, _) => InFront::NotHeld,
        (Announcer::Extension, true) => InFront::PageAsked,
        (Announcer::Extension, false) => {
            ledger.remove(index);
            InFront::Released
        }
    }
}

/// Appends `entry`, dropping the oldest past [`MAX_ANNOUNCED_KEYS`].
fn push_bounded(ledger: &mut Vec<Announced>, entry: Announced) {
    ledger.push(entry);
    if ledger.len() > MAX_ANNOUNCED_KEYS {
        let excess = ledger.len() - MAX_ANNOUNCED_KEYS;
        ledger.drain(..excess);
    }
}

/// Reads the ledger in `dir`, hands it to `edit`, and writes it back - the ONE way the file is
/// written, under [`ANNOUNCED_LOCK`], through a temporary file renamed over the old one so a reader
/// never opens half a file. An absent file is an empty ledger; an unreadable one is an ERROR, never
/// a silent empty ledger: every claim would then read fresh and announce twice.
pub fn with_ledger<R>(
    dir: &Path,
    edit: impl FnOnce(&mut Vec<Announced>) -> R,
) -> Result<R, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(ANNOUNCED_LOCK))
        .map_err(|e| format!("open {ANNOUNCED_LOCK}: {e}"))?;
    crate::commands::push::lock_exclusive(&lock)
        .map_err(|e| format!("lock {ANNOUNCED_LOCK}: {e}"))?;
    let path = dir.join(ANNOUNCED_FILE);
    let mut ledger: Vec<Announced> = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(ledger) => ledger,
            Err(e) => {
                // Only a foreign write produces this (every write here renames a whole file over
                // the old one). THIS call fails and says so; the file goes, so the next one starts
                // from an empty ledger instead of failing for ever.
                let removed = std::fs::remove_file(&path).is_ok();
                return Err(format!(
                    "{ANNOUNCED_FILE} unreadable ({e}) - removed={removed}, the next claim starts empty"
                ));
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("read {ANNOUNCED_FILE}: {e}")),
    };
    let before = ledger.clone();
    let answer = edit(&mut ledger);
    if ledger != before {
        let bytes = serde_json::to_vec(&ledger).map_err(|e| format!("encode: {e}"))?;
        let tmp = dir.join(format!("{ANNOUNCED_FILE}.tmp"));
        std::fs::write(&tmp, bytes).map_err(|e| format!("write {ANNOUNCED_FILE}.tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename over {ANNOUNCED_FILE}: {e}"))?;
    }
    // `lock` is released when it drops here, after the rename.
    drop(lock);
    Ok(answer)
}

/// The page's ask over the ledger in `dir`: the keys of `conversation` at `instants` (unkeyable
/// ones left out), claimed together. Answers the claim and the keys it covered, which the page
/// stamps on its notification so the extension can find it ([`claim_by_extension`]).
pub fn page_claim_in(
    dir: &Path,
    conversation: &str,
    instants: &[i64],
) -> Result<(PageClaim, Vec<String>), String> {
    let keys: Vec<String> = instants
        .iter()
        .filter_map(|at| announce_key(conversation, *at))
        .collect();
    if keys.is_empty() {
        return Err("no message of this banner carries an instant".to_string());
    }
    let claim = with_ledger(dir, |ledger| claim_by_page(ledger, &keys))?;
    Ok((claim, keys))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canari-announced-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn key(at: i64) -> String {
        announce_key("group-a", at).expect("keyable")
    }

    #[test]
    fn a_message_without_an_instant_or_a_conversation_has_no_key() {
        assert_eq!(announce_key("group-a", 0), None);
        assert_eq!(announce_key("group-a", -5), None);
        assert_eq!(announce_key("", 12), None);
        assert_eq!(
            announce_key("channel_x", 12).as_deref(),
            Some("channel_x:12")
        );
    }

    /// The defect of `1.7.3-alpha.6`: the extension drew it with the app killed, the cold launch's
    /// catch-up redelivered it, and the page raised it again.
    #[test]
    fn the_page_stands_down_for_what_the_extension_drew() {
        let mut ledger = Vec::new();
        assert_eq!(
            claim_by_extension(&mut ledger, &key(1)),
            ExtensionClaim::First
        );
        let claim = claim_by_page(&mut ledger, &[key(1)]);
        assert!(!claim.raise());
        assert_eq!(claim.by_extension, 1);
        // A second redelivery (the warm resume's pull after the live frame) stands down too.
        assert!(!claim_by_page(&mut ledger, &[key(1)]).raise());
    }

    #[test]
    fn the_same_frame_twice_raises_once() {
        let mut ledger = Vec::new();
        assert!(claim_by_page(&mut ledger, &[key(1)]).raise());
        let again = claim_by_page(&mut ledger, &[key(1)]);
        assert!(!again.raise());
        assert_eq!(again.by_page, 1);
    }

    #[test]
    fn one_fresh_message_in_a_flush_raises_and_takes_every_key() {
        let mut ledger = Vec::new();
        claim_by_extension(&mut ledger, &key(1));
        let claim = claim_by_page(&mut ledger, &[key(1), key(2)]);
        assert!(claim.raise());
        assert_eq!((claim.fresh, claim.by_extension), (1, 1));
        assert!(ledger.iter().all(|a| a.by == Announcer::Page && !a.wanted));
    }

    /// A push reaching an active app is answered `None`: its claim must go back, or the page's
    /// later ask stands down for a banner nobody saw.
    #[test]
    fn an_unshown_extension_banner_gives_its_claim_back() {
        let mut ledger = Vec::new();
        claim_by_extension(&mut ledger, &key(1));
        assert_eq!(settle_in_front(&mut ledger, &key(1)), InFront::Released);
        assert!(claim_by_page(&mut ledger, &[key(1)]).raise());
    }

    /// The page asked between the extension's claim and `willPresent`: it stood down, so the push
    /// is what the reader sees.
    #[test]
    fn a_push_the_page_stood_down_for_is_presented() {
        let mut ledger = Vec::new();
        claim_by_extension(&mut ledger, &key(1));
        assert!(!claim_by_page(&mut ledger, &[key(1)]).raise());
        assert_eq!(settle_in_front(&mut ledger, &key(1)), InFront::PageAsked);
    }

    #[test]
    fn a_push_the_page_already_announced_is_not_presented() {
        let mut ledger = Vec::new();
        claim_by_page(&mut ledger, &[key(1)]);
        assert_eq!(
            claim_by_extension(&mut ledger, &key(1)),
            ExtensionClaim::AfterPage
        );
        assert_eq!(settle_in_front(&mut ledger, &key(1)), InFront::NotHeld);
        assert_eq!(settle_in_front(&mut ledger, &key(9)), InFront::NotHeld);
    }

    #[test]
    fn the_ledger_keeps_the_newest_keys() {
        let mut ledger = Vec::new();
        for at in 1..=(MAX_ANNOUNCED_KEYS as i64 + 3) {
            claim_by_extension(&mut ledger, &key(at));
        }
        assert_eq!(ledger.len(), MAX_ANNOUNCED_KEYS);
        assert_eq!(ledger[0].key, key(4));
    }

    #[test]
    fn the_file_carries_the_claims_across_processes() {
        let dir = temp_dir("file");
        with_ledger(&dir, |l| claim_by_extension(l, &key(7))).unwrap();
        let (claim, keys) = page_claim_in(&dir, "group-a", &[7, 0]).unwrap();
        assert!(!claim.raise());
        assert_eq!(keys, vec![key(7)], "an unkeyable instant is left out");
        assert!(page_claim_in(&dir, "group-a", &[0]).is_err());
    }

    #[test]
    fn an_unreadable_ledger_is_an_error_never_an_empty_one() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join(ANNOUNCED_FILE), b"not json").unwrap();
        assert!(with_ledger(&dir, |l| claim_by_page(l, &[key(1)])).is_err());
        assert!(
            with_ledger(&dir, |l| claim_by_page(l, &[key(1)]))
                .unwrap()
                .raise(),
            "the next claim starts from an empty ledger"
        );
    }
}
