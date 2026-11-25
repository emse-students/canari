//! THE APP'S LEDGERS THAT DESCRIBE THIS STATE, CARRIED INSIDE IT (KILL-2, 2026-10-26).
//!
//! Two of the app's records exist only to describe the ratchets this state holds:
//!
//! - the seen-ciphertext marks - "this device consumed the generation that decrypted this frame";
//! - the send ledger's `persisted` counts - "this state holds the advance of N frames sent at epoch E".
//!
//! Each is only TRUE of the state it was written beside. They lived in `localStorage`, which a
//! browser commits to disk lazily - seconds after the write - while the state itself is durable
//! when its checkpoint completes. A browser or an app killed inside that delay came back with a
//! ratchet ahead of its marks: the next history walk re-read a frame it had consumed, MLS answered
//! `SecretReuseError`, and the client accused the frame of being lost (measured by KILL-2).
//!
//! No ordering of two stores closes that: "state first, then ledger" is exactly the window that
//! was measured, and "ledger first" is the unsurvivable direction (a mark ahead of its ratchet
//! skips a frame that was never read). So the ledgers are written IN the state - one CBOR document,
//! one seal, one write - and reach disk together or not at all, on every platform and through
//! every writer, including the native ones that persist the live manager without the app asking.
//!
//! The values are OPAQUE here. The app owns their shape (`stateLedgers.ts`); this crate only keeps
//! them with the tree they describe, and carries them across a swap ([`MlsManager::adopt_app_ledgers`]).
//!
//! What is NOT here, deliberately: the send ledger's `emitted` count. It must be durable BEFORE a
//! frame leaves, which is earlier than any checkpoint, so it lives in a store the app awaits on the
//! send path (`sendRatchetLedger.ts`).

use std::collections::HashMap;

use base64::Engine;

use crate::{IncomingApplication, MlsError, MlsManager};

/// The prefix of every key a KEPT key-group frame is stored under. The app owns the rest of the key
/// (`keptKeyGroupFrames.ts`: the group and the frame's fingerprint); this crate only refuses a key
/// outside the namespace, so a kept frame can never overwrite another ledger.
pub const KEPT_FRAME_PREFIX: &str = "kept-frame:";

/// What a kept frame holds: the sender MLS verified (`userId:deviceId`, `None` when the credential
/// was unreadable) and the plaintext, base64 (standard, padded). Serialised in this field order with
/// no whitespace - `keptKeyGroupFrames.ts` builds the identical string for its own view.
#[derive(serde::Serialize)]
struct KeptFrame<'a> {
    sender: Option<&'a str>,
    plaintext: String,
}

/// The most the app's ledgers may weigh in this state, in bytes: each key and value plus the five
/// bytes of its CBOR text header. The app enforces it (`seenLedgerBounds.ts`, against
/// `APP_LEDGERS_BYTE_BUDGET` in `stateLedgers.ts`, which `seenLedgerBounds.test.ts` holds equal to
/// this one): every checkpoint seals and writes all of them, so their weight is a cost on every
/// write. A state that opens over it is a broken bound, said at ERROR by `load_or_create`.
pub const APP_LEDGERS_BYTE_BUDGET: usize = 1_048_576;

/// The CBOR header of one text string, at most - the unit the budget above counts per key and value.
const CBOR_STRING_HEADER_BYTES: usize = 5;

impl MlsManager {
    /// Applies the app's staged ledger changes: a `Some` sets the key, a `None` removes it.
    ///
    /// Marks the snapshot DIRTY - the next `save_state` must carry the change - and never the
    /// ratchet flag: no generation moved, so a reload guard grading ratchets must not see one.
    ///
    /// @returns how many keys actually changed (a value identical to the held one is not a change)
    pub fn apply_app_ledgers(
        &mut self,
        changes: impl IntoIterator<Item = (String, Option<String>)>,
    ) -> usize {
        let mut changed = 0usize;
        for (key, value) in changes {
            let moved = match value {
                Some(v) => self.app_ledgers.insert(key, v.clone()).as_ref() != Some(&v),
                None => self.app_ledgers.remove(&key).is_some(),
            };
            if moved {
                changed += 1;
            }
        }
        if changed > 0 {
            self.state_snapshot.borrow_mut().invalidate();
        }
        changed
    }

    /// [`Self::apply_app_ledgers`] for a JSON object `{ "key": "value" | null }` - the one wire
    /// format both bridges hand over (the WASM binding and the native checkpoint command).
    ///
    /// @returns how many keys changed, or `InvalidData` for a document that is not such an object
    pub fn apply_app_ledgers_json(&mut self, changes_json: &str) -> Result<usize, MlsError> {
        let changes: HashMap<String, Option<String>> =
            serde_json::from_str(changes_json).map_err(|e| {
                log::error!("apply_app_ledgers_json: the app handed a malformed change set ({e})");
                MlsError::InvalidData
            })?;
        Ok(self.apply_app_ledgers(changes))
    }

    /// Decrypts one frame and, when it is an application message, KEEPS its plaintext in the
    /// ledgers under `keep_as` - in the same call, so no export of this state can hold the spent
    /// generation without the plaintext it produced.
    ///
    /// WHY HERE AND NOT IN THE APP (mls-desync-prevention section 11). A key-group frame's generation
    /// is spent at decrypt, and the app's handler (the seed store) runs after it. A handler that threw
    /// left a frame whose redelivery MLS refuses (`SecretReuseError`), so the seed was lost. Kept by
    /// the app after the decrypt returned, a checkpoint could export between the two (on native it
    /// runs under the same manager lock, between this call and the IPC answer) and a kill then lost
    /// the frame again. Kept here, the plaintext and the ratchet advance are one mutation of one
    /// document: every export holds both or neither.
    ///
    /// A commit or a proposal (`Ok(None)`) keeps nothing - there is no payload to hand anyone.
    ///
    /// @returns what [`Self::process_incoming_message_with_sender`] returns; `InvalidData` before any
    ///   decrypt for a `keep_as` outside [`KEPT_FRAME_PREFIX`]
    pub fn process_incoming_message_kept(
        &mut self,
        group_id: &str,
        message_bytes: &[u8],
        keep_as: &str,
    ) -> Result<Option<IncomingApplication>, MlsError> {
        if !keep_as.starts_with(KEPT_FRAME_PREFIX) || keep_as.len() == KEPT_FRAME_PREFIX.len() {
            // The key is not printed: it names a group, and a native log line carries no identifier
            // it does not need (`nativeLogContent.test.ts`). Its length tells a reader which case.
            log::error!(
                "process_incoming_message_kept: refused a key outside '{KEPT_FRAME_PREFIX}' ({} bytes) - nothing decrypted",
                keep_as.len()
            );
            return Err(MlsError::InvalidData);
        }
        let app = self.process_incoming_message_with_sender(group_id, message_bytes)?;
        if let Some(app) = &app {
            let kept = KeptFrame {
                sender: app.sender_identity.as_deref(),
                plaintext: base64::engine::general_purpose::STANDARD.encode(&app.plaintext),
            };
            // A struct of a string and an optional string cannot fail to serialise; an error is a
            // serde_json bug. The generation is already spent, so it is said at ERROR and the frame
            // is still returned - the app handles it now, and only a kill before that loses it.
            match serde_json::to_string(&kept) {
                Ok(value) => {
                    self.apply_app_ledgers([(keep_as.to_string(), Some(value))]);
                }
                Err(e) => log::error!(
                    "process_incoming_message_kept: the frame decrypted but could not be kept ({e})"
                ),
            }
        }
        Ok(app)
    }

    /// Every ledger this state carries, by key.
    pub fn app_ledgers(&self) -> &HashMap<String, String> {
        &self.app_ledgers
    }

    /// [`Self::app_ledgers`] as a JSON object, for the bridges.
    pub fn app_ledgers_json(&self) -> String {
        // A map of strings to strings cannot fail to serialise; an error here is a serde_json bug,
        // and an empty object would read as "no ledgers" - so it is named, never swallowed.
        serde_json::to_string(&self.app_ledgers).unwrap_or_else(|e| {
            log::error!("app_ledgers_json: serialisation failed ({e}) - answering no ledgers");
            "{}".to_string()
        })
    }

    /// Takes `live`'s ledgers into this manager, which is about to REPLACE `live`.
    ///
    /// THE LEDGERS BELONG TO THE DOCUMENT, NOT TO WHICHEVER COPY OF THE STATE IS LIVE. A swap installs
    /// a candidate built from a snapshot (a worker's result, a catch-up, the native resume reload), and
    /// that snapshot holds the ledgers as they stood when it was taken. Changes the app applied to the
    /// live manager after that - and already stopped tracking, because a checkpoint took them - would
    /// otherwise vanish with the live manager, and the next checkpoint would write the state without
    /// them: the very regression this module exists to remove.
    ///
    /// Only sound because every swap seam already refuses a candidate the live manager is AHEAD of
    /// (`reload_is_monotonic` plus a ratchet guard): the candidate holds every advance the live one
    /// does, so every mark the live ledgers carry describes an advance the candidate holds too.
    pub fn adopt_app_ledgers(&mut self, live: &MlsManager) {
        if self.app_ledgers == live.app_ledgers {
            return;
        }
        self.app_ledgers = live.app_ledgers.clone();
        self.state_snapshot.borrow_mut().invalidate();
    }

    /// What these ledgers weigh in the state, as [`APP_LEDGERS_BYTE_BUDGET`] counts it.
    pub fn app_ledgers_bytes(&self) -> usize {
        self.app_ledgers
            .iter()
            .map(|(k, v)| k.len() + v.len() + 2 * CBOR_STRING_HEADER_BYTES)
            .sum()
    }

    /// `"<keys>x<bytes>B"` for the composition line - the cost these ledgers add to every checkpoint.
    pub(crate) fn app_ledgers_weight(&self) -> String {
        let bytes: usize = self
            .app_ledgers
            .iter()
            .map(|(k, v)| k.len() + v.len())
            .sum();
        format!("{}x{}B", self.app_ledgers.len(), bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::KeptFrame;
    use crate::MlsManager;

    /// A frame whose credential could not be read keeps `sender: null`, and `keptFrameValue(null, ..)`
    /// in `keptKeyGroupFrames.ts` builds this very string - the two must weigh the same.
    #[test]
    fn a_kept_frame_with_no_sender_serialises_as_null() {
        let value = serde_json::to_string(&KeptFrame {
            sender: None,
            plaintext: "BAI=".to_string(),
        })
        .unwrap();
        assert_eq!(value, r#"{"sender":null,"plaintext":"BAI="}"#);
    }

    fn manager(tag: &str) -> MlsManager {
        MlsManager::load_or_create(&format!("{tag}-user"), "d1", None).unwrap()
    }

    #[test]
    fn the_weight_counts_every_key_and_value_with_its_header() {
        let mut m = manager("ledger-weight");
        assert_eq!(m.app_ledgers_bytes(), 0);
        m.apply_app_ledgers([("ab".to_string(), Some("cde".to_string()))]);
        assert_eq!(m.app_ledgers_bytes(), 2 + 3 + 10);
    }

    #[test]
    fn a_ledger_travels_in_the_saved_state_and_comes_back_with_it() {
        let mut m = manager("ledger-roundtrip");
        let changed = m.apply_app_ledgers([
            ("seen:g1".to_string(), Some("[\"a:b\"]".to_string())),
            (
                "send-persisted".to_string(),
                Some("{\"g1@3\":2}".to_string()),
            ),
        ]);
        assert_eq!(changed, 2);
        let bytes = m.save_state().unwrap();
        let back = MlsManager::load_or_create("ledger-roundtrip-user", "d1", Some(bytes)).unwrap();
        assert_eq!(back.app_ledgers().get("seen:g1").unwrap(), "[\"a:b\"]");
        assert_eq!(
            back.app_ledgers().get("send-persisted").unwrap(),
            "{\"g1@3\":2}"
        );
    }

    #[test]
    fn a_change_dirties_the_snapshot_and_never_the_ratchet_flag() {
        let mut m = manager("ledger-dirty");
        let first = m.save_state().unwrap();
        // Cached: nothing changed.
        assert_eq!(m.save_state().unwrap(), first);
        m.apply_app_ledgers([("k".to_string(), Some("v".to_string()))]);
        assert!(!m.has_unsaved_ratchet_advance());
        let second = m.save_state().unwrap();
        assert_ne!(second, first, "the next save must carry the ledger");
    }

    #[test]
    fn an_identical_value_and_an_absent_removal_change_nothing() {
        let mut m = manager("ledger-noop");
        m.apply_app_ledgers([("k".to_string(), Some("v".to_string()))]);
        assert_eq!(
            m.apply_app_ledgers([("k".to_string(), Some("v".to_string()))]),
            0
        );
        assert_eq!(m.apply_app_ledgers([("absent".to_string(), None)]), 0);
        assert_eq!(m.apply_app_ledgers([("k".to_string(), None)]), 1);
        assert!(m.app_ledgers().is_empty());
    }

    #[test]
    fn the_json_bridge_sets_and_removes() {
        let mut m = manager("ledger-json");
        m.apply_app_ledgers_json(r#"{"a":"1","b":"2"}"#).unwrap();
        m.apply_app_ledgers_json(r#"{"a":null}"#).unwrap();
        assert_eq!(m.app_ledgers_json(), r#"{"b":"2"}"#);
        assert!(m.apply_app_ledgers_json("[1,2]").is_err());
    }

    #[test]
    fn a_swap_keeps_the_live_ledgers_and_not_the_snapshots() {
        let mut live = manager("ledger-swap");
        live.apply_app_ledgers([("seen:g".to_string(), Some("old".to_string()))]);
        let snapshot = live.save_state().unwrap();
        // The app stages a newer ledger into the live manager AFTER the snapshot was taken.
        live.apply_app_ledgers([("seen:g".to_string(), Some("new".to_string()))]);
        let mut candidate =
            MlsManager::load_or_create("ledger-swap-user", "d1", Some(snapshot)).unwrap();
        assert_eq!(candidate.app_ledgers().get("seen:g").unwrap(), "old");
        candidate.adopt_app_ledgers(&live);
        assert_eq!(candidate.app_ledgers().get("seen:g").unwrap(), "new");
        let reloaded = MlsManager::load_or_create(
            "ledger-swap-user",
            "d1",
            Some(candidate.save_state().unwrap()),
        )
        .unwrap();
        assert_eq!(reloaded.app_ledgers().get("seen:g").unwrap(), "new");
    }
}
