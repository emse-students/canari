use ciborium::{de::from_reader, ser::into_writer};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_traits::storage::StorageProvider;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::MlsError;

// --- 1. Persistence model (on disk) ---

/// The on-disk snapshot.
///
/// Every byte-buffer field goes through [`crate::byte_compat`], which writes a CBOR byte string
/// and reads EITHER a byte string or the legacy array of integers. Without that, serde's generic
/// `Vec<u8>` path parses one CBOR header per byte - 58.6 s of CPU on a 2.67 MB file, enough to ANR
/// the app from the boot receiver (WP-ANR-1). The read side of the pair is what lets an existing
/// install survive the change and MUST NOT be removed; see the module docs for the rollback
/// consequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedState {
    #[serde(with = "crate::byte_compat::bytes")]
    pub identity_bundle: Vec<u8>,
    #[serde(with = "crate::byte_compat::bytes_map")]
    pub storage_values: HashMap<Vec<u8>, Vec<u8>>,
    #[serde(with = "crate::byte_compat::bytes_vec")]
    pub group_ids: Vec<Vec<u8>>,
    /// Minimum epoch to accept per group after a forget_group() call.
    /// #[serde(default)] ensures compatibility with states saved before this field was added.
    #[serde(default)]
    pub forgotten_group_min_epochs: HashMap<String, u64>,
}

/// Borrowed view of [`PersistedState`] for CBOR encoding without cloning OpenMLS storage.
///
/// The field encodings must match [`PersistedState`] exactly - this is the WRITER of the same
/// bytes that struct reads, and nothing in the type system ties the two together.
#[derive(Serialize)]
pub(crate) struct PersistedStateSer<'a> {
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) identity_bundle: &'a [u8],
    #[serde(with = "crate::byte_compat::bytes_map")]
    pub(crate) storage_values: &'a HashMap<Vec<u8>, Vec<u8>>,
    #[serde(with = "crate::byte_compat::bytes_vec")]
    pub(crate) group_ids: &'a [Vec<u8>],
    pub(crate) forgotten_group_min_epochs: &'a HashMap<String, u64>,
}

// Struct request wrapper for serialization
#[derive(Serialize)]
pub(crate) struct IdentityBundleRef<'a> {
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) keypair: &'a [u8], // Serialized bytes
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) credential: &'a [u8], // Serialized bytes
}

#[derive(Serialize, Deserialize)]
pub(crate) struct IdentityBundle {
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) keypair: Vec<u8>,
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) credential: Vec<u8>,
}

// --- 2. Manager (in memory) ---

/// In-memory CBOR snapshot cache for `save_state` / `save_encrypted`.
/// Uses interior mutability so `generate_key_package` (`&self`) can invalidate it.
pub(crate) struct StateSnapshotCache {
    pub(crate) dirty: bool,
    pub(crate) cached_cbor: Option<Vec<u8>>,
}

impl StateSnapshotCache {
    pub(crate) fn new_dirty() -> Self {
        Self {
            dirty: true,
            cached_cbor: None,
        }
    }

    pub(crate) fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub(crate) fn get_or_build<F>(&mut self, build: F) -> Result<Vec<u8>, MlsError>
    where
        F: FnOnce() -> Result<Vec<u8>, MlsError>,
    {
        if !self.dirty
            && let Some(ref cached) = self.cached_cbor
        {
            log::debug!(
                "save_state: returning cached CBOR snapshot ({} bytes)",
                cached.len()
            );
            return Ok(cached.clone());
        }

        let bytes = build()?;
        log::debug!("save_state: rebuilt CBOR snapshot ({} bytes)", bytes.len());
        self.cached_cbor = Some(bytes.clone());
        self.dirty = false;
        Ok(bytes)
    }
}

pub struct MlsManager {
    // OpenMlsRustCrypto owns the MemoryStorage internally and implements OpenMlsProvider
    pub(crate) provider: OpenMlsRustCrypto,

    pub(crate) keypair: SignatureKeyPair,
    pub(crate) credential: BasicCredential,

    pub(crate) groups: HashMap<String, MlsGroup>,

    /// Minimum epoch required to accept a Welcome (per groupId).
    /// Set by forget_group to prevent a stale Welcome (from a device itself behind on epoch)
    /// from putting this device back on the wrong branch.
    pub(crate) forgotten_group_min_epochs: HashMap<String, u64>,

    pub(crate) state_snapshot: RefCell<StateSnapshotCache>,
}

/// Every label `openmls_memory_storage` prefixes its storage keys with.
///
/// A key is `label || serde_json(id) || u16 version`, built by that crate's `build_key_from_vec`,
/// so the label is a plain byte PREFIX and a scan can attribute every entry to exactly one owner.
/// Longest match wins when one label is a prefix of another - `Tree` must not swallow
/// `ApplicationExportTree`, and `Psk` must not swallow `ResumptionPsk`.
pub(crate) const STORAGE_LABELS: &[&str] = &[
    "KeyPackage",
    "EncryptionKeyPair",
    "SignatureKeyPair",
    "EpochKeyPairs",
    "Psk",
    "Tree",
    "GroupContext",
    "ApplicationExportTree",
    "InterimTranscriptHash",
    "ConfirmationTag",
    "MlsGroupJoinConfig",
    "OwnLeafNodes",
    "GroupState",
    "QueuedProposal",
    "ProposalQueueRefs",
    "OwnLeafNodeIndex",
    "EpochSecrets",
    "ResumptionPsk",
    "MessageSecrets",
];

/// Which [`STORAGE_LABELS`] prefix a raw storage key belongs to - longest match wins.
///
/// ONE COPY, because two callers ask different questions about the SAME rows: `state_composition`
/// counts them and `key_package_keys` names them. A label rule written twice is those two drifting
/// apart, and the second one deciding a reload is safe when the first would have said otherwise.
/// Longest-match matters: several labels share a prefix, and the shortest would swallow the rest.
fn storage_label(key: &[u8]) -> String {
    STORAGE_LABELS
        .iter()
        .filter(|l| key.starts_with(l.as_bytes()))
        .max_by_key(|l| l.len())
        .map(|l| (*l).to_string())
        .unwrap_or_else(|| "UNKNOWN".to_string())
}

/// One storage label's share of the state: how many entries, and how many bytes they occupy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoragePortion {
    pub label: String,
    pub entries: usize,
    pub bytes: usize,
}

/// WHAT THE STORED KEY PACKAGES ARE, which is the axis that decides what may be reclaimed.
///
/// [`MlsManager::state_composition`] says `KeyPackage 3050x7211906B` and stops there - two thirds
/// of a 10.7 MB state on a Mi 9T, 2026-09-09, against a pool the protocol sizes at FIFTY. A count
/// that large is not one fact, it is several stacked, and they do not have the same remedy:
///
/// - an EXPIRED bundle is already reclaimable and [`MlsManager::prune_key_packages_expired_at`]
///   takes it, so any of these still present are debt with time left to run;
/// - a LAST-RESORT bundle is superseded only by its owner. The server keeps exactly one and never
///   hands it out-and-deletes it, so every earlier one died by an action this device took and
///   nothing can be racing it;
/// - a ONE-TIME bundle absent from the server is ambiguous, and that ambiguity is the whole reason
///   the prune uses expiry alone: the delivery service DELETES the row as it hands it out, so
///   "the server no longer has it" means either "a peer is about to send a Welcome built on it" or
///   "its owner revoked it", and the two want opposite treatment.
///
/// `mint_instants` and `largest_batch` separate the last two from outside. A pool topped up
/// incrementally carries many instants; a pool purged and reminted wholesale carries one instant
/// per round, fifty bundles deep - the signature already measured server-side, where the harness
/// account's fifty prekeys all shared a single timestamp to the microsecond.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPackageCensus {
    /// Entries proven to be key packages. `last_resort + one_time`, and `undecodable` is beside it.
    pub total: usize,
    /// Bundles carrying the `LastResort` extension - the static fallback, one live at a time.
    pub last_resort: usize,
    /// Bundles without it - the one-time pool, which the protocol sizes at fifty.
    pub one_time: usize,
    /// Of `total`, how many have a `not_after` already elapsed at the instant asked about.
    pub expired: usize,
    /// Entries under a `KeyPackage` key this build could not prove were key packages. Never
    /// counted as either kind, and never deleted - see `for_each_proven_key_package`.
    pub undecodable: usize,
    /// How many DISTINCT `not_before` instants the bundles carry - one per mint round.
    pub mint_instants: usize,
    /// The most bundles sharing a single `not_before`. Fifty means a wholesale remint.
    pub largest_batch: usize,
}

/// What [`MlsManager::forget_key_packages`] did, split so a caller can tell three things apart.
///
/// A single count would conflate "the purge and the keystore agreed" with "this device never held
/// what the server just deleted for it" - and the second is the shape `reconcilePublishedKeyPackages`
/// exists to catch, arriving from the other direction. A sweep that reports clean while every entry
/// was `not_held` is a device whose keystore has diverged from what it published, which is worth
/// far more than the bytes this reclaimed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ForgetOutcome {
    /// Private bundles found and deleted.
    pub forgotten: usize,
    /// Payloads this device held no private bundle for - it had already lost or spent them.
    pub not_held: usize,
    /// Payloads that would not deserialise, validate, or hash. Never deleted, always counted.
    pub unreadable: usize,
}

impl MlsManager {
    /// What this device's persisted state is MADE OF, heaviest first.
    ///
    /// ## Why this exists, and why it is product code rather than a test helper
    ///
    /// `mls.bin` has been a P1 twice - a phone reached 20 812 360 bytes with a checkpoint costing
    /// 48 s and a PIN unlock 22 s - and BOTH investigations were slowed by the same gap: nothing
    /// could ask a device what its state was made of. The composition had to be inferred from
    /// synthetic states and arithmetic, and on 2026-09-06 that inference was wrong twice in one
    /// evening. A 12.8 MB drop was then attributed to abandoned groups on the strength of a
    /// division, while a bounded per-epoch cost measured minutes later refuted the mechanism that
    /// division implied.
    ///
    /// A number nobody can read off the running system is a number that gets guessed. This makes it
    /// readable: it is the same scan `prune_expired_key_packages` uses, over the same map, exposed
    /// rather than reimplemented - `tests/state_weight.rs` calls THIS instead of carrying its own
    /// copy of the label list, so the measurement and the product can never disagree.
    ///
    /// Bytes are `key.len() + value.len()`, which is the entry's weight in the map rather than in
    /// the CBOR that wraps it - close enough to attribute a megabyte, and it needs no serialisation.
    pub fn state_composition(&self) -> Result<Vec<StoragePortion>, MlsError> {
        let storage = self.provider.storage();
        let values = storage
            .values
            .read()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;

        let mut by_label: HashMap<String, StoragePortion> = HashMap::new();
        for (k, v) in values.iter() {
            let label = storage_label(k);
            let e = by_label.entry(label.clone()).or_insert(StoragePortion {
                label,
                entries: 0,
                bytes: 0,
            });
            e.entries += 1;
            e.bytes += k.len() + v.len();
        }

        let mut rows: Vec<StoragePortion> = by_label.into_values().collect();
        // Heaviest first, then by label so the order is stable for a reader comparing two runs.
        rows.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.label.cmp(&b.label)));
        Ok(rows)
    }

    /// One compact line naming the three heaviest parts of the state, for the load-time log.
    ///
    /// THREE, not all nineteen: a line nobody reads to the end is a line that hides the next defect,
    /// and every composition measured so far has had one part carrying most of the weight. The total
    /// is always printed, so a reader can see at once whether the three explain it.
    pub fn state_composition_summary(&self) -> String {
        match self.state_composition() {
            Ok(rows) => {
                let total: usize = rows.iter().map(|r| r.bytes).sum();
                let head = rows
                    .iter()
                    .take(3)
                    .map(|r| format!("{} {}x{}B", r.label, r.entries, r.bytes))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{total}B total; {head}")
            }
            // NOT SWALLOWED INTO AN EMPTY STRING: a caller logging this would print a line that
            // reads as "the state is made of nothing", which is a worse answer than none.
            Err(e) => format!("unavailable ({e})"),
        }
    }

    /// How many key package bundles this keystore holds - THE AXIS THE RELOAD GUARD CANNOT SEE.
    ///
    /// [`Self::reload_is_monotonic`] compares GROUP EPOCHS and nothing else, and the native foreground
    /// resume replaces the live manager on that evidence alone. Key material is not a group epoch, so
    /// a snapshot predating a mint passes that guard unchanged and installs a keystore missing the
    /// bundles the device published seconds earlier. `key_package_has_private` then answers `false`
    /// about this device's own fresh mints, which is exactly the observation
    /// `reconcilePublishedKeyPackages` reads as "the server holds an orphan" before purging the pool.
    ///
    /// A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER. This one exists so the
    /// second axis can be STATED at that boundary rather than assumed, and it deliberately reuses
    /// [`Self::state_composition`]'s scan rather than carrying a second copy of the label rule.
    ///
    /// @returns the number of `KeyPackage` entries, or the storage error that prevented counting
    pub fn key_package_count(&self) -> Result<usize, MlsError> {
        Ok(self
            .state_composition()?
            .into_iter()
            .find(|r| r.label == "KeyPackage")
            .map_or(0, |r| r.entries))
    }

    /// WHICH key package bundles this keystore holds - the axis a COUNT cannot answer.
    ///
    /// [`Self::key_package_count`] says HOW MANY, and the resume guard in `recharger_mls_au_resume`
    /// compared cardinalities: a candidate holding FEWER than the live manager was accused, and one
    /// holding the same number was waved through. Measured on the Mi 9T on 2026-09-08, and it is why
    /// this exists: `REFUSED to purge 6/50 prekey(s) this session published itself` - six of the
    /// device's own fresh mints unbacked by the installed keystore - while
    /// `[RESUME] reload DROPS KEY MATERIAL` did not print once. A reload that drops six bundles and a
    /// mint that adds six leave the cardinality untouched, so the detector written for exactly this
    /// loss was blind to the shape it took.
    ///
    /// A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER, and "how many" is not
    /// "which ones". These are the identities, so a caller can name the bundles a reload would LOSE
    /// instead of inferring a loss from a smaller number - and a substitution, which is what the
    /// hardware actually showed, stops being invisible.
    ///
    /// @returns the raw storage keys of every `KeyPackage` entry, or the error that prevented reading
    pub fn key_package_keys(&self) -> Result<BTreeSet<Vec<u8>>, MlsError> {
        let storage = self.provider.storage();
        let values = storage
            .values
            .read()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;
        Ok(values
            .keys()
            .filter(|k| storage_label(k) == "KeyPackage")
            .cloned()
            .collect())
    }

    /// Visits every storage entry this build can PROVE is the key package its own key names.
    ///
    /// ONE COPY, for the same reason [`storage_label`] is one copy, and with more at stake. Two
    /// callers ask different questions of the same rows - [`Self::prune_key_packages_expired_at`]
    /// DELETES from this set and [`Self::key_package_census_at`] DESCRIBES it - and a proof written
    /// twice is those two disagreeing about what a key package is, with the delete on the wrong
    /// side of the disagreement. The census exists to decide what may be reclaimed; it must be
    /// counting the exact rows the prune can reach, or its numbers argue for a delete that lands
    /// somewhere else.
    ///
    /// The proof itself is unchanged and is described where it was written: the prefix and the
    /// decode both LOOK like discrimination and neither is, because serde ignores unknown fields,
    /// so the stored key must be shown to contain the recomputed hash reference. The key is
    /// `label || json(hash_ref) || version` by construction, which makes the containment exact.
    ///
    /// @returns how many entries under a `KeyPackage` key could NOT be proven - never visited,
    ///          never deleted, and counted so a reader sees that this build did not understand them
    fn for_each_proven_key_package<F>(
        &self,
        values: &HashMap<Vec<u8>, Vec<u8>>,
        mut visit: F,
    ) -> usize
    where
        F: FnMut(&[u8], &KeyPackageBundle),
    {
        let mut undecodable = 0usize;
        for (k, v) in values.iter() {
            if !k.starts_with(b"KeyPackage") {
                continue;
            }
            let Ok(bundle) = serde_json::from_slice::<KeyPackageBundle>(v) else {
                undecodable += 1;
                continue;
            };
            let Ok(hash_ref) = bundle.key_package().hash_ref(self.provider.crypto()) else {
                undecodable += 1;
                continue;
            };
            let Ok(named) = serde_json::to_vec(&hash_ref) else {
                undecodable += 1;
                continue;
            };
            if !k.windows(named.len()).any(|w| w == named.as_slice()) {
                undecodable += 1;
                continue;
            }
            visit(k, &bundle);
        }
        undecodable
    }

    /// [`KeyPackageCensus`] for this keystore, at the instant given.
    ///
    /// THE CLOCK IS A PARAMETER FOR THE REASON [`Self::prune_key_packages_expired_at`] TAKES ONE,
    /// and it matters more here: this number is meant to be compared against what the prune WILL
    /// take, and a census that read its own clock could not be asked "what will be reclaimable in
    /// a hundred days" - which is the question the 84-day bound makes a reader ask first.
    ///
    /// Reads only. Nothing here deletes, and nothing here may: the census is the evidence a reclaim
    /// is argued from, and a measurement that mutates its subject cannot be that.
    pub fn key_package_census_at(&self, now_secs: u64) -> Result<KeyPackageCensus, MlsError> {
        let storage = self.provider.storage();
        let values = storage
            .values
            .read()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;

        let mut total = 0usize;
        let mut last_resort = 0usize;
        let mut expired = 0usize;
        // A count per `not_before`, which is what tells a wholesale remint from an incremental
        // top-up without asking the server anything.
        let mut by_instant: HashMap<u64, usize> = HashMap::new();

        let undecodable = self.for_each_proven_key_package(&values, |_k, bundle| {
            let kp = bundle.key_package();
            total += 1;
            if kp.extensions().contains(ExtensionType::LastResort) {
                last_resort += 1;
            }
            if kp.life_time().not_after() < now_secs {
                expired += 1;
            }
            *by_instant.entry(kp.life_time().not_before()).or_insert(0) += 1;
        });

        Ok(KeyPackageCensus {
            total,
            last_resort,
            one_time: total - last_resort,
            expired,
            undecodable,
            mint_instants: by_instant.len(),
            largest_batch: by_instant.values().copied().max().unwrap_or(0),
        })
    }

    /// [`Self::key_package_census_at`] with the clock read rather than given.
    ///
    /// **NOT COMPILED FOR wasm32**, for the reason [`Self::prune_expired_key_packages`] is not:
    /// `std`'s clock is unimplemented there and PANICS rather than erroring, which took down every
    /// web login in v0.16.4. A target that cannot read a clock must not be offered a function that
    /// reads one - callers on wasm have a clock of their own and pass it to the `_at` form.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn key_package_census(&self) -> Result<KeyPackageCensus, MlsError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .map_err(|e| {
                MlsError::OpenMls(format!("System clock is before the UNIX epoch: {e}"))
            })?;
        self.key_package_census_at(now)
    }

    /// One compact line for the load-time log, beside the composition summary.
    ///
    /// The composition line already prints `KeyPackage 3050x7211906B`, and that is the number that
    /// sent two investigations looking for a mechanism. This says which of them it could be.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn key_package_census_summary(&self) -> String {
        match self.key_package_census() {
            Ok(c) => format!(
                "{} proven ({} one-time, {} last-resort); {} expired, {} undecodable; \
                 {} mint instant(s), largest batch {}",
                c.total,
                c.one_time,
                c.last_resort,
                c.expired,
                c.undecodable,
                c.mint_instants,
                c.largest_batch
            ),
            // NOT SWALLOWED INTO AN EMPTY STRING, for the reason `state_composition_summary` says:
            // a line reading as "there are no key packages" is a worse answer than none.
            Err(e) => format!("unavailable ({e})"),
        }
    }

    /// Marks the CBOR snapshot stale after any MLS state mutation.
    ///
    /// INVARIANT: every method that mutates `self.provider` storage, `self.groups`,
    /// `self.keypair`, or `forgotten_group_min_epochs` MUST call this (or invalidate the
    /// snapshot directly, as `process_incoming_on_group` does). Forgetting it makes
    /// `save_state` persist a stale snapshot - silent state loss / ratchet desync.
    /// Over-invalidating only costs a rebuild and is always safe.
    pub(crate) fn mark_state_dirty(&self) {
        self.state_snapshot.borrow_mut().invalidate();
    }

    /// Invalidates the in-memory CBOR snapshot so the next [`Self::save_state`] rebuilds it.
    /// Exposed for benchmarks and integration tests measuring cold serialization cost.
    pub fn invalidate_persisted_snapshot(&self) {
        self.mark_state_dirty();
    }
    // --- A. INITIALIZATION (Load or Create) ---

    pub fn load_or_create(
        user_id: &str,
        device_id: &str,
        decrypted_state: Option<Vec<u8>>,
    ) -> Result<Self, MlsError> {
        let provider = OpenMlsRustCrypto::default();

        if let Some(state_bytes) = decrypted_state {
            // CAS 1 : Restauration
            let state: PersistedState = from_reader(state_bytes.as_slice())
                .map_err(|e| MlsError::Serialization(e.to_string()))?;

            let bundle: IdentityBundle = from_reader(state.identity_bundle.as_slice())
                .map_err(|e| MlsError::Serialization(e.to_string()))?;

            // Deserialize keypair & credential from bytes
            let keypair = SignatureKeyPair::tls_deserialize(&mut bundle.keypair.as_slice())
                .map_err(|_| MlsError::Serialization("Failed to deserialize keypair".into()))?;

            let credential_enum = Credential::tls_deserialize(&mut bundle.credential.as_slice())
                .map_err(|_| MlsError::Serialization("Failed to deserialize credential".into()))?;

            let credential =
                BasicCredential::try_from(credential_enum).map_err(|_| MlsError::InvalidData)?;

            // Verify that the credential identity matches the expected identity.
            // A corrupted or tampered state could contain a credential for a different user/device.
            let expected_identity = format!("{}:{}", user_id, device_id);
            let loaded_identity = String::from_utf8_lossy(credential.identity()).to_string();
            if loaded_identity != expected_identity {
                log::warn!(
                    "load_or_create: identity mismatch - expected={} loaded={}",
                    expected_identity,
                    loaded_identity
                );
                return Err(MlsError::StateIdentityMismatch(format!(
                    "expected {} but state contains {}",
                    expected_identity, loaded_identity
                )));
            }

            // 2. Restore in-memory storage
            {
                let storage = provider.storage();
                let mut lock = storage.values.write().unwrap();
                *lock = state.storage_values;
            }

            // 3. Restore the groups
            let mut groups = HashMap::new();
            for gid_bytes in state.group_ids {
                let group_id = GroupId::from_slice(&gid_bytes);

                // Load using the provider
                if let Some(group) = MlsGroup::load(provider.storage(), &group_id)
                    .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?
                {
                    let group_id_str = String::from_utf8_lossy(&gid_bytes).to_string();
                    groups.insert(group_id_str, group);
                }
            }

            let manager = Self {
                provider,
                keypair,
                credential,
                groups,
                forgotten_group_min_epochs: state.forgotten_group_min_epochs,
                // Deliberately NOT `from_loaded(state_bytes)`, which would hand the bytes we just
                // read straight back to the first `save_state`. That is a sound optimisation while
                // the encoding is fixed, and exactly wrong across a format change: a device
                // carrying a legacy `mls.bin` would re-persist it verbatim and keep paying the
                // per-byte decode for ever, migrating only if some mutation happened to dirty the
                // cache first. Rebuilding once per session makes the migration deterministic
                // instead of dependent on what the user does next, and the cost is one
                // serialization - never the decode this change exists to remove.
                state_snapshot: RefCell::new(StateSnapshotCache::new_dirty()),
            };

            // SHED WHAT THIS DEVICE CAN NO LONGER USE, ONCE PER LOAD.
            //
            // Nothing else ever deletes a key package bundle, and two callers mint them without
            // bound - a fresh last-resort package on every connection, and up to 50 more per
            // `republishKeyMaterial`. See `prune_expired_key_packages` for the measurement and for
            // why an elapsed lifetime is the only signal that cannot race a join.
            //
            // HERE rather than on a timer: a load is the one moment that happens exactly once per
            // session, needs no scheduling, and already has the whole state in hand. A clock would
            // add a second path to the same state for no gain, and the rule this repository keeps
            // is that termination comes from a proof and never from a timer.
            //
            // A FAILURE HERE MUST NOT FAIL THE LOAD. Pruning is maintenance: a device that cannot
            // shed old bundles still works, where a device that refuses to load has lost
            // everything. It is logged at a level that accuses, because a prune that never succeeds
            // is the leak coming back and nothing else would say so.
            // AND NOT ON THE WEB, BECAUSE THE GUARD ABOVE CANNOT HOLD THERE. This crate compiles to
            // `wasm32-unknown-unknown`, where `std::time::SystemTime::now()` is not implemented and
            // does not return an error - it PANICS. A panic is not an `Err`, so the `match` below
            // never saw it: `load_or_create` unwound, MLS init failed for every web user on every
            // login, and the login path reported it as `auth_pin_mismatch` - a correct PIN refused,
            // account-wide, in v0.16.4. The clock is a parameter on the function that does the work
            // for exactly this reason; the convenience wrapper that reads a clock is the part that
            // has no business in a crate targeting wasm.
            //
            // Native only is not a compromise here: the 2 338 accumulated bundles that motivated
            // this were measured on a handset, and a browser profile does not live long enough to
            // reach the horizon. When the web needs it, the caller passes `Date.now()/1000` to
            // `prune_key_packages_expired_at` - no clock inside this crate, on any target.
            #[cfg(not(target_arch = "wasm32"))]
            match manager.prune_expired_key_packages() {
                Ok(0) => {}
                Ok(n) => log::info!("load_or_create: pruned {} expired key package(s)", n),
                Err(e) => log::warn!(
                    "load_or_create: could not prune expired key packages: {}",
                    e
                ),
            }

            // WHAT THE STATE IS MADE OF, ONCE PER LOAD.
            //
            // One line per session, on the one seam every platform loads through, and it is here
            // because the alternative has been paid for twice: `mls.bin` has been a P1 on SIZE
            // alone, and both investigations had to INFER the composition from synthetic states
            // because nothing could ask the running device. That inference was wrong twice in one
            // evening on 2026-09-06 - once blaming key packages for a drop that deleting groups
            // caused, once blaming epochs for a per-group cost a later measurement showed to be
            // bounded.
            //
            // Nobody watches this line. It is the one a reader needs the moment a checkpoint starts
            // costing seconds, and it costs one pass over a map already in memory.
            log::info!(
                "load_or_create: state composition - {}",
                manager.state_composition_summary()
            );

            // AND WHAT THE HEAVIEST LABEL IS MADE OF, because on every device measured so far it
            // has been `KeyPackage` and the count alone names no remedy. 3050 bundles against a
            // pool of fifty is expired debt, superseded fallbacks and a revoked pool stacked in one
            // number, and those three are reclaimed by three different things - one of which is
            // already running. This line is what stops the next reader dividing 7.2 MB by 50.
            //
            // NATIVE ONLY, and gated by the SAME rule as the prune above rather than by a second
            // one: the summary reads a clock to fill `expired`, and this crate must not read a
            // clock on wasm - `SystemTime::now()` PANICS there, which is the v0.16.4 outage the
            // block above is written around. The other six figures need no clock, so a web caller
            // that wants them calls `key_package_census_at` with `Date.now()/1000`, exactly as the
            // prune's escape hatch works. It is not a gap worth closing blind: the accumulation
            // this measures was measured on a handset, and a browser profile does not live long
            // enough to reach the horizon.
            #[cfg(not(target_arch = "wasm32"))]
            log::info!(
                "load_or_create: key package census - {}",
                manager.key_package_census_summary()
            );

            Ok(manager)
        } else {
            // Case 2: First creation
            let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
            let keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
                .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?;

            let credential =
                BasicCredential::new(format!("{}:{}", user_id, device_id).into_bytes());

            Ok(Self {
                provider,
                keypair,
                credential,
                groups: HashMap::new(),
                forgotten_group_min_epochs: HashMap::new(),
                state_snapshot: RefCell::new(StateSnapshotCache::new_dirty()),
            })
        }
    }

    // --- E. SAVE (CBOR serialization) ---

    pub fn save_state(&self) -> Result<Vec<u8>, MlsError> {
        let mut cache = self.state_snapshot.borrow_mut();
        cache.get_or_build(|| self.serialize_state())
    }

    fn serialize_state(&self) -> Result<Vec<u8>, MlsError> {
        // 1. Serialize the identity (using Ref wrapper to avoid cloning keypair)
        let keypair_bytes = self
            .keypair
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Keypair serialization: {:?}", e)))?;

        // Credential is an enum, we convert BasicCredential to Credential for serialization
        let cred_enum: Credential = self.credential.clone().into();
        let credential_bytes = cred_enum
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Credential serialization: {:?}", e)))?;

        let bundle = IdentityBundleRef {
            keypair: &keypair_bytes,
            credential: &credential_bytes,
        };

        let mut bundle_bytes = Vec::new();
        into_writer(&bundle, &mut bundle_bytes)
            .map_err(|e| MlsError::Serialization(e.to_string()))?;

        // 2. Snapshot OpenMLS storage under a read lock (no HashMap::clone).
        let storage = self.provider.storage();
        let storage_lock = storage.values.read().unwrap();

        // 3. Collect active group IDs (sorted for stable order; note: storage_values is
        //    an unordered HashMap, so the overall CBOR is not deterministic)
        let mut group_ids: Vec<Vec<u8>> = self
            .groups
            .keys()
            .map(|gid_str| gid_str.as_bytes().to_vec())
            .collect();
        group_ids.sort();

        // 4. Encode the global state without copying storage_values
        let persisted = PersistedStateSer {
            identity_bundle: &bundle_bytes,
            storage_values: &storage_lock,
            group_ids: &group_ids,
            forgotten_group_min_epochs: &self.forgotten_group_min_epochs,
        };

        let mut final_bytes = Vec::new();
        into_writer(&persisted, &mut final_bytes)
            .map_err(|e| MlsError::Serialization(e.to_string()))?;

        Ok(final_bytes)
    }

    // --- E. GÉNÉRER MON KEY PACKAGE ---

    /// Builds, persists and serialises one KeyPackage.
    ///
    /// `last_resort` decides the ONE thing that separates the two kinds this device publishes, and
    /// it decides it in the crypto rather than in a convention: `into_group` deletes the private
    /// bundle after a Welcome built on the package is processed *unless* the package carries the
    /// `last_resort` extension (openmls 0.8.1, `group/mls_group/creation.rs:605`). A pool prekey is
    /// claimed once and its server row deleted with it, so it must be forgettable; the static
    /// fallback is served to every peer that finds the pool empty, so it must not be.
    ///
    /// The leaf capabilities have to declare `LastResort` as well - a leaf validates locally that
    /// its capabilities cover the extensions it uses, and a peer re-runs that validation on the
    /// KeyPackage it was handed.
    fn build_key_package(&self, last_resort: bool) -> Result<Vec<u8>, MlsError> {
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

        let credential_with_key = CredentialWithKey {
            credential: self.credential.clone().into(),
            signature_key: self.keypair.public().into(),
        };

        let mut builder = KeyPackage::builder();
        if last_resort {
            builder = builder
                .mark_as_last_resort()
                .leaf_node_capabilities(Capabilities::new(
                    None,
                    None,
                    Some(&[ExtensionType::LastResort]),
                    None,
                    None,
                ));
        }

        let key_package_bundle = builder
            .build(
                ciphersuite,
                &self.provider,
                &self.keypair,
                credential_with_key,
            )
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage creation error: {:?}", e)))?;

        // 2. IMPORTANT: Persist the bundle (private key) in the provider's storage
        let key_package = key_package_bundle.key_package();
        let hash_ref = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| MlsError::OpenMls(format!("HashRef error: {:?}", e)))?;

        self.provider
            .storage()
            .write_key_package(&hash_ref, &key_package_bundle)
            .map_err(|e| MlsError::OpenMls(format!("Storage error: {:?}", e)))?;

        self.mark_state_dirty();

        // 3. Return the serialized public KeyPackage
        key_package
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Serialization error: {:?}", e)))
    }

    /// A one-time prekey for the server-side pool: consumed by the first Welcome built on it.
    pub fn generate_key_package(&self) -> Result<Vec<u8>, MlsError> {
        self.build_key_package(false)
    }

    /// Deletes every stored `KeyPackage` bundle whose lifetime has ELAPSED. Returns how many went.
    ///
    /// ## The leak this closes, measured rather than assumed
    ///
    /// Minting a key package writes its private bundle to the provider's storage, and until now
    /// NOTHING ever deleted one that was not consumed by a Welcome. The reconciliation that exists
    /// runs the other way - `reconcilePublishedKeyPackages` purges the SERVER of prekeys whose
    /// private key is gone locally - so a bundle the server has stopped publishing is kept for
    /// ever. Two callers make that unbounded:
    ///
    /// - `generateKeyPackageImpl` republishes a FRESH last-resort package on every connection, and
    /// - `republishKeyMaterial` calls `deleteAllOneTimePrekeys()` and mints up to 50 more, once per
    ///   30 s, on every `NoMatchingKeyPackage` storm.
    ///
    /// `tests/state_weight.rs` weighs the result: a bundle is 1 936 bytes, and 200 of them are
    /// 60% of a state that also holds 41 groups. A phone through the 2026-09 healing campaign
    /// reached a 19 548 753-byte `mls.bin` that took 17 s to checkpoint and 22 s to unlock - about
    /// ten thousand accumulated bundles, which is ~200 purge-and-remint rounds.
    ///
    /// ## Why EXPIRY is the discriminator, and not "the server no longer publishes it"
    ///
    /// "Unpublished" is not the same as "dead": the delivery service DELETES a one-time prekey as
    /// it hands it out, so a bundle can be absent from the server precisely because a peer is about
    /// to send the Welcome built on it. Deleting on that signal would race a join and lose it.
    ///
    /// An elapsed lifetime carries no such ambiguity. `not_after` is set at mint time and openmls
    /// defaults it to 84 days; a Welcome that referenced an expired KeyPackage is invalid under
    /// RFC 9420 and every joiner is entitled to refuse it. So this deletes only what could not have
    /// been used anyway, needs no server round-trip, and cannot race anything - which is what makes
    /// it safe to run unattended at load. It BOUNDS the leak at (mint rate x 84 days) rather than
    /// letting it grow with the life of the install.
    ///
    /// A bundle that fails to decode is LEFT ALONE and counted in the log: it is a byte pattern
    /// this build does not understand, and deleting what one cannot read is how a state gets lost.
    ///
    /// Reads the clock ONCE and hands it to [`Self::prune_key_packages_expired_at`], which is where
    /// the decision actually lives - see there for why the two are separate.
    ///
    /// **NOT COMPILED FOR wasm32**, and the `cfg` is the fix rather than a limitation. `std`'s clock
    /// is unimplemented there and PANICS instead of erroring, which took down every web login in
    /// v0.16.4; a target that cannot read a clock must not be offered a function that reads one.
    /// Callers on wasm have a clock of their own and pass it to
    /// [`Self::prune_key_packages_expired_at`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn prune_expired_key_packages(&self) -> Result<usize, MlsError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            // A clock before the epoch cannot say anything is expired, and guessing would delete
            // key material. Prune nothing and say so.
            .map_err(|e| {
                MlsError::OpenMls(format!("System clock is before the UNIX epoch: {e}"))
            })?;
        self.prune_key_packages_expired_at(now)
    }

    /// [`Self::prune_expired_key_packages`] with the current time given rather than read.
    ///
    /// THE CLOCK IS A PARAMETER SO THE RULE CAN BE TESTED WITHOUT ASSERTING ON ONE. `Lifetime`'s own
    /// `is_valid()` consults `SystemTime::now()` internally, so a test written against it could only
    /// prove "nothing minted a moment ago is expired" - it could never reach the branch that
    /// deletes, which is the entire point of this function. Passing `now` in lets a test mint
    /// normally and then ask what the state will look like in a hundred days, which is a statement
    /// about the RULE and not about the machine it ran on.
    ///
    /// Compares against `not_after` alone. `is_valid()` also refuses a package whose `not_before`
    /// is still in the future, and that is a package this device minted moments ago on a machine
    /// with a skewed clock - the one thing that must NOT be deleted.
    pub fn prune_key_packages_expired_at(&self, now_secs: u64) -> Result<usize, MlsError> {
        let storage = self.provider.storage();
        let mut values = storage
            .values
            .write()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;

        // THE ENTRY MUST PROVE IT IS THE KEY PACKAGE ITS OWN KEY NAMES, AND NOT MERELY DECODE -
        // see `for_each_proven_key_package`, which owns that proof so the census cannot describe a
        // different set of rows from the one this deletes.
        let mut doomed: Vec<Vec<u8>> = Vec::new();
        let undecodable = self.for_each_proven_key_package(&values, |k, bundle| {
            if bundle.key_package().life_time().not_after() < now_secs {
                doomed.push(k.to_vec());
            }
        });

        for key in &doomed {
            values.remove(key);
        }
        let pruned = doomed.len();
        drop(values);

        if pruned > 0 || undecodable > 0 {
            log::info!(
                "prune_expired_key_packages: removed {} expired bundle(s), left {} undecodable",
                pruned,
                undecodable
            );
        }
        if pruned > 0 {
            self.mark_state_dirty();
        }
        Ok(pruned)
    }

    /// The device's static fallback, served by the delivery service to every peer that finds the
    /// one-time pool empty. Reusable by construction - see [`Self::build_key_package`].
    pub fn generate_last_resort_key_package(&self) -> Result<Vec<u8>, MlsError> {
        self.build_key_package(true)
    }

    pub fn generate_key_packages(&self, count: usize) -> Result<Vec<Vec<u8>>, MlsError> {
        (0..count).map(|_| self.generate_key_package()).collect()
    }

    /// Checks whether the private key for the provided public KeyPackage is still held locally.
    ///
    /// Recomputes the `hash_ref` of the KeyPackage (the key under which its private bundle
    /// was stored at generation time) then queries the keystore. Lets the client detect
    /// KeyPackages published to the server whose local private key has been lost (state reset
    /// or restored from an older backup) - the root cause of `NoMatchingKeyPackage` loops.
    /// These orphan KeyPackages can then be pruned from the server before a peer consumes them.
    pub fn key_package_has_private(&self, kp_bytes: &[u8]) -> Result<bool, MlsError> {
        let kp_in = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..])
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage deserialize error: {:?}", e)))?;
        let key_package = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage validate error: {:?}", e)))?;
        let hash_ref = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| MlsError::OpenMls(format!("HashRef error: {:?}", e)))?;

        let bundle: Option<KeyPackageBundle> = self
            .provider
            .storage()
            .key_package(&hash_ref)
            .map_err(|e| MlsError::OpenMls(format!("Storage read error: {:?}", e)))?;
        Ok(bundle.is_some())
    }

    /// Forgets the private bundles for key packages the SERVER HAS CONFIRMED IT DELETED.
    ///
    /// ## Why this is the one signal that is safe, when "absent from the server" is not
    ///
    /// [`Self::prune_key_packages_expired_at`] uses an elapsed lifetime and nothing else, and its
    /// docblock says why: the delivery service DELETES a one-time prekey row as it hands it out
    /// (`devices.controller.ts`), so a bundle missing from the server may be missing precisely
    /// because a peer is about to send the Welcome built on it. Deleting on that signal races a
    /// join and loses it.
    ///
    /// A row the server deletes *on its owner's instruction* carries no such ambiguity. It was
    /// still in the pool at that instant, which is the same as saying it had NOT been handed to
    /// anybody - the hand-out is what would have removed it. So nothing can hold it, nothing can
    /// build a Welcome on it, and its private half is dead the moment the purge commits. The caller
    /// passes exactly what the server reported deleting; this forgets exactly that.
    ///
    /// ## The debt this repays, measured
    ///
    /// `republishKeyMaterial` purges the server pool and mints up to 50 more, once per 30 s during
    /// a `NoMatchingKeyPackage` storm. Nothing local ever dropped the previous pool, so every round
    /// orphaned fifty bundles for 84 days. Measured on a Mi 9T on 2026-09-09: **3051 bundles, 2782
    /// of them one-time, against a pool of fifty** - about fifty-six such rounds - and `0 expired`,
    /// so not one of them was reclaimable that day. 7 214 310 bytes of a 10 676 363-byte state.
    ///
    /// ## What it deliberately does NOT do
    ///
    /// It never derives the set itself. A version of this that scanned for "one-time bundles the
    /// server no longer lists" would be the racing delete above wearing a different name, and it
    /// would also reach the bundles a hand-out removed - the exact ones that must survive. The
    /// argument for safety is entirely in WHERE the list comes from, so the list is a parameter.
    ///
    /// Deletion goes through the provider's own `delete_key_package`, not the raw map, so it is
    /// confined to key packages by the API rather than by a prefix test this code would have to get
    /// right.
    ///
    /// A payload that will not deserialise, will not validate, or names a bundle this device does
    /// not hold is COUNTED AND SKIPPED, never fatal: this is maintenance running behind a purge
    /// that already succeeded, and a device that cannot forget one stale bundle still works.
    ///
    /// @param publics serialized public KeyPackages the server reported deleting
    /// @returns how many private bundles were forgotten, and how many entries were skipped
    pub fn forget_key_packages(&self, publics: &[Vec<u8>]) -> Result<ForgetOutcome, MlsError> {
        let mut outcome = ForgetOutcome::default();

        for bytes in publics {
            let Ok(kp_in) = KeyPackageIn::tls_deserialize(&mut &bytes[..]) else {
                outcome.unreadable += 1;
                continue;
            };
            let Ok(key_package) = kp_in.validate(self.provider.crypto(), ProtocolVersion::Mls10)
            else {
                outcome.unreadable += 1;
                continue;
            };
            let Ok(hash_ref) = key_package.hash_ref(self.provider.crypto()) else {
                outcome.unreadable += 1;
                continue;
            };

            // ASKED BEFORE DELETING, so the three outcomes stay distinguishable. `delete_key_package`
            // succeeds on a key that was never there, which would let "the purge and the keystore
            // disagree" - the shape `reconcilePublishedKeyPackages` exists to catch - report as a
            // clean sweep.
            let held: Option<KeyPackageBundle> = self
                .provider
                .storage()
                .key_package(&hash_ref)
                .map_err(|e| MlsError::OpenMls(format!("Storage read error: {:?}", e)))?;
            if held.is_none() {
                outcome.not_held += 1;
                continue;
            }

            self.provider
                .storage()
                .delete_key_package(&hash_ref)
                .map_err(|e| MlsError::OpenMls(format!("Storage delete error: {:?}", e)))?;
            outcome.forgotten += 1;
        }

        if outcome.forgotten > 0 {
            self.mark_state_dirty();
        }
        Ok(outcome)
    }

    /// A last-resort key package this device ALREADY HOLDS and can still publish, if there is one.
    ///
    /// ## The mint this replaces, and why the old one was unbounded
    ///
    /// `generer_key_packages_et_persister` calls [`Self::generate_last_resort_key_package`]
    /// UNCONDITIONALLY on every connection, while the one-time pool beside it is topped up
    /// incrementally (`needed = 50 - existing`, so nothing is minted when the pool is full). The
    /// asymmetry has no reason behind it: a last-resort package is REUSABLE BY CONSTRUCTION - that
    /// is the entire meaning of the extension, and why the delivery service can serve the same one
    /// to every peer that finds the pool empty. Minting a fresh one per connection writes a 2 364-byte
    /// bundle that nothing deletes for 84 days, to replace a package that was still perfectly good.
    ///
    /// Measured on a Mi 9T on 2026-09-09: **269 last-resort bundles**, one per connection since the
    /// store was last empty, 9% of a 3051-bundle keystore.
    ///
    /// Republishing the one already held makes the rotation cadence the package's own lifetime -
    /// every 84 days, when this returns `None` because nothing valid is left - instead of every
    /// time the socket comes back. That is a cadence a reader can state, which is what the previous
    /// one was not.
    ///
    /// ## Why the newest, and why validity is checked here
    ///
    /// The store may hold many, and they are not interchangeable: an expired one would be published
    /// to a server that will serve it to peers who are all entitled to refuse the Welcome built on
    /// it. So only a package valid at `now_secs` is offered, and of those the newest, so the one
    /// published has the most life left before this has to mint again.
    ///
    /// THE CLOCK IS A PARAMETER for the reason it is on the prune and the census: `SystemTime::now()`
    /// panics on wasm and took every web login down in v0.16.4.
    ///
    /// @returns the serialized PUBLIC key package to republish, or `None` if the device must mint
    pub fn existing_last_resort_key_package(
        &self,
        now_secs: u64,
    ) -> Result<Option<Vec<u8>>, MlsError> {
        let storage = self.provider.storage();
        let values = storage
            .values
            .read()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;

        let mut best: Option<(u64, Vec<u8>)> = None;
        self.for_each_proven_key_package(&values, |_k, bundle| {
            let kp = bundle.key_package();
            if !kp.extensions().contains(ExtensionType::LastResort) {
                return;
            }
            let life = kp.life_time();
            // BOTH ENDS, not just `not_after`. A package whose `not_before` is still ahead was
            // minted moments ago on a skewed clock, and publishing it would have peers refuse it
            // for being from the future - the same asymmetry the prune documents from the other
            // side, where that package is the one thing that must not be deleted.
            if life.not_after() < now_secs || life.not_before() > now_secs {
                return;
            }
            let Ok(public) = kp.tls_serialize_detached() else {
                return;
            };
            if best
                .as_ref()
                .is_none_or(|(seen, _)| life.not_before() > *seen)
            {
                best = Some((life.not_before(), public));
            }
        });

        Ok(best.map(|(_, public)| public))
    }
}
