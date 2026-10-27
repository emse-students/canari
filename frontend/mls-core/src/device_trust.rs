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
    /// Whether this DEVICE was never in this group as far as this device saw: no leaf of its in the
    /// tree the commit was built on, and no departure of it recorded for this group. Decided PER
    /// GROUP, never from the pin (one store, which any group's tree writes): what makes an entry by
    /// the device's own commit an entry no member made ([`DeviceEvent::enters_as_unvouched_device`]).
    /// `false` for an event recorded before the field existed.
    #[serde(default)]
    pub first_in_group: bool,
    /// Whether the admitted device's USER already had a leaf in the tree before the commit - so the
    /// commit gave a member another device, rather than bringing a new member in with theirs.
    /// `false` for an event recorded before the field existed: such an event is never announced.
    #[serde(default)]
    pub member_already_present: bool,
}

impl DeviceEvent {
    /// Whether this event is "a device was added" - the fact both notices are built from (user
    /// decision 2026-10-22, `docs/wiki/protocols/mls-protocol.md#new-device-notices`):
    ///
    /// - a signed commit admitted it (`added_by` is set - a key change found in a joined tree is not
    ///   an admission);
    /// - and the key is NEW to this device: either a first sight for a user who was already in the
    ///   conversation (a member joining with all their devices is the member-added line, not N
    ///   device lines), or a key other than the one pinned for that identity, which nothing proves
    ///   and which is announced wherever it happens.
    ///
    /// A `pinned` re-add (the replace path, a rotation) is the same device and is never announced -
    /// unless the device entered by its own commit, never in this group
    /// ([`DeviceEvent::enters_as_unvouched_device`]): a pin written by another group vouches for
    /// nothing here, and the owner is told.
    pub fn announces_new_device(&self) -> bool {
        self.added_by.is_some()
            && match self.trust {
                LeafTrust::KeyChanged => true,
                LeafTrust::FirstSight => self.member_already_present,
                LeafTrust::Pinned => self.enters_as_unvouched_device(),
            }
    }

    /// Whether a device of a MEMBER brought ITSELF into this group: the commit admitting it was
    /// signed by that very device (an external commit), its user already held a leaf, and the
    /// device was never in this group ([`DeviceEvent::first_in_group`]) - whatever its pin says.
    /// The twin of `entersAsUnvouchedDevice` in `deviceTrust.ts`, held to the same table.
    pub fn enters_as_unvouched_device(&self) -> bool {
        self.first_in_group
            && self.member_already_present
            && self
                .added_by
                .as_deref()
                .is_some_and(|c| same_identity(c, &self.identity))
    }

    /// Whether this event is the account owner's alert, "a new device was added to your account",
    /// for the device `own_user_id:own_device_id` that processed it: an announced device of the same
    /// account (user half ignoring ASCII case), and never the processing device itself - a device
    /// does not alert itself about its own arrival.
    ///
    /// The native background engines decide with this; the app decides with its TypeScript twin
    /// `deviceEventAudience`, and both are held to one table (`tests/fixtures/device_notices.json`).
    pub fn is_owner_alert(&self, own_user_id: &str, own_device_id: &str) -> bool {
        // An identity that names no device ([`canonical_identity`]) alerts nobody.
        let Some(identity) = canonical_identity(&self.identity) else {
            return false;
        };
        let Some((user, device)) = identity.split_once(':') else {
            return false;
        };
        self.announces_new_device()
            && user == canonical_user_id(own_user_id)
            && device != own_device_id
    }

    /// The key a notice is de-duplicated on: one device under one key is announced once, however
    /// many groups admitted it and whichever engine (app or background) saw it first. Identical to
    /// the TypeScript `deviceEventKey`: the [`canonical_identity`], then the fingerprint; `None` for
    /// an identity that names no device, which [`Self::is_owner_alert`] never alerts for.
    pub fn notice_key(&self) -> Option<String> {
        canonical_identity(&self.identity)
            .map(|identity| format!("{identity}|{}", self.key_fingerprint))
    }
}

/// The persisted form of one identity's pinned keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedPin {
    pub identity: String,
    #[serde(with = "crate::byte_compat::bytes_vec")]
    pub keys: Vec<Vec<u8>>,
    /// See [`Pin::anchored`]. A pin written before the field existed was never re-seeded after a
    /// prune (nothing pruned then), so it reads as anchored.
    #[serde(default = "anchored_by_default")]
    pub anchored: bool,
    /// See [`Pin::reaffirmations`].
    #[serde(default)]
    pub reaffirmations: u64,
}

fn anchored_by_default() -> bool {
    true
}

/// One identity's pin, in memory.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pin {
    /// Every signature key accepted for the identity. MORE THAN ONE only when the trees held several
    /// at the load that first pinned it: every one of those was admitted by a commit this device
    /// merged before pins existed, so none is more trustworthy than another.
    keys: Vec<Vec<u8>>,
    /// FALSE when this pin was written AFTER the identity's previous pin was pruned: the key came
    /// from whatever tree arrived next, with nothing this device saw before to anchor it. A verifier
    /// reads a contradiction with an unanchored pin as "unverified", never as "forged".
    anchored: bool,
    /// How many times a merged commit showed the device holding a pinned key AFTER the pin was
    /// written: its leaf entering a tree under that key, or a commit it signed. Lifts a refusal a
    /// single forged KeyPackage caused (`refusedDevices.ts`).
    reaffirmations: u64,
}

/// What a verifier is told about one device: `MlsManager::pinned_signature_keys`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinView {
    /// The pinned signature keys - a signature valid under ANY of them is the device's.
    pub keys: Vec<Vec<u8>>,
    /// Whether the pin is anchored ([`Pin::anchored`]).
    pub anchored: bool,
    /// The reaffirmation count ([`Pin::reaffirmations`]); a verifier ignores it.
    pub reaffirmations: u64,
}

/// The most pruned identities remembered (to mark a later pin unanchored). Past it the oldest go.
pub const MAX_REMEMBERED_PRUNED: usize = 8192;

/// One leaf as [`DeviceTrust`] reads it: index, identity, signature key.
pub(crate) type LeafKey = (u32, String, Vec<u8>);

/// One user LEAVING a group's tree, as a commit this device merged showed it: the commit removed the
/// user's last leaf. Never shown to anybody - it is evidence for a verifier, not a notice.
///
/// WITH `device_id`, ONE DEVICE leaving it (2026-10-27): any leaf a merged commit removed, whether
/// or not its user stays - and `user_left` says it was the user's last. What tells a device COMING
/// BACK by its own commit from a device that was never in the group
/// ([`DeviceEvent::first_in_group`]). ONE record per removed device, so the bound counts what it
/// always counted for a user with one device; a record without `device_id` is a user's departure
/// written before the field existed (or of a leaf whose identity names no device).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Departure {
    pub group_id: String,
    /// The user half of the identity, ASCII-lowercased (the half `identity_names` reads that way).
    pub user_id: String,
    /// The epoch the removing commit created: the first epoch the user is no longer in.
    pub epoch: u64,
    /// The device half, as [`canonical_identity`] writes it, on a DEVICE's departure; `None` on a
    /// user's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// On a device's departure: it was its user's LAST leaf - the user left the tree with it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub user_left: bool,
}

/// The most departures kept. Past it the departures of groups no longer held are dropped at load,
/// and a push past it drops the oldest (said once per filling).
pub const MAX_RECORDED_DEPARTURES: usize = 8192;

/// The pins and the pending events. Owned by [`crate::MlsManager`].
#[derive(Debug, Default)]
pub struct DeviceTrust {
    /// identity -> its pin ([`Pin`]).
    pins: HashMap<String, Pin>,
    /// Identities whose pin was pruned, oldest first: a pin written for one of them later is
    /// UNANCHORED ([`Pin::anchored`]). Persisted; bounded by [`MAX_REMEMBERED_PRUNED`].
    pruned: VecDeque<String>,
    events: VecDeque<DeviceEvent>,
    /// Whether this process already said the event queue is full (see `push_event`).
    full_reported: bool,
    /// Every user departure seen in a merged commit, oldest first (see [`Departure`]).
    departures: VecDeque<Departure>,
    /// Whether this process already said the departure record is full.
    departures_full_reported: bool,
    /// Groups the load did NOT seed because a commit was staged in them. In memory only: the next
    /// load decides again. Seeded at the first commit merged on their tree
    /// ([`Self::observe_merged_commit`]), or when their staged commit is cleared.
    unseeded: std::collections::HashSet<String>,
}

/// The user `identity` names, ASCII-lowercased, or `None` for an identity that names nobody. Every
/// comparison of a leaf's user with a user id goes through it.
///
/// TWO SHAPES ARE READ. A device identity `user:device` ([`canonical_identity`]), and the LEGACY
/// BARE `user` credential that builds before device identities wrote (no colon at all): it names
/// its user and NO device, so it is removed with that user and a push it signed is that user's, but
/// [`canonical_identity`] refuses it - it is never pinned and never matches `user:device`. Kept
/// until no held tree carries a bare leaf (docs/wiki/legacy-compatibility.md).
pub fn canonical_user_of(identity: &str) -> Option<String> {
    if is_legacy_bare_identity(identity) {
        return Some(canonical_user_id(identity));
    }
    canonical_identity(identity).and_then(|c| c.split_once(':').map(|(user, _)| user.to_string()))
}

/// Whether `identity` is the LEGACY BARE credential shape: a non-empty user id with no colon.
pub fn is_legacy_bare_identity(identity: &str) -> bool {
    !identity.is_empty() && !identity.contains(':')
}

/// A bare user id in the form [`canonical_user_of`] returns: ASCII-lowercased, so a roster's or a
/// push's user id compares with a leaf's user half as the binding compares them.
pub fn canonical_user_id(user_id: &str) -> String {
    user_id.to_ascii_lowercase()
}

/// THE ONE CANONICAL FORM OF A DEVICE IDENTITY: the user half ASCII-lowercased, the device half as
/// is, or `None` for an identity that is not well formed.
///
/// Every comparison of two identities and every key of the pin store goes through it - the binding
/// ([`identity_names`]), the pins, the lookups, the leaf a replace removes. Two spellings the
/// binding accepts as one device must be one device everywhere else too.
pub fn canonical_identity(identity: &str) -> Option<String> {
    if !is_well_formed_identity(identity) {
        return None;
    }
    let (user, device) = identity.split_once(':')?;
    Some(format!("{}:{device}", user.to_ascii_lowercase()))
}

/// Whether two identities are the same device under [`canonical_identity`].
fn same_identity(a: &str, b: &str) -> bool {
    matches!((canonical_identity(a), canonical_identity(b)), (Some(a), Some(b)) if a == b)
}

/// The most pinned identities kept before those absent from every held tree are dropped
/// ([`DeviceTrust::prune_absent`]). An identity and one key are ~120 bytes of the sealed state.
pub const MAX_PINNED_IDENTITIES: usize = 8192;

/// Whether `identity` is `userId:deviceId` with exactly one separator and two non-empty halves.
///
/// Both halves come from the server when a KeyPackage is fetched, so a second ':' would let one
/// split disagree with another (the TypeScript parsers split on the first and on the last). No id
/// this product mints contains one (`web-`/`tauri-` + random, and a user id that is 64-hex in
/// practice and ASCII without ':' by construction - core-service `users/user-id.ts`).
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
/// 64-hex in practice and ASCII without ':' by construction (core-service `users/user-id.ts`), so
/// ASCII folding is all the folding they can need, and both halves of the comparison come from
/// different places (the credential was minted
/// from the token's subject, the expectation from a roster): a case difference names the same
/// account and must not refuse it.
pub fn identity_names(found: &str, expected: &str) -> bool {
    same_identity(found, expected)
}

/// Whether two identities name the same USER (the user half, ignoring ASCII case, as
/// [`identity_names`] compares it).
fn same_user(a: &str, b: &str) -> bool {
    let user = |s: &str| s.split_once(':').map_or(s, |(u, _)| u).to_string();
    user(a).eq_ignore_ascii_case(&user(b))
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
    pub(crate) fn from_persisted(
        pins: Vec<PersistedPin>,
        pruned: Vec<String>,
        events: Vec<DeviceEvent>,
        departures: Vec<Departure>,
    ) -> Self {
        // EVERY PIN THIS CODE WRITES IS KEYED CANONICALLY ([`Self::insert_pin`]), and no released
        // build wrote pins before that. A record under any other key is therefore not a pin of this
        // code and is NOT merged into one: merging two records would turn a key conflict between
        // them into trust. No lookup could reach it, so it is dropped, loudly.
        let mut loaded: HashMap<String, Pin> = HashMap::new();
        for p in pins {
            if canonical_identity(&p.identity).as_deref() != Some(p.identity.as_str()) {
                // ERROR, not WARN: no code wrote this record, so the sealed state is inconsistent.
                log::error!(
                    "[TRUST] a persisted pin is not keyed by a canonical identity ({}) - dropped",
                    p.identity
                );
                continue;
            }
            loaded.insert(
                p.identity,
                Pin {
                    keys: p.keys,
                    anchored: p.anchored,
                    reaffirmations: p.reaffirmations,
                },
            );
        }
        let pruned: VecDeque<String> = pruned
            .into_iter()
            .filter(|p| {
                let canonical = canonical_identity(p).as_deref() == Some(p.as_str());
                if !canonical {
                    log::error!(
                        "[TRUST] a pruned record is not a canonical identity ({p}) - dropped"
                    );
                }
                canonical
            })
            .collect();
        Self {
            pins: loaded,
            pruned,
            events: events.into_iter().collect(),
            full_reported: false,
            departures: departures.into_iter().collect(),
            departures_full_reported: false,
            unseeded: Default::default(),
        }
    }

    /// Records that the load did not seed `group_id` (a commit was staged in it).
    pub(crate) fn mark_unseeded(&mut self, group_id: &str) {
        self.unseeded.insert(group_id.to_string());
    }

    /// Forgets that `group_id` was left unseeded: its staged commit was refused or the group went.
    ///
    /// @returns whether it was.
    pub(crate) fn forget_unseeded(&mut self, group_id: &str) -> bool {
        self.unseeded.remove(group_id)
    }

    /// The departures, oldest first, as they are persisted.
    pub(crate) fn persisted_departures(&self) -> Vec<Departure> {
        self.departures.iter().cloned().collect()
    }

    /// The epochs at which this device saw `user_id` leave `group_id`'s tree, oldest first.
    pub fn removal_epochs(&self, group_id: &str, user_id: &str) -> Vec<u64> {
        let user = user_id.to_ascii_lowercase();
        let mut epochs: Vec<u64> = self
            .departures
            .iter()
            .filter(|d| {
                d.group_id == group_id
                    && d.user_id == user
                    && (d.device_id.is_none() || d.user_left)
            })
            .map(|d| d.epoch)
            .collect();
        // Two devices of one user removed by one commit are two records of one departure.
        epochs.dedup();
        epochs
    }

    /// Whether this device saw `identity`'s leaf leave `group_id`'s tree in a merged commit.
    pub fn device_left_group(&self, group_id: &str, identity: &str) -> bool {
        let Some((user, device)) = canonical_identity(identity).and_then(|c| {
            c.split_once(':')
                .map(|(u, d)| (u.to_string(), d.to_string()))
        }) else {
            return false;
        };
        self.departures.iter().any(|d| {
            d.group_id == group_id && d.user_id == user && d.device_id.as_deref() == Some(&device)
        })
    }

    /// Drops the departures of groups not in `held_groups`, only when past
    /// [`MAX_RECORDED_DEPARTURES`] - the same rule as the pins.
    pub(crate) fn prune_departures(
        &mut self,
        held_groups: &std::collections::HashSet<&str>,
    ) -> usize {
        if self.departures.len() <= MAX_RECORDED_DEPARTURES {
            return 0;
        }
        let before = self.departures.len();
        self.departures
            .retain(|d| held_groups.contains(d.group_id.as_str()));
        let dropped = before - self.departures.len();
        log::info!(
            "[TRUST] {dropped} departure(s) of groups this device no longer holds dropped \
             ({} kept, bound {MAX_RECORDED_DEPARTURES})",
            self.departures.len()
        );
        dropped
    }

    fn push_departure(&mut self, departure: Departure) {
        if self.departures.len() >= MAX_RECORDED_DEPARTURES
            && let Some(dropped) = self.departures.pop_front()
            && !self.departures_full_reported
        {
            self.departures_full_reported = true;
            log::warn!(
                "[TRUST] {MAX_RECORDED_DEPARTURES} departures recorded - the oldest are dropped from \
                 now on (first: {} from {} at epoch {})",
                dropped.user_id,
                dropped.group_id,
                dropped.epoch
            );
        }
        self.departures.push_back(departure);
    }

    /// Records every user whose LAST leaf a merged commit removed: present in `before`, absent from
    /// `after`. Compared per USER, over the trees, so a heal that swaps a device's leaf in one commit
    /// (an external rejoin, a remove-and-add) or the removal of one device among several records
    /// nothing. Never an event: nothing user-visible comes of it.
    ///
    /// @returns whether anything was written.
    fn record_departures(
        &mut self,
        group_id: &str,
        epoch: u64,
        before: &[LeafKey],
        after: &[LeafKey],
    ) -> bool {
        let remaining: std::collections::HashSet<String> = after
            .iter()
            .filter_map(|(_, id, _)| canonical_user_of(id))
            .collect();
        let mut gone: Vec<String> = before
            .iter()
            .filter_map(|(_, id, _)| canonical_user_of(id))
            .filter(|u| !remaining.contains(u))
            .collect();
        gone.sort();
        gone.dedup();
        for user_id in &gone {
            log::info!(
                "[TRUST] {group_id} epoch {epoch}: {user_id} left the tree (last leaf removed)"
            );
        }
        // EVERY DEVICE whose leaf went, its user staying or not: the record that tells a device
        // coming back by its own commit from one that was never here ([`DeviceEvent::first_in_group`]).
        let mut devices_gone: Vec<(String, String)> = before
            .iter()
            .filter(|(_, id, _)| !after.iter().any(|(_, a, _)| same_identity(a, id)))
            .filter_map(|(_, id, _)| canonical_identity(id))
            .filter_map(|id| {
                id.split_once(':')
                    .map(|(u, d)| (u.to_string(), d.to_string()))
            })
            .collect();
        devices_gone.sort();
        devices_gone.dedup();
        for (user_id, device_id) in &devices_gone {
            self.push_departure(Departure {
                group_id: group_id.to_string(),
                user_id: user_id.clone(),
                epoch,
                device_id: Some(device_id.clone()),
                user_left: gone.contains(user_id),
            });
        }
        // A user whose leaves name no device still left: the user-level record alone.
        for user_id in gone
            .iter()
            .filter(|u| !devices_gone.iter().any(|(du, _)| du == *u))
        {
            self.push_departure(Departure {
                group_id: group_id.to_string(),
                user_id: user_id.clone(),
                epoch,
                device_id: None,
                user_left: false,
            });
        }
        !gone.is_empty() || !devices_gone.is_empty()
    }

    /// The persisted form of the pins, sorted so two saves of one record are byte-identical.
    pub(crate) fn persisted_pins(&self) -> Vec<PersistedPin> {
        let mut out: Vec<PersistedPin> = self
            .pins
            .iter()
            .map(|(identity, pin)| PersistedPin {
                identity: identity.clone(),
                keys: pin.keys.clone(),
                anchored: pin.anchored,
                reaffirmations: pin.reaffirmations,
            })
            .collect();
        out.sort_by(|a, b| a.identity.cmp(&b.identity));
        out
    }

    /// The pruned identities, oldest first, as they are persisted.
    pub(crate) fn persisted_pruned(&self) -> Vec<String> {
        self.pruned.iter().cloned().collect()
    }

    /// Writes a NEW pin for `identity`: anchored unless its previous pin was pruned.
    fn insert_pin(&mut self, identity: &str, keys: Vec<Vec<u8>>) {
        let Some(identity) = canonical_identity(identity) else {
            log::warn!("[TRUST] {identity} names no device - nothing pinned");
            return;
        };
        let identity = identity.as_str();
        let anchored = match self.pruned.iter().position(|p| p == identity) {
            Some(at) => {
                self.pruned.remove(at);
                log::warn!(
                    "[TRUST] {identity} pinned again after its pin was pruned - UNANCHORED: a \
                     contradiction with it is unverified, never forged"
                );
                false
            }
            None => true,
        };
        self.pins.insert(
            identity.to_string(),
            Pin {
                keys,
                anchored,
                reaffirmations: 0,
            },
        );
    }

    /// Counts one proof that `identity` holds a pinned key `key` (see [`Pin::reaffirmations`]).
    fn reaffirm(&mut self, identity: &str, key: &[u8]) -> bool {
        let Some(identity) = canonical_identity(identity) else {
            return false;
        };
        match self.pins.get_mut(&identity) {
            Some(pin) if pin.keys.iter().any(|k| k.as_slice() == key) => {
                pin.reaffirmations += 1;
                true
            }
            _ => false,
        }
    }

    /// The pending events, oldest first.
    pub(crate) fn persisted_events(&self) -> Vec<DeviceEvent> {
        self.events.iter().cloned().collect()
    }

    /// How `key` relates to what is pinned for `identity`, WITHOUT pinning anything.
    pub fn verdict(&self, identity: &str, key: &[u8]) -> LeafTrust {
        match self.pin_of(identity) {
            None => LeafTrust::FirstSight,
            Some(pin) if pin.keys.iter().any(|k| k.as_slice() == key) => LeafTrust::Pinned,
            Some(_) => LeafTrust::KeyChanged,
        }
    }

    /// The pin of `identity` under its [`canonical_identity`] - the ONE lookup every reader uses.
    fn pin_of(&self, identity: &str) -> Option<&Pin> {
        canonical_identity(identity).and_then(|id| self.pins.get(&id))
    }

    /// The keys pinned for `identity`, if any.
    pub fn pinned_keys(&self, identity: &str) -> Option<&[Vec<u8>]> {
        self.pin_of(identity).map(|pin| pin.keys.as_slice())
    }

    /// The pin of the device `expected` names, or `None` when no pin names it or `expected` is not a
    /// well-formed identity. Any spelling the binding accepts finds the one canonical pin.
    pub fn pin_naming(&self, expected: &str) -> Option<PinView> {
        self.pin_of(expected).map(|pin| PinView {
            keys: pin.keys.clone(),
            anchored: pin.anchored,
            reaffirmations: pin.reaffirmations,
        })
    }

    /// Records a leaf seen in a signed tree: pins it on first sight, never moves an existing pin.
    ///
    /// @returns how the key related to the pin BEFORE this call, and whether anything was written.
    fn observe(&mut self, identity: &str, key: &[u8]) -> (LeafTrust, bool) {
        let trust = self.verdict(identity, key);
        if trust == LeafTrust::FirstSight {
            self.insert_pin(identity, vec![key.to_vec()]);
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
    /// if it ever returns, but its new pin is UNANCHORED ([`Pin::anchored`]): the identity is
    /// remembered here, so a verifier never reads a contradiction with that new pin as a forgery.
    ///
    /// @returns how many pins were dropped.
    pub(crate) fn prune_absent(&mut self, held: &std::collections::HashSet<&str>) -> usize {
        if self.pins.len() <= MAX_PINNED_IDENTITIES {
            return 0;
        }
        let before = self.pins.len();
        let held: std::collections::HashSet<String> = held
            .iter()
            .filter_map(|id| canonical_identity(id))
            .collect();
        let mut gone: Vec<String> = self
            .pins
            .keys()
            .filter(|identity| !held.contains(identity.as_str()))
            .cloned()
            .collect();
        gone.sort();
        for identity in gone {
            self.pins.remove(&identity);
            self.pruned.push_back(identity);
        }
        while self.pruned.len() > MAX_REMEMBERED_PRUNED {
            self.pruned.pop_front();
        }
        let dropped = before - self.pins.len();
        // A REPORT, NOT A ROUTINE LINE: every dropped pin turns a later contradiction for that
        // device from "forged" into "unverified". WARN, with the numbers a reader needs; the count
        // also rides every load's state-composition line (`pin_summary`).
        log::warn!(
            "[TRUST] PINS PRUNED: {before} pinned identities passed the bound of \
             {MAX_PINNED_IDENTITIES}; dropped the {dropped} no held tree contains, {} kept, {} \
             pruned identities remembered - a pin written for one of them again is UNANCHORED",
            self.pins.len(),
            self.pruned.len()
        );
        dropped
    }

    /// `pins <n>, <m> pruned remembered` - the line every load's state composition carries.
    pub(crate) fn pin_summary(&self) -> String {
        format!(
            "pins {}, {} pruned remembered",
            self.pins.len(),
            self.pruned.len()
        )
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
        let mut fresh: HashMap<String, Vec<Vec<u8>>> = HashMap::new();
        for (_, identity, key) in leaves {
            let Some(identity) = canonical_identity(identity) else {
                continue;
            };
            if self.pins.contains_key(&identity) {
                continue;
            }
            let keys = fresh.entry(identity).or_default();
            if !keys.iter().any(|k| k == key) {
                keys.push(key.clone());
            }
        }
        let wrote = !fresh.is_empty();
        for (identity, keys) in fresh {
            self.insert_pin(&identity, keys);
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
        // Joining pins the whole tree below, which is everything a later seed would do.
        self.unseeded.remove(group_id);
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
                    // A joined tree has no "before": nothing here was added by a commit we merged.
                    first_in_group: false,
                    member_already_present: false,
                });
                wrote = true;
            } else if same_identity(identity, own_identity) && trust != LeafTrust::Pinned {
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
        // A GROUP THE LOAD LEFT UNSEEDED is seeded from the tree this commit was built on: a commit
        // merged on it - ours accepted by the server, or a member's - makes it a tree this device
        // accepted, the reason the load seeds every other held tree.
        let mut wrote = false;
        if self.unseeded.remove(group_id) {
            log::info!(
                "[TRUST] {group_id}: not seeded at load (a commit was staged) - seeding the tree a merged commit was built on"
            );
            wrote |= self.seed_from_tree(before);
        }
        wrote |= self.record_departures(group_id, epoch, before, after);
        // The committer signed this commit with the key its leaf carries: a proof it holds that key.
        if let Some(committer) = added_by
            && let Some((_, _, key)) = after.iter().find(|(_, id, _)| same_identity(id, committer))
        {
            wrote |= self.reaffirm(committer, key);
        }
        for (_, identity, key) in after {
            let existed = before
                .iter()
                .any(|(_, id, k)| same_identity(id, identity) && k == key);
            if existed {
                continue;
            }
            // PER GROUP, NEVER FROM THE PIN: no leaf of this device in the tree the commit was built
            // on, and no departure of it recorded here. A pin is one store any group's tree writes.
            let first_in_group = !before.iter().any(|(_, id, _)| same_identity(id, identity))
                && !self.device_left_group(group_id, identity);
            // This device's own leaf entering its own group (an external join it made) is not a
            // device being added to anybody's conversation.
            if same_identity(identity, own.0) && key.as_slice() == own.1 {
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
                LeafTrust::Pinned
                    if !(first_in_group
                        && added_by.is_some_and(|c| same_identity(c, identity))
                        && before.iter().any(|(_, id, _)| same_user(id, identity))) =>
                {
                    // A package under the pinned key reached somebody: the device still holds it.
                    wrote |= self.reaffirm(identity, key);
                    log::debug!(
                        "[TRUST] {group_id} epoch {epoch}: {identity} re-entered under its pinned key \
                         (added by {}) - the same device, nothing recorded",
                        added_by.unwrap_or("an unreadable sender")
                    );
                    continue;
                }
                LeafTrust::Pinned => log::error!(
                    "[TRUST] {group_id} epoch {epoch}: {identity} entered by its OWN commit under a key                      pinned elsewhere, never in this group - the pin vouches for nothing here, recorded"
                ),
                LeafTrust::FirstSight => log::info!(
                    "[TRUST] {group_id} epoch {epoch}: {identity} added by {} (key {fingerprint}, first sight)",
                    added_by.unwrap_or("an unreadable sender"),
                ),
            }
            let member_already_present = before.iter().any(|(_, id, _)| same_user(id, identity));
            self.push_event(DeviceEvent {
                group_id: group_id.to_string(),
                epoch,
                identity: identity.clone(),
                key_fingerprint: fingerprint,
                trust,
                added_by: added_by.map(str::to_string),
                first_in_group,
                member_already_present,
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

    fn lk(index: u32, identity: &str, key: u8) -> LeafKey {
        (index, identity.to_string(), vec![key; 32])
    }

    #[test]
    fn a_device_pinned_in_another_group_entering_this_one_by_itself_is_unvouched_here() {
        // The pin store is ONE store: a tree of group A writes the pin, and it must vouch for
        // nothing in group B, where the device was never a leaf (review of #2594, 2026-10-27).
        let mut t = DeviceTrust::default();
        let own = ("alice:phone-a", &[1u8; 32][..]);
        // Group A: bob's second device enters (first sight, pinned now).
        let a_before = vec![lk(0, "alice:phone-a", 1), lk(1, "bob:phone-1", 2)];
        let mut a_after = a_before.clone();
        a_after.push(lk(2, "bob:web-2", 3));
        t.observe_merged_commit("gA", 4, &a_before, &a_after, Some("bob:phone-1"), own);
        t.take_events();
        // Group B: the same device, same key, brings ITSELF in.
        let b_before = vec![lk(0, "alice:phone-a", 1), lk(1, "bob:phone-1", 2)];
        let mut b_after = b_before.clone();
        b_after.push(lk(2, "bob:web-2", 3));
        t.observe_merged_commit("gB", 9, &b_before, &b_after, Some("bob:web-2"), own);
        let events = t.take_events();
        assert_eq!(
            events.len(),
            1,
            "the pinned key does not silence a first entry here"
        );
        let e = &events[0];
        assert_eq!(e.trust, LeafTrust::Pinned);
        assert!(e.first_in_group);
        assert!(e.enters_as_unvouched_device());
        assert!(e.announces_new_device());
    }

    #[test]
    fn a_device_that_left_this_group_and_comes_back_by_itself_is_not_unvouched() {
        let mut t = DeviceTrust::default();
        let own = ("alice:phone-a", &[1u8; 32][..]);
        let full = vec![
            lk(0, "alice:phone-a", 1),
            lk(1, "bob:phone-1", 2),
            lk(2, "bob:web-2", 3),
        ];
        let without = vec![lk(0, "alice:phone-a", 1), lk(1, "bob:phone-1", 2)];
        t.seed_from_tree(&full);
        // A member's commit removes bob's web device; bob stays.
        t.observe_merged_commit("g", 5, &full, &without, Some("alice:phone-a"), own);
        assert!(t.device_left_group("g", "BOB:web-2"));
        assert!(!t.device_left_group("g", "bob:phone-1"));
        assert!(
            t.removal_epochs("g", "bob").is_empty(),
            "bob never left as a user"
        );
        t.take_events();
        // It comes back by its own commit, under its pinned key: the same device, nothing to say.
        t.observe_merged_commit("g", 6, &without, &full, Some("bob:web-2"), own);
        assert!(t.take_events().is_empty());
    }

    #[test]
    fn a_member_added_device_is_never_an_unvouched_entry() {
        let mut t = DeviceTrust::default();
        let own = ("alice:phone-a", &[1u8; 32][..]);
        let before = vec![lk(0, "alice:phone-a", 1), lk(1, "bob:phone-1", 2)];
        let mut after = before.clone();
        after.push(lk(2, "bob:web-2", 3));
        t.observe_merged_commit("g", 3, &before, &after, Some("alice:phone-a"), own);
        let events = t.take_events();
        assert_eq!(events.len(), 1);
        assert!(events[0].first_in_group);
        assert!(!events[0].enters_as_unvouched_device());
    }

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
            first_in_group: false,
            member_already_present: false,
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
    fn a_pin_written_after_its_identity_was_pruned_is_unanchored_and_persists_so() {
        let mut t = DeviceTrust::default();
        for i in 0..=MAX_PINNED_IDENTITIES {
            t.observe(&format!("u{i}:d"), b"k");
        }
        assert!(t.pin_naming("u5:d").unwrap().anchored);
        let held: std::collections::HashSet<&str> = ["u0:d"].into_iter().collect();
        t.prune_absent(&held);
        assert!(t.pin_naming("u5:d").is_none());

        // u5 comes back under whatever key the next tree carries.
        t.seed_from_tree(&[(0, "u5:d".into(), b"other".to_vec())]);
        let pin = t.pin_naming("U5:d").unwrap();
        assert!(!pin.anchored, "re-seeded after a prune");
        assert_eq!(pin.keys, vec![b"other".to_vec()]);
        assert!(
            t.pin_naming("u0:d").unwrap().anchored,
            "a kept pin stays anchored"
        );
        // A never-pruned first sight is anchored; the flag survives persistence.
        t.observe("new:d", b"k");
        assert!(t.pin_naming("new:d").unwrap().anchored);
        let again =
            DeviceTrust::from_persisted(t.persisted_pins(), t.persisted_pruned(), vec![], vec![]);
        assert!(!again.pin_naming("u5:d").unwrap().anchored);
        assert!(
            again.pruned.contains(&"u6:d".to_string()),
            "the pruned identities persist"
        );
    }

    #[test]
    fn departures_are_bounded_and_past_the_bound_keep_only_held_groups() {
        let mut t = DeviceTrust::default();
        let leaf = |id: &str| (0u32, id.to_string(), b"k".to_vec());
        // One departure per group: a tree with "u:d" that loses it.
        for i in 0..=MAX_RECORDED_DEPARTURES {
            t.record_departures(&format!("g{i}"), 1, &[leaf("u:d")], &[]);
        }
        assert_eq!(
            t.departures.len(),
            MAX_RECORDED_DEPARTURES,
            "the oldest went"
        );
        assert!(t.removal_epochs("g0", "u").is_empty());
        assert_eq!(t.removal_epochs("g1", "U"), vec![1]);
        assert!(t.events.is_empty(), "a departure is never an event");

        t.push_departure(Departure {
            group_id: "g-extra".into(),
            user_id: "u".into(),
            epoch: 2,
            device_id: None,
            user_left: false,
        });
        t.departures.push_back(Departure {
            group_id: "g1".into(),
            user_id: "v".into(),
            epoch: 3,
            device_id: None,
            user_left: false,
        });
        // The push dropped g1's (the oldest left); g2 is the group still held.
        assert!(t.removal_epochs("g1", "u").is_empty());
        let held: std::collections::HashSet<&str> = ["g2", "g1"].into_iter().collect();
        t.prune_departures(&held);
        assert_eq!(t.removal_epochs("g2", "u"), vec![1]);
        assert_eq!(t.removal_epochs("g1", "v"), vec![3]);
        assert_eq!(t.departures.len(), 2);
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
            first_in_group: true,
            member_already_present: true,
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"groupId":"g","epoch":4,"identity":"u:d","keyFingerprint":"00ff","trust":"key-changed","addedBy":"v:e","firstInGroup":true,"memberAlreadyPresent":true}"#
        );
    }

    /// The owner-alert half of the notice rule and the dedup key, held to the SAME table the
    /// TypeScript `deviceEventAudience` / `deviceEventKey` are (`deviceNotices.fixture.test.ts`):
    /// the background engines decide here, the app there, and the two must never disagree.
    #[test]
    fn the_owner_alert_and_the_notice_key_follow_the_shared_table() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            event: DeviceEvent,
            own_user_id: String,
            own_device_id: String,
            audience: String,
            key: Option<String>,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/device_notices.json"))
                .expect("fixture parses");
        assert!(cases.len() >= 12);
        for c in cases {
            assert_eq!(
                c.event.is_owner_alert(&c.own_user_id, &c.own_device_id),
                c.audience == "owner-alert",
                "{}",
                c.name
            );
            assert_eq!(c.event.notice_key(), c.key, "{}", c.name);
        }
    }

    /// The app computes a key's fingerprint itself (`keyFingerprintOf`) to find the server's date
    /// for the key an event names: the two computations are held to one table.
    #[test]
    fn the_key_fingerprint_follows_the_shared_table() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            key_hex: String,
            fingerprint: String,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/key_fingerprints.json"))
                .expect("fixture parses");
        assert!(!cases.is_empty());
        for c in cases {
            let key: Vec<u8> = (0..c.key_hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&c.key_hex[i..i + 2], 16).expect("hex"))
                .collect();
            assert_eq!(key_fingerprint(&key), c.fingerprint, "{}", c.key_hex);
        }
    }
}
