//! What this device knows, by itself, about the OTHER devices it shares groups with: the signature
//! key each `userId:deviceId` was first seen with, and every NEW device a signed commit admitted
//! (first sight or a changed key - a re-add under the pinned key records nothing).
//!
//! # Why a device keeps its own record
//!
//! A credential is a self-asserted `BasicCredential("userId:deviceId")` and the signature key behind
//! it is a keypair the device minted for itself. Nothing certifies the pair, so the only party a
//! client could ask "is this really that device's key" is the delivery service - which is the party
//! the question has to be answered without. What a client CAN do alone is remember: the first key it
//! sees for an identity is pinned (trust on first use), and a later KeyPackage or leaf naming the
//! same identity under another key is a fact this device can state on its own authority.
//!
//! # What the pin decides, and what it only reports
//!
//! - **An Add this device builds** ([`crate::MlsManager::add_members_bulk_with_base`]) refuses a
//!   KeyPackage whose identity is not exactly the device it was fetched for, and one whose key is
//!   not pinned for that identity. Both are typed skips ([`crate::SkippedKeyPackageReason`]).
//! - **A commit somebody else made** is MERGED whatever it admits - refusing to merge a commit the
//!   rest of the group merged forks this device out of the group, which is not a protection - and
//!   every new device it adds is recorded as a [`DeviceEvent`], with `trust = key-changed` and an ERROR
//!   line when the identity was pinned under another key. The pin is NOT moved by such a commit, so
//!   the changed key is still refused by every Add this device builds.
//!
//! # What proof would lift a refusal, and why there is none yet
//!
//! A key change is legitimate only when something the old key's holder controls vouches for the new
//! one. Today nothing does: a device whose state is gone has lost its old private key with it, and no
//! per-user identity signs a user's devices. So a changed key is refused outright, and a device that
//! lost its MLS state re-enrols as a NEW device (a new device id) rather than under its old name -
//! see `BaseMlsService.rotateDeviceIdentity`. Cross-signing by the user's other devices is the proof
//! a later work package adds.
//!
//! # Where it lives
//!
//! Inside [`crate::MlsManager`], persisted in the same CBOR snapshot as the OpenMLS storage - so it is
//! sealed by the device key with everything else, read by every platform through this one crate, and
//! written by the native background engine exactly as by the foreground. Both fields are
//! `#[serde(default)]` additions: a state written before them loads with no pins, and the trees it
//! already holds are pinned at that load ([`DeviceTrust::seed_from_tree`]).

use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::HashType;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

use crate::members::credential_identity;

/// The most device events kept while nobody takes them. An event is a few hundred bytes of
/// `mls.bin`; past this bound the OLDEST is dropped, with a WARN, because a record nobody reads must
/// not grow the state without limit.
pub const MAX_PENDING_DEVICE_EVENTS: usize = 512;

/// How a leaf's signature key relates to what this device had pinned for its identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeafTrust {
    /// No key was pinned for this identity: this one now is.
    FirstSight,
    /// The key is one this device had already pinned for the identity.
    Pinned,
    /// The identity was pinned under ANOTHER key. Nothing today can prove the change legitimate.
    KeyChanged,
}

impl LeafTrust {
    /// The stable wire name, identical in WASM, Tauri and TypeScript.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstSight => "first-sight",
            Self::Pinned => "pinned",
            Self::KeyChanged => "key-changed",
        }
    }
}

/// One device admission this device saw in a signed commit it merged, or one changed key it found
/// in a tree it joined.
///
/// The record a "Alice added a device" line in a conversation is built from: computed from the
/// signed MLS state, never from anything the delivery service says. No UI reads it yet - whether to
/// show it is the user's decision - so it waits in the state until
/// [`crate::MlsManager::take_device_events`] hands it over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEvent {
    /// The group whose tree changed.
    pub group_id: String,
    /// The epoch the commit created (or the epoch of the tree joined).
    pub epoch: u64,
    /// The admitted leaf's identity, `userId:deviceId`.
    pub identity: String,
    /// The first 8 bytes of SHA-256 over the leaf's signature key, hex - enough to say WHICH key.
    pub key_fingerprint: String,
    /// How that key relates to the pin.
    pub trust: LeafTrust,
    /// The verified identity of the committer, `None` for a key change found in a joined tree.
    pub added_by: Option<String>,
}

/// The persisted form of one identity's pinned keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedPin {
    pub identity: String,
    #[serde(with = "crate::byte_compat::bytes_vec")]
    pub keys: Vec<Vec<u8>>,
}

/// One leaf as [`DeviceTrust`] reads it: index, identity, signature key.
pub(crate) type LeafKey = (u32, String, Vec<u8>);

/// The pins and the pending events. Owned by [`crate::MlsManager`].
#[derive(Debug, Default)]
pub struct DeviceTrust {
    /// identity -> every signature key accepted for it. MORE THAN ONE only when the trees held
    /// several at the load that first pinned it: every one of those was admitted by a commit this
    /// device merged before pins existed, so none is more trustworthy than another.
    pins: HashMap<String, Vec<Vec<u8>>>,
    events: VecDeque<DeviceEvent>,
    /// Whether this process already said the event queue is full (see `push_event`).
    full_reported: bool,
}

/// The most pinned identities kept before those absent from every held tree are dropped
/// ([`DeviceTrust::prune_absent`]). An identity and one key are ~120 bytes of the sealed state.
pub const MAX_PINNED_IDENTITIES: usize = 8192;

/// Whether `identity` is `userId:deviceId` with exactly one separator and two non-empty halves.
///
/// Both halves come from the server when a KeyPackage is fetched, so a second ':' would let one
/// split disagree with another (the TypeScript parsers split on the first and on the last). No id
/// this product mints contains one (`web-`/`tauri-` + random, and a UUID user id).
pub fn is_well_formed_identity(identity: &str) -> bool {
    let mut parts = identity.split(':');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(u), Some(d), None) if !u.is_empty() && !d.is_empty()
    )
}

/// Whether a credential `found` names exactly the device `expected`.
///
/// The device half is compared exactly. The user half ignores ASCII case, because user ids are
/// UUIDs and both halves of the comparison come from different places (the credential was minted
/// from the token's subject, the expectation from a roster): a case difference names the same
/// account and must not refuse it.
pub fn identity_names(found: &str, expected: &str) -> bool {
    if !is_well_formed_identity(found) || !is_well_formed_identity(expected) {
        return false;
    }
    let (fu, fd) = found.split_once(':').unwrap_or_default();
    let (eu, ed) = expected.split_once(':').unwrap_or_default();
    fu.eq_ignore_ascii_case(eu) && fd == ed
}

/// `events` as the JSON array a binding without serde of its own hands to TypeScript (the WASM
/// one) - the same field names the Tauri command serialises.
pub fn events_json(events: &[DeviceEvent]) -> Result<String, crate::MlsError> {
    serde_json::to_string(events).map_err(|e| crate::MlsError::Serialization(e.to_string()))
}

/// The first 8 bytes of SHA-256 over a signature key, hex.
pub fn key_fingerprint(key: &[u8]) -> String {
    let provider = OpenMlsRustCrypto::default();
    // SHA-256 cannot fail in this backend; an empty digest would print as an empty fingerprint,
    // which a reader sees as missing rather than as a value.
    let digest = provider
        .crypto()
        .hash(HashType::Sha2_256, key)
        .unwrap_or_default();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Every leaf of `group`: `(index, identity, signature key)`. A leaf whose credential is unreadable
/// is skipped with a WARN - it can be pinned to nothing.
pub(crate) fn leaf_keys(group: &MlsGroup) -> Vec<LeafKey> {
    group
        .members()
        .filter_map(|m| match credential_identity(&m.credential) {
            Ok(identity) => Some((m.index.u32(), identity, m.signature_key)),
            Err(why) => {
                log::warn!(
                    "[TRUST] leaf {} carries an unreadable credential ({why}) - not pinned",
                    m.index.u32()
                );
                None
            }
        })
        .collect()
}

impl DeviceTrust {
    /// Rebuilds the in-memory record from the persisted one.
    pub(crate) fn from_persisted(pins: Vec<PersistedPin>, events: Vec<DeviceEvent>) -> Self {
        Self {
            pins: pins.into_iter().map(|p| (p.identity, p.keys)).collect(),
            events: events.into_iter().collect(),
            full_reported: false,
        }
    }

    /// The persisted form of the pins, sorted so two saves of one record are byte-identical.
    pub(crate) fn persisted_pins(&self) -> Vec<PersistedPin> {
        let mut out: Vec<PersistedPin> = self
            .pins
            .iter()
            .map(|(identity, keys)| PersistedPin {
                identity: identity.clone(),
                keys: keys.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.identity.cmp(&b.identity));
        out
    }

    /// The pending events, oldest first.
    pub(crate) fn persisted_events(&self) -> Vec<DeviceEvent> {
        self.events.iter().cloned().collect()
    }

    /// How `key` relates to what is pinned for `identity`, WITHOUT pinning anything.
    pub fn verdict(&self, identity: &str, key: &[u8]) -> LeafTrust {
        match self.pins.get(identity) {
            None => LeafTrust::FirstSight,
            Some(keys) if keys.iter().any(|k| k.as_slice() == key) => LeafTrust::Pinned,
            Some(_) => LeafTrust::KeyChanged,
        }
    }

    /// The keys pinned for `identity`, if any.
    pub fn pinned_keys(&self, identity: &str) -> Option<&[Vec<u8>]> {
        self.pins.get(identity).map(Vec::as_slice)
    }

    /// Records a leaf seen in a signed tree: pins it on first sight, never moves an existing pin.
    ///
    /// @returns how the key related to the pin BEFORE this call, and whether anything was written.
    fn observe(&mut self, identity: &str, key: &[u8]) -> (LeafTrust, bool) {
        let trust = self.verdict(identity, key);
        if trust == LeafTrust::FirstSight {
            self.pins.insert(identity.to_string(), vec![key.to_vec()]);
            return (trust, true);
        }
        (trust, false)
    }

    /// Queues an event, dropping the oldest past the bound.
    ///
    /// SAID ONCE PER FILLING, NOT PER DROP: a full queue means nothing takes the events, and a line
    /// at every admission after that would be a line its reader learns to skip. The flag is in memory
    /// only - a new process says it once again - and clears when the queue is taken.
    ///
    /// @returns whether this call reported the queue full.
    fn push_event(&mut self, event: DeviceEvent) -> bool {
        let mut reported = false;
        if self.events.len() >= MAX_PENDING_DEVICE_EVENTS
            && let Some(dropped) = self.events.pop_front()
            && !self.full_reported
        {
            self.full_reported = true;
            reported = true;
            log::warn!(
                "[TRUST] {MAX_PENDING_DEVICE_EVENTS} device events are waiting and nothing took \
                 them - the oldest are dropped from now on (first: {} on {} at epoch {})",
                dropped.identity,
                dropped.group_id,
                dropped.epoch
            );
        }
        self.events.push_back(event);
        reported
    }

    /// Drops the pins of identities no held tree contains, when there are more than
    /// [`MAX_PINNED_IDENTITIES`] - the bound on a record that otherwise only grows.
    ///
    /// ONLY ABSENT IDENTITIES GO: a pin of a device still in a tree this device holds is what refuses
    /// a changed key for it, and is kept whatever the count. A dropped identity is first sight again
    /// if it ever returns - the same answer a device that never met it gets.
    ///
    /// @returns how many pins were dropped.
    pub(crate) fn prune_absent(&mut self, held: &std::collections::HashSet<&str>) -> usize {
        if self.pins.len() <= MAX_PINNED_IDENTITIES {
            return 0;
        }
        let before = self.pins.len();
        self.pins
            .retain(|identity, _| held.contains(identity.as_str()));
        let dropped = before - self.pins.len();
        log::info!(
            "[TRUST] {before} pinned identities passed the bound of {MAX_PINNED_IDENTITIES}: \
             dropped the {dropped} no held tree contains"
        );
        dropped
    }

    /// Pins every leaf of a tree whose identity has no pin yet, and nothing else.
    ///
    /// For the trees a state ALREADY HOLDS when it loads: each was admitted by a commit this device
    /// merged, so this is first sight. An identity seen with several keys across those trees gets all
    /// of them - nothing distinguishes them. An identity already pinned is left alone and nothing is
    /// recorded: a conflict there was reported when the leaf arrived.
    ///
    /// @returns whether any pin was written.
    pub(crate) fn seed_from_tree(&mut self, leaves: &[LeafKey]) -> bool {
        let mut fresh: HashMap<&str, Vec<Vec<u8>>> = HashMap::new();
        for (_, identity, key) in leaves {
            if self.pins.contains_key(identity.as_str()) {
                continue;
            }
            let keys = fresh.entry(identity.as_str()).or_default();
            if !keys.iter().any(|k| k == key) {
                keys.push(key.clone());
            }
        }
        let wrote = !fresh.is_empty();
        for (identity, keys) in fresh {
            self.pins.insert(identity.to_string(), keys);
        }
        wrote
    }

    /// Records a tree this device has just JOINED (a Welcome, an external commit): pins the
    /// identities seen for the first time, and records an event for every leaf whose identity is
    /// pinned under another key.
    ///
    /// @returns whether anything was written.
    pub(crate) fn observe_joined_tree(
        &mut self,
        group_id: &str,
        epoch: u64,
        leaves: &[LeafKey],
        own_identity: &str,
    ) -> bool {
        let mut wrote = false;
        for (_, identity, key) in leaves {
            let (trust, pinned) = self.observe(identity, key);
            wrote |= pinned;
            if trust == LeafTrust::KeyChanged {
                log::error!(
                    "[TRUST] joined {group_id} at epoch {epoch}: its tree holds {identity} under key {} \
                     while this device pinned another for that identity - nothing proves the change",
                    key_fingerprint(key)
                );
                self.push_event(DeviceEvent {
                    group_id: group_id.to_string(),
                    epoch,
                    identity: identity.clone(),
                    key_fingerprint: key_fingerprint(key),
                    trust,
                    added_by: None,
                });
                wrote = true;
            } else if identity == own_identity && trust != LeafTrust::Pinned {
                log::debug!("[TRUST] pinned this device's own key on joining {group_id}");
            }
        }
        wrote
    }

    /// Records a commit this device merged: a leaf in `after` whose `(identity, key)` pair is nowhere
    /// in `before` ENTERED the tree with that commit. An event is recorded only when that pair is NEWS
    /// to this device - a key never pinned for the identity (`first-sight`) or another key than the
    /// pinned one (`key-changed`).
    ///
    /// The diff is over the TREE, not over the commit's proposals, so every way a leaf enters - an
    /// Add, an external join's own leaf, an update that swaps a key - is caught by one rule. It is
    /// over PAIRS, not indexes, and a pinned pair is not news: a leaf that moved index, or a device
    /// removed and re-added under its pinned key (a heal), is the same device and says nothing.
    ///
    /// @returns whether anything was written.
    pub(crate) fn observe_merged_commit(
        &mut self,
        group_id: &str,
        epoch: u64,
        before: &[LeafKey],
        after: &[LeafKey],
        added_by: Option<&str>,
        own: (&str, &[u8]),
    ) -> bool {
        let mut wrote = false;
        for (_, identity, key) in after {
            let existed = before.iter().any(|(_, id, k)| id == identity && k == key);
            if existed {
                continue;
            }
            // This device's own leaf entering its own group (an external join it made) is not a
            // device being added to anybody's conversation.
            if identity == own.0 && key.as_slice() == own.1 {
                wrote |= self.observe(identity, key).1;
                continue;
            }
            let (trust, pinned) = self.observe(identity, key);
            wrote |= pinned;
            let fingerprint = key_fingerprint(key);
            match trust {
                LeafTrust::KeyChanged => log::error!(
                    "[TRUST] {group_id} epoch {epoch}: a commit by {} added {identity} under key \
                     {fingerprint}, but this device pinned another key for it - merged (the group did), \
                     NOT re-pinned, and every Add this device builds keeps refusing that key",
                    added_by.unwrap_or("an unreadable sender")
                ),
                LeafTrust::Pinned => {
                    log::debug!(
                        "[TRUST] {group_id} epoch {epoch}: {identity} re-entered under its pinned key \
                         (added by {}) - the same device, nothing recorded",
                        added_by.unwrap_or("an unreadable sender")
                    );
                    continue;
                }
                LeafTrust::FirstSight => log::info!(
                    "[TRUST] {group_id} epoch {epoch}: {identity} added by {} (key {fingerprint}, first sight)",
                    added_by.unwrap_or("an unreadable sender"),
                ),
            }
            self.push_event(DeviceEvent {
                group_id: group_id.to_string(),
                epoch,
                identity: identity.clone(),
                key_fingerprint: fingerprint,
                trust,
                added_by: added_by.map(str::to_string),
            });
            wrote = true;
        }
        wrote
    }

    /// Hands every pending event over and forgets them.
    pub(crate) fn take_events(&mut self) -> Vec<DeviceEvent> {
        self.full_reported = false;
        self.events.drain(..).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identity_with_more_than_one_separator_is_not_a_device() {
        assert!(is_well_formed_identity("u:d"));
        assert!(!is_well_formed_identity("u:d:x"));
        assert!(!is_well_formed_identity("u"));
        assert!(!is_well_formed_identity(":d"));
        assert!(!is_well_formed_identity("u:"));
    }

    #[test]
    fn the_user_half_ignores_case_and_the_device_half_does_not() {
        assert!(identity_names("ABC:web-1", "abc:web-1"));
        assert!(!identity_names("abc:WEB-1", "abc:web-1"));
        assert!(!identity_names("abc:web-1", "abd:web-1"));
        assert!(!identity_names("abc:web-1:x", "abc:web-1:x"));
    }

    #[test]
    fn a_first_sight_pins_and_a_later_different_key_is_a_change_that_does_not_move_the_pin() {
        let mut t = DeviceTrust::default();
        assert_eq!(t.observe("u:d", b"k1"), (LeafTrust::FirstSight, true));
        assert_eq!(t.observe("u:d", b"k1"), (LeafTrust::Pinned, false));
        assert_eq!(t.observe("u:d", b"k2"), (LeafTrust::KeyChanged, false));
        assert_eq!(t.verdict("u:d", b"k1"), LeafTrust::Pinned);
        assert_eq!(t.verdict("u:d", b"k2"), LeafTrust::KeyChanged);
    }

    #[test]
    fn a_seed_grandfathers_every_key_the_trees_held_and_never_touches_an_existing_pin() {
        let mut t = DeviceTrust::default();
        t.observe("a:1", b"old");
        let leaves = vec![
            (0, "a:1".to_string(), b"other".to_vec()),
            (1, "b:1".to_string(), b"x".to_vec()),
            (2, "b:1".to_string(), b"y".to_vec()),
        ];
        assert!(t.seed_from_tree(&leaves));
        assert_eq!(t.verdict("a:1", b"other"), LeafTrust::KeyChanged);
        assert_eq!(t.verdict("b:1", b"x"), LeafTrust::Pinned);
        assert_eq!(t.verdict("b:1", b"y"), LeafTrust::Pinned);
        assert!(!t.seed_from_tree(&leaves), "a second seed writes nothing");
    }

    #[test]
    fn the_event_queue_is_bounded_drops_the_oldest_and_says_so_once() {
        let event = |i: usize| DeviceEvent {
            group_id: "g".into(),
            epoch: i as u64,
            identity: "u:d".into(),
            key_fingerprint: String::new(),
            trust: LeafTrust::FirstSight,
            added_by: None,
        };
        let mut t = DeviceTrust::default();
        let reports = (0..(MAX_PENDING_DEVICE_EVENTS + 3))
            .filter(|&i| t.push_event(event(i)))
            .count();
        assert_eq!(
            reports, 1,
            "a full queue is said once, not at every admission"
        );
        let taken = t.take_events();
        assert_eq!(taken.len(), MAX_PENDING_DEVICE_EVENTS);
        assert_eq!(taken[0].epoch, 3);
        assert!(t.take_events().is_empty());

        // Taken, then full again: said again, once.
        let again = (0..(MAX_PENDING_DEVICE_EVENTS + 2))
            .filter(|&i| t.push_event(event(i)))
            .count();
        assert_eq!(again, 1);
    }

    #[test]
    fn pins_past_the_bound_drop_only_identities_no_held_tree_contains() {
        let mut t = DeviceTrust::default();
        for i in 0..=MAX_PINNED_IDENTITIES {
            t.observe(&format!("u{i}:d"), b"k");
        }
        let held: std::collections::HashSet<&str> = ["u0:d", "u1:d"].into_iter().collect();
        assert_eq!(t.prune_absent(&held), MAX_PINNED_IDENTITIES - 1);
        assert_eq!(t.verdict("u0:d", b"other"), LeafTrust::KeyChanged);
        assert_eq!(t.verdict("u5:d", b"other"), LeafTrust::FirstSight);
        assert_eq!(
            t.prune_absent(&held),
            0,
            "under the bound, nothing is pruned"
        );
    }

    #[test]
    fn events_serialise_with_the_wire_names_typescript_reads() {
        let e = DeviceEvent {
            group_id: "g".into(),
            epoch: 4,
            identity: "u:d".into(),
            key_fingerprint: "00ff".into(),
            trust: LeafTrust::KeyChanged,
            added_by: Some("v:e".into()),
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"groupId":"g","epoch":4,"identity":"u:d","keyFingerprint":"00ff","trust":"key-changed","addedBy":"v:e"}"#
        );
    }
}
